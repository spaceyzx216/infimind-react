import { assertDocumentLength } from '../services/document-materials.js'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractText } from '../services/file-parser.js'
import { chatDetailed, getFlashModel } from '../services/llm-client.js'
import { searchLaborKbLexical } from '../services/labor-kb.js'
import { searchCases, findLaw } from '../services/law-whitelist.js'
import { createLaborContractRedactor } from '../services/labor-contract-redaction.js'
import { LABOR_ARBITRATION_SYSTEM_PROMPT } from '../prompts/labor-arbitration.js'
import { validateTitle } from '../services/title-refiner.js'
import { CONTEXT_WINDOW_TOKENS, OUTPUT_RESERVE_TOKENS, CONTEXT_SAFETY_TOKENS, estimateTokens, selectHistoryByTokens } from '../../src/utils/context-budget.js'
import { formatArbitrationDraft, normalizeArbitrationResult } from '../../src/utils/arbitration-result.js'
import { arbitrationResultIssues, extractExplicitArbitrationRequests, selectArbitrationMaterialText } from '../services/arbitration-validation.js'
import { runStagedArbitration } from './labor-arbitration-staged.js'

const REFERENCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/labor-arbitration/references')
const MAX_DOCUMENT_TEXT = 80000
const MAX_SAVED_TEXT = 2000000
const MAX_REFERENCE_TEXT = 20000
const REDACTION_NOTICE = '发送给模型前，系统只替换可识别的证件号、电话、邮箱、企业代码和银行账户；姓名、单位、地区、日期、工资和条款内容会保留。自动识别可能遗漏信息。'

const safeText = (value, max = 6000) => String(value || '').trim().slice(0, max)

// 日期差由程序计算；这里只校验自然日算术，不决定法律起算点或适用期限。
export function getArbitrationDateChecks(text) {
  const dates = new Map()
  for (const match of String(text || '').matchAll(/(?<!\d)((?:19|20)\d{2})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})(?:日)?(?!\d)/g)) {
    const [year, month, day] = match.slice(1).map(Number)
    const timestamp = Date.UTC(year, month - 1, day)
    const date = new Date(timestamp)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue
    dates.set(timestamp, { year, month, day, timestamp, label: `${year}年${month}月${day}日` })
    if (dates.size >= 8) break
  }
  const sorted = [...dates.values()].sort((a, b) => a.timestamp - b.timestamp)
  return sorted.flatMap((from, index) => sorted.slice(index + 1).map((to) => ({ from, to, days: (to.timestamp - from.timestamp) / 86400000 })))
}

export function validateArbitrationDateAssertions(result, checks) {
  const source = JSON.stringify(result).replace(/(?:没有|尚未|不|未)超过/g, '未达到')
  const pattern = (date, requireYear) => `(?:${requireYear ? date.year + '年' : '(?:' + date.year + '年)?'}0?${date.month}月0?${date.day}日|${date.year}[-/]0?${date.month}[-/]0?${date.day})`
  for (const { from, to, days } of checks) {
    const sameCalendarDay = from.month === to.month && from.day === to.day
    // 两个日期必须在同一连接语句中，不能拿相邻字段或第三个日期作比较。
    const expression = new RegExp(`${pattern(from, sameCalendarDay)}[^0-9。！？\\n]{0,25}(?:至|到|距|距离|与)[^0-9。！？\\n]{0,10}${pattern(to, sameCalendarDay)}[^0-9。！？\\n]{0,25}(?:超过|大于|多于|不少于|已满)\\s*(\\d+)\\s*(?:日|天)`, 'g')
    for (const assertion of source.matchAll(expression)) {
      if (days < Number(assertion[1])) {
        const error = new Error(`模型日期推算与材料矛盾：${from.label}至${to.label}相差${days}个自然日。本次未保存该结果，请重试或按通知请求分项分析。`)
        error.code = 'arbitration_result_inconsistent'
        throw error
      }
    }
  }
}

async function loadOpinionReferences() {
  try {
    const names = (await readdir(REFERENCE_DIR)).filter((name) => name.toLowerCase().endsWith('.txt')).sort()
    const references = []
    let total = 0
    for (const name of names) {
      if (references.length >= 5 || total >= MAX_REFERENCE_TEXT) break
      const text = safeText(await readFile(resolve(REFERENCE_DIR, name), 'utf8'), MAX_REFERENCE_TEXT - total)
      if (!text) continue
      references.push({ title: `仲裁意见参考 ${name.replace(/\.txt$/i, '')}`, sourceType: 'arbitration_opinion', text })
      total += text.length
    }
    return references
  } catch (error) {
    console.warn('[labor-arbitration] opinion references unavailable:', error.message)
    return []
  }
}

