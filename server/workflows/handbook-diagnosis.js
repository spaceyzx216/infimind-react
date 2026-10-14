import { MAX_MODEL_OUTPUT_TOKENS } from '../../src/utils/context-budget.js'
import { chatDetailed } from '../services/llm-client.js'
import { extractHandbookText, HANDBOOK_PARSER_VERSION } from '../services/handbook-materials.js'
import { TaskCancelledError } from './contract-review.js'
import { buildHandbookStructure, fingerprint, handbookTopics, locateHandbookQuote, retrieveHandbookRelations, rankHandbookChunks } from '../services/handbook-structure.js'
import { loadHandbookReferences, retrieveHandbookReferences } from '../services/handbook-references.js'
import { createHandbookRedactor } from '../services/handbook-redaction.js'
import { listLawsForBaseline, resolveLawStatus } from '../services/law-whitelist.js'
import { loadHandbookProvisions, matchHandbookProvision, retrieveHandbookProvisions, validateHandbookLegalChecks } from '../services/handbook-provisions.js'
import { CONTEXT_WINDOW_TOKENS, OUTPUT_RESERVE_TOKENS, CONTEXT_SAFETY_TOKENS, estimateTokens } from '../../src/utils/context-budget.js'
import { SCOPE_PROMPT, REVIEW_PROMPT, RELATION_PROMPT, FOLLOWUP_PROMPT, LEGAL_CHECK_PROMPT } from '../prompts/handbook-diagnosis.js'

export const HANDBOOK_PRODUCT = 'handbook-diagnosis'
const string = (value) => typeof value === 'string' ? value.trim() : ''
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []
const unique = (values) => [...new Set(values.filter(Boolean))]
const error = (message, code = 'handbook_output_invalid') => Object.assign(new Error(message), { code, retryable: false, unitRetryExhausted: true })

// A narrow factual guard, not a legal/reasoning judge: a non-conflict edit must
// not silently replace an already specified clock time. Explicit proposals in
// 待确认/待核实 placeholders remain proposals, and numeric wording is normalized.
function clockTimes(text) {
  const digits = '零一二三四五六七八九'
  const number = (value = '零') => {
    if (/^\d+$/.test(value)) return Number(value)
    value = value.replace(/两/g, '二')
    if (value.includes('十')) { const [left, right] = value.split('十'); return (left ? digits.indexOf(left) : 1) * 10 + (right ? digits.indexOf(right) : 0) }
    return Number([...value].map((digit) => digits.indexOf(digit)).join(''))
  }
  const pattern = /(?<period>上午|下午|晚上|早上|中午|凌晨)?(?:(?<hour>[零一二三四五六七八九十两\d]{1,3})(?:时|点)(?:(?<minute>[零一二三四五六七八九十两\d]{1,3})分)?(?<half>半)?|(?<colonhour>\d{1,2})[:：](?<colonminute>\d{2}))/g
  return new Set([...String(text).matchAll(pattern)].flatMap(({ groups }) => {
    let hour = number(groups.hour || groups.colonhour)
    const minute = groups.half ? 30 : number(groups.minute || groups.colonminute)
    if (hour > 24 || minute > 59) return []
    if (/下午|晚上/.test(groups.period || '') && hour < 12) hour += 12
    if (/凌晨|上午/.test(groups.period || '') && hour === 12) hour = 0
    return [`${hour}:${minute}`]
  }))
}

const PROCEDURE_CHECKLIST = [
  { id: 'discussion', title: '制定和修改程序', status: 'pending', description: '核对涉及员工切身利益的规则是否履行适用的讨论、协商程序。', materials: ['制度版本与修改记录', '讨论及协商记录'], note: '仅提供核对清单，未审查程序证据。' },
  { id: 'notice', title: '公示或告知', status: 'pending', description: '核对适用员工是否能够了解当前制度及其更新。', materials: ['发布或告知记录', '适用人员范围及版本对应关系'], note: '正文中的公示说明不等于实际完成告知。' },
  { id: 'receipt', title: '签收和执行留痕', status: 'pending', description: '核对实际知悉、培训与执行记录，及其与本次制度版本的对应关系。', materials: ['实际签收或知悉记录', '培训与执行记录'], note: '空白签收页不能证明已经签收；清单不认定签字是唯一告知方式。' }
]

