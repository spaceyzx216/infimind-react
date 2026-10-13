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
import { resolveLawStatus } from '../services/law-whitelist.js'
import { classifyLaborContractDocumentsWithLlm } from '../workflows/labor-contract-document-classifier.js'
import { chat, chatDetailed } from '../services/llm-client.js'
import { createLaborContractRedactor } from '../services/labor-contract-redaction.js'
import { createLaborContractAnalysisWorkflow as makeAnalysisWorkflow, createLaborContractFollowupWorkflow, locateLaborContractQuote, scoreLaborContractAnalysis } from '../workflows/labor-contract-analysis.js'
import { createLaborDispatchAnalysisWorkflow as makeDispatchWorkflow } from '../workflows/labor-dispatch-analysis.js'
import { materializeAllLaborContractCases } from '../fixtures/labor-contract-analysis/cases.js'
import { LABOR_CONTRACT_ANALYSIS_TOPICS } from '../prompts/labor-contract-analysis.js'
import { LABOR_DISPATCH_ANALYSIS_TOPICS, LABOR_DISPATCH_FOLLOWUP_SYSTEM_PROMPT, buildLaborDispatchFollowupMessage } from '../prompts/labor-dispatch-analysis.js'

const mockAuxiliary = ({ phase, userMessage }) => {
  if (phase === 'assessment') return { score: 94, conclusion: '建议核对试用期约定。', complete: true }
  if (phase === 'quality') return { decisions: JSON.parse(userMessage).candidates.map(({ candidateId }) => ({ candidateId, kind: 'risk', reason: '合成样例中的独立风险' })), complete: true }
  if (phase === 'dependencies') return { independentIds: [], serialIds: JSON.parse(userMessage).groups.map((group) => group.id), complete: true }
  if (phase === 'final-check') return { conflicts: [], complete: true }
  return null
}
const syntheticRewrite = async ({ findings }) => JSON.stringify({ revisions: findings.map((finding) => ({ findingId: finding.id,
  action: 'modify', rewrittenText: '双方依法明确本条事项及执行程序。', riskNote: '结合完整条款核对。' })) })
// All tests use synthetic contracts and model responses; never send fixtures to the live provider.
const createLaborContractAnalysisWorkflow = (options = {}) => makeAnalysisWorkflow({ ...options,
  rewrite: options.rewrite || syntheticRewrite,
  ...(options.generate ? { generate: async (request) => {
    const auxiliary = mockAuxiliary(request)
    if (auxiliary) return { content: JSON.stringify(auxiliary), finishReason: 'stop' }
    const value = await options.generate(request)
    return typeof value === 'string' ? { content: value, finishReason: 'stop' } : value
  } } : {}),
  ...(options.streamGenerate ? { streamGenerate: async function* (request) {
    const auxiliary = mockAuxiliary(request)
    if (auxiliary) { yield { content: JSON.stringify(auxiliary), finishReason: 'stop' }; return }
    yield* options.streamGenerate(request)
  } } : {})
})

const createLaborDispatchAnalysisWorkflow = (options = {}) => makeDispatchWorkflow({ ...options, consolidate: async () => '', rewrite: syntheticRewrite,
  generate: async (request) => {
    const auxiliary = mockAuxiliary(request)
    return auxiliary ? { content: JSON.stringify(auxiliary), finishReason: 'stop' } : options.generate(request)
  }
})

const fixtureCases = materializeAllLaborContractCases()
assert.equal(fixtureCases.length, 10)
assert.deepEqual(fixtureCases.map((item) => item.id), Array.from({ length: 10 }, (_, index) => `LC-${String(index).padStart(2, '0')}`))
assert.ok(fixtureCases.every((item) => item.caseSet.goldStandard === false && item.caseSet.evaluated === false))
assert.ok(fixtureCases.every((item) => item.expectedChecks.every((check) => check.provisional === true)))
assert.ok(fixtureCases.find((item) => item.id === 'LC-07').analysisContext.region === null)
assert.equal(fixtureCases.find((item) => item.id === 'LC-09').retrievalIsolation.syntheticDecoy.contractType, '买卖合同')

const redactionInput = '甲方：华星人力资源有限公司\n乙方：张伟\n身份证号码：310101199001011234\n手机号：13812345678\n邮箱：zhangwei@example.test\n收款账号：6222021234567890123\n工作地点：上海市浦东新区，合同期限：2026年10月1日至2027年9月30日，月工资 8000 元。'
const redactor = createLaborContractRedactor({ documents: [{ fileName: '华星人力资源有限公司合同.txt', text: redactionInput }] })
const redactedInput = redactor.mask(redactionInput)
assert.doesNotMatch(redactedInput, /华星人力资源有限公司|张伟|310101199001011234|13812345678|zhangwei@example\.test|6222021234567890123/)
assert.match(redactedInput, /上海市浦东新区/)
assert.match(redactedInput, /2026年10月1日至2027年9月30日/)
assert.match(redactedInput, /月工资 8000 元/)
assert.equal(redactor.restore(redactedInput), redactionInput, '本机持有的映射可恢复原文用于报告显示和定位')
assert.deepEqual(redactor.restoreMetadataDeep({ employer: '单位A', employee: '个人A' }), { employer: '华星人力资源有限公司', employee: '张伟' }, '基本信息恢复唯一已知假名，不能让括号丢失泄漏到显示')
assert.equal(redactor.restore('单位A'), '单位A', '不得放宽原文摘录的精确恢复与定位规则')
const ambiguousRedactor = createLaborContractRedactor({ aliases: [
  { value: '合成主体一', token: '【单位A】', category: 'organization' },
  { value: '合成主体二', token: '【单位A】', category: 'organization' }
] })
assert.equal(ambiguousRedactor.restoreMetadataDeep('单位A'), '单位A', '不猜有歧义的主体别名')
assert.ok(redactor.maxTokenLength > 0)

const repeatedDocument = { fileId: 'source-1', fileName: '合同.txt', text: '第一条 工资约定\n月工资为 8000 元。\n第二条 工资约定\n月工资为 8000 元。' }
assert.equal(locateLaborContractQuote('月工资为 8000 元。', [repeatedDocument]).status, 'ambiguous')
assert.equal(locateLaborContractQuote('试用期为三个月', [repeatedDocument]).status, 'not-found')
assert.equal(locateLaborContractQuote('第一条 工资约定 月工资为 8000 元。', [repeatedDocument]).matches[0].lineStart, 1)

const database = createBusinessDatabase(':memory:')
const directory = mkdtempSync(join(tmpdir(), 'fafee-labor-contract-analysis-'))
const fileStore = createTaskFileStore({ root: directory })
const taskService = createTaskService(database)
for (const [userId, email] of [['user-a', 'labor-a@example.test'], ['user-b', 'labor-b@example.test']]) {
  const inviteId = `invite-${userId}`
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)').run(inviteId, `hash-${userId}`, new Date().toISOString())
  database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, userId, email, 'hash', 'salt', inviteId, new Date().toISOString())
}

