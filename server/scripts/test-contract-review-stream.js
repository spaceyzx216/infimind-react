import assert from 'node:assert/strict'
import { completeCommercial } from '../services/commercial-completion.js'
import { analyzeContract } from '../agents/contract-analyzer.js'
import { initialize } from '../services/knowledge-base.js'

// All model calls are intercepted and the catalog lives in memory.
// A gate holds back the model's finish event until a preview reaches the caller.
const database = initialize(':memory:')
const nativeFetch = globalThis.fetch
const encoder = new TextEncoder()
let respond
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body)
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (content, finish = null) => controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`
      ))
      try { await respond(body, send); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close() }
      catch (error) { controller.error(error) }
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}

try {
  const first = '虚构合同结构预览。'.repeat(70), tail = '\n\n分析完成。'
  let release, ended = false, preview = ''
  const gate = new Promise((resolve) => { release = resolve })
  respond = async (_body, send) => { send(first); await gate; ended = true; send(tail, 'stop') }
  const report = await analyzeContract('第一条 虚构主体按月支付服务费。', async (delta) => {
    if (!preview) { assert.equal(ended, false, 'preview must precede the model finish event'); release() }
    preview += delta
  }, undefined, { mode: 'fast' })
  assert.equal(preview, first + tail)
  assert.equal(report, preview, 'no duplicated whole report after streaming')

  let attempts = 0, resets = 0
  preview = ''
  respond = async (_body, send) => ++attempts === 1 ? send(first, 'length') : send(first + tail, 'stop')
  const retried = await analyzeContract('第二条 虚构付款条件。', (delta) => { preview += delta }, undefined, {
    mode: 'fast', emit: async (event, data) => {
      if (event === 'stage.start' && data.stage === 'analysis') { resets++; preview = '' }
    }
  })
  assert.equal(attempts, 2)
  assert.equal(resets, 1)
  assert.equal(preview, retried)

  const checkpoints = new Map()
  preview = ''
  let blockCalls = 0, mergeCalls = 0
  respond = async (body, send) => {
    const merged = body.messages[0].content.includes('将各内容块')
    if (merged) mergeCalls++; else blockCalls++
    send(merged ? '虚构汇总报告。'.repeat(70) : first)
    send(merged ? '\n最终汇总完成。' : '\n当前块完成。', 'stop')
  }
  const options = {
    mode: 'fast', blockBudget: 150,
    checkpoint: async (key, result) => checkpoints.set(key, { result }),
    getCheckpoint: (key) => checkpoints.get(key),
    emit: async (event, data) => { if (event === 'stage.start' && data.stage === 'analysis') preview = '' }
  }
  const source = ('第一条 虚构付款条件，双方协商确认。\n\n').repeat(40)
  const merged = await analyzeContract(source, (delta) => { preview += delta }, undefined, options)
  assert.ok(blockCalls > 1 && mergeCalls > 0)
  assert.equal(preview, merged, 'block previews must be replaced by the final merged report')
  const calls = blockCalls + mergeCalls
  preview = ''
  assert.equal(await analyzeContract(source, (delta) => { preview += delta }, undefined, options), merged)
  assert.equal(blockCalls + mergeCalls, calls, 'completed block/merge checkpoints are reused')
  assert.equal(preview, merged)

  respond = async (_body, send) => send('', 'stop')
  await assert.rejects(completeCommercial({ stage: 'analysis', systemPrompt: '虚构', userMessage: '虚构', mode: 'fast' }),
    (error) => error.code === 'commercial_output_incomplete')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(analyzeContract('虚构', () => {}, undefined, { signal: controller.signal }),
    (error) => error.name === 'AbortError')
  console.log('PASS contract analysis: preview before finish, exact final text, retry reset, split/merge, checkpoint replay, empty response rejection and cancellation (model stub only)')
} finally { globalThis.fetch = nativeFetch; database.close() }
