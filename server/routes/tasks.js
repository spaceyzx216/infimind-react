import { createMaterialRouter } from './materials.js'
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
import { getMaterials, clearMaterials, materialStoreKey } from '../services/consult-material-store.js'
import { LABOR_CONTRACT_RETENTION_POLICY, TASK_RETENTION_POLICY } from '../services/task-service.js'
import { extractText } from '../services/file-parser.js'
import { classifyLaborContractDocument, classifyLaborContractDocumentsWithLlm } from '../workflows/labor-contract-document-classifier.js'
import { CONTEXT_WINDOW_TOKENS, OUTPUT_RESERVE_TOKENS, CONTEXT_SAFETY_TOKENS, selectHistoryByTokens } from '../../src/utils/context-budget.js'
import { refineConversationTitle, isTitleRefineEnabled, toClientResult } from '../services/title-refiner.js'
import { createHandbookTaskRouter } from './handbook-tasks.js'

import { MAX_FILES, MAX_FILE_SIZE } from '../services/upload-config.js'
const MAX_MESSAGE_LENGTH = 16000
const MAX_THREAD_ID_LENGTH = 200
const LABOR_ANALYSIS_TYPES = new Set(['ordinary_labor_contract', 'labor_dispatch_agreement'])
const LABOR_FILE_ROLES = new Set(['dispatch_agreement', 'dispatch_employment_contract', 'supporting_attachment'])
const LABOR_DOCUMENT_TYPES = new Set([
  'direct_labor_contract', 'dispatch_employment_contract', 'dispatch_agreement', 'supporting_attachment', 'unsupported'
])
const LABOR_REVIEW_PERSPECTIVES = new Set(['dispatch_unit', 'using_unit'])

const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE, fieldSize: 12 * 1024 * 1024 }
})

