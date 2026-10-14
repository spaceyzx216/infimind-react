// Synthetic documents and injected providers only. No live model calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildReviewResult } from '../services/annotation-locator.js'
import { reduceLaborProgress } from '../../src/utils/labor-progress.js'
import { locateLaborContractQuote, createLaborContractAnalysisWorkflow } from '../workflows/labor-contract-analysis.js'
import { LABOR_CONTRACT_ANALYSIS_TOPICS, LABOR_CONTRACT_COMPLETENESS_ELEMENTS } from '../prompts/labor-contract-analysis.js'
import { auditLaborOccupationalResponsibilities, validateLaborRevisionCheck, auditLaborMonthlyDates, laborReadOnlyGroupIds, laborContractTermFacts, laborPhaseOptions, planLaborRevisionBatches, runLaborModelUnit, auditLaborRevisionDefaults, auditLaborRevisionPositions } from '../services/labor-analysis-units.js'
import { runContractDraft, classifyContractDraft, buildFakeDraft } from '../workflows/contract-draft.js'
import { buildRewriteUserMessage } from '../prompts/agent-3-rewrite.js'

const coverage = LABOR_CONTRACT_ANALYSIS_TOPICS.map(({ id, label }) => ({ id, topic: label, status: 'covered', summary: '合成测试覆盖' }))
const quote = (index) => createHash('sha256').update(`synthetic-clause-${index}`).digest('hex')
const finding = (index) => ({ topic: '薪酬', level: '中', title: `条款${quote(index).slice(0, 20)}`,
  location: `第${index + 1}条`, quote: quote(index), risk: `影响${quote(index)}`, advice: '补充明确执行安排' })
const page = (findings = [], roundComplete = true) => ({ contractInfo: {}, coverage, findings, roundComplete })
// 结构分析现在是 Markdown 流式输出，四个章节与逐项检查必须齐全。
const syntheticStructureReport = [
  '# 合同基础识别', '- 合同类型：劳动合同', '- 合同子类型：固定期限', '- 类型判定依据：合成依据',
  '- 交易角色与主体：', '  - 用人单位（甲方）：名称：合成公司', '- 合同目的与标的：合成标的',
  '- 已识别附件/引用文件：未识别到附件或引用文件',
  '', '# 条款结构图', '按原文顺序列出：', '- 第一条｜合成条款｜合成约定｜文本状态：完整',
  '', '# 要素完整性核查',
  ...LABOR_CONTRACT_COMPLETENESS_ELEMENTS.map((name) => `- ${name}：待确认（全文未提及）`),
  '', '# 文本一致性与待确认事项', '- 格式与编号：编号连续', '- 金额大小写：未发现异常', '- 日期：未发现异常',
  '- 主体称谓：未发现异常', '- 附件引用：未发现异常', '- 交叉条款冲突：未发现可直接指认的冲突。',
  '', '待确认事项（需用户补充的交易事实）：', '- 合成待确认事项。'
].join('\n')
const aux = ({ phase, userMessage }) => phase === 'assessment' ? { score: 80, conclusion: '合成测试结论', complete: true }
  : phase === 'quality' ? { decisions: JSON.parse(userMessage).candidates.map(({ candidateId }) => ({ candidateId, kind: 'risk', reason: '合成测试中保留独立缺陷' })), complete: true }
  : phase === 'dependencies' ? { independentIds: JSON.parse(userMessage).groups.map((group) => group.id), serialIds: [], complete: true }
    : phase === 'final-check' ? { conflicts: [], complete: true } : null
const rewrite = async ({ findings }) => JSON.stringify({ revisions: findings.map(({ id }) => ({ findingId: id,
  action: 'modify', rewrittenText: '双方明确本条执行程序。', riskNote: '补充执行安排' })) })
