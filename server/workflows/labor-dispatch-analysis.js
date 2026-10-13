import { MAX_MODEL_OUTPUT_TOKENS } from '../../src/utils/context-budget.js'
import { extractText } from '../services/file-parser.js'
import { searchEvidence, DEFAULT_EVIDENCE_LIMIT } from '../services/knowledge-base.js'
import { listLawsForBaseline, resolveLawStatus } from '../services/law-whitelist.js'
import { chatDetailed, getFlashModel, getProModel, streamChat } from '../services/llm-client.js'
import { createLaborContractRedactor, LABOR_CONTRACT_REDACTION_NOTICE } from '../services/labor-contract-redaction.js'
import { LABOR_DISPATCH_ANALYSIS_SYSTEM_PROMPT, LABOR_DISPATCH_ANALYSIS_TOPICS, buildLaborDispatchAnalysisUserMessage, LABOR_DISPATCH_FOLLOWUP_SYSTEM_PROMPT, buildLaborDispatchFollowupMessage } from '../prompts/labor-dispatch-analysis.js'
import { createLaborContractFollowupWorkflow, locateLaborContractQuote, executeLaborContractReview } from './labor-contract-analysis.js'
import { consolidateContractFindings } from '../agents/contract-consolidator.js'
import { rewriteContract } from '../agents/contract-rewriter.js'
import { MAX_CONTRACT_TEXT, TaskCancelledError, isValidAttachment } from './contract-review.js'

const ALLOWED_STATUSES = new Set(['covered', 'missing', 'unclear', 'risk', 'not_applicable'])
const STATUS_LABELS = Object.freeze({
  verified: '法规记录已核实',
  provisional: '法规记录待复核',
  superseded: '法规版本已更新',
  repealed: '法规已废止',
  expired: '法规记录已失效',
  pending_effect: '法规尚未生效',
  not_found: '法规未收录，需人工核实'
})
const text = (value, limit = 1200) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const textList = (value, maxItems = 8, maxLength = 600) => Array.isArray(value)
  ? value.map((item) => text(item, maxLength)).filter(Boolean).slice(0, maxItems)
  : []
const checkpointResult = (getCheckpoint, stage) => getCheckpoint?.(stage)?.result || null

function outputError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  return error
}

function parseOutput(raw, afterRetry = false) {
  const source = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (!source) throw outputError('劳务派遣协议分析没有收到模型输出。', 'labor_dispatch_output_empty')
  try {
    const value = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根节点必须是 JSON 对象')
    return value
  } catch (error) {
    throw outputError(`劳务派遣协议分析${afterRetry ? '精简重试后' : ''}未返回有效 JSON：${error.message}`, 'labor_dispatch_output_invalid', error)
  }
}

function assertCompleteTopics(raw) {
  const expected = new Map(LABOR_DISPATCH_ANALYSIS_TOPICS.map(({ id, label }) => [id, label]))
  const seen = new Set()
  for (const item of Array.isArray(raw.topicChecks) ? raw.topicChecks : []) {
    const label = expected.get(item?.id)
    if (label && item?.topic === label && !seen.has(item.id)) seen.add(item.id)
  }
  const missing = [...expected].filter(([id]) => !seen.has(id)).map(([, label]) => label)
  if (missing.length || (Array.isArray(raw.topicChecks) ? raw.topicChecks.length : 0) !== expected.size) {
    throw outputError(`劳务派遣协议分析检查项不完整${missing.length ? `：${missing.join('、')}` : '，包含重复或未识别的项目'}。`, 'labor_dispatch_output_incomplete')
  }
}

const normalizedLawName = (value) => String(value || '').replace(/[《》\s\u3000]/g, '').replace(/[（(](?:19|20)\d{2}[^）)]*[）)]/g, '').trim()
function matchLaw(title, laws) {
  const wanted = normalizedLawName(title)
  return wanted ? laws.find((law) => [law.title, ...(Array.isArray(law.aliases) ? law.aliases : [])].some((candidate) => normalizedLawName(candidate) === wanted)) || null : null
}

function makeLawCatalog(laws, resolveStatus) {
  return laws.slice(0, 80).map((law) => ({
    title: law.title,
    aliases: Array.isArray(law.aliases) ? law.aliases : [],
    versionLabel: law.versionLabel || '',
    effectiveFrom: law.effectiveFrom || '',
    effectiveTo: law.effectiveTo || '',
    status: law.status || '',
    reviewStatus: law.reviewStatus || 'pending',
    verificationStatus: resolveStatus(law),
    sourceUrl: /^https:\/\//i.test(String(law.sourceUrl || '')) ? law.sourceUrl : ''
  }))
}

