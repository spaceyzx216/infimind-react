import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fingerprint } from '../services/handbook-structure.js'

const arg = (key) => { const index = process.argv.indexOf(key); return index < 0 ? null : process.argv[index + 1] }
assert.ok(arg('--run') && arg('--output'))
const directory = resolve(arg('--run'))
const labels = JSON.parse(await readFile(resolve(arg('--labels') || 'docs/员工手册诊断测试/检索标注用例.json'), 'utf8'))
assert.equal(labels.syntheticOnly, true)
const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))
assert.equal(summary.isolated, true)
const cases = []
for (const outcome of summary.outcomes.filter((item) => labels.relations.some((scene) => scene.id === item.id))) {
  const scene = labels.relations.find((item) => item.id === outcome.id)
  const { report } = JSON.parse(await readFile(join(directory, `${scene.id}.json`), 'utf8'))
  const checkpoints = JSON.parse(await readFile(join(directory, `${scene.id}-checkpoints.json`), 'utf8'))
  const structure = checkpoints.find((item) => item.stage === 'handbook-structure')?.result
  assert.ok(structure && report.analysisStatus === 'completed', 'Only finished, fully captured runs can be assessed')
  const policyBlocks = new Map()
  for (const doc of scene.documents) {
    const source = report.sourceDocuments.find((item) => item.fileName === `${scene.id}${doc.fileName}.txt`)
    assert.ok(source, 'Label source filename differs from actual upload')
    const compact = (value) => value.replace(/\s/g, '')
    const matches = structure.chunks.filter((chunk) => chunk.fileId === source.fileId && compact(source.text.slice(chunk.startOffset, chunk.endOffset)).includes(compact(doc.text)))
    assert.equal(matches.length, 1, 'Gold clause must resolve to one actual body block')
    policyBlocks.set(matches[0].id, doc.fileId)
  }
  const pairIds = new Set(checkpoints.filter((item) => item.stage.startsWith('handbook-relations:'))
    .flatMap((item) => item.result.output.checkedRelationIds))
  assert.equal(pairIds.size, report.relationCoverage.total, 'Incomplete candidate capture')
  const actual = []
  for (const [index, left] of structure.chunks.entries()) for (const right of structure.chunks.slice(index + 1)) {
    const pairId = fingerprint([left.id, right.id].sort()).slice(0, 20)
    if (pairIds.has(pairId) && policyBlocks.has(left.id) && policyBlocks.has(right.id)) actual.push([policyBlocks.get(left.id), policyBlocks.get(right.id)].sort().join('|'))
  }
  // Annotation is about policy-rule pairs. Headers/background are counted
  // separately, not incorrectly labelled irrelevant or excluded silently.
  const gold = scene.goldPairs.map((ids) => [...ids].sort().join('|'))
  const tp = actual.filter((id) => gold.includes(id)).length
  cases.push({ id: scene.id, tp, fp: actual.length - tp, fn: gold.length - tp,
    totalCandidateCount: pairIds.size, policyPairCount: actual.length, backgroundPairCount: pairIds.size - actual.length,
    findings: report.findings.map((finding) => ({ id: finding.id, kind: finding.kind, title: finding.title,
      locationStatus: finding.locationStatus, status: finding.status, evidenceCount: finding.evidence.length })),
    manualSemanticReviewRequired: true })
}
const totals = cases.reduce((sum, item) => ({ tp: sum.tp + item.tp, fp: sum.fp + item.fp, fn: sum.fn + item.fn }), { tp: 0, fp: 0, fn: 0 })
const result = { annotationStatus: labels.annotationStatus,
  scope: 'Actual completed candidates including model links, evaluated over labelled policy body pairs; background pairs separately reported. Generation correctness requires independent review.',
  ...totals, precision: totals.tp + totals.fp ? totals.tp / (totals.tp + totals.fp) : null,
  recall: totals.tp + totals.fn ? totals.tp / (totals.tp + totals.fn) : null, cases }
await writeFile(resolve(arg('--output')), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ tp: result.tp, fp: result.fp, fn: result.fn, precision: result.precision, recall: result.recall }))
