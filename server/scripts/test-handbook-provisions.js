import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHandbookProvisions, matchHandbookProvision, retrieveHandbookProvisions, validateHandbookLegalChecks, articleNumber } from '../services/handbook-provisions.js'
import { runHandbookDiagnosis } from '../workflows/handbook-diagnosis.js'

const directory = await mkdtemp(join(tmpdir(), 'handbook-provision-test-'))
const path = join(directory, 'synthetic.json')
const provision = { provisionId: 'synthetic-42', lawTitle: '虚构法条测试（不是真实法律）', article: '第四十二条',
  text: '第四十二条 员工怀孕本身不得作为违纪处理的理由；相关情形必须分别核对。', versionLabel: 'synthetic-v1', effectiveFrom: '2000-01-01',
  sourceUrl: 'https://www.gov.cn/__synthetic_test_only__/42', reviewStatus: 'pending', relatedProvisionIds: [] }
const save = async (provisions) => { await writeFile(path, JSON.stringify({ provisions })); return loadHandbookProvisions({ manifestPath: path }) }
let passed = 0
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`) }
await test('未配置法条正文保持待核实，不触发默认法规库读写', async () => {
  assert.deepEqual((await loadHandbookProvisions({ manifestPath: '' })).provisions, [])
  assert.equal(matchHandbookProvision({}, []).provisionStatus, 'unavailable')
})
await test('合法清单记录内容指纹，中文及阿拉伯条号一致', async () => {
  const result = await save([provision])
  assert.equal(result.configured, true); assert.equal(result.provisions[0].contentHash.length, 64)
  assert.equal(articleNumber('第42条'), 42); assert.equal(articleNumber('第四十二条（四）'), 42)
  assert.equal(articleNumber('第42条任意内容'), null)
})
await test('拒绝重复编号、伪官方链接、坏日期、条号不符及不存在的关联', async () => {
  for (const list of [[provision, provision], [{ ...provision, sourceUrl: 'https://gov.cn.evil.example/law' }], [{ ...provision, effectiveFrom: '2026-13-01' }],
    [{ ...provision, article: '第四十条' }], [{ ...provision, relatedProvisionIds: ['missing'] }]]) await assert.rejects(save(list))
})
await test('取消法条加载不能降级为普通待核实', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(loadHandbookProvisions({ manifestPath: path, signal: controller.signal }), { name: 'AbortError' })
})
await test('条号匹配不等于引文匹配；长短及拼接引文均检查', async () => {
  const authority = { title: provision.lawTitle, article: '第42条' }
  assert.equal(matchHandbookProvision(authority, [provision], '2026-10-12').quoteStatus, 'missing')
  assert.equal(matchHandbookProvision({ ...authority, quote: '员工怀孕本身不得作为违纪处理的理由' }, [provision], '2026-10-12').quoteStatus, 'matched')
  for (const quote of ['员工', '员工怀孕可以直接解除劳动合同', '员工怀孕本身相关情形必须分别核对']) assert.equal(matchHandbookProvision({ ...authority, quote }, [provision], '2026-10-12').quoteStatus, 'mismatch')
})
await test('生效边界、到期边界、多版本歧义不发布匹配结论', async () => {
  const a = { title: provision.lawTitle, article: provision.article }
  assert.equal(matchHandbookProvision(a, [{ ...provision, effectiveFrom: '2026-10-13' }], '2026-10-12').provisionStatus, 'inactive')
  assert.equal(matchHandbookProvision(a, [{ ...provision, effectiveTo: '2026-10-12' }], '2026-10-12').provisionStatus, 'inactive')
  assert.equal(matchHandbookProvision(a, [provision, { ...provision, provisionId: 'other-version' }], '2026-10-12').provisionStatus, 'ambiguous')
  assert.equal(matchHandbookProvision({ ...a, provisionId: 'wrong-id' }, [provision], '2026-10-12').provisionStatus, 'not_found')
})
await test('检索带上关联保护条款，不只取一个相似法条', () => {
  const related = { ...provision, provisionId: 'related', article: '第三十九条', text: '第三十九条 虚构关联条件。' }
  assert.equal(retrieveHandbookProvisions('员工怀孕违纪处理', [{ ...provision, relatedProvisionIds: ['related'] }, related], '2026-10-12').length, 2)
})
await test('混合多主题块不能把短竞业条款挤出全局前四名', () => {
  const long = Array.from({ length: 5 }, (_, i) => ({ ...provision, provisionId: 'long-' + i, lawTitle: '中华人民共和国劳动合同法', article: `第${30 + i}条`, text: '解除员工劳动合同 工资怀孕考勤'.repeat(15) }))
  const brief = { ...provision, provisionId: 'noncompete', lawTitle: '中华人民共和国劳动合同法', article: '第二十四条', text: '第二十四条 竞业限制条件。' }
  assert.ok(retrieveHandbookProvisions('解除员工劳动合同 工资怀孕考勤'.repeat(15) + '竞业限制', [...long, brief], '2026-10-12').some((p) => p.provisionId === brief.provisionId))
})
await test('支持复核拒绝遗漏、未知编号、重复编号及虚构法条引文', () => {
  const checks = [{ key: 'a', provisionId: provision.provisionId }]
  const valid = { key: 'a', provisionId: provision.provisionId, support: 'unsupported', quote: '员工怀孕本身不得作为违纪处理的理由', reason: '构造反例不受此条支持' }
  assert.equal(validateHandbookLegalChecks({ checks: [valid] }, checks, [provision]).length, 1)
  for (const rows of [[], [valid, valid], [{ ...valid, key: 'unknown' }], [{ ...valid, quote: '任意解除均合法有效' }]]) assert.throws(() => validateHandbookLegalChecks({ checks: rows }, checks, [provision]))
})
await test('任务复核不支持改法时隐藏示例，仍保留问题和法务待核验状态', async () => {
  const checkpoints = new Map()
  const opts = { input: { text: '第一章 员工管理\n第一条 怀孕员工直接按严重违纪解除劳动合同。' }, lawLoader: async () => [], referenceLoader: async () => ({ documents: [], versions: [], warnings: [] }),
    provisionLoader: async () => ({ configured: true, provisions: [provision], warnings: [] }), fakeLlm: false,
    checkpoint: async (key, result) => checkpoints.set(key, { result }), getCheckpoint: (key) => checkpoints.get(key),
    generateCompletion: async (_prompt, message) => {
      const payload = JSON.parse(message)
      if (payload.checks) return { finishReason: 'stop', content: JSON.stringify({ complete: true, checks: payload.checks.map((c) => ({ key: c.key, provisionId: c.provisionId, support: 'unsupported', quote: '员工怀孕本身不得作为违纪处理的理由', reason: '不能用怀孕本身认定违纪。' })) }) }
      if (payload.chunk && !payload.context) return { content: JSON.stringify({ complete: true, type: 'policy-fragment', acceptedEvidence: payload.chunk.text, background: {}, relatedSections: [] }), finishReason: 'stop' }
      return { finishReason: 'stop', content: JSON.stringify({ complete: true, findings: [{ kind: 'clause', title: '虚构测试问题', explanation: '构造一项错误修改稿供复核', evidence: [{ chunkId: payload.chunk.id, quote: '怀孕员工直接按严重违纪解除劳动合同。' }],
        authorities: [{ title: provision.lawTitle, article: provision.article }], recommendation: '直接解除', suggestedClause: '员工怀孕即解除劳动合同。' }], questions: [] }) }
    } }
  const report = await runHandbookDiagnosis(opts)
  assert.equal(report.analysisStatus, 'completed'); assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].suggestedClause, '')
  assert.equal(report.findings[0].authorities[0].supportStatus, 'model_unsupported')
  assert.equal(report.findings[0].authorities[0].applicabilityStatus, 'pending')
  assert.equal(report.findings[0].status, 'pending')
  assert.ok([...checkpoints.keys()].some((key) => key.startsWith('handbook-legal:')))
  let calls = 0
  await runHandbookDiagnosis({ ...opts, generateCompletion: async () => { calls++; throw new Error('should reuse checkpoints') } })
  assert.equal(calls, 0)
  await runHandbookDiagnosis({ ...opts, provisionLoader: async () => ({ configured: true, provisions: [{ ...provision, versionLabel: 'synthetic-v2' }], warnings: [] }) })
})
console.log(`Handbook provisions: ${passed} scenarios passed; synthetic sources only`)
