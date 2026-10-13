import assert from 'node:assert/strict'
import { mergeRevisions } from '../services/revision-merger.js'

const text = '第一条 付款期限为十五日。\n第二条 解除条件由双方确认。'
const findings = ['付款期限为十五日', '解除条件由双方确认'].map((quote, at) => ({
  id: `verified-${at}`, lineStart: at, lineEnd: at, clauseEnd: at, originalText: text.split('\n')[at], quoteText: quote,
  quoteStatus: 'exact', quoteSpans: [{ line: at, start: 4, end: 12 }], title: `虚构提示${at}`, level: '中',
  advice: '保留已核验的虚构原文提示。', risk: '虚构风险。', evidence: []
}))
const payload = (revisions) => JSON.stringify({ revisions })
const complete = findings.map((finding, at) => ({ findingId: finding.id, action: 'modify', rewrittenText: `虚构修订${at}`, lineStart: 999, lineEnd: 999 }))
const ordered = mergeRevisions(findings, payload(complete.toReversed()), text)
assert.deepEqual(ordered.revisions.map((rev) => rev.rewrittenText), ['虚构修订0', '虚构修订1'], 'Matching IDs must win over output order')
assert.deepEqual(ordered.revisions.map((rev) => [rev.findingId, rev.lineStart, rev.lineEnd]), [['verified-0', 0, 0], ['verified-1', 1, 1]], 'Model line numbers cannot override verified source positions')

const truncated = mergeRevisions(findings, '{"revisions":[' + JSON.stringify(complete[0]) + ',{"findingId":"verified-1","rewrittenText":"unfinished', text)
assert.equal(truncated.recovered, true)
assert.equal(truncated.revisions.length, 2, 'Truncation must preserve all verified findings and source anchors')
assert.equal(truncated.revisions[0].hasRewrite, true)
assert.equal(truncated.revisions[1].hasRewrite, false)
assert.ok(truncated.revisions[1].localizedEdits.length, 'Missing generated text must retain a source-verified notice')
const empty = mergeRevisions(findings, '{broken', text)
assert.equal(empty.revisions.length, 2)
assert.ok(empty.revisions.every((rev) => rev.localizedEdits.length && !rev.hasRewrite))
const noId = mergeRevisions(findings, payload(complete.map((rev) => { const copy = { ...rev }; delete copy.findingId; return copy })), text)
assert.equal(noId.stats.matched, 2, 'Legacy outputs without IDs retain positional compatibility')
const wrongId = mergeRevisions(findings, payload(complete.map((rev, at) => ({ ...rev, findingId: `foreign-${at}` })).toReversed()), text)
assert.equal(wrongId.stats.matched, 0, 'An explicitly wrong ID must not attach another clause rewrite by position')
assert.ok(wrongId.revisions.every((rev) => !rev.hasRewrite && rev.localizedEdits.length))
console.log('PASS revision integrity: source anchors retained on truncation/invalid JSON, ID order verified, explicit foreign IDs rejected, legacy missing-ID compatibility retained (synthetic only)')
