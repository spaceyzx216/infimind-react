import { extractText } from '../services/file-parser.js'
import { chat, getFlashModel, streamChat } from '../services/llm-client.js'
import { buildContractDraftSystemPrompt, buildContractDraftUserMessage } from '../prompts/contract-draft.js'
import {
  CONTRACT_TYPE_CLASSIFIER_SYSTEM_PROMPT,
  buildContractTypeClassifierMessage,
  guessContractType,
  parseContractTypeClassification
} from '../prompts/contract-draft-types.js'
import { TaskCancelledError, isValidAttachment } from './contract-review.js'

export const MAX_DRAFT_REFERENCE_TEXT = 40000
export const MAX_DRAFT_HISTORY_MESSAGES = 12
export const MAX_DRAFT_HISTORY_MESSAGE_LENGTH = 6000

export const DRAFT_INTENT_CLARIFICATION = '请说明附件是用于参考、更新现有合同，还是据此生成一份完整合同；如需保存新版本，请明确提出“起草/生成/更新全文”等要求。'

export const DRAFT_OPERATIONS = Object.freeze({
  CREATE: 'create',
  REGENERATE: 'regenerate',
  UPDATE: 'update',
  ATTACHMENT_UPDATE: 'attachment_update',
  CHAT: 'chat'
})

const DRAFT_ACTION_CLASSIFIER_SYSTEM_PROMPT = `你是合同起草对话的意图路由器。用户已经拥有一份合同草稿。判断他本轮是否要求生成一份新的、重写后的或根据新增信息修订后的完整合同文档。\n\n仅返回 JSON：{"action":"draft"} 或 {"action":"chat"}。\n\n选择 draft：明确要求起草、生成、重写、重新生成、出一版新稿、把补充信息写入合同并更新全文。选择 chat：询问条款含义、法律风险、需要补充什么、让你解释或给建议，且没有要求输出新的完整合同。`

const CHAT_HINT_PATTERN = /解释|含义|什么意思|风险|建议|需要补充什么|缺少哪些|哪些信息|怎么看|请问|咨询|为什么|如何理解|是否合规|能否说明/i
const DRAFT_VERB_PATTERN = /起草|生成|重写|改写|重新生成|再生成|更新|修订|完善|拟定|编写|写一份|出一版|出一份|形成新稿/i
const DRAFT_TARGET_PATTERN = /合同|协议|文档|草稿|全文|新稿|一版|版本/i
const ATTACHMENT_REFERENCE_PATTERN = /附件|上传的|参考材料|旧版|模板|文件|材料/i

const normalizeText = (value, maxLength = 16000) => String(value || '').trim().slice(0, maxLength)

export class DraftInputError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'DraftInputError'
    this.code = code
    this.status = status
  }
}

export function normalizeDraftHistory(value) {
  let history = value
  if (typeof history === 'string') {
    try { history = JSON.parse(history || '[]') } catch { history = [] }
  }
  if (!Array.isArray(history)) return []
  return history
    .filter((item) => ['user', 'assistant'].includes(item?.role) && typeof item?.content === 'string' && item.content.trim())
    .slice(-MAX_DRAFT_HISTORY_MESSAGES)
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, MAX_DRAFT_HISTORY_MESSAGE_LENGTH) }))
}