function harness({ review, rewriteFn = rewrite, consolidateFn = async () => '', count = 70, dependency, check, quality, requestSpy }) {
  const saved = new Map()
  const events = []
  const documents = [{ fileName: '合成测试.txt', text: Array.from({ length: count }, (_, index) => `第${index + 1}条\n${quote(index)}`).join('\n') }]
  const workflow = createLaborContractAnalysisWorkflow({ retrieveEvidence: async () => [], getLawCatalog: async () => [],
    consolidate: consolidateFn, rewrite: rewriteFn,
    streamGenerate: async function* (request) {
      requestSpy?.(request)
      if (request.phase === 'structure') { yield { content: syntheticStructureReport, finishReason: 'stop' }; return }
      const value = request.phase === 'dependencies' && dependency ? dependency(request)
        : request.phase === 'final-check' && check ? check(request) : request.phase === 'quality' && quality ? quality(request) : aux(request)
      if (value) { yield { content: JSON.stringify(value), finishReason: 'stop' }; return }
      yield* review(request, saved)
    }
  })
  const args = { task: { id: 'synthetic-batch-test', mode: 'fast' }, input: { action: 'analyze' }, sourceDocuments: documents,
    checkpoint: async (stage, result) => saved.set(stage, { result }), getCheckpoint: (stage) => saved.get(stage),
    emit: async (event, data) => events.push({ event, data }) }
  return { workflow, args, saved, events }
}
const respond = (value) => ({ content: JSON.stringify(value), finishReason: 'stop' })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const excerptSource = '第三条 月工资8000元，每月15日支付。解除后工资应一次付清，经济补偿在交接后支付。'
assert.equal(locateLaborContractQuote('第三条 ……解除后工资应一次付清，经济补偿在交接后支付。', [{ text: excerptSource }]).matches[0].excerpt, excerptSource)
assert.equal(locateLaborContractQuote('第三条 ……解除后工资应一次付清，经济补偿在交接后支付。', [{ text: excerptSource + '\n' + excerptSource }]).status, 'ambiguous')
assert.equal(locateLaborContractQuote('第三条 ……解除后工资应一次付清，经济补偿在交接后支付。', [{ text: '第三条 月工资8000元。\n解除后工资应一次付清，经济补偿在交接后支付。' }]).status, 'not-found')
assert.equal(locateLaborContractQuote('第三条 ……解除后工资立即支付。', [{ text: excerptSource }]).status, 'not-found')
const mutableRevision = { findingId: 'main', rewrittenText: '派遣单位应依法处理现有劳动合同期限不足二年的问题。' }
const readOnlyRevision = { findingId: 'paired', rewrittenText: '劳动合同期限一年。' }
const readOnlyCheck = { complete: true, conflicts: [{ groupIds: ['main'], target: 'read_only', reason: '配套原文期限一年，应由派遣单位处理。' }] }
assert.deepEqual(validateLaborRevisionCheck(readOnlyCheck, [mutableRevision, readOnlyRevision], new Set(['paired'])).conflicts, [])
assert.equal(validateLaborRevisionCheck(readOnlyCheck, [mutableRevision]).reminders.length, 1)
assert.throws(() => validateLaborRevisionCheck({ complete: true, conflicts: [{ groupIds: ['main'], target: 'revision', quote: '劳动合同期限一年。', reason: '错误引用旧文' }] }, [mutableRevision]), /实际修订文字/)
assert.throws(() => validateLaborRevisionCheck({ complete: true, conflicts: [{ groupIds: ['paired'], target: 'revision', quote: '劳动合同期限一年。', reason: '擅改配套' }] }, [readOnlyRevision], new Set(['paired'])), /实际修订文字/)
assert.throws(() => validateLaborRevisionCheck({ complete: true, conflicts: [{ groupIds: ['unknown'], target: 'optional', reason: '未知组' }] }, [mutableRevision]), /标识/)
assert.equal(validateLaborRevisionCheck({ complete: true, conflicts: [{ groupIds: ['deleted'], target: 'revision', quote: '工资应按月支付', reason: '删除了必要支付义务' }] },
  [{ findingId: 'deleted', action: 'delete', originalText: '工资应按月支付', rewrittenText: '' }]).conflicts.length, 1, '删除操作以被删除文字作为核对依据')

const termFacts = (text) => laborContractTermFacts([{ fileName: '虚构劳动合同.txt', text }])
assert.deepEqual(termFacts('本合同期限为 2026 年 10 月 1 日至 2027 年 9 月 30 日。').map(({ calendarDays, reachesTwoCalendarYears }) => [calendarDays, reachesTwoCalendarYears]), [[365, false]])
assert.equal(termFacts('劳动合同期限：2026-10-01 至 2028-09-30')[0].reachesTwoCalendarYears, true)
assert.equal(termFacts('本劳动合同为固定期限，期限为2026年10月1日至2028年9月30日。')[0].calendarDays, 731)
assert.equal(termFacts('本合同期限为2024年2月29日至2026年2月27日')[0].reachesTwoCalendarYears, true)
assert.equal(termFacts('本合同期限为2026年2月30日至2028年2月28日').length, 0)
assert.equal(termFacts('签订日期2026年10月1日至2027年9月30日').length, 0)
assert.deepEqual([...laborReadOnlyGroupIds([{ id: 'main', lineStart: 1, lineEnd: 2 }, { id: 'paired', lineStart: 5, lineEnd: 6 }],
  [{ role: 'dispatch_agreement', text: 'a\nb' }, { role: 'dispatch_employment_contract', text: 'c\nd' }], ['dispatch_employment_contract'])], ['paired'])
assert.deepEqual([...laborReadOnlyGroupIds([{ id: 'main-last-clause', lineStart: 2, lineEnd: 2, clauseEnd: 6 }],
  [{ role: 'dispatch_agreement', text: 'a\nb' }, { role: 'dispatch_employment_contract', text: 'c\nd' }], ['dispatch_employment_contract'])], [], '修订所属材料由原文范围决定，不能被后续文件的标题影响')
const boundaryReview = buildReviewResult({ contractText: '=== 文件：主协议 ===\n第九条 争议处理\n向甲方住所地有管辖权的法院诉讼。\n=== 文件：配套合同 ===\n甲方名称\n第一条 合同期限',
  modelOutput: JSON.stringify({ findings: [{ id: 'boundary', level: '中', title: '争议处理', quote: '向甲方住所地有管辖权的法院诉讼。', risk: '异地成本', advice: '双方协商' }] }) })