// 仲裁完整文本历史可超过 multer 默认的 1 MB 字段限制；文件限制沿用现有工具。
const arbitrationUpload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE, fieldSize: 12 * 1024 * 1024, fields: 8 }
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
  .map((item) => ({
    role: item.role,
    content: item.content
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
  intentResolver = resolveDraftIntent,
  classifyDocuments = classifyLaborContractDocumentsWithLlm
} = {}) {
  if (!taskService || !taskQueue || !fileStore) throw new Error('task router requires taskService, taskQueue and fileStore')
  const router = Router()
  router.use(createMaterialRouter({ taskService, fileStore }))
  // In-process guard for the demo server: block new turns while deleting files.
  const deletingThreads = new Set()
  const creatingThreads = new Set()
  const deletionKey = (userId, productId, threadId) => JSON.stringify([userId, productId, threadId])
  const deleteThread = async (req, res, productId) => {
    const threadId = normalizeThreadId(req.params.threadId)
    if (!threadId) return jsonError(res, 400, '缺少会话 ID')
    const key = deletionKey(req.user.id, productId, threadId)
    if (deletingThreads.has(key) || creatingThreads.has(key)) return jsonError(res, 409, '会话正在删除，请稍后重试', 'thread_busy')
    const tasks = taskService.listAllThreadTasks(req.user.id, productId, threadId)
    if (!tasks.length) return jsonError(res, 404, '会话不存在或无权删除', 'thread_not_found')
    if (tasks.some((task) => !taskService.isTerminal(task.status))) return jsonError(res, 409, '请先停止当前任务，再删除会话', 'thread_busy')
    deletingThreads.add(key)
    try {
      const results = await Promise.allSettled(tasks.map(async (task) => {
        await fileStore.removeTaskFiles(task.id)
        taskService.removeFileRecords((task.files || []).map((file) => file.id))
      }))
      if (results.some((result) => result.status === 'rejected')) {
        // Keep DB/checkpoints until all files are removed, so the same request can be retried.
        return res.status(500).json({ error: '部分上传文件未能清理，会话记录已保留，请重试删除。', code: 'thread_file_cleanup_failed', deleted: false })
      }
      const outcome = taskService.deleteThreadTasks(req.user.id, productId, threadId)
      if (!outcome.deleted) return jsonError(res, 409, '会话状态已变化，请稍后重试', 'thread_busy')
      if (productId === 'labor-consult') clearMaterials(materialStoreKey(req.user.id, threadId))
      return res.json({ deleted: true, taskIds: outcome.taskIds })
    } catch (error) {
      console.error('[tasks] thread deletion failed:', error.message)
      return jsonError(res, 500, '会话删除未完成，请重试', 'thread_delete_failed')
    } finally { deletingThreads.delete(key) }
  }

  router.post('/labor-consult/forget', async (req, res) => {
    const threadId = normalizeThreadId(req.body?.conversationId)
    if (!threadId) return jsonError(res, 400, '缺少 conversationId')
    if (!taskService.listAllThreadTasks(req.user.id, 'labor-consult', threadId).length) {
      clearMaterials(materialStoreKey(req.user.id, threadId))
      return res.json({ ok: true })
    }
    req.params.threadId = threadId
    return deleteThread(req, res, 'labor-consult')
  })

  router.use(createHandbookTaskRouter({ taskService, taskQueue, fileStore, deleteThread, creatingThreads, deletingThreads, deletionKey }))

  router.post('/tasks/labor-contract-analysis/classify', upload.array('files', MAX_FILES), async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : []
    const clarification = typeof req.body?.clarification === 'string' ? req.body.clarification.trim() : ''
    if (!files.length) return jsonError(res, 400, '请至少选择一个劳动合同或派遣材料文件')
    if (clarification.length > MAX_MESSAGE_LENGTH) return jsonError(res, 400, `材料说明超过 ${MAX_MESSAGE_LENGTH} 个字符，请精简后重试`)
    for (const file of files) {
      if (!isValidAttachment(file)) return jsonError(res, 400, `${file.originalname || '文件'} 文件类型暂不支持`)
    }

    const parsedFiles = []
    for (const [index, file] of files.entries()) {
      try {
        const parsed = await extractText(file)
        const text = String(parsed?.text || '').trim()
        parsedFiles.push({ index, file, text, parseStatus: text ? 'succeeded' : 'empty', parseMetadata: parsed.metadata })
      } catch (error) {
        parsedFiles.push({ index, file, text: '', parseStatus: 'failed', parseError: error })
      }
    }
    const readable = parsedFiles.filter((item) => item.parseStatus === 'succeeded')
    const inferred = fakeLlm
      ? readable.map((item) => classifyLaborContractDocument({ fileName: item.file.originalname, text: item.text }))
      : readable.length ? await classifyDocuments({
        documents: readable.map((item) => ({ fileName: item.file.originalname || '上传文件', text: item.text })), clarification
      }) : []
    let inferredIndex = 0
    const classifications = parsedFiles.map(({ index, file, text, parseStatus, parseError }) => {
      if (parseStatus !== 'succeeded') return {
        index,
        fileName: file.originalname || '上传文件',
        parseStatus,
        suggestedType: 'unsupported',
        suggestedLabel: '其他/暂不支持',
        confidence: 'low',
        reason: parseStatus === 'empty'
          ? '未提取到可分析正文，请换用可解析文件后重试'
          : `文件正文预解析失败：${String(parseError?.message || '请检查文件是否损坏或格式是否受支持').slice(0, 220)}`,
        evidence: ''
      }
      return {
        index,
        fileName: file.originalname || '上传文件',
        parseStatus,
        ...(inferred[inferredIndex++] || {
          suggestedType: 'unsupported', suggestedLabel: '其他/暂不支持', confidence: 'low',
          reason: 'AI 未能返回该文件的类型判断，请补充材料说明后重试。', evidence: ''
        })
      }
    })

    res.set('Cache-Control', 'no-store, private')
    return res.json({
      classifications,
      confirmationRequired: false
    })
  })

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
          temporary: req.body?.temporary === 'true' || req.body?.temporary === true,
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
      if (error?.code === 'task_thread_expired') {
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return jsonError(res, 410, error.message, error.code)
      }
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

  router.post('/tasks/labor-contract-analysis', upload.array('files', MAX_FILES), async (req, res) => {
    const action = ['followup', 'reanalyze', 'restart-analysis'].includes(req.body?.action) ? req.body.action : 'analyze'
    const requestedAnalysisType = String(req.body?.analysisType || 'ordinary_labor_contract').trim()
    if (action === 'analyze' && !LABOR_ANALYSIS_TYPES.has(requestedAnalysisType)) {
      return jsonError(res, 400, '不支持的劳动合同分析类型', 'analysis_type_invalid')
    }
    const focus = typeof req.body?.focus === 'string'
      ? req.body.focus.trim()
      : typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const mode = normalizeMode(req.body?.mode)
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    const files = Array.isArray(req.files) ? req.files : []
    if (action === 'analyze' && !files.length) return jsonError(res, 400, requestedAnalysisType === 'labor_dispatch_agreement' ? '请至少上传一份劳务派遣协议' : '请至少上传一个劳动合同文件')
    if (action !== 'analyze' && files.length) return jsonError(res, 400, '当前任务不能同时上传文件；请以新文件开始新版分析')
    if (action === 'followup' && !message) return jsonError(res, 400, '请输入追问内容')
    if (focus.length > MAX_MESSAGE_LENGTH) return jsonError(res, 400, `分析侧重点超过 ${MAX_MESSAGE_LENGTH} 个字符，请精简后重试`)
    for (const file of files) {
      if (!isValidAttachment(file)) return jsonError(res, 400, `${file.originalname || '文件'} 文件类型暂不支持`)
    }
    const submittedFileRoles = parseJsonValue(req.body?.fileRoles, [])
    const requestedFileRoles = Array.isArray(submittedFileRoles)
      ? submittedFileRoles.map((role) => typeof role === 'string' ? role : role?.role).map((role) => String(role || ''))
      : []
    const submittedDocumentTypes = parseJsonValue(req.body?.documentTypes, null)
    const requestedDocumentTypes = Array.isArray(submittedDocumentTypes)
      ? submittedDocumentTypes.map((type) => String(type || ''))
      : null
    const requestedPerspective = String(req.body?.reviewPerspective || '').trim()
    let analysisType = requestedAnalysisType
    let fileRoles = requestedFileRoles
    let documentTypes = requestedDocumentTypes
    if (action === 'analyze') {
      if (documentTypes) {
        if (documentTypes.length !== files.length || documentTypes.some((type) => !LABOR_DOCUMENT_TYPES.has(type))) {
          return jsonError(res, 400, '请先确认每份文件的材料类型', 'document_types_invalid')
        }
        if (documentTypes.includes('unsupported')) {
          return jsonError(res, 400, '请移除“其他/暂不支持”的文件，或改选正确的材料类型', 'unsupported_document_type')
        }
        const hasDispatchAgreement = documentTypes.includes('dispatch_agreement')
        const hasDispatchContract = documentTypes.includes('dispatch_employment_contract')
        const hasDirectContract = documentTypes.includes('direct_labor_contract')
        if (hasDispatchAgreement && hasDirectContract || hasDispatchContract && hasDirectContract) {
          return jsonError(res, 400, '普通劳动合同与劳务派遣材料请分开分析；可在一个派遣分析中上传协议和配套派遣劳动合同。', 'mixed_document_types')
        }
        if (hasDispatchAgreement) {
          analysisType = 'labor_dispatch_agreement'
          fileRoles = documentTypes
          if (documentTypes.filter((type) => type === 'dispatch_agreement').length !== 1) {
            return jsonError(res, 400, '一次派遣分析请指定一份派遣协议；其他协议请另建分析。', 'dispatch_agreement_count_invalid')
          }
          if (!LABOR_REVIEW_PERSPECTIVES.has(requestedPerspective)) {
            return jsonError(res, 400, '请选择您代表派遣单位还是用工单位', 'review_perspective_required')
          }
        } else if (hasDispatchContract || hasDirectContract) {
          analysisType = 'ordinary_labor_contract'
          fileRoles = documentTypes
        } else {
          return jsonError(res, 400, '请至少选择一份普通劳动合同或劳务派遣协议作为分析主文件', 'analysis_document_required')
        }
      } else if (requestedAnalysisType === 'labor_dispatch_agreement') {
        // 兼容旧版页面：仍要求用户为每份派遣材料指定角色。
        if (!LABOR_REVIEW_PERSPECTIVES.has(requestedPerspective)) {
          return jsonError(res, 400, '请选择您代表派遣单位还是用工单位', 'review_perspective_required')
        }
        if (requestedFileRoles.length !== files.length || requestedFileRoles.some((role) => !LABOR_FILE_ROLES.has(role))) {
          return jsonError(res, 400, '请为每个文件选择材料类型', 'file_roles_invalid')
        }
        if (requestedFileRoles.filter((role) => role === 'dispatch_agreement').length !== 1) {
          return jsonError(res, 400, '请上传且仅上传一份劳务派遣协议作为主文件', 'dispatch_agreement_required')
        }
        documentTypes = requestedFileRoles
      } else {
        documentTypes = files.map(() => 'direct_labor_contract')
      }
    }

    const taskId = randomUUID()
    const sourceTaskId = String(req.body?.sourceTaskId || '').trim()
    const reportTaskId = String(req.body?.reportTaskId || '').trim()
    const sourceTask = sourceTaskId ? taskService.getTask(sourceTaskId, req.user.id, true) : null
    const reportTask = reportTaskId ? taskService.getTask(reportTaskId, req.user.id, true) : null
    if (sourceTaskId && (!sourceTask || sourceTask.productId !== 'labor-contract-analysis')) {
      return jsonError(res, 404, '原合同任务不存在或无权访问', 'source_task_not_found')
    }
    if (sourceTask?.resultExpiresAt && new Date(sourceTask.resultExpiresAt).getTime() <= Date.now()) {
      return jsonError(res, 410, '合同会话已到保存期限，请重新上传开始新分析。', 'source_expired')
    }
    const sourceInput = sourceTask ? taskService.getTaskInput?.(sourceTask.id, req.user.id) || {} : {}
    // 劳动合同分析与其他任务队列产品共用原文及会话保留期限。
    const retentionPolicy = LABOR_CONTRACT_RETENTION_POLICY
    analysisType = action === 'analyze'
      ? analysisType
      : LABOR_ANALYSIS_TYPES.has(sourceInput.analysisType)
        ? sourceInput.analysisType
        : LABOR_ANALYSIS_TYPES.has(reportTask?.result?.analysisType) ? reportTask.result.analysisType : 'ordinary_labor_contract'
    const reviewPerspective = action === 'analyze'
      ? (analysisType === 'labor_dispatch_agreement' ? requestedPerspective : '')
      : (sourceInput.reviewPerspective || reportTask?.result?.reviewPerspective || '')
    fileRoles = action === 'analyze' && analysisType === 'labor_dispatch_agreement'
      ? fileRoles
      : Array.isArray(sourceInput.fileRoles) ? sourceInput.fileRoles : []
    const threadId = sourceTask ? (sourceTask.threadId || sourceTask.id) : taskId
    if (deletingThreads.has(deletionKey(req.user.id, 'labor-contract-analysis', threadId))) return jsonError(res, 409, '会话正在删除，请稍后再提交', 'thread_busy')
    if (action !== 'analyze') {
      if (!sourceTask || sourceTask.status === 'queued' || sourceTask.status === 'running'
        || sourceTask.status === 'retry_waiting' || sourceTask.status === 'cancel_requested') {
        return jsonError(res, 409, '原任务尚未停止，暂时不能继续提交', 'source_task_active')
      }
      if (action === 'restart-analysis') {
        const sourceFiles = taskService.getFiles(sourceTask.id)
        const parsedDocuments = taskService.getLaborSourceDocuments(sourceTask.id)
        const sourceAvailable = sourceFiles.length && sourceFiles.every((file) => new Date(file.cleanupAt).getTime() > Date.now())
        if (!parsedDocuments.length && !sourceAvailable) {
          return jsonError(res, 404, '这段历史没有保存可继续分析的原文，请重新上传合同。', 'source_unavailable')
        }
      } else if (!reportTask || reportTask.productId !== 'labor-contract-analysis'
        || reportTask.status !== 'succeeded' || (reportTask.threadId || reportTask.id) !== threadId
        || reportTask.result?.analysisStatus !== 'completed'
        || (reportTask.result?.sourceTaskId || reportTask.id) !== sourceTask.id) {
        return jsonError(res, 404, '分析报告不存在或无权访问', 'report_not_found')
      }
      if (action === 'reanalyze') {
        const available = taskService.getLaborSourceDocuments(sourceTask.id).length > 0
        if (!available) return jsonError(res, 404, '这段历史没有保存可继续分析的原文，请重新上传合同。', 'source_unavailable')
      }
    }
    const activeTask = taskService.getActiveTaskByThread?.(req.user.id, 'labor-contract-analysis', threadId)
    if (activeTask) return jsonError(res, 409, '当前会话仍有任务在处理，请稍后继续。', 'thread_busy')
    const creationKey = deletionKey(req.user.id, 'labor-contract-analysis', threadId)
    if (creatingThreads.has(creationKey)) return jsonError(res, 409, '当前会话正在提交，请稍后重试', 'thread_busy')
    creatingThreads.add(creationKey)
    let storedFiles = []
    let createdTask = null
    try {
      const savedFiles = files.length ? await fileStore.saveIncomingFiles(taskId, files) : []
      storedFiles = savedFiles.map((file) => ({ ...file, id: randomUUID() }))
      const fileRefs = storedFiles.map((file, index) => ({
        id: file.id,
        originalName: file.originalName,
        size: file.size,
        mimeType: file.mimeType,
        role: (documentTypes || fileRoles)[index] || ''
      }))
      const primaryFileIndex = fileRoles.indexOf('dispatch_agreement')
      const primaryFile = primaryFileIndex >= 0 ? files[primaryFileIndex] : files[0]
      createdTask = taskService.createTask({
        id: taskId,
        userId: req.user.id,
        productId: 'labor-contract-analysis',
        threadId,
        title: title || (action === 'followup' ? message.slice(0, 80) : `${analysisType === 'labor_dispatch_agreement' ? '劳务派遣协议分析' : '劳动合同分析'}：${primaryFile?.originalname || sourceTask?.title || '上传文件'}`),
        prompt: action === 'followup' ? message : focus,
        mode,
        workflowVersion: 'labor-contract-analysis-v3',
        input: {
          schemaVersion: 3, action, focus, message, mode, fileRefs,
          temporary: req.body?.temporary === 'true' || req.body?.temporary === true,
          analysisType, reviewPerspective, fileRoles, documentTypes, sourceTaskId, reportTaskId, retentionPolicy
        },
        files: storedFiles
      })
      await taskQueue.enqueue(taskId)
      return res.status(202).json({
        taskId,
        status: createdTask.status,
        productId: createdTask.productId,
        eventsUrl: `/api/tasks/${taskId}/events?after=0`,
        task: createdTask
      })
    } catch (error) {
      if (error?.code === 'task_thread_expired') {
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return jsonError(res, 410, error.message, error.code)
      }
      const currentTask = createdTask ? taskService.getTaskInternal(taskId, false) : null
      if (currentTask && !taskService.isTerminal(currentTask.status)) taskService.failTask(taskId, new Error('任务队列暂不可用'), { code: 'queue_unavailable' })
      await fileStore.removeTaskFiles(taskId).catch(() => {})
      if (isUniqueThreadBusyError(error)) return jsonError(res, 409, '当前会话仍有任务在处理，请稍后继续。', 'thread_busy')
      console.error('[tasks] create labor-contract-analysis task failed:', error.message)
      return jsonError(res, 503, '劳动合同分析任务暂时无法创建，请稍后重试', 'task_unavailable')
    } finally { creatingThreads.delete(creationKey) }
  })

  router.post('/tasks/labor-consult', upload.array('files', MAX_FILES), async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const mode = normalizeMode(req.body?.mode)
    const threadId = normalizeThreadId(req.body?.threadId || req.body?.conversationId)
    const conversationId = threadId
    const region = typeof req.body?.region === 'string' ? req.body.region.trim().slice(0, 120) : ''
    const history = normalizeConversationHistory(parseJsonValue(req.body?.history, []))
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    const files = Array.isArray(req.files) ? req.files : []
    if (!message && !files.length) return jsonError(res, 400, '请输入需要咨询的劳动法问题，或上传需要分析的材料')
    if (message.length > 8000) return jsonError(res, 400, '咨询内容超过 8000 字，请精简后重试')
    for (const file of files) {
      if (!isValidAttachment(file)) return jsonError(res, 400, `${file.originalname || '文件'} 文件类型暂不支持`)
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
      createdTask = taskService.createTask({
        id: taskId,
        userId: req.user.id,
        productId: 'labor-consult',
        threadId: threadId || null,
        title: title || (files[0]?.originalname ? `劳动合同分析：${files[0].originalname}` : '劳动合同分析'),
        prompt: message,
        mode,
        workflowVersion: 'labor-consult-v1',
        input: {
          schemaVersion: 1,
          temporary: req.body?.temporary === 'true' || req.body?.temporary === true,
          message,
          mode,
          region,
          conversationId,
          threadId: threadId || null,
          history,
          // 追问任务不一定重新上传附件；把当前会话材料快照放入任务输入，
          // worker 重启后仍能复原，而不是依赖进程内的材料 Map。
          materials: conversationId ? getMaterials(materialStoreKey(req.user.id, conversationId)) : [],
          fileRefs
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
      if (error?.code === 'task_thread_expired') {
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return jsonError(res, 410, error.message, error.code)
      }
      if (isUniqueThreadBusyError(error)) {
        const activeTask = threadId ? taskService.getActiveTaskByThread?.(req.user.id, 'labor-consult', threadId) : null
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return res.status(409).json({
          error: '该对话已有劳动合同分析任务正在处理，请先停止或等待其结束',
          code: 'labor_consult_task_conflict',
          task: activeTask
        })
      }
      const currentTask = createdTask ? taskService.getTaskInternal(taskId, false) : null
      if (currentTask && !taskService.isTerminal(currentTask.status)) taskService.failTask(taskId, new Error('任务队列暂不可用'), { code: 'queue_unavailable' })
      await fileStore.removeTaskFiles(taskId).catch(() => {})
      console.error('[tasks] create labor-consult task failed:', error.message)
      return jsonError(res, 503, '劳动合同分析任务暂时无法创建，请稍后重试', 'task_unavailable')
    }
  })

  router.post('/tasks/labor-arbitration', arbitrationUpload.array('files', MAX_FILES), async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    const action = ['analyze', 'followup', 'draft'].includes(req.body?.action) ? req.body.action : 'analyze'
    const mode = normalizeMode(req.body?.mode)
    const threadId = normalizeThreadId(req.body?.threadId)
    if (deletingThreads.has(deletionKey(req.user.id, 'labor-arbitration', threadId))) return jsonError(res, 409, '会话正在删除，请稍后再提交', 'thread_busy')
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    const rawHistory = req.body?.history ? parseJsonValue(req.body.history, null) : []
    if (!Array.isArray(rawHistory)) return jsonError(res, 400, '案件历史格式无效', 'arbitration_history_invalid')
    const selectedHistory = selectHistoryByTokens(rawHistory, CONTEXT_WINDOW_TOKENS - OUTPUT_RESERVE_TOKENS - CONTEXT_SAFETY_TOKENS - 100000)
    const history = selectedHistory.history
    const files = Array.isArray(req.files) ? req.files : []
    if (!threadId) return jsonError(res, 400, '缺少案件会话 ID', 'thread_id_required')
    if (!message && !files.length && action !== 'draft') return jsonError(res, 400, '请描述案件情况或上传仲裁材料')
    if (message.length > MAX_MESSAGE_LENGTH) return jsonError(res, 400, `补充说明超过 ${MAX_MESSAGE_LENGTH} 个字符，请精简后重试`)
    for (const file of files) {
      if (!isValidAttachment(file)) return jsonError(res, 400, `${file.originalname || '文件'} 文件类型暂不支持`)
    }

    const activeTask = taskService.getActiveTaskByThread?.(req.user.id, 'labor-arbitration', threadId)
    if (activeTask) return res.status(409).json({
      error: '当前案件会话仍有任务在处理，请等待结束或先停止当前任务。',
      code: 'arbitration_thread_busy',
      task: activeTask
    })
    const priorTasks = taskService.listAllThreadTasks?.(req.user.id, 'labor-arbitration', threadId)
      || taskService.listThreadTasks(req.user.id, 'labor-arbitration', threadId, 200)
    if (action === 'draft' && !priorTasks.length && !files.length && !message) return jsonError(res, 400, '请先提供案件材料，再生成答辩文书')
    if (TASK_RETENTION_POLICY.sessionRetentionDays !== null && priorTasks.length
      && priorTasks.every((prior) => prior.resultExpiresAt && new Date(prior.resultExpiresAt).getTime() <= Date.now())) {
      return jsonError(res, 410, '案件会话已到期，请新建案件继续。', 'arbitration_session_expired')
    }

    const taskId = randomUUID()
    const creationKey = deletionKey(req.user.id, 'labor-arbitration', threadId)
    if (creatingThreads.has(creationKey)) return jsonError(res, 409, '当前会话正在提交，请稍后重试', 'thread_busy')
    creatingThreads.add(creationKey)
    let storedFiles = []
    let createdTask = null
    try {
      const savedFiles = files.length ? await fileStore.saveIncomingFiles(taskId, files) : []
      storedFiles = savedFiles.map((file) => ({ ...file, id: randomUUID() }))
      const fileRefs = storedFiles.map((file) => ({
        id: file.id,
        originalName: file.originalName,
        size: file.size,
        mimeType: file.mimeType
      }))
      const displayTitle = title || (action === 'draft'
        ? '答辩文书新版'
        : files[0]?.originalname ? `仲裁答辩：${files[0].originalname}` : message.slice(0, 80) || '劳动仲裁答辩')
      createdTask = taskService.createTask({
        id: taskId,
        userId: req.user.id,
        productId: 'labor-arbitration',
        threadId,
        title: displayTitle,
        prompt: message,
        mode,
        workflowVersion: 'labor-arbitration-v2',
        input: { schemaVersion: 2, action, message, mode, temporary: req.body?.temporary === 'true' || req.body?.temporary === true, history: [], historyDroppedMessages: 0, fileRefs, retentionPolicy: TASK_RETENTION_POLICY },
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
      if (error?.code === 'task_thread_expired') {
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return jsonError(res, 410, error.message, error.code)
      }
      if (isUniqueThreadBusyError(error)) {
        const current = taskService.getActiveTaskByThread?.(req.user.id, 'labor-arbitration', threadId)
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return res.status(409).json({
          error: '当前案件会话已有分析任务正在处理，请稍后继续。',
          code: 'arbitration_thread_busy',
          task: current
        })
      }
      const currentTask = createdTask ? taskService.getTaskInternal(taskId, false) : null
      if (currentTask && !taskService.isTerminal(currentTask.status)) {
        taskService.failTask(taskId, new Error('任务队列暂不可用'), { code: 'queue_unavailable' })
      }
      await fileStore.removeTaskFiles(taskId).catch(() => {})
      console.error('[tasks] create labor-arbitration task failed:', error.message)
      return jsonError(res, 503, '劳动仲裁答辩任务暂时无法创建，请稍后重试', 'task_unavailable')
    } finally { creatingThreads.delete(creationKey) }
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
        mode,
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
        temporary: req.body?.temporary === 'true' || req.body?.temporary === true,
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
      if (error?.code === 'task_thread_expired') {
        await fileStore.removeTaskFiles(taskId).catch(() => {})
        return jsonError(res, 410, error.message, error.code)
      }
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
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit) || 20)))
    const tasks = taskService.listTasks(req.user.id, limit, { productId: String(req.query.productId || ''), offset: Math.max(0, Number(req.query.offset) || 0) })
    res.json({ tasks, hasMore: tasks.length === Math.min(100, Math.max(1, limit)) })
  })

  router.get('/tasks/labor-arbitration/thread/:threadId', (req, res) => {
    const threadId = normalizeThreadId(req.params.threadId)
    if (!threadId) return jsonError(res, 400, '缺少案件会话 ID')
    const offset = Math.max(0, Number(req.query.offset) || 0)
    const tasks = taskService.listThreadTasks(req.user.id, 'labor-arbitration', threadId, 200, { offset })
    if (!tasks.length && !offset) return jsonError(res, 404, '案件会话不存在或无权访问', 'thread_not_found')
    return res.json({ tasks, hasMore: tasks.length === 200, materials: taskService.getThreadMaterials?.(req.user.id, 'labor-arbitration', threadId) || [] })
  })

  router.patch('/tasks/labor-arbitration/thread/:threadId/materials', (req, res) => {
    const threadId = normalizeThreadId(req.params.threadId)
    if (!threadId || typeof req.body?.fileId !== 'string' || typeof req.body?.enabled !== 'boolean') return jsonError(res, 400, '材料操作参数无效')
    const tasks = taskService.listAllThreadTasks(req.user.id, 'labor-arbitration', threadId)
    if (!tasks.length) return jsonError(res, 404, '案件不存在或无权访问')
    if (tasks.some((task) => !taskService.isTerminal(task.status))) return jsonError(res, 409, '请先停止当前任务，再修改材料')
    if (tasks.every((task) => new Date(task.resultExpiresAt).getTime() <= Date.now())) return jsonError(res, 410, '案件已到期')
    if (!taskService.setThreadMaterialEnabled(req.user.id, 'labor-arbitration', threadId, req.body.fileId, req.body.enabled)) return jsonError(res, 404, '材料不存在或无权访问')
    return res.json({ materials: taskService.getThreadMaterials(req.user.id, 'labor-arbitration', threadId) })
  })

  router.delete('/tasks/labor-arbitration/thread/:threadId', (req, res) => deleteThread(req, res, 'labor-arbitration'))

  router.get('/tasks/labor-contract-analysis/thread/:threadId', (req, res) => {
    const threadId = normalizeThreadId(req.params.threadId)
    if (!threadId) return jsonError(res, 400, '缺少会话 ID')
    const tasks = taskService.listThreadTasks(req.user.id, 'labor-contract-analysis', threadId)
    return res.json({ tasks })
  })

  router.post('/tasks/labor-contract-analysis/thread/:threadId/title', async (req, res) => {
    const threadId = normalizeThreadId(req.params.threadId)
    if (!threadId) return jsonError(res, 400, '缺少会话 ID')
    const question = typeof req.body?.question === 'string' ? req.body.question.slice(0, 500) : ''
    if (!question.trim()) return jsonError(res, 400, '请提供用于命名的问题文本')
    if (!isTitleRefineEnabled()) return res.json({ ok: false, reason: 'disabled' })
    const result = await refineConversationTitle({ question })
    if (!result.ok && result.error) console.warn('[tasks] 劳动合同分析标题提炼失败:', result.reason, result.error)
    if (result.ok && !taskService.updateThreadTitle(req.user.id, 'labor-contract-analysis', threadId, result.title)) {
      return jsonError(res, 404, '分析会话不存在或无权修改', 'thread_not_found')
    }
    return res.json(toClientResult(result))
  })

  router.get('/tasks/labor-contract-analysis/source/:sourceTaskId', (req, res) => {
    const sourceTask = taskService.getTask(req.params.sourceTaskId, req.user.id, false)
    if (!sourceTask || sourceTask.productId !== 'labor-contract-analysis') {
      return jsonError(res, 404, '合同原文不存在或无权查看', 'source_not_found')
    }
    if (sourceTask.resultExpiresAt && new Date(sourceTask.resultExpiresAt).getTime() <= Date.now()) return jsonError(res, 410, '合同会话已到保存期限', 'source_expired')
    const documents = taskService.getLaborSourceDocuments(sourceTask.id)
    if (!Array.isArray(documents) || !documents.length) {
      if (['queued', 'running', 'retry_waiting'].includes(sourceTask.status)) {
        return jsonError(res, 409, '合同文本仍在解析，稍后再试。', 'source_not_ready')
      }
      return jsonError(res, 404, '这份历史记录没有保存可回看的原文，请重新上传合同。', 'source_not_found')
    }
    const readableDocuments = documents.map((document) => ({
      fileId: String(document?.fileId || ''),
      fileName: String(document?.fileName || '上传文件'),
      role: String(document?.role || ''),
      text: String(document?.text || '')
    })).filter((document) => document.text.trim())
    if (!readableDocuments.length) return jsonError(res, 409, '没有可展示的解析正文。', 'source_empty')

    res.set('Cache-Control', 'no-store')
    return res.json({
      sourceTaskId: sourceTask.id,
      expiresAt: sourceTask.resultExpiresAt,
      documents: readableDocuments
    })
  })

  router.delete('/tasks/labor-contract-analysis/thread/:threadId', (req, res) => deleteThread(req, res, 'labor-contract-analysis'))

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
    res.on('close', close)
    writeEvents()
  })

  router.post('/tasks/:taskId/retry', async (req, res) => {
    const existing = taskService.getTask(req.params.taskId, req.user.id, false)
    if (!existing || existing.productId !== 'contract-review') return jsonError(res, 404, '审查任务不存在或无权访问', 'task_not_found')
    if (deletingThreads.has(deletionKey(req.user.id, 'contract-review', existing.threadId || existing.id))) {
      return jsonError(res, 409, '会话正在删除，请稍后再继续核对', 'thread_busy')
    }
    let task
    try { task = taskService.resumeFailedReview(req.params.taskId, req.user.id) } catch (error) {
      return jsonError(res, 409, error.message, error.code)
    }
    if (!task) return jsonError(res, 404, '审查任务不存在或无权访问', 'task_not_found')
    try { await taskQueue.enqueue(task.id) } catch {
      taskService.failTask(task.id, new Error('继续核对暂时未能排入队列，已完成结果保留，请稍后再试。'), { code: 'queue_unavailable' })
      return jsonError(res, 503, '继续核对暂时未能排入队列，请稍后再试。', 'queue_unavailable')
    }
    return res.status(202).json({ task })
  })

  router.post('/tasks/:taskId/cancel', (req, res) => {
    const task = taskService.requestCancel(req.params.taskId, req.user.id)
    if (!task) return jsonError(res, 404, '任务不存在或无权访问', 'task_not_found')
    return res.json({ task })
  })

  router.use((error, req, res, next) => {
    if (!(error instanceof multer.MulterError)) return next(error)
    if (error.code === 'LIMIT_FILE_SIZE') return jsonError(res, 413, '单个文件不能超过 80 MB，请缩小文件后重新上传。', error.code)
    if (['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code)) return jsonError(res, 400, '每次最多上传 6 个文件，请检查附件数量和上传字段。', error.code)
    return jsonError(res, 400, '上传内容超过限制或格式不正确，请精简输入后重试。', error.code)
  })
  return router
}

export { ACCEPTED_TYPES, MAX_FILE_SIZE }
