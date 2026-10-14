// 报告格式契约：劳动合同分析的文字输出必须与商业合同审查的章节结构一致。
// 全部为合成合同与注入的模型桩，不触达真实模型、网络或项目数据库。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLaborContractAnalysisWorkflow } from '../workflows/labor-contract-analysis.js'
import { LABOR_CONTRACT_COMPLETENESS_ELEMENTS, LABOR_CONTRACT_ANALYSIS_TOPICS } from '../prompts/labor-contract-analysis.js'

const quote = (index) => createHash('sha256').update(`format-clause-${index}`).digest('hex')
const finding = (index) => ({ topic: '薪酬', level: '高', title: `条款${quote(index).slice(0, 12)}`,
  location: `第${index + 1}条`, quote: quote(index), issueClause: quote(index).slice(0, 24),
  risk: `合成风险${index}`, advice: '合成建议', applicableConditions: ['合成前提'], supportingEvidenceIds: [] })
const structure = [
  '# 合同基础识别',
  '- 合同类型：劳动合同',
  '- 合同子类型：固定期限',
  '- 类型判定依据：合同标题为“劳动合同”，第一条约定合同期限。',
  '- 交易角色与主体：',
  '  - 用人单位（甲方）：名称：合成公司；统一社会信用代码/证件信息：9133***；法定代表人/授权代表人：合成代表',
  '  - 劳动者（乙方）：信息空白未填写',
  '- 合同目的与标的：合成岗位与劳动报酬约定。',
  '- 已识别附件/引用文件：',
  '  - 附件1：岗位说明书——已提供模板，内容空白',
  '',
  '# 条款结构图',
  '按原文顺序列出：',
  '- 首部｜无编号说明｜合成首部约定｜文本状态：完整',
  '- 第一条｜合同期限｜期限一年，起止日期空白｜文本状态：空白',
  '',
  '# 要素完整性核查',
  '- 合同期限：待确认（第一条）。起止日期空白',
  '- 主体与授权：未约定（签署栏）',
  ...LABOR_CONTRACT_COMPLETENESS_ELEMENTS.filter((name) => !['合同期限', '主体与授权'].includes(name))
    .map((name) => `- ${name}：待确认（全文未提及）`),
  '',
  '# 文本一致性与待确认事项',
  '- 格式与编号：条款编号连续',
  '- 金额大小写：金额小写与大写均为空白',
  '- 日期：签署日期空白',
  '- 主体称谓：称谓一致',
  '- 附件引用：附件1为模板未填写',
  '- 交叉条款冲突：',
  '  - 第二条2.3 与 第十三条13.3：两处权利配置互相印证',
  '',
  '待确认事项（需用户补充的交易事实）：',
  '- 补充劳动者姓名与证件信息。',
  '- 补充合同起止日期。'
].join('\n')

const coverage = LABOR_CONTRACT_ANALYSIS_TOPICS.map(({ id, label }) => ({ id, topic: label, status: 'covered', summary: '合成覆盖' }))
const saved = new Map()
const events = []
const documents = [{ fileName: '合成劳动合同.txt', text: Array.from({ length: 40 }, (_, index) => `第${index + 1}条\n${quote(index)}`).join('\n') }]
const workflow = createLaborContractAnalysisWorkflow({
  retrieveEvidence: async () => [], getLawCatalog: async () => [],
  consolidate: async () => '', rewrite: async ({ findings }) => JSON.stringify({ revisions: findings.map(({ id }) => ({ findingId: id,
    action: 'modify', rewrittenText: '双方依法明确本条执行程序。', riskNote: '结合完整条款核对。' })) }),
  streamGenerate: async function* (request) {
    // 结构分析按 Markdown 逐块流式输出：只有最后一块带结束标记。
    if (request.phase === 'structure') {
      const chunks = structure.match(/[\s\S]{1,40}/g) || []
      for (const [index, chunk] of chunks.entries()) {
        yield { content: chunk, ...(index === chunks.length - 1 ? { finishReason: 'stop' } : {}) }
      }
      return
    }
    const byPhase = request.phase === 'assessment' ? { score: 82, conclusion: '合成整体结论。', complete: true }
        : request.phase === 'quality' ? { decisions: JSON.parse(request.userMessage).candidates.map(({ candidateId }) => ({ candidateId, kind: 'risk', reason: '合成保留' })), complete: true }
          : request.phase === 'dependencies' ? { independentIds: JSON.parse(request.userMessage).groups.map((group) => group.id), serialIds: [], complete: true }
            : request.phase === 'final-check' ? { conflicts: [], complete: true } : null
    if (byPhase) { yield { content: JSON.stringify(byPhase), finishReason: 'stop' }; return }
    yield { content: JSON.stringify({ contractInfo: {}, coverage, findings: [finding(0), finding(1)], roundComplete: true }), finishReason: 'stop' }
  }
})
const result = await workflow({
  task: { id: 'format-contract', mode: 'fast' }, input: { action: 'analyze' }, sourceDocuments: documents,
  checkpoint: async (stage, value) => saved.set(stage, { result: value }), getCheckpoint: (stage) => saved.get(stage),
  emit: async (event, data) => events.push({ event, data })
})

const overview = result.analysisOverview
const review = result.reviewReport

