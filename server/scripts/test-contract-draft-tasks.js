import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskRouter } from '../routes/tasks.js'
import contractRewriteRouter from '../routes/contract-rewrite.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskProcessor } from '../services/task-processor.js'
import { createTaskQueue } from '../services/task-queue.js'
import { createTaskService } from '../services/task-service.js'
import { getContractTypeProfile } from '../prompts/contract-draft-types.js'
import { resolveDraftAction, resolveDraftIntent, runContractDraft } from '../workflows/contract-draft.js'

process.env.TASK_FAKE_LLM = 'true'

const database = createBusinessDatabase(':memory:')
const directory = mkdtempSync(join(tmpdir(), 'fafee-contract-draft-'))
const fileStore = createTaskFileStore({ root: directory })
const taskService = createTaskService(database, { maxAttempts: 2 })
const queue = createTaskQueue({
  taskService,
  processTask: createTaskProcessor({ taskService, fileStore, fakeLlm: true }).processTask,
  mode: 'local',
  workerEnabled: true,
  pollIntervalMs: 10
})

const seedUser = (id, email, inviteId) => {
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)').run(inviteId, `hash-${id}`, new Date().toISOString())
  database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, id, email, 'hash', 'salt', inviteId, new Date().toISOString())
}
seedUser('user-a', 'draft-a@example.com', 'draft-invite-a')
seedUser('user-b', 'draft-b@example.com', 'draft-invite-b')

const processor = createTaskProcessor({ taskService, fileStore, fakeLlm: true })
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use((req, res, next) => {
  req.user = { id: req.get('X-Test-User') || 'user-a' }
  next()
})
app.use('/api', createTaskRouter({ taskService, taskQueue: queue, fileStore, fakeLlm: true }))
app.use('/api', contractRewriteRouter)
const passiveTaskQueue = { enqueue: async (taskId) => ({ mode: 'test', taskId }) }
app.use('/concurrent-api', createTaskRouter({ taskService, taskQueue: passiveTaskQueue, fileStore, fakeLlm: true }))

const server = await new Promise((resolve) => {
  const listener = app.listen(0, () => resolve(listener))
})
const baseUrl = `http://127.0.0.1:${server.address().port}`
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: { ...(options.headers || {}) }
})

const waitFor = async (check, timeoutMs = 5000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待合同起草任务状态超时')
}

const draftForm = ({ message, threadId, operation, parentTaskId, currentDraft, title, file }) => {
  const body = new FormData()
  if (message !== undefined) body.append('message', message)
  if (threadId) body.append('threadId', threadId)
  if (operation) body.append('operation', operation)
  if (parentTaskId) body.append('parentTaskId', parentTaskId)
  if (currentDraft) body.append('currentDraft', JSON.stringify(currentDraft))
  if (title) body.append('title', title)
  if (file) body.append('files', new Blob([file.text], { type: file.type || 'text/plain' }), file.name || '参考材料.txt')
  return body
}

const readTask = async (taskId, user = 'user-a') => {
  const response = await request(`/api/tasks/${taskId}`, { headers: { 'X-Test-User': user } })
  const payload = await response.json()
  return { response, payload }
}

const waitForTask = (taskId) => waitFor(async () => {
  const { payload } = await readTask(taskId)
  if (['failed', 'cancelled'].includes(payload.task?.status)) throw new Error(`任务未成功：${payload.task.errorSummary || payload.task.status}`)
  return payload.task?.status === 'succeeded' ? payload.task : null
})

const parseSse = (text) => [...String(text || '').matchAll(/^event:\s*([^\n]+)\ndata:\s*([^\n]+)\n\n/gm)]
  .map((match) => ({ event: match[1], data: JSON.parse(match[2]) }))

