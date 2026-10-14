// Synthetic material, in-memory checkpoints and model stubs only.
// No business database, knowledge retrieval, uploads or external requests.
import assert from 'node:assert/strict'
import { reduceLaborProgress } from '../../src/utils/labor-progress.js'
import { runContractReview } from '../workflows/contract-review.js'
import { createLaborContractAnalysisWorkflow } from '../workflows/labor-contract-analysis.js'
import { createLaborDispatchAnalysisWorkflow } from '../workflows/labor-dispatch-analysis.js'
import { LABOR_CONTRACT_ANALYSIS_TOPICS, LABOR_CONTRACT_COMPLETENESS_ELEMENTS } from '../prompts/labor-contract-analysis.js'
import { LABOR_DISPATCH_ANALYSIS_TOPICS } from '../prompts/labor-dispatch-analysis.js'

const source = '用人单位：北京测试有限公司，劳动者：李四。\n第一条 月工资为8000元。\n第二条 每周工作六天。\n第三条 合同期限为两年。'
const findings = [
  { title: '第一轮工资支付安排', quote: '月工资为8000元。', risk: '未约定支付日', advice: '约定每月支付日' },
  { title: '第二轮每周休息安排', quote: '每周工作六天。', risk: '需要核对休息与工时', advice: '明确休息与加班安排' }
].map((finding) => ({ level: '中', topic: '薪酬', location: '相关条款', replacement: '', evidence: [], ...finding }))
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('External requests forbidden in first-round regression') }
const harness = (initial = []) => {
  const saved = new Map(initial.map(([stage, result]) => [stage, { result }]))
  const events = []
  return { saved, events,
    checkpoint: async (stage, result) => saved.set(stage, { result }),
    getCheckpoint: (stage) => saved.get(stage),
    emit: async (event, data) => events.push({ event, data }) }
}
const firstRoundEvents = (events) => events.filter(({ event }) => event === 'review.delta')
function assertSequence(events, result, { fake = false, requireLive = true } = {}) {
  const deltas = firstRoundEvents(events)
  assert.ok(deltas.length)
  // 两类 review.delta：
  //  - 首轮报告（无 live 标记）：仍是 round 1、replace、firstRoundReport === content，契约不变；
  //  - 实时正文（live: true）：按当前累计发现重渲染，覆盖第 1～3 轮，不带 firstRoundReport。
  const firstRoundDeltas = deltas.filter(({ data }) => !data.live)
  const liveDeltas = deltas.filter(({ data }) => data.live)
  assert.ok(firstRoundDeltas.length, '必须仍有首轮报告事件')
  assert.ok(firstRoundDeltas.every(({ data }) => data.round === 1 && data.replace === true && data.firstRoundReport === data.content))
  assert.ok(liveDeltas.every(({ data }) => data.replace === true && data.firstRoundReport === undefined))
  // 实时正文来自模型调用：检查点恢复路径不重新请求模型，因此没有 live 事件；
  // 劳动合同链路暂未推送 live（本轮只改商业审查），用 requireLive 区分。
  if (!fake && requireLive) assert.ok(liveDeltas.length, '必须推送实时审查正文')
  const end = events.findIndex(({ event, data }) => event === 'review.round' && data.round === 1 && data.phase === 'end')
  assert.ok(end >= 0)
  assert.ok(events.findIndex(({ event }) => event === 'review.delta') < end, '第一轮正文先于审查进度完成事件')
  if (!fake) {
    const second = events.findIndex(({ event, data }) => event === 'review.round' && data.round === 2 && data.phase === 'start')
    const third = events.findIndex(({ event, data }) => event === 'review.round' && data.round === 3 && data.phase === 'start')
    assert.ok(second > end && third > second, '第一轮正文结束后继续执行第二、三轮')
    assert.match(result.firstRoundReport, /第一轮工资支付安排/)
    assert.doesNotMatch(result.firstRoundReport, /第二轮每周休息安排/)
    assert.match(result.reviewReport, /第二轮每周休息安排/, '最终报告保留后续复核风险')
    assert.ok(result.revisions.length, '最终批注链路仍然执行')
    // 新契约（仅商业审查链路）：后续轮次的新发现必须进入实时正文，首轮报告本身不受影响。
    if (requireLive) {
      assert.ok(liveDeltas.some(({ data }) => Number(data.round) > 1), '第 2/3 轮也要有实时正文')
      assert.ok(liveDeltas.some(({ data }) => data.content.includes('第二轮每周休息安排')), '实时正文必须包含后续轮次的新发现')
      assert.ok(firstRoundDeltas.every(({ data }) => !data.content.includes('第二轮每周休息安排')), '首轮报告不得混入后续轮次发现')
    }
  }
  assert.equal(result.firstRoundReport, firstRoundDeltas.at(-1).data.firstRoundReport)
  const completed = events.find(({ event, data }) => event === 'stage.complete' && data.stage === 'review')
  assert.deepEqual(completed?.data.roundSnapshots, result.reviewRounds, '审查完成及恢复事件携带全部轮次快照')
}

