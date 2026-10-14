import { Router } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { MAX_FILES, MAX_FILE_SIZE, isAcceptableFile } from '../services/upload-config.js'
import { HANDBOOK_PRODUCT } from '../workflows/handbook-diagnosis.js'

const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8',
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE, fieldSize: 12 * 1024 * 1024 } })
const text = (value) => typeof value === 'string' ? value.trim() : ''
const bad = (res, status, message, code = 'handbook_input_invalid') => res.status(status).json({ error: message, code })
const expired = (task) => !task || new Date(task.resultExpiresAt).getTime() <= Date.now()

export function createHandbookTaskRouter({ taskService, taskQueue, fileStore, deleteThread, creatingThreads, deletingThreads, deletionKey }) {
  const router = Router()
  router.get('/tasks/handbook-diagnosis/thread/:threadId', (req, res) => {
    const threadId = text(req.params.threadId)
    if (!threadId || threadId.length > 200) return bad(res, 400, '会话 ID 无效')
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0))
    const tasks = taskService.listThreadTasks(req.user.id, HANDBOOK_PRODUCT, threadId, 200, { offset })
    if (!tasks.length && !offset) return bad(res, 404, '会话不存在或无权访问', 'thread_not_found')
    return res.json({ tasks, hasMore: tasks.length === 200 })
  })
  router.delete('/tasks/handbook-diagnosis/thread/:threadId', (req, res) => deleteThread(req, res, HANDBOOK_PRODUCT))
  router.get('/tasks/handbook-diagnosis/:taskId/report', (req, res) => {
    const task = taskService.getTask(req.params.taskId, req.user.id, true)
    if (!task || task.productId !== HANDBOOK_PRODUCT) return bad(res, 404, '诊断任务不存在或无权访问', 'task_not_found')
    if (expired(task)) return bad(res, 410, '诊断材料已到保存期限，请重新提交', 'handbook_source_expired')
    res.set('Cache-Control', 'no-store, private')
    const input = taskService.getTaskInput(task.id) || {}
    return res.json({ task, report: task.result || taskService.getCheckpoint(task.id, 'handbook-report')?.result?.result || null,
      sourceTaskId: input.action === 'followup' ? input.sourceTaskId : '' })
  })
  router.post('/tasks/handbook-diagnosis', upload.array('files', MAX_FILES), async (req, res) => {
    const action = req.body?.action || 'analyze'
    if (!['analyze', 'restart', 'followup'].includes(action)) return bad(res, 400, '不支持的诊断操作')
    const files = Array.isArray(req.files) ? req.files : []
    const submittedText = text(req.body?.text)
    const message = text(req.body?.message)
    const focus = text(req.body?.focus)
    if (submittedText.length > 2000000) return bad(res, 400, '提交正文过长，请分文件提交；正文未被截断')
    if (focus.length > 16000 || message.length > 16000) return bad(res, 400, '检查要求或追问过长，请精简')
    if (files.some((file) => !isAcceptableFile(file))) return bad(res, 400, '存在暂不支持的文件格式')
    if (action === 'analyze' && !files.length && !submittedText) return bad(res, 400, '请上传员工手册或粘贴制度正文')
    if (action !== 'analyze' && (files.length || submittedText)) return bad(res, 400, '新版正文请开始新诊断，不能混入旧报告追问或恢复任务')
    if (action === 'followup' && !message) return bad(res, 400, '请输入追问内容')
    let threadId = text(req.body?.threadId)
    if (threadId.length > 200) return bad(res, 400, '会话 ID 过长')
    let source = null
    let sourceInput = {}
    let materialTaskId = ''
    if (action !== 'analyze') {
      source = taskService.getTask(text(req.body?.sourceTaskId), req.user.id, true)
      if (!source || source.productId !== HANDBOOK_PRODUCT || (threadId && threadId !== (source.threadId || source.id))) return bad(res, 404, '原诊断不存在或无权使用', 'handbook_source_unavailable')
      if (expired(source)) return bad(res, 410, '原诊断材料已到保存期限，请重新提交', 'handbook_source_expired')
      if (!taskService.isTerminal(source.status)) return bad(res, 409, '原任务尚未结束，请先停止或等待完成', 'handbook_task_conflict')
      if (action === 'followup' && source.result?.analysisStatus !== 'completed') return bad(res, 409, '请先完成诊断，再根据报告追问')
      sourceInput = taskService.getTaskInput(source.id) || {}
      materialTaskId = sourceInput.materialTaskId || source.id
      const materialTask = taskService.getTask(materialTaskId, req.user.id, false)
      if (!materialTask || materialTask.productId !== HANDBOOK_PRODUCT
        || (materialTask.threadId || materialTask.id) !== (source.threadId || source.id) || expired(materialTask))
        return bad(res, 410, '原始材料不可恢复，请重新提交', 'handbook_source_unavailable')
      const cached = taskService.getCheckpoint(source.id, 'handbook-parsing')?.result?.documents?.length
      const availableFiles = taskService.getFiles(materialTaskId).filter((file) => new Date(file.cleanupAt).getTime() > Date.now())
      if (!cached && !sourceInput.text && !availableFiles.length) return bad(res, 410, '没有可恢复的制度正文，请重新提交', 'handbook_source_unavailable')
      threadId = source.threadId || source.id
    }
    const taskId = randomUUID()
    threadId ||= randomUUID()
    const key = deletionKey(req.user.id, HANDBOOK_PRODUCT, threadId)
    if (creatingThreads.has(key) || deletingThreads.has(key)) return bad(res, 409, '会话正在处理提交或删除，请稍后重试', 'handbook_task_conflict')
    const current = taskService.getActiveTaskByThread?.(req.user.id, HANDBOOK_PRODUCT, threadId)
    if (current) return res.status(409).json({ error: '本会话已有任务正在处理，请先停止或等待完成', code: 'handbook_task_conflict', task: current })
    creatingThreads.add(key)
    let created = null
    try {
      const stored = files.length ? (await fileStore.saveIncomingFiles(taskId, files)).map((file) => ({ ...file, id: randomUUID() })) : []
      created = taskService.createTask({ id: taskId, userId: req.user.id, productId: HANDBOOK_PRODUCT, threadId,
        title: text(req.body?.title) || source?.title || files[0]?.originalname || '员工手册诊断', prompt: action === 'followup' ? message : focus,
        mode: req.body?.mode === 'fast' ? 'fast' : 'thinking', workflowVersion: 'handbook-diagnosis-v1',
        input: { schemaVersion: 1, action, text: action === 'analyze' ? submittedText : sourceInput.text || '',
          focus: action === 'analyze' ? focus : sourceInput.focus || '', message, sourceTaskId: source?.id || '', materialTaskId,
          allowPartial: req.body?.allowPartial === true || req.body?.allowPartial === 'true' || (action !== 'analyze' && sourceInput.allowPartial === true),
          temporary: req.body?.temporary === true || req.body?.temporary === 'true',
          fileRefs: stored.map((file) => ({ id: file.id, originalName: file.originalName, size: file.size, mimeType: file.mimeType })) }, files: stored })
      // Copy only retained checkpoints from the verified same-user/product/thread
      // source. This also makes a second restart independent of older sources.
      if (source) for (const cached of taskService.listCheckpoints(source.id).filter((item) => item.stage.startsWith('handbook-') && item.stage !== 'handbook-report' && item.stage !== 'handbook-followup')) taskService.saveCheckpoint(taskId, cached.stage, cached.result)
      await taskQueue.enqueue(taskId)
      return res.status(202).json({ taskId, threadId, productId: HANDBOOK_PRODUCT, status: created.status, task: created, eventsUrl: `/api/tasks/${taskId}/events?after=0` })
    } catch (cause) {
      const currentTask = created ? taskService.getTaskInternal(taskId, false) : null
      if (currentTask && !taskService.isTerminal(currentTask.status)) taskService.failTask(taskId, new Error('诊断任务创建失败，请重新提交'), { code: 'queue_unavailable' })
      await fileStore.removeTaskFiles(taskId).catch(() => {})
      if (String(cause.code || '').startsWith('SQLITE_CONSTRAINT_UNIQUE')) return bad(res, 409, '本会话已有任务正在处理', 'handbook_task_conflict')
      if (cause.code === 'task_thread_expired') return bad(res, 410, cause.message, cause.code)
      return bad(res, 503, '诊断任务暂时无法创建，请稍后重试', 'handbook_task_unavailable')
    } finally { creatingThreads.delete(key) }
  })
  return router
}