const lawCatalog = [
  {
    title: '中华人民共和国劳动合同法', aliases: ['劳动合同法'], versionLabel: '2012年修正',
    effectiveFrom: '2013-07-01', status: 'effective', reviewStatus: 'verified',
    sourceUrl: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_0abfdd261c03417b949df19d869add8d.html'
  },
  {
    title: '中华人民共和国社会保险法', aliases: ['社会保险法'], effectiveFrom: '2011-07-01',
    status: 'effective', reviewStatus: 'pending', sourceUrl: 'https://example.test/pending-law'
  }
]
const evidenceSpy = []
const modelSpy = []
const dispatchEvidenceSpy = []
const dispatchModelSpy = []
const queuedModelResponses = []
const sampleModelOutput = {
  roundComplete: true,
  score: 94,
  conclusion: '建议核对试用期约定。',
  contractInfo: { employer: '海棠数字服务有限公司（虚构主体）', contractType: '劳动合同', workLocation: '上海市' },
  topicChecks: LABOR_CONTRACT_ANALYSIS_TOPICS.map(({ id, label }) => ({ id, topic: label, status: 'covered', summary: `${label}已在虚构文本中出现，仍需核验。` })),
  missingItems: [{ topic: '劳动者身份', item: '证件号码未提供', reason: '文本明确标注未提供。' }],
  findings: [{
    topic: '试用期', level: '中', title: '试用期约定需核对', explanation: '需结合期限与适用前提核验。',
    quote: '试用期为 3 个月', applicableConditions: ['合同期限为两年。'],
    authorities: [{ title: '劳动合同法', article: '第十九条' }, { title: '不存在的法规', article: '第1条' }],
    supportingEvidenceIds: ['labor-risk-1', 'commercial-decoy'],
    recommendation: '核对期限约定与适用前提。', suggestedClause: '双方依法协商确定试用期。'
  }],
  contextQuestions: ['请确认合同实际生效日期。'],
  lawCandidates: [{ title: '待核对的地方规定', reason: '需按实际工作地点核对。' }, { title: '劳动合同法', reason: '已收录法规不得重复列为线索。' }],
  analysisNotes: ['本分析输出为测试草案。']
}
const sampleDispatchModelOutput = {
  roundComplete: true,
  agreementInfo: {
    dispatchingUnit: '【单位A】', usingUnit: '【单位B】', workerCount: '2 人',
    positions: '包装岗位', workLocation: '上海市浦东新区', dispatchTerm: '2026年10月1日至2027年9月30日',
    wageArrangement: '派遣单位向劳动者支付工资', socialInsurance: '按约定办理社会保险',
    serviceFee: '用工单位按月支付服务费', reviewPerspectiveSummary: '从用工单位视角核对结算约定。'
  },
  topicChecks: LABOR_DISPATCH_ANALYSIS_TOPICS.map(({ id, label }) => ({ id, topic: label, status: 'covered', summary: `${label}有文本约定，仍需结合材料复核。` })),
  missingItems: [],
  findings: [{
    topic: '服务费用与结算', level: '中', title: '服务费用结算条款需要核对',
    explanation: '核对结算条件、周期和凭证是否明确。',
    quote: '用工单位按月向派遣单位支付服务费。', sourceRole: 'dispatch_agreement',
    applicableConditions: ['需结合完整派遣协议及实际对账安排。'],
    authorities: [{ title: '劳动合同法', article: '第五十九条' }],
    supportingEvidenceIds: ['dispatch-risk-1'],
    recommendation: '明确费用构成、对账材料和付款期限。', suggestedClause: '双方可另行明确每月对账及付款安排。'
  }],
  contextQuestions: ['请核对服务费计算口径和结算凭证。'],
  lawCandidates: [{ title: '当地派遣服务管理规定', reason: '需按实际经营地自行核对官方原文。' }],
  analysisNotes: ['派遣专项主题仍待 Mentor / 法务复核。']
}

assert.equal(scoreLaborContractAnalysis([
  { id: 'term', topic: '合同期限', status: 'covered' },
  { id: 'probation', topic: '试用期', status: 'missing' },
  { id: 'compensation', topic: '薪酬', status: 'unclear' },
  { id: 'non-compete', topic: '竞业', status: 'not_applicable' }
]).value, 50)

const analysisWorkflow = createLaborContractAnalysisWorkflow({
  consolidate: async () => '', rewrite: syntheticRewrite,
  parseFile: async (file) => ({ text: file.buffer.toString('utf8') }),
  retrieveEvidence: async (plan, options) => {
    evidenceSpy.push({ plan, options })
    return [
      { evidenceId: 'labor-risk-1', contractType: '劳动合同', kind: 'risk_rule', title: '试用期风险规则', sourceName: '虚构劳动合同风险规则', text: '试用期触发条件参考。', referenceRole: 'annotated_case', topicLabels: ['试用期'] },
      { evidenceId: 'commercial-decoy', contractType: '买卖合同', kind: 'clause', title: '商业违约条款诱饵', sourceName: '虚构商业合同', text: '不得进入劳动分析。' },
      { evidenceId: 'labor-qa-decoy', contractType: '劳动合同', kind: 'labor_qa', title: '用工咨询问答', sourceName: '用工问答诱饵', text: '不属于合同分析资料。' }
    ]
  },
  getLawCatalog: async () => lawCatalog,
  resolveStatus: (law) => resolveLawStatus(law, new Date('2026-09-26T00:00:00+08:00')),
  generate: async (request) => {
    modelSpy.push(request)
    if (queuedModelResponses.length) return queuedModelResponses.shift()
    return JSON.stringify(sampleModelOutput)
  }
})

const dispatchAnalysisWorkflow = createLaborDispatchAnalysisWorkflow({
  parseFile: async (file) => ({ text: file.buffer.toString('utf8') }),
  retrieveEvidence: async (plan, options) => {
    dispatchEvidenceSpy.push({ plan, options })
    return [
      { evidenceId: 'dispatch-risk-1', contractType: '劳务派遣协议', kind: 'risk_rule', title: '派遣协议结算提示', sourceName: '虚构派遣协议规则', text: '明确服务费构成、结算周期和付款凭证。', topicLabels: ['服务费用与结算'] },
      { evidenceId: 'ordinary-labor-decoy', contractType: '劳动合同', kind: 'clause', title: '普通劳动合同模板诱饵', text: '不应进入派遣协议资料。' },
      { evidenceId: 'commercial-dispatch-decoy', contractType: '买卖合同', kind: 'clause', title: '商业合同诱饵', text: '不得跨类型使用。' },
      { evidenceId: 'dispatch-qa-decoy', contractType: '劳务派遣协议', kind: 'labor_qa', title: '用工咨询问答诱饵', text: '不作为合同范本或风险规则。' }
    ]
  },
  getLawCatalog: async () => lawCatalog,
  resolveStatus: (law) => resolveLawStatus(law, new Date('2026-09-26T00:00:00+08:00')),
  generate: async (request) => {
    dispatchModelSpy.push(request)
    return { content: JSON.stringify(sampleDispatchModelOutput), finishReason: 'stop' }
  }
})

let reviewWorkflowCalls = 0
const processor = createTaskProcessor({
  taskService,
  fileStore,
  laborContractAnalysisWorkflow: analysisWorkflow,
  laborContractFollowupWorkflow: createLaborContractFollowupWorkflow({
    generate: async (message) => ({ content: message.includes('原文已过可追问期限') ? '请重新上传合同以核对新问题。' : '根据原文与旧报告，试用期条款需要复核。', finishReason: 'stop' })
  }),
  laborDispatchAnalysisWorkflow: dispatchAnalysisWorkflow,
  laborDispatchFollowupWorkflow: createLaborContractFollowupWorkflow({
    systemPrompt: LABOR_DISPATCH_FOLLOWUP_SYSTEM_PROMPT,
    messageBuilder: buildLaborDispatchFollowupMessage,
    expiredSourceMessage: '派遣协议原文已过期，请重新上传。',
    generate: async (message) => {
      dispatchModelSpy.push({ userMessage: message, followup: true })
      return { content: '【单位B】应核对与【个人A】的工资支付安排。', finishReason: 'stop' }
    }
  }),
  reviewWorkflow: async () => { reviewWorkflowCalls += 1; throw new Error('劳动合同分析不可走商业合同工作流') }
})
const queue = createTaskQueue({ taskService, processTask: processor.processTask, mode: 'local', workerEnabled: true, pollIntervalMs: 25 })
const app = express()
app.use(express.json())
app.use((req, _res, next) => { req.user = { id: req.get('X-Test-User') || 'user-a' }; next() })
const classificationCalls = []
app.use('/api', createTaskRouter({ taskService, taskQueue: queue, fileStore, fakeLlm: false,
  classifyDocuments: async (options) => {
    classificationCalls.push(options)
    return options.documents.map(() => ({ suggestedType: 'unsupported', confidence: 'low', reason: '合成分类桩' }))
  }
}))
const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
const baseUrl = `http://127.0.0.1:${server.address().port}`
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.headers || {}) } })
const waitFor = async (check, timeoutMs = 5000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待劳动合同分析任务状态超时')
}
const createSyntheticTask = async (filename = '虚构劳动合同-重试测试.txt') => {
  const body = new FormData()
  body.append('files', new Blob(['第一条 合同期限：两年。\n第二条 工作地点：待双方确认。'], { type: 'text/plain' }), filename)
  const response = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body })
  assert.equal(response.status, 202)
  return response.json()
}
const waitForTerminalTask = async (taskId) => waitFor(async () => {
  const response = await request(`/api/tasks/${taskId}`)
  const payload = await response.json()
  return ['succeeded', 'failed'].includes(payload.task?.status) ? payload.task : null
})

