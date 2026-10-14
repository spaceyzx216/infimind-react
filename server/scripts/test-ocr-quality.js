import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractText } from '../services/file-parser.js'
import { handbookOcrCacheDirectory } from '../services/handbook-ocr-process.js'
import { containsOcrTestField } from './ocr-test-metrics.js'

const [directory, baselinePath] = process.argv.slice(2)
if (!directory || !baselinePath) throw new Error('Usage: node test-ocr-quality.js <synthetic-sample-dir> <baseline-file-parser.js>')
const sampleRoot = resolve(directory), baseline = resolve(baselinePath)
const gold = await readFile(join(sampleRoot, 'gold.txt'), 'utf8')
const buffer = await readFile(join(sampleRoot, 'sample.png'))
const legacy = await import(pathToFileURL(baseline).href)
// Language files stay in the existing task-owned OCR cache, outside the repo.
process.chdir(handbookOcrCacheDirectory)
const input = { originalname: '虚构印刷体.png', mimetype: 'image/png', buffer }
const firstStart = Date.now(), before = await legacy.extractText(input), beforeMs = Date.now() - firstStart
const secondStart = Date.now(), after = await extractText(input, { ocrInProcess: true }), afterMs = Date.now() - secondStart
const clean = (s) => [...s.replace(/\s/g, '')]
function distance(a, b) {
  a = clean(a); b = clean(b)
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}
const fields = ['8000', '2026年10月12日', '2027年10月11日', '不得扣减工资']
assert.ok(after.metadata.ocrRegions.length > 0)
assert.ok(after.metadata.ocrRegions.some((r) => r.text.includes('8000')))
const result = { sample: '虚构印刷体', gold, before: { text: before.text, characterEdits: distance(gold, before.text), elapsedMs: beforeMs,
  incorrectFields: fields.filter((field) => !containsOcrTestField(before.text,field)) },
  after: { text: after.text, characterEdits: distance(gold, after.text), elapsedMs: afterMs,
    incorrectFields: fields.filter((field) => !containsOcrTestField(after.text,field)), reviewRegions: after.metadata.ocrRegions.length,
    alternateCandidatesAvailable: after.metadata.ocrRegions.some((r) => r.candidates.length) },
  limitation: '单份虚构印刷体样例，仅比较字符误读和核对信息，不能代表业务准确率。原始识别文字没有自动纠正。' }
await writeFile(join(sampleRoot, 'comparison.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