function sanitizeEvidence(items = []) {
  return items.slice(0, DEFAULT_EVIDENCE_LIMIT).map((item, index) => ({
    id: String(item.evidenceId || `dispatch-evidence-${index + 1}`),
    sourceType: item.kind === 'risk_rule' ? 'risk-rule' : 'template-clause',
    title: text(item.title || item.sourceName || item.category || '劳务派遣协议参考资料', 180),
    sourceName: text(item.sourceName, 180),
    text: text(item.text, 1800),
    topicLabels: textList(item.topicLabels, 12, 80)
  }))
}

function normalizeOutput(raw, { documents, evidence, laws, resolveStatus, reviewPerspective }) {
  const infoSource = raw.agreementInfo && typeof raw.agreementInfo === 'object' ? raw.agreementInfo : {}
  const agreementInfo = Object.fromEntries([
    'dispatchingUnit', 'usingUnit', 'workerCount', 'positions', 'workLocation', 'dispatchTerm',
    'wageArrangement', 'socialInsurance', 'serviceFee', 'reviewPerspectiveSummary'
  ].map((key) => [key, text(infoSource[key], 1200)]))
  const topicChecks = LABOR_DISPATCH_ANALYSIS_TOPICS.map(({ id, label }) => {
    const source = (raw.coverage || raw.topicChecks || []).find((item) => item?.id === id)
    return {
      id,
      topic: label,
      status: ALLOWED_STATUSES.has(source?.status) ? source.status : 'unclear',
      summary: text(source?.summary, 800) || '模型未返回此项的可用检查结论，需人工复核。'
    }
  })
  const evidenceById = new Map(evidence.map((item) => [item.id, item]))
  const findings = (Array.isArray(raw.findings) ? raw.findings : []).map((item, index) => {
    const location = locateLaborContractQuote(text(item?.quote, 1000), documents)
    const matchedQuote = location.matches[0]?.excerpt || null
    const authorities = (Array.isArray(item?.authorities) ? item.authorities : []).slice(0, 8).map((authority) => {
      const law = matchLaw(text(authority?.title, 180), laws)
      if (!law) return null
      const status = resolveStatus(law)
      const article = text(authority?.article, 100).match(/第[0-9一二三四五六七八九十百千万零〇]+条(?:第[0-9一二三四五六七八九十百千万零〇]+款)?/)?.[0] || ''
      return {
        title: law.title,
        article,
        lawStatus: status,
        lawStatusLabel: STATUS_LABELS[status] || STATUS_LABELS.not_found,
        articleApplicability: 'pending-mentor-and-legal-review',
        sourceUrl: /^https:\/\//i.test(String(law.sourceUrl || '')) ? law.sourceUrl : ''
      }
    }).filter(Boolean)
    const supportingMaterials = [...new Set(textList(item?.supportingEvidenceIds, 12, 160))]
      .map((id) => evidenceById.get(id))
      .filter(Boolean)
      .map((source) => ({ id: source.id, sourceType: source.sourceType, title: source.title }))
    return {
      id: `dispatch-finding-${index + 1}`,
      topic: text(item?.topic, 100) || '派遣协议条款',
      title: text(item?.title, 200) || '需要核对的事项',
      level: ['高', '中', '低'].includes(item?.level) ? item.level : null,
      explanation: text(item?.risk || item?.explanation, 2400),
      quote: matchedQuote,
      sourceRole: text(item?.sourceRole, 60),
      location,
      applicableConditions: textList(item?.applicableConditions, 8, 600),
      authorities,
      supportingMaterials,
      recommendation: text(item?.advice || item?.recommendation, 1600),
      suggestedClause: text(item?.suggestedClause, 3000)
    }
  })
  const missingItems = (Array.isArray(raw.missingItems) ? raw.missingItems : []).slice(0, 30).map((item) => ({
    topic: text(item?.topic, 100) || '待确认事项',
    item: text(item?.item, 700),
    reason: text(item?.reason, 1000),
    location: { status: 'not-found', matches: [] }
  })).filter((item) => item.item || item.reason)
  const lawCandidates = [...new Map((Array.isArray(raw.lawCandidates) ? raw.lawCandidates : []).slice(0, 16)
    .map((item) => ({ title: text(item?.title, 180), reason: text(item?.reason, 700), status: 'unverified' }))
    .filter((item) => item.title && !matchLaw(item.title, laws))
    .map((item) => [item.title, item])).values()].slice(0, 10)
  const pairedContract = documents.some((document) => document.role === 'dispatch_employment_contract')
  const warnings = [
    ...textList(raw.analysisNotes, 12, 600),
    '本报告为待 Mentor / 法务复核的分析草案，不构成个案法律意见；法规记录状态不等于条文适用性已经确认。',
    ...(pairedContract ? [] : ['本次只上传劳务派遣协议，未能与派遣劳动合同交叉核对；实际履行情况也未核验。']),
    ...(findings.some((item) => item.location.status !== 'found') ? ['部分提示未能唯一定位到上传原文，请先核对摘录与来源。'] : []),
    ...(evidence.length ? [] : ['没有检索到“劳务派遣协议”专属范本或风险规则；未用其他合同资料代替。'])
  ]
  const contextQuestions = textList(raw.contextQuestions, 14, 700)
  if (!pairedContract && !contextQuestions.some((item) => item.includes('劳动合同'))) {
    contextQuestions.push('如需交叉核对，请补充被派遣劳动者与派遣单位签订的劳动合同。')
  }
  return {
    schemaVersion: 1,
    productId: 'labor-contract-analysis',
    analysisType: 'labor_dispatch_agreement',
    kind: 'analysis',
    analysisStatus: 'completed',
    reviewPerspective,
    reviewPerspectiveLabel: reviewPerspective === 'using_unit' ? '用工单位' : '派遣单位',
    agreementInfo,
    conclusion: text(raw.conclusion, 1000),
    score: { value: Number.isInteger(raw.score) ? raw.score : null, status: Number.isInteger(raw.score) ? 'model-reference' : 'unavailable' },
    contractInfo: { employer: agreementInfo.dispatchingUnit, workLocation: agreementInfo.workLocation, contractType: '劳务派遣协议' },
    topicChecks,
    missingItems,
    findings,
    lawCandidates,
    contextQuestions,
    warnings: [...new Set(warnings)],
    crossDocumentReviewStatus: pairedContract ? 'paired-materials' : 'agreement-only',
    sourceFiles: documents.map((document) => ({ fileId: document.fileId, fileName: document.fileName, role: document.role })),
    privacyNotice: LABOR_CONTRACT_REDACTION_NOTICE,
    reviewStatus: 'draft-pending-mentor-and-legal-review',
    generatedAt: new Date().toISOString()
  }
}

