import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskRouter } from '../routes/tasks.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskProcessor } from '../services/task-processor.js'
import { createTaskQueue } from '../services/task-queue.js'
import { createTaskService } from '../services/task-service.js'

// 「审查对话中断与插队发送」及「后台任务入口收敛」的回归验收。
// 覆盖计划中可由服务端断言的部分：同对话不产生并行完整审查任务、
// 排队任务立即取消、运行中任务在阶段边界取消、取消/失败不覆盖已有成功结果、
// 终态任务可继续按 taskId 查询与补拉事件。

const database = createBusinessDatabase(':memory:')
const directory = mkdtempSync(join(tmpdir(), 'fafee-interrupt-'))
const fileStore = createTaskFileStore({ root: directory })
const taskService = createTaskService(database)
for (const [inviteId, userId] of [['invite-a', 'user-a'], ['invite-b', 'user-b']]) {
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)').run(inviteId, `hash-${inviteId}`, new Date().toISOString())
  database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, userId, `${userId}@example.com`, 'hash', 'salt', inviteId, new Date().toISOString())
}

// 处理器默认不自动执行，测试手动驱动，以便精确控制阶段边界。
// workerEnabled 必须为 true，否则本地队列的 enqueue 会直接拒绝；
// enqueue 会立刻调用 tick() 领取任务，因此让队列侧的 processTask 成为空操作，
// 由测试自己调用 processor.processTask 决定何时推进到哪个阶段。
const processor = createTaskProcessor({ taskService, fileStore, fakeLlm: true })
const queue = createTaskQueue({ taskService, processTask: async () => {}, mode: 'local', workerEnabled: true, pollIntervalMs: 60 * 60 * 1000 })

const app = express()
app.use(express.json())
app.use((req, _res, next) => {
  req.user = { id: req.get('X-Test-User') || 'user-a' }
  next()
})
app.use('/api', createTaskRouter({ taskService, taskQueue: queue, fileStore, fakeLlm: true }))

const server = await new Promise((resolve) => {
  const listener = app.listen(0, () => resolve(listener))
})
const baseUrl = `http://127.0.0.1:${server.address().port}`
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.headers || {}) } })

const submitReview = (threadId, message = '请审查付款与违约责任') => {
  const body = new FormData()
  body.append('message', message)
  body.append('mode', 'fast')
  body.append('threadId', threadId)
  body.append('files', new Blob([`第一条 付款方式：${message}`], { type: 'text/plain' }), '合同.txt')
  return request('/api/tasks/contract-review', { method: 'POST', body })
}

