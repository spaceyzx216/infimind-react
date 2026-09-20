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

const summarizeTask = (row, includeResult = true) => {
  if (!row) return null
  const resultExpired = row.result_expires_at && new Date(row.result_expires_at).getTime() <= Date.now()
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
    resultExpiresAt: row.result_expires_at,
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
  cleanupAt: row.cleanup_at,
  createdAt: row.created_at
})

const summarizePublicFile = (row) => {
  const { storagePath, ...file } = summarizeFile(row)
  void storagePath
  return file
}

export function createTaskService(database, {
  resultRetentionDays = Math.max(1, Number(process.env.TASK_RESULT_RETENTION_DAYS) || 30),
  maxAttempts = Math.max(1, Number(process.env.TASK_MAX_ATTEMPTS) || 3)
} = {}) {
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
  const selectTask = database.prepare('SELECT * FROM tasks WHERE id = ?')
  const selectUserTask = database.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?')
  const selectFiles = database.prepare('SELECT * FROM task_files WHERE task_id = ? ORDER BY created_at, id')
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
    const stageSummary = payload?.summary || payload?.message || null
    if (currentStage || stageSummary) {
      database.prepare(`
        UPDATE tasks SET current_stage = COALESCE(?, current_stage), stage_summary = COALESCE(?, stage_summary)
        WHERE id = ?
      `).run(currentStage, stageSummary, taskId)
    }
    insertEvent.run(randomUUID(), taskId, seq, currentStage, eventType, safeJson(payload), at)
    return { taskId, seq, stage: currentStage, eventType, payload, createdAt: at }
  }

  const appendEvent = database.transaction((taskId, eventType, payload = {}, stage = null) => appendEventTx(taskId, eventType, payload, stage))

  const createTaskTx = database.transaction((input) => {
    const createdAt = now()
    const id = input.id || randomUUID()
    insertTask.run({
      id,
      userId: input.userId,
      productId: input.productId || 'contract-review',
      threadId: input.threadId ? String(input.threadId).slice(0, 200) : null,
      title: String(input.title || '商业合同审查').slice(0, 120),
      prompt: String(input.prompt || '').slice(0, 16000),
      mode: input.mode === 'fast' ? 'fast' : 'thinking',
      status: TASK_STATUS.QUEUED,
      maxAttempts: Number(input.maxAttempts) > 0 ? Number(input.maxAttempts) : maxAttempts,
      workflowVersion: input.workflowVersion || 'contract-review-v1',
      createdAt,
      inputJson: safeJson(input.input || {})
    })

    const retentionHours = Math.max(1, Number(process.env.TASK_FILE_RETENTION_HOURS || 24))
    const cleanupAt = input.cleanupAt || new Date(Date.now() + retentionHours * 60 * 60 * 1000).toISOString()
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
    ...summarizeTask(row, includeResult),
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

  const listTasks = (userId, limit = 20) => taskList(database.prepare(`
    SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(userId, Math.min(Math.max(Number(limit) || 20, 1), 100)), false)

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
    return rows.map((row) => ({
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
    SELECT * FROM task_files
    WHERE cleanup_at <= ? AND task_id IN (SELECT id FROM tasks WHERE status IN (?, ?, ?))
    ORDER BY cleanup_at ASC LIMIT 200
  `).all(at, TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED).map(summarizeFile)

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
    const expiresAt = new Date(Date.now() + Math.max(1, resultRetentionDays) * 24 * 60 * 60 * 1000).toISOString()
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

  const failTask = database.transaction((taskId, error, { code = 'task_failed' } = {}) => {
    const current = selectTask.get(taskId)
    if (!current) return null
    // 取消或终态已经赢得状态竞争时，迟到的模型/队列异常不能覆盖它。
    if (current.status === TASK_STATUS.CANCEL_REQUESTED || TERMINAL_STATUSES.has(current.status)) {
      return summarizeTask(current)
    }
    const finishedAt = now()
    const summary = String(error?.message || error || '任务处理失败').slice(0, 1000)
    const updated = database.prepare(`
      UPDATE tasks SET status = ?, finished_at = ?, error_code = ?, error_summary = ?, next_run_at = NULL
      WHERE id = ? AND status NOT IN (?, ?, ?) AND cancel_requested_at IS NULL
    `).run(TASK_STATUS.FAILED, finishedAt, code, summary, taskId, TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED)
    if (updated.changes !== 1) return summarizeTask(selectTask.get(taskId))
    appendEventTx(taskId, 'error', { status: TASK_STATUS.FAILED, code, message: summary })
    appendEventTx(taskId, 'done', { status: TASK_STATUS.FAILED, resultAvailable: false })
    return getTask(taskId, null, true)
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
    completeTask,
    failTask,
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
