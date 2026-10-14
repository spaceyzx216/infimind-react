import assert from 'node:assert/strict'
import { isReviewProgressVisible } from '../../src/utils/review-presentation.js'
import { reduceLaborProgress } from '../../src/utils/labor-progress.js'
import { LABOR_CONTRACT_REVIEW_SYSTEM_PROMPT } from '../prompts/labor-contract-analysis.js'

const events = [
  ['review.round', { phase: 'start', round: 1 }],
  ['review.delta', { content: '第一轮风险' }],
  ['review.round', { phase: 'end', round: 1, newCount: 2, newFindings: [{ title: '风险一' }] }],
  ['review.round', { phase: 'start', round: 2 }],
  ['review.round', { phase: 'end', round: 2, newCount: 1, newFindings: [{ title: '风险二' }] }],
  ['review.round', { phase: 'start', round: 3 }],
  ['review.delta', { content: '第三轮累计风险' }],
  ['rewrite.result', { revisions: [{ findingId: 'one' }], stats: { groups: 1 } }]
]
const restore = () => events.reduce((report, [event, data]) => reduceLaborProgress(report, event, data), {})
const snapshot = restore()
assert.equal(snapshot.activeReviewRound, 3)
assert.equal(snapshot.reviewReport, '第三轮累计风险')
assert.deepEqual(snapshot.reviewRounds.map((round) => round.round), [1, 2])
assert.deepEqual(restore(), snapshot, '刷新重建快照不追加历史内容')
assert.equal(reduceLaborProgress(snapshot, 'review.round', { phase: 'end', round: 2, newCount: 3 }).reviewRounds.length, 2)
const info = reduceLaborProgress(snapshot, 'analysis.section', { section: 'contractInfo', item: { term: '待确认' } })
assert.equal(info.contractInfo.term, '待确认')
assert.equal(snapshot.contractInfo, undefined, '不修改旧快照')
assert.equal(reduceLaborProgress(snapshot, 'model.progress', { message: '连接心跳' }), snapshot, '连接心跳不重绘风险全文')
assert.equal(reduceLaborProgress(snapshot, 'rewrite.result', { revisions: [{ findingId: 'one' }, { findingId: 'two' }] }).revisions.length, 2)
// 同一任务重跑生成前，后端会发 analysis.reset：必须清掉上一轮流式草稿。
const streamed = reduceLaborProgress(snapshot, 'analysis.delta', { content: '# 合同基础识别\n- 合同类型：劳动合同' })
assert.equal(streamed.analysisOverview, '# 合同基础识别\n- 合同类型：劳动合同')
const appended = reduceLaborProgress(streamed, 'analysis.delta', { content: '\n继续' })
assert.equal(appended.analysisOverview, '# 合同基础识别\n- 合同类型：劳动合同\n继续', '不带 replace 的增量必须追加')
const reset = reduceLaborProgress(appended, 'analysis.reset', { reason: 'generation-start' })
assert.equal(reset.analysisOverview, '', 'analysis.reset 必须清空结构分析草稿，否则新旧两遍会首尾相接')
assert.equal(reset.reviewReport, '')
assert.deepEqual(reset.reviewRounds, [])
assert.deepEqual(reset.revisions, [])
assert.match(LABOR_CONTRACT_REVIEW_SYSTEM_PROMPT, /没有单独写明不等于违法/)
assert.match(LABOR_CONTRACT_REVIEW_SYSTEM_PROMPT, /限定条件和例外/)
assert.match(LABOR_CONTRACT_REVIEW_SYSTEM_PROMPT, /工资、经济补偿、赔偿/)
console.log('劳动合同历史快照、重复轮次及质量提示约束回归通过')

const firstText = '## 合同基本信息\n合成合同\n## 重点风险与处理建议\n首轮工资问题'
let staged = reduceLaborProgress({}, 'review.round', { phase: 'start', round: 1 })
assert.equal(isReviewProgressVisible(staged), false, '首轮开始不得抢先显示进度面板')
staged = reduceLaborProgress(staged, 'review.delta', { content: firstText, firstRoundReport: firstText, round: 1, replace: true })
assert.equal(staged.firstRoundReport, firstText)
assert.equal(isReviewProgressVisible(staged), false, '首轮正文输出期间仍隐藏进度面板')
staged = reduceLaborProgress(staged, 'review.round', { phase: 'end', round: 1, newCount: 1 })
assert.equal(isReviewProgressVisible(staged), true, '首轮输出完成后显示进度面板')
staged = reduceLaborProgress(staged, 'review.round', { phase: 'start', round: 2 })
staged = reduceLaborProgress(staged, 'review.delta', { content: '二轮累计问题', replace: true })
assert.equal(staged.firstRoundReport, firstText, '后续累计报告不污染首轮正文')
assert.equal(staged.reviewReport, '二轮累计问题', '完整报告仍保留用于报告功能')
const sanitized = firstText.replace('首轮工资问题', '首轮无确认风险')
staged = reduceLaborProgress(staged, 'review.delta', { content: sanitized, firstRoundReport: sanitized, round: 1, replace: true })
assert.equal(staged.firstRoundReport, sanitized, '质量过滤后可替换首轮结果')
const restored = reduceLaborProgress({}, 'stage.complete', { stage: 'review', roundSnapshots: [{ round: 1, newCount: 1 }] })
assert.equal(isReviewProgressVisible(restored), true, '完成快照单独恢复也显示进度')
assert.equal(restored.reviewFinished, true)
assert.equal(isReviewProgressVisible({ reviewRounds: [{ round: 1 }] }), true, '旧任务首轮快照兼容')
assert.equal(isReviewProgressVisible({ activeReviewRound: 1 }), false)
assert.equal(isReviewProgressVisible({ activeReviewRound: 2 }), true)
assert.equal(isReviewProgressVisible(), false)
assert.equal(isReviewProgressVisible(null), false)
assert.equal(reduceLaborProgress({}, 'review.round', {phase:'end', round:3, newCount:0}).reviewStoppedEarly, undefined, '第三轮正常结束不标为提前停止')
console.log('首轮正文冻结、面板顺序、质量过滤与刷新恢复回归通过')