async function commercial() {
  let calls = 0
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/chat/completions'))
    calls++
    const body = JSON.parse(init.body)
    const user = body.messages.at(-1).content
    let output
    if (user.includes('# 修订组清单')) {
      const ids = [...user.matchAll(/\d+\. findingId：([^\n]+)/g)].map((match) => match[1])
      output = { revisions: ids.map((findingId) => ({ findingId, action: 'modify', rewrittenText: '双方明确本条事项和履行安排。', riskNote: '合成测试修订' })) }
    } else if (body.messages[0].content.includes('"completeness"')) {
      const round = Number(user.match(/# 第 (\d) 轮审查/)?.[1] || 1)
      output = { conclusion: '合成审查结果', findings: round === 1 ? [findings[0], { ...findings[0], title:'首轮待核对事项', quote:'不在原文中的虚构句子', location:'未知条款', risk:'原文定位待核对', advice:'请核对实际约定' }] : round < 3 ? [findings[round - 1]] : [], completeness: [] }
    } else output = { groups: [] }
    const content = JSON.stringify(output)
    return body.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      : Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] })
  }
  const state = harness([
    ['parsing', { parsedText: source }],
    ['analysis', { analysisReport: '## 合同基本信息\n虚构合同，用于验证工作流。' }],
    ['knowledge', { evidence: [], reviewPlan: { contractType: '劳动合同', topics: [] }, wholeTemplate: null }]
  ])
  const args = { ...state, task: { id: 'first-round-commercial', userId: 'synthetic-user', mode: 'fast' },
    files: [{ originalname: '虚构合同.txt', mimetype: 'text/plain', buffer: Buffer.from(source) }], fakeLlm: false }
  const result = await runContractReview(args)
  assertSequence(state.events, result)
  assert.match(result.firstRoundReport, /合同基本信息/)
  assert.match(result.firstRoundReport, /重点风险与处理建议/)
  // 实时审查正文：每块/每轮更新一次，覆盖第 1～3 轮，且不含 firstRoundReport 字段。
  const live = state.events.filter(({ event, data }) => event === 'review.delta' && data.live)
  assert.ok(live.length, '必须推送实时审查正文')
  assert.ok(live.every(({ data }) => data.replace === true && data.firstRoundReport === undefined))
  assert.ok(live.some(({ data }) => Number(data.round) > 1), '第 2/3 轮也要有实时正文')
  assert.ok(live.at(-1).data.content.includes('第二轮每周休息安排') || live.at(-1).data.content.includes('未发现'), '实时正文使用当前累计发现')
  // 逐批修订增量：批次完成后右栏可渐进展示批注。
  const rewriteDeltas = state.events.filter(({ event }) => event === 'rewrite.delta')
  assert.ok(rewriteDeltas.length, '必须推送逐批修订增量')
  assert.ok(rewriteDeltas.every(({ data }) => data.partial === true && Array.isArray(data.revisions)))
  assert.ok(rewriteDeltas.at(-1).data.done === rewriteDeltas.at(-1).data.total, '最后一批需覆盖全部修订组')
  assert.equal(rewriteDeltas.at(-1).data.contractText, source, '增量需带合同原文，供右栏直接渲染')
  assert.match(result.firstRoundReport, /待核对：首轮待核对事项[\s\S]*请核对实际约定/, '无法定位的首轮问题仍可阅读，且不猜批注位置')
  assert.equal(state.saved.get('review').result.firstRoundReport, result.firstRoundReport)

  const completeCalls = calls
  state.events.length = 0
  assert.equal((await runContractReview(args)).firstRoundReport, result.firstRoundReport)
  assert.equal(calls, completeCalls, '完成检查点恢复不再请求模型')
  assertSequence(state.events, result, { fake: true })
  assert.deepEqual(state.events.filter(({event, data}) => event === 'review.round' && data.phase === 'end').map(({data}) => ({ round: data.round, newCount: data.newCount, newFindings: data.newFindings })), result.reviewRounds.map(({round, newCount, newFindings}) => ({round, newCount, newFindings})), '完成检查点恢复不发送会覆盖真实发现的占位轮次')
  const replay = state.events.reduce((report, {event, data}) => reduceLaborProgress(report, event, data), {})
  assert.equal(replay.reviewStoppedEarly, undefined, '正常三轮恢复不会错误标记提前停止')

  // Resume a worker immediately after first-round completion, before round 2.
  const resumed = harness([
    ...['parsing', 'analysis', 'knowledge'].map((stage) => [stage, state.saved.get(stage).result]),
    ['review', { combinedFindings: [findings[0]], accumulatedSummary: [findings[0]],
      roundSnapshots: result.reviewRounds.slice(0, 1), totalRoundsExecuted: 1,
      firstRoundReport: result.firstRoundReport }]
  ])
  const restored = await runContractReview({ ...args, ...resumed, task: { ...args.task, id: 'resumed-commercial' } })
  assertSequence(resumed.events, restored)
  assert.equal(restored.firstRoundReport, result.firstRoundReport)
  assert.equal(resumed.events.some(({ event, data }) => event === 'review.round' && data.round === 1 && data.phase === 'start'), false)
  const fake = harness()
  const fakeResult = await runContractReview({ ...args, ...fake, fakeLlm: true })
  assertSequence(fake.events, fakeResult, { fake: true })
  assert.equal(fake.saved.get('review').result.firstRoundReport, fakeResult.firstRoundReport)
}

