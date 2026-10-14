import { randomUUID } from 'node:crypto'

export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  RETRY_WAITING: 'retry_waiting',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCEL_REQUESTED: 'cancel_requested',
  CANCELLED: 'cancelled'
})

const positiveDays = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
const sourceRetentionDays = positiveDays(process.env.TASK_SOURCE_RETENTION_DAYS, 90)
export const TASK_RETENTION_POLICY = Object.freeze({
  version: 'task-retention-source-90d-session-idle-365d-v3',
  sourceRetentionDays,
  sourceRetentionHours: sourceRetentionDays * 24,
  sessionRetentionDays: positiveDays(process.env.TASK_SESSION_RETENTION_DAYS, 365)
})
// Keep the old export name for product-specific callers while sharing one policy.
export const LABOR_CONTRACT_RETENTION_POLICY = TASK_RETENTION_POLICY

const TERMINAL_STATUSES = new Set([
  TASK_STATUS.SUCCEEDED,
  TASK_STATUS.FAILED,
  TASK_STATUS.CANCELLED
])

const now = () => new Date().toISOString()

const parseJson = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback
  try { return JSON.parse(value) } catch { return fallback }
}

const safeJson = (value, fallback = {}) => {
  try { return JSON.stringify(value ?? fallback) } catch { return JSON.stringify(fallback) }
}

const taskRetentionPolicy = () => TASK_RETENTION_POLICY

const addDays = (value, days) => new Date(new Date(value).getTime() + days * 24 * 60 * 60 * 1000).toISOString()
const effectiveFileCleanupAt = (row) => {
  const storedDeadline = row?.cleanup_at
  if (!row?.task_created_at) return storedDeadline
  const policy = taskRetentionPolicy()
  const policyDeadline = addDays(row.task_created_at, policy.sourceRetentionDays)
  const storedTime = new Date(storedDeadline || 0).getTime()
  const policyTime = new Date(policyDeadline).getTime()
  if (!Number.isFinite(storedTime)) return policyDeadline
  return new Date(Math.min(storedTime, policyTime)).toISOString()
}

const summarizeTaskRow = (row, includeResult = true, retentionDays = TASK_RETENTION_POLICY.sessionRetentionDays) => {
  if (!row) return null
  const sessionExpiresAt = retentionDays === null ? null : addDays(row.last_activity_at || row.created_at, retentionDays)
  const resultExpired = sessionExpiresAt && new Date(sessionExpiresAt).getTime() <= Date.now()
  const input = parseJson(row.input_json, {}) || {}
  return {
    id: row.id,
    userId: row.user_id,
    productId: row.product_id,
    threadId: row.thread_id,
    title: row.title,
    prompt: row.prompt,
    mode: row.mode,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    workflowVersion: row.workflow_version,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nextRunAt: row.next_run_at,
    cancelRequestedAt: row.cancel_requested_at,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    resultExpiresAt: sessionExpiresAt,
    retentionPolicy: TASK_RETENTION_POLICY,
    ...(row.product_id === 'labor-contract-analysis' ? {
      action: input.action || 'analyze',
      analysisType: input.analysisType || 'ordinary_labor_contract',
      reviewPerspective: input.reviewPerspective || '',
      fileRoles: Array.isArray(input.fileRoles) ? input.fileRoles : [],
      sourceTaskId: input.sourceTaskId || '',
      reportTaskId: input.reportTaskId || '',
      retentionPolicy: taskRetentionPolicy()
    } : {}),
    currentStage: row.current_stage,
    stageSummary: row.stage_summary,
    lastEventSeq: row.last_event_seq,
    result: includeResult && !resultExpired ? parseJson(row.result_json, null) : null
  }
}

const summarizeFile = (row) => ({
  id: row.id,
  originalName: row.original_name,
  size: row.size,
  mimeType: row.mime_type,
  storagePath: row.storage_path,
  parseStatus: row.parse_status,
  cleanupAt: effectiveFileCleanupAt(row),
  createdAt: row.created_at
})

const summarizePublicFile = (row) => {
  const { storagePath, ...file } = summarizeFile(row)
  void storagePath
  return file
}

