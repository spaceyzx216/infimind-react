// 劳动仲裁：纯文本（无上传文件）与流式叙述回归。全部为合成数据与模型桩，
// 不触达真实模型、网络、项目数据库或上传目录。
import assert from 'node:assert/strict'
import { runLaborArbitration } from '../workflows/labor-arbitration.js'

const message = '公司收到仲裁申请书：1、支付加班费1200元。2、支付工资差额800元。申请人称公司从未支付以上款项，履行地区杭州。公司认为金额需要核实。'
const REQUESTS = ['支付加班费1200元。', '支付工资差额800元。']

function stageOf(prompt) {
  if (prompt.includes('当前阶段：只整理案件')) return 'case'
  if (prompt.includes('当前阶段：根据案件记录逐请求')) return 'analysis'
  if (prompt.includes('当前阶段：根据有效案件记录')) return 'reply'
  if (prompt.includes('当前阶段：依据当前案件记录')) return 'draft'
  return 'review'
}

function stageValue(stage, input, config, source) {
  if (stage === 'case') {
    const texts = REQUESTS.filter((text) => source?.text?.includes(text))
    const value = {
      intent: 'update', relation: 'same', region: '杭州', relevantDate: '',
      caseInfo: [{ label: '履行地区', value: '杭州', sources: [{ sourceId: source?.id, quote: '杭州' }] }],
      requests: texts.map((text) => ({ text, subitems: [], sources: [{ sourceId: source?.id, quote: text }] })),
      facts: [{ text: '企业称金额需要核实', kind: 'company_statement', requestIndexes: texts.map((_, index) => index),
        sources: [{ sourceId: source?.id, quote: '公司认为金额需要核实。' }] }],
      conflicts: [], followUpQuestions: ['是否有付款记录？']
    }
    if (config.noRequests) value.requests = []
    if (config.unknownSource) value.requests = value.requests.map((request) => ({ ...request, sources: [{ sourceId: 'does-not-exist', quote: request.text }] }))
    return value
  }
  if (stage === 'analysis') {
    return { answer: '初步分析：申请人主张的加班费与工资差额均以单方陈述为据，付款记录、考勤记录与工资基数尚未核实。企业在答辩中应先确认请求范围与金额口径，再逐项回应；在取得付款凭证前，不能认定款项已经支付，也不宜承认欠付金额。建议先核对申请人的仲裁请求与在职期间记录，再决定是否对请求提出异议。', conversationTitle: '加班费与工资差额争议',
      claims: input.caseRecord.requests.map((request) => ({ requestId: request.id, companyPosition: '金额待核实',
        defenseAdvice: '核对工资记录。', reasoning: '申请人单方主张。', riskLevel: 'medium', riskReason: '金额未核实。',
        materialSufficiency: 'partial', sourceIds: [request.sources[0].sourceId],
        factIds: input.caseRecord.facts.filter((fact) => fact.kind !== 'unknown').map((fact) => fact.id),
        referenceIds: [], legalBasis: [],
        evidence: [{ name: '仲裁申请书', proves: '对方请求', status: config.chatAsUploaded ? 'uploaded' : 'proposed',
          sourceId: config.chatAsUploaded ? (input.caseRecord.facts[0]?.sources?.[0]?.sourceId || '') : '' }], evidenceGaps: [] })),
      overallRisk: 'medium', riskBasis: ['请求金额尚待核实'], followUpQuestions: ['请核对付款记录'], defenseDraft: '' }
  }
  if (stage === 'draft') {
    return { respondent: '虚构星河公司', applicant: '虚构林某', requestsSummary: '对无依据部分提出抗辩。',
      items: input.caseRecord.requests.map((request) => ({ requestId: request.id, coveredSubitems: request.subitems,
        conclusion: '核实事实后回应。', advice: '核对实际记录。', legalBasis: '具体条文待核对。', analysis: '仅有申请人陈述。' })),
      evidence: '拟补充：付款和考勤记录。', closing: '提交前由专业人员复核。' }
  }
  if (stage === 'reply') return { answer: '可以补充与本案有关的记录：付款凭证、考勤原始记录、工资表与劳动合同。需要说明的是，申请人单方陈述属于待核实事实，不能直接当作已证明事实；企业补充的材料也应注明形成时间与来源，避免把拟补充证据写成已上传证据。', followUpQuestions: [] }
  return { issues: [], notes: [] }
}

