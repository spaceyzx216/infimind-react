import { selectMaterialBlocks, formatMaterialBlocks } from '../services/document-materials.js'
import { indexedMaterialText } from '../services/material-processing.js'
import { chatDetailed, getFlashModel } from '../services/llm-client.js'
import { createLaborContractRedactor } from '../services/labor-contract-redaction.js'
import { extractQueryTerms } from '../services/cjk-tokenizer.js'
import { searchLaborKbLexical } from '../services/labor-kb.js'
import { searchCases } from '../services/law-whitelist.js'
import { validateTitle } from '../services/title-refiner.js'
import { selectArbitrationMaterialText, arbitrationResultIssues, extractExplicitArbitrationRequests, arbitrationRequestCoverageIssues } from '../services/arbitration-validation.js'
import { buildCaseSources, materialSignature, normalizeCaseRecord, validateAnalysisSources,
  validateDraftParts, composeArbitrationDraft, affectedRequestIds, calculationIssues, inlineArithmeticIssues, list, str, hash } from '../services/arbitration-case-record.js'
import { CASE_RECORD_PROMPT, CASE_ANALYSIS_PROMPT, CASE_REPLY_PROMPT, CASE_DRAFT_PROMPT, CASE_REVIEW_PROMPT } from '../prompts/labor-arbitration-stages.js'
import { normalizeArbitrationResult } from '../../src/utils/arbitration-result.js'
import { CONTEXT_WINDOW_TOKENS, OUTPUT_RESERVE_TOKENS, CONTEXT_SAFETY_TOKENS, estimateTokens, selectHistoryByTokens } from '../../src/utils/context-budget.js'

const stageError = (message, code = 'arbitration_result_invalid') => Object.assign(new Error(message), { code })
export const isExplicitArbitrationDraftRequest = (message) => String(message || '').split(/[。！？\n，,；;]/).some((clause) =>
  /(?:生成|写|出|改写|修改|更新|重写|提供|给我|帮我)[^。！？\n]{0,18}(?:草稿|答辩(?:意见|书|文书))/.test(clause)
  && !/(?:不要|不用|无需|不必|暂不|先不|不|别)[^。！？\n]{0,6}(?:生成|写|出|改写|修改|更新|重写|提供)/.test(clause))
const level = (value) => ['low', 'medium', 'high', 'unknown'].includes(value) ? value : 'unknown'
const containsCandidateQuote = (value, quote) => typeof value === 'string' ? value.includes(quote)
  : value && typeof value === 'object' ? Object.values(value).some((item) => containsCandidateQuote(item, quote)) : false

export function selectOpinionFragments(opinions, request) {
  const { primary, expanded } = extractQueryTerms(request, { limit: 14 })
  const terms = [...new Set([...primary, ...expanded])].filter((term) => term.length >= 2)
  return opinions.flatMap((opinion) => str(opinion.text).split(/\n\s*\n/).flatMap((paragraph, p) => {
    const chunks = paragraph.match(/[\s\S]{1,1800}/g) || []
    return chunks.map((text, c) => ({ title: opinion.title, sourceType: 'arbitration_opinion', text,
      score: terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0), fragment: `${p}-${c}` }))
  })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3)
}