const assertLegacyTaskMigration = () => {
  const legacyPath = join(directory, 'legacy-task-schema.db')
  const legacyDatabase = new Database(legacyPath)
  legacyDatabase.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'thinking',
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      workflow_version TEXT NOT NULL DEFAULT 'contract-review-v1',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      next_run_at TEXT,
      cancel_requested_at TEXT,
      error_code TEXT,
      error_summary TEXT,
      result_json TEXT,
      result_expires_at TEXT,
      current_stage TEXT,
      stage_summary TEXT,
      last_event_seq INTEGER NOT NULL DEFAULT 0
    )
  `)
  legacyDatabase.prepare(`
    INSERT INTO tasks (id, user_id, product_id, title, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-task', 'user-a', 'contract-review', '旧任务', '旧输入', 'succeeded', new Date().toISOString())
  legacyDatabase.close()

  const migrated = createBusinessDatabase(legacyPath)
  const columns = new Set(migrated.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name))
  assert.equal(columns.has('thread_id'), true)
  assert.equal(columns.has('input_json'), true)
  assert.equal(migrated.prepare('SELECT title, input_json FROM tasks WHERE id = ?').get('legacy-task').title, '旧任务')
  const indexes = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'").all().map((row) => row.name)
  assert.equal(indexes.includes('idx_tasks_active_contract_draft_thread'), true)
  migrated.close()
}