assert.equal(boundaryReview.findings[0].clauseEnd, 2, '末条新增批注的范围不得越过文件边界')
assert.equal(auditLaborMonthlyDates([{ findingId: 'dates', action: 'modify', originalText: '每月3日前提交，甲方每月15日支付工资。', rewrittenText: '每月____日前提交，甲方按月支付工资。' }]).length, 1)
assert.equal(auditLaborMonthlyDates([{ findingId: 'dates', action: 'modify', originalText: '每月3日前提交，甲方每月15日支付工资。', rewrittenText: '每月3日前提交；甲方每月15日支付工资，数据争议不影响工资支付。' }]).length, 0)
const dispatchRoles = [{ role: 'dispatch_agreement', text: '甲方（劳务派遣单位）：合成派遣公司\n乙方（用工单位）：合成用工公司' }]
assert.equal(auditLaborOccupationalResponsibilities([{ findingId: 'health', rewrittenText: '甲方负责组织职业健康检查并承担费用。' }], dispatchRoles).length, 1)
assert.equal(auditLaborOccupationalResponsibilities([{ findingId: 'health', rewrittenText: '依法涉及职业病危害作业时，乙方履行法定义务，甲方协助组织职业健康检查。' }], dispatchRoles).length, 0)
assert.equal(auditLaborOccupationalResponsibilities([{ findingId: 'health', rewrittenText: '甲方负责组织职业健康检查。' }], [{ role: 'dispatch_agreement', text: '乙方（劳务派遣单位）：合成派遣公司\n甲方（用工单位）：合成用工公司' }]).length, 0, '不假定甲方必是派遣单位')
assert.equal(auditLaborOccupationalResponsibilities([{ findingId: 'health', rewrittenText: '甲方负责组织职业健康检查。' }], []).length, 0, '主体不明确时不猜角色')

assert.equal(auditLaborRevisionDefaults([{ findingId: 'test', rewrittenText: '工资在离职后____日（建议5～10日）支付。' }], '原文没有宽限期').length, 1)
assert.equal(auditLaborRevisionDefaults([{ findingId: 'test', rewrittenText: '工资依法及时足额支付；经济补偿在办结交接时支付。' }], '').length, 0)
assert.equal(auditLaborRevisionDefaults([{ findingId: 'test', rewrittenText: '沿用原文：双方建议15日结算。' }], '双方建议15日结算。').length, 0, '不误拦原文已有业务约定')

// Deep mode spends reasoning on structure analysis, risk review and the final legal/consistency check.
for (const stage of ['structure', 'review', 'assessment', 'consolidation', 'dependencies', 'rewrite', 'final-check']) {
  assert.equal(laborPhaseOptions('fast', stage).thinking.type, 'disabled')
  const expected = ['structure', 'review', 'final-check'].includes(stage) ? 'thinking' : 'fast'
  assert.equal(laborPhaseOptions('thinking', stage).mode, expected)
  assert.equal(laborPhaseOptions('thinking', stage).reasoningEffort, expected === 'thinking' ? 'low' : undefined)
}
const hybridPhases = new Set()
const hybrid = harness({ count: 2,
  requestSpy: ({ phase, mode, requestTimeoutMs }) => {
    hybridPhases.add(phase)
    const expected = ['structure', 'review', 'final-check'].includes(phase) ? 'thinking' : 'fast'
    assert.equal(mode, expected)
    assert.equal(requestTimeoutMs, expected === 'thinking' ? 240_000 : 120_000)
  },
  consolidateFn: async (_findings, _model, options) => { hybridPhases.add('consolidation'); assert.equal(options.thinking.type, 'disabled'); return '' },
  rewriteFn: async (input, onContent, model, options) => {
    hybridPhases.add('rewrite'); assert.equal(options.thinking.type, 'disabled'); assert.equal(options.requestTimeoutMs, 120_000)
    return rewrite(input)
  },
  review: async function* (request) { yield respond(page(/审查轮次：第 1/.test(request.userMessage) ? [finding(0), finding(1)] : [])) }
})
hybrid.args.task.mode = 'thinking'
await hybrid.workflow(hybrid.args)
assert.ok(['structure', 'review', 'assessment', 'consolidation', 'dependencies', 'rewrite', 'final-check'].every((stage) => hybridPhases.has(stage)))

// Candidate classification must retain independent defects and reminders, dedupe
// only against a retained earlier candidate, and resume completed batches.
let qualityFirstBatchCalls = 0
let qualityDisconnected = true
const qualityChecked = harness({ count: 8, review: async function* (request) {
  const firstRound = /审查轮次：第 1/.test(request.userMessage)
  const lastBatch = request.userMessage.includes(finding(5).title)
  yield respond(page(firstRound ? (lastBatch ? [finding(6), finding(7)] : Array.from({ length: 6 }, (_, i) => finding(i))) : [], !firstRound || lastBatch))
}, quality: (request) => {
  const batch = JSON.parse(request.userMessage).candidates
  if (batch[0].candidateId === 'candidate-1') qualityFirstBatchCalls += 1
  else if (qualityDisconnected) throw new Error('ECONNRESET')
  return { decisions: batch.map(({ candidateId }) => ({ candidateId,
    kind: candidateId === 'candidate-2' ? 'reminder' : candidateId === 'candidate-7' ? 'duplicate' : 'risk',
    reason: candidateId === 'candidate-2' ? '依法执行后的凭证核对提醒' : '合成测试的独立性判断',
    ...(candidateId === 'candidate-7' ? { duplicateOf: 'candidate-1' } : {}) })).reverse(), complete: true }
} })
await assert.rejects(qualityChecked.workflow(qualityChecked.args), (error) => error.unitRetryExhausted)
assert.equal(qualityChecked.saved.get('finding-quality').result.decisions.length, 6)
qualityDisconnected = false
const qualityResult = await qualityChecked.workflow(qualityChecked.args)
assert.equal(qualityFirstBatchCalls, 1, '恢复时不重做已完成核验批次')
assert.equal(qualityResult.findings.length, 6)
assert.equal(qualityResult.reviewRounds[0].newCount, 6)
assert.doesNotMatch(qualityResult.firstRoundReport, new RegExp(finding(1).title), '质量过滤移除第一轮中的执行提醒')
assert.doesNotMatch(qualityResult.firstRoundReport, new RegExp(finding(6).title), '质量过滤移除第一轮中的重复风险')
assert.match(qualityResult.firstRoundReport, new RegExp(finding(0).title), '独立第一轮问题继续保留')
assert.equal(qualityChecked.saved.get('review').result.firstRoundReport, qualityResult.firstRoundReport, '检查点保存过滤后的第一轮正文')
assert.equal(qualityChecked.events.filter(({ event }) => event === 'review.delta').at(-1).data.firstRoundReport,
  qualityResult.firstRoundReport, '最终质量核对只替换第一轮风险正文')