function parseJson(raw) {
  const source = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const value = JSON.parse(source)
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('模型结果不是 JSON 对象')
  return value
}

function normalizeLevel(value) {
  const text = String(value || '').trim().toLowerCase()
  return ({ low: 'low', '低': 'low', '低风险': 'low', medium: 'medium', '中': 'medium', '中风险': 'medium', high: 'high', '高': 'high', '高风险': 'high' })[text] || 'unknown'
}

function validateLegalBasis(result) {
  const claims = (Array.isArray(result.claims) ? result.claims : []).filter((claim) => claim && typeof claim === 'object')
  for (const claim of claims) {
    claim.legalBasis = (Array.isArray(claim.legalBasis) ? claim.legalBasis : []).map((basis) => {
      const law = findLaw(basis?.name)
      if (!law) return { ...basis, status: 'needs_review', note: '未在法规白名单中匹配，请核对现行有效文本。' }
      return {
        ...basis,
        status: law.status === 'effective' && law.reviewStatus === 'verified' ? 'verified' : 'needs_review',
        effectiveFrom: law.effectiveFrom || '',
        effectiveTo: law.effectiveTo || '',
        note: law.status === 'effective' && law.reviewStatus === 'verified'
          ? '法规名称在白名单中匹配；具体条文仍需人工核对。'
          : '法规状态或审核状态需要人工核对。'
      }
    })
  }
  return { ...result, claims, overallRisk: normalizeLevel(result.overallRisk) }
}

function formatReferenceContext({ opinions, practical, cases }) {
  const blocks = []
  for (const item of opinions) blocks.push(`【仲裁意见参考：${item.title}】\n${item.text}`)
  for (const item of practical) blocks.push(`【劳动用工实务资料，仅供参考】\n标题：${item.title}\n来源：${[item.book, item.chapter, item.section].filter(Boolean).join(' / ')}\n${safeText(item.content, 1800)}`)
  for (const item of cases) blocks.push(`【类案参考，不代表本案事实或必然结论】\n${item.title}\n争议焦点：${item.disputeFocus}\n裁判要点：${safeText(item.holding, 1500)}\n依据：${safeText(item.legalBasis, 500)}\n来源：${item.source || item.court || '未注明'}`)
  return blocks.join('\n\n')
}

