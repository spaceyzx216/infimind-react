import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commercialPhaseOptions, completeCommercial, MAX_COMMERCIAL_OUTPUT_TOKENS } from '../services/commercial-completion.js'
import { reviewContract } from '../agents/contract-reviewer.js'
import { indexMaterialDocuments, locateMaterialExcerpt } from '../services/material-processing.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createTaskService } from '../services/task-service.js'
import { createTaskFileStore } from '../services/task-file-store.js'
import { createTaskProcessor } from '../services/task-processor.js'
import { createTaskRouter } from '../routes/tasks.js'

// Model requests are intercepted; HTTP requests below target an isolated local
// router. No real contract, external provider, project DB or worker is used.
const nativeFetch = globalThis.fetch
const captured = []
let respond = () => ({ content: '完整虚构结果', finish: 'stop' })
globalThis.fetch = async (url, init) => {
  assert.ok(String(url).endsWith('/chat/completions'))
  const body = JSON.parse(init.body)
  captured.push(body)
  const { content, finish } = respond(body)
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } })
}
let database, server
try {
  for (const stage of ['analysis', 'review', 'rewrite', 'consolidation', 'merge']) {
    assert.equal(commercialPhaseOptions('fast', stage).thinking.type, 'disabled')
    assert.equal(commercialPhaseOptions('fast', stage).maxTokens, MAX_COMMERCIAL_OUTPUT_TOKENS)
  }
  assert.equal(commercialPhaseOptions('thinking', 'analysis').reasoningEffort, 'low')
  assert.equal(commercialPhaseOptions('thinking', 'review').reasoningEffort, 'high')
  assert.equal(commercialPhaseOptions('thinking', 'rewrite').reasoningEffort, 'low')
  let attempts = 0
  respond = () => ++attempts === 1 ? { content: '半截报告', finish: 'length' } : { content: '完整虚构结果', finish: 'stop' }
  assert.equal(await completeCommercial({ stage: 'analysis', systemPrompt: '虚构结构任务', userMessage: '虚构合同', mode: 'fast' }), '完整虚构结果')
  assert.equal(attempts, 2)
  assert.ok(captured.every((body) => body.max_tokens === 393216 && body.thinking.type === 'disabled'))
  respond = () => ({ content: '半截报告', finish: 'length' })
  await assert.rejects(completeCommercial({ stage: 'analysis', systemPrompt: '虚构', userMessage: '虚构', mode: 'fast' }),
    (error) => error.code === 'commercial_output_incomplete')

  const checkpoints = new Map(), events = []
  respond = (body) => {
    const source = body.messages.at(-1).content.match(/# 合同原文\n([\s\S]*?)\n\n# 结构分析报告/)?.[1] || ''
    return source.length > 1800 ? { content: '{"findings":', finish: 'length' }
      : { content: JSON.stringify({ findings: [], completeness: [], conclusion: '虚构块已核对' }), finish: 'stop' }
  }
  const reviewed = await reviewContract({ contractText: '虚构测试条款。'.repeat(350), analysisReport: '虚构结构', evidence: [],
    reviewPlan: { contractType: '虚构合同', topics: [] }, mode: 'fast',
    checkpoint: async (key, result) => checkpoints.set(key, { result }), getCheckpoint: (key) => checkpoints.get(key),
    emit: async (event, data) => events.push({ event, ...data }) })
  assert.deepEqual(JSON.parse(reviewed).findings, [])
  assert.ok(events.some((event) => event.message.includes('拆小')))
  assert.equal(checkpoints.get('material-coverage').result.partial, false)
  assert.equal(locateMaterialExcerpt('付款 8000 元。', '付款8000元。').end, '付款 8000 元。'.length)
  assert.equal(locateMaterialExcerpt('付款8000元。', '付款80000元。'), null)
  assert.equal(locateMaterialExcerpt('甲 方\n甲 方', '甲方'), null, 'Ambiguous whitespace-only matching must not guess a location')
  let indexAttempts = 0
  const indexed = await indexMaterialDocuments([{ fileId: 'fake', fileName: 'synthetic.txt', text: '付款 8000 元。' }], {
    task: { productId: 'contract-review', mode: 'fast' }, generate: async (system, user, options) => {
      assert.equal(options.maxTokens, 393216)
      return { finishReason: 'stop', content: JSON.stringify({ complete: true, quotes: [{ quote: ++indexAttempts === 1 ? '付款80000元。' : '付款8000元。' }] }) }
    }
  })
  assert.equal(indexAttempts, 2)
  assert.equal(indexed[0].quotes[0].quote, '付款 8000 元。')

  database = createBusinessDatabase(':memory:')
  const service = createTaskService(database)
  database.prepare('INSERT INTO invite_codes (id,code_hash,created_at) VALUES (?,?,?)').run('invite', 'fake', new Date().toISOString())
  database.prepare('INSERT INTO users (id,username,email,password_hash,password_salt,invite_code_id,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('owner', 'synthetic', 'test@example.invalid', 'fake', 'fake', 'invite', new Date().toISOString())
  const store = createTaskFileStore({ root: mkdtempSync(join(tmpdir(), 'commercial-recovery-')) })
  const files = (await store.saveIncomingFiles('recovery-task', [{ originalname: 'synthetic.txt', mimetype: 'text/plain', buffer: Buffer.from('第一条 甲方可以拒绝付款。') }]))
    .map((file) => ({ ...file, id: 'fake-file' }))
  const task = service.createTask({ id: 'recovery-task', userId: 'owner', productId: 'contract-review', threadId: 'recovery-thread', mode: 'fast', files })
  const processor = createTaskProcessor({ taskService: service, fileStore: store, fakeLlm: false,
    reviewWorkflow: async ({ checkpoint }) => {
      await checkpoint('analysis', { analysisReport: '虚构结构已读取' })
      await checkpoint('parsing', { parsedText: '第一条 甲方可以拒绝付款。', parseErrors: [] })
      throw Object.assign(new Error('第二个内容块还需核对。'), { code: 'commercial_output_incomplete', retryable: false })
    } })
  const failed = await processor.processTask(task.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.result.reviewComplete, false)
  assert.equal(failed.result.analysis, '虚构结构已读取')
  assert.ok(failed.result.review.includes('尚未取得可核验'))
  assert.ok(!failed.result.review.includes('未发现可稳定定位'))
  assert.equal(service.resumeFailedReview(task.id, 'other'), null)
  const app = express()
  app.use((req, res, next) => { req.user = { id: req.get('X-Test-User') || 'owner' }; next() })
  app.use('/api', createTaskRouter({ taskService: service, fileStore: store, taskQueue: { enqueue: async () => {} }, fakeLlm: true }))
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) })
  const endpoint = `http://127.0.0.1:${server.address().port}/api/tasks/${task.id}/retry`
  assert.equal((await nativeFetch(endpoint, { method: 'POST', headers: { 'X-Test-User': 'other' } })).status, 404)
  const resumed = await nativeFetch(endpoint, { method: 'POST' })
  assert.equal(resumed.status, 202)
  assert.equal((await resumed.json()).task.status, 'queued')
  assert.equal(service.getCheckpoint(task.id, 'analysis').result.analysisReport, '虚构结构已读取')
  assert.equal((await nativeFetch(endpoint, { method: 'POST' })).status, 409)
  const completing = createTaskProcessor({ taskService: service, fileStore: store, fakeLlm: false,
    reviewWorkflow: async ({ getCheckpoint }) => {
      assert.equal(getCheckpoint('analysis').result.analysisReport, '虚构结构已读取')
      return { analysis: '虚构结构已读取', review: '虚构核对已完成', contractText: '第一条 甲方可以拒绝付款。', revisions: [] }
    } })
  assert.equal((await completing.processTask(task.id)).status, 'succeeded')
  console.log('PASS commercial recovery: maximum output budget, stage modes, retry/split, source-safe excerpt repair, readable failed results, ownership, duplicate retry rejection and checkpoint continuation (model stub only)')
} finally {
  globalThis.fetch = nativeFetch
  if (server) await new Promise((resolve) => server.close(resolve))
  database?.close()
}
