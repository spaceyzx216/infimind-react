import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { ACCEPTED_TYPES, isValidAttachment } from '../workflows/contract-review.js'
import {
  DRAFT_INTENT_CLARIFICATION,
  DRAFT_OPERATIONS,
  DraftInputError,
  normalizeDraftHistory,
  normalizeDraftSnapshot,
  resolveDraftIntent
} from '../workflows/contract-draft.js'

const MAX_FILES = 6
const MAX_FILE_SIZE = 80 * 1024 * 1024
const MAX_MESSAGE_LENGTH = 16000
const MAX_THREAD_ID_LENGTH = 200

const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE }
})

const jsonError = (res, status, message, code = 'bad_request') => res.status(status).json({ error: message, code })

const normalizeMode = (value) => value === 'fast' ? 'fast' : 'thinking'

const parseJsonValue = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

const normalizeConversationHistory = (value) => (Array.isArray(value) ? value : [])
  .filter((item) => item && typeof item === 'object' && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
  .slice(-12)
  .map((item) => ({
    role: item.role,
    content: item.content.slice(0, 6000)
  }))

const normalizeThreadId = (value) => String(value || '').trim().slice(0, MAX_THREAD_ID_LENGTH)

const draftTaskError = (res, error) => {
  if (error instanceof DraftInputError) return jsonError(res, error.status, error.message, error.code)
  return jsonError(res, 400, error?.message || '合同起草任务参数无效', error?.code || 'draft_input_invalid')
}

// 审查任务与起草任务共用同一套「同一对话串行」约束，命中时返回 409 而不是 503，
// 让前端能区分「旧任务还没结束」与「服务暂时不可用」。
// better-sqlite3 的报错只给出列名（UNIQUE constraint failed: tasks.user_id, tasks.thread_id），
// 不带索引名，所以按列名判定，并限定为 tasks 表的 user_id/thread_id 组合。
// 起草与审查各自有独立的部分唯一索引，因此再按 product_id 区分冲突类型。
const isUniqueThreadBusyError = (error) => {
  const code = String(error?.code || '')
  const message = String(error?.message || '')
  return code.startsWith('SQLITE_CONSTRAINT_UNIQUE')
    && /tasks\.user_id/.test(message)
    && /tasks\.thread_id/.test(message)
}

export function createTaskRouter({
  taskService,
  taskQueue,
  fileStore,
  fakeLlm = String(process.env.TASK_FAKE_LLM || '').toLowerCase() === 'true',
  intentResolver = resolveDraftIntent
} = {}) {
  if (!taskService || !taskQueue || !fileStore) throw new Error('task router requires taskService, taskQueue and fileStore')
  const router = Router()

  router.post('/tasks/contract-review', upload.array('files', MAX_FILES), async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const mode = normalizeMode(req.body?.mode)
    const threadId = normalizeThreadId(req.body?.threadId)
    const history = normalizeConversationHistory(parseJsonValue(req.body?.history, []))
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    const files = Array.isArray(req.files) ? req.files : []
    if (!files.length) return jsonError(res, 400, '请至少上传一个合同文件')
    if (message.length > MAX_MESSAGE_LENGTH) return jsonError(res, 400, `审查要求超过 ${MAX_MESSAGE_LENGTH} 个字符，请精简后重试`)
    for (const file of files) {
      if (!isValidAttachment(file)) return jsonError(res, 400, `${file.originalname || '文件'} 文件类型暂不支持`)
    }

    const taskId = randomUUID()
    let storedFiles = []
    let createdTask = null
    try {
      storedFiles = (await fileStore.saveIncomingFiles(taskId, files)).map((file) => ({ ...file, id: randomUUID() }))
      createdTask = taskService.createTask({
        id: taskId,
        userId: req.user.id,
        productId: 'contract-review',
        threadId: threadId || null,
        title: title || files[0].originalname || '商业合同审查',
        prompt: message,
        mode,
        input: {
          schemaVersion: 1,
          threadId: threadId || null,
          history,
          fileRefs: storedFiles.map((file) => ({
            id: file.id,
            originalName: file.originalName,
            size: file.size,
            mimeType: file.mimeType
          }))
        },
        files: storedFiles
      })
      await taskQueue.enqueue(taskId)
      return res.status(202).json({
        taskId,
        status: createdTask.status,
        productId: createdTask.productId,
        threadId: createdTask.threadId,
        eventsUrl: `/api/tasks/${taskId}/events?after=0`,
        task: createdTask
      })
    } catch (error) {
      if (isUniqueThreadBusyError(error)) {
        const activeTask = threadId ? taskService.getActiveTaskByThread?.(req.user.id, 'contract-review', threadId) : null
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return res.status(409).json({
          error: '该对话已有审查任务正在处理，请先停止或等待其结束',
          code: 'review_task_conflict',
          task: activeTask
        })
      }
      const currentTask = createdTask ? taskService.getTaskInternal(taskId, false) : null
      if (currentTask && !taskService.isTerminal(currentTask.status)) taskService.failTask(taskId, new Error('任务队列暂不可用'), { code: 'queue_unavailable' })
      await fileStore.removeTaskFiles(taskId).catch(() => {})
      console.error('[tasks] create contract-review task failed:', error.message)
      return jsonError(res, 503, '任务暂时无法创建，请稍后重试', 'task_unavailable')
    }
  })

  router.post('/tasks/contract-draft', upload.array('files', MAX_FILES), async (req, res) => {
    const inputSnapshotBody = parseJsonValue(req.body?.inputSnapshot, {}) || {}
    const threadId = normalizeThreadId(req.body?.threadId || inputSnapshotBody.threadId)
    const message = typeof req.body?.message === 'string'
      ? req.body.message.trim()
      : String(inputSnapshotBody.message || '').trim()
    const operationInput = req.body?.operation ?? inputSnapshotBody.operation
    const parentTaskId = String(req.body?.parentTaskId || req.body?.baseTaskId || inputSnapshotBody.parentTaskId || '').trim().slice(0, 120)
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    const mode = normalizeMode(req.body?.mode || inputSnapshotBody.mode)
    const files = Array.isArray(req.files) ? req.files : []
    const history = normalizeDraftHistory(req.body?.history ?? inputSnapshotBody.history)
    let currentDraft = normalizeDraftSnapshot(parseJsonValue(
      req.body?.currentDraft ?? req.body?.baseDraft ?? inputSnapshotBody.currentDraft ?? inputSnapshotBody.baseDraft,
      null
    ))

    if (!threadId) return jsonError(res, 400, '缺少 threadId，无法保证同一对话的起草任务串行执行', 'thread_id_required')
    if (message.length > MAX_MESSAGE_LENGTH) return jsonError(res, 400, `起草要求超过 ${MAX_MESSAGE_LENGTH} 个字符，请精简后重试`)
    for (const file of files) {
      if (!isValidAttachment(file)) return jsonError(res, 400, `${file.originalname || '文件'} 文件类型暂不支持`)
    }

    let parentTask = null
    if (parentTaskId) {
      parentTask = taskService.getTask(parentTaskId, req.user.id, true)
      if (!parentTask || parentTask.productId !== 'contract-draft') {
        return jsonError(res, 404, '基础起草任务不存在或无权访问', 'parent_task_not_found')
      }
      if (parentTask.status !== 'succeeded' || !parentTask.result?.draftText) {
        return jsonError(res, 409, '基础起草任务尚未保存可用的正式草稿', 'parent_draft_unavailable')
      }
      const parentInput = taskService.getTaskInput?.(parentTaskId, req.user.id) || {}
      if (parentInput.threadId && parentInput.threadId !== threadId) {
        return jsonError(res, 400, 'parentTaskId 与 threadId 不属于同一对话', 'parent_thread_mismatch')
      }
      currentDraft = normalizeDraftSnapshot(parentTask.result)
      if (!currentDraft?.valid) return jsonError(res, 409, '基础起草任务的正式草稿结构无效', 'parent_draft_invalid')
    }

    const hasExistingDraft = Boolean(currentDraft?.draftText) || history.some((item) => item.content.includes('【当前合同草稿'))
    let intent
    try {
      intent = await intentResolver({
        operation: operationInput,
        message,
        hasExistingDraft,
        attachments: files,
        fakeLlm
      })
    } catch (error) {
      return draftTaskError(res, error)
    }
    if (intent.action === 'clarify') {
      return res.status(422).json({ error: DRAFT_INTENT_CLARIFICATION, code: 'draft_intent_clarification', requiresClarification: true })
    }
    if (intent.action === 'chat') {
      return res.status(409).json({
        error: '本轮是条款咨询或解释请求，请继续使用合同起草 SSE 接口',
        code: 'draft_sse_required',
        route: '/api/contract-draft',
        action: 'chat'
      })
    }
    if (!message && !files.length) return jsonError(res, 400, '请描述合同类型、交易背景和关键要求', 'draft_message_required')
    if ([DRAFT_OPERATIONS.REGENERATE, DRAFT_OPERATIONS.UPDATE, DRAFT_OPERATIONS.ATTACHMENT_UPDATE].includes(intent.operation) && !currentDraft?.draftText) {
      return jsonError(res, 400, '重新生成或更新全文需要提供 parentTaskId 或当前草稿快照', 'base_draft_required')
    }
    if (currentDraft && !currentDraft.valid && [DRAFT_OPERATIONS.REGENERATE, DRAFT_OPERATIONS.UPDATE, DRAFT_OPERATIONS.ATTACHMENT_UPDATE].includes(intent.operation)) {
      return jsonError(res, 400, '当前草稿快照未通过结构校验，不能作为正式版本基础', 'base_draft_invalid')
    }

    const taskId = randomUUID()
    let storedFiles = []
    let createdTask = null
    try {
      const savedFiles = await fileStore.saveIncomingFiles(taskId, files)
      storedFiles = savedFiles.map((file) => ({ ...file, id: randomUUID() }))
      const fileRefs = storedFiles.map((file) => ({
        id: file.id,
        originalName: file.originalName,
        size: file.size,
        mimeType: file.mimeType
      }))
      const taskInput = {
        schemaVersion: 1,
        operation: intent.operation,
        threadId,
        parentTaskId: parentTaskId || null,
        message,
        history,
        currentDraft,
        baseDraft: currentDraft,
        fileRefs,
        inputSnapshot: { message, history, currentDraft }
      }
      createdTask = taskService.createTask({
        id: taskId,
        userId: req.user.id,
        productId: 'contract-draft',
        threadId,
        title: title || currentDraft?.title || '合同起草任务',
        prompt: message,
        mode,
        workflowVersion: 'contract-draft-v1',
        input: taskInput,
        files: storedFiles
      })
      await taskQueue.enqueue(taskId)
      return res.status(202).json({
        taskId,
        status: createdTask.status,
        productId: createdTask.productId,
        threadId,
        operation: intent.operation,
        eventsUrl: `/api/tasks/${taskId}/events?after=0`,
        task: createdTask
      })
    } catch (error) {
      if (isUniqueThreadBusyError(error)) {
        const activeTask = taskService.getActiveTaskByThread?.(req.user.id, 'contract-draft', threadId)
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return res.status(409).json({
          error: '该对话已有完整合同起草任务正在处理，请等待其完成或取消后再提交',
          code: 'draft_task_conflict',
          task: activeTask
        })
      }
      const currentTask = createdTask ? taskService.getTaskInternal(taskId, false) : null
      if (currentTask && !taskService.isTerminal(currentTask.status)) taskService.failTask(taskId, new Error('任务队列暂不可用'), { code: 'queue_unavailable' })
      await fileStore.removeTaskFiles(taskId).catch(() => {})
      console.error('[tasks] create contract-draft task failed:', error.message)
      return jsonError(res, 503, '合同起草任务暂时无法创建，请稍后重试', 'task_unavailable')
    }
  })

  router.get('/tasks', (req, res) => {
    const limit = Number(req.query.limit) || 20
    res.json({ tasks: taskService.listTasks(req.user.id, limit) })
  })

  router.get('/tasks/:taskId', (req, res) => {
    const task = taskService.getTask(req.params.taskId, req.user.id, true)
    if (!task) return jsonError(res, 404, '任务不存在或无权访问', 'task_not_found')
    return res.json({ task })
  })

  router.get('/tasks/:taskId/events', (req, res) => {
    const task = taskService.getTask(req.params.taskId, req.user.id, false)
    if (!task) return jsonError(res, 404, '任务不存在或无权访问', 'task_not_found')
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    const startedAt = Date.now()
    let after = Math.max(0, Number(req.query.after) || 0)
    let closed = false
    let pollTimer = null
    let keepAliveTimer = null
    const close = () => {
      if (closed) return
      closed = true
      if (pollTimer) clearTimeout(pollTimer)
      if (keepAliveTimer) clearInterval(keepAliveTimer)
      if (!res.writableEnded) res.end()
    }
    const writeEvents = () => {
      if (closed) return
      const events = taskService.getEvents(req.params.taskId, req.user.id, after, 500)
      if (events === null) return close()
      for (const item of events) {
        after = item.seq
        res.write(`id: ${item.seq}\nevent: ${item.event}\ndata: ${JSON.stringify({ ...item.data, _seq: item.seq })}\n\n`)
      }
      const current = taskService.getTask(req.params.taskId, req.user.id, false)
      if (!current || (taskService.isTerminal(current.status) && events.length === 0)) return close()
      if (Date.now() - startedAt > 30 * 60 * 1000) return close()
      pollTimer = setTimeout(writeEvents, 300)
    }
    keepAliveTimer = setInterval(() => { if (!closed) res.write(': keep-alive\n\n') }, 15000)
    keepAliveTimer.unref?.()
    req.on('close', close)
    writeEvents()
  })

  router.post('/tasks/:taskId/cancel', (req, res) => {
    const task = taskService.requestCancel(req.params.taskId, req.user.id)
    if (!task) return jsonError(res, 404, '任务不存在或无权访问', 'task_not_found')
    return res.json({ task })
  })

  return router
}

export { ACCEPTED_TYPES, MAX_FILE_SIZE }
