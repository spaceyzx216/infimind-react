// Synthetic buffers and an injected generator only. No model, network, uploaded file or project DB.
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractText, parseCacheKey } from '../services/file-parser.js'
import { readCachedParse, writeCachedParse, clearParseCache, parseCacheStats } from '../services/parse-cache.js'
import { indexMaterialDocuments, prepareTaskMaterials } from '../services/material-processing.js'
import { documentBlocks } from '../services/document-materials.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskService } from '../services/task-service.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskRouter } from '../routes/tasks.js'

const contractText = '劳动合同\n甲方：虚构测试公司\n第一条 月工资8000元，每月15日支付。'
const textFile = (id, name = '虚构劳动合同.txt') => ({ id, originalname: name, mimetype: 'text/plain', buffer: Buffer.from(contractText) })

// 1) 显式 opt-in 时，同一份字节第二次解析必须命中缓存：用哨兵正文证明它没有重新解析文件。
clearParseCache()
const classifyFile = textFile('classify-file')
const first = await extractText(classifyFile, { reuseParsed: true })
assert.equal(first.text.includes('8000'), true)
const key = parseCacheKey(textFile('task-file'), {})
assert.equal(parseCacheKey(classifyFile, {}), key, '分类与任务准备必须得出同一个复用键')
assert.ok(readCachedParse(key), '第一次解析必须写入缓存')

const sentinel = { text: '哨兵正文：来自缓存的原始解析结果', pageCount: null, metadata: {} }
writeCachedParse(key, sentinel)
const taskFile = textFile('task-file')
const second = await extractText(taskFile, { reuseParsed: true })
assert.equal(second.text, sentinel.text, '命中缓存时不得重新解析文件')
assert.notEqual(second.metadata.blocks[0].fileId, first.metadata.blocks[0].fileId,
  '命中缓存也必须按当前请求重新 finalize（块 fileId 属于当前文件）')
assert.equal(second.metadata.parserVersion, first.metadata.parserVersion)

// 2) 没有 opt-in 的调用点行为不变：不读也不写缓存。
clearParseCache()
const plain = textFile('plain-file')
const parsedPlain = await extractText(plain)
assert.equal(parsedPlain.text.includes('8000'), true)
assert.equal(readCachedParse(parseCacheKey(plain, {})), null, '未 opt-in 的解析不得写入缓存')

// 3) 复用键必须覆盖会改变结果的输入：字节、文件名、解析器版本、OCR 执行方式。
assert.notEqual(parseCacheKey(textFile('a'), {}), parseCacheKey({ ...textFile('b'), buffer: Buffer.from('另一份正文') }, {}), '不同字节不得共用缓存')
assert.notEqual(parseCacheKey(textFile('a', '甲.txt'), {}), parseCacheKey(textFile('b', '乙.txt'), {}), '不同原始文件名不得共用缓存')
assert.notEqual(parseCacheKey(textFile('a'), {}), parseCacheKey(textFile('b'), { ocrInProcess: true }), '不同 OCR 执行方式不得共用缓存')
assert.equal(parseCacheKey({ originalname: '无buffer.txt' }, {}), '', '没有 Buffer 时不得生成复用键')

// 4) 预算与清理：超大结果不缓存，清理后为空。
clearParseCache()
assert.equal(writeCachedParse('oversized', { text: 'x'.repeat(2_000_001), metadata: {} }), false, '超预算结果不得进入缓存')
assert.deepEqual(parseCacheStats(), { entries: 0, totalChars: 0 })
writeCachedParse('small', { text: '短正文', metadata: {} })
assert.equal(parseCacheStats().entries, 1)
clearParseCache()
assert.deepEqual(parseCacheStats(), { entries: 0, totalChars: 0 })