try {
  await queue.start()
  // 任务平台回归覆盖同对话串行、取消边界与 taskId 恢复入口。
  // 1. 同一 thread 在旧任务未终态时不得创建第二个完整审查任务。
  //    前端「先取消再发」是软约束，重复提交必须由服务端原子拒绝。
  const first = await (await submitReview('thread-1', '第一轮审查')).json()
  assert.ok(first.taskId, '首个审查任务应创建成功')
  const conflict = await submitReview('thread-1', '插队审查')
  assert.equal(conflict.status, 409, '同对话未终态时必须拒绝第二个审查任务')
  const conflictPayload = await conflict.json()
  assert.equal(conflictPayload.code, 'review_task_conflict')
  assert.equal(conflictPayload.task?.id, first.taskId, '冲突响应应返回占用槽位的活动任务')

  // 2. 不同 thread 可以并行创建，隔离不能过度收紧。
  const otherThread = await (await submitReview('thread-2')).json()
  assert.ok(otherThread.taskId, '不同对话应能各自创建任务')

  // 3. 排队任务取消必须立即进入终态，不等待 Worker。
  //    队列在 enqueue 时会立刻领取任务，因此这里直接构造一个未被领取的排队任务，
  //    对应「提交后还没轮到执行就点了停止」的场景。
  const queuedTask = taskService.createTask({
    userId: 'user-a',
    productId: 'contract-review',
    threadId: 'thread-queued',
    title: '排队取消测试',
    prompt: '排队取消',
    files: []
  })
  assert.equal(taskService.getTaskInternal(queuedTask.id).status, 'queued')
  const cancelQueued = await request(`/api/tasks/${queuedTask.id}/cancel`, { method: 'POST' })
  assert.equal(cancelQueued.status, 200)
  const cancelledQueued = (await cancelQueued.json()).task
  assert.equal(cancelledQueued.status, 'cancelled', '排队任务取消应立即生效')

  // 4. 旧任务终态后，同一 thread 必须能重新创建任务（插队发送的落点）。
  //    先把首个任务推进到终态，释放该对话的串行槽位。
  //    first 已被空操作 Worker 领取为 running，取消只能先标记 cancel_requested，
  //    由处理器在阶段边界收敛为 cancelled，之后槽位才真正释放。
  await request(`/api/tasks/${first.taskId}/cancel`, { method: 'POST' })
  await processor.processTask(first.taskId, { assumedClaimed: true })
  assert.equal(taskService.getTaskInternal(first.taskId).status, 'cancelled', '旧任务必须进入终态')
  const resumedResponse = await submitReview('thread-1', '插队后的新审查')
  assert.equal(resumedResponse.status, 202, '旧任务终态后应能创建新任务')
  const resumed = await resumedResponse.json()
  assert.ok(resumed.taskId, '旧任务终态后同对话应能创建新任务')
  assert.notEqual(resumed.taskId, first.taskId)

  // 5. 运行中任务取消请求落在阶段边界：先进入 cancel_requested，
  //    由处理器的阶段检查点收敛为 cancelled，而不是立刻丢弃结果。
  //    enqueue 已被空操作处理器领取，任务此刻应处于 running。
  assert.equal(taskService.getTaskInternal(resumed.taskId).status, 'running', '入队后任务应被领取为运行中')
  const cancelRunning = await request(`/api/tasks/${resumed.taskId}/cancel`, { method: 'POST' })
  const requestedTask = (await cancelRunning.json()).task
  assert.equal(requestedTask.status, 'cancel_requested', '运行中任务先标记取消请求')
  const processed = await processor.processTask(resumed.taskId, { assumedClaimed: true })
  assert.equal(processed.status, 'cancelled', '运行中任务应在阶段边界收敛为已取消')
  assert.equal(processed.result, null, '取消的任务不得产出正式结果')

  // 6. 取消不得覆盖此前已成功保存的结果：另一条 thread 先跑成功，再发新任务失败。
  const succeededTask = taskService.createTask({
    id: 'succeeded-task',
    userId: 'user-a',
    productId: 'contract-review',
    threadId: 'thread-3',
    title: '成功结果保护',
    prompt: '成功审查',
    files: []
  })
  taskService.claimTask(succeededTask.id)
  taskService.completeTask(succeededTask.id, { analysis: '已保存的分析结果', review: '已保存的审查结果' })
  const preserved = taskService.getTaskInternal(succeededTask.id)
  assert.equal(preserved.status, 'succeeded')
  // 失败与取消都发生在同一 thread 之后，均不得改写已成功的终态结果。
  taskService.failTask(succeededTask.id, new Error('晚到的失败'))
  taskService.requestCancel(succeededTask.id, 'user-a')
  const afterLateEvents = taskService.getTaskInternal(succeededTask.id)
  assert.equal(afterLateEvents.status, 'succeeded', '迟到的失败/取消不得覆盖成功结果')
  assert.equal(afterLateEvents.result?.analysis, '已保存的分析结果', '成功结果内容必须保留')

  // 7. 后台任务入口收敛后，taskId 是恢复入口：终态任务仍可按 taskId 查询与补拉事件。
  const detailResponse = await request(`/api/tasks/${succeededTask.id}`)
  assert.equal(detailResponse.status, 200)
  const detail = (await detailResponse.json()).task
  assert.equal(detail.status, 'succeeded')
  assert.equal(detail.result.analysis, '已保存的分析结果')
  assert.equal('inputJson' in detail, false, '任务查询不得返回原始 input_json')
  assert.equal('input_json' in detail, false, '任务查询不得泄露 input_json 字段')
  assert.ok(detail.files.every((file) => !('storagePath' in file)), '任务查询不得暴露私有存储路径')

  const eventsResponse = await request(`/api/tasks/${succeededTask.id}/events?after=0`, { headers: { Accept: 'text/event-stream' } })
  assert.equal(eventsResponse.status, 200)
  const eventsText = await eventsResponse.text()
  assert.match(eventsText, /event: task\.created/)
  assert.match(eventsText, /event: task\.succeeded/)

  // 8. 越权保护：其他用户既查不到任务详情，也不能取消。
  const forbidden = await request(`/api/tasks/${succeededTask.id}`, { headers: { 'X-Test-User': 'user-b' } })
  assert.equal(forbidden.status, 404, '其他用户不得查看任务详情')
  const forbiddenCancel = await request(`/api/tasks/${succeededTask.id}/cancel`, { method: 'POST', headers: { 'X-Test-User': 'user-b' } })
  assert.equal(forbiddenCancel.status, 404, '其他用户不得取消任务')

  // 9. 服务端任务列表接口保留为通用查询能力（本轮不再于左侧展示）。
  const listResponse = await request('/api/tasks?limit=5')
  assert.equal(listResponse.status, 200)
  const listPayload = await listResponse.json()
  assert.ok(Array.isArray(listPayload.tasks), '任务列表接口应保留')
  assert.ok(listPayload.tasks.every((task) => task.userId === 'user-a'), '任务列表只能返回本人任务')
  assert.ok(listPayload.tasks.every((task) => !('inputJson' in task)), '任务列表不得返回 input_json')

  // 10. 无 threadId 的旧式提交保持可用，不受同对话串行约束影响。
  const legacyBody = new FormData()
  legacyBody.append('message', '旧接口兼容')
  legacyBody.append('files', new Blob(['第一条 兼容性条款'], { type: 'text/plain' }), '兼容.txt')
  const legacyResponse = await request('/api/tasks/contract-review', { method: 'POST', body: legacyBody })
  assert.equal(legacyResponse.status, 202, '无 threadId 的旧式提交应继续可用')

  console.log('Interrupt and task-entry regression passed: per-thread review serialization, queued/running cancellation boundary, late-event result protection, taskId recovery surface, ownership isolation and legacy submission compatibility.')
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