assert.ok(qualityResult.warnings.some((warning) => warning.includes('凭证核对提醒')))
assert.equal(qualityResult.sourceDocuments[0].text, qualityChecked.args.sourceDocuments[0].text)
const forwardDuplicate = harness({ count: 2, review: async function* (request) {
  yield respond(/审查轮次：第 [23]/.test(request.userMessage) ? page() : page([finding(0), finding(1)]))
}, quality: () => ({ complete: true, decisions: [
  { candidateId: 'candidate-1', kind: 'duplicate', duplicateOf: 'candidate-2', reason: '同批保留问题的同一缺陷' },
  { candidateId: 'candidate-2', kind: 'risk', reason: '保留实际缺陷' }
] }) })
const forwardDuplicateResult = await forwardDuplicate.workflow(forwardDuplicate.args)
assert.equal(forwardDuplicateResult.findings.length, 1, '同批指向后面的有效risk不因顺序失败')
// 被合并为重复项的问题必须留在报告里并说明理由，不能静默消失。
assert.match(forwardDuplicateResult.reviewReport, /# 完整性清单/)
assert.match(forwardDuplicateResult.reviewReport, /重复项已合并：/)
assert.match(forwardDuplicateResult.reviewReport, /同批保留问题的同一缺陷/)
assert.ok(forwardDuplicate.events.some(({ event, data }) => event === 'stage.progress'
  && typeof data.message === 'string' && data.message.includes('与其他问题属于同一缺陷已合并')), '必须提示合并了几条')
assert.ok(Array.isArray(forwardDuplicateResult.qualityNotes) && forwardDuplicateResult.qualityNotes.length)
const malformedQuality = harness({ count: 1, review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage) ? [finding(0)] : []))
}, quality: () => ({ decisions: [{ candidateId: 'candidate-1', kind: 'duplicate', duplicateOf: 'invented-id', reason: '错误去重目标' }], complete: true }) })
await assert.rejects(malformedQuality.workflow(malformedQuality.args), (error) => error.unitRetryExhausted)
assert.equal(malformedQuality.saved.get('finding-quality'), undefined, '不完整或不可信核验不保存为完成')

// Model aliases must not erase extracted facts; A/B labels alone do not prove roles.
const aliases = harness({ count: 1, review: async function* () {
  yield respond({ ...page(), contractInfo: { partyA: '未确定角色的主体', contractTerm: '2026-07-01至2028-06-30',
    probationPeriod: '2个月', workLocation: '未明确约定', signDate: '未填写' } })
} })
const aliasResult = await aliases.workflow(aliases.args)
assert.equal(aliasResult.contractInfo.term, '2026-07-01至2028-06-30')
assert.equal(aliasResult.contractInfo.probation, '2个月')
assert.equal(aliasResult.contractInfo.employer, '', '不按甲乙方标签猜测企业身份')
assert.equal(aliasResult.contractInfo.workLocation, '')
assert.equal(aliasResult.contractInfo.signedDate, '')

const unmatchedBeforeLocated = harness({ count: 2, review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage)
    ? [{ ...finding(0), quote: '不在已上传原文中的测试摘录' }, finding(1)] : []))
} })
const locatedAfterGap = await unmatchedBeforeLocated.workflow(unmatchedBeforeLocated.args)
assert.ok(locatedAfterGap.revisions.length > 0)
assert.deepEqual(locatedAfterGap.revisions.flatMap((revision) => revision.memberFindingIds), [locatedAfterGap.findings[1].id], '前序风险未定位时，后续批注仍引用原始风险 ID')

const abbreviatedQuote = harness({ count: 1, rewriteFn: async ({ findings }) => JSON.stringify({ revisions: findings.map(({ id }) => ({ findingId: id,
  action: 'modify', rewrittenText: excerptSource, riskNote: '保留原文日期，仅验证可信定位' })) }), review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage)
    ? [{ ...finding(0), quote: '第三条 ……解除后工资应一次付清，经济补偿在交接后支付。' }] : []))
} })
abbreviatedQuote.args.sourceDocuments = [{ fileName: '合成测试.txt', text: excerptSource }]
const abbreviatedResult = await abbreviatedQuote.workflow(abbreviatedQuote.args)
assert.equal(abbreviatedResult.findings[0].quote, excerptSource)
assert.equal(abbreviatedResult.revisions.length, 1, '省略引文恢复后仍经完整批注链路校验')

const repeatedQuote = harness({ count: 1, review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage)
    ? [{ ...finding(0), fileName: '合成测试.txt', quote: excerptSource }] : []))
} })
repeatedQuote.args.sourceDocuments = [{ fileName: '合成测试.txt', text: excerptSource + '\n' + excerptSource }]
const repeatedResult = await repeatedQuote.workflow(repeatedQuote.args)
assert.equal(repeatedResult.findings[0].location.status, 'ambiguous', '同文件多处相同摘录不能用文件名消除歧义')
assert.equal(repeatedResult.revisions.length, 0)