export function createLaborDispatchAnalysisWorkflow({
  parseFile = extractText,
  retrieveEvidence = searchEvidence,
  getLawCatalog = listLawsForBaseline,
  resolveStatus = resolveLawStatus,
  generate,
  streamGenerate,
  consolidate = consolidateContractFindings,
  rewrite = rewriteContract
} = {}) {
  const optionsFor = ({ mode, signal, requestTimeoutMs, maxTokens }) => ({
    model: mode === 'fast' ? getFlashModel() : getProModel(), temperature: 0.15,
    maxTokens: maxTokens || MAX_MODEL_OUTPUT_TOKENS,
    thinking: { type: mode === 'fast' ? 'disabled' : 'enabled' },
    ...(mode === 'fast' ? {} : { reasoningEffort: 'low' }),
    responseFormat: { type: 'json_object' }, signal, requestTimeoutMs, maxAttempts: 1
  })
  const generateCompletion = generate || (async (request) => chatDetailed(request.systemPrompt, request.userMessage, optionsFor(request)))
  const streamCompletion = streamGenerate || (!generate ? async function* (request) {
    yield* streamChat(request.systemPrompt, request.userMessage, optionsFor(request))
  } : null)

  return async function runLaborDispatchAnalysis({
    task, input = {}, files = [], sourceDocuments = [], emit = async () => {}, checkpoint = async () => {},
    getCheckpoint = () => null, isCancellationRequested = () => false,
    updateFileParseStatus = () => {}, privacyAliases = [], signal, fakeLlm = false
  } = {}) {
    if (!task?.id) throw new Error('缺少任务信息')
    if (input.analysisType !== 'labor_dispatch_agreement') throw new Error('派遣分析任务类型无效')
    if (!['dispatch_unit', 'using_unit'].includes(input.reviewPerspective)) throw new Error('请选择派遣单位或用工单位视角')
    if (!files.length && !sourceDocuments.length) throw new Error('请上传劳务派遣协议')
    for (const file of files) if (!isValidAttachment(file)) throw new Error(`${file.originalname || '文件'} 文件类型暂不支持`)
    const ensureActive = () => { if (signal?.aborted || isCancellationRequested?.()) throw new TaskCancelledError() }
    const warnings = []
    let parsed = checkpointResult(getCheckpoint, 'parsing')
    if (!Array.isArray(parsed?.documents) || !parsed.documents.some((item) => item.text?.trim())) {
      await emit('stage.start', { stage: 'parsing', label: '正在读取劳务派遣协议和配套材料' })
      const documents = []
      const parseErrors = []
      const inputOrder = new Map((input.fileRefs || []).map((ref, index) => [String(ref.id), index]))
      const filesInInputOrder = [...files].sort((left, right) =>
        (inputOrder.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) - (inputOrder.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER)
      )
      for (const [index, file] of filesInInputOrder.entries()) {
        ensureActive()
        await emit('stage.progress', { stage: 'parsing', message: `正在解析材料 ${index + 1}/${files.length}` })
        try {
          const result = await parseFile(file)
          const content = String(result?.text || '').trim()
          updateFileParseStatus(file.id, content ? 'succeeded' : 'empty')
          if (content) documents.push({
            fileId: String(file.id || ''), fileName: String(file.originalname || file.originalName || '上传文件'),
            role: input.fileRefs?.find((ref) => ref.id === file.id)?.role || input.fileRoles?.[index] || '',
            pageCount: Number(result?.pageCount) || null, text: content, parseMetadata: result.metadata
          })
          else parseErrors.push(`材料 ${index + 1}：未提取到可分析文本`)
        } catch (error) {
          updateFileParseStatus(file.id, 'failed')
          parseErrors.push(`材料 ${index + 1}：${text(error.message, 400) || '解析失败'}`)
        }
      }
      if (!files.length && sourceDocuments.length) {
        const roleById = new Map((input.fileRefs || []).map((ref) => [String(ref.id), ref.role]))
        documents.push(...sourceDocuments.filter((item) => item?.text?.trim()).map((item, index) => ({
          ...item,
          role: item.role || roleById.get(String(item.fileId)) || input.fileRoles?.[index] || ''
        })))
      }
      if (!documents.length) {
        const error = new Error(`文件解析失败：${parseErrors.join('；') || '未提取到可用文字'}`)
        error.code = 'labor_dispatch_parse_failed'
        throw error
      }
      const totalLength = documents.reduce((sum, item) => sum + item.text.length, 0)
      if (totalLength > MAX_CONTRACT_TEXT) {
        const error = new Error(`派遣协议及配套材料正文超过 ${MAX_CONTRACT_TEXT} 字符，请拆分文件后重试`)
        error.code = 'labor_dispatch_text_too_long'
        throw error
      }
      parsed = { documents, parseErrors, totalLength }
      if (files.length && !['reanalyze', 'restart-analysis'].includes(input.action)) await checkpoint('parsing', parsed)
      await emit('stage.complete', { stage: 'parsing', summary: `解析完成，提取 ${totalLength} 个字符`, fileCount: documents.length })
    } else {
      parsed.totalLength ||= parsed.documents.reduce((sum, item) => sum + String(item.text || '').length, 0)
      const roleById = new Map((input.fileRefs || []).map((ref) => [String(ref.id), ref.role]))
      parsed.documents = parsed.documents.map((item, index) => ({
        ...item,
        role: item.role || roleById.get(String(item.fileId)) || input.fileRoles?.[index] || ''
      }))
      await emit('stage.start', { stage: 'parsing', label: '正在恢复已保存的文本解析结果' })
      await emit('stage.complete', { stage: 'parsing', summary: `已恢复 ${parsed.totalLength} 个字符`, recovered: true })
    }
    warnings.push(...textList(parsed.parseErrors, 8, 500))
    const agreementDocuments = parsed.documents.filter((document) => document.role === 'dispatch_agreement')
    if (agreementDocuments.length !== 1) {
      const error = new Error('请为本次材料指定且只指定一份劳务派遣协议作为主文件。')
      error.code = 'dispatch_agreement_required'
      throw error
    }
    ensureActive()

    const focus = text(input.focus || task.prompt, 16000)
    const previousAliases = [
      ...(Array.isArray(privacyAliases) ? privacyAliases : []),
      ...(Array.isArray(input.privacyAliases) ? input.privacyAliases : []),
      ...(checkpointResult(getCheckpoint, 'privacy')?.aliases || [])
    ]
    let redactor = createLaborContractRedactor({ documents: parsed.documents, aliases: previousAliases, extraTexts: [focus] })
    let knowledge = checkpointResult(getCheckpoint, 'knowledge')
    if (!knowledge) {
      await emit('stage.start', { stage: 'knowledge', label: '正在检索劳务派遣协议专属参考资料' })
      const topics = LABOR_DISPATCH_ANALYSIS_TOPICS.map((topic) => ({ ...topic }))
      if (focus) topics.push({ id: 'user-focus', label: '用户侧重点', query: redactor.mask(focus).slice(0, 500) })
      let rawEvidence = []
      let retrievalFailure = ''
      try {
        const retrieved = await retrieveEvidence({ contractType: '劳务派遣协议', topics }, {
          limit: DEFAULT_EVIDENCE_LIMIT, perDocumentCap: 5, strictContractType: true
        })
        rawEvidence = (Array.isArray(retrieved) ? retrieved : [])
          .filter((item) => item.contractType === '劳务派遣协议' && ['clause', 'risk_rule'].includes(item.kind))
      } catch (error) {
        retrievalFailure = `劳务派遣协议参考资料检索不可用：${text(error.message, 300) || '未知原因'}`
        warnings.push(retrievalFailure)
      }
      let laws = []
      try {
        const listed = await getLawCatalog()
        laws = Array.isArray(listed) ? listed : []
      } catch (error) {
        warnings.push(`法规白名单暂时不可用：${text(error.message, 300) || '未知原因'}`)
      }
      knowledge = { evidence: sanitizeEvidence(rawEvidence), laws, lawCatalog: makeLawCatalog(laws, resolveStatus), retrievalFailure }
      await checkpoint('knowledge', knowledge)
      await emit('stage.complete', {
        stage: 'knowledge',
        summary: `派遣协议专属参考资料 ${knowledge.evidence.length} 条；法规记录 ${knowledge.lawCatalog.length} 条`,
        evidenceCount: knowledge.evidence.length, lawCount: knowledge.lawCatalog.length
      })
    } else {
      await emit('stage.start', { stage: 'knowledge', label: '正在恢复已保存的派遣协议检索结果' })
      await emit('stage.complete', { stage: 'knowledge', summary: `已恢复参考资料 ${knowledge.evidence?.length || 0} 条和法规记录 ${knowledge.lawCatalog?.length || 0} 条`, recovered: true })
      if (knowledge.retrievalFailure) warnings.push(knowledge.retrievalFailure)
    }
    redactor = createLaborContractRedactor({
      documents: parsed.documents,
      aliases: redactor.aliases,
      extraTexts: [focus, knowledge.evidence || [], knowledge.lawCatalog || []]
    })
    await checkpoint('privacy', { aliases: redactor.aliases, version: 'selective-pseudonymization-v1' })
    const saved = checkpointResult(getCheckpoint, 'analysis')?.result
    if (saved) {
      await emit('analysis.result', { resultAvailable: true, recovered: true })
      return saved
    }

    const reviewPerspective = input.reviewPerspective
    const result = await executeLaborContractReview({
      task, input, documents: parsed.documents, focus, evidence: knowledge.evidence || [], laws: knowledge.laws || [],
      lawPromptCatalog: knowledge.lawCatalog || [], resolveStatus, privacyRedactor: redactor,
      emit, checkpoint, getCheckpoint, ensureActive, signal, fakeLlm, generateCompletion, streamCompletion, consolidate, rewrite,
      reviewTopics: LABOR_DISPATCH_ANALYSIS_TOPICS, reviewSystemPrompt: LABOR_DISPATCH_ANALYSIS_SYSTEM_PROMPT,
      messageBuilder: buildLaborDispatchAnalysisUserMessage, normalizeResult: normalizeOutput, extraContext: { reviewPerspective },
      readOnlyDocumentRoles: reviewPerspective === 'using_unit' ? ['dispatch_employment_contract'] : [],
      rewriteSystemPrompt: `你是企业侧劳务派遣协议局部修订助手，本次代表${reviewPerspective === 'using_unit' ? '用工单位' : '派遣单位'}。只处理已定位风险，遵守商业合同修订 JSON 协议；协议是两个企业之间的约定，不套用普通劳动合同九项。配套劳动合同只用于交叉核对，不擅自修改不属于所选企业签订的材料。不得编造金额、日期、主体或转移法定义务。`
    })
    result.warnings = [...new Set([...result.warnings, ...warnings])]
    if (fakeLlm) result.fake = true
    await checkpoint('analysis', { result })

    return result
  }
}

export const runLaborDispatchAnalysis = createLaborDispatchAnalysisWorkflow()

export const runLaborDispatchFollowup = createLaborContractFollowupWorkflow({
  systemPrompt: LABOR_DISPATCH_FOLLOWUP_SYSTEM_PROMPT,
  messageBuilder: buildLaborDispatchFollowupMessage,
  expiredSourceMessage: '派遣协议原文已到期。现在只能解释旧报告；要重新核对协议或配套材料，请重新上传。'
})
