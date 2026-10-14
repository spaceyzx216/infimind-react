import assert from 'node:assert/strict'
import { buildHandbookAnnotations, handbookAnnotationText } from '../../src/utils/handbook-annotations.js'
import { formatHandbookReport } from '../../src/utils/handbook-result.js'

const documents = [{ fileId: 'a', fileName: '手册.txt', text: '第一章 考勤\n  实际出勤不得按旷工处理。\n仍保留原文。' },
  { fileId: 'b', fileName: '考勤.txt', text: '实际出勤仍按旷工处理。' }]
const evidence = (fileId, quote) => {
  const doc = documents.find((item) => item.fileId === fileId), startOffset = doc.text.indexOf(quote)
  return { quote, location: { status: 'found', matches: [{ fileId, fileName: doc.fileName, sectionTitle: '考勤', startOffset, endOffset: startOffset + quote.length }] } }
}
const finding = { id: 'f1', kind: 'conflict', title: '实际出勤规则冲突', level: 'high', status: 'risk', explanation: '两处规则无法同时执行。',
  recommendation: '核对实际出勤，统一认定规则。', conditions: ['同一员工、同一实际出勤条件'], suggestedClause: '建议整条规则，不能当成局部替换。',
  evidence: [evidence('a', '实际出勤不得按旷工处理。'), evidence('b', documents[1].text)] }
let count = 0
const test = (name, run) => { run(); count++; console.log(`PASS ${name}`) }
test('跨文件两处标记共用问题编号，条款建议不转为替换', () => {
  const result = buildHandbookAnnotations({ sourceDocuments: documents, findings: [finding] })
  assert.equal(result.unresolved.length, 0)
  for (const doc of result.documents) {
    assert.equal(doc.revisions[0].localizedEdits[0].markerNumber, 1)
    assert.equal(doc.revisions[0].localizedEdits[0].operation, 'notice')
    assert.equal(doc.revisions[0].localizedEdits[0].replacementText, '')
    assert.equal(doc.revisions[0].rewrittenText, finding.suggestedClause)
    assert.equal(doc.text, documents.find((item) => item.fileId === doc.fileId).text)
  }
})
test('前导空格、多行范围和重复正文只用已有位置', () => {
  const doc = { fileId: 'r', fileName: '重复.txt', text: '甲\n同句\n乙\n同句\n尾行' }
  const quote = '同句\n尾行', startOffset = doc.text.lastIndexOf('同句')
  const result = buildHandbookAnnotations({ sourceDocuments: [doc], findings: [{ ...finding, evidence: [{ quote, location: { status: 'found', matches: [{ fileId: 'r', startOffset, endOffset: doc.text.length }] } }] }] })
  assert.deepEqual(result.documents[0].revisions[0].localizedEdits[0].quoteSpans, [{ line: 3, start: 0, end: 2 }, { line: 4, start: 0, end: 2 }])
})
test('越界、篡改原文、歧义和缺失引用保留未定位提示', () => {
  for (const item of [{ quote: '不存在', location: finding.evidence[0].location },
    { ...finding.evidence[0], location: { status: 'ambiguous', matches: finding.evidence[0].location.matches } },
    { quote: '不存在', location: { status: 'found', matches: [{ fileId: 'a', startOffset: -1, endOffset: 999 }] } }]) {
    const result = buildHandbookAnnotations({ sourceDocuments: documents, findings: [{ ...finding, evidence: [item] }] })
    assert.equal(result.documents[0].revisions.length, 0); assert.equal(result.unresolved.length, 1)
    assert.ok(handbookAnnotationText(result.documents[0], result.unresolved).startsWith(documents[0].text))
    assert.match(handbookAnnotationText(result.documents[0], result.unresolved), /未定位诊断提示/)
  }
})
test('OCR和待确认问题仍可定位但只生成提示，不展示条款建议', () => {
  for (const report of [{ sourceDocuments: documents.map((doc) => ({ ...doc, parseMetadata: { ocrRegionCount: 2 } })), findings: [finding] },
    { sourceDocuments: documents, findings: [{ ...finding, status: 'pending' }] }]) {
    for (const doc of buildHandbookAnnotations(report).documents) assert.equal(doc.revisions[0].rewrittenText, '')
  }
})
test('部分引用不可定位时，两边的结果都保留', () => {
  const result = buildHandbookAnnotations({ sourceDocuments: [documents[0]], findings: [finding] })
  assert.equal(result.documents[0].revisions.length, 1); assert.equal(result.unresolved.length, 1)
})
test('同一片段多个问题保留各自标记，空结果不改原文', () => {
  const result = buildHandbookAnnotations({ sourceDocuments: documents, findings: [finding, { ...finding, id: 'f2', title: '另一问题', suggestedClause: '' }] })
  assert.deepEqual(result.documents[0].revisions.map((rev) => rev.localizedEdits[0].markerNumber), [1, 2])
  assert.equal(handbookAnnotationText(result.documents[0]), documents[0].text)
  assert.deepEqual(buildHandbookAnnotations().documents, [])
})
test('报告复制与批注稿一致隐藏待核实示例，保留诊断说明', () => {
  const report = { sourceDocuments: documents, findings: [{ ...finding, status: 'pending' }] }
  const copied = formatHandbookReport(report)
  assert.ok(!copied.includes(finding.suggestedClause)); assert.ok(copied.includes(finding.recommendation))
  assert.equal(buildHandbookAnnotations(report).documents[0].revisions[0].rewrittenText, '')
})
console.log(`Handbook annotations: ${count} scenarios passed`)