// More than 12 per round / 60 overall; full original survives, no duplicate IDs.
let reviewed = 0
const many = harness({ review: async function* (request) {
  const round = Number(request.userMessage.match(/审查轮次：第 (\d)/)[1])
  if (round > 1) { yield respond(page()); return }
  const next = Array.from({ length: Math.min(6, 70 - reviewed) }, (_, index) => finding(reviewed + index))
  reviewed += next.length
  yield respond(page(next, reviewed === 70))
} })
const complete = await many.workflow(many.args)
assert.equal(complete.findings.length, 70)
assert.equal(complete.revisions.reduce((sum, item) => sum + item.issueCount, 0), 70)
assert.equal(complete.sourceDocuments[0].text, many.args.sourceDocuments[0].text)
assert.equal(new Set(complete.revisions.map((item) => item.findingId)).size, complete.revisions.length)
assert.ok(many.events.filter(({ event, data }) => event === 'rewrite.result' && data.partial).length > 1)

// A complete object is checkpointed before a reset; retry prompt includes it,
// and does not replay it into the final output.
let resetCalls = 0
const reset = harness({ count: 2, review: async function* (request, saved) {
  const round = Number(request.userMessage.match(/审查轮次：第 (\d)/)[1])
  if (round > 1) { yield respond(page()); return }
  resetCalls += 1
  if (resetCalls === 1) {
    yield { content: `{"findings":[${JSON.stringify(finding(0))}],"coverage":` }
    assert.equal(saved.get('review-pages').result.payload.findings.length, 1)
    throw Object.assign(new Error('synthetic ECONNRESET'), { code: 'LLM_STREAM_READ_FAILED', retryable: true })
  }
  assert.ok(request.userMessage.includes(finding(0).title))
  yield respond(page([finding(1)]))
} })
assert.equal((await reset.workflow(reset.args)).findings.length, 2)
assert.equal(resetCalls, 2)

// A malformed sibling does not discard complete, valid risks from the same chunk.
let siblingCalls = 0
const sibling = harness({ count: 2, review: async function* (request, saved) {
  if (/审查轮次：第 [23]/.test(request.userMessage)) { yield respond(page()); return }
  siblingCalls += 1
  if (siblingCalls === 1) { yield respond(page([finding(0), { ...finding(1), advice: '' }])); return }
  assert.equal(saved.get('review-pages').result.payload.findings.length, 1)
  yield respond(page([finding(1)]))
} })
assert.equal((await sibling.workflow(sibling.args)).findings.length, 2)
assert.equal(siblingCalls, 2)

// A reset after the final content/usage chunk cannot undo a complete response.
const terminatedAfterStop = harness({ count: 1, review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage) ? [finding(0)] : []))
  throw Object.assign(new Error('synthetic reset after stop'), { retryable: true })
} })
assert.equal((await terminatedAfterStop.workflow(terminatedAfterStop.args)).findings.length, 1)

// All external phases use the same aliases; only the saved annotations restore
// real source identities. Dates, locations and wages remain analysis facts.
const privateCompany = '北辰合成测试有限公司'
const privatePhone = '13900001234'
const privateIdentity = '330106199001010015'
const privateValues = [privateCompany, privatePhone, privateIdentity]
const privacyPhases = new Set()
const assertMasked = (value) => {
  const serialized = JSON.stringify(value)
  for (const original of privateValues) assert.equal(serialized.includes(original), false)
}
const privacy = harness({ count: 2,
  requestSpy: (request) => { assertMasked(request.userMessage); privacyPhases.add(request.phase) },
  review: async function* (request) {
    yield respond(page(/审查轮次：第 1/.test(request.userMessage)
      ? [0, 1].map((index) => ({ ...finding(index), risk: '【单位A】执行安排不清晰' })) : []))
  },
  consolidateFn: async (findings) => { assertMasked(findings); privacyPhases.add('consolidation'); return '' },
  rewriteFn: async (input) => {
    assertMasked(input); privacyPhases.add('rewrite')
    assert.ok(input.contractText.includes('2026-10-01'))
    assert.ok(input.contractText.includes('杭州市'))
    assert.ok(input.contractText.includes('8000'))
    return JSON.stringify({ revisions: input.findings.map(({ id }) => ({ findingId: id, action: 'modify',
      rewrittenText: '【单位A】明确本条执行程序。', riskNote: '补充执行安排' })) })
  }
})
privacy.args.sourceDocuments[0].text = `甲方：${privateCompany}\n联系电话：${privatePhone}\n证件号码：${privateIdentity}\n日期：2026-10-01；地点：杭州市；工资：8000元\n${privacy.args.sourceDocuments[0].text}`
const privateResult = await privacy.workflow(privacy.args)
assert.ok(['review', 'assessment', 'consolidation', 'dependencies', 'rewrite', 'final-check'].every((phase) => privacyPhases.has(phase)))
assert.ok(privateResult.revisions.every((item) => item.rewrittenText.includes(privateCompany)))
assert.equal(privateResult.sourceDocuments[0].text, privacy.args.sourceDocuments[0].text)

// Missing marker is never success, even with valid JSON, and attempts stop at 3.
let markerCalls = 0
const marker = harness({ review: async function* () { markerCalls += 1; yield respond({ findings: [finding(0)], coverage }) } })
await assert.rejects(marker.workflow(marker.args), (error) => error.unitRetryExhausted && error.code === 'labor_analysis_unit_exhausted')
assert.equal(markerCalls, 3)
assert.equal(marker.saved.get('review-pages').result.payload.findings.length, 1)
assert.equal(marker.saved.has('analysis'), false)

