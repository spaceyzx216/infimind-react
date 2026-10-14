import assert from 'node:assert/strict'
import { reviewContract } from '../agents/contract-reviewer.js'
import { documentBlocks } from '../services/document-materials.js'

const source = '普通商业合同条款。\n'.repeat(1300) + '末尾付款条件：每月十五日支付8000元。'
const submitted = [], checkpoints = new Map()
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  assert.ok(String(url).endsWith('/chat/completions'))
  const body = JSON.parse(init.body)
  const content = body.messages.at(-1).content
  submitted.push(content)
  const finding = content.includes('末尾付款条件') ? [{ level: '中', title: '付款条件核对', location: '末尾付款条件',
    quote: '末尾付款条件：每月十五日支付8000元。', risk: '虚构模型桩风险', advice: '核对', replacement: '', evidence: [] }] : []
  const data = { choices: [{ delta: { content: JSON.stringify({ conclusion: '虚构模型桩输出', findings: finding, completeness: [] }) }, finish_reason: 'stop' }] }
  return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}
try {
  const params = { contractText: source, analysisReport: '虚构结构概览', evidence: [], reviewPlan: { contractType: '虚构商业合同', topics: [] },
    checkpoint: async (key, result) => checkpoints.set(key, { result }), getCheckpoint: (key) => checkpoints.get(key) }
  const output = JSON.parse(await reviewContract(params))
  assert.equal(output.findings.length, 1)
  assert.ok(submitted.some((body) => body.includes('末尾付款条件')))
  assert.equal(submitted.length, documentBlocks([{ text: source }]).length)
  const completedCalls = submitted.length
  await reviewContract(params)
  assert.equal(submitted.length, completedCalls, '恢复复用已完成的内容块')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(reviewContract({ ...params, signal: controller.signal }))
  checkpoints.clear()
  const unfinished = { choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'length' }] }
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify(unfinished)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  await assert.rejects(reviewContract(params), (error) => error.code === 'commercial_output_incomplete')
  assert.equal(checkpoints.get('material-coverage').result.checked.length, 0)
  assert.equal(checkpoints.get('material-coverage').result.entered.length, 1)
  assert.equal([...checkpoints.keys()].some((key) => key.startsWith('commercial-review:')), false)
  console.log(`commercial traversal: ${completedCalls} material blocks entered model; tail, aggregation, recovery, cancellation and unfinished coverage passed`)
} finally { globalThis.fetch = originalFetch }