function harness(config = {}) {
  const cache = new Map()
  const events = []
  const calls = []
  const build = (prompt, json) => {
    const input = JSON.parse(json)
    const stage = stageOf(prompt)
    calls.push({ stage, input })
    const source = input.sources?.find((item) => item.kind === 'document') || input.sources?.at(-1)
    return { stage, input, source, value: stageValue(stage, input, config, source) }
  }
  const chat = async (prompt, json) => {
    const { value } = build(prompt, json)
    return { content: JSON.stringify(value), finishReason: 'stop', model: 'stub', usage: { prompt_tokens: 10, completion_tokens: 5 } }
  }
  // 流式桩：把同一份 JSON 切成小块推送，模拟真实逐字输出。
  const stream = async function* (prompt, json) {
    const { value } = build(prompt, json)
    const payload = JSON.stringify(value)
    for (let at = 0; at < payload.length; at += 24) {
      const last = at + 24 >= payload.length
      yield { content: payload.slice(at, at + 24), ...(last ? { finishReason: 'stop' } : {}) }
    }
  }
  return {
    calls, events, cache,
    run: (input = {}, sourceDocuments = []) => runLaborArbitration({
      task: { id: 'text-only', workflowVersion: 'labor-arbitration-v2' },
      input: { schemaVersion: 2, action: 'analyze', message, mode: 'fast', ...input },
      sourceDocuments,
      checkpoint: (stage, result) => cache.set(stage, { result }),
      getCheckpoint: (stage) => cache.get(stage),
      emit: (event, payload) => events.push({ event, ...payload }),
      isCancellationRequested: () => false,
      stageDependencies: { chat, stream, practicalSearch: () => [], caseSearch: () => [] }
    })
  }
}

// 1) 纯文本带编号请求：正常分析，且必须逐块推送叙述正文。
const streamed = harness()
const streamedResult = await streamed.run()
assert.equal(streamedResult.kind, 'analysis')
assert.equal(streamedResult.claims.length, 2)
const deltas = streamed.events.filter((event) => event.event === 'arbitration.delta')
assert.ok(deltas.length > 5, `叙述正文必须分块流式推送，实际 ${deltas.length} 块`)
assert.equal(deltas[0].replace, true, '第一块必须整段替换，避免续在上一次内容之后')
assert.ok(deltas.slice(1).every((event) => !event.replace), '后续块只推增量')
const streamedText = deltas[0].content + deltas.slice(1).map((event) => event.content).join('')
assert.equal(streamedText, streamedResult.answer, '流式块拼接必须等于最终叙述正文')
assert.ok(deltas.every((event) => event.field === 'answer' && event.stage === 'arbitration_analysis'))

// 2) 纯文本、模型未提取到请求：仍然给出结论而不是报错。
const noRequests = harness({ noRequests: true })
const noRequestResult = await noRequests.run()
assert.equal(noRequestResult.kind, 'analysis')
assert.equal(noRequestResult.claims.length, 0)

// 3) 纯文本时模型把企业聊天陈述写成“已上传证据”：必须降级为拟补充，而不是整案失败。
const chatEvidence = harness({ chatAsUploaded: true })
const chatEvidenceResult = await chatEvidence.run()
assert.equal(chatEvidenceResult.claims.length, 2)
const downgraded = chatEvidenceResult.claims.flatMap((claim) => claim.evidence || []).filter((item) => item.name === '仲裁申请书')
assert.ok(downgraded.length, '证据条目必须保留')
assert.ok(downgraded.every((item) => item.status !== 'uploaded'), '没有上传文件时不得声称已上传')
assert.ok(chatEvidenceResult.warnings.some((warning) => warning.includes('拟补充')) || chatEvidenceResult.reviewNotes?.some((note) => note.includes('拟补充'))
  || downgraded.every((item) => item.status === 'proposed'), '降级必须留下可追溯记录')

// 4) 模型引用了不存在的来源：仍然如实失败，不能被降级逻辑掩盖。
const unknownSource = harness({ unknownSource: true })
await assert.rejects(unknownSource.run(), (error) => error.code === 'arbitration_result_invalid')

console.log('PASS labor arbitration text-only and streaming: no-material case completes, uploaded-evidence claim downgraded, unknown sources still rejected, narrative streamed in chunks')