// Repeated continuations switch to coverage audit, then end that content block explicitly.
// 对齐商业合同审查：无进展不再把整轮判失败，而是保留成果并如实标注未核对范围。
let noProgressCalls = 0
let auditSeen = false
const stagnant = harness({ review: async function* ({ userMessage }) {
  noProgressCalls += 1
  auditSeen ||= userMessage.includes('连续续写没有有效进展')
  yield respond(page([], false))
} })
const stagnantResult = await stagnant.workflow(stagnant.args)
assert.ok(auditSeen, '连续无进展时应先进入覆盖核对')
// 第 1 页首次写入 coverage 算一次进展，之后连续两页无进展才进入覆盖核对，再两页后收尾。
assert.equal(noProgressCalls, 5, '覆盖核对应有限收尾，不得无限续写')
assert.equal(stagnantResult.reviewComplete, false, '覆盖核对提前结束时必须标记未完整核对')
assert.ok(stagnantResult.warnings.some((warning) => warning.includes('覆盖核对')), '未核对范围必须写入警告')
assert.ok(stagnantResult.missingItems.some((item) => item.topic === '覆盖核对'), '未核对范围必须进入待确认事项')
assert.deepEqual(stagnant.saved.get('material-coverage').result.checked, [], '被强制收尾的内容块不能计为已核对')
assert.equal(stagnant.saved.get('material-coverage').result.partial, true)

// Paraphrasing a coverage summary is not effective progress; it ends the same way without failing.
let paraphraseCalls = 0
const paraphrase = harness({ review: async function* () {
  paraphraseCalls += 1
  yield respond({ ...page([], false), coverage: coverage.map((item) => ({ ...item, summary: `同一状态的不同措辞${paraphraseCalls}` })) })
} })
const paraphraseResult = await paraphrase.workflow(paraphrase.args)
assert.equal(paraphraseResult.reviewComplete, false, '仅改写覆盖说明不算进展，应标记未完整核对')
assert.equal(paraphraseCalls, 5)
assert.ok(paraphraseResult.warnings.some((warning) => warning.includes('覆盖核对')))

// 基础检查项本身没凑齐时也不能把失败点后移到 assertAllTopicChecks：
// 强制收尾要先把未确认主题按 unclear 补齐，再正常返回。
let shortCoverageCalls = 0
const shortCoverage = harness({ review: async function* () {
  shortCoverageCalls += 1
  yield respond({ ...page([], false), coverage: coverage.slice(0, 3) })
} })
const shortCoverageResult = await shortCoverage.workflow(shortCoverage.args)
assert.equal(shortCoverageCalls, 5)
assert.equal(shortCoverageResult.reviewComplete, false)
assert.equal(shortCoverageResult.topicChecks.length, LABOR_CONTRACT_ANALYSIS_TOPICS.length, '强制收尾后仍必须给出全部基础检查项')
const filledCoverage = shortCoverage.saved.get('review').result.generated.coverage
assert.equal(filledCoverage.length, LABOR_CONTRACT_ANALYSIS_TOPICS.length, '缺失主题必须补进已保存的覆盖记录')
assert.deepEqual(filledCoverage.filter((item) => item.status === 'unclear').map((item) => item.id),
  LABOR_CONTRACT_ANALYSIS_TOPICS.slice(3).map((topic) => topic.id), '未确认主题必须如实标记为 unclear')

// Worker refresh/resume retains complete pages; an explicit fatal error is not
// network retry. Resume reviews only remaining findings with a new provider turn.
let fatal = true
const resume = harness({ count: 2, review: async function* (request) {
  const round = Number(request.userMessage.match(/审查轮次：第 (\d)/)[1])
  if (round > 1) { yield respond(page()); return }
  if (fatal) {
    yield { content: `{"findings":[${JSON.stringify(finding(0))}]` }
    throw new Error('synthetic worker restart')
  }
  assert.ok(request.userMessage.includes(finding(0).title))
  yield respond(page([finding(1)]))
} })
await assert.rejects(resume.workflow(resume.args), /worker restart/)
fatal = false
assert.equal((await resume.workflow(resume.args)).findings.length, 2)

// Out of order parallel completion never overwrites the other checkpoint.
let active = 0
let maximum = 0
let returned = 0
const parallel = harness({ count: 9, review: async function* (request) {
  const round = Number(request.userMessage.match(/审查轮次：第 (\d)/)[1])
  if (round > 1) { yield respond(page()); return }
  const next = Array.from({ length: Math.min(6, 9 - returned) }, (_, index) => finding(returned + index))
  returned += next.length
  yield respond(page(next, returned === 9))
}, rewriteFn: async (input) => {
  active += 1; maximum = Math.max(maximum, active)
  await pause(input.findings[0].id === 'revision-group-1' ? 35 : 5)
  active -= 1
  return rewrite(input)
} })
const parallelResult = await parallel.workflow(parallel.args)
assert.equal(maximum, 2)
assert.equal(parallel.saved.get('rewrite-batches').result.revisions.length, 9)
assert.equal(parallelResult.revisions.length, 9)
assert.deepEqual(parallelResult.revisions.map((item) => item.findingId), Array.from({ length: 9 }, (_, index) => `revision-group-${index + 1}`))
// 逐批增量：partial 事件只带本批新增的 added，终态事件才带完整数组。
const partialRewrites = parallel.events.filter(({ event, data }) => event === 'rewrite.result' && data.partial)
const finalRewrite = parallel.events.filter(({ event, data }) => event === 'rewrite.result' && !data.partial).at(-1)
assert.ok(partialRewrites.length, '必须逐批推送修订增量')
assert.ok(partialRewrites.every(({ data }) => Array.isArray(data.added) && data.revisions === undefined),
  '逐批事件只带新增项，不能重发整个数组')
