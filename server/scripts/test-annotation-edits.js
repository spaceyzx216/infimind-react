// 批注人工编辑与导出契约回归（商业合同审查 / 劳动合同分析共用）。
//
// 为什么需要：批注稿里的每条意见都必须能被人工改写成最终版本，而复制、下载 Word、
// 页面渲染三条路径必须取同一份「原文 + 人工编辑」派生结果。这里锁定三件事：
//   1. 编辑按批注 id（findingId / editId）覆盖，绝不改服务端下发的原文定位数据；
//   2. 编号、挂行、高亮合并口径不变，编辑后批注仍钉在原句上；
//   3. 复制导出的纯文本批注稿带的是最后确认的意见，没有编辑时逐字退回原文。
import assert from 'node:assert/strict'
import {
  annotationTargetOf,
  attachRevisionsToLines,
  buildDisplayRevisions,
  buildRevisionPlainText,
  clearAnnotationEdit,
  countAnnotationEdits,
  mergeQuoteMarks,
  normalizeAnnotationEditStore,
  normalizeAnnotationEdits,
  setAnnotationEdit
} from '../../src/utils/revision-annotations.js'

let count = 0
const test = (name, run) => { run(); count++; console.log(`PASS ${name}`) }

const CONTRACT = [
  '# 采购框架协议',
  '',
  '第一条 甲方应在收到发票后九十个自然日内付款。',
  '第二条 乙方逾期交货的，按日万分之五支付违约金。',
  '第三条 本合同自双方签字之日起生效。'
].join('\n')

// 服务端结果：一条挂局部编辑（replace + notice 两种），一条新增条款（无局部锚点）。
const REVISIONS = [
  {
    findingId: 'finding-pay',
    action: 'modify',
    level: '高',
    lineStart: 2,
    lineEnd: 2,
    rewrittenText: '第一条 甲方应在收到发票后三十个自然日内付款，逾期付款的按日万分之三支付违约金。',
    riskNote: '付款期限过长，占用乙方现金流。',
    localizedEdits: [{
      editId: 'finding-pay-local-1',
      markerNumber: 1,
      operation: 'replace',
      targetQuote: '九十个自然日内付款',
      replacementText: '三十个自然日内付款',
      riskNote: '账期超出行业惯例。',
      quoteSpans: [{ line: 2, start: 13, end: 22 }]
    }, {
      editId: 'finding-pay-local-2',
      markerNumber: 2,
      operation: 'notice',
      targetQuote: '收到发票后',
      replacementText: '',
      noticeText: '请确认起算凭据是发票还是验收单。',
      quoteSpans: [{ line: 2, start: 8, end: 13 }]
    }]
  },
  {
    findingId: 'finding-penalty',
    action: 'add',
    level: '中',
    title: '补充违约金上限',
    insertAfterLine: 3,
    anchorText: '第三条 本合同自双方签字之日起生效。',
    rewrittenText: '违约金累计不超过合同总价的百分之五。',
    riskNote: '避免违约金过高被调减。'
  }
]

test('无人工编辑时展示口径与旧实现一致', () => {
  const display = buildDisplayRevisions(REVISIONS)
  assert.deepEqual(display.map((rev) => rev.findingId), ['finding-pay-local-1', 'finding-pay-local-2', 'finding-penalty'])
  assert.deepEqual(display.map((rev) => rev.markerNumber), [1, 2, null])
  assert.deepEqual(display.map((rev) => rev.isLocalized), [true, true, false])
  assert.equal(display[0].rewrittenText, '三十个自然日内付款')
  assert.equal(display[0].fullRewrittenText, REVISIONS[0].rewrittenText)
  assert.equal(display[1].operation, 'notice')
  // add 修订块挂在服务端解析出的插入锚点行之后。
  const { byLine } = attachRevisionsToLines(CONTRACT.split('\n'), display)
  assert.deepEqual([...byLine.keys()].sort((a, b) => a - b), [2, 3])
  assert.equal(byLine.get(3)[0].findingId, 'finding-penalty')
})