export function extractDraftMeta(markdown = '') {
  const title = markdown.match(/^#\s+([^\n#]+)\s*$/m)?.[1]?.trim() || '合同草稿'
  const pendingHeading = markdown.match(/^##\s+待确认信息\s*$/m)
  const pendingSection = pendingHeading?.index === undefined
    ? ''
    : markdown.slice(pendingHeading.index + pendingHeading[0].length).split(/^##\s+/m)[0]
  const pendingItems = pendingSection
    ? [...pendingSection.matchAll(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.+?)\s*$/gm)]
      .map((item) => item[1].trim())
      .filter(Boolean)
      .slice(0, 8)
    : []
  return { title, pendingItems }
}

export function validateDraftMarkdown(markdown = '') {
  const text = String(markdown || '').trim()
  const title = text.match(/^#\s+([^\n#]+)\s*$/m)?.[1]?.trim()
  const bodyHeading = /^##\s+合同正文\s*$/m.exec(text)
  if (!text) return { valid: false, code: 'empty_model_response', message: '模型未返回合同草稿' }
  if (text.includes('```')) return { valid: false, code: 'draft_structure_invalid', message: '合同草稿结构校验失败：不得包含代码围栏' }
  if (!title) return { valid: false, code: 'draft_structure_invalid', message: '合同草稿结构校验失败：缺少合同标题' }
  if (!/^##\s+待确认信息\s*$/m.test(text)) return { valid: false, code: 'draft_structure_invalid', message: '合同草稿结构校验失败：缺少待确认信息区块' }
  if (!bodyHeading) return { valid: false, code: 'draft_structure_invalid', message: '合同草稿结构校验失败：缺少合同正文区块' }
  const body = text.slice(bodyHeading.index + bodyHeading[0].length).replace(/^\s+/, '').trim()
  if (body.length < 20) return { valid: false, code: 'draft_structure_invalid', message: '合同草稿结构校验失败：合同正文为空或过短' }
  const meta = extractDraftMeta(text)
  return { valid: true, title: meta.title, pendingItems: meta.pendingItems, text }
}

export function normalizeDraftSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const draftText = normalizeText(value.draftText || value.text, 60000)
  if (!draftText) return null
  const validation = validateDraftMarkdown(draftText)
  return {
    draftText,
    title: normalizeText(value.title || validation.title || '合同草稿', 120),
    pendingItems: Array.isArray(value.pendingItems)
      ? value.pendingItems.map((item) => normalizeText(item, 300)).filter(Boolean).slice(0, 8)
      : validation.pendingItems || [],
    contractType: value.contractType && typeof value.contractType === 'object'
      ? {
          id: normalizeText(value.contractType.id, 80),
          label: normalizeText(value.contractType.label, 120),
          risk: normalizeText(value.contractType.risk, 30),
          confidence: normalizeText(value.contractType.confidence, 30)
        }
      : null,
    valid: validation.valid
  }
}

export function hasExplicitDraftIntent(message = '') {
  const text = String(message || '').trim()
  return Boolean(DRAFT_VERB_PATTERN.test(text) && DRAFT_TARGET_PATTERN.test(text))
}

export function hasAttachmentUsageIntent(message = '') {
  const text = String(message || '').trim()
  return Boolean(ATTACHMENT_REFERENCE_PATTERN.test(text) && (DRAFT_VERB_PATTERN.test(text) || /依据|根据|结合|按照|参考|用于/.test(text)))
}

const draftActionFromResult = (result) => {
  try {
    const parsed = JSON.parse(String(result || '').match(/\{[\s\S]*\}/)?.[0] || '{}')
    return parsed.action === 'draft' || parsed.action === 'chat' ? parsed.action : null
  } catch {
    return null
  }
}

const likelyChatIntent = (message = '') => Boolean(CHAT_HINT_PATTERN.test(message) && !hasExplicitDraftIntent(message))

export async function resolveDraftAction({
  message,
  hasExistingDraft,
  attachments = [],
  model = getFlashModel(),
  fakeLlm = false,
  chatFn = chat
} = {}) {
  if (!hasExistingDraft) return hasExplicitDraftIntent(message) ? 'draft' : 'clarify'
  if (attachments.length) return hasExplicitDraftIntent(message) || hasAttachmentUsageIntent(message) ? 'draft' : 'clarify'
  if (fakeLlm) return likelyChatIntent(message) ? 'chat' : (hasExplicitDraftIntent(message) ? 'draft' : 'clarify')
  try {
    const result = await chatFn(DRAFT_ACTION_CLASSIFIER_SYSTEM_PROMPT, `用户本轮消息：${message}`, {
      model,
      temperature: 0,
      maxTokens: 40,
      thinking: { type: 'disabled' }
    })
    return draftActionFromResult(result) || (hasExplicitDraftIntent(message) ? 'draft' : (likelyChatIntent(message) ? 'chat' : 'clarify'))
  } catch (error) {
    console.warn('[contract-draft] Intent classification failed; using deterministic fallback:', error.message)
    return hasExplicitDraftIntent(message) ? 'draft' : (likelyChatIntent(message) ? 'chat' : 'clarify')
  }
}

const inferDraftOperation = ({ message = '', hasExistingDraft = false, attachments = [] } = {}) => {
  if (!hasExistingDraft) return DRAFT_OPERATIONS.CREATE
  if (attachments.length) return DRAFT_OPERATIONS.ATTACHMENT_UPDATE
  return /更新|补充|完善|修订|写入|加入/.test(message) ? DRAFT_OPERATIONS.UPDATE : DRAFT_OPERATIONS.REGENERATE
}

export function normalizeDraftOperation(value, { hasExistingDraft = false, attachments = [] } = {}) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!raw) return null
  const aliases = {
    create: DRAFT_OPERATIONS.CREATE,
    initial: DRAFT_OPERATIONS.CREATE,
    generate: DRAFT_OPERATIONS.CREATE,
    draft: DRAFT_OPERATIONS.CREATE,
    regenerate: DRAFT_OPERATIONS.REGENERATE,
    recreate: DRAFT_OPERATIONS.REGENERATE,
    rewrite: DRAFT_OPERATIONS.REGENERATE,
    regenerate_full: DRAFT_OPERATIONS.REGENERATE,
    update: DRAFT_OPERATIONS.UPDATE,
    update_full: DRAFT_OPERATIONS.UPDATE,
    full_update: DRAFT_OPERATIONS.UPDATE,
    attachment: hasExistingDraft ? DRAFT_OPERATIONS.ATTACHMENT_UPDATE : DRAFT_OPERATIONS.CREATE,
    attachment_update: DRAFT_OPERATIONS.ATTACHMENT_UPDATE,
    attachment_generate: hasExistingDraft ? DRAFT_OPERATIONS.ATTACHMENT_UPDATE : DRAFT_OPERATIONS.CREATE,
    create_with_attachments: DRAFT_OPERATIONS.CREATE,
    chat: DRAFT_OPERATIONS.CHAT,
    sse: DRAFT_OPERATIONS.CHAT
  }
  return aliases[raw] || null
}

export async function resolveDraftIntent({
  operation,
  message = '',
  hasExistingDraft = false,
  attachments = [],
  model = getFlashModel(),
  fakeLlm = false,
  chatFn = chat,
  classifyAction = resolveDraftAction
} = {}) {
  const attachmentDraftIntent = attachments.length && hasAttachmentUsageIntent(message) && DRAFT_VERB_PATTERN.test(message)
  const explicitOperation = String(operation || '').trim()
  if (explicitOperation) {
    const normalized = normalizeDraftOperation(explicitOperation, { hasExistingDraft, attachments })
    if (!normalized) throw new DraftInputError('draft_operation_invalid', '起草操作类型无效，请使用 create、regenerate、update 或 attachment_update')
    if (normalized === DRAFT_OPERATIONS.CHAT) return { action: 'chat', operation: normalized, source: 'operation' }
    if (!message && !attachments.length) return { action: 'clarify', operation: normalized, source: 'operation' }
    if (attachments.length && !hasExplicitDraftIntent(message) && !attachmentDraftIntent && normalized === DRAFT_OPERATIONS.CREATE) {
      return { action: 'clarify', operation: normalized, source: 'attachment_usage' }
    }
    return { action: 'draft', operation: normalized, source: 'operation' }
  }

  if (!String(message || '').trim() && attachments.length) return { action: 'clarify', operation: null, source: 'attachment_usage' }
  if (attachments.length && !hasExplicitDraftIntent(message) && !attachmentDraftIntent) {
    return { action: 'clarify', operation: null, source: 'attachment_usage' }
  }
  if (hasExplicitDraftIntent(message) || attachmentDraftIntent) {
    return { action: 'draft', operation: inferDraftOperation({ message, hasExistingDraft, attachments }), source: 'deterministic' }
  }

  if (hasExistingDraft && !attachments.length) {
    const action = await classifyAction({ message, hasExistingDraft, attachments, model, fakeLlm, chatFn })
    if (action === 'draft') return { action, operation: inferDraftOperation({ message, hasExistingDraft, attachments }), source: 'classifier' }
    if (action === 'chat') return { action, operation: DRAFT_OPERATIONS.CHAT, source: 'classifier' }
  }
  return { action: 'clarify', operation: null, source: 'unclear' }
}

export async function classifyContractDraft({
  instruction,
  referenceMaterials = [],
  model = getFlashModel(),
  fakeLlm = false,
  chatFn = chat
} = {}) {
  const fallbackInput = `${instruction}\n${referenceMaterials.map((item) => `${item.name}\n${item.text}`).join('\n')}`
  const fallback = guessContractType(fallbackInput)
  if (fakeLlm) return fallback
  try {
    const result = await chatFn(CONTRACT_TYPE_CLASSIFIER_SYSTEM_PROMPT, buildContractTypeClassifierMessage({ instruction, referenceMaterials }), {
      model,
      temperature: 0,
      maxTokens: 180,
      thinking: { type: 'enabled' },
      reasoningEffort: 'low'
    })
    return parseContractTypeClassification(result, fallbackInput)
  } catch (error) {
    console.warn('[contract-draft] Type classification failed; using fallback:', error.message)
    return fallback
  }
}

export function buildFakeDraft({ instruction = '', operation = DRAFT_OPERATIONS.CREATE, typeProfile, referenceMaterials = [] } = {}) {
  const profile = typeProfile || guessContractType(instruction).profile
  const title = profile.label || '通用合同'
  const operationLabel = operation === DRAFT_OPERATIONS.CREATE ? '首次起草' : operation === DRAFT_OPERATIONS.REGENERATE ? '重新生成' : '根据补充信息更新全文'
  const referenceLabel = referenceMaterials.length ? referenceMaterials.map((item) => item.name).join('、') : '未提供附件'
  const safeInstruction = normalizeText(instruction, 300).replace(/\n/g, ' ')
  return `# ${title}

## 待确认信息
- [ ] 甲方、乙方的完整名称、统一社会信用代码及签署授权
- [ ] 交易标的、数量/规格、服务范围或交付物
- [ ] 对价、付款节点、发票和税费承担
- [ ] 履行期限、验收标准及送达信息

## 合同正文

甲方：____

乙方：____

鉴于双方拟开展与“${title}”相关的合作，双方在平等、自愿的基础上，就本次交易约定如下：

第一条 交易内容
1.1 双方确认的交易内容、履行范围和交付标准以本合同及经双方确认的附件为准，具体事实由双方在签署前补充确认。
1.2 本次处理方式为${operationLabel}；用户要求摘要：${safeInstruction || '____'}。

第二条 履行、验收与付款
2.1 履行期限、验收方式、付款金额、付款节点、开票及税费承担由双方根据实际交易填写并以书面确认。
2.2 一方未按约履行的，应及时通知对方并采取合理补救措施；违约责任以双方确认的具体损失、期限和责任范围为准。

第三条 保密、变更与终止
3.1 未经对方书面同意，任何一方不得向无关第三方披露因履行本合同知悉的非公开信息，但法律法规或有权机关要求披露的除外。
3.2 对合同内容的补充、变更或终止应以双方授权代表签署的书面文件为准。

第四条 争议解决与签署
4.1 因本合同产生的争议，双方应先协商解决；协商不成时，提交____所在地有管辖权的法院或双方另行约定的仲裁机构处理。
4.2 本合同自双方签字或盖章之日起生效，一式____份，双方各执____份，具有同等效力。

（附件参考：${referenceLabel}）

甲方（盖章）：____    乙方（盖章）：____
授权代表：____        授权代表：____
签署日期：____        签署日期：____`
}

export function buildFakeChatReply(message = '') {
  const question = normalizeText(message, 120)
  return `关于“${question}”，建议先核对当前草稿中的主体、交易标的、期限、金额、验收和违约责任。若要把补充信息写入合同并保存新版本，请明确提出“更新全文”或“重新生成完整合同”。`
}

const checkpointValue = (getCheckpoint, stage) => getCheckpoint?.(stage)?.result || null

const parseReferences = async ({ files, emit, checkpoint, getCheckpoint, updateFileParseStatus, ensure }) => {
  const saved = checkpointValue(getCheckpoint, 'parsing')
  if (Array.isArray(saved?.referenceMaterials)) {
    await emit('stage.start', { stage: 'parsing', label: '正在恢复附件解析检查点' })
    await emit('stage.complete', {
      stage: 'parsing',
      summary: '已从检查点恢复附件解析结果',
      referenceCount: saved.referenceMaterials.length,
      textLength: Number(saved.referenceLength) || 0,
      recovered: true
    })
    return saved.referenceMaterials
  }

  await emit('stage.start', { stage: 'parsing', label: files.length ? '正在解析起草参考附件' : '正在确认本次起草无附件输入' })
  const referenceMaterials = []
  for (const file of files) {
    ensure()
    await emit('stage.progress', { stage: 'parsing', message: `正在解析参考文件：${file.originalname}` })
    try {
      const parsed = await extractText(file)
      const text = String(parsed?.text || '').trim()
      updateFileParseStatus?.(file.id, text ? 'succeeded' : 'empty')
      if (!text) {
        const error = new Error(`${file.originalname || '参考文件'} 未提取到可用文字`)
        error.code = 'empty_file'
        throw error
      }
      referenceMaterials.push({ name: file.originalname, text })
    } catch (error) {
      updateFileParseStatus?.(file.id, 'failed')
      throw error
    }
  }
  const referenceLength = referenceMaterials.reduce((sum, item) => sum + item.text.length, 0)
  if (referenceLength > MAX_DRAFT_REFERENCE_TEXT) {
    const error = new Error(`参考材料正文超过 ${MAX_DRAFT_REFERENCE_TEXT} 字符，请减少附件或拆分后重试`)
    error.code = 'reference_too_large'
    throw error
  }
  await checkpoint('parsing', { referenceMaterials, referenceLength })
  await emit('stage.complete', {
    stage: 'parsing',
    summary: files.length ? `附件解析完成，共提取 ${referenceLength} 个字符` : '本次起草未提供附件',
    referenceCount: referenceMaterials.length,
    textLength: referenceLength
  })
  return referenceMaterials
}

const collectDraftText = async ({ instruction, referenceMaterials, typeProfile, history, model, operation, fakeLlm, streamFn, ensure }) => {
  if (fakeLlm) return buildFakeDraft({ instruction, operation, typeProfile, referenceMaterials })
  let draftText = ''
  for await (const chunk of streamFn(buildContractDraftSystemPrompt(typeProfile), buildContractDraftUserMessage({ instruction, referenceMaterials }), {
    model,
    temperature: 0.2,
    maxTokens: 12288,
    history,
    thinking: { type: 'enabled' },
    reasoningEffort: 'medium'
  })) {
    if (chunk?.content) draftText += chunk.content
  }
  ensure()
  return draftText
}

export async function runContractDraft({
  task,
  input = {},
  files = [],
  emit = async () => {},
  checkpoint = async () => {},
  getCheckpoint = () => null,
  isCancellationRequested = () => false,
  updateFileParseStatus = () => {},
  fakeLlm = String(process.env.TASK_FAKE_LLM || '').toLowerCase() === 'true',
  model = getFlashModel(),
  chatFn = chat,
  streamFn = streamChat,
  classifyType = classifyContractDraft
} = {}) {
  if (!task?.id) throw new DraftInputError('task_input_invalid', '缺少任务信息')
  if (task.productId && task.productId !== 'contract-draft') throw new DraftInputError('workflow_product_mismatch', '任务不是合同起草任务')
  const ensure = () => { if (isCancellationRequested?.()) throw new TaskCancelledError() }
  const instruction = normalizeText(task.prompt || input.message, 16000)
  const baseDraft = normalizeDraftSnapshot(input.currentDraft || input.baseDraft)
  const normalizedOperation = normalizeDraftOperation(input.operation, { hasExistingDraft: Boolean(baseDraft?.draftText), attachments: files })
  if (String(input.operation || '').trim() && !normalizedOperation) {
    throw new DraftInputError('draft_operation_invalid', '起草操作类型无效')
  }
  const operation = normalizedOperation || (baseDraft?.draftText
    ? (files.length ? DRAFT_OPERATIONS.ATTACHMENT_UPDATE : DRAFT_OPERATIONS.UPDATE)
    : DRAFT_OPERATIONS.CREATE)
  const history = normalizeDraftHistory(input.history)
  for (const file of files) {
    if (!isValidAttachment(file)) {
      const error = new DraftInputError('unsupported_file_type', `${file.originalname || '参考文件'} 文件类型暂不支持`)
      throw error
    }
  }
  if (baseDraft?.draftText && !history.some((item) => item.role === 'assistant' && item.content.includes('【当前合同草稿'))) {
    history.push({ role: 'assistant', content: `【当前合同草稿，用户可能要求基于此版本调整或重新生成】\n${baseDraft.draftText}`.slice(0, MAX_DRAFT_HISTORY_MESSAGE_LENGTH) })
  }

  ensure()
  const referenceMaterials = await parseReferences({ files, emit, checkpoint, getCheckpoint, updateFileParseStatus, ensure })
  ensure()

  const typeCheckpoint = checkpointValue(getCheckpoint, 'contract_type')
  let classification = typeCheckpoint?.classification || null
  if (!classification) {
    await emit('stage.start', { stage: 'contract_type', label: '正在识别合同类型并加载专项条款框架' })
    classification = await classifyType({ instruction, referenceMaterials, model, fakeLlm, chatFn })
    await checkpoint('contract_type', { classification })
    await emit('stage.complete', {
      stage: 'contract_type',
      summary: `已识别为：${classification.profile.label}`,
      contractType: { id: classification.profile.id, label: classification.profile.label, risk: classification.profile.risk },
      confidence: classification.confidence
    })
  } else {
    await emit('stage.start', { stage: 'contract_type', label: '正在恢复合同类型识别检查点' })
    await emit('stage.complete', {
      stage: 'contract_type',
      summary: `已恢复合同类型：${classification.profile.label}`,
      contractType: { id: classification.profile.id, label: classification.profile.label, risk: classification.profile.risk },
      confidence: classification.confidence,
      recovered: true
    })
  }

  ensure()
  const generationCheckpoint = checkpointValue(getCheckpoint, 'generation')
  let draftText = generationCheckpoint?.draftText || ''
  let validation = validateDraftMarkdown(draftText)
  if (!validation.valid) {
    await emit('stage.start', { stage: 'generation', label: '正在生成完整合同正文', operation })
    await emit('stage.progress', { stage: 'generation', message: '正在调用合同起草模型；完整结果校验通过后才会保存为正式草稿' })
    draftText = await collectDraftText({ instruction, referenceMaterials, typeProfile: classification.profile, history, model, operation, fakeLlm, streamFn, ensure })
    validation = validateDraftMarkdown(draftText)
    if (!validation.valid) {
      const error = new Error(validation.message)
      error.code = validation.code
      throw error
    }
    const meta = extractDraftMeta(validation.text)
    await checkpoint('generation', {
      draftText: validation.text,
      title: meta.title,
      pendingItems: meta.pendingItems,
      contractType: { id: classification.profile.id, label: classification.profile.label, risk: classification.profile.risk, confidence: classification.confidence }
    })
    await emit('draft.complete', {
      title: meta.title,
      pendingItems: meta.pendingItems,
      contractType: { id: classification.profile.id, label: classification.profile.label, risk: classification.profile.risk, confidence: classification.confidence },
      textLength: validation.text.length,
      resultAvailable: false
    })
    await emit('stage.complete', { stage: 'generation', summary: `完整合同生成完成，共 ${validation.text.length} 个字符`, textLength: validation.text.length })
  } else {
    draftText = validation.text
    const meta = extractDraftMeta(draftText)
    await emit('stage.start', { stage: 'generation', label: '正在恢复完整合同生成检查点', operation })
    await emit('draft.complete', {
      title: meta.title,
      pendingItems: meta.pendingItems,
      contractType: { id: classification.profile.id, label: classification.profile.label, risk: classification.profile.risk, confidence: classification.confidence },
      textLength: draftText.length,
      resultAvailable: false,
      recovered: true
    })
    await emit('stage.complete', { stage: 'generation', summary: '已从检查点恢复完整合同结果', textLength: draftText.length, recovered: true })
  }

  ensure()
  const meta = extractDraftMeta(draftText)
  const result = {
    productId: 'contract-draft',
    taskId: task.id,
    threadId: input.threadId || task.threadId || null,
    operation,
    parentTaskId: input.parentTaskId || null,
    version: task.id,
    draftText,
    title: meta.title,
    pendingItems: meta.pendingItems,
    contractType: { id: classification.profile.id, label: classification.profile.label, risk: classification.profile.risk, confidence: classification.confidence },
    referenceFiles: referenceMaterials.map((item) => item.name),
    fake: Boolean(fakeLlm)
  }
  await emit('stage.start', { stage: 'persistence', label: '正在校验并持久化正式合同草稿结果' })
  // 这里只记录“已通过完整结构校验、准备写入任务结果”；真正的 SQLite 结果写入由
  // task-service.completeTask 在同一事务中完成，并补写 persisted=true 检查点。
  // 任务在此阶段被取消时，下面的预持久化检查点不会被当作正式草稿。
  await checkpoint('persistence', { validated: true, readyToPersist: true, resultAvailable: false, taskId: task.id, version: task.id })
  await emit('stage.complete', { stage: 'persistence', summary: '合同草稿已通过结构校验，准备保存为正式版本', readyToPersist: true, resultAvailable: false })
  return result
}