assert.ok(partialRewrites.every(({ data }) => data.added.length <= 9))
assert.ok(finalRewrite && Array.isArray(finalRewrite.data.revisions), '终态事件必须带完整修订数组')
assert.deepEqual(finalRewrite.data.revisions.map((item) => item.findingId), parallelResult.revisions.map((item) => item.findingId))
// 前端按 findingId 合并增量，结果必须与终态数组一致。
const merged = parallel.events.filter(({ event }) => event === 'rewrite.result')
  .reduce((report, { event, data }) => reduceLaborProgress(report, event, data), {}).revisions
assert.deepEqual(merged.map((item) => item.findingId), parallelResult.revisions.map((item) => item.findingId))

// Overlap, same anchor, known dependency and unknown location all use serial.
const groups = Array.from({ length: 9 }, (_, index) => ({ id: String(index), lineStart: index * 10, lineEnd: index * 10 }))
groups[8].lineStart = 0; groups[8].lineEnd = 0
const planned = planLaborRevisionBatches(groups, { independentIds: groups.map((item) => item.id), dependencies: [['1', '7']] })
assert.ok(planned.find((batch) => batch.groups.some(({ id }) => id === '0')).groups.some(({ id }) => id === '8'))
assert.ok(planned.find((batch) => batch.groups.some(({ id }) => id === '1')).groups.some(({ id }) => id === '7'))
assert.ok(planned.every((batch) => batch.groups.length <= 4))
assert.equal(planLaborRevisionBatches([{ id: 'unknown', lineStart: -1 }], { independentIds: ['unknown'] })[0].parallel, false)

// Connection reset downgrades remaining batches to serial, without redoing a
// concurrently finished batch.
let resetOnce = false
let downgraded = false
let serialViolation = false
active = 0; returned = 0
const counts = new Map()
const downgrade = harness({ count: 14, review: async function* (request) {
  if (/审查轮次：第 [23]/.test(request.userMessage)) { yield respond(page()); return }
  const next = Array.from({ length: Math.min(6, 14 - returned) }, (_, index) => finding(returned + index))
  returned += next.length; yield respond(page(next, returned === 14))
}, rewriteFn: async (input) => {
  const id = input.findings[0].id
  counts.set(id, (counts.get(id) || 0) + 1)
  if (id === 'revision-group-1' && !resetOnce) {
    resetOnce = true; await pause(20); downgraded = true
    throw Object.assign(new Error('synthetic ECONNRESET'), { code: 'LLM_STREAM_READ_FAILED', retryable: true })
  }
  active += 1
  if (downgraded && active > 1) serialViolation = true
  await pause(5); active -= 1
  return rewrite(input)
} })
await downgrade.workflow(downgrade.args)
assert.equal(downgrade.saved.get('rewrite-batches').result.serialOnly, true)
assert.equal(counts.get('revision-group-5'), 1)
assert.equal(serialViolation, false)

// Rate limiting also downgrades the remaining work, preserving completed groups.
let limited = false
let limitedReturned = 0
const rateLimited = harness({ count: 9, review: async function* (request) {
  if (/审查轮次：第 [23]/.test(request.userMessage)) { yield respond(page()); return }
  const next = Array.from({ length: Math.min(6, 9 - limitedReturned) }, (_, index) => finding(limitedReturned + index))
  limitedReturned += next.length; yield respond(page(next, limitedReturned === 9))
}, rewriteFn: async (input) => {
  if (!limited) { limited = true; throw Object.assign(new Error('synthetic 429'), { code: 'LLM_HTTP_429', retryable: true }) }
  return rewrite(input)
} })
assert.equal((await rateLimited.workflow(rateLimited.args)).revisions.length, 9)
assert.equal(rateLimited.saved.get('rewrite-batches').result.serialOnly, true)

// Cancellation during concurrent rewriting cannot save late provider responses.
const cancellation = new AbortController()
let cancellationReturned = 0
const cancelled = harness({ count: 8, review: async function* (request) {
  if (/审查轮次：第 [23]/.test(request.userMessage)) { yield respond(page()); return }
  const next = Array.from({ length: Math.min(6, 8 - cancellationReturned) }, (_, index) => finding(cancellationReturned + index))
  cancellationReturned += next.length; yield respond(page(next, cancellationReturned === 8))
}, rewriteFn: async (input) => {
  cancellation.abort()
  await pause(10)
  return rewrite(input)
} })
cancelled.args.signal = cancellation.signal
await assert.rejects(cancelled.workflow(cancelled.args), (error) => /cancel/i.test(error.code || error.name))
assert.equal(cancelled.saved.get('rewrite-batches').result.revisions.length, 0)
assert.equal(cancelled.saved.has('analysis'), false)
assert.equal(cancelled.events.some(({ event }) => event === 'analysis.result'), false)

// Position auditing rejects ambiguous/incorrect spans and overlapping edits.
const positioned = { findingId: 'a', action: 'modify', lineStart: 0, lineEnd: 0,
  localizedEdits: [{ targetQuote: 'abc', quoteSpans: [{ line: 0, start: 0, end: 3 }], operation: 'replace' }] }