test('人工编辑按批注 id 覆盖展示字段，定位数据保持服务端结果', () => {
  const edits = setAnnotationEdit(setAnnotationEdit({}, 'finding-pay-local-1', { rewrittenText: '三十日内付款', riskNote: '财务已确认可接受。' }), 'finding-penalty', { title: '补充违约金上限（已确认）', rewrittenText: '违约金累计不超过合同总价的百分之三。' })
  const display = buildDisplayRevisions(REVISIONS, edits)
  const first = display.find((rev) => rev.findingId === 'finding-pay-local-1')
  assert.equal(first.rewrittenText, '三十日内付款')
  assert.equal(first.riskNote, '财务已确认可接受。')
  assert.equal(first.edited, true)
  assert.equal(first.lineStart, 2)
  assert.deepEqual(first.quoteSpans, [{ line: 2, start: 13, end: 22 }])
  assert.equal(first.markerNumber, 1)
  // 同一 finding 下的另一条局部批注不受影响。
  assert.equal(display.find((rev) => rev.findingId === 'finding-pay-local-2').edited, undefined)
  assert.equal(display.find((rev) => rev.findingId === 'finding-pay-local-2').noticeText, '请确认起算凭据是发票还是验收单。')
  const added = display.find((rev) => rev.findingId === 'finding-penalty')
  assert.equal(added.title, '补充违约金上限（已确认）')
  assert.equal(added.rewrittenText, '违约金累计不超过合同总价的百分之三。')
  assert.equal(countAnnotationEdits(edits), 2)
})

test('处理方式改成删除/提示后渲染与导出同步生效', () => {
  const edits = setAnnotationEdit({}, 'finding-pay-local-1', { operation: 'delete' })
  const display = buildDisplayRevisions(REVISIONS, edits)
  assert.equal(display[0].operation, 'delete')
  const text = buildRevisionPlainText({ title: '合同审查批注稿', text: CONTRACT, revisions: REVISIONS, annotationEdits: edits })
  assert.ok(text.includes('【1】删除此处：删除该问题片段'))
  assert.ok(!text.includes('【1】改为：三十个自然日内付款'))
  const noticeEdit = setAnnotationEdit({}, 'finding-pay-local-2', { noticeText: '请确认发票签收记录由谁保管。' })
  assert.ok(buildRevisionPlainText({ title: 'x', text: CONTRACT, revisions: REVISIONS, annotationEdits: noticeEdit }).includes('请确认发票签收记录由谁保管。'))
})

test('复制导出的纯文本批注稿取最终确认意见，并标注人工修改条数', () => {
  const plain = buildRevisionPlainText({ title: '劳动合同审查批注稿', text: CONTRACT, revisions: REVISIONS })
  assert.ok(plain.startsWith('劳动合同审查批注稿（最终确认意见）'))
  assert.ok(plain.includes('共 3 条批注。'))
  // 原文行内插入编号，与文档高亮一一对应；编号紧跟被标记的片段。
  assert.ok(plain.includes('第一条 甲方应在收到发票后九十个自然日内付款【1·2】。'))
  assert.ok(plain.includes('【1】改为：三十个自然日内付款'))
  assert.ok(plain.includes('【2】提示：请确认起算凭据是发票还是验收单。'))
  assert.ok(plain.includes('【新增】补充违约金上限'))
  assert.ok(plain.includes('插入于“第三条 本合同自双方签字之日起生效。”之后'))
  // 意见块紧跟在对应原文行之后，顺序与文档一致。
  const lines = plain.split('\n')
  const sourceLineIndex = lines.findIndex((line) => line.startsWith('第一条 甲方应在收到发票后'))
  assert.ok(sourceLineIndex >= 0 && sourceLineIndex < lines.findIndex((line) => line.startsWith('【1】改为')))
  assert.ok(lines.findIndex((line) => line.startsWith('【2】提示')) < lines.indexOf('第二条 乙方逾期交货的，按日万分之五支付违约金。'))

  const edited = setAnnotationEdit({}, 'finding-pay-local-1', { rewrittenText: '三十日内付款（财务已确认）' })
  const editedPlain = buildRevisionPlainText({ title: 'x', text: CONTRACT, revisions: REVISIONS, annotationEdits: edited })
  assert.ok(editedPlain.includes('【1】改为：三十日内付款（财务已确认）'))
  assert.ok(!editedPlain.includes('【1】改为：三十个自然日内付款'))
  assert.ok(editedPlain.includes('其中 1 条已人工修改'))
  assert.ok(editedPlain.includes('原片段：九十个自然日内付款'))
})

