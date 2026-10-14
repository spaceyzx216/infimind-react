import assert from 'node:assert/strict'
import express from 'express'
import JSZip from 'jszip'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskRouter } from '../routes/tasks.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskProcessor } from '../services/task-processor.js'
import { createTaskQueue } from '../services/task-queue.js'
import { createTaskService } from '../services/task-service.js'
import { initialize as initializeLawDatabase } from '../services/law-whitelist.js'
import { mergeMaterials, getMaterials, materialStoreKey } from '../services/consult-material-store.js'

// 回归测试必须自带环境：.env.local 里的 TASK_QUEUE_MODE/REDIS_URL/TASK_RUN_WORKER
// 面向真实部署，不能决定测试行为，否则本地无 Redis 时 enqueue 会直接失败。
// Fake LLM仍会经过咨询runner的法规初始化；先隔离其单例，避免打开现役labor.db。
initializeLawDatabase(':memory:')
const database = createBusinessDatabase(':memory:')
const directory = mkdtempSync(join(tmpdir(), 'fafee-task-platform-'))
const fileStore = createTaskFileStore({ root: directory })
const taskService = createTaskService(database)
const inviteRows = [
  ['invite-a', 'hash-a', 'user-a', 'task-a@example.com'],
  ['invite-b', 'hash-b', 'user-b', 'task-b@example.com']
]
for (const [inviteId, hash, userId, email] of inviteRows) {
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)').run(inviteId, hash, new Date().toISOString())
  database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, userId, email, 'hash', 'salt', inviteId, new Date().toISOString())
}

const processor = createTaskProcessor({ taskService, fileStore, fakeLlm: true })
const queue = createTaskQueue({ taskService, processTask: processor.processTask, mode: 'local', workerEnabled: true, pollIntervalMs: 30 })
let apiOnlyRecoveryCalls = 0
const apiOnlyQueue = createTaskQueue({
  taskService: { recoverInFlight: () => { apiOnlyRecoveryCalls += 1 } },
  processTask: async () => {},
  mode: 'local',
  workerEnabled: false
})
const app = express()
app.use(express.json())
app.use((req, res, next) => {
  req.user = { id: req.get('X-Test-User') || 'user-a' }
  next()
})
app.use('/api', createTaskRouter({ taskService, taskQueue: queue, fileStore, fakeLlm: true }))

const server = await new Promise((resolve) => {
  const listener = app.listen(0, () => resolve(listener))
})
const baseUrl = `http://127.0.0.1:${server.address().port}`
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.headers || {}) } })

const waitFor = async (check, timeoutMs = 5000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('等待任务状态超时')
}