assert.equal(auditLaborRevisionPositions([positioned], 'abcdef').length, 0)
assert.ok(auditLaborRevisionPositions([{ ...positioned, findingId: 'invalid', localizedEdits: [{ ...positioned.localizedEdits[0], targetQuote: 'wrong' }] }], 'abcdef').length)
assert.ok(auditLaborRevisionPositions([positioned, { ...positioned, findingId: 'b' }], 'abcdef').some(({ groupIds }) => groupIds.length === 2))

// Only conflicting groups are repaired; the original and other IDs survive.
let checkCalls = 0
let repairCalls = 0
const repair = harness({ count: 2, review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage) ? [finding(0), finding(1)] : []))
}, check: () => ({ complete: true, conflicts: checkCalls++ === 0 ? [{ groupIds: ['revision-group-1'], target: 'revision', quote: '双方明确本条执行程序。', reason: '合成冲突' }] : [] }),
rewriteFn: async (input) => {
  if (input.findings.some(({ repairInstructions }) => repairInstructions)) {
    repairCalls += 1
    assert.ok(buildRewriteUserMessage(input).includes('合成冲突'), '最终核对修复要求必须出现在实际发送给修订模型的正文中')
  }
  return rewrite(input)
} })
assert.equal((await repair.workflow(repair.args)).revisions.length, 2)
assert.equal(checkCalls, 2); assert.equal(repairCalls, 1)

// A repair can expose another defect; retry only that group within a fixed cap.
let cascadingChecks = 0
const repairedIds = []
const cascading = harness({ count: 2, review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage) ? [finding(0), finding(1)] : []))
}, check: () => ({ complete: true, conflicts: ++cascadingChecks < 3
  ? [{ groupIds: [`revision-group-${cascadingChecks}`], target: 'revision', quote: '双方明确本条执行程序。', reason: `修复要求${cascadingChecks}` }] : [] }),
rewriteFn: async (input) => {
  repairedIds.push(...input.findings.filter((group) => group.repairInstructions).map((group) => group.id))
  return rewrite(input)
} })
assert.equal((await cascading.workflow(cascading.args)).revisions.length, 2)
assert.equal(cascadingChecks, 3)
assert.deepEqual(repairedIds, ['revision-group-1', 'revision-group-2'])
let unresolvedChecks = 0
const unresolvedConflict = harness({ count: 1, review: async function* (request) {
  yield respond(page(/审查轮次：第 1/.test(request.userMessage) ? [finding(0)] : []))
}, check: () => {
  unresolvedChecks += 1
  return { complete: true, conflicts: [{ groupIds: ['revision-group-1'], target: 'revision', quote: '双方明确本条执行程序。', reason: '持续存在的合成冲突' }] }
} })
await assert.rejects(unresolvedConflict.workflow(unresolvedConflict.args), (error) => error.code === 'labor_revision_conflict')
assert.equal(unresolvedChecks, 3, '持续冲突不能无限修订')
assert.equal(unresolvedConflict.saved.get('rewrite-batches').result.revisions.length, 1, '失败仍保存已生成批注')
assert.equal(unresolvedConflict.saved.get('revision-final-check'), undefined, '未通过不能保存成功核对标记')

// Request deadline and cancellation have separate behavior; no late success.
let attempts = 0
await assert.rejects(runLaborModelUnit({ mode: 'fast', requestTimeoutMs: 15, ensureActive: () => {}, emit: async () => {},
  operation: async ({ signal }) => { attempts += 1; await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); throw new Error('request aborted') }
}), (error) => error.unitRetryExhausted)
assert.equal(attempts, 3)
const controller = new AbortController()
let cancelledCalls = 0
await assert.rejects(runLaborModelUnit({ mode: 'fast', signal: controller.signal, ensureActive: () => { if (controller.signal.aborted) throw new Error('cancelled') }, emit: async () => {},
  operation: async () => { cancelledCalls += 1; controller.abort(); throw Object.assign(new Error('ECONNRESET'), { retryable: true }) }
}), /cancelled/)
assert.equal(cancelledCalls, 1)

// Draft generation/classification receives the actual selected mode.
for (const mode of ['fast', 'thinking']) {
  let draftOptions
  await runContractDraft({ task: { id: `draft-${mode}`, productId: 'contract-draft', prompt: '起草保密协议', mode },
    input: { operation: 'create' }, classifyType: async () => (await classifyContractDraft({ instruction: '起草保密协议', mode,
      chatFn: async (_system, _message, options) => {
        assert.equal(options.thinking.type, mode === 'fast' ? 'disabled' : 'enabled')
        if (mode !== 'fast') assert.equal(options.reasoningEffort, 'low')
        return '{"type":"nda","confidence":"high"}'
      } })),
    streamFn: async function* (_system, _message, options) {
      draftOptions = options
      yield { content: buildFakeDraft({ instruction: '起草保密协议' }), finishReason: 'stop' }
    }
  })
  assert.equal(draftOptions.thinking.type, mode === 'fast' ? 'disabled' : 'enabled')
  assert.equal(draftOptions.requestTimeoutMs, mode === 'fast' ? 120000 : 240000)
  if (mode !== 'fast') assert.equal(draftOptions.reasoningEffort, 'low')
}
console.log('Labor batch fault regression passed: 70 findings, closed-object checkpoints, interrupted resume, strict markers, no-progress audit, 2-way out-of-order rewrites, overlap/dependencies, reset downgrade, selective conflict repair, deadlines, cancellation and draft thinking modes.')