test('多行意见与空编辑的边界处理', () => {
  const edits = setAnnotationEdit({}, 'finding-penalty', { rewrittenText: '第一行\n第二行' })
  const plain = buildRevisionPlainText({ title: 'x', text: CONTRACT, revisions: REVISIONS, annotationEdits: edits })
  assert.ok(plain.includes('  第一行\n  第二行'))
  // 没有任何批注时不加“最终确认意见”表头，逐字返回原文（保持旧的复制原文行为）。
  assert.equal(buildRevisionPlainText({ title: 'x', text: CONTRACT, revisions: [] }), CONTRACT)
  // 空 patch 不写入、恢复后回到模型原稿。
  assert.equal(countAnnotationEdits(setAnnotationEdit({}, 'finding-pay-local-1', {})), 0)
  const reset = clearAnnotationEdit(edits, 'finding-penalty')
  assert.equal(countAnnotationEdits(reset), 0)
  assert.equal(buildDisplayRevisions(REVISIONS, reset).find((rev) => rev.findingId === 'finding-penalty').rewrittenText, '违约金累计不超过合同总价的百分之五。')
})

test('持久化数据校验：非法字段与非法处理方式被丢弃', () => {
  const stored = normalizeAnnotationEdits({
    'finding-pay-local-1': { rewrittenText: '三十日内付款', operation: 'rewrite-everything', lineStart: 99, injected: '<script>' },
    'finding-pay-local-2': { noticeText: 42 },
    '': { rewrittenText: 'x' },
    broken: 'not-an-object'
  })
  assert.deepEqual(stored, { 'finding-pay-local-1': { rewrittenText: '三十日内付款' } })
  assert.equal(countAnnotationEdits(null), 0)
  assert.equal(countAnnotationEdits([1, 2]), 0)
  const display = buildDisplayRevisions(REVISIONS, normalizeAnnotationEdits({ 'finding-pay-local-1': { lineStart: 99 } }))
  assert.equal(display[0].lineStart, 2)
})

test('劳动合同分析的分桶编辑表：刷新后仍按任务 id 还原（回归：嵌套结构被当成单层 patch 丢弃）', () => {
  const store = normalizeAnnotationEditStore({
    'task-a': { 'finding-pay-local-1': { rewrittenText: '三十日内付款' } },
    'task-b': { 'finding-pay-local-2': { riskNote: '已确认。', operation: 'not-an-operation' } },
    'task-c': {},
    '': { 'finding-pay-local-1': { rewrittenText: 'x' } },
    broken: 'oops'
  })
  assert.deepEqual(store, {
    'task-a': { 'finding-pay-local-1': { rewrittenText: '三十日内付款' } },
    'task-b': { 'finding-pay-local-2': { riskNote: '已确认。' } }
  })
  // 还原后确实作用到该任务的批注上。
  const taskDisplay = buildDisplayRevisions(REVISIONS, store['task-a'])
  assert.equal(taskDisplay[0].rewrittenText, '三十日内付款')
  assert.equal(taskDisplay[0].edited, true)
  assert.equal(countAnnotationEdits(store['task-b']), 1)
  assert.deepEqual(normalizeAnnotationEditStore(null), {})
  assert.deepEqual(normalizeAnnotationEditStore([1, 2]), {})
})