// Dependencies are injectable for isolated tests; production uses the existing client and KB.
export async function runStagedArbitration({ task = {}, input = {}, documents, warnings = [],
  checkpoint, getCheckpoint, emit, ensureActive, signal, fakeLlm, loadOpinions,
  validateLegalBasis, validateDates, dependencies = {} }) {
  const callModel = dependencies.chat || chatDetailed
  const practicalSearch = dependencies.practicalSearch || searchLaborKbLexical
  const caseSearch = dependencies.caseSearch || searchCases
  const taskId = task.id || 'direct-v2'
  const userMessage = str(input.message).slice(0, 16000)
  const rawUserMessages = [...list(input.userMessages).filter((item) => item.role !== 'assistant'),
    ...(userMessage ? [{ taskId, content: userMessage }] : [])].filter((item) => str(item.content))
  const selectedMessages = selectHistoryByTokens(rawUserMessages.map((item) => ({ ...item, role: 'user' })), 100000)
  // The shared selector intentionally strips metadata; preserve task identity
  // while taking its selected suffix, otherwise statements would share an ID.
  const userMessages = rawUserMessages.slice(rawUserMessages.length - selectedMessages.history.length)
  if (selectedMessages.droppedMessages) warnings.push('较早企业陈述未纳入本轮；涉及早期事实时请补充原文，不能以旧分析替代。')
  const materialSelection = selectMaterialBlocks(documents, userMessage)
  const indexText = indexedMaterialText(input.materialIndex)
  const selected = (input.materialIndex?.length ? documents.map((doc) => ({ ...doc, text: formatMaterialBlocks(materialSelection.blocks.filter((b) => b.fileId === doc.fileId)) + '\n' + indexedMaterialText(input.materialIndex.filter((e) => e.fileId === doc.fileId)), partial: materialSelection.coverage.partial })) : selectArbitrationMaterialText(documents, userMessage, 80000)).map((doc) => ({
    ...doc, originalText: documents.find((original) => original.fileId === doc.fileId && original.fileName === doc.fileName)?.text || doc.text
  }))
  const sources = buildCaseSources(selected, userMessages)
  const materialHash = materialSignature(sources, input.excludedFileIds)
  const previous = input.previousCaseRecord?.schemaVersion === 2 ? input.previousCaseRecord : null
  const activeSourceIds = new Set(sources.map((source) => source.id))
  const currentUserSources = sources.filter((source) => source.kind === 'company_statement')
  const userHash = hash(currentUserSources.map((source) => ({ id: source.id, digest: hash(source.text) })))
  const inputHash = hash([materialHash, userHash, input.action, input.mode, previous?.taskId])
  const partial = selected.some((doc) => doc.partial || doc.truncated || doc.parseWarnings?.length)
    || warnings.some((warning) => /解析失败|未提取到正文|无法读取|未保留/.test(warning))
  const redactor = createLaborContractRedactor({ documents: selected, extraTexts: [userMessages, previous],
    categories: ['phone', 'identity', 'email', 'business-id', 'bank-account'] })
  const options = { model: getFlashModel(), thinking: { type: input.mode === 'fast' ? 'disabled' : 'enabled' },
    reasoningEffort: 'high', temperature: 0.2, maxTokens: OUTPUT_RESERVE_TOKENS,
    requestTimeoutMs: input.mode === 'fast' ? 180000 : 300000, maxAttempts: 1,
    responseFormat: { type: 'json_object' }, signal }
  const calls = []
  const reviewNotes = []
  const parse = (response) => {
    if (response.finishReason === 'length') throw stageError('模型输出达到长度上限，本阶段未完成。', 'arbitration_output_truncated')
    const result = JSON.parse(String(response.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('需要JSON对象')
    return redactor.restoreDeep(result)
  }
  const invoke = async (stage, prompt, context) => {
    ensureActive()
    const masked = redactor.mask(JSON.stringify(context))
    if (estimateTokens(prompt) + estimateTokens(masked) + options.maxTokens + CONTEXT_SAFETY_TOKENS > CONTEXT_WINDOW_TOKENS) throw stageError('本阶段上下文超过模型预算，请精简材料或按请求分项继续。', 'arbitration_output_truncated')
    const response = await callModel(prompt, masked, { ...options,
      maxTokens: OUTPUT_RESERVE_TOKENS })
    ensureActive()
    calls.push({ stage, model: response.model || options.model, usage: response.usage || null,
      promptHash: hash(prompt), inputHash: hash(masked), estimatedPromptTokens: estimateTokens(prompt) + estimateTokens(masked) + 64 })
    try { return parse(response) } catch (error) {
      if (error.code) throw error
      throw Object.assign(stageError(`模型未返回有效JSON对象：${str(error.message).slice(0, 180)}`),
        { repairCandidate: str(response.content).slice(0, 40000) })
    }
  }
  const runStage = async (stage, label, prompt, context, validate) => {
    const signature = hash([inputHash, stage, prompt, context])
    const cached = (await getCheckpoint(stage))?.result
    if (cached?.signature === signature && cached.value) return cached.value
    await emit('arbitration.progress', { stage, label })
    let issues = []
    let repairCandidate
    for (let attempt = 0; attempt < 2; attempt++) {
      ensureActive()
      let value
      try { value = await invoke(stage, prompt, { ...context, repair: attempt ? { issues, candidate: repairCandidate } : undefined }) }
      catch (error) {
        if (!['arbitration_result_invalid', 'arbitration_output_truncated'].includes(error.code)) throw error
        issues = [error.message]
        repairCandidate = error.repairCandidate
        if (!attempt) continue
        throw error
      }
      issues = await validate(value)
      repairCandidate = value
      ensureActive()
      if (!issues.length) { await checkpoint(stage, { signature, value }); return value }
    }
    throw stageError(`本阶段未完成核对：${issues.slice(0, 3).join('；')}`)
  }
  const review = async (candidateStage, candidate, record, analysis, references) => {
    const reviewed = await runStage(`arbitration_review_${candidateStage}`, '正在核对企业立场与材料依据…', CASE_REVIEW_PROMPT,
      { candidateStage, candidate, caseRecord: record, analysis, references }, (value) => {
        if (!Array.isArray(value.issues) || value.issues.some((issue) => !str(issue?.message))) return ['复核结果必须包含issues数组及具体问题']
        return []
      })
    const blockingCodes = new Set(['wrong_perspective', 'invented_fact', 'unapproved_commitment', 'missing_request', 'missing_subitem',
      'contradictory_position', 'invented_evidence', 'invalid_citation', 'arithmetic_error', 'cross_case', 'unsupported_applicability'])
    const errors = []
    for (const issue of reviewed.issues) {
      if (issue.code === 'arithmetic_error' && !calculationIssues(candidate.calculations).length && !inlineArithmeticIssues(candidate).length) {
        reviewNotes.push(`算式算术已由程序核对，参数与单位待法务核对：${str(issue.message)}`)
        continue
      }
      if (issue.severity === 'error' && blockingCodes.has(issue.code) && str(issue.candidateQuote)
        && containsCandidateQuote(candidate, str(issue.candidateQuote))) errors.push(`${str(issue.requestId)} ${str(issue.message)}`.trim())
      else reviewNotes.push(str(issue.message))
    }
    reviewNotes.push(...list(reviewed.notes).map(str))
    return errors
  }
  await checkpoint('material-coverage', { ...materialSelection.coverage, indexed: (input.materialIndex || []).map((e) => e.blockId), mode: 'case-index-and-request-selection' })
  const compactSources = sources.map(({ originalText, ...source }) => source)
  const previousUsable = previous && previous.materialSignature === materialHash
    && previous.sources.every((source) => activeSourceIds.has(source.id))
  let record
  let intent = input.action === 'draft' || isExplicitArbitrationDraftRequest(userMessage) ? 'draft' : 'update'
  if (fakeLlm) return { schemaVersion: 2, kind: 'analysis', answer: '模型桩只验证流程，不生成法律结论。',
    claims: [], overallRisk: 'unknown', riskBasis: [], followUpQuestions: ['请提供仲裁请求和案件材料。'], defenseDraft: '', warnings }
  const extracted = await runStage('arbitration_case', '正在梳理请求与材料来源…', CASE_RECORD_PROMPT,
    { message: userMessage, materialNotice: input.materialNotice || '', indexText, previousCaseRecord: previous, materialChanged: !previousUsable, sources: compactSources }, (value) => {
      if (!['update', 'question', 'draft'].includes(value.intent)) return ['必须返回用户意图intent']
      if (value.unchanged === true && previousUsable) return []
      if (!Array.isArray(value.requests) || !Array.isArray(value.facts)) return ['必须返回requests和facts数组']
      const { record: candidate, issues } = normalizeCaseRecord(value, sources, previous, { taskId, materialHash })
      if (candidate.relation === 'same') issues.push(...arbitrationRequestCoverageIssues(candidate.requests,
        extractExplicitArbitrationRequests(sources.map((source) => source.text).join('\n'))))
      return issues
    })
  const declinesDraft = !isExplicitArbitrationDraftRequest(userMessage)
    && /(?:不要|不用|无需|不必|暂不|先不|不|别)[^。！？\n，,；;]{0,6}(?:生成|写|出|改写|修改|更新|重写|提供)[^。！？\n，,；;]{0,18}(?:草稿|答辩(?:意见|书|文书))/.test(userMessage)
  if (extracted.intent === 'draft') {
    if (!declinesDraft || input.action === 'draft') intent = 'draft'
  } else if (intent !== 'draft') intent = extracted.intent
  if (extracted.unchanged === true && previousUsable) record = previous
  else record = normalizeCaseRecord(extracted, sources, previous, { taskId, materialHash }).record
  // Explicit numbered requests are a lower bound, not the complete extractor.
  // A source-backed model record covers non-numbered requests and opinion material.
  await checkpoint('arbitration_case_record', { record })
  let priorAnalysis = input.previousAnalysis
  const canReuse = record === previous && priorAnalysis?.caseRecord?.taskId === record.taskId
    && priorAnalysis?.caseRecord?.materialSignature === materialHash
  const changed = record !== previous
  const commonResult = {
    schemaVersion: 2, caseRecord: record, materialSignature: materialHash,
    caseVersion: record.version, caseInfo: record.caseInfo, followUpQuestions: record.followUpQuestions,
    materialCoverage: { partial, files: selected.map((doc) => ({ fileName: doc.fileName, partial: Boolean(doc.partial || doc.truncated) })) },
    changes: changed && previous ? { message: '已依据当前有效材料和企业陈述更新案件分析。',
      requestIds: record.requests.map((request) => request.id), previousCaseVersion: previous.version } : null
  }
  const finish = (result) => {
    if (commonResult.changes) {
      const affected = new Set(affectedRequestIds(record, previous, list(priorAnalysis?.claims)))
      commonResult.changes.requestIds = [...affected]
      commonResult.changes.items = list(result.claims).filter((claim) => affected.has(claim.requestId)).map((claim) => {
        const before = list(priorAnalysis?.claims).find((old) => old.requestId === claim.requestId)
        return { requestId: claim.requestId, claim: claim.claim, previousRisk: before?.riskLevel || null,
          riskLevel: claim.riskLevel, directionChanged: Boolean(before && before.companyPosition !== claim.companyPosition) }
      })
      commonResult.changes.removedRequests = list(previous?.requests).filter((old) => !record.requests.some((request) => request.id === old.id)).map((request) => request.text)
    }
    const normalized = normalizeArbitrationResult({ ...result, ...commonResult,
      references: result.retrievalSnapshot ? result.retrievalSnapshot.map(({ title, sourceType, use }) => ({ title, sourceType, use })) : result.references,
      followUpQuestions: list(result.followUpQuestions || record.followUpQuestions).slice(0, 3) })
    normalized.warnings = [...new Set([...warnings, ...list(result.warnings)])]
    normalized.model = calls.at(-1)?.model || options.model
    normalized.stageUsage = calls
    normalized.reviewNotes = [...new Set(reviewNotes.filter(Boolean))]
    normalized.usage = calls.length ? { prompt_tokens: calls.reduce((n, call) => n + (Number(call.usage?.prompt_tokens) || 0), 0),
      completion_tokens: calls.reduce((n, call) => n + (Number(call.usage?.completion_tokens) || 0), 0) } : null
    const last = calls.at(-1)
    normalized.contextUsage = { capacity: CONTEXT_WINDOW_TOKENS, estimatedPromptTokens: last?.estimatedPromptTokens || 0,
      promptTokens: last?.usage?.prompt_tokens ?? null, materialsTokens: estimateTokens(selected.map((doc) => doc.text).join('\n')) }
    const title = validateTitle(result.conversationTitle)
    normalized.conversationTitle = title.ok ? title.title : ''
    normalized.privacyNotice = '材料经服务器解析后发送给当前 DeepSeek；仅替换可识别的证件号、电话、邮箱、企业代码和银行账户，自动识别可能遗漏。'
    return normalized
  }
  if (!record.requests.length || record.relation !== 'same') return finish({ kind: 'analysis', answer: record.relation !== 'same'
    ? '材料的案件归属需要先澄清，暂不合并分析或生成答辩文书。'
    : '目前尚不能识别具体仲裁请求，可以先补充申请书或说明对方要求。', overallRisk: 'unknown', claims: [], defenseDraft: '' })
  if (canReuse && intent === 'question') {
    const reply = await runStage('arbitration_reply', '正在回答本案问题…', CASE_REPLY_PROMPT,
      { message: userMessage, caseRecord: record, analysis: priorAnalysis }, async (value) => {
        if (!str(value.answer)) return ['追问回复为空']
        const issues = arbitrationResultIssues(normalizeArbitrationResult(value), { action: 'followup' })
        return issues.length ? issues : review('reply', value, record, priorAnalysis, list(priorAnalysis.retrievalSnapshot))
      })
    return finish({ ...reply, kind: 'reply', defenseDraft: '', analysisVersion: priorAnalysis.analysisVersion,
      analysisTaskId: priorAnalysis.analysisTaskId, conversationTitle: priorAnalysis.conversationTitle })
  }
  let references
  let analysis
  if (canReuse && intent === 'draft') { analysis = priorAnalysis; references = list(priorAnalysis.retrievalSnapshot) }
  else {
    const cached = (await getCheckpoint('arbitration_retrieval'))?.result
    const retrievalSignature = hash([record, 'request-retrieval-v2'])
    if (cached?.signature === retrievalSignature) references = cached.references
    else {
      await emit('arbitration.progress', { stage: 'arbitration_retrieval', label: '正在查找各项请求的参考资料…' })
      const opinions = await loadOpinions()
      references = []
      let referenceChars = 0
      for (const request of record.requests) {
        ensureActive()
        let practical = [], cases = []
        try { practical = practicalSearch(request.text, { limit: 3 }) } catch { warnings.push('实务检索暂不可用，本次不据此确认法律结论。') }
        try { cases = caseSearch(request.text, { limit: 3, region: record.region }) } catch { warnings.push('类案检索暂不可用，本次不据此确认法律结论。') }
        const candidates = [
          ...selectOpinionFragments(opinions, request.text),
          ...practical.map((item) => ({ title: item.title, sourceType: 'labor_practice', text: str(item.content).slice(0, 1800), source: [item.book, item.chapter, item.section].filter(Boolean).join(' / ') })),
          ...cases.map((item) => ({ title: item.title, sourceType: 'case', text: `${item.disputeFocus || ''}\n${item.holding || ''}\n${item.legalBasis || ''}`.slice(0, 1800),
            region: item.region, judgedAt: item.judgedAt, source: item.sourceUrl || item.source }))
        ]
        for (const item of candidates) {
          if (referenceChars + item.text.length > 20000) continue
          referenceChars += item.text.length
          references.push({ ...item, id: `ref-${hash([request.id, item.sourceType, item.title, item.text]).slice(0, 16)}`, requestId: request.id,
            use: '仅供观点或表达参考，不作为本案事实，也不代表条文适用已核实。' })
        }
      }
      await checkpoint('arbitration_retrieval', { signature: retrievalSignature, references })
    }
    let affected = changed ? affectedRequestIds(record, previous, list(priorAnalysis?.claims)) : []
    // Missing/removed sources or unavailable previous analysis force a full
    // pass. Reusing a claim is allowed only with exactly unchanged dependencies.
    const reusable = Boolean(priorAnalysis && previous && priorAnalysis.caseRecord?.taskId === previous.taskId)
      && list(priorAnalysis.claims).every((claim) => list(claim.sourceIds).every((id) => activeSourceIds.has(id)))
    if (!reusable) affected = record.requests.map((request) => request.id)
    const unaffected = reusable ? list(priorAnalysis.claims).filter((claim) => record.requests.some((request) => request.id === claim.requestId) && !affected.includes(claim.requestId)) : []
    const analysisRecord = { ...record, requests: record.requests.filter((request) => affected.includes(request.id)) }
    const oldReferences = unaffected.length ? list(priorAnalysis.retrievalSnapshot).filter((ref) => unaffected.some((claim) => claim.requestId === ref.requestId)) : []
    references = [...new Map([...references, ...oldReferences].map((ref) => [ref.id, ref])).values()]
    analysis = reusable && !affected.length ? priorAnalysis : await runStage('arbitration_analysis', '正在逐项分析企业答辩方向…', CASE_ANALYSIS_PROMPT,
      { message: userMessage, caseRecord: analysisRecord, fullCaseRecord: record, unaffectedClaims: unaffected,
        references, priorAnalysis: canReuse ? priorAnalysis : null, affectedRequestIds: affected,
        requiredRequestIds: analysisRecord.requests.map((request) => request.id), expectedClaimCount: analysisRecord.requests.length }, async (value) => {
        value.claims = list(value.claims).filter((claim) => claim && typeof claim === 'object')
        const issues = validateAnalysisSources(value, analysisRecord, new Set(references.map((ref) => ref.id)))
        value.claims = [...list(value.claims), ...unaffected].sort((a, b) => record.requests.findIndex((request) => request.id === a.requestId) - record.requests.findIndex((request) => request.id === b.requestId))
        issues.push(...validateAnalysisSources(value, record, new Set(references.map((ref) => ref.id))), ...calculationIssues(value.calculations), ...inlineArithmeticIssues(value))
        if (str(value.defenseDraft)) issues.push('分析阶段不得生成整份文书')
        for (const claim of list(value.claims)) claim.riskLevel = level(claim.riskLevel)
        value.overallRisk = list(value.riskBasis).length ? level(value.overallRisk) : 'unknown'
        validateDates(value, sources.map((source) => source.text).join('\n'))
        issues.push(...arbitrationResultIssues(normalizeArbitrationResult(value), { action: 'analyze' }))
        if (issues.length) return issues
        return review('analysis', value, record, null, references)
      })
    analysis = validateLegalBasis(analysis)
    analysis = { ...analysis, caseRecord: record, analysisVersion: record.version,
      analysisTaskId: taskId, retrievalSnapshot: references, defenseDraft: '' }
    await checkpoint('arbitration_validated_analysis', { result: analysis })
  }
  if (intent !== 'draft') return finish({ ...analysis, kind: 'analysis', answer: str(analysis.answer) || '已完成初步分析，可以补充信息或按需生成完整答辩意见。' })
  try {
    const parts = await runStage('arbitration_draft', '正在整理完整答辩草稿…', CASE_DRAFT_PROMPT,
      { message: userMessage, caseRecord: record, analysis, references }, async (value) => {
        if (str(value.requestsSummary)) value.requestsSummary = '以下为拟议企业答辩请求，待企业确认；所涉支付、和解等事实按材料陈述整理，尚待原始凭证核实。\n\n' + value.requestsSummary
        if (str(value.closing)) value.closing = '以下为待企业确认的结语；企业单方陈述不等同于已证明事实，所涉事实与金额待证据核实。\n\n' + value.closing
        const issues = validateDraftParts(value, record)
        issues.push(...calculationIssues(value.calculations), ...inlineArithmeticIssues(value))
        if (issues.length) return issues
        const draft = composeArbitrationDraft(value, record)
        validateDates({ defenseDraft: draft }, sources.map((source) => source.text).join('\n'))
        issues.push(...arbitrationResultIssues(normalizeArbitrationResult({ ...analysis, defenseDraft: draft }), { action: 'draft' }))
        if (issues.length) return issues
        return review('draft', value, record, analysis, references)
      })
    let defenseDraft = composeArbitrationDraft(parts, record)
    if (partial) defenseDraft = '> 部分材料未读全，本草稿仅依据已读取内容，提交前请核对完整申请书及原件。\n\n' + defenseDraft
    const lawNotes = [...new Set(list(analysis.claims).flatMap((claim) => list(claim.legalBasis).map((law) => `${law.name || '法规'}${law.article ? ` ${law.article}` : ''}：${law.note || '具体条文及适用性待核对。'}`)))]
    if (lawNotes.length) defenseDraft += '\n\n---\n\n**法规复核提示（提交前处理）**\n\n' + lawNotes.map((note) => `- ${note}`).join('\n')
    return finish({ ...analysis, kind: 'draft', answer: '已依据当前分析生成待复核草稿。', defenseDraft,
      draftBasis: { caseVersion: record.version, materialSignature: materialHash, analysisTaskId: analysis.analysisTaskId }, draftStatus: 'completed' })
  } catch (error) {
    ensureActive()
    if (!['arbitration_result_invalid', 'arbitration_output_truncated', 'arbitration_result_inconsistent'].includes(error.code)) throw error
    // A failed document must not take away a previously checked analysis.
    return finish({ ...analysis, kind: 'analysis', defenseDraft: '', draftStatus: 'failed',
      draftError: { code: error.code, message: error.message }, answer: '案件分析已保留，本次草稿未通过检查，可补充信息后再次生成。' })
  }
}