// A 段：结构分析报告，四个章节与商业合同审查一致。
const aSections = ['# 合同基础识别', '# 条款结构图', '# 要素完整性核查', '# 文本一致性与待确认事项']
let cursor = -1
for (const section of aSections) {
  const at = overview.indexOf(section)
  assert.ok(at > cursor, `结构分析缺少或顺序错误：${section}`)
  cursor = at
}
for (const label of ['- 合同类型：', '- 合同子类型：', '- 类型判定依据：', '- 交易角色与主体：', '- 合同目的与标的：', '- 已识别附件/引用文件：']) {
  assert.ok(overview.includes(label), `合同基础识别缺少字段：${label}`)
}
assert.ok(overview.includes('- 用人单位（甲方）：名称：合成公司'), '主体必须逐项列出')
assert.ok(overview.includes('信息空白未填写'), '空白主体必须如实标注')
assert.ok(overview.includes('｜文本状态：空白'), '条款结构图必须带文本状态')
assert.ok(LABOR_CONTRACT_COMPLETENESS_ELEMENTS.every((name) => overview.includes(`\n- ${name}：`)), '要素完整性核查必须逐项列出清单')
assert.ok(overview.includes('- 合同期限：待确认（第一条）'), '要素状态与依据必须照实渲染')
assert.ok(overview.includes('- 竞业限制：待确认（全文未提及）'), '模型漏项必须补为待确认')
assert.ok(overview.includes('- 金额大小写：金额小写与大写均为空白'), '文本一致性必须逐项输出')
assert.ok(overview.includes('- 交叉条款冲突：'), '交叉条款冲突必须输出')
assert.ok(overview.includes('待确认事项（需用户补充的交易事实）：'), '待确认事项必须输出')
assert.ok(overview.includes('- 补充合同起止日期。'), '待确认事项必须来自结构分析结果')

// B 段：审查结论 / 逐条批注 / 完整性清单 / 审查说明。
const bSections = ['# 审查结论', '# 逐条批注', '# 审查说明']
cursor = -1
for (const section of bSections) {
  const at = review.indexOf(section)
  assert.ok(at > cursor, `审查报告缺少或顺序错误：${section}`)
  cursor = at
}
assert.ok(review.startsWith('# 审查结论\n合成整体结论。'), '审查结论必须紧跟标题且使用整体结论')
assert.ok(review.includes('## 【高】'), '风险等级必须渲染为 ## 【高】')
for (const label of ['- 定位：L', '- 位置：', '- 原文：', '- 问题子句：', '- 风险：', '- 建议：']) {
  assert.ok(review.includes(label), `逐条批注缺少字段：${label}`)
}
assert.ok(review.includes('# 审查说明\n结果供合同完善参考；'), '审查说明必须与商业口径一致')
assert.ok(!review.includes('# 劳动合同分析结果'), '不应再输出旧版报告标题')
assert.ok(!review.includes('### 【'), '不应再使用旧版三级风险标题')

// 流式阶段：与商业合同审查一致，首轮报告本身就是「结构分析 + 审查报告」两段拼接。
const firstRound = events.filter((item) => item.event === 'review.delta' && item.data?.replace).at(-1)?.data?.content || ''
assert.ok(firstRound.startsWith('# 合同基础识别'), '首轮报告必须以结构分析报告开头（与商业一致）')
assert.ok(firstRound.includes('# 条款结构图') && firstRound.includes('# 要素完整性核查'), '首轮报告必须同时带结构分析章节')
assert.ok(firstRound.includes('# 重点风险与处理建议'), '首轮报告必须使用“重点风险与处理建议”')
assert.ok(!firstRound.includes('# 逐条批注'), '首轮流式报告不应提前使用“逐条批注”')
const firstRoundSections = ['# 合同基础识别', '# 条款结构图', '# 要素完整性核查', '# 文本一致性与待确认事项', '# 审查结论', '# 重点风险与处理建议', '# 审查说明']
cursor = -1
for (const section of firstRoundSections) {
  const at = firstRound.indexOf(section)
  assert.ok(at > cursor, `首轮报告章节缺失或顺序错误：${section}`)
  cursor = at
}
assert.equal(result.firstRoundReport, firstRound, '持久化的首轮报告必须与流式内容一致')
// 首轮报告是整篇内容：整篇重发必须受时间窗限制，否则正文会一块一块反复重绘。
const reviewDeltaCount = events.filter((item) => item.event === 'review.delta').length
assert.ok(reviewDeltaCount <= 4, `首轮报告不得整篇反复重发（实际 ${reviewDeltaCount} 次）`)
const analysisDelta = events.filter((item) => item.event === 'analysis.delta').map((item) => item.data?.content || '').join('')
assert.ok(analysisDelta.startsWith('# 合同基础识别'), 'analysis.delta 仍是结构分析报告')
assert.ok(!analysisDelta.includes('## 审查摘要'), '不应再输出“审查摘要”占位标题')
// 结构分析必须逐块流式推送（而不是整段一次性弹出），且不得用 replace 反复重发整篇。
const overviewDeltas = events.filter((item) => item.event === 'analysis.delta')
assert.ok(overviewDeltas.length > 5, `结构分析必须分块流式输出（实际 ${overviewDeltas.length} 块）`)
assert.ok(overviewDeltas.every((item) => !item.data?.replace), '结构分析流式块不得整篇替换')
assert.equal(overviewDeltas.map((item) => item.data.content).join(''), structure, '流式块拼接必须等于完整结构报告')

// 结构分析结果要持久化，便于刷新与恢复。
assert.equal(saved.get('structure')?.result?.report, structure, '结构分析报告必须写入检查点')
assert.equal(result.structure?.report, structure)

console.log('PASS labor report format: structure analysis sections, clause map, element checklist, consistency checks, commercial field labels and streaming section names (synthetic only)')