export async function runLaborArbitration({
  task,
  input = {},
  files = [],
  sourceDocuments = [],
  checkpoint = async () => {},
  getCheckpoint = () => null,
  updateFileParseStatus = () => {},
  emit = async () => {},
  isCancellationRequested = () => false,
  signal,
  fakeLlm = false,
  stageDependencies = {}
} = {}) {
  const ensureActive = () => {
    if (isCancellationRequested?.() || signal?.aborted) {
      const error = new Error('用户已停止本次分析')
      error.code = 'TASK_CANCELLED'
      throw error
    }
  }

  ensureActive()
  let documents = []
  const warnings = Array.isArray(input.materialWarnings) ? [...input.materialWarnings] : []
  const ownDocuments = []
  const cachedResult = (await getCheckpoint('parsing'))?.result
  const cachedIds = new Set(cachedResult?.fileIds || [])
  const appendDocument = (document) => {
    const text = safeText(document.text, MAX_SAVED_TEXT)
    if (text) documents.push({ ...document, text, truncated: Boolean(document.truncated || String(document.text || '').trim().length > text.length) })
  }
  if (files.length) {
    await emit('arbitration.progress', { label: '正在读取上传材料…', stage: 'parsing' })
    for (const file of files) {
      ensureActive()
      if (!file.sourceTaskId && file.id && cachedIds.has(file.id)) {
        const document = cachedResult.documents?.find((item) => item.fileId === file.id)
        if (document) { ownDocuments.push(document); appendDocument(document) }
        continue
      }
      try {
        const parsed = await extractText(file, { signal })
        ensureActive()
        const text = assertDocumentLength(String(parsed?.text || '')).trim()
        const document = { fileName: file.originalname || '上传文件', fileId: file.id, sourceTaskId: file.sourceTaskId || task?.id, text, truncated: String(parsed?.text || '').trim().length > text.length,
          pageCount: parsed?.pageCount ?? null, parseMetadata: parsed?.metadata, parseWarnings: parsed?.metadata?.warnings || [] }
        warnings.push(...document.parseWarnings.map((warning) => `${document.fileName}：${warning}`))
        if (String(parsed?.text || '').trim().length > text.length) warnings.push(`${document.fileName}正文过长，解析缓存未保留全部内容；请补充关键原文。`)
        if (text) {
          if (!file.sourceTaskId) ownDocuments.push(document)
          else await checkpoint('source_document', { document })
          appendDocument(document)
          if (file.id) await updateFileParseStatus(file.id, 'succeeded')
        }
        else {
          if (file.id) await updateFileParseStatus(file.id, 'failed')
          warnings.push(`${file.originalname || '上传文件'}未提取到正文；如果是扫描版 PDF，请补充清晰图片或可复制文字的版本。`)
        }
      } catch (error) {
        ensureActive()
        if (file.id) await updateFileParseStatus(file.id, 'failed')
        warnings.push(`${file.originalname || '上传文件'}解析失败：${safeText(error.message, 180)}`)
      }
      // Persist this task's original text independently of the binary lifetime.
      await checkpoint('parsing', { documents: ownDocuments, fileIds: ownDocuments.map((item) => item.fileId).filter(Boolean), warnings })
      await checkpoint('source', { documents: ownDocuments, fileIds: ownDocuments.map((item) => item.fileId).filter(Boolean) })
    }
  }
  if (cachedResult?.warnings) warnings.push(...cachedResult.warnings)
  for (const document of sourceDocuments) appendDocument(document)
  ensureActive()
  if (documents.some((document) => document.truncated)) warnings.push('本案部分原文较长，缓存未保留全文；请补充与本轮请求有关的关键原文。')
  if ((files.length || sourceDocuments.length) && !documents.length) {
    const error = new Error(`上传材料均未读取成功，本次不生成案件结论。${warnings.join(' ')}`)
    error.code = 'arbitration_documents_unreadable'
    throw error
  }

  // Queued v1 tasks keep their original contract; only new server-created v2
  // tasks use the staged flow. Both reuse parsing, storage and cancellation.
  if (task?.workflowVersion === 'labor-arbitration-v2' || input.schemaVersion === 2) {
    return runStagedArbitration({ task, input, documents, warnings, checkpoint, getCheckpoint,
      emit, ensureActive, signal, fakeLlm, loadOpinions: loadOpinionReferences,
      validateLegalBasis, validateDates: (result, text) => validateArbitrationDateAssertions(result, getArbitrationDateChecks(text)),
      dependencies: stageDependencies })
  }

  const action = ['analyze', 'followup', 'draft'].includes(input.action) ? input.action : 'analyze'
  // Thinking tokens and the final JSON share the completion allowance.
  const outputReserve = OUTPUT_RESERVE_TOKENS
  const userMessage = safeText(input.message, 16000)
  const sourceRequests = extractExplicitArbitrationRequests([userMessage, ...documents.map((document) => document.text)].join('\n'))
  documents = selectArbitrationMaterialText(documents, userMessage, MAX_DOCUMENT_TEXT)
  const partialDocuments = documents.filter((document) => document.partial || document.parseWarnings?.length)
  for (const document of partialDocuments) warnings.push(`${document.fileName}未完成全文核对，本轮仅分析已读片段；请核对关键请求、日期及金额。`)
  const incompleteMaterials = Boolean(partialDocuments.length || warnings.some((warning) => /解析失败|未提取到正文|无法读取|未保留全部|未保留全文/.test(warning)))
  let history = selectHistoryByTokens(input.history, CONTEXT_WINDOW_TOKENS - outputReserve - CONTEXT_SAFETY_TOKENS).history
  const dateChecks = getArbitrationDateChecks([userMessage, ...documents.map((item) => item.text), ...history.filter((item) => item.role === 'user').map((item) => item.content)].join('\n'))
  const privacyRedactor = createLaborContractRedactor({
    documents,
    extraTexts: [userMessage, history],
    categories: ['phone', 'identity', 'email', 'business-id', 'bank-account']
  })

  if (fakeLlm) {
    await emit('arbitration.progress', { label: '演示模式：正在准备结构化示例…', stage: 'analysis' })
    return {
      kind: action === 'draft' ? 'draft' : action === 'analyze' ? 'analysis' : 'reply',
      answer: '当前为模型桩演示结果。请配置 DeepSeek 后再进行真实案件分析。',
      conversationTitle: '仲裁材料与答辩准备',
      overallRisk: 'unknown',
      riskBasis: ['模型桩不对案件作事实或法律判断。'],
      claims: [], disputes: [], evidenceGaps: [], evidenceList: [], defenseStrategy: [], hearingPoints: [],
      followUpQuestions: ['请补充仲裁请求、案件地区和争议经过。'],
      documentTypes: documents.map((item) => ({ fileName: item.fileName, type: '待确认', confidence: 'low', reason: '演示模式未执行模型识别。' })),
      defenseDraft: action === 'draft' ? '【演示草稿】请配置 DeepSeek 后生成真实答辩文书。' : '',
      references: [],
      warnings: [...warnings, '演示结果不是法律分析。']
    }
  }

  const queryText = safeText([userMessage, ...documents.map((item) => item.text.slice(0, 2400))].join('\n'), 10000)
  let practical = []
  let cases = []
  try { practical = searchLaborKbLexical(queryText, { limit: 3 }) } catch (error) { warnings.push(`劳动实务资料检索暂不可用：${safeText(error.message, 140)}`) }
  try { cases = searchCases(queryText, { limit: 3 }) } catch (error) { warnings.push(`类案检索暂不可用：${safeText(error.message, 140)}`) }
  const opinions = await loadOpinionReferences()
  const referenceContext = formatReferenceContext({ opinions, practical, cases })

  const actionInstruction = action === 'draft'
    ? '用户要求生成或改写完整答辩文书。请结合此前对话、已有分析和新增材料，返回完整的 defenseDraft；明确保留待补充字段。'
    : action === 'analyze'
      ? '这是本案首轮材料分析。按基本信息、请求事项、核心争议点展开，并在能识别请求时生成完整 defenseDraft。逐项写清答辩结论、答辩建议、法条依据和具体分析。材料若是已有答辩意见，标明单方陈述；未知信息用待补充，不强编。'
      : '这是本案后续对话。针对用户新问题、补充事实或新材料作答；如信息已足够，更新对应风险/证据建议。除非用户明确要求生成/修改完整文书，否则 defenseDraft 留空。'

  const contentBlocks = [
    `任务类型：${action}\n${actionInstruction}`,
    userMessage ? `\n【用户本轮说明】\n${userMessage}` : '',
    sourceRequests.length ? `\n【本案材料中明确列出的请求原文，须逐项回应】\n${sourceRequests.join('\n')}` : '',
    incompleteMaterials ? '\n部分材料未读全或识别需核对：仅针对已读片段给条件式建议，不得声称全案已审查完成；草稿显著注明材料范围和待核实事项。' : '',
    dateChecks.length ? `\n【系统日期差校验，仅为自然日算术，日期事实及法律起算点仍待证据核实】\n${dateChecks.map(({ from, to, days }) => `${from.label}至${to.label}相差${days}个自然日。`).join('\n')}\n涉及通知期时严格核对本表；不得把不足30日写成超过30日，不能把自然日差直接当作法定赔偿天数。` : '',
    documents.length ? `\n【本案上传材料原文（含此前上传，请区分新旧材料及单方陈述）】\n${documents.map((item) => `--- ${item.fileName} ---\n${item.text}`).join('\n\n')}` : '\n【本轮没有可读取的文件正文】',
    referenceContext ? `\n【检索到的参考资料】\n${referenceContext}` : '',
    `\n【本轮解析提示】\n${warnings.length ? warnings.join('\n') : '文件解析未发现明显错误。'}\n${documents.length ? `系统读取到 ${documents.length} 份有正文的文件，请逐份识别材料类型并给出置信度。` : ''}`
  ].filter(Boolean)
  const systemTokens = estimateTokens(LABOR_ARBITRATION_SYSTEM_PROMPT)
  const baseTokens = systemTokens + estimateTokens(contentBlocks.join('\n')) + 64
  if (baseTokens > CONTEXT_WINDOW_TOKENS - outputReserve - CONTEXT_SAFETY_TOKENS) {
    throw new Error('本轮材料超过模型上下文预算，请拆分后重试。')
  }
  const selected = selectHistoryByTokens(history, CONTEXT_WINDOW_TOKENS - outputReserve - CONTEXT_SAFETY_TOKENS - baseTokens)
  history = selected.history
  const droppedMessages = selected.droppedMessages + Math.max(0, Number(input.historyDroppedMessages) || 0)
  if (droppedMessages) warnings.push(`本轮按 token 预算未纳入最早的 ${droppedMessages} 条历史消息；会话记录仍保留。如涉及早期信息，请重新补充关键事实。`)
  const userContent = [...contentBlocks,
    history.length ? `\n【此前对话】\n${history.map((item) => `${item.role === 'user' ? '企业用户' : '助手'}：${item.content}`).join('\n\n')}` : '',
    droppedMessages ? '\n历史上下文不完整；不要假装记得已移出的事实，必要时追问。' : ''
  ].filter(Boolean).join('\n')
  const maskedUserContent = privacyRedactor.mask(userContent)

  ensureActive()
  await emit('arbitration.progress', { label: action === 'draft' ? '正在整理答辩文书…' : '正在梳理请求、争议和证据…', stage: 'analysis' })
  const modelOptions = {
    model: getFlashModel(),
    thinking: input.mode === 'fast' ? { type: 'disabled' } : { type: 'enabled' },
    reasoningEffort: 'high',
    temperature: 0.2,
    maxTokens: outputReserve,
    // Complete non-streaming drafts, especially thinking mode, can exceed the
    // client's default 60s. Keep cancellation active and avoid nested retries;
    // transient failures are retried by the existing persistent task queue.
    requestTimeoutMs: input.mode === 'fast' ? 180000 : 300000,
    maxAttempts: 1,
    responseFormat: { type: 'json_object' },
    signal
  }
  let response
  let result
  for (let attempt = 0; attempt < 2; attempt += 1) {
    ensureActive()
    response = await chatDetailed(LABOR_ARBITRATION_SYSTEM_PROMPT, maskedUserContent + (attempt ? privacyRedactor.mask(`\n【上一结果结构缺漏，请仅按原材料修补，仍返回完整JSON】\n${result.issues.join('\n')}\n修补一处不得删掉其它内容。输出前复核：草稿保留标题、答辩人、总答辩请求、分别对应每项请求的四标签正文、证据清单、结语和此致落款；不同请求各用一个“关于……请求”标题，不因观点相同合并章节。总答辩请求仍须与逐项结论一致。一般追问仍不要求生成整份草稿。`) : ''), modelOptions)
    if (response.finishReason === 'length') break
    try { result = normalizeArbitrationResult(privacyRedactor.restoreDeep(parseJson(response.content))) } catch {
      result = { issues: ['返回内容必须为单个有效JSON对象'] }
      continue
    }
    const issues = arbitrationResultIssues(result, { action, requests: sourceRequests })
    if (!issues.length) break
    result = { issues }
    await emit('arbitration.progress', { label: '正在核对请求覆盖和文书完整性…', stage: 'validation' })
  }
  ensureActive()
  if (response.finishReason === 'length') {
    const error = new Error('模型输出达到长度上限，本次结果未完成；请按具体请求分项继续分析。')
    error.code = 'arbitration_output_truncated'
    throw error
  }

  if (result?.issues) {
    const error = new Error(`本轮结果未完成核对：${result.issues.slice(0, 3).join('；')}。请补充关键材料或按请求分项重试。`)
    error.code = action === 'draft' && result.issues.includes('模型未返回答辩文书正文') ? 'arbitration_draft_missing' : 'arbitration_result_invalid'
    throw error
  }
  result = privacyRedactor.restoreDeep(result)
  validateArbitrationDateAssertions(result, dateChecks)
  if (!safeText(result.answer) && !(Array.isArray(result.claims) && result.claims.some((claim) => safeText(claim?.claim))) && !safeText(result.defenseDraft)) {
    const error = new Error('模型未返回有效的案件分析，请补充材料后重试。')
    error.code = 'arbitration_result_invalid'
    throw error
  }
  result = validateLegalBasis(result)
  result.kind = action === 'draft' ? 'draft' : action === 'analyze' ? 'analysis' : 'reply'
  result.answer = safeText(result.answer, 10000)
  const title = validateTitle(result.conversationTitle)
  result.conversationTitle = title.ok ? title.title : ''
  result.documentTypes = Array.isArray(result.documentTypes) ? result.documentTypes : []
  result.claims = Array.isArray(result.claims) ? result.claims : []
  result.claims = result.claims.filter((claim) => claim && typeof claim === 'object').map((claim) => ({
    ...claim, riskLevel: normalizeLevel(claim.riskLevel), defenseAdvice: safeText(claim.defenseAdvice, 6000)
  }))
  result.disputes = Array.isArray(result.disputes) ? result.disputes : []
  result.riskBasis = Array.isArray(result.riskBasis) ? result.riskBasis.filter((item) => typeof item === 'string' && item.trim()) : []
  if (!result.riskBasis.length && result.overallRisk !== 'unknown') {
    result.overallRisk = 'unknown'
    warnings.push('模型未给出风险分级依据，暂不展示确定的风险档位。')
  }
  result.evidenceGaps = Array.isArray(result.evidenceGaps) ? result.evidenceGaps : []
  result.evidenceList = Array.isArray(result.evidenceList) ? result.evidenceList : []
  result.defenseStrategy = Array.isArray(result.defenseStrategy) ? result.defenseStrategy : []
  result.hearingPoints = Array.isArray(result.hearingPoints) ? result.hearingPoints : []
  result.followUpQuestions = Array.isArray(result.followUpQuestions) ? result.followUpQuestions : []
  for (const name of ['caseInfo', 'documentTypes', 'evidenceGaps', 'evidenceList', 'disputes']) {
    if (Array.isArray(result[name])) result[name] = result[name].filter((item) => item && (typeof item === 'object' || (name === 'disputes' && typeof item === 'string')))
  }
  for (const name of ['defenseStrategy', 'hearingPoints', 'followUpQuestions']) result[name] = result[name].filter((item) => typeof item === 'string' && item.trim())
  if (typeof result.defenseDraft === 'string' && result.defenseDraft.length > 60000) {
    const error = new Error('答辩文书过长，本次正文不完整，请按请求分项生成。')
    error.code = 'arbitration_output_truncated'
    throw error
  }
  result.defenseDraft = formatArbitrationDraft(safeText(result.defenseDraft, 60000))
  if (incompleteMaterials && result.defenseDraft) result.defenseDraft = `> 材料范围提示：部分正文未读全或识别需核对，本草稿仅针对已读取材料与已识别请求，提交前请核对完整申请书及原件。\n\n${result.defenseDraft}`
  const lawNotes = [...new Set(result.claims.flatMap((claim) => claim.legalBasis.map((law) => `${law.name || '法规'}${law.article ? ` ${law.article}` : ''}：${law.note}`)))]
  if (result.defenseDraft && lawNotes.length) result.defenseDraft += `\n\n---\n\n**法规复核提示（提交前处理）**\n\n${lawNotes.map((note) => `- ${note}`).join('\n')}`
  if (/已由【待补充】[^。\n]{0,30}受理/.test(result.defenseDraft)) {
    result.defenseDraft = result.defenseDraft.replace(/已由【待补充】[^。\n]{0,30}受理/g, '【受理情况及仲裁委员会待核实】')
    warnings.push('文书中的受理情况尚未明确，已保留待核实标记。')
  }
  if (action === 'analyze' && result.claims.length && !result.defenseDraft) warnings.push('本轮已返回案件分析，但未生成答辩文书；可以继续补充信息或点击生成完整答辩意见。')
  if (action === 'draft' && !result.defenseDraft) {
    const error = new Error('模型未返回答辩文书正文，请补充请求和案件信息后重试。')
    error.code = 'arbitration_draft_missing'
    throw error
  }
  result.usage = response.usage || null
  result.contextUsage = {
    capacity: CONTEXT_WINDOW_TOKENS,
    estimatedPromptTokens: systemTokens + estimateTokens(maskedUserContent) + 64,
    promptTokens: Number.isFinite(response.usage?.prompt_tokens) ? response.usage.prompt_tokens : null,
    systemTokens, historyTokens: selected.tokens,
    materialsTokens: estimateTokens(documents.map((item) => item.text).join('\n')),
    referenceTokens: estimateTokens(referenceContext),
    droppedMessages
  }
  result.references = [
    ...opinions.map(({ title }) => ({ title, sourceType: 'arbitration_opinion', use: '团队提供的仲裁意见参考材料，仅供观点和结构参考。' })),
    ...practical.map((item) => ({ title: item.title, sourceType: 'labor_practice', use: '劳动用工实务资料，仅作参考。' })),
    ...cases.map((item) => ({ title: item.title, sourceType: 'case', use: '相似案例，仅供比较，不代表本案事实或必然裁决结果。' }))
  ]
  result.warnings = [...warnings, ...(Array.isArray(result.warnings) ? result.warnings.map((item) => safeText(item, 500)) : [])]
  result.privacyNotice = REDACTION_NOTICE
  result.model = response.model || getFlashModel()
  result.materialCoverage = { partial: incompleteMaterials, files: documents.map(({ fileName, partial }) => ({ fileName, partial: Boolean(partial) })) }
  return result
}
