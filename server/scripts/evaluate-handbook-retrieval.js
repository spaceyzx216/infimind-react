import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildHandbookStructure, retrieveHandbookRelations } from '../services/handbook-structure.js'
import { retrieveHandbookReferences } from '../services/handbook-references.js'
import { handbookTopicsForQuestion } from '../workflows/handbook-diagnosis.js'

const arg = (key) => { const index = process.argv.indexOf(key); return index < 0 ? null : process.argv[index + 1] }
const fixture = JSON.parse(await readFile(resolve(arg('--cases') || 'docs/员工手册诊断测试/检索标注用例.json'), 'utf8'))
assert.equal(fixture.syntheticOnly, true)
const pairKey = (ids) => [...ids].sort().join('|')
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null
const measureRelations = (scenes) => scenes.map((scene) => {
  const chunks = buildHandbookStructure(scene.documents).chunks
  // These short scenes have one block per file, so file pairs uniquely specify
  // block pairs. Fail rather than silently coarsen labels if this changes.
  assert.equal(chunks.length, scene.documents.length)
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk.fileId]))
  const actual = retrieveHandbookRelations(chunks).map((pair) => pairKey(pair.chunkIds.map((id) => byId.get(id))))
  const gold = scene.goldPairs.map(pairKey)
  const tp = actual.filter((id) => gold.includes(id)).length
  const fp = actual.length - tp, fn = gold.length - tp
  return { id: scene.id, tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    missed: gold.filter((id) => !actual.includes(id)), extra: actual.filter((id) => !gold.includes(id)) }
})
const relations = measureRelations(fixture.relations)
const holdout = measureRelations(fixture.holdoutRelations || [])
const pool = fixture.referenceDocuments
const chunks = buildHandbookStructure(pool).chunks
const rankedMetrics = (ids, gold, k) => {
  const selected = ids.slice(0, k)
  const hits = new Set(selected.filter((id) => gold.includes(id))).size
  const first = selected.findIndex((id) => gold.includes(id))
  return { ids: selected, hits, precisionAtK: hits / k, recallAtK: ratio(hits, gold.length),
    reciprocalRankAtK: first < 0 ? 0 : 1 / (first + 1) }
}
const queries = fixture.queries.map((query) => {
  assert.ok(query.goldDocumentIds.length && query.goldDocumentIds.every((id) => pool.some((doc) => doc.fileId === id)))
  const referenceIds = retrieveHandbookReferences({ text: query.text }, pool).map((ref) => pool.find((doc) => doc.fileName === ref.title).fileId)
  const followupIds = handbookTopicsForQuestion(query.text, chunks).map((chunk) => chunk.fileId)
  return { id: query.id, text: query.text, gold: query.goldDocumentIds,
    references: rankedMetrics(referenceIds, query.goldDocumentIds, 2), followup: rankedMetrics(followupIds, query.goldDocumentIds, 4) }
})
const totals = relations.reduce((sum, item) => ({ tp: sum.tp + item.tp, fp: sum.fp + item.fp, fn: sum.fn + item.fn }), { tp: 0, fp: 0, fn: 0 })
const mean = (kind, metric) => queries.reduce((sum, query) => sum + query[kind][metric], 0) / queries.length
const result = { syntheticOnly: true, annotationStatus: fixture.annotationStatus,
  scope: 'Small assistant-labelled stress set; rule-only relation recall excludes model links; no production KB or model calls.',
  relationSceneCount: relations.length, queryCount: queries.length,
  relationMetrics: { ...totals, precision: ratio(totals.tp, totals.tp + totals.fp), recall: ratio(totals.tp, totals.tp + totals.fn) },
  referenceMetrics: { k: 2, precisionAtK: mean('references', 'precisionAtK'), recallAtK: mean('references', 'recallAtK'), mrrAtK: mean('references', 'reciprocalRankAtK') },
  followupMetrics: { k: 4, precisionAtK: mean('followup', 'precisionAtK'), recallAtK: mean('followup', 'recallAtK'), mrrAtK: mean('followup', 'reciprocalRankAtK') },
  relations, queries, holdout, holdoutNote: fixture.holdoutNote || '' }
if (arg('--output')) await writeFile(resolve(arg('--output')), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ relationMetrics: result.relationMetrics, referenceMetrics: result.referenceMetrics, followupMetrics: result.followupMetrics,
  holdout: holdout.map(({ id, tp, fn }) => ({ id, tp, fn })) }))
if (process.argv.includes('--assert')) {
  assert.equal(totals.fn, 0, 'Known labelled relationships missed')
  assert.ok(queries.every((query) => query.references.recallAtK === 1 && query.followup.recallAtK === 1), 'Known query evidence missed')
}