// 5) 同一文件切成多个内容块时，进度文案必须带块序号，不能出现完全相同的重复文案。
const longText = '劳动合同条款约定内容。'.repeat(3000)
const longBlocks = documentBlocks([{ fileId: 'long-file', fileName: '虚构长合同.txt', text: longText }])
assert.ok(longBlocks.length > 1, '测试正文必须切成多个内容块')
const events = []
await indexMaterialDocuments([{ fileId: 'long-file', fileName: '虚构长合同.txt', text: longText }], {
  task: { productId: 'labor-contract-analysis', mode: 'fast' }, fakeLlm: true,
  emit: async (event, data) => events.push({ event, ...data })
})
const messages = events.filter((item) => item.event === 'stage.progress').map((item) => item.message)
assert.equal(messages.length, longBlocks.length)
assert.ok(messages.every((message, index) => message.includes(`（第 ${index + 1}/${longBlocks.length} 块）`)),
  `每个块的进度文案都要标明块序号：${JSON.stringify(messages)}`)
assert.equal(new Set(messages).size, messages.length, '同一文件的多个块不得发出完全相同的进度文案')

// 6) 端到端：分类接口与任务材料准备对同一份上传文件共用一次原始解析。
// 做法：先把该内容的缓存替换成哨兵正文——若任一环节重新解析，哨兵就会被真实解析结果覆盖。
const uploadName = '虚构分类材料.txt'
const uploadKey = parseCacheKey({ originalname: uploadName, mimetype: 'text/plain', buffer: Buffer.from(contractText) }, {})
clearParseCache()
writeCachedParse(uploadKey, { text: '哨兵正文：分类与任务准备必须复用这一份', pageCount: null, metadata: {} })

let database, server
try {
  database = createBusinessDatabase(':memory:')
  const service = createTaskService(database)
  const store = createTaskFileStore({ root: mkdtempSync(join(tmpdir(), 'parse-cache-')) })
  const app = express()
  app.use((request, response, next) => { request.user = { id: 'owner' }; next() })
  app.use('/api', createTaskRouter({ taskService: service, fileStore: store, taskQueue: { enqueue: async () => {} }, fakeLlm: true }))
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const form = new FormData()
  form.append('files', new Blob([Buffer.from(contractText)], { type: 'text/plain' }), uploadName)
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/labor-contract-analysis/classify`, { method: 'POST', body: form })
  assert.equal(response.status, 200)
  const classification = await response.json()
  assert.equal(classification.classifications[0].parseStatus, 'succeeded', '分类接口仍然要返回解析状态')
  assert.equal(readCachedParse(uploadKey).text, '哨兵正文：分类与任务准备必须复用这一份', '分类接口必须复用缓存，不能重新解析同一份文件')

  // 任务材料准备：同一份字节再次进入，仍不得重新解析。
  const materialFile = { id: 'stored-file', originalname: uploadName, mimetype: 'text/plain', buffer: Buffer.from(contractText) }
  const saved = new Map()
  const prepared = await prepareTaskMaterials({
    files: [materialFile], sourceDocuments: [], input: {}, task: { id: 'task-1', productId: 'labor-contract-analysis', mode: 'fast' },
    checkpoint: async (stage, result) => saved.set(stage, { result }), getCheckpoint: (stage) => saved.get(stage),
    emit: async () => {}, isCancellationRequested: () => false
  })
  assert.equal(readCachedParse(uploadKey).text, '哨兵正文：分类与任务准备必须复用这一份', '任务材料准备必须复用缓存，不能重新解析同一份文件')
  assert.equal(materialFile.preparsed.text, '哨兵正文：分类与任务准备必须复用这一份')
  assert.equal(prepared.materialDocuments.length, 1)
  assert.equal(saved.get('material-source').result.documents[0].text, '哨兵正文：分类与任务准备必须复用这一份')
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  database?.close()
}

console.log('PASS parse cache and material progress: classify/task reuse the same raw parse without re-parsing, opt-in only, key covers bytes/name/OCR mode, budget enforced, per-block progress labelled, endpoint-level reuse verified (synthetic only)')