export function normalizeHandbookFindings(raw, chunks, laws = [], provisions = []) {
  if (!Array.isArray(raw)) throw error('诊断单元未返回问题列表')
  const map = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  return raw.map((finding) => {
    if (!finding || !string(finding.title) || !string(finding.explanation)) throw error('诊断问题缺少标题或说明')
    const evidence = (Array.isArray(finding.evidence) ? finding.evidence : []).map((item) => {
      const chunk = map.get(item?.chunkId)
      const location = locateHandbookQuote(item?.quote, chunk)
      return { chunkId: string(item?.chunkId), quote: string(item?.quote), location }
    })
    const located = evidence.length > 0 && evidence.every((item) => item.location.status === 'found')
    const isConflict = finding.kind === 'conflict'
    const locations = evidence.filter((item) => item.location.status === 'found').map((item) => item.location.matches[0])
    const validConflict = !isConflict || locations.some((left, index) => locations.slice(index + 1).some((right) =>
      left.fileId !== right.fileId || left.endOffset <= right.startOffset || right.endOffset <= left.startOffset))
    const authorities = (Array.isArray(finding.authorities) ? finding.authorities : []).map((item) => {
      const name = string(item?.title).replace(/[《》\s]/g, '')
      const law = laws.find((candidate) => [candidate.title, ...(candidate.aliases || [])].some((title) => title.replace(/[《》\s]/g, '') === name))
      const provision = matchHandbookProvision(item, provisions)
      return { title: string(item?.title), article: string(item?.article), reason: string(item?.reason),
        recordStatus: law ? resolveLawStatus(law) : 'not_found', provisionStatus: 'unverified',
        sourceUrl: /^https?:\/\//.test(law?.sourceUrl || '') ? law.sourceUrl : '',
        ...provision, supportStatus: 'unverified',
        note: provision.provisionStatus === 'matched' ? '匹配到外部法条正文；引文支持关系与法律适用尚待复核。' : law ? '检索到法规记录；具体条文和适用性尚未核实。' : '法规记录未收录，需核实。' }
    })
    const needsLegalVerification = authorities.length > 0
    const needsSourceVerification = evidence.some((item) => map.get(item.chunkId)?.sourceNeedsVerification || /OCR识别待核对/.test(map.get(item.chunkId)?.text || ''))
    const sourceTimes = clockTimes(evidence.map((item) => item.quote).join('\n'))
    const draftTimes = clockTimes(string(finding.suggestedClause).replace(/【(?:待确认|待核实)[^】]*】/g, ''))
    const changedTime = !isConflict && sourceTimes.size > 0 && [...draftTimes].some((time) => !sourceTimes.has(time))
    const identity = { kind: isConflict ? 'conflict' : 'clause', topic: string(finding.topic) || '制度内容', title: string(finding.title),
      evidence: evidence.map((item) => [item.chunkId, item.quote.replace(/\s/g, '')]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
    return { id: `finding:${fingerprint(identity).slice(0, 20)}`, kind: identity.kind, topic: identity.topic || '制度内容',
      title: string(finding.title), level: ['high', 'medium', 'low'].includes(finding.level) ? finding.level : 'medium',
      status: !located || !validConflict || !isConflict || needsLegalVerification || needsSourceVerification || finding.status === 'pending' ? 'pending' : 'risk',
      explanation: string(finding.explanation), conditions: strings(finding.conditions), evidence, authorities,
      locationStatus: located && validConflict ? 'found' : 'unverified',
      recommendation: string(finding.recommendation), suggestedClause: located && validConflict && !changedTime ? string(finding.suggestedClause) : '',
      relatedChanges: strings(finding.relatedChanges), supersedesFindingIds: strings(finding.supersedesFindingIds),
      verificationNote: !located || !validConflict ? '原文引用未唯一核对成功，暂不发布为已定位问题或修订条款。' : changedTime ? '修订稿未经确认改变了引文中的时点，暂不提供该示例条款；判断及法律依据仍待复核。' : needsSourceVerification ? '引文仅在OCR识别文字中定位，需对照图片原件核对；法律依据和执行条件仍待复核。' : needsLegalVerification || !isConflict ? '条款判断及执行条件待复核；具体法律依据尚未核实。' : '' }
  })
}

export function mergeHandbookFindings(existing, incoming, allowedReplacements = []) {
  const result = new Map(existing.map((item) => [item.id, item]))
  const allowed = new Set(allowedReplacements)
  const sources = (finding) => unique(finding.evidence.map((item) => item.chunkId)).sort().join('\n')
  const preservesLocatedEvidence = (previous, next) => previous.evidence.length > 0 && previous.evidence.every((old) =>
    old.location.status === 'found' && next.evidence.some((current) => current.chunkId === old.chunkId && current.location.status === 'found'
      && current.location.matches[0].startOffset <= old.location.matches[0].startOffset
      && current.location.matches[0].endOffset >= old.location.matches[0].endOffset))
  for (const { supersedesFindingIds = [], ...incomingItem } of incoming) {
    let item = incomingItem
    for (const id of supersedesFindingIds) {
      const replaced = result.get(id)
      if (!allowed.has(id) || !replaced || replaced.kind !== 'conflict' || item.kind !== 'conflict'
        || item.locationStatus !== 'found' || (sources(replaced) !== sources(item) && !preservesLocatedEvidence(replaced, item))) continue
      item = { ...item, conditions: unique([...replaced.conditions, ...item.conditions]),
        relatedChanges: unique([...replaced.relatedChanges, ...item.relatedChanges]),
        authorities: [...new Map([...replaced.authorities, ...item.authorities].map((authority) => [fingerprint(authority), authority])).values()],
        status: replaced.status === 'pending' || item.status === 'pending' ? 'pending' : 'risk' }
      result.delete(id)
    }
    const previous = result.get(item.id)
    result.set(item.id, previous ? { ...previous, conditions: unique([...previous.conditions, ...item.conditions]),
      relatedChanges: unique([...previous.relatedChanges, ...item.relatedChanges]),
      status: previous.status === 'pending' || item.status === 'pending' ? 'pending' : 'risk' } : item)
  }
  return [...result.values()]
}

function relationBatches(pairs, chunks) {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const batches = []
  let batch = { pairs: [], chunks: [] }
  for (const pair of pairs) {
    const candidates = [...new Map([...batch.chunks, ...pair.chunkIds.map((id) => byId.get(id))].map((chunk) => [chunk.id, chunk])).values()]
    if (batch.pairs.length && (estimateTokens(candidates.map((chunk) => chunk.text).join('\n')) > 30000 || batch.pairs.length >= 16)) {
      batches.push(batch); batch = { pairs: [], chunks: [] }
    }
    batch.pairs.push(pair)
    batch.chunks = [...new Map([...batch.chunks, ...pair.chunkIds.map((id) => byId.get(id))].map((chunk) => [chunk.id, chunk])).values()]
  }
  if (batch.pairs.length) batches.push(batch)
  return batches
}

// This deterministic fixture is exclusively used by TASK_FAKE_LLM engineering
// tests. Production classification and judgment use the shared model client.
export function fakeHandbookResponse(stage, payload) {
  if (stage === 'scope') {
    const text = payload.chunk.text
    const accepted = /(?:员工|劳动者|公司|用人单位).{0,30}(?:应当|应|须|不得|必须)|(?:旷工|迟到|早退|打卡|补正|年假|病假|工资|考勤|违纪|解除|培训|签收).{0,30}(?:日|天|次|元|处理|规定|制度|员工)/u.test(text)
    return { complete: true, type: accepted ? 'policy-fragment' : 'unrelated', acceptedEvidence: accepted ? text.trim() : '',
      summary: accepted ? '测试用制度正文' : '未发现可诊断的制度正文', completeness: 'unconfirmed', background: {}, questions: accepted ? ['适用地区及执行背景待核实。'] : [], relatedSections: [] }
  }
  if (stage === 'followup') return { complete: true, answer: '测试回复：请结合已定位原文核对适用条件；当前未核实程序证据或法律条文。', references: [], questions: [] }
  if (stage === 'legal-check') return { complete: true, checks: payload.checks.map((item) => ({ key: item.key, provisionId: item.provisionId, support: 'uncertain', quote: '', reason: '模型桩不判断法律支持关系。' })) }
  const findings = []
  if (stage === 'review' && /忘打卡/.test(payload.chunk.text)) findings.push({ kind: 'clause', topic: '考勤工时', title: '考勤异常的认定条件需明确', level: 'medium', status: 'pending',
    explanation: '需区分实际缺勤与记录异常，并核对补正流程。', conditions: ['实际出勤记录和补卡流程待核实。'],
    evidence: [{ chunkId: payload.chunk.id, quote: payload.chunk.text.trim() }], authorities: [], recommendation: '补充记录核实和补正步骤。',
    suggestedClause: '发生考勤记录异常时，先核对实际出勤情况，并按【待确认的补正流程】处理。', relatedChanges: [] })
  if (stage === 'relations') {
    for (const pair of payload.pairs) {
      const [left, right] = pair.chunkIds.map((id) => payload.chunks.find((chunk) => chunk.id === id))
      if (/迟到/.test(left.text) && /迟到/.test(right.text) && /(?:提醒|补正)/.test(left.text + right.text) && /(?:解除|开除)/.test(left.text + right.text)) findings.push({ kind: 'conflict', topic: '考勤与奖惩', title: '迟到处理规则前后需协调', level: 'medium', status: 'pending',
        explanation: '两处规定的处理方式不同，需要确认适用条件和先后关系。', conditions: ['核实两处规定是否适用于同一情形。'],
        evidence: [left, right].map((chunk) => ({ chunkId: chunk.id, quote: chunk.text.trim() })), authorities: [], recommendation: '明确条件并统一相关处理规则。', suggestedClause: '迟到处理按【统一的分级处理规则】执行，相关章节同步调整。', relatedChanges: [left.sectionTitle, right.sectionTitle] })
    }
  }
  return { complete: true, findings, questions: [], ...(stage === 'relations' ? { checkedRelationIds: payload.pairs.map((pair) => pair.id) } : {}) }
}

export async function runHandbookDiagnosis({ task = {}, input = {}, files = [], report: priorReport = null,
  emit = async () => {}, checkpoint = async () => {}, getCheckpoint = () => null,
  isCancellationRequested = () => false, updateFileParseStatus = () => {}, signal, fakeLlm = false,
  parseFile = extractHandbookText, generateCompletion = chatDetailed, referenceLoader = loadHandbookReferences,
  lawLoader = listLawsForBaseline, provisionLoader = loadHandbookProvisions, materialDocuments = [], chunkBudget } = {}) {
  const active = () => { if (signal?.aborted || isCancellationRequested()) throw new TaskCancelledError() }
  const saved = (stage) => getCheckpoint(stage)?.result
  let currentStage = 'parsing'
  const stage = async (name, label) => { active(); currentStage = name; await emit('stage.start', { stage: name, label, summary: label }) }
  await stage('parsing', '正在读取员工手册正文')
  let parsed = saved('handbook-parsing')
  if (input.action !== 'followup' && !(parsed?.parserVersion > 0 && parsed.parserVersion <= HANDBOOK_PARSER_VERSION)) parsed = null
  if (!parsed) {
    const documents = []
    const failures = []
    const warnings = []
    for (const file of files) {
      active()
      try {
        const shared = materialDocuments.find((document) => document.fileId === file.id)
        const result = shared ? { text: shared.text, pageCount: shared.pageCount, metadata: shared.parseMetadata } : await parseFile(file, { signal })
        active()
        if (!result.text?.trim()) throw error('未读取到正文', 'handbook_empty_document')
        const fileId = file.id || fingerprint(file.originalname + result.text).slice(0, 20)
        const unreadPages = result.metadata?.pages?.filter((page) => page.error || !page.text?.trim()) || []
        const unreadableParts = result.metadata?.unreadableParts || []
        documents.push({ fileId, fileName: file.originalname || '上传材料', text: result.text, pageCount: result.pageCount,
          pages: result.metadata?.pages?.map((page) => ({ page: page.page, method: page.method, error: Boolean(page.error), confidence: page.confidence })) || [],
          parseMetadata: { parserVersion: result.metadata?.parserVersion, completeness: result.metadata?.completeness,
            warnings: result.metadata?.warnings || [], ocrRegionCount: result.metadata?.ocrRegions?.length || 0,
            blocks: (result.metadata?.blocks || []).map(({ id, start, end, source }) => ({ id, start, end,
              source: Object.fromEntries(Object.entries(source || {}).filter(([key]) => ['page', 'slide', 'sheet', 'table', 'method'].includes(key))) })) },
          parseWarnings: result.metadata?.warnings || [] })
        if (unreadPages.length) failures.push({ fileId, fileName: file.originalname, reason: `第${unreadPages.map((page) => page.page).join('、')}页未读取成功` })
        for (const reason of unreadableParts) failures.push({ fileId, fileName: file.originalname, reason })
        warnings.push(...(result.metadata?.warnings || []))
        updateFileParseStatus(file.id, unreadPages.length || unreadableParts.length ? 'partial' : 'succeeded')
      } catch (cause) {
        active(); failures.push({ fileId: file.id, fileName: file.originalname, reason: cause.message }); updateFileParseStatus(file.id, 'failed')
      }
    }
    if (string(input.text)) documents.push({ fileId: 'submitted-text', fileName: '提交的制度正文', text: input.text, pageCount: null, pages: [] })
    parsed = { documents, failures, warnings: unique(warnings), parserVersion: HANDBOOK_PARSER_VERSION }
    await checkpoint('handbook-parsing', parsed)
  }
  let structure = buildHandbookStructure(parsed.documents, chunkBudget ? { budget: chunkBudget } : {})
  let references = { documents: [], versions: [], warnings: [] }
  let laws = []
  let legal = { configured: false, provisions: [], warnings: [] }
  const baseReport = { schemaVersion: 1, productId: HANDBOOK_PRODUCT, kind: 'diagnosis', analysisStatus: 'streaming',
    sourceTaskId: input.sourceTaskId || task.id || '', sourceDocuments: parsed.documents,
    scope: { kind: 'uncertain', description: '正在判断提交材料的范围；完整性尚未确认。', completeness: 'unconfirmed', background: {} },
    coverage: structure.chunks.map((chunk) => ({ chunkId: chunk.id, fileId: chunk.fileId, sectionTitle: chunk.sectionTitle, status: 'pending' })),
    findings: [], pendingQuestions: [], procedureChecklist: PROCEDURE_CHECKLIST, warnings: [...parsed.warnings], unreadableMaterials: parsed.failures,
    referenceVersions: [], relationCoverage: { total: 0, completed: 0 }, fake: fakeLlm }
  let result = baseReport
  let publishedSource = false
  const publish = async () => {
    active(); await checkpoint('handbook-report', { result })
    const completed = result.coverage.filter((item) => item.status === 'completed').map((item) => item.chunkId)
    await checkpoint('material-coverage', { parsed: result.coverage.length, indexed: [], entered: fakeLlm ? [] : completed,
      selected: completed, checked: completed, simulated: Boolean(fakeLlm), partial: result.analysisStatus !== 'completed' || parsed.failures.length > 0 })
    const { sourceDocuments, ...summary } = result
    await emit('handbook.snapshot', { stage: currentStage, result: publishedSource ? summary : { ...summary, sourceDocuments } })
    publishedSource = true
  }
  if (input.action !== 'followup') await publish()
  if (!structure.chunks.length || (parsed.failures.length && !input.allowPartial)) {
    result = { ...result, analysisStatus: 'blocked', scope: { ...result.scope, description: structure.chunks.length ? '部分材料未读取成功；请补传，或选择仅检查已读取部分。' : '未读取到可诊断正文，请更换材料。' } }
    await publish(); return result
  }
  if (input.action === 'followup') {
    if (!priorReport || priorReport.analysisStatus !== 'completed') throw error('原诊断报告未完成，不能依据它追问', 'handbook_report_unavailable')
  }
  try { references = await referenceLoader({ signal }) } catch (cause) { active(); references.warnings = ['员工手册参考资料读取失败，本轮未使用参考资料。']; await emit('stage.warning', { stage: 'knowledge', summary: '参考资料读取失败', message: cause.message }) }
  try { laws = await lawLoader({ includeRepealed: false }) } catch { laws = []; result.warnings.push('法规记录库不可用，相关依据需核实。') }
  try { legal = await provisionLoader({ signal }) } catch { active(); legal.warnings = ['员工手册法条正文清单读取失败，具体条文依据保持待核实。'] }
  result.warnings = unique([...result.warnings, ...(references.warnings || []), '自动解析可能丢失复杂表格或页内图片信息；本次检查以提取正文为范围。'])
  result.referenceVersions = references.versions || []
  result.warnings = unique([...result.warnings, ...(legal.warnings || [])])
  result.legalReferenceVersions = legal.provisions.map((p) => ({ id: p.provisionId, title: p.lawTitle, article: p.article, version: p.versionLabel, contentHash: p.contentHash, sourceUrl: p.sourceUrl, reviewStatus: p.reviewStatus }))
  const redactor = createHandbookRedactor({ documents: [...parsed.documents, ...(references.documents || [])], extraTexts: [input.focus || '', input.message || ''] })
  const signature = fingerprint({ documents: parsed.documents, focus: input.focus || '', versions: result.referenceVersions, legalVersions: result.legalReferenceVersions, workflow: 'handbook-diagnosis-v1' })
  const unit = async (key, prompt, payload, type) => {
    active()
    const message = JSON.stringify(redactor.maskDeep(payload))
    // Reuse requires the actual sent input to match, including redaction changes.
    const unitSignature = fingerprint([signature, prompt, message, type])
    const cached = saved(key)
    const ownsCurrentSource = (output) => Array.isArray(output?.findings) && output.findings.every((finding) =>
      Array.isArray(finding?.evidence) && finding.evidence.some((item) => item?.chunkId === payload.chunk?.id))
    if (cached?.signature === unitSignature && cached.output?.complete === true && (type !== 'review' || ownsCurrentSource(cached.output))) return cached.output
    if (estimateTokens(prompt + message) > CONTEXT_WINDOW_TOKENS - OUTPUT_RESERVE_TOKENS - CONTEXT_SAFETY_TOKENS) throw error('本检查单元超出模型输入预算，未截断正文', 'handbook_context_exceeded')
    await emit('model.progress', { stage: type, summary: type === 'scope' ? '正在确认材料与检查范围' : type === 'relations' ? '正在核对跨章节原文' : '正在检查制度条款' })
    const request = (instruction) => fakeLlm ? Promise.resolve({ content: JSON.stringify(fakeHandbookResponse(type, payload)), finishReason: 'stop' })
      : generateCompletion(instruction, message, { signal, maxAttempts: 1, responseFormat: { type: 'json_object' }, maxTokens: MAX_MODEL_OUTPUT_TOKENS,
        temperature: 0.1, thinking: { type: task.mode === 'thinking' && ['review', 'relations'].includes(type) ? 'enabled' : 'disabled' },
        reasoningEffort: 'low', requestTimeoutMs: task.mode === 'thinking' ? 240000 : 120000 })
    const decode = (response) => {
      active()
      if (response?.finishReason === 'length') throw error('模型输出达到长度限制，本单元尚未完成，已保留此前检查结果', 'handbook_output_truncated')
      try { return redactor.restoreDeep(JSON.parse(response.content)) } catch { throw error('模型未返回完整的诊断 JSON，已保留此前检查结果') }
    }
    let output = decode(await request(prompt))
    if (type === 'review' && Array.isArray(output?.findings) && output.findings.every((finding) => string(finding?.title) && string(finding?.explanation)) && !ownsCurrentSource(output) && !fakeLlm) {
      await emit('stage.warning', { stage: type, summary: '正在纠正条款引用归属，仅重试当前单元一次。' })
      output = decode(await request(`${prompt}\n引用归属需纠正：每项问题至少引用当前chunk ${payload.chunk.id} 的精确原文，不能只引用context；没有当前块问题应返回空findings。`))
    }
    if (output?.complete !== true) throw error('模型未确认检查单元完成，不能发布全文完成状态')
    if (['review', 'relations'].includes(type) && !Array.isArray(output.findings)) throw error('模型缺少诊断问题列表')
    if (['review', 'relations'].includes(type)) normalizeHandbookFindings(output.findings,
      type === 'review' ? [payload.chunk, ...payload.context] : payload.chunks, laws)
    if (type === 'review' && !ownsCurrentSource(output)) throw error('当前正文块缺少对应引用，尚未完成', 'handbook_review_source_invalid')
    if (type === 'relations') {
      const normalized = normalizeHandbookFindings(output.findings, payload.chunks, laws)
      const accounted = new Set(normalized.flatMap((finding) => [finding.id, ...finding.supersedesFindingIds]))
      if ((payload.findings || []).some((finding) => finding.kind === 'conflict' && !accounted.has(finding.id))) {
        throw error('关联归并遗漏已提供冲突的处置，尚未完成', 'handbook_merge_incomplete')
      }
      // Some models return explicit {pairId, checked:true} acknowledgements.
      // Accept that equivalent representation, never false/absent acknowledgements.
      output.checkedRelationIds = (Array.isArray(output.checkedRelationIds) ? output.checkedRelationIds : [])
        .map((item) => typeof item === 'string' ? item : item?.checked === true && typeof item.pairId === 'string' ? item.pairId : '')
        .filter(Boolean)
      if (payload.pairs.some((pair) => !output.checkedRelationIds.includes(pair.id))) throw error('跨章节关系尚未全部检查，已保留此前结果')
    }
    if (type === 'scope' && !['handbook', 'policy-fragment', 'attachment', 'unrelated', 'uncertain'].includes(output.type)) throw error('模型未返回可识别的材料类型')
    if (type === 'followup' && !string(output.answer)) throw error('追问没有完整回答')
    if (type === 'legal-check') validateHandbookLegalChecks(output, payload.checks, payload.provisions)
    await checkpoint(key, { signature: unitSignature, output })
    return output
  }
  if (input.action === 'followup') {
    await stage('followup', '正在结合本次原文回答追问')
    const topics = handbookTopicsForQuestion(input.message, structure.chunks)
    const answer = await unit('handbook-followup', FOLLOWUP_PROMPT, { message: input.message, report: { findings: priorReport.findings, scope: priorReport.scope }, chunks: topics }, 'followup')
    const citations = (Array.isArray(answer.references) ? answer.references : []).map((ref) => ({ ...ref, location: locateHandbookQuote(ref.quote, topics.find((chunk) => chunk.id === ref.chunkId)) }))
    return { schemaVersion: 1, productId: HANDBOOK_PRODUCT, kind: 'followup', analysisStatus: 'completed', sourceTaskId: input.sourceTaskId,
      answer: answer.answer, references: citations, pendingQuestions: strings(answer.questions), warnings: result.warnings, fake: fakeLlm }
  }
  await stage('scope', '正在识别制度正文和检查范围')
  let classifications = []
  const semanticHeadings = []
  const catalog = structure.sections.map((section) => ({ id: section.id, title: section.title, fileId: section.fileId }))
  for (const chunk of structure.chunks) {
    const classified = await unit(`handbook-scope:${fingerprint(chunk.id).slice(0, 20)}`, SCOPE_PROMPT, { chunk, sections: catalog }, 'scope')
    const evidence = locateHandbookQuote(classified.acceptedEvidence, chunk)
    for (const hint of Array.isArray(classified.suggestedHeadings) ? classified.suggestedHeadings : []) {
      if (!hint || string(hint.title) !== string(hint.quote)) continue
      const location = locateHandbookQuote(hint.quote, chunk)
      if (location.status !== 'found') continue
      const source = parsed.documents.find((doc) => doc.fileId === chunk.fileId)
      const offset = location.matches[0].startOffset
      const lineStart = source.text.lastIndexOf('\n', offset - 1) + 1
      semanticHeadings.push({ fileId: chunk.fileId, title: string(hint.title), startOffset: lineStart })
    }
    const background = Object.fromEntries(['region', 'people', 'version', 'effectiveDate'].map((key) => {
      const value = string(classified.background?.[key])
      return [key, value && chunk.text.replace(/\s/g, '').includes(value.replace(/\s/g, '')) ? value : '']
    }))
    classifications.push({ ...classified, background, chunkId: chunk.id, fileId: chunk.fileId,
      accepted: ['handbook', 'policy-fragment', 'attachment'].includes(classified.type) && evidence.status === 'found' })
  }
  const acceptedFiles = new Set(classifications.filter((item) => item.accepted).map((item) => item.fileId))
  const unsupported = parsed.documents.filter((document) => !acceptedFiles.has(document.fileId))
  result.pendingQuestions = unique(classifications.flatMap((item) => strings(item.questions)))
  result.scope = { kind: classifications.some((item) => item.accepted && item.type === 'handbook') ? 'handbook' : acceptedFiles.size ? 'fragment' : 'uncertain',
    description: acceptedFiles.size ? '检查本次提交的制度正文；未证明材料涵盖完整手册及所有附件。' : '未发现可核对的制度正文，请提交员工手册或具体制度条款。',
    completeness: 'unconfirmed', background: Object.fromEntries(['region', 'people', 'version', 'effectiveDate'].map((key) => [key, unique(classifications.filter((item) => item.accepted).map((item) => string(item.background?.[key]))).join('；')])) }
  if (unsupported.length) {
    result = { ...result, analysisStatus: 'blocked', unreadableMaterials: [...result.unreadableMaterials, ...unsupported.map((doc) => ({ fileId: doc.fileId, fileName: doc.fileName, reason: '未确认包含制度正文；请更换或移除该材料。' }))] }
    await publish(); return result
  }
  if (semanticHeadings.length) {
    const originalChunks = structure.chunks
    const originalClassifications = classifications
    structure = buildHandbookStructure(parsed.documents, { ...(chunkBudget ? { budget: chunkBudget } : {}), headings: semanticHeadings })
    classifications = structure.chunks.map((chunk) => {
      const original = originalChunks.find((item) => item.fileId === chunk.fileId && item.startOffset <= chunk.startOffset && item.endOffset > chunk.startOffset)
      return { ...originalClassifications.find((item) => item.chunkId === original?.id), chunkId: chunk.id, fileId: chunk.fileId }
    })
    result.coverage = structure.chunks.map((chunk) => ({ chunkId: chunk.id, fileId: chunk.fileId, sectionTitle: chunk.sectionTitle, status: 'pending' }))
  }
  const modelLinks = classifications.flatMap((item) => strings(item.relatedSections).flatMap((title) => structure.chunks.filter((chunk) => chunk.sectionTitle === title).map((chunk) => ({ from: item.chunkId, to: chunk.id }))))
  const pairs = retrieveHandbookRelations(structure.chunks, modelLinks)
  const batches = relationBatches(pairs, structure.chunks)
  result.relationCoverage.total = pairs.length
  await checkpoint('handbook-structure', { signature, sections: structure.sections, chunks: structure.chunks.map((chunk) => Object.fromEntries(Object.entries(chunk).filter(([key]) => key !== 'text'))), classifications })
  await publish()
  await stage('review', '正在逐章节检查制度条款')
  for (const chunk of structure.chunks) {
    const relatedChunks = pairs.filter((pair) => pair.chunkIds.includes(chunk.id)).flatMap((pair) => pair.chunkIds).filter((id) => id !== chunk.id)
    const relatedIds = new Set(relatedChunks)
    const context = rankHandbookChunks(chunk.text, structure.chunks.filter((item) => relatedIds.has(item.id))).slice(0, 2).map((item) => item.chunk)
    const output = await unit(`handbook-review:${fingerprint(chunk.id).slice(0, 20)}`, REVIEW_PROMPT, { chunk, context, globalIndex: classifications.map((item) => ({ chunkId: item.chunkId, summary: item.summary, background: item.background })),
      lawRecords: laws, lawProvisions: retrieveHandbookProvisions([chunk, ...context].map((c) => c.text).join('\n'), legal.provisions), referenceMaterials: retrieveHandbookReferences(chunk, references.documents || []), focus: input.focus || '' }, 'review')
    result.findings = mergeHandbookFindings(result.findings, normalizeHandbookFindings(output.findings, [chunk, ...context], laws, legal.provisions))
    result.pendingQuestions = unique([...result.pendingQuestions, ...strings(output.questions)])
    result.coverage = result.coverage.map((item) => item.chunkId === chunk.id ? { ...item, status: 'completed' } : item)
    await publish()
    await emit('stage.complete', { stage: 'review', summary: `已检查 ${result.coverage.filter((item) => item.status === 'completed').length}/${result.coverage.length} 个正文单元；全文关联核对尚未完成。` })
  }
  await stage('relations', '正在回看原文并核对跨章节关联')
  for (const batch of batches) {
    const output = await unit(`handbook-relations:${fingerprint(batch.pairs.map((pair) => pair.id)).slice(0, 20)}`, `${RELATION_PROMPT}\n当前单元提供关联候选 pairs。返回 checkedRelationIds:["实际pair.id",...] 字符串数组，逐项包含所有已核对的 pair.id；只有全部核对后才 complete:true。`,
      { ...batch, findings: result.findings.filter((finding) => finding.evidence.length && finding.evidence.every((item) => batch.chunks.some((chunk) => chunk.id === item.chunkId))), lawRecords: laws, lawProvisions: retrieveHandbookProvisions(batch.chunks.map((c) => c.text).join('\n'), legal.provisions) }, 'relations')
    const allowedReplacements = result.findings.filter((finding) => finding.evidence.every((item) => batch.chunks.some((chunk) => chunk.id === item.chunkId))).map((finding) => finding.id)
    result.findings = mergeHandbookFindings(result.findings, normalizeHandbookFindings(output.findings, batch.chunks, laws, legal.provisions), allowedReplacements)
    result.pendingQuestions = unique([...result.pendingQuestions, ...strings(output.questions)])
    result.relationCoverage.completed += batch.pairs.length
    await publish()
  }
  await stage('validation', '正在核对原文定位并汇总局部修订建议')
  if (result.coverage.some((item) => item.status !== 'completed') || result.relationCoverage.completed !== result.relationCoverage.total) throw error('检查覆盖尚未完成')
  const checks = result.findings.flatMap((finding) => finding.authorities.flatMap((authority, index) => authority.provisionStatus === 'matched'
    ? [{ key: `${finding.id}:${index}`, findingId: finding.id, provisionId: authority.provisionId, finding: { title: finding.title, explanation: finding.explanation,
      conditions: finding.conditions, evidence: finding.evidence, recommendation: finding.recommendation, suggestedClause: finding.suggestedClause, authorityReason: authority.reason } }] : []))
  // Each reference gets its own bounded review. Checkpoints include the full law
  // text/version and finding, so a changed manifest cannot reuse an old verdict.
  if (checks.length) await stage('legal-check', '正在核对法条引文与结论支持关系')
  for (const check of checks) {
    const entry = legal.provisions.find((p) => p.provisionId === check.provisionId)
    const provisions = legal.provisions.filter((p) => p.provisionId === entry.provisionId || entry.relatedProvisionIds.includes(p.provisionId))
    const output = await unit(`handbook-legal:${fingerprint(check.key).slice(0, 20)}`, LEGAL_CHECK_PROMPT, { checks: [check], provisions }, 'legal-check')
    const opinion = output.checks[0]
    const finding = result.findings.find((f) => f.id === check.findingId)
    const authority = finding.authorities[Number(check.key.slice(check.key.lastIndexOf(':') + 1))]
    Object.assign(authority, { quote: opinion.quote || authority.quote, quoteStatus: opinion.quote ? 'matched' : authority.quoteStatus,
      supportStatus: opinion.support === 'uncertain' ? 'uncertain' : `model_${opinion.support}`, supportReason: opinion.reason,
      note: '条号及引文与清单核对；支持关系为模型意见，法律适用仍待法务复核。' })
    if (opinion.support !== 'supported') {
      finding.suggestedClause = ''
      finding.verificationNote = '法条复核未确认当前改法有充分支持，暂不提供示例条款；请复核判断及适用条件。'
    }
    await publish()
  }
  result = { ...result, analysisStatus: 'completed', pendingQuestions: unique([...result.pendingQuestions,
    ...Object.entries(result.scope.background).filter(([, value]) => !value).map(([key]) => ({ region: '适用地区', people: '适用人员', version: '版本', effectiveDate: '生效日期' }[key] + '尚未确认。'))]) }
  await publish()
  await emit('stage.complete', { stage: 'validation', summary: `本次可读正文检查完成，共 ${result.findings.length} 项提示；法律判断及程序事实仍需复核。` })
  return result
}

export function handbookTopicsForQuestion(question, chunks) {
  const words = [...String(question || '').matchAll(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi)].flatMap((match) =>
    match[0].length > 2 ? [match[0], ...Array.from({ length: match[0].length - 1 }, (_, index) => match[0].slice(index, index + 2))] : [match[0]])
  const topics = handbookTopics(question)
  const score = (chunk) => words.reduce((sum, word) => sum + Number(chunk.text.includes(word)), 0) + chunk.topics.filter((topic) => topics.includes(topic)).length * 5
  return [...chunks].sort((a, b) => score(b) - score(a)).slice(0, 4)
}