export function createTaskService(database, {
  resultRetentionDays = TASK_RETENTION_POLICY.sessionRetentionDays,
  maxAttempts = Math.max(1, Number(process.env.TASK_MAX_ATTEMPTS) || 3)
} = {}) {
  const summarizeTask = (row, includeResult = true) => summarizeTaskRow(row, includeResult, resultRetentionDays)
  const insertTask = database.prepare(`
    INSERT INTO tasks (
      id, user_id, product_id, thread_id, title, prompt, mode, status, attempt_count,
      max_attempts, workflow_version, created_at, input_json, result_expires_at
    ) VALUES (@id, @userId, @productId, @threadId, @title, @prompt, @mode, @status, 0,
      @maxAttempts, @workflowVersion, @createdAt, @inputJson, NULL)
  `)
  const insertFile = database.prepare(`
    INSERT INTO task_files (
      id, task_id, original_name, size, mime_type, storage_path,
      parse_status, cleanup_at, created_at
    ) VALUES (@id, @taskId, @originalName, @size, @mimeType, @storagePath,
      'pending', @cleanupAt, @createdAt)
  `)
  const taskSelect = `SELECT tasks.*, (SELECT COALESCE(MAX(CASE
    WHEN t.status = 'failed' AND COALESCE(t.error_code, '') = 'queue_unavailable' THEN NULL
    ELSE t.created_at END), MIN(t.created_at)) FROM tasks t
    WHERE t.user_id = tasks.user_id AND t.product_id = tasks.product_id
    AND COALESCE(t.thread_id, t.id) = COALESCE(tasks.thread_id, tasks.id)) AS last_activity_at FROM tasks`
  const selectTask = database.prepare(`${taskSelect} WHERE id = ?`)
  const selectUserTask = database.prepare(`${taskSelect} WHERE id = ? AND user_id = ?`)
  const selectFiles = database.prepare(`
    SELECT task_files.*, tasks.product_id, tasks.created_at AS task_created_at
    FROM task_files INNER JOIN tasks ON tasks.id = task_files.task_id
    WHERE task_id = ? ORDER BY task_files.created_at, task_files.id
  `)
  const updateEventSeq = database.prepare('UPDATE tasks SET last_event_seq = ? WHERE id = ?')
  const insertEvent = database.prepare(`
    INSERT INTO task_events (id, task_id, seq, stage, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const upsertCheckpoint = database.prepare(`
    INSERT INTO task_checkpoints (id, task_id, stage, result_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(task_id, stage) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at
  `)

  const saveCheckpointTx = (taskId, stage, result = {}, timestamp = now()) => {
    upsertCheckpoint.run(randomUUID(), taskId, stage, safeJson(result), timestamp)
    return { taskId, stage, result, createdAt: timestamp }
  }

  const appendEventTx = (taskId, eventType, payload = {}, stage = null, at = now()) => {
    const task = selectTask.get(taskId)
    if (!task) throw new Error(`任务不存在: ${taskId}`)
    const seq = Number(task.last_event_seq || 0) + 1
    updateEventSeq.run(seq, taskId)
    const currentStage = stage || payload?.stage || null
    // 事件 payload 的 summary 既可能是给用户看的字符串，也可能是引用校验
    // 这类结构化对象；任务表只保存短摘要，不能把对象直接绑定到 SQLite 参数。
    const stageSummary = typeof payload?.summary === 'string'
      ? payload.summary
      : typeof payload?.message === 'string' ? payload.message : null
    if (currentStage || stageSummary) {
      database.prepare(`
        UPDATE tasks SET current_stage = COALESCE(?, current_stage), stage_summary = COALESCE(?, stage_summary)
        WHERE id = ?
      `).run(currentStage, stageSummary, taskId)
    }
    insertEvent.run(randomUUID(), taskId, seq, currentStage, eventType, safeJson(payload), at)
    return { taskId, seq, stage: currentStage, eventType, payload, createdAt: at }
  }

  const clearLaborTransientPayloadsTx = (taskId) => {
    const task = selectTask.get(taskId)
    if (task?.product_id !== 'labor-contract-analysis') return
    database.prepare("DELETE FROM task_events WHERE task_id = ? AND event_type IN ('analysis.section', 'followup.delta')").run(taskId)
    database.prepare("DELETE FROM task_checkpoints WHERE task_id = ? AND stage IN ('analysis', 'privacy')").run(taskId)
  }

  const appendEvent = database.transaction((taskId, eventType, payload = {}, stage = null) => appendEventTx(taskId, eventType, payload, stage))

  const createTaskTx = database.transaction((input) => {
    const createdAt = now()
    const id = input.id || randomUUID()
    const productId = input.productId || 'contract-review'
    const retentionPolicy = taskRetentionPolicy()
    const threadId = input.threadId ? String(input.threadId).slice(0, 200) : null
    const previous = database.prepare(`SELECT id FROM tasks WHERE user_id = ? AND product_id = ?
      AND COALESCE(thread_id, id) = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(input.userId, productId, threadId || id)
    const previousExpiry = previous ? summarizeTask(selectTask.get(previous.id), false).resultExpiresAt : null
    if (previousExpiry && new Date(previousExpiry).getTime() <= new Date(createdAt).getTime()) {
      const error = new Error('会话已到保存期限，请新建会话后重新提交。')
      error.code = 'task_thread_expired'
      throw error
    }
    insertTask.run({
      id,
      userId: input.userId,
      productId: input.productId || 'contract-review',
      threadId,
      title: String(input.title || '商业合同审查').slice(0, 120),
      prompt: String(input.prompt || '').slice(0, 16000),
      mode: input.mode === 'fast' ? 'fast' : 'thinking',
      status: TASK_STATUS.QUEUED,
      maxAttempts: Number(input.maxAttempts) > 0 ? Number(input.maxAttempts) : maxAttempts,
      workflowVersion: input.workflowVersion || 'contract-review-v1',
      createdAt,
      inputJson: safeJson(input.input || {})
    })

    const sessionExpiresAt = retentionPolicy.sessionRetentionDays === null
      ? null
      : addDays(createdAt, resultRetentionDays)
    database.prepare(`
      UPDATE tasks SET result_expires_at = ?
      WHERE user_id = ? AND product_id = ? AND COALESCE(thread_id, id) = ?
    `).run(sessionExpiresAt, input.userId, productId, threadId || id)

    const cleanupAt = input.cleanupAt || addDays(createdAt, retentionPolicy.sourceRetentionDays)
    for (const file of input.files || []) {
      insertFile.run({
        id: file.id || randomUUID(),
        taskId: id,
        originalName: String(file.originalName || '合同文件').slice(0, 255),
        size: Math.max(0, Number(file.size) || 0),
        mimeType: String(file.mimeType || 'application/octet-stream').slice(0, 180),
        storagePath: String(file.storagePath || ''),
        cleanupAt,
        createdAt
      })
    }
    appendEventTx(id, 'task.created', {
      productId: input.productId || 'contract-review',
      title: String(input.title || '商业合同审查').slice(0, 120),
      fileCount: (input.files || []).length,
      status: TASK_STATUS.QUEUED
    }, null, createdAt)
    return id
  })

  const taskList = (rows, includeResult = false) => rows.map((row) => ({
    ...summarizeTask(selectTask.get(row.id), includeResult),
    files: selectFiles.all(row.id).map(summarizePublicFile)
  }))

  const claimTask = database.transaction((taskId) => {
    const row = selectTask.get(taskId)
    if (!row || (row.status !== TASK_STATUS.QUEUED && row.status !== TASK_STATUS.RETRY_WAITING)) return null
    if (row.next_run_at && new Date(row.next_run_at).getTime() > Date.now()) return null
    const startedAt = row.started_at || now()
    database.prepare(`
      UPDATE tasks
      SET status = ?, attempt_count = attempt_count + 1, started_at = ?, next_run_at = NULL,
          error_code = NULL, error_summary = NULL
      WHERE id = ? AND status IN (?, ?)
    `).run(TASK_STATUS.RUNNING, startedAt, taskId, TASK_STATUS.QUEUED, TASK_STATUS.RETRY_WAITING)
    const claimed = selectTask.get(taskId)
    if (!claimed || claimed.status !== TASK_STATUS.RUNNING) return null
    appendEventTx(taskId, 'task.running', {
      attempt: claimed.attempt_count,
      status: TASK_STATUS.RUNNING
    })
    return summarizeTask(claimed)
  })

  const claimNextTask = database.transaction(() => {
    const row = database.prepare(`
      SELECT id FROM tasks
      WHERE status = ? OR (status = ? AND (next_run_at IS NULL OR next_run_at <= ?))
      ORDER BY created_at ASC LIMIT 1
    `).get(TASK_STATUS.QUEUED, TASK_STATUS.RETRY_WAITING, now())
    return row ? claimTask(row.id) : null
  })

  const recoverInFlight = database.transaction(() => {
    const runningRows = database.prepare('SELECT id FROM tasks WHERE status = ?').all(TASK_STATUS.RUNNING)
    const cancelRows = database.prepare('SELECT id FROM tasks WHERE status = ?').all(TASK_STATUS.CANCEL_REQUESTED)
    for (const row of runningRows) {
      database.prepare(`UPDATE tasks SET status = ?, next_run_at = NULL, cancel_requested_at = NULL WHERE id = ?`)
        .run(TASK_STATUS.QUEUED, row.id)
      appendEventTx(row.id, 'task.recovered', { status: TASK_STATUS.QUEUED, reason: 'worker_restart' })
    }
    for (const row of cancelRows) {
      const finishedAt = now()
      database.prepare('UPDATE tasks SET status = ?, finished_at = ?, next_run_at = NULL WHERE id = ?')
        .run(TASK_STATUS.CANCELLED, finishedAt, row.id)
      clearLaborTransientPayloadsTx(row.id)
      appendEventTx(row.id, 'task.cancelled', { status: TASK_STATUS.CANCELLED, reason: 'worker_restart_cancel' }, null, finishedAt)
      appendEventTx(row.id, 'done', { status: TASK_STATUS.CANCELLED, resultAvailable: false }, null, finishedAt)
    }
    return runningRows.length + cancelRows.length
  })

  const getTask = (taskId, userId, includeResult = true) => {
    const row = userId ? selectUserTask.get(taskId, userId) : selectTask.get(taskId)
    if (!row) return null
    return {
      ...summarizeTask(row, includeResult),
      files: selectFiles.all(row.id).map(summarizePublicFile)
    }
  }

  const getTaskInput = (taskId, userId = null) => {
    const row = userId ? selectUserTask.get(taskId, userId) : selectTask.get(taskId)
    return row ? parseJson(row.input_json, {}) : null
  }

  const getActiveTaskByThread = (userId, productId, threadId) => {
    if (!userId || !productId || !threadId) return null
    const row = database.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND product_id = ? AND thread_id = ?
        AND status IN (?, ?, ?, ?)
      ORDER BY created_at ASC
      LIMIT 1
    `).get(userId, productId, threadId,
      TASK_STATUS.QUEUED,
      TASK_STATUS.RUNNING,
      TASK_STATUS.RETRY_WAITING,
      TASK_STATUS.CANCEL_REQUESTED)
    return row ? getTask(row.id, userId, false) : null
  }

  const listTasks = (userId, limit = 20, { productId = '', offset = 0 } = {}) => taskList(database.prepare(`
    SELECT * FROM tasks WHERE user_id = ? AND (? = '' OR product_id = ?)
      AND COALESCE(json_extract(input_json, '$.temporary'), 0) != 1
    ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
  `).all(userId, productId, productId, Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 100), Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(offset) || 0)))), false)

  const listThreadTasks = (userId, productId, threadId, limit = 100, { offset = 0 } = {}) => taskList(database.prepare(`
    SELECT * FROM (SELECT *, rowid AS task_order FROM tasks WHERE user_id = ? AND product_id = ?
      AND (thread_id = ? OR (id = ? AND thread_id IS NULL))
    ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?) ORDER BY created_at ASC, task_order ASC
  `).all(userId, productId, threadId, threadId, Math.min(Math.max(Math.floor(Number(limit) || 100), 1), 200), Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(offset) || 0)))), true)

  const listAllThreadTasks = (userId, productId, threadId) => taskList(database.prepare(`
    SELECT * FROM tasks WHERE user_id = ? AND product_id = ? AND COALESCE(thread_id, id) = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(userId, productId, threadId), true)

  const getThreadMaterials = (userId, productId, threadId) => {
    const tasks = listAllThreadTasks(userId, productId, threadId)
    if (!tasks.length) return []
    const excluded = new Set(getCheckpoint(tasks[0]?.id, 'material_selection')?.result?.excludedFileIds || [])
    return tasks.filter((task) => !(task.status === 'failed' && task.errorCode === 'queue_unavailable')).flatMap((task) => {
      const input = getTaskInput(task.id, userId) || {}
      const documents = getLaborSourceDocuments(task.id)
      return (input.fileRefs || []).map((ref) => ({
        id: ref.id, sourceTaskId: task.id, size: ref.size || 0, name: ref.originalName || documents.find((doc) => doc.fileId === ref.id)?.fileName || '案件材料',
        enabled: !excluded.has(ref.id), available: documents.some((doc) => doc.fileId === ref.id && doc.text?.trim())
          || task.files.some((file) => file.id === ref.id && new Date(file.cleanupAt).getTime() > Date.now()),
        originalAvailable: task.files.some((file) => file.id === ref.id && new Date(file.cleanupAt).getTime() > Date.now())
      }))
    })
  }

  const setThreadMaterialEnabled = database.transaction((userId, productId, threadId, fileId, enabled) => {
    const tasks = listAllThreadTasks(userId, productId, threadId)
    if (!tasks.length || !getThreadMaterials(userId, productId, threadId).some((file) => file.id === fileId)) return false
    if (tasks.some((task) => !TERMINAL_STATUSES.has(task.status))) throw new Error('请先停止当前任务，再修改材料')
    const excluded = new Set(getCheckpoint(tasks[0].id, 'material_selection')?.result?.excludedFileIds || [])
    if (enabled) excluded.delete(fileId); else excluded.add(fileId)
    saveCheckpointTx(tasks[0].id, 'material_selection', { excludedFileIds: [...excluded] })
    return true
  })

  const updateThreadTitle = database.transaction((userId, productId, threadId, title) => {
    const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!userId || !productId || !threadId || !normalizedTitle) return false
    const outcome = database.prepare(`
      UPDATE tasks SET title = ?
      WHERE user_id = ? AND product_id = ? AND COALESCE(thread_id, id) = ?
    `).run(normalizedTitle, userId, productId, threadId)
    return outcome.changes > 0
  })

  const deleteThreadTasks = database.transaction((userId, productId, threadId) => {
    const rows = database.prepare(`
      SELECT id, status FROM tasks WHERE user_id = ? AND product_id = ?
        AND (thread_id = ? OR (id = ? AND thread_id IS NULL))
      ORDER BY created_at ASC, rowid ASC
    `).all(userId, productId, threadId, threadId)
    if (!rows.length) return { deleted: false, reason: 'not_found', taskIds: [] }
    if (rows.some((row) => !TERMINAL_STATUSES.has(row.status))) {
      return { deleted: false, reason: 'active', taskIds: [] }
    }
    const removeTask = database.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ? AND product_id = ?')
    for (const row of rows) removeTask.run(row.id, userId, productId)
    return { deleted: true, reason: null, taskIds: rows.map((row) => row.id) }
  })

  const listExpiredLaborThreads = (at = now()) => {
    if (resultRetentionDays === null) return []
    const rows = database.prepare(`
      SELECT user_id, product_id, COALESCE(thread_id, id) AS thread_id
      FROM tasks
      GROUP BY user_id, product_id, COALESCE(thread_id, id)
      HAVING strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(MAX(CASE WHEN status = 'failed' AND COALESCE(error_code, '') = 'queue_unavailable' THEN NULL ELSE created_at END), MIN(created_at)), '+' || ? || ' days') <= ?
        AND SUM(CASE WHEN status NOT IN (?, ?, ?) THEN 1 ELSE 0 END) = 0
    `).all(resultRetentionDays, at, TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED)
    return rows.map(({ user_id: userId, product_id: productId, thread_id: threadId }) => {
      const tasks = database.prepare(`
        SELECT id FROM tasks WHERE user_id = ? AND product_id = ? AND COALESCE(thread_id, id) = ?
        ORDER BY created_at ASC, rowid ASC
      `).all(userId, productId, threadId).map((row) => row.id)
      const files = database.prepare(`
        SELECT task_files.* FROM task_files
        INNER JOIN tasks ON tasks.id = task_files.task_id
        WHERE tasks.user_id = ? AND tasks.product_id = ? AND COALESCE(tasks.thread_id, tasks.id) = ?
      `).all(userId, productId, threadId).map(summarizeFile)
      return { userId, productId, threadId, taskIds: tasks, files }
    })
  }

  const deleteExpiredLaborThreadTasks = database.transaction((userId, productId, threadId, at = now()) => {
    if (resultRetentionDays === null) return { deleted: false, reason: 'not_expired', taskIds: [] }
    const rows = database.prepare(`
      SELECT id, status, result_expires_at FROM tasks
      WHERE user_id = ? AND product_id = ? AND COALESCE(thread_id, id) = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(userId, productId, threadId)
    if (!rows.length) return { deleted: false, reason: 'not_found', taskIds: [] }
    if (rows.some((row) => !TERMINAL_STATUSES.has(row.status))) {
      return { deleted: false, reason: 'active', taskIds: [] }
    }
    const latestExpiry = rows.reduce((latest, row) => Math.max(latest, new Date(summarizeTask(selectTask.get(row.id), false).resultExpiresAt).getTime()), 0)
    if (!latestExpiry || latestExpiry > new Date(at).getTime()) {
      return { deleted: false, reason: 'not_expired', taskIds: [] }
    }
    const removeTask = database.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ? AND product_id = ?')
    for (const row of rows) removeTask.run(row.id, userId, productId)
    return { deleted: true, reason: null, taskIds: rows.map((row) => row.id) }
  })

  // Callers must first check ownership. This is the original used for the
  // conversation/annotations, independently of the uploaded binary's lifetime.
  const getLaborSourceDocuments = (taskId) => {
    const row = selectTask.get(taskId)
    if (!row || !['labor-contract-analysis', 'labor-arbitration'].includes(row.product_id)) return []
    const result = parseJson(row.result_json, {}) || {}
    const documents = getCheckpoint(taskId, 'source')?.result?.documents
      || result.sourceDocuments
      || getCheckpoint(taskId, 'analysis')?.result?.result?.sourceDocuments
      || getCheckpoint(taskId, 'parsing')?.result?.documents
    return Array.isArray(documents) ? documents.filter((item) => item?.text?.trim()) : []
  }

  const purgeExpiredLaborSourceCheckpoints = (at = now()) => {
    return database.transaction(() => {
      const taskRows = database.prepare('SELECT id, product_id, created_at, input_json FROM tasks WHERE status IN (?, ?, ?)')
        .all(TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED)
      const filesByTask = new Map()
      for (const file of database.prepare(`
        SELECT task_files.task_id, task_files.cleanup_at, tasks.product_id,
          tasks.created_at AS task_created_at
        FROM task_files INNER JOIN tasks ON tasks.id = task_files.task_id
        ORDER BY task_files.cleanup_at ASC
      `).all()) {
        const deadline = effectiveFileCleanupAt(file)
        const existing = filesByTask.get(file.task_id)
        if (!existing || new Date(deadline).getTime() < new Date(existing).getTime()) {
          filesByTask.set(file.task_id, deadline)
        }
      }
      const expiredSourceTaskIds = new Set()
      for (const row of taskRows) {
        const fileCleanupAt = filesByTask.get(row.id)
        const sourcePolicy = taskRetentionPolicy()
        const sourceExpiresAt = fileCleanupAt || addDays(row.created_at, sourcePolicy.sourceRetentionDays)
        if (!Number.isFinite(new Date(sourceExpiresAt).getTime()) || new Date(sourceExpiresAt).getTime() <= new Date(at).getTime()) {
          expiredSourceTaskIds.add(row.id)
        }
      }
      let changes = 0
      const deleteSourceCheckpoint = database.prepare("DELETE FROM task_checkpoints WHERE task_id = ? AND stage IN ('parsing', 'privacy', 'arbitration_documents')")
      for (const row of taskRows) {
        const input = parseJson(row.input_json, {}) || {}
        const reusesSourceMaterial = ['followup', 'reanalyze', 'restart-analysis'].includes(input.action)
        if (expiredSourceTaskIds.has(row.id) || (reusesSourceMaterial && expiredSourceTaskIds.has(input.sourceTaskId))) {
          if (['labor-contract-analysis', 'labor-arbitration'].includes(row.product_id) && !reusesSourceMaterial) {
            const documents = getLaborSourceDocuments(row.id)
            if (documents.length && !getCheckpoint(row.id, 'source')) saveCheckpoint(row.id, 'source', { documents })
          }
          changes += deleteSourceCheckpoint.run(row.id).changes
        }
      }
      return changes
    })()
  }

  const listPendingTaskIds = (limit = 1000) => database.prepare(`
    SELECT id FROM tasks
    WHERE status = ? OR (status = ? AND (next_run_at IS NULL OR next_run_at <= ?))
    ORDER BY created_at ASC LIMIT ?
  `).all(TASK_STATUS.QUEUED, TASK_STATUS.RETRY_WAITING, now(), Math.min(Math.max(Number(limit) || 1000, 1), 5000)).map((row) => row.id)

  const getEvents = (taskId, userId, after = 0, limit = 500) => {
    const task = userId ? selectUserTask.get(taskId, userId) : selectTask.get(taskId)
    if (!task) return null
    const rows = database.prepare(`
      SELECT seq, stage, event_type, payload_json, created_at
      FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(taskId, Math.max(0, Number(after) || 0), Math.min(Math.max(Number(limit) || 500, 1), 1000))
    const expiry = summarizeTask(task, false).resultExpiresAt
    const contentExpired = Boolean(expiry && new Date(expiry).getTime() <= Date.now())
    return rows.filter((row) => !contentExpired || !['analysis.section', 'followup.delta'].includes(row.event_type)).map((row) => ({
      seq: row.seq,
      stage: row.stage,
      event: row.event_type,
      data: parseJson(row.payload_json, {}),
      createdAt: row.created_at
    }))
  }

  const saveCheckpoint = database.transaction((taskId, stage, result = {}) => saveCheckpointTx(taskId, stage, result))

  const getCheckpoint = (taskId, stage) => {
    const row = database.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? AND stage = ?').get(taskId, stage)
    return row ? { taskId, stage: row.stage, result: parseJson(row.result_json, {}), createdAt: row.created_at } : null
  }

  const listCheckpoints = (taskId) => database.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY created_at, id')
    .all(taskId).map((row) => ({ taskId, stage: row.stage, result: parseJson(row.result_json, {}), createdAt: row.created_at }))

  const updateFileParseStatus = (fileId, parseStatus) => database.prepare('UPDATE task_files SET parse_status = ? WHERE id = ?').run(parseStatus, fileId)

  const listExpiredFiles = (at = now()) => database.prepare(`
    SELECT task_files.*, tasks.product_id, tasks.created_at AS task_created_at, tasks.status AS task_status
    FROM task_files INNER JOIN tasks ON tasks.id = task_files.task_id
    WHERE tasks.status IN (?, ?, ?)
    ORDER BY task_files.cleanup_at ASC
  `).all(TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED)
    .map((row) => ({ ...summarizeFile(row), taskStatus: row.task_status }))
    .filter((file) => file.cleanupAt && new Date(file.cleanupAt).getTime() <= new Date(at).getTime())
    .slice(0, 200)

  const removeFileRecords = (fileIds = []) => {
    const ids = fileIds.filter(Boolean)
    if (!ids.length) return 0
    const statement = database.prepare('DELETE FROM task_files WHERE id = ?')
    const remove = database.transaction(() => ids.reduce((count, id) => count + statement.run(id).changes, 0))
    return remove()
  }

  const completeTask = database.transaction((taskId, result) => {
    const current = selectTask.get(taskId)
    if (!current) return null
    if (current.status === TASK_STATUS.CANCEL_REQUESTED || current.status === TASK_STATUS.CANCELLED) {
      return summarizeTask(current)
    }
    if (TERMINAL_STATUSES.has(current.status)) return summarizeTask(current)
    const finishedAt = now()
    const retentionPolicy = taskRetentionPolicy()
    const expiresAt = retentionPolicy.sessionRetentionDays === null
      ? null
      : current.result_expires_at || addDays(finishedAt, Math.max(1, resultRetentionDays))
    const updated = database.prepare(`
      UPDATE tasks SET status = ?, finished_at = ?, result_json = ?, result_expires_at = ?,
        error_code = NULL, error_summary = NULL, next_run_at = NULL
      WHERE id = ? AND status = ? AND cancel_requested_at IS NULL
    `).run(TASK_STATUS.SUCCEEDED, finishedAt, safeJson(result), expiresAt, taskId, TASK_STATUS.RUNNING)
    if (updated.changes !== 1) return summarizeTask(selectTask.get(taskId))
    saveCheckpointTx(taskId, 'persistence', { persisted: true, resultAvailable: true, taskId }, finishedAt)
    appendEventTx(taskId, 'task.succeeded', {
      status: TASK_STATUS.SUCCEEDED,
      resultAvailable: true,
      resultExpiresAt: expiresAt
    }, null, finishedAt)
    return getTask(taskId, null, true)
  })

  const failTask = database.transaction((taskId, error, { code = 'task_failed', result = null } = {}) => {
    const current = selectTask.get(taskId)
    if (!current) return null
    // 取消或终态已经赢得状态竞争时，迟到的模型/队列异常不能覆盖它。
    if (current.status === TASK_STATUS.CANCEL_REQUESTED || TERMINAL_STATUSES.has(current.status)) {
      return summarizeTask(current)
    }
    const finishedAt = now()
    const summary = String(error?.message || error || '任务处理失败').slice(0, 1000)
    const updated = database.prepare(`
      UPDATE tasks SET status = ?, finished_at = ?, error_code = ?, error_summary = ?, next_run_at = NULL,
        result_json = COALESCE(?, result_json)
      WHERE id = ? AND status NOT IN (?, ?, ?) AND cancel_requested_at IS NULL
    `).run(TASK_STATUS.FAILED, finishedAt, code, summary, result ? safeJson(result) : null, taskId, TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED)
    if (updated.changes !== 1) return summarizeTask(selectTask.get(taskId))
    clearLaborTransientPayloadsTx(taskId)
    appendEventTx(taskId, 'error', { status: TASK_STATUS.FAILED, code, message: summary })
    appendEventTx(taskId, 'done', { status: TASK_STATUS.FAILED, resultAvailable: Boolean(result || current.result_json) })
    return getTask(taskId, null, true)
  })

  const resumeFailedReview = database.transaction((taskId, userId) => {
    const current = selectUserTask.get(taskId, userId)
    if (!current || current.product_id !== 'contract-review') return null
    if (current.status !== TASK_STATUS.FAILED || getActiveTaskByThread(userId, current.product_id, current.thread_id || taskId)) {
      throw Object.assign(new Error('当前对话已有审查在运行，请等待完成后继续。'), { code: 'review_resume_busy' })
    }
    database.prepare(`UPDATE tasks SET status = ?, finished_at = NULL, error_code = NULL, error_summary = NULL,
      next_run_at = NULL, max_attempts = MAX(max_attempts, attempt_count + 1) WHERE id = ? AND status = ?`)
      .run(TASK_STATUS.QUEUED, taskId, TASK_STATUS.FAILED)
    appendEventTx(taskId, 'task.resumed', { status: TASK_STATUS.QUEUED, message: '继续核对尚未完成的内容，复用已完成进度。' })
    return getTask(taskId, userId, true)
  })

  const retryTask = database.transaction((taskId, error, delayMs) => {
    const row = selectTask.get(taskId)
    if (!row) return null
    if (row.status === TASK_STATUS.CANCEL_REQUESTED || TERMINAL_STATUSES.has(row.status)) return summarizeTask(row)
    const nextRunAt = new Date(Date.now() + Math.max(250, Number(delayMs) || 1000)).toISOString()
    const summary = String(error?.message || error || '暂时性错误').slice(0, 1000)
    const updated = database.prepare(`
      UPDATE tasks SET status = ?, next_run_at = ?, error_code = ?, error_summary = ?
      WHERE id = ? AND status IN (?, ?) AND cancel_requested_at IS NULL
    `).run(TASK_STATUS.RETRY_WAITING, nextRunAt, 'retryable_error', summary, taskId, TASK_STATUS.RUNNING, TASK_STATUS.RETRY_WAITING)
    if (updated.changes !== 1) return summarizeTask(selectTask.get(taskId))
    appendEventTx(taskId, 'task.retry_waiting', {
      status: TASK_STATUS.RETRY_WAITING,
      nextRunAt,
      attempt: row.attempt_count,
      message: summary
    })
    return getTask(taskId, null, false)
  })

  const requestCancel = database.transaction((taskId, userId) => {
    const row = selectUserTask.get(taskId, userId)
    if (!row) return null
    if (TERMINAL_STATUSES.has(row.status)) return summarizeTask(row)
    if (row.status === TASK_STATUS.QUEUED || row.status === TASK_STATUS.RETRY_WAITING) {
      const finishedAt = now()
      database.prepare(`UPDATE tasks SET status = ?, finished_at = ?, next_run_at = NULL WHERE id = ?`)
        .run(TASK_STATUS.CANCELLED, finishedAt, taskId)
      clearLaborTransientPayloadsTx(taskId)
      appendEventTx(taskId, 'task.cancelled', { status: TASK_STATUS.CANCELLED, immediate: true }, null, finishedAt)
      return summarizeTask(selectTask.get(taskId))
    }
    if (row.status === TASK_STATUS.RUNNING) {
      const requestedAt = now()
      database.prepare(`UPDATE tasks SET status = ?, cancel_requested_at = ? WHERE id = ?`)
        .run(TASK_STATUS.CANCEL_REQUESTED, requestedAt, taskId)
      appendEventTx(taskId, 'task.cancel_requested', { status: TASK_STATUS.CANCEL_REQUESTED })
    }
    return summarizeTask(selectTask.get(taskId))
  })

  const markCancelled = database.transaction((taskId, reason = 'user_requested') => {
    const row = selectTask.get(taskId)
    if (!row || TERMINAL_STATUSES.has(row.status)) return summarizeTask(row)
    const finishedAt = now()
    database.prepare(`UPDATE tasks SET status = ?, finished_at = ?, next_run_at = NULL WHERE id = ?`)
      .run(TASK_STATUS.CANCELLED, finishedAt, taskId)
    clearLaborTransientPayloadsTx(taskId)
    appendEventTx(taskId, 'task.cancelled', { status: TASK_STATUS.CANCELLED, reason }, null, finishedAt)
    appendEventTx(taskId, 'done', { status: TASK_STATUS.CANCELLED, resultAvailable: false }, null, finishedAt)
    return summarizeTask(selectTask.get(taskId))
  })

  const isCancellationRequested = (taskId) => {
    const row = selectTask.get(taskId)
    return row?.status === TASK_STATUS.CANCEL_REQUESTED || row?.status === TASK_STATUS.CANCELLED
  }

  return {
    createTask: (input) => {
      const id = createTaskTx(input)
      return getTask(id, input.userId, true)
    },
    getTask,
    getTaskInternal: (taskId, includeResult = true) => getTask(taskId, null, includeResult),
    listTasks,
    listThreadTasks,
    listAllThreadTasks,
    getThreadMaterials,
    setThreadMaterialEnabled,
    updateThreadTitle,
    deleteThreadTasks,
    listExpiredLaborThreads,
    deleteExpiredLaborThreadTasks,
    listPendingTaskIds,
    getEvents,
    appendEvent,
    claimTask,
    claimNextTask,
    recoverInFlight,
    saveCheckpoint,
    getCheckpoint,
    listCheckpoints,
    updateFileParseStatus,
    listExpiredFiles,
    removeFileRecords,
    purgeExpiredLaborSourceCheckpoints,
    getLaborSourceDocuments,
    completeTask,
    failTask,
    resumeFailedReview,
    retryTask,
    requestCancel,
    markCancelled,
    isCancellationRequested,
    getFiles: (taskId) => selectFiles.all(taskId).map(summarizeFile),
    getTaskInput,
    getActiveTaskByThread,
    isTerminal: (status) => TERMINAL_STATUSES.has(status),
    terminalStatuses: TERMINAL_STATUSES
  }
}
