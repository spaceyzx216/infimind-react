// Public statute text plus fixed fictional claims only; no internal KB or DB.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { loadHandbookProvisions, validateHandbookLegalChecks } from '../services/handbook-provisions.js'
import { LEGAL_CHECK_PROMPT } from '../prompts/handbook-diagnosis.js'

if (!process.argv.includes('--live')) { console.log('Add --live to review fixed fictional claims against the explicitly supplied public law manifest.'); process.exit(0) }
const arg = (key) => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1] }
assert.ok(arg('--manifest') && arg('--output'))
const loaded = await loadHandbookProvisions({ manifestPath: resolve(arg('--manifest')) })
const overtime = loaded.provisions.find((p) => p.lawTitle === '中华人民共和国劳动法' && p.article === '第四十四条')
const pregnancy = loaded.provisions.find((p) => p.lawTitle === '中华人民共和国劳动合同法' && p.article === '第四十二条')
assert.ok(overtime && pregnancy)
const cases = [
  { key: 'L01', provisionId: overtime.provisionId, expected: 'supported', finding: { explanation: '普通标准工时员工法定节假日工作，仅安排补休而不支付加班工资的规则存在问题。', recommendation: '保留标准工时和法定节日条件，按法定要求支付不低于工资百分之三百的工资报酬。' } },
  { key: 'L02', provisionId: pregnancy.provisionId, expected: 'unsupported', finding: { explanation: '虚构制度规定孕期女职工因不胜任工作可以被解除。', recommendation: '保留孕期女职工不胜任工作时按劳动合同法第四十条解除的规则。', suggestedClause: '孕期女职工经培训后仍不胜任工作的，公司可以依第四十条解除劳动合同。' } },
  { key: 'L03', provisionId: overtime.provisionId, expected: 'unsupported', finding: { explanation: '虚构制度规定办公室墙面为白色。', recommendation: '依据劳动法第四十四条，墙面必须改为蓝色。' } }
]
const { chatDetailed } = await import('../services/llm-client.js')
const results = []
for (const item of cases) {
  const primary = loaded.provisions.find((p) => p.provisionId === item.provisionId)
  const provisions = loaded.provisions.filter((p) => p.provisionId === primary.provisionId || primary.relatedProvisionIds.includes(p.provisionId))
  const check = { key: item.key, provisionId: item.provisionId, finding: item.finding }
  const start = performance.now()
  const response = await chatDetailed(LEGAL_CHECK_PROMPT, JSON.stringify({ checks: [check], provisions }), { temperature: 0.1, maxAttempts: 1,
    maxTokens: 4096, responseFormat: { type: 'json_object' }, thinking: { type: 'disabled' }, requestTimeoutMs: 120000 })
  assert.notEqual(response.finishReason, 'length')
  const output = JSON.parse(response.content)
  assert.equal(output.complete, true)
  validateHandbookLegalChecks(output, [check], provisions)
  results.push({ key: item.key, expectedDirection: item.expected, opinion: output.checks[0], milliseconds: performance.now() - start, usage: response.usage })
  console.log(JSON.stringify({ key: item.key, expected: item.expected, actual: output.checks[0].support }))
}
await writeFile(resolve(arg('--output')), JSON.stringify({ syntheticClaimsOnly: true, source: 'explicit public-law manifest', annotationStatus: 'assistant-labelled-control-not-legal-gold', results }, null, 2))