async function labor(dispatch = false) {
  globalThis.fetch = async () => { throw new Error('External requests forbidden in labor first-round regression') }
  const topics = dispatch ? LABOR_DISPATCH_ANALYSIS_TOPICS : LABOR_CONTRACT_ANALYSIS_TOPICS
  const coverage = topics.map(({ id, label }) => ({ id, topic: label, status: 'covered', summary: '合成样例已覆盖' }))
  let calls = 0
  const factory = dispatch ? createLaborDispatchAnalysisWorkflow : createLaborContractAnalysisWorkflow
  const workflow = factory({ retrieveEvidence: async () => [], getLawCatalog: async () => [], consolidate: async () => '',
    rewrite: async ({ findings: groups }) => JSON.stringify({ revisions: groups.map(({ id }) => ({
      findingId: id, action: 'modify', rewrittenText: '双方明确本条事项和履行安排。', riskNote: '合成测试修订' })) }),
    streamGenerate: async function* ({ phase, userMessage }) {
      calls++
      // 结构分析是 Markdown 流式阶段，不按 JSON 桩返回。
      if (phase === 'structure') {
        yield { content: ['# 合同基础识别', '- 合同类型：劳动合同', '- 合同子类型：固定期限', '- 类型判定依据：合成依据',
          '- 交易角色与主体：', '  - 用人单位（甲方）：名称：【单位A】', '- 合同目的与标的：合成标的',
          '- 已识别附件/引用文件：未识别到附件或引用文件', '', '# 条款结构图', '按原文顺序列出：',
          '- 第一条｜合成条款｜合成约定｜文本状态：完整', '', '# 要素完整性核查',
          ...LABOR_CONTRACT_COMPLETENESS_ELEMENTS.map((name) => `- ${name}：待确认（全文未提及）`),
          '', '# 文本一致性与待确认事项', '- 格式与编号：编号连续', '- 金额大小写：未发现异常', '- 日期：未发现异常',
          '- 主体称谓：未发现异常', '- 附件引用：未发现异常', '- 交叉条款冲突：未发现可直接指认的冲突。',
          '', '待确认事项（需用户补充的交易事实）：', '- 合成待确认事项。'].join('\n'), finishReason: 'stop' }
        return
      }
      let value
      if (phase === 'review') {
        const round = Number(userMessage.match(/审查轮次：第 (\d)/)?.[1] || 1)
        value = { contractInfo: { employer: '单位A', term: '两年' }, agreementInfo: { dispatchTerm: '两年' }, coverage,
          findings: round < 3 ? [findings[round - 1]] : [], roundComplete: true }
      } else if (phase === 'quality') {
        value = { complete: true, decisions: JSON.parse(userMessage).candidates.map(({ candidateId }) => ({ candidateId, kind: 'risk', reason: '保留合成测试独立问题' })) }
      } else if (phase === 'assessment') value = { score: 80, conclusion: '合成测试总结', complete: true }
      else if (phase === 'dependencies') value = { complete: true, independentIds: JSON.parse(userMessage).groups.map(({ id }) => id), serialIds: [] }
      else if (phase === 'final-check') value = { complete: true, conflicts: [] }
      else throw new Error(`Unexpected phase: ${phase}`)
      const content = JSON.stringify(value)
      yield { content: content.slice(0, Math.floor(content.length / 2)) }
      yield { content: content.slice(Math.floor(content.length / 2)), finishReason: 'stop' }
    }
  })
  const state = harness()
  const args = { ...state, task: { id: `first-round-labor-${dispatch}`, mode: 'fast' },
    input: { action: 'analyze', ...(dispatch ? { analysisType: 'labor_dispatch_agreement', reviewPerspective: 'using_unit' } : {}) },
    sourceDocuments: [{ fileId: 'synthetic-source', fileName: '虚构样例.txt', text: source, ...(dispatch ? { role: 'dispatch_agreement' } : {}) }] }
  const result = await workflow(args)
  assertSequence(state.events, result, { requireLive: false })
  // 报告格式已与商业审查对齐：首轮报告是「审查结论 + 重点风险与处理建议 + 审查说明」。
  assert.match(result.firstRoundReport, /# 审查结论/)
  assert.match(result.firstRoundReport, /# 重点风险与处理建议/)
  assert.match(result.firstRoundReport, /# 审查说明/)
  assert.doesNotMatch(result.firstRoundReport, /# 劳动合同分析结果/, '旧版报告标题不再出现')
  // 结构分析概览承载合同基础识别，别名必须还原为原文主体。
  assert.match(result.analysisOverview, /# 合同基础识别/)
  assert.match(result.analysisOverview, /北京测试有限公司/, '结构分析需将单位别名还原为原文主体')
  assert.equal(state.saved.get('review').result.firstRoundReport, result.firstRoundReport)
  const completeCalls = calls
  assert.equal((await workflow(args)).firstRoundReport, result.firstRoundReport)
  assert.equal(calls, completeCalls, '分析结果恢复不再请求模型')

  const rawFirstRound = state.saved.get('review').result.firstRoundSource
  const resumed = harness([
    ['review', { generated: rawFirstRound, combinedFindings: rawFirstRound.findings,
      firstRoundSource: rawFirstRound, firstRoundReport: result.firstRoundReport,
      totalRoundsExecuted: 1, roundSnapshots: result.reviewRounds.slice(0, 1) }]
  ])
  const restored = await workflow({ ...args, ...resumed })
  assertSequence(resumed.events, restored, { requireLive: false })
  assert.equal(restored.firstRoundReport, result.firstRoundReport)
  assert.equal(resumed.events.some(({ event, data }) => event === 'review.round' && data.round === 1 && data.phase === 'start'), false)
  const fake = harness()
  const fakeResult = await workflow({ ...args, ...fake, fakeLlm: true })
  assertSequence(fake.events, fakeResult, { fake: true })
  assert.equal(fake.saved.get('review').result.firstRoundReport, fakeResult.firstRoundReport)
}

try {
  await commercial()
  await labor()
  await labor(true)
  console.log('First-round sequencing: commercial, labor, dispatch, checkpoints, restart and fake paths passed')
} finally {
  globalThis.fetch = originalFetch
}