try {
  assertLegacyTaskMigration()
  await queue.start()

  const firstResponse = await request('/api/tasks/contract-draft', {
    method: 'POST',
    body: draftForm({
      message: '起草一份软件开发服务合同，明确需求变更、知识产权和验收标准。',
      threadId: 'draft-thread-a',
      title: '软件开发合同初稿'
    })
  })
  assert.equal(firstResponse.status, 202)
  const firstCreated = await firstResponse.json()
  assert.equal(firstCreated.productId, 'contract-draft')
  assert.equal(firstCreated.operation, 'create')
  const firstTask = await waitForTask(firstCreated.taskId)
  assert.equal(firstTask.result.productId, 'contract-draft')
  assert.match(firstTask.result.draftText, /^# /)
  assert.match(firstTask.result.draftText, /## 合同正文/)
  assert.equal(firstTask.result.version, firstCreated.taskId)
  const firstCheckpoints = new Set(taskService.listCheckpoints(firstCreated.taskId).map((item) => item.stage))
  for (const stage of ['parsing', 'contract_type', 'generation', 'persistence']) assert.equal(firstCheckpoints.has(stage), true, `缺少 ${stage} 检查点`)

  const inputRow = database.prepare('SELECT input_json FROM tasks WHERE id = ?').get(firstCreated.taskId)
  const persistedInput = JSON.parse(inputRow.input_json)
  assert.equal(persistedInput.operation, 'create')
  assert.equal(persistedInput.threadId, 'draft-thread-a')
  assert.equal(persistedInput.inputSnapshot.message, '起草一份软件开发服务合同，明确需求变更、知识产权和验收标准。')
  assert.equal(persistedInput.currentDraft, null)
  assert.deepEqual(persistedInput.fileRefs, [])

  const attachmentResponse = await request('/api/tasks/contract-draft', {
    method: 'POST',
    body: draftForm({
      message: '请根据附件中的交易背景起草一份年度采购合同。',
      threadId: 'draft-thread-attachment',
      operation: 'create',
      file: { name: '采购背景.txt', text: '采购方：甲方；供货方：乙方；交付周期待双方确认。' }
    })
  })
  assert.equal(attachmentResponse.status, 202)
  const attachmentCreated = await attachmentResponse.json()
  const attachmentTask = await waitForTask(attachmentCreated.taskId)
  assert.equal(attachmentTask.result.referenceFiles[0], '采购背景.txt')
  const attachmentInput = JSON.parse(database.prepare('SELECT input_json FROM tasks WHERE id = ?').get(attachmentCreated.taskId).input_json)
  assert.equal(attachmentInput.fileRefs.length, 1)
  assert.equal(attachmentInput.fileRefs[0].originalName, '采购背景.txt')
  assert.equal('storagePath' in attachmentInput.fileRefs[0], false)
  assert.equal(attachmentTask.files[0].parseStatus, 'succeeded')

  const attachmentUpdateResponse = await request('/api/tasks/contract-draft', {
    method: 'POST',
    body: draftForm({
      message: '请根据新附件更新完整合同。',
      threadId: 'draft-thread-attachment',
      operation: 'attachment_update',
      parentTaskId: attachmentCreated.taskId,
      file: { name: '补充交付要求.txt', text: '补充要求：验收应以书面确认的交付清单为准。' }
    })
  })
  assert.equal(attachmentUpdateResponse.status, 202)
  const attachmentUpdateCreated = await attachmentUpdateResponse.json()
  const attachmentUpdatedTask = await waitForTask(attachmentUpdateCreated.taskId)
  assert.equal(attachmentUpdatedTask.result.operation, 'attachment_update')
  assert.deepEqual(attachmentUpdatedTask.result.referenceFiles, ['补充交付要求.txt'])

  const regenerateResponse = await request('/api/tasks/contract-draft', {
    method: 'POST',
    body: draftForm({
      message: '请重新生成完整合同，并把验收标准写得更清楚。',
      threadId: 'draft-thread-a',
      operation: 'regenerate',
      parentTaskId: firstCreated.taskId
    })
  })
  assert.equal(regenerateResponse.status, 202)
  const regenerateCreated = await regenerateResponse.json()
  const regeneratedTask = await waitForTask(regenerateCreated.taskId)
  assert.equal(regeneratedTask.result.operation, 'regenerate')
  assert.equal(regeneratedTask.result.parentTaskId, firstCreated.taskId)
  const regeneratedInput = JSON.parse(database.prepare('SELECT input_json FROM tasks WHERE id = ?').get(regenerateCreated.taskId).input_json)
  assert.equal(regeneratedInput.parentTaskId, firstCreated.taskId)
  assert.match(regeneratedInput.currentDraft.draftText, /## 合同正文/)

  const updateResponse = await request('/api/tasks/contract-draft', {
    method: 'POST',
    body: draftForm({
      message: '请将付款节点和违约责任更新到全文。',
      threadId: 'draft-thread-a',
      operation: 'update',
      parentTaskId: regenerateCreated.taskId
    })
  })
  assert.equal(updateResponse.status, 202)
  const updateCreated = await updateResponse.json()
  const updatedTask = await waitForTask(updateCreated.taskId)
  assert.equal(updatedTask.result.operation, 'update')
  assert.equal(updatedTask.result.parentTaskId, regenerateCreated.taskId)

  const replayResponse = await request(`/api/tasks/${updateCreated.taskId}/events?after=${updatedTask.lastEventSeq - 2}`, { headers: { Accept: 'text/event-stream' } })
  assert.equal(replayResponse.status, 200)
  const replayEvents = parseSse(await replayResponse.text())
  assert.equal(replayEvents.some((item) => item.event === 'task.created'), false)
  assert.equal(replayEvents.some((item) => item.event === 'task.succeeded'), true)
  assert.equal(replayEvents.every((item) => Number(item.data._seq) > updatedTask.lastEventSeq - 2), true)

  const forbidden = await readTask(firstCreated.taskId, 'user-b')
  assert.equal(forbidden.response.status, 404)

  const sseResponse = await request('/api/contract-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      message: '请解释当前付款条款的含义和风险。',
      history: [{ role: 'assistant', content: `【当前合同草稿，用户可能要求基于此版本调整或重新生成】\n${updatedTask.result.draftText}` }]
    })
  })
  assert.equal(sseResponse.status, 200)
  const sseEvents = parseSse(await sseResponse.text())
  assert.equal(sseEvents.some((item) => item.event === 'chat.delta'), true)
  assert.equal(sseEvents.some((item) => item.event === 'draft.complete'), false)
  assert.equal(sseEvents.some((item) => item.event === 'done'), true)

  const legacyDraftResponse = await request('/api/contract-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message: '起草一份保密协议，明确保密期限和返还义务。' })
  })
  assert.equal(legacyDraftResponse.status, 200)
  const legacyDraftEvents = parseSse(await legacyDraftResponse.text())
  assert.equal(legacyDraftEvents.some((item) => item.event === 'draft.delta'), true)
  const legacyDraftComplete = legacyDraftEvents.find((item) => item.event === 'draft.complete')
  assert.ok(legacyDraftComplete?.data?.draftText)
  assert.match(legacyDraftComplete.data.draftText, /## 合同正文/)
  assert.equal(legacyDraftEvents.some((item) => item.event === 'done'), true)

  const unclearAttachment = await request('/api/tasks/contract-draft', {
    method: 'POST',
    body: draftForm({ message: '请看看附件。', threadId: 'draft-thread-unclear', file: { name: '未说明用途.txt', text: '这是一份参考材料。' } })
  })
  assert.equal(unclearAttachment.status, 422)
  const unclearPayload = await unclearAttachment.json()
  assert.equal(unclearPayload.code, 'draft_intent_clarification')
  assert.equal(unclearPayload.requiresClarification, true)

  const classifierFallback = await resolveDraftAction({
    message: '请完善这份合同',
    hasExistingDraft: true,
    chatFn: async () => { throw new Error('classifier unavailable') }
  })
  assert.equal(classifierFallback, 'draft')
  const explicitOperation = await resolveDraftIntent({ operation: 'chat', message: '解释付款条款', hasExistingDraft: true })
  assert.equal(explicitOperation.action, 'chat')
  assert.equal(explicitOperation.source, 'operation')

  await queue.close()

  const duplicate = taskService.createTask({
    userId: 'user-a',
    productId: 'contract-draft',
    threadId: 'draft-thread-duplicate',
    title: '重复提交保护',
    prompt: '起草合同',
    input: { operation: 'create', threadId: 'draft-thread-duplicate', message: '起草合同', fileRefs: [] }
  })
  assert.throws(() => taskService.createTask({
    userId: 'user-a',
    productId: 'contract-draft',
    threadId: 'draft-thread-duplicate',
    title: '重复提交保护 2',
    prompt: '起草合同',
    input: { operation: 'create', threadId: 'draft-thread-duplicate', message: '起草合同', fileRefs: [] }
  }), /UNIQUE/)
  const duplicateResponse = await request('/api/tasks/contract-draft', {
    method: 'POST',
    body: draftForm({ message: '起草合同', threadId: 'draft-thread-duplicate' })
  })
  assert.equal(duplicateResponse.status, 409)
  const duplicatePayload = await duplicateResponse.json()
  assert.equal(duplicatePayload.code, 'draft_task_conflict')
  assert.equal(duplicatePayload.task.id, duplicate.id)
  taskService.requestCancel(duplicate.id, 'user-a')

  const concurrentRequests = await Promise.all([
    request('/concurrent-api/tasks/contract-draft', { method: 'POST', body: draftForm({ message: '起草合同', threadId: 'draft-thread-concurrent' }) }),
    request('/concurrent-api/tasks/contract-draft', { method: 'POST', body: draftForm({ message: '起草合同', threadId: 'draft-thread-concurrent' }) })
  ])
  const concurrentPayloads = await Promise.all(concurrentRequests.map(async (response) => ({ status: response.status, payload: await response.json() })))
  assert.deepEqual(concurrentPayloads.map((item) => item.status).sort((left, right) => left - right), [202, 409])
  const concurrentWinner = concurrentPayloads.find((item) => item.status === 202)
  const concurrentConflict = concurrentPayloads.find((item) => item.status === 409)
  assert.equal(concurrentConflict.payload.code, 'draft_task_conflict')
  taskService.requestCancel(concurrentWinner.payload.taskId, 'user-a')

  const restartTaskId = 'draft-worker-restart-task'
  const restartTask = taskService.createTask({
    id: restartTaskId,
    userId: 'user-a',
    productId: 'contract-draft',
    threadId: 'draft-thread-restart',
    prompt: '起草一份保密协议',
    input: { operation: 'create', threadId: 'draft-thread-restart', message: '起草一份保密协议', fileRefs: [] }
  })
  taskService.claimTask(restartTask.id)
  taskService.saveCheckpoint(restartTask.id, 'parsing', { referenceMaterials: [], referenceLength: 0 })
  taskService.recoverInFlight()
  assert.equal(taskService.getTaskInternal(restartTask.id).status, 'queued')
  const restartedResult = await processor.processTask(restartTask.id)
  assert.equal(restartedResult.status, 'succeeded')
  assert.equal(taskService.getEvents(restartTask.id, null, 0).some((event) => event.event === 'task.recovered'), true)
  assert.equal(taskService.getCheckpoint(restartTask.id, 'parsing').result.referenceMaterials.length, 0)

  let retryCalls = 0
  const retryProcessor = createTaskProcessor({
    taskService,
    fileStore,
    fakeLlm: true,
    draftWorkflow: async ({ task }) => {
      retryCalls += 1
      if (retryCalls === 1) {
        const error = new Error('upstream rate limit')
        error.retryable = true
        throw error
      }
      return { productId: 'contract-draft', taskId: task.id, threadId: task.threadId, operation: 'create', version: task.id, draftText: '# 合同\n\n## 待确认信息\n- [ ] 暂无\n\n## 合同正文\n\n正文已生成。', pendingItems: [], title: '合同', contractType: { id: 'general_contract', label: '通用合同', risk: 'standard' }, fake: true }
    }
  })
  const retryTask = taskService.createTask({ userId: 'user-a', productId: 'contract-draft', threadId: 'draft-thread-retry', prompt: '起草合同', input: { operation: 'create', threadId: 'draft-thread-retry', message: '起草合同', fileRefs: [] } })
  const retryWaiting = await retryProcessor.processTask(retryTask.id)
  assert.equal(retryWaiting.status, 'retry_waiting')
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.equal((await retryProcessor.processTask(retryTask.id)).status, 'succeeded')
  assert.equal(retryCalls, 2)

  const emptyTaskId = 'draft-empty-file-task'
  const emptyFiles = await fileStore.saveIncomingFiles(emptyTaskId, [{ originalname: '空文件.txt', mimetype: 'text/plain', buffer: Buffer.alloc(0), size: 0 }])
  const emptyTask = taskService.createTask({ id: emptyTaskId, userId: 'user-a', productId: 'contract-draft', threadId: 'draft-thread-empty', prompt: '根据附件起草合同', input: { operation: 'create', threadId: 'draft-thread-empty', message: '根据附件起草合同', fileRefs: [] }, files: emptyFiles })
  const emptyResult = await processor.processTask(emptyTask.id)
  assert.equal(emptyResult.status, 'failed')
  assert.equal(emptyResult.errorCode, 'empty_file')
  assert.equal(emptyResult.attemptCount, 1)

  const unsupportedTaskId = 'draft-unsupported-file-task'
  const unsupportedFiles = await fileStore.saveIncomingFiles(unsupportedTaskId, [{ originalname: '不支持.exe', mimetype: 'application/octet-stream', buffer: Buffer.from('binary'), size: 6 }])
  const unsupportedTask = taskService.createTask({ id: unsupportedTaskId, userId: 'user-a', productId: 'contract-draft', threadId: 'draft-thread-unsupported', prompt: '根据附件起草合同', input: { operation: 'create', threadId: 'draft-thread-unsupported', message: '根据附件起草合同', fileRefs: [] }, files: unsupportedFiles })
  const unsupportedResult = await processor.processTask(unsupportedTask.id)
  assert.equal(unsupportedResult.status, 'failed')
  assert.equal(unsupportedResult.errorCode, 'unsupported_file_type')

  const runWithFakeStream = (streamValue) => createTaskProcessor({
    taskService,
    fileStore,
    fakeLlm: false,
    draftWorkflow: (options) => runContractDraft({
      ...options,
      classifyType: async () => ({ profile: getContractTypeProfile('general_contract'), confidence: 'low', source: 'test' }),
      streamFn: async function * () { yield { content: streamValue } }
    })
  })
  const emptyModelTask = taskService.createTask({
    userId: 'user-a', productId: 'contract-draft', threadId: 'draft-thread-empty-model', prompt: '起草合同',
    input: { operation: 'create', threadId: 'draft-thread-empty-model', message: '起草合同', fileRefs: [] }
  })
  const emptyModelResult = await runWithFakeStream('').processTask(emptyModelTask.id)
  assert.equal(emptyModelResult.status, 'failed')
  assert.equal(emptyModelResult.errorCode, 'empty_model_response')

  const invalidStructureTask = taskService.createTask({
    userId: 'user-a', productId: 'contract-draft', threadId: 'draft-thread-invalid-structure', prompt: '起草合同',
    input: { operation: 'create', threadId: 'draft-thread-invalid-structure', message: '起草合同', fileRefs: [] }
  })
  const invalidStructureResult = await runWithFakeStream('# 只有标题\n\n不完整').processTask(invalidStructureTask.id)
  assert.equal(invalidStructureResult.status, 'failed')
  assert.equal(invalidStructureResult.errorCode, 'draft_structure_invalid')

  let releaseCancellation
  const cancellationGate = new Promise((resolve) => { releaseCancellation = resolve })
  const cancelProcessor = createTaskProcessor({
    taskService,
    fileStore,
    fakeLlm: true,
    draftWorkflow: async ({ task }) => {
      await cancellationGate
      return { productId: 'contract-draft', taskId: task.id, threadId: task.threadId, operation: 'create', version: task.id, draftText: '# 合同\n\n## 待确认信息\n- [ ] 暂无\n\n## 合同正文\n\n正文已生成。', pendingItems: [], title: '合同', contractType: { id: 'general_contract', label: '通用合同', risk: 'standard' }, fake: true }
    }
  })
  const cancelTask = taskService.createTask({ userId: 'user-a', productId: 'contract-draft', threadId: 'draft-thread-cancel', prompt: '起草合同', input: { operation: 'create', threadId: 'draft-thread-cancel', message: '起草合同', fileRefs: [] } })
  const runningCancellation = cancelProcessor.processTask(cancelTask.id)
  await waitFor(() => taskService.getTaskInternal(cancelTask.id).status === 'running')
  assert.equal(taskService.requestCancel(cancelTask.id, 'user-a').status, 'cancel_requested')
  releaseCancellation()
  assert.equal((await runningCancellation).status, 'cancelled')
  assert.equal(taskService.getTaskInternal(cancelTask.id).result, null)

  const oldDraft = firstTask.result.draftText
  const failedVersion = taskService.createTask({
    userId: 'user-a',
    productId: 'contract-draft',
    threadId: 'draft-thread-a',
    prompt: '更新全文',
    input: { operation: 'update', threadId: 'draft-thread-a', parentTaskId: firstCreated.taskId, currentDraft: firstTask.result, message: '更新全文', fileRefs: [] }
  })
  const failingProcessor = createTaskProcessor({
    taskService,
    fileStore,
    fakeLlm: true,
    draftWorkflow: async () => { throw new Error('draft_structure_invalid') }
  })
  assert.equal((await failingProcessor.processTask(failedVersion.id)).status, 'failed')
  assert.equal(taskService.getTask(firstCreated.taskId, 'user-a', true).result.draftText, oldDraft)
  assert.equal(taskService.getTask(failedVersion.id, 'user-a', true).result, null)

  console.log('Contract draft task regression passed: create, attachment create/update, regenerate/update, SSE clarification/chat, classifier fallback, event replay, checkpoint recovery, retry, cancellation, concurrent duplicate/ownership protection, snapshots/file refs, migration, validation failures and old draft preservation.')
} finally {
  await queue.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