test('重跑后同 ID 换了条款：锚点不一致的人工意见被丢弃（回归：意见串到别的条款）', () => {
  const target = annotationTargetOf(buildDisplayRevisions(REVISIONS)[0])
  const edits = setAnnotationEdit({}, 'finding-pay-local-1', { rewrittenText: '三十日内付款' }, target)
  assert.equal(countAnnotationEdits(edits), 1)
  // 同一份结果刷新：锚点一致，编辑照常生效。
  const same = buildDisplayRevisions(REVISIONS, edits)
  assert.equal(same[0].rewrittenText, '三十日内付款')
  assert.equal(same[0].edited, true)
  // 重跑后同一个位置序号换了条款（行号与原文片段都变了）：人工意见不能套过去。
  const rerun = [{
    findingId: 'finding-pay', action: 'modify', level: '中', lineStart: 3, lineEnd: 3,
    rewrittenText: '第二条 乙方逾期交货的，按日万分之三支付违约金。', riskNote: '重跑意见。',
    localizedEdits: [{
      editId: 'finding-pay-local-1', markerNumber: 1, operation: 'replace',
      targetQuote: '按日万分之五支付违约金', replacementText: '按日万分之三支付违约金',
      riskNote: '重跑意见。', quoteSpans: [{ line: 3, start: 8, end: 19 }]
    }]
  }]
  const after = buildDisplayRevisions(rerun, edits)
  assert.equal(after[0].rewrittenText, '按日万分之三支付违约金')
  assert.equal(after[0].edited, undefined)
  // 没有 target 的旧记录继续按原样生效，不因升级丢用户已保存的意见。
  const legacy = buildDisplayRevisions(rerun, { 'finding-pay-local-1': { rewrittenText: '三十日内付款' } })
  assert.equal(legacy[0].rewrittenText, '三十日内付款')
  // 锚点指纹只进存储，不进渲染结果。
  assert.equal('target' in same[0], false)
  assert.equal(annotationTargetOf({ action: 'add', insertAfterLine: 4, anchorText: '第二条' }), annotationTargetOf({ action: 'add', insertAfterLine: 4, anchorText: '第二条' }))
  assert.notEqual(annotationTargetOf({ action: 'add', insertAfterLine: 4, anchorText: '第二条' }), annotationTargetOf({ action: 'add', insertAfterLine: 5, anchorText: '第二条' }))
})

test('高亮片段合并与编号口径不变', () => {
  const line = '  第一条 甲方应在收到发票后九十个自然日内付款。'
  // 服务端偏移基于未 trim 的原始行；重叠片段合并后保留全部编号，越界片段被丢弃。
  const spans = [
    { start: 16, end: 25, markerNumber: 1 },
    { start: 21, end: 27, markerNumber: 2 },
    { start: 200, end: 210, markerNumber: 3 }
  ]
  const { text, merged } = mergeQuoteMarks(line, spans)
  assert.equal(text, '第一条 甲方应在收到发票后九十个自然日内付款。')
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].markerNumbers, [1, 2])
  // 前导两格空白从偏移里扣除，合并区间收敛到 [14, 23)。
  assert.equal(merged[0].start, 14)
  assert.equal(merged[0].end, 23)
  assert.equal(text.slice(merged[0].start, merged[0].end), '十个自然日内付款。')
})

test('缺少 findingId 的批注仍可编辑，编号键稳定且互不覆盖', () => {
  const revisions = [
    { action: 'modify', lineStart: 2, lineEnd: 2, rewrittenText: 'A', localizedEdits: [{ operation: 'replace', targetQuote: '付款', replacementText: 'A', quoteSpans: [{ line: 2, start: 5, end: 7 }] }] },
    { action: 'modify', lineStart: 3, lineEnd: 3, rewrittenText: 'B', localizedEdits: [{ operation: 'replace', targetQuote: '违约金', replacementText: 'B', quoteSpans: [{ line: 3, start: 5, end: 8 }] }] }
  ]
  const first = buildDisplayRevisions(revisions)
  assert.deepEqual(first.map((rev) => rev.findingId), ['annotation-0', 'annotation-1'])
  const edits = setAnnotationEdit({}, 'annotation-1', { rewrittenText: 'B2' })
  const second = buildDisplayRevisions(revisions, edits)
  assert.equal(second[0].rewrittenText, 'A')
  assert.equal(second[1].rewrittenText, 'B2')
  assert.equal(second[1].edited, true)
})

test('越界与损坏的修订数据不产生幻影批注', () => {
  const display = buildDisplayRevisions([null, [], { findingId: 'x', action: 'modify', lineStart: 99, lineEnd: 99, localizedEdits: [{ editId: 'x-1', operation: 'replace', replacementText: 'y' }] }])
  assert.equal(display.length, 1)
  const { byLine, quoteMarks } = attachRevisionsToLines(CONTRACT.split('\n'), display)
  assert.equal(byLine.size, 0)
  assert.equal(quoteMarks.size, 0)
  assert.equal(buildDisplayRevisions(null).length, 0)
})

console.log(`Annotation edits: ${count} scenarios passed`)
