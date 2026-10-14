// --live explicitly opts into embedding ONLY the frozen, fictional fixture.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildHandbookStructure, rankHandbookChunks } from '../services/handbook-structure.js'

const arg = (key) => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1] }
const bytes = await readFile(resolve('docs/员工手册诊断测试/检索扩展标注-20261012.json'))
const fixture = JSON.parse(bytes)
assert.equal(fixture.syntheticOnly, true)
const chunks = buildHandbookStructure(fixture.documents).chunks
assert.equal(chunks.length, fixture.documents.length, 'One block per document is required by these labels')
const k = 2
const lexical = (query) => rankHandbookChunks(query.text, chunks).filter((item) => item.score > 0).map(({ chunk, score }) => ({ id: chunk.fileId, score }))
const rows = fixture.queries.map((query) => ({ ...query, lexical: lexical(query) }))
let embedding = { executed: false }
if (process.argv.includes('--live')) {
  const { embedTexts, isEmbeddingConfigured, getRetrievalHealth } = await import('../services/siliconflow-client.js')
  assert.ok(isEmbeddingConfigured(), 'Embedding credentials are not configured')
  const inputs = [...chunks.map((c) => c.text), ...fixture.queries.map((q) => q.text)]
  const start = performance.now()
  const vectors = await embedTexts(inputs, { onProgress: ({ done, total }) => console.log(`Embedding ${done}/${total}`) })
  assert.equal(vectors.length, inputs.length)
  const dim = vectors[0].length
  assert.ok(dim > 0 && vectors.every((v) => v.length === dim && v.every(Number.isFinite)), 'Invalid embedding dimensions or values')
  const norm = (v) => { const n = Math.hypot(...v); assert.ok(n > 0); return v.map((x) => x / n) }
  const normalized = vectors.map(norm)
  rows.forEach((row, qi) => {
    const query = normalized[chunks.length + qi]
    row.vector = chunks.map((c, i) => ({ id: c.fileId, score: query.reduce((sum, x, j) => sum + x * normalized[i][j], 0) })).sort((a, b) => b.score - a.score)
    // Fixed equal-weight RRF, no tuning to labels. Full rankings, identical k.
    const fused = new Map()
    for (const ranking of [row.lexical, row.vector]) ranking.forEach((item, index) => fused.set(item.id, (fused.get(item.id) || 0) + 1 / (60 + index + 1)))
    row.hybrid = [...fused].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
  })
  embedding = { executed: true, model: getRetrievalHealth().embedding.model, dimensions: dim, inputCount: inputs.length, milliseconds: performance.now() - start }
}
const methods = embedding.executed ? ['lexical', 'vector', 'hybrid'] : ['lexical']
const measure = (subset, method) => {
  const answerable = subset.filter((q) => q.goldDocumentIds.length)
  const noAnswer = subset.filter((q) => !q.goldDocumentIds.length)
  let tp = 0, returned = 0, expected = 0, rr = 0
  const cases = subset.map((row) => {
    const selected = row[method].slice(0, k), ids = selected.map((x) => x.id)
    const hits = ids.filter((id) => row.goldDocumentIds.includes(id)).length
    if (row.goldDocumentIds.length) {
      tp += hits; returned += ids.length; expected += row.goldDocumentIds.length
      const first = ids.findIndex((id) => row.goldDocumentIds.includes(id)); rr += first < 0 ? 0 : 1 / (first + 1)
    }
    return { id: row.id, selected, gold: row.goldDocumentIds, hits, missed: row.goldDocumentIds.filter((id) => !ids.includes(id)) }
  })
  return { answerableCount: answerable.length, noAnswerCount: noAnswer.length, hits: tp, returned, expected,
    precisionAtK: answerable.length ? tp / (answerable.length * k) : null,
    recallMicroAtK: expected ? tp / expected : null, mrrAtK: answerable.length ? rr / answerable.length : null,
    noAnswerReturnedCount: cases.filter((row) => !row.gold.length && row.selected.length).length, cases }
}
const results = Object.fromEntries(methods.map((method) => [method, { all: measure(rows, method),
  groups: Object.fromEntries([...new Set(rows.map((q) => q.group))].map((g) => [g, measure(rows.filter((q) => q.group === g), method)])) }]))
const output = { syntheticOnly: true, annotationStatus: fixture.annotationStatus, scope: fixture.scope, k,
  corpusHash: createHash('sha256').update(bytes).digest('hex'), embedding, results,
  limitations: ['Same-author small synthetic set; not legal gold or production distribution.', 'No similarity abstention threshold was fitted; no-answer returns are explicitly reported.', 'Reference ranking comparison does not measure body-conflict candidate recall.', 'No production retrieval changes, no DB writes, no silent vector fallback.'] }
if (arg('--output')) await writeFile(resolve(arg('--output')), JSON.stringify(output, null, 2))
console.log(JSON.stringify({ corpusHash: output.corpusHash, embedding, metrics: Object.fromEntries(methods.map((method) => [method, Object.fromEntries(Object.entries(results[method].all).filter(([key]) => key !== 'cases'))])) }))