try {
  await apiOnlyQueue.start()
  assert.equal(apiOnlyRecoveryCalls, 0, 'API-only 进程不能恢复 Worker 任务')
  await apiOnlyQueue.close()
  await queue.start()
  const body = new FormData()
  body.append('message', '请重点检查付款和违约责任')
  body.append('mode', 'fast')
  body.append('title', '任务平台 Fake LLM 验收')
  body.append('files', new Blob(['第一条 付款方式：合同签署后支付首笔款。'], { type: 'text/plain' }), '合同.txt')
  const createdResponse = await request('/api/tasks/contract-review', { method: 'POST', body })
  assert.equal(createdResponse.status, 202)
  const created = await createdResponse.json()
  assert.ok(created.taskId)
  assert.equal(created.status, 'queued')
  assert.ok(created.task?.files?.[0])
  assert.equal('storagePath' in created.task.files[0], false, '任务 API 不得暴露私有存储路径')

  const finished = await waitFor(async () => {
    const response = await request(`/api/tasks/${created.taskId}`)
    const payload = await response.json()
    return payload.task?.status === 'succeeded' ? payload.task : null
  })
  assert.equal(finished.result.fake, true)
  assert.equal(finished.result.contractText, '第一条 付款方式：合同签署后支付首笔款。')

  const eventsResponse = await request(`/api/tasks/${created.taskId}/events?after=0`, { headers: { Accept: 'text/event-stream' } })
  assert.equal(eventsResponse.status, 200)
  const eventsText = await eventsResponse.text()
  assert.match(eventsText, /event: task\.created/)
  assert.match(eventsText, /event: stage\.start/)
  assert.match(eventsText, /event: rewrite\.result/)
  assert.match(eventsText, /event: done/)
  const replayResponse = await request(`/api/tasks/${created.taskId}/events?after=${finished.lastEventSeq - 2}`, { headers: { Accept: 'text/event-stream' } })
  const replayText = await replayResponse.text()
  assert.doesNotMatch(replayText, /event: task\.created/)
  assert.match(replayText, /event: task\.succeeded/)
  const checkpointCount = database.prepare('SELECT COUNT(*) AS count FROM task_checkpoints WHERE task_id = ?').get(created.taskId).count
  assert.ok(checkpointCount >= 5)

  const temporaryBody = new FormData()
  temporaryBody.append('message', '侧边临时审查')
  temporaryBody.append('threadId', 'temporary-review-thread')
  temporaryBody.append('temporary', 'true')
  temporaryBody.append('files', new Blob(['第一条 临时合同内容。'], { type: 'text/plain' }), '临时合同.txt')
  const temporaryResponse = await request('/api/tasks/contract-review', { method: 'POST', body: temporaryBody })
  assert.equal(temporaryResponse.status, 202)
  const temporary = await temporaryResponse.json()
  assert.equal(taskService.getTaskInput(temporary.taskId).temporary, true)
  assert.equal((await request(`/api/tasks/${temporary.taskId}`)).status, 200, '临时会话仍可读取正在执行的任务')
  const durableList = await (await request('/api/tasks?productId=contract-review&limit=1')).json()
  assert.deepEqual(durableList.tasks.map((item) => item.id), [created.taskId], '临时会话必须在分页前排除，且不影响普通历史')
  assert.equal(taskService.listTasks('user-a').some((item) => item.id === temporary.taskId), false)
  await waitFor(() => taskService.getTask(temporary.taskId)?.status === 'succeeded')

  const laborBody = new FormData()
  laborBody.append('message', '请分析这份劳动合同的试用期和解除风险')
  laborBody.append('threadId', 'labor-thread-test')
  laborBody.append('mode', 'fast')
  laborBody.append('files', new Blob(['劳动合同：试用期三个月，双方可依法解除。'], { type: 'text/plain' }), '劳动合同.txt')
  const laborCreatedResponse = await request('/api/tasks/labor-consult', { method: 'POST', body: laborBody })
  assert.equal(laborCreatedResponse.status, 202)
  const laborCreated = await laborCreatedResponse.json()
  assert.equal(laborCreated.productId, 'labor-consult')
  assert.ok(laborCreated.taskId)
  const laborFinished = await waitFor(async () => {
    const response = await request(`/api/tasks/${laborCreated.taskId}`)
    const payload = await response.json()
    return payload.task?.status === 'succeeded' ? payload.task : null
  })
  assert.match(laborFinished.result.answer, /Fake LLM 用工咨询结果/)
  assert.equal(laborFinished.result.mode, 'fast')
  assert.equal(
    database.prepare('SELECT parse_status FROM task_files WHERE task_id = ?').get(laborCreated.taskId)?.parse_status,
    'succeeded'
  )
  const laborEventsResponse = await request(`/api/tasks/${laborCreated.taskId}/events?after=0`, { headers: { Accept: 'text/event-stream' } })
  const laborEventsText = await laborEventsResponse.text()
  assert.match(laborEventsText, /event: consult\.start/)
  assert.match(laborEventsText, /event: consult\.evidence/)
  assert.match(laborEventsText, /event: consult\.delta/)
  assert.match(laborEventsText, /event: consult\.citations/)
  assert.ok(database.prepare("SELECT COUNT(*) AS count FROM task_checkpoints WHERE task_id = ? AND stage IN ('materials', 'retrieval', 'generation')").get(laborCreated.taskId).count >= 3)
  const laborSourcePath = database.prepare('SELECT storage_path FROM task_files WHERE task_id = ?').get(laborCreated.taskId).storage_path
  const ownerMaterialKey = materialStoreKey('user-a', 'labor-thread-test')
  const otherMaterialKey = materialStoreKey('user-b', 'labor-thread-test')
  mergeMaterials(otherMaterialKey, [{ name: '另一用户材料', text: '应保留' }])
  const forget = (user) => request('/api/labor-consult/forget', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-User': user }, body: JSON.stringify({ conversationId: 'labor-thread-test' }) })
  assert.equal((await forget('user-b')).status, 200)
  assert.ok(taskService.getTaskInternal(laborCreated.taskId))
  mergeMaterials(otherMaterialKey, [{ name: '另一用户材料', text: '应保留' }])
  const removeFiles = fileStore.removeTaskFiles
  fileStore.removeTaskFiles = async () => { throw new Error('synthetic cleanup failure') }
  try { assert.equal((await forget('user-a')).status, 500) } finally { fileStore.removeTaskFiles = removeFiles }
  assert.ok(taskService.getCheckpoint(laborCreated.taskId, 'material-source'))
  assert.ok(getMaterials(ownerMaterialKey).length)
  assert.equal((await forget('user-a')).status, 200)
  assert.equal(taskService.getTaskInternal(laborCreated.taskId), null)
  assert.equal(taskService.getCheckpoint(laborCreated.taskId, 'material-source'), null)
  assert.equal(existsSync(laborSourcePath), false)
  assert.equal(getMaterials(ownerMaterialKey).length, 0)
  assert.equal(getMaterials(otherMaterialKey)[0].text, '应保留')

  const emptyLaborBody = new FormData()
  emptyLaborBody.append('message', '请说明附件为空文本时如何继续咨询')
  emptyLaborBody.append('threadId', 'labor-thread-empty')
  emptyLaborBody.append('mode', 'fast')
  emptyLaborBody.append('files', new Blob(['  \r\n  '], { type: 'text/plain' }), '空文本.txt')
  const emptyLaborResponse = await request('/api/tasks/labor-consult', { method: 'POST', body: emptyLaborBody })
  assert.equal(emptyLaborResponse.status, 202)
  const emptyLaborCreated = await emptyLaborResponse.json()
  const emptyLaborFinished = await waitFor(async () => {
    const response = await request(`/api/tasks/${emptyLaborCreated.taskId}`)
    const payload = await response.json()
    return payload.task?.status === 'succeeded' ? payload.task : null
  })
  assert.equal(
    database.prepare('SELECT parse_status FROM task_files WHERE task_id = ?').get(emptyLaborCreated.taskId)?.parse_status,
    'empty'
  )
  assert.ok(emptyLaborFinished.result.warnings.some((warning) => warning.includes('未提取到可用文字')))

  const brokenDocx = await new JSZip().file('placeholder.txt', 'not a Word document').generateAsync({ type: 'nodebuffer' })
  const failedLaborBody = new FormData()
  failedLaborBody.append('message', '请在附件解析失败时仅依据当前问题回复并提示材料未读取')
  failedLaborBody.append('threadId', 'labor-thread-failed')
  failedLaborBody.append('mode', 'fast')
  failedLaborBody.append(
    'files',
    new Blob([brokenDocx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    '无法解析.docx'
  )
  const failedLaborResponse = await request('/api/tasks/labor-consult', { method: 'POST', body: failedLaborBody })
  assert.equal(failedLaborResponse.status, 202)
  const failedLaborCreated = await failedLaborResponse.json()
  const failedLaborFinished = await waitFor(async () => {
    const response = await request(`/api/tasks/${failedLaborCreated.taskId}`)
    const payload = await response.json()
    return payload.task?.status === 'succeeded' ? payload.task : null
  })
  assert.equal(
    database.prepare('SELECT parse_status FROM task_files WHERE task_id = ?').get(failedLaborCreated.taskId)?.parse_status,
    'failed'
  )
  assert.ok(failedLaborFinished.result.warnings.some((warning) => warning.includes('DOCX 解析失败')))

  const forbidden = await request(`/api/tasks/${created.taskId}`, { headers: { 'X-Test-User': 'user-b' } })
  assert.equal(forbidden.status, 404)

  const queued = taskService.createTask({ userId: 'user-a', title: '取消测试', files: [] })
  const cancelled = taskService.requestCancel(queued.id, 'user-a')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(taskService.isTerminal(cancelled.status), true)

  const retry = taskService.createTask({ userId: 'user-a', title: '重试测试', files: [] })
  taskService.claimTask(retry.id)
  taskService.retryTask(retry.id, new Error('upstream timeout'), 1)
  assert.equal(taskService.getTaskInternal(retry.id).status, 'retry_waiting')
  assert.ok(taskService.getTaskInternal(retry.id).nextRunAt)

  const recovered = taskService.createTask({ userId: 'user-a', title: '重启恢复测试', files: [] })
  taskService.claimTask(recovered.id)
  assert.equal(taskService.getTaskInternal(recovered.id).status, 'running')
  taskService.recoverInFlight()
  assert.equal(taskService.getTaskInternal(recovered.id).status, 'queued')
  assert.ok(taskService.getEvents(recovered.id, null, 0).some((event) => event.event === 'task.recovered'))

  const storedPath = database.prepare('SELECT storage_path FROM task_files WHERE task_id = ?').get(created.taskId)?.storage_path
  assert.ok(storedPath)
  assert.equal(readFileSync(storedPath, 'utf8'), '第一条 付款方式：合同签署后支付首笔款。')

  const duplicate = taskService.createTask({
    userId: 'user-a',
    title: '重复领取保护测试',
    files: [{ originalName: '合同.txt', size: 1, mimeType: 'text/plain', storagePath: storedPath }]
  })
  taskService.claimTask(duplicate.id)
  const duplicateResult = await processor.processTask(duplicate.id)
  assert.equal(duplicateResult.status, 'running', '重复 Job 不得再次执行 running 任务')
  console.log('Task platform regression passed: creation, durable events, checkpoints, Fake LLM workflow, ownership isolation, cancellation and retry state.')
} finally {
  await queue.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