async function testDetailedLlmResponse() {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const detailed = await chatDetailed('输出 JSON', '合成测试', {
      maxTokens: 128,
      thinking: { type: 'disabled' },
      responseFormat: { type: 'json_object' }
    })
    assert.deepEqual(detailed, {
      content: '{"ok":true}',
      finishReason: 'length',
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      empty: false
    })
    assert.deepEqual(requests[0].response_format, { type: 'json_object' })
    assert.equal(await chat('普通调用', '合成测试', { thinking: { type: 'disabled' } }), '{"ok":true}')
    assert.equal('response_format' in requests[1], false, '既有 chat 调用默认仍使用文本模式')
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testLongDocumentTraversal() {
  const checkpoints = new Map(), submitted = []
  const tail = '末尾工资支付日为每月十五日。'
  const documents = [{ fileId: 'long-source', fileName: '虚构长劳动合同.txt', text: '普通条款仅供模型桩验证。\n'.repeat(900) + tail }]
  const workflow = createLaborContractAnalysisWorkflow({ retrieveEvidence: async () => [], getLawCatalog: async () => [],
    generate: async ({ userMessage }) => { submitted.push(userMessage); return JSON.stringify({ ...sampleModelOutput, findings: [] }) } })
  await workflow({ task: { id: 'long-traversal', mode: 'fast' }, input: { action: 'analyze' }, sourceDocuments: documents,
    checkpoint: async (key, result) => checkpoints.set(key, { result }), getCheckpoint: (key) => checkpoints.get(key) })
  assert.ok(submitted.length > 1, '长合同分块进入实际模型调用入口')
  assert.ok(submitted.some((body) => body.includes(tail)), '后半部分条款必须进入模型')
  const coverage = checkpoints.get('material-coverage').result
  assert.equal(coverage.checked.length, coverage.parsed)
  assert.ok(coverage.checked.length > 1)
}

async function testReviewResumeAndMode() {
  const saved = new Map()
  const rounds = []
  const events = []
  const options = []
  const rewriteSizes = []
  let interrupted = false
  const documents = [{ fileId: 'resume-file', fileName: '合成合同.txt', text: '月工资为8000元。\n每周工作六天。' }]
  const workflow = createLaborContractAnalysisWorkflow({
    retrieveEvidence: async () => [], getLawCatalog: async () => [],
    generate: async ({ userMessage }) => {
      const round = Number(userMessage.match(/审查轮次：第 (\d)/)[1])
      rounds.push(round)
      if (round === 2 && !interrupted) { interrupted = true; throw new Error('ECONNRESET synthetic interruption') }
      return JSON.stringify({ ...sampleModelOutput, findings: round === 3 ? [] : [{
        level: '中', topic: round === 1 ? '薪酬' : '工时',
        title: round === 1 ? '工资支付日未约定' : '每周休息安排需要核对',
        quote: round === 1 ? '月工资为8000元。' : '每周工作六天。',
        risk: round === 1 ? '工资支付日期不明' : '每周工时与休息缺少清晰安排',
        advice: round === 1 ? '约定每月付款日' : '核对休息和加班安排'
      }] })
    },
    consolidate: async (_findings, _model, completion) => { options.push(completion); return '' },
    rewrite: async (input, _onChunk, _model, completion) => {
      options.push(completion)
      rewriteSizes.push(input.findings.length)
      if (input.findings.length > 1) throw Object.assign(new Error('synthetic rewrite length limit'), { code: 'rewrite_output_truncated' })
      return syntheticRewrite(input)
    }
  })
  const args = {
    task: { id: 'resume', mode: 'fast' }, input: { action: 'analyze' }, sourceDocuments: documents,
    checkpoint: async (stage, result) => saved.set(stage, { result }),
    getCheckpoint: (stage) => saved.get(stage), emit: async (event, data) => events.push({ event, data })
  }
  const result = await workflow(args)
  const completedRoundCalls = rounds.length
  await workflow(args)
  assert.equal(rounds.length, completedRoundCalls, '已完成轮次恢复不重复请求')
  assert.deepEqual(rounds, [1, 2, 2, 3], '自动恢复从未完成的第二轮继续，不跳过复审')
  assert.deepEqual(result.reviewRounds.map((item) => item.round), [1, 2, 3])
  assert.equal(result.findings.length, 2)
  assert.ok(result.revisions.length, '重用商业合同定位和局部修订组件所需数据')
  assert.deepEqual(rewriteSizes, [2, 1, 1], '修订输出截断时继续拆小批次，不丢弃其他问题')
  assert.equal(result.sourceDocuments[0].text, documents[0].text)
  assert.ok(options.every((option) => option.thinking.type === 'disabled'), '关闭深度思考时归并/修订也不开 thinking')
  assert.ok(events.some((event) => event.event === 'stage.progress' && event.data.message?.includes('自动重试')))
  const fastOptionCount = options.length
  await workflow({ ...args, task: { id: 'deep-mode', mode: 'thinking' }, getCheckpoint: () => null, checkpoint: async () => {} })
  assert.ok(options.slice(fastOptionCount).every((option) => option.thinking.type === 'disabled'), '深度模式的归并/修订关闭 thinking，思考预算留给风险审查和最终复核')
}

async function testStreamedAnalysisEvents() {
  const emitted = []
  let modelCalls = 0
  let streamedRaw = ''
  const workflow = createLaborContractAnalysisWorkflow({
  consolidate: async () => '', rewrite: syntheticRewrite,
    parseFile: async (file) => ({ text: file.buffer.toString('utf8') }),
    retrieveEvidence: async () => [{ evidenceId: 'labor-risk-1', contractType: '劳动合同', kind: 'risk_rule', title: '试用期规则' }],
    getLawCatalog: async () => lawCatalog,
    resolveStatus: (law) => resolveLawStatus(law, new Date('2026-09-26T00:00:00+08:00')),
    streamGenerate: async function* () {
      modelCalls += 1
      const content = JSON.stringify(sampleModelOutput)
      streamedRaw = ''
      for (let offset = 0; offset < content.length; offset += 43) {
        streamedRaw += content.slice(offset, offset + 43)
        yield { content: content.slice(offset, offset + 43), finishReason: null }
      }
      yield { content: '', finishReason: 'stop' }
    }
  })
  const result = await workflow({
    task: { id: 'stream-analysis', mode: 'thinking', prompt: '' },
    input: { action: 'analyze' },
    files: [{ id: 'stream-file', originalname: '虚构劳动合同.txt', buffer: Buffer.from('第一条 合同期限：两年。\n第二条 试用期为 3 个月。') }],
    emit: async (event, data) => emitted.push({ event, data, raw: streamedRaw }),
    checkpoint: async () => {},
    getCheckpoint: () => null,
    updateFileParseStatus: () => {}
  })
  assert.equal(result.analysisStatus, 'completed')
  assert.equal(modelCalls, 2, '首轮有新增时继续复审，重复项不会新增')
  assert.ok(emitted.some((item) => item.event === 'review.delta' && item.data.streaming), '风险报告在模型生成中更新')
  const firstFindingEnd = JSON.stringify(sampleModelOutput).indexOf('}],"contextQuestions"')
  assert.ok(emitted.some((item) => item.event === 'review.delta' && item.data.content.includes('重点风险与处理建议')
    && item.raw.length < firstFindingEnd), '风险对象闭合前就连续显示其标题和正文，不能等整条风险才弹出')
  assert.ok(emitted.findIndex((item) => item.event === 'review.round' && item.data.phase === 'start')
    < emitted.findIndex((item) => item.event === 'review.delta'), '审查开始先于首段模型输出')
  assert.equal(result.findings[0].location.status, 'found')
  assert.equal(result.reviewStoppedEarly, true)
  assert.ok(emitted.some((item) => item.event === 'analysis.result'))

  const retryEvents = []
  let retryCalls = 0
  const retryWorkflow = createLaborContractAnalysisWorkflow({
  consolidate: async () => '', rewrite: syntheticRewrite,
    parseFile: async (file) => ({ text: file.buffer.toString('utf8') }),
    retrieveEvidence: async () => [],
    getLawCatalog: async () => lawCatalog,
    streamGenerate: async function* () {
      retryCalls += 1
      if (retryCalls === 1) {
        yield { content: '{', finishReason: null }
        yield { content: '', finishReason: 'length' }
        return
      }
      const content = JSON.stringify(sampleModelOutput)
      yield { content, finishReason: 'stop' }
    }
  })
  const retried = await retryWorkflow({
    task: { id: 'stream-retry', mode: 'thinking', prompt: '' },
    input: { action: 'analyze' },
    files: [{ id: 'retry-file', originalname: '虚构劳动合同.txt', buffer: Buffer.from('试用期为 3 个月') }],
    emit: async (event, data) => retryEvents.push({ event, data }),
    checkpoint: async () => {}, getCheckpoint: () => null, updateFileParseStatus: () => {}
  })
  assert.equal(retried.analysisStatus, 'completed')
  assert.equal(retryCalls, 3)
  assert.ok(retryEvents.some((item) => item.event === 'stage.progress' && item.data.message.includes('自动重试')))

  const followupEvents = []
  const followupWorkflow = createLaborContractFollowupWorkflow({
    streamGenerate: async function* () {
      yield { content: '依据原文，' }
      yield { content: '该条款还需复核。', finishReason: 'stop' }
    }
  })
  const followup = await followupWorkflow({
    task: { id: 'stream-followup', mode: 'thinking', prompt: '试用期为什么需要复核？' },
    input: { message: '试用期为什么需要复核？' },
    report: { productId: 'labor-contract-analysis', analysisStatus: 'completed', sourceTaskId: 'source' },
    sourceDocuments: [{ fileName: '虚构劳动合同.txt', text: '试用期为 3 个月' }],
    emit: async (event, data) => followupEvents.push({ event, data }),
    checkpoint: async () => {}, getCheckpoint: () => null
  })
  assert.equal(followup.answer, '依据原文，该条款还需复核。')
  assert.ok(followupEvents.some((item) => item.event === 'followup.delta'))
}

async function testInterruptedStreamSegmentation() {
  const saved = new Map()
  const calls = []
  const events = []
  let failedSegment = false
  const workflow = createLaborContractAnalysisWorkflow({
    retrieveEvidence: async () => [], getLawCatalog: async () => [],
    consolidate: async () => '', rewrite: syntheticRewrite,
    streamGenerate: async function* (request) {
      const round = Number(request.userMessage.match(/本轮为第\s*(\d+)\s*轮/)?.[1] || 1)
      calls.push({ round, compact: request.compact })
      if (!request.compact) {
        yield { content: '{"conclusion":"合成断线测试"' }
        throw Object.assign(new Error('synthetic ECONNRESET'), { code: 'LLM_STREAM_READ_FAILED' })
      }
      // Failing a compact request also triggers narrower batches; failing one topic is retried by the task layer.
      if (!failedSegment) {
        failedSegment = true
        throw Object.assign(new Error('synthetic ECONNRESET'), { code: 'LLM_STREAM_READ_FAILED' })
      }
      const topics = JSON.parse(request.userMessage.match(/内部覆盖主题清单：(\[[^\n]+\])/)[1])
      yield { content: JSON.stringify({ ...sampleModelOutput, topicChecks: topics.map((topic) => ({ ...topic, status: 'covered', summary: '合成覆盖记录' })), findings: [] }), finishReason: 'stop' }
    }
  })
  const result = await workflow({
    task: { id: 'stream-segment', mode: 'fast' }, input: { action: 'analyze' },
    sourceDocuments: [{ fileName: '合成合同.txt', text: '试用期为 3 个月' }],
    checkpoint: async (stage, value) => saved.set(stage, { result: value }), getCheckpoint: (stage) => saved.get(stage),
    emit: async (event, data) => events.push({ event, data })
  })
  assert.equal(result.analysisStatus, 'completed')
  assert.equal(calls.filter((call) => !call.compact).length, 1, '长连接断线后只拆短请求，不反复重跑整份材料')
  assert.ok(saved.get('review-pages').result.version === 1)
  assert.ok(events.some((event) => event.data.message?.includes('自动重试')))
}

async function testClassificationClarification() {
  const document = { fileName: '虚构材料.txt', text: '双方约定：单位聘用乙方担任文员，每月支付报酬。' }
  let captured
  const classify = (evidence, type = 'direct_labor_contract') => classifyLaborContractDocumentsWithLlm({
    documents: [document], clarification: '这是单位与职工签署的劳动合同，请结合双方权利义务识别。',
    generate: async (_system, user) => {
      captured = user
      return { content: JSON.stringify({ classifications: [{ index: 0, type, confidence: 'medium', evidence }] }) }
    }
  })
  const supported = await classify('单位聘用乙方担任文员')
  assert.ok(captured.includes('这是单位与职工签署的劳动合同'), '重新分类必须传入用户说明')
  assert.equal(supported[0].suggestedType, 'direct_labor_contract')
  const invented = await classify('不存在的劳动合同标题')
  assert.equal(invented[0].suggestedType, 'unsupported', '说明和模型虚构依据不能覆盖原文')
  assert.equal((await classify(''))[0].suggestedType, 'unsupported', '没有原文依据不得凭说明改类型')
  assert.equal((await classify('单位聘用乙方担任文员', 'unsupported'))[0].suggestedType, 'unsupported')
  const failed = await classifyLaborContractDocumentsWithLlm({ documents: [document], clarification: '劳动合同',
    generate: async () => { throw new Error('synthetic classifier unavailable') } })
  assert.equal(failed[0].suggestedType, 'unsupported', '模型失败不能用说明强制本地类型')
  assert.equal(failed[0].classificationStatus, 'unavailable', '识别服务故障与材料类型未知应分开提示')
  const filenameOnly = await classifyLaborContractDocumentsWithLlm({ documents: [{ ...document, fileName: '劳动合同.txt' }], clarification: '这是劳动合同',
    generate: async () => { throw new Error('synthetic classifier unavailable') } })
  assert.equal(filenameOnly[0].suggestedType, 'unsupported', '模型失败时也不能凭文件名和说明绕过正文依据')
  let emptyCalls = 0
  const empty = await classifyLaborContractDocumentsWithLlm({ documents: [{ fileName: '虚构空白.txt', text: '' }], clarification: '劳动合同',
    generate: async () => { emptyCalls++; return '{}' } })
  assert.equal(emptyCalls, 0, '没有正文不调用分类模型')
  assert.equal(empty[0].suggestedType, 'unsupported')

  const maskedDocument = { fileName: '虚构用工约定.txt', text: '甲方：虚构星河公司。乙方：张伟。单位聘用乙方工作。' }
  const maskedResult = await classifyLaborContractDocumentsWithLlm({ documents: [maskedDocument], clarification: '可联系18012345678说明材料类型',
    generate: async (_system, user) => {
      assert.equal(user.includes('18012345678'), false, '说明中的新增身份标识同样掩码')
      assert.equal(user.includes('虚构星河公司'), false)
      const input = JSON.parse(user.slice(user.indexOf('\n') + 1))
      return { content: JSON.stringify({ classifications: [{ index: 0, type: 'direct_labor_contract', evidence: input.documents[0].text.split('。')[0] }] }) }
    }
  })
  assert.equal(maskedResult[0].suggestedType, 'direct_labor_contract')
  assert.equal(maskedResult[0].evidence, '甲方：虚构星河公司', '模型掩码引用还原后与真实原文核对')

  const before = taskService.listTasks('user-a').length
  const body = new FormData()
  body.append('files', new Blob([document.text], { type: 'text/plain' }), document.fileName)
  body.append('clarification', '  这是职工与单位签的合同  ')
  const response = await request('/api/tasks/labor-contract-analysis/classify', { method: 'POST', body })
  assert.equal(response.status, 200)
  assert.equal(classificationCalls.at(-1).clarification, '这是职工与单位签的合同')
  assert.equal((await response.json()).classifications[0].suggestedType, 'unsupported')
  assert.equal(taskService.listTasks('user-a').length, before, '预分类不创建持久任务')
  const excessive = new FormData()
  excessive.append('files', new Blob([document.text], { type: 'text/plain' }), document.fileName)
  excessive.append('clarification', '甲'.repeat(16001))
  const count = classificationCalls.length
  assert.equal((await request('/api/tasks/labor-contract-analysis/classify', { method: 'POST', body: excessive })).status, 400)
  assert.equal(classificationCalls.length, count, '超长说明在模型调用前拒绝')
  const blank = new FormData()
  blank.append('files', new Blob(['   '], { type: 'text/plain' }), '虚构空白.txt')
  blank.append('clarification', '劳动合同')
  const blankResponse = await request('/api/tasks/labor-contract-analysis/classify', { method: 'POST', body: blank })
  assert.equal((await blankResponse.json()).classifications[0].parseStatus, 'empty')
  assert.equal(classificationCalls.length, count, '空白正文不能由说明代替')
}

try {
  await testClassificationClarification()
  await testLongDocumentTraversal()
  await testReviewResumeAndMode()
  await testDetailedLlmResponse()
  await testStreamedAnalysisEvents()
  await testInterruptedStreamSegmentation()
  await queue.start()

  const body = new FormData()
  body.append('focus', '请重点检查试用期。')
  body.append('files', new Blob(['第一条 合同期限：两年。\n第二条 试用期为 3 个月。'], { type: 'text/plain' }), '虚构劳动合同.txt')
  const createdResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body })
  assert.equal(createdResponse.status, 202)
  const created = await createdResponse.json()
  assert.equal(created.productId, 'labor-contract-analysis')
  assert.equal(created.task.workflowVersion, 'labor-contract-analysis-v3')
  assert.equal(created.task.threadId, created.taskId)

  const finished = await waitFor(async () => {
    const response = await request(`/api/tasks/${created.taskId}`)
    const payload = await response.json()
    return ['succeeded', 'failed'].includes(payload.task?.status) ? payload.task : null
  })
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.result.productId, 'labor-contract-analysis')
  assert.equal(finished.result.analysisStatus, 'completed')
  assert.equal(finished.result.topicChecks.length, 9)
  assert.equal(finished.result.findings[0].location.status, 'found')
  assert.equal(finished.result.findings[0].location.matches[0].fileName, '虚构劳动合同.txt')
  assert.equal(finished.result.findings[0].location.matches[0].lineStart, 2)
  assert.equal(finished.result.findings[0].authorities[0].lawStatus, 'verified')
  assert.equal(finished.result.findings[0].authorities[0].articleApplicability, 'pending-mentor-and-legal-review')
  assert.equal(finished.result.findings[1], undefined)
  assert.equal(finished.result.findings[0].supportingMaterials.length, 1)
  assert.equal(finished.result.findings[0].supportingMaterials[0].id, 'labor-risk-1')
  assert.equal(finished.result.findings[0].authorities.length, 1, '未收录法规不能混入已收录依据')
  assert.equal(finished.result.score.value, 94)
  assert.equal(finished.result.score.status, 'model-reference')
  assert.equal(finished.result.score.breakdown, undefined, '分数由模型返回，不生成逐项试算表')
  assert.deepEqual(finished.result.lawCandidates.map((item) => item.title), ['待核对的地方规定', '不存在的法规'])
  assert.ok(finished.result.warnings.some((warning) => warning.includes('白名单覆盖度')))
  assert.equal(reviewWorkflowCalls, 0, '新 productId 必须显式分发到劳动合同分析专属工作流')
  assert.equal(evidenceSpy[0].plan.contractType, '劳动合同')
  assert.equal(evidenceSpy[0].options.limit, 12)
  assert.doesNotMatch(modelSpy[0].userMessage, /商业违约条款诱饵|用工问答诱饵/)
  assert.match(modelSpy[0].systemPrompt, /白名单可能不完整/)

  const privacyBody = new FormData()
  privacyBody.append('focus', '请核对华星人力资源有限公司与张伟的约定，联系电话 13812345678。')
  privacyBody.append('files', new Blob(['华星人力资源有限公司\n乙方：张伟\n身份证号码：310101199001011234\n联系电话：13812345678\n签订日期：2026年10月1日\n工作地点：上海市浦东新区\n月工资：8000元\n试用期为 3 个月'], { type: 'text/plain' }), '含虚构身份标识的合成劳动合同.txt')
  const privacyResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: privacyBody })
  assert.equal(privacyResponse.status, 202)
  const privacyCreated = await privacyResponse.json()
  const privacyFinished = await waitForTerminalTask(privacyCreated.taskId)
  assert.equal(privacyFinished.status, 'succeeded')
  const ordinaryLlmInput = modelSpy.at(-1).userMessage
  assert.doesNotMatch(ordinaryLlmInput, /华星人力资源有限公司|张伟|310101199001011234|13812345678/)
  assert.match(ordinaryLlmInput, /2026年10月1日/)
  assert.match(ordinaryLlmInput, /上海市浦东新区/)
  assert.match(ordinaryLlmInput, /8000元/)
  assert.equal(privacyFinished.result.privacyNotice.includes('自动识别可能遗漏'), true)
  assert.ok((taskService.getCheckpoint(privacyCreated.taskId, 'privacy')?.result?.aliases || []).some((item) => item.value === '华星人力资源有限公司'))

  const parsedFile = database.prepare('SELECT parse_status FROM task_files WHERE task_id = ?').get(created.taskId)
  assert.equal(parsedFile.parse_status, 'succeeded')
  const eventsResponse = await request(`/api/tasks/${created.taskId}/events?after=0`, { headers: { Accept: 'text/event-stream' } })
  const events = await eventsResponse.text()
  assert.match(events, /event: stage\.start/)
  assert.match(events, /event: analysis\.result/)
  assert.match(events, /event: task\.succeeded/)

  const historyResponse = await request('/api/tasks?limit=100')
  const history = await historyResponse.json()
  assert.ok(history.tasks.some((item) => item.id === created.taskId && item.productId === 'labor-contract-analysis'))
  const unauthorized = await request(`/api/tasks/${created.taskId}`, { headers: { 'X-Test-User': 'user-b' } })
  assert.equal(unauthorized.status, 404)

  const followBody = new FormData()
  followBody.append('action', 'followup')
  followBody.append('message', '试用期为什么需要复核？')
  followBody.append('sourceTaskId', created.taskId)
  followBody.append('reportTaskId', created.taskId)
  const forbiddenFollow = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: followBody, headers: { 'X-Test-User': 'user-b' } })
  assert.equal(forbiddenFollow.status, 404)
  const followResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: followBody })
  assert.equal(followResponse.status, 202)
  const followCreated = await followResponse.json()
  const followFinished = await waitForTerminalTask(followCreated.taskId)
  assert.equal(followFinished.status, 'succeeded')
  assert.equal(followFinished.result.kind, 'followup')
  assert.equal(followFinished.result.sourceAvailable, true)
  assert.equal(followFinished.threadId, created.taskId)
  assert.equal(finished.result.score.value, 94, '追问不能改写旧报告与分数')
  const threadResponse = await request(`/api/tasks/labor-contract-analysis/thread/${created.taskId}`)
  assert.deepEqual((await threadResponse.json()).tasks.map((item) => item.id), [created.taskId, followCreated.taskId])
  const forbiddenThread = await request(`/api/tasks/labor-contract-analysis/thread/${created.taskId}`, { headers: { 'X-Test-User': 'user-b' } })
  assert.equal((await forbiddenThread.json()).tasks.length, 0)

  const reanalyzeBody = new FormData()
  reanalyzeBody.append('action', 'reanalyze')
  reanalyzeBody.append('sourceTaskId', created.taskId)
  reanalyzeBody.append('reportTaskId', created.taskId)
  reanalyzeBody.append('focus', '请再次核对试用期。')
  const reanalyzeResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: reanalyzeBody })
  assert.equal(reanalyzeResponse.status, 202)
  const reanalyzeCreated = await reanalyzeResponse.json()
  const reanalyzed = await waitForTerminalTask(reanalyzeCreated.taskId)
  assert.equal(reanalyzed.status, 'succeeded')
  assert.equal(reanalyzed.result.kind, 'analysis')
  assert.equal(reanalyzed.result.sourceTaskId, created.taskId)
  assert.equal(taskService.getCheckpoint(reanalyzeCreated.taskId, 'parsing'), null, '重新分析不能复制全文检查点延长留存')
  taskService.saveCheckpoint(reanalyzeCreated.taskId, 'privacy', {
    aliases: [{ value: 'Synthetic Dispatch Ltd', token: '【单位A】', category: 'organization' }]
  })
  assert.ok(taskService.getCheckpoint(reanalyzeCreated.taskId, 'privacy')?.result?.aliases?.length)

  database.prepare('UPDATE task_files SET cleanup_at = ? WHERE task_id = ?').run(new Date(Date.now() - 1000).toISOString(), created.taskId)
  const expiredFollowBody = new FormData()
  expiredFollowBody.append('action', 'followup')
  expiredFollowBody.append('message', '重新核对一条新风险')
  expiredFollowBody.append('sourceTaskId', created.taskId)
  expiredFollowBody.append('reportTaskId', reanalyzeCreated.taskId)
  const expiredFollowResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: expiredFollowBody })
  assert.equal(expiredFollowResponse.status, 202)
  const expiredFollowCreated = await expiredFollowResponse.json()
  const expiredFollowResult = await waitForTerminalTask(expiredFollowCreated.taskId)
  assert.equal(expiredFollowResult.result.sourceAvailable, true, '临时文件到期不影响会话正文追问')
  const expiredReanalysis = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: reanalyzeBody })
  assert.equal(expiredReanalysis.status, 202, '会话正文仍可重新分析')
  await waitForTerminalTask((await expiredReanalysis.json()).taskId)
  assert.equal(taskService.purgeExpiredLaborSourceCheckpoints() > 0, true)
  assert.equal(taskService.getCheckpoint(created.taskId, 'parsing'), null)
  const retainedSource = await request(`/api/tasks/labor-contract-analysis/source/${created.taskId}`)
  assert.equal(retainedSource.status, 200)
  assert.equal((await retainedSource.json()).expiresAt, taskService.getTask(created.taskId, 'user-a').resultExpiresAt)
  assert.ok(taskService.getLaborSourceDocuments(created.taskId).length)
  const expiredFileIds = new Set(taskService.listExpiredFiles().map((file) => file.id))
  taskService.removeFileRecords(taskService.getFiles(created.taskId).filter((file) => expiredFileIds.has(file.id)).map((file) => file.id))
  assert.equal(taskService.getFiles(created.taskId).length, 0)
  const sourceWithoutFiles = await request(`/api/tasks/labor-contract-analysis/source/${created.taskId}`)
  assert.equal(sourceWithoutFiles.status, 200, '临时文件记录清除后，会话原文仍可读取')
  assert.ok((await sourceWithoutFiles.json()).documents.length)
  assert.equal(taskService.getCheckpoint(created.taskId, 'privacy'), null, '源合同到期时清除原分析中的身份映射')
  assert.equal(taskService.getCheckpoint(reanalyzeCreated.taskId, 'privacy'), null, '重新分析任务的身份映射随源合同到期清除')

  const callsBeforeDispatch = modelSpy.length
  const evidenceBeforeDispatch = evidenceSpy.length
  const dispatchBody = new FormData()
  dispatchBody.append('files', new Blob(['劳务派遣协议\n派遣单位：虚构甲公司\n用工单位：虚构乙公司'], { type: 'text/plain' }), '虚构劳务派遣协议.txt')
  const dispatchResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: dispatchBody })
  assert.equal(dispatchResponse.status, 202)
  const dispatchTask = await dispatchResponse.json()
  const dispatchFinished = await waitFor(async () => {
    const response = await request(`/api/tasks/${dispatchTask.taskId}`)
    const payload = await response.json()
    return payload.task?.status === 'succeeded' ? payload.task : null
  })
  assert.equal(dispatchFinished.result.analysisStatus, 'scope-confirmation-required')
  assert.equal(dispatchFinished.result.findings.length, 0)
  assert.equal(modelSpy.length, callsBeforeDispatch, '劳务派遣范围待确认时不得生成法律分析')
  assert.equal(evidenceSpy.length, evidenceBeforeDispatch, '劳务派遣范围待确认时不得检索劳动合同资料')

  const dispatchAgreementText = [
    '劳务派遣协议',
    '派遣单位：华星人力资源有限公司',
    '用工单位：东海电子有限公司',
    '派遣岗位：包装岗位',
    '协议期限：2026年10月1日至2027年9月30日',
    '用工单位按月向派遣单位支付服务费。'
  ].join('\n')
  const dispatchEmploymentText = [
    '劳务派遣劳动合同',
    '甲方：华星人力资源有限公司',
    '乙方：张伟',
    '身份证号码：310101199001011234',
    '手机号：13812345678',
    '派往单位：东海电子有限公司',
    '工作地点：上海市浦东新区',
    '工资：8000元/月'
  ].join('\n')
  const dispatchMissingPerspective = new FormData()
  dispatchMissingPerspective.append('analysisType', 'labor_dispatch_agreement')
  dispatchMissingPerspective.append('fileRoles', JSON.stringify(['dispatch_agreement']))
  dispatchMissingPerspective.append('files', new Blob([dispatchAgreementText], { type: 'text/plain' }), '虚构派遣协议.txt')
  const noPerspectiveResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: dispatchMissingPerspective })
  assert.equal(noPerspectiveResponse.status, 400)
  assert.equal((await noPerspectiveResponse.json()).code, 'review_perspective_required')

  const dispatchNoAgreement = new FormData()
  dispatchNoAgreement.append('analysisType', 'labor_dispatch_agreement')
  dispatchNoAgreement.append('reviewPerspective', 'using_unit')
  dispatchNoAgreement.append('fileRoles', JSON.stringify(['supporting_attachment']))
  dispatchNoAgreement.append('files', new Blob([dispatchAgreementText], { type: 'text/plain' }), '缺少主文件.txt')
  const noAgreementResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: dispatchNoAgreement })
  assert.equal(noAgreementResponse.status, 400)
  assert.equal((await noAgreementResponse.json()).code, 'dispatch_agreement_required')

  const beforeDispatchModelCount = dispatchModelSpy.length
  const beforeDispatchRetrievalCount = dispatchEvidenceSpy.length
  const pairedDispatchBody = new FormData()
  pairedDispatchBody.append('analysisType', 'labor_dispatch_agreement')
  pairedDispatchBody.append('reviewPerspective', 'using_unit')
  pairedDispatchBody.append('fileRoles', JSON.stringify(['dispatch_agreement', 'dispatch_employment_contract']))
  pairedDispatchBody.append('focus', '请重点核对费用结算和双方职责。')
  pairedDispatchBody.append('files', new Blob([dispatchAgreementText], { type: 'text/plain' }), '虚构劳务派遣协议.txt')
  pairedDispatchBody.append('files', new Blob([dispatchEmploymentText], { type: 'text/plain' }), '虚构派遣劳动合同.txt')
  const pairedDispatchResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: pairedDispatchBody })
  assert.equal(pairedDispatchResponse.status, 202)
  const pairedDispatchTask = await pairedDispatchResponse.json()
  const pairedDispatchFinished = await waitForTerminalTask(pairedDispatchTask.taskId)
  assert.equal(pairedDispatchFinished.status, 'succeeded')
  assert.equal(pairedDispatchFinished.analysisType, 'labor_dispatch_agreement')
  assert.equal(pairedDispatchFinished.reviewPerspective, 'using_unit')
  assert.deepEqual(pairedDispatchFinished.fileRoles, ['dispatch_agreement', 'dispatch_employment_contract'])
  assert.equal(pairedDispatchFinished.result.analysisType, 'labor_dispatch_agreement')
  assert.equal(pairedDispatchFinished.result.reviewPerspectiveLabel, '用工单位')
  assert.equal(pairedDispatchFinished.result.crossDocumentReviewStatus, 'paired-materials')
  assert.equal(pairedDispatchFinished.result.topicChecks.length, 8)
  assert.equal(pairedDispatchFinished.result.score.status, 'model-reference', '派遣协议也采用模型整体判断，不使用普通合同试算分')
  assert.equal(pairedDispatchFinished.result.agreementInfo.dispatchingUnit, '华星人力资源有限公司')
  assert.equal(pairedDispatchFinished.result.agreementInfo.usingUnit, '东海电子有限公司')
  assert.equal(pairedDispatchFinished.result.findings[0].location.status, 'found')
  assert.equal(pairedDispatchFinished.result.findings[0].location.matches[0].fileName, '虚构劳务派遣协议.txt')
  assert.equal(pairedDispatchFinished.result.findings[0].authorities[0].lawStatus, 'verified')
  assert.deepEqual(pairedDispatchFinished.result.findings[0].supportingMaterials.map((item) => item.id), ['dispatch-risk-1'])
  assert.deepEqual(pairedDispatchFinished.result.lawCandidates.map((item) => item.title), ['当地派遣服务管理规定'])
  assert.ok(pairedDispatchFinished.result.privacyNotice.includes('自动识别可能遗漏'))
  assert.equal(dispatchModelSpy.length, beforeDispatchModelCount + 2)
  assert.equal(dispatchEvidenceSpy.length, beforeDispatchRetrievalCount + 1)
  assert.equal(dispatchEvidenceSpy.at(-1).plan.contractType, '劳务派遣协议')
  assert.equal(dispatchEvidenceSpy.at(-1).options.strictContractType, true)
  const dispatchLlmInput = dispatchModelSpy.at(-1).userMessage
  assert.doesNotMatch(dispatchLlmInput, /华星人力资源有限公司|东海电子有限公司|张伟|310101199001011234|13812345678/)
  assert.match(dispatchLlmInput, /【单位A】/)
  assert.match(dispatchLlmInput, /上海市浦东新区/)
  assert.match(dispatchLlmInput, /2026年10月1日至2027年9月30日/)
  assert.match(dispatchLlmInput, /8000元\/月/)
  assert.doesNotMatch(dispatchLlmInput, /普通劳动合同模板诱饵|商业合同诱饵|用工咨询问答诱饵/)
  assert.equal(reviewWorkflowCalls, 0)
  const storedPrivacyAliases = taskService.getCheckpoint(pairedDispatchTask.taskId, 'privacy')?.result?.aliases || []
  assert.ok(storedPrivacyAliases.some((item) => item.value === '张伟'))
  assert.ok(!JSON.stringify(pairedDispatchFinished.result).includes('aliases'))
  const dispatchSourceResponse = await request(`/api/tasks/labor-contract-analysis/source/${pairedDispatchTask.taskId}`)
  const dispatchSource = await dispatchSourceResponse.json()
  assert.deepEqual(dispatchSource.documents.map((document) => document.role), ['dispatch_agreement', 'dispatch_employment_contract'])
  const unauthorizedDispatchSource = await request(`/api/tasks/labor-contract-analysis/source/${pairedDispatchTask.taskId}`, { headers: { 'X-Test-User': 'user-b' } })
  assert.equal(unauthorizedDispatchSource.status, 404)

  const dispatchFollowupBody = new FormData()
  dispatchFollowupBody.append('action', 'followup')
  dispatchFollowupBody.append('message', '请结合华星人力资源有限公司、张伟和13812345678说明工资安排。')
  dispatchFollowupBody.append('sourceTaskId', pairedDispatchTask.taskId)
  dispatchFollowupBody.append('reportTaskId', pairedDispatchTask.taskId)
  const dispatchFollowupResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: dispatchFollowupBody })
  assert.equal(dispatchFollowupResponse.status, 202)
  const dispatchFollowupCreated = await dispatchFollowupResponse.json()
  const dispatchFollowupResult = await waitForTerminalTask(dispatchFollowupCreated.taskId)
  assert.equal(dispatchFollowupResult.status, 'succeeded')
  assert.equal(dispatchFollowupResult.result.analysisType, 'labor_dispatch_agreement')
  assert.equal(dispatchFollowupResult.result.sourceAvailable, true)
  assert.match(dispatchFollowupResult.result.answer, /东海电子有限公司/)
  assert.match(dispatchFollowupResult.result.answer, /张伟/)
  assert.doesNotMatch(dispatchModelSpy.at(-1).userMessage, /华星人力资源有限公司|张伟|13812345678/)

  const singleDispatchBody = new FormData()
  singleDispatchBody.append('analysisType', 'labor_dispatch_agreement')
  singleDispatchBody.append('reviewPerspective', 'dispatch_unit')
  singleDispatchBody.append('fileRoles', JSON.stringify(['dispatch_agreement']))
  singleDispatchBody.append('files', new Blob([dispatchAgreementText], { type: 'text/plain' }), '仅派遣协议.txt')
  const singleDispatchResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: singleDispatchBody })
  assert.equal(singleDispatchResponse.status, 202)
  const singleDispatchCreated = await singleDispatchResponse.json()
  const singleDispatchFinished = await waitForTerminalTask(singleDispatchCreated.taskId)
  assert.equal(singleDispatchFinished.status, 'succeeded')
  assert.equal(singleDispatchFinished.result.crossDocumentReviewStatus, 'agreement-only')
  assert.ok(singleDispatchFinished.result.warnings.some((warning) => warning.includes('未能与派遣劳动合同交叉核对')))

  const emptyBody = new FormData()
  emptyBody.append('files', new Blob([' \n  '], { type: 'text/plain' }), '空白劳动合同.txt')
  const emptyResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: emptyBody })
  assert.equal(emptyResponse.status, 202)
  const emptyTask = await emptyResponse.json()
  const emptyFinished = await waitFor(async () => {
    const response = await request(`/api/tasks/${emptyTask.taskId}`)
    const payload = await response.json()
    return payload.task?.status === 'failed' ? payload.task : null
  })
  assert.equal(emptyFinished.errorCode, 'labor_contract_parse_failed')
  assert.equal(database.prepare('SELECT parse_status FROM task_files WHERE task_id = ?').get(emptyTask.taskId)?.parse_status, 'empty')
  assert.equal(modelSpy.length, callsBeforeDispatch, '没有解析到合同文本时不得请求模型')

  const noFiles = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: new FormData() })
  assert.equal(noFiles.status, 400)

  const retryCallStart = modelSpy.length
  queuedModelResponses.push({ content: '{"partial":', finishReason: 'length', usage: { completion_tokens: 6144 } }, JSON.stringify(sampleModelOutput))
  const retryTask = await createSyntheticTask()
  const retryResult = await waitForTerminalTask(retryTask.taskId)
  const retryRequests = modelSpy.slice(retryCallStart)
  assert.equal(retryResult.status, 'succeeded')
  assert.equal(retryRequests.length, 3, '首轮截断精简一次，完成后继续增量复审')
  assert.equal(retryRequests[1].compact, true, '截断重试必须使用精简输出要求')

  const analysisGroups = [0, 3, 6].map((start) => LABOR_CONTRACT_ANALYSIS_TOPICS.slice(start, start + 3))
  const outputForGroup = (topics, index) => ({
    ...sampleModelOutput,
    topicChecks: sampleModelOutput.topicChecks.filter((check) => topics.some((topic) => topic.id === check.id)),
    missingItems: index === 0 ? sampleModelOutput.missingItems : [],
    findings: index === 0 ? sampleModelOutput.findings : [],
    lawCandidates: index === 1 ? sampleModelOutput.lawCandidates : [],
    contextQuestions: index === 2 ? sampleModelOutput.contextQuestions : [],
    analysisNotes: [`分组 ${index + 1} 测试说明`]
  })
  const segmentedRecoveryStart = modelSpy.length
  queuedModelResponses.push(
    ...analysisGroups.map((topics, index) => ({ content: JSON.stringify({ ...outputForGroup(topics, index), roundComplete: index === 2 }), finishReason: 'stop' }))
  )
  const segmentedRecoveryTask = await createSyntheticTask()
  const segmentedRecovery = await waitForTerminalTask(segmentedRecoveryTask.taskId)
  assert.equal(segmentedRecovery.status, 'succeeded', '主动分批继续核对全文而非等待截断')
  assert.equal(segmentedRecovery.result.topicChecks.length, 9)
  assert.equal(segmentedRecovery.result.findings.length, 1)
  assert.equal(modelSpy.length - segmentedRecoveryStart, 4)
  assert.ok(modelSpy.slice(segmentedRecoveryStart).every((request) => request.userMessage.includes('内部覆盖主题清单')))

  const failedBatchStart = modelSpy.length
  queuedModelResponses.push(...Array.from({ length: 3 }, () => ({ content: '{"batchPartial":', finishReason: 'length' })))
  const failedBatchTask = await createSyntheticTask()
  const failedBatch = await waitForTerminalTask(failedBatchTask.taskId)
  assert.equal(failedBatch.status, 'failed')
  assert.equal(failedBatch.errorCode, 'labor_analysis_unit_exhausted')
  assert.equal(modelSpy.length - failedBatchStart, 3, '单批预算耗尽不得触发任务层再次重试')

  const malformedStart = modelSpy.length
  queuedModelResponses.push({ content: '{"broken":', finishReason: 'stop' })
  const malformedTask = await createSyntheticTask()
  const malformed = await waitForTerminalTask(malformedTask.taskId)
  assert.equal(malformed.status, 'failed')
  assert.equal(malformed.errorCode, 'labor_analysis_output_invalid')
  assert.match(malformed.errorSummary, /不是有效 JSON/)
  assert.equal(modelSpy.length - malformedStart, 1, '非截断 JSON 错误不得自动重试')
  assert.equal(taskService.getCheckpoint(malformedTask.taskId, 'privacy'), null, '失败任务应清除用于恢复身份映射的临时隐私检查点')

  const emptyStart = modelSpy.length
  queuedModelResponses.push({ content: '', finishReason: 'stop', empty: true })
  const emptyOutputTask = await createSyntheticTask()
  const emptyOutput = await waitForTerminalTask(emptyOutputTask.taskId)
  assert.equal(emptyOutput.status, 'failed')
  assert.equal(emptyOutput.errorCode, 'labor_analysis_output_empty')
  assert.match(emptyOutput.errorSummary, /未返回内容/)
  assert.equal(modelSpy.length - emptyStart, 1)

  const incompleteOutput = { ...sampleModelOutput, topicChecks: sampleModelOutput.topicChecks.slice(1) }
  const incompleteStart = modelSpy.length
  queuedModelResponses.push(JSON.stringify(incompleteOutput))
  const incompleteTask = await createSyntheticTask()
  const incomplete = await waitForTerminalTask(incompleteTask.taskId)
  assert.equal(incomplete.status, 'failed')
  assert.equal(incomplete.errorCode, 'labor_analysis_output_incomplete')
  assert.match(incomplete.errorSummary, /缺少基础检查项/)
  assert.equal(modelSpy.length - incompleteStart, 1, '九项不完整但未截断时不得自动重试')

  queuedModelResponses.push({ content: '{"broken":', finishReason: 'stop' })
  const restartSource = await createSyntheticTask('虚构劳动合同-中断续分析.txt')
  const restartSourceFinished = await waitForTerminalTask(restartSource.taskId)
  assert.equal(restartSourceFinished.status, 'failed')
  assert.ok(taskService.getCheckpoint(restartSource.taskId, 'parsing')?.result?.documents?.length)
  const restartBody = new FormData()
  restartBody.append('action', 'restart-analysis')
  restartBody.append('sourceTaskId', restartSource.taskId)
  restartBody.append('focus', '请补充关注社保约定。')
  const restartResponse = await request('/api/tasks/labor-contract-analysis', { method: 'POST', body: restartBody })
  assert.equal(restartResponse.status, 202)
  const restartCreated = await restartResponse.json()
  const restarted = await waitForTerminalTask(restartCreated.taskId)
  assert.equal(restarted.status, 'succeeded')
  assert.equal(restarted.result.sourceTaskId, restartSource.taskId)
  assert.equal(taskService.getCheckpoint(restartCreated.taskId, 'parsing'), null, '中断后从原任务续分析不得复制全文检查点')

  database.prepare("UPDATE tasks SET created_at = ? WHERE user_id = ? AND product_id = ? AND COALESCE(thread_id, id) = ?")
    .run('2020-01-01T00:00:00.000Z', 'user-a', 'labor-contract-analysis', created.taskId)
  const expiredTaskResponse = await request(`/api/tasks/${created.taskId}`)
  assert.equal((await expiredTaskResponse.json()).task.result, null, '统一的会话到期字段隐藏已到期结果')
  const expiredEvents = taskService.getEvents(created.taskId, 'user-a')
  assert.equal(expiredEvents.some((item) => ['analysis.section', 'followup.delta'].includes(item.event)), false, '报告内容事件过期后不再通过事件接口回放')
  taskService.purgeExpiredLaborSourceCheckpoints()
  assert.ok(database.prepare('SELECT result_json FROM tasks WHERE id = ?').get(created.taskId).result_json, '材料清理与会话删除分开，材料清理器不直接删除报告')
  assert.ok(taskService.getCheckpoint(created.taskId, 'analysis'), '清理器保留分析结果检查点')

  assert.equal(queuedModelResponses.length, 0)
  const forbiddenDelete = await request(`/api/tasks/labor-contract-analysis/thread/${created.taskId}`, { method: 'DELETE', headers: { 'X-Test-User': 'user-b' } })
  assert.equal(forbiddenDelete.status, 404)
  const deleteResponse = await request(`/api/tasks/labor-contract-analysis/thread/${created.taskId}`, { method: 'DELETE' })
  assert.equal(deleteResponse.status, 200)
  assert.equal(taskService.getCheckpoint(created.taskId, 'source'), null, '主动删除整段会话时，原文快照随会话清除')
  assert.equal((await request(`/api/tasks/labor-contract-analysis/source/${created.taskId}`)).status, 404)
  console.log('Labor contract analysis regression passed: synthetic fixtures, stream events, resumed incremental rounds, real thinking mode options, paged completion markers, unit retry budgets, rewrite batching, conversation source snapshot after temporary cleanup, shared session expiry, ownership and complete thread deletion.')
} finally {
  await queue.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
