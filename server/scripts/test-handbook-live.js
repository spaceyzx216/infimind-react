// Explicit opt-in; only fictional fixture files, isolated storage, no internal KB.
// node --use-env-proxy --env-file=<local-env> server/scripts/test-handbook-live.js --live --cases <cases.json> --output <directory>
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

if (!process.argv.includes('--live')) {
  console.log('须显式指定 --live；将向配置的模型发送完全虚构的测试材料，不加载公司知识库。')
  process.exit(0)
}
const arg = (key) => { const index = process.argv.indexOf(key); return index < 0 ? null : process.argv[index + 1] }
assert.ok(arg('--cases') && arg('--output'), '必须指定虚构材料清单和独立评测目录')
const manifestPath = resolve(arg('--cases'))
const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
assert.equal(manifest.syntheticOnly, true, '只接受标明完全虚构的测试清单')
const output = resolve(arg('--output'))
await mkdir(output, { recursive: true })
assert.ok(process.env.DEEPSEEK_API_KEY, '未配置模型凭据')
process.env.TASK_FAKE_LLM = 'false'
delete process.env.HANDBOOK_REFERENCE_MANIFEST
delete process.env.HANDBOOK_PROVISION_MANIFEST
let provisionCount = 0
let provisionManifestHash = ''
if (arg('--public-provision-manifest')) {
  const path = resolve(arg('--public-provision-manifest'))
  const { loadHandbookProvisions } = await import('../services/handbook-provisions.js')
  const loaded = await loadHandbookProvisions({ manifestPath: path })
  assert.ok(loaded.configured && loaded.provisions.length)
  process.env.HANDBOOK_PROVISION_MANIFEST = path
  provisionCount = loaded.provisions.length
  provisionManifestHash = createHash('sha256').update(await readFile(path)).digest('hex')
}
let referenceCount = 0
if (arg('--synthetic-reference-fixture')) {
  assert.ok(!arg('--resume-run'), '参考资料对比须使用全新独立运行')
  const fixture = JSON.parse(await readFile(resolve(arg('--synthetic-reference-fixture')), 'utf8'))
  assert.equal(fixture.syntheticOnly, true)
  assert.ok(Array.isArray(fixture.referenceDocuments) && fixture.referenceDocuments.length)
  const directory = join(output, 'synthetic-references')
  await mkdir(directory, { recursive: true })
  const documents = []
  for (const [index, doc] of fixture.referenceDocuments.entries()) {
    assert.ok(doc.fileId && doc.fileName && typeof doc.text === 'string')
    const name = `reference-${index}.txt`
    await writeFile(join(directory, name), doc.text)
    documents.push({ id: doc.fileId, title: doc.fileName, version: 'synthetic-20261012', role: 'reference', filePath: name })
  }
  process.env.HANDBOOK_REFERENCE_MANIFEST = join(directory, 'manifest.json')
  await writeFile(process.env.HANDBOOK_REFERENCE_MANIFEST, JSON.stringify({ documents }))
  referenceCount = documents.length
}
const destination = new URL(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
const nativeFetch = globalThis.fetch
const modelCalls = []
let currentCase = ''
globalThis.fetch = async (url, options) => {
  const parsed = new URL(String(url))
  if (!parsed.pathname.endsWith('/chat/completions')) return nativeFetch(url, options)
  assert.equal(parsed.origin, destination.origin)
  const body = JSON.parse(options.body)
  const call = { caseId: currentCase, model: body.model, thinking: body.thinking?.type,
    startedAt: new Date().toISOString(), inputHash: createHash('sha256').update(options.body).digest('hex') }
  modelCalls.push(call)
  const number = modelCalls.length, start = Date.now()
  await writeFile(join(output, `model-request-${number}.json`), JSON.stringify(body, null, 2))
  console.log(`${currentCase}: 模型调用 ${number} 开始`)
  try {
    const response = await nativeFetch(url, options)
    call.status = response.status
    const raw = await response.clone().text()
    await writeFile(join(output, `model-response-${number}.json`), raw)
    try { call.usage = JSON.parse(raw).usage } catch { /* failed responses may be plain text */ }
    return response
  } catch (error) { call.error = error.message; throw error }
  finally { call.ms = Date.now() - start; console.log(`${currentCase}: 模型调用 ${number} 结束 ${call.ms}ms`)
    await writeFile(join(output, 'model-calls.json'), JSON.stringify(modelCalls, null, 2)) }
}

const { initialize } = await import('../services/law-whitelist.js')
const kb = initialize(':memory:') // Empty public metadata baseline; never initialize the company's KB.
const { createBusinessDatabase } = await import('../services/business-db.js')
const { createTaskService } = await import('../services/task-service.js')
const { createTaskFileStore } = await import('../services/task-file-store.js')
const { createTaskProcessor } = await import('../services/task-processor.js')
const { createTaskQueue } = await import('../services/task-queue.js')
const { createTaskRouter } = await import('../routes/tasks.js')
const { createAuthService } = await import('../services/auth-service.js')
const { createAuthRouter } = await import('../routes/auth.js')
const { createRequireAuth } = await import('../middleware/auth.js')
const { extractHandbookText: extractText } = await import('../services/handbook-materials.js')
const { default: express } = await import('express')
const resumeRun = arg('--resume-run') ? resolve(arg('--resume-run')) : null
const sourceResults = arg('--source-results') ? resolve(arg('--source-results')) : resumeRun
assert.ok(!arg('--source-results') || resumeRun, '历史结果选择必须配合原独立数据库的resume-run')
const db = createBusinessDatabase(join(resumeRun || output, 'app-test.db'))
// A second worker on an unfinished evaluation DB can claim the other suite's
// jobs. Resume only a fully stopped run, otherwise preserve it for inspection.
if (resumeRun) {
  const unfinished = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status NOT IN ('succeeded', 'failed', 'cancelled')").get().count
  if (unfinished) { db.close(); throw new Error('原评测尚有未结束任务；请停止并核对原运行，不能并行复用同一数据库。') }
}
const taskService = createTaskService(db, { maxAttempts: 1 })
const fileStore = createTaskFileStore({ root: join(resumeRun || output, 'uploads') })
const auth = createAuthService(db, { jwtSecret: 'fictional-handbook-test-only-secret-20261011' })
const accounts = []
for (const [index, inviteCode] of (resumeRun ? [null, null] : auth.createInviteCodes(2)).entries()) {
  const username = `handbook_test_${index}`, password = 'Synthetic-Test-Only-2026'
  const user = resumeRun ? db.prepare('SELECT id FROM users WHERE username = ?').get(username)
    : await auth.register({ inviteCode, username, password, email: `${username}@invalid.test` })
  assert.ok(user, '只能恢复本脚本生成的虚构测试账号')
  accounts.push({ username, password, user })
}
const processor = createTaskProcessor({ taskService, fileStore, fakeLlm: false })
const queue = createTaskQueue({ taskService, processTask: processor.processTask, mode: 'local', concurrency: 1, workerEnabled: true })
await queue.start()
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use('/api/auth', createAuthRouter(auth))
app.use('/api', createRequireAuth(auth), createTaskRouter({ taskService, taskQueue: queue, fileStore, fakeLlm: false }))
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  return res.status(400).json({ error: error.message, code: error.code || 'test_http_error' })
})
const server = await new Promise((done) => { const listener = app.listen(0, '127.0.0.1', () => done(listener)) })
const origin = `http://127.0.0.1:${server.address().port}`
const logins = []
for (const account of accounts) {
  const response = await nativeFetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fafee-Auth': '1' }, body: JSON.stringify({ identifier: account.username, password: account.password }) })
  assert.equal(response.status, 200); logins.push(await response.json())
}
const request = (path, options = {}, account = 0) => nativeFetch(`${origin}${path}`, { ...options, headers: { Authorization: `Bearer ${logins[account].accessToken}`, ...options.headers } })
const outcomes = []
const persist = () => writeFile(join(output, 'summary.json'), JSON.stringify({ destination: destination.origin, isolated: true, fakeLlm: false, referenceCount, provisionCount, provisionManifestHash, lawMetadataCount: 0, outcomes, modelCalls }, null, 2))
async function submit(item, extra = {}) {
  const body = new FormData()
  for (const [key, value] of Object.entries({ threadId: `live-${item.id}`, action: 'analyze', mode: arg('--mode') || 'thinking', ...extra })) body.set(key, String(value))
  if (!extra.action) for (const name of item.files) body.append('files', new Blob([await readFile(join(dirname(manifestPath), '材料', name))]), name)
  const response = await request('/api/tasks/handbook-diagnosis', { method: 'POST', body })
  assert.equal(response.status, 202, await response.clone().text())
  return response.json()
}
async function waitTask(id) {
  const start = Date.now(), deadline = start + 45 * 60 * 1000
  let last, firstFindingMs = null
  while (Date.now() < deadline) {
    const response = await request(`/api/tasks/handbook-diagnosis/${id}/report`)
    assert.equal(response.status, 200)
    const { task, report } = await response.json()
    const state = `${task.status}:${task.currentStage}:${report?.coverage?.filter((row) => row.status === 'completed').length || 0}:${report?.findings?.length || 0}`
    if (state !== last) { console.log(`${currentCase}: ${state}`); last = state }
    if (report?.findings?.length && firstFindingMs === null) firstFindingMs = Date.now() - start
    if (taskService.isTerminal(task.status)) return { task, report, ms: Date.now() - start, firstFindingMs }
    await new Promise((done) => setTimeout(done, 750))
  }
  taskService.requestCancel(id, accounts[0].user.id)
  throw new Error('测试等待超过45分钟，已请求取消；未计作通过')
}
function observations(item, report) {
  const findings = report?.findings || []
  const expected = (item.expected || []).map((point) => ({ ...point, matchingFindingIds: findings.filter((finding) => {
    const serialized = JSON.stringify(finding)
    return (!point.terms?.length || point.terms.some((term) => serialized.includes(term)))
      && (!point.anchor || serialized.includes(point.anchor))
      && (!point.conflict || finding.kind === 'conflict')
      && (!point.quotes || point.quotes.every((quote) => (finding.evidence || []).some((e) => e.quote.includes(quote))))
      && (!point.crossFile || new Set(finding.evidence?.flatMap((e) => e.location?.matches?.map((match) => match.fileId) || [])).size >= 2)
  }).map((finding) => finding.id) }))
  return { expected, expectedHits: expected.filter((point) => point.matchingFindingIds.length).length,
    expectedTotal: expected.length, findings: findings.length, conflicts: findings.filter((finding) => finding.kind === 'conflict').length,
    badLocations: findings.flatMap((finding) => finding.evidence || []).filter((e) => e.location?.status !== 'found'),
    forbiddenForManualReview: item.forbidden, manualReviewRequired: true }
}
try {
  assert.equal((await nativeFetch(`${origin}/api/tasks`)).status, 401)
  const empty = new FormData(); empty.set('threadId', 'empty-input')
  assert.equal((await request('/api/tasks/handbook-diagnosis', { method: 'POST', body: empty })).status, 400)
  outcomes.push({ id: 'HTTP-auth-empty', ok: true })
  const caseIds = arg('--case')?.split(',')
  const selected = caseIds ? caseIds.map((id) => {
    const item = manifest.cases.find((candidate) => candidate.id === id)
    assert.ok(item, `不存在测试用例 ${id}`)
    return item
  }) : manifest.cases
  for (const item of selected) {
    currentCase = item.id
    const start = Date.now(), callStart = modelCalls.length
    console.log(`开始 ${item.id}: ${item.title}`)
    try {
      if (item.parseOnly && !process.argv.includes('--diagnose-formats')) {
        const parsed = await extractText({ originalname: item.files[0], buffer: await readFile(join(dirname(manifestPath), '材料', item.files[0])) })
        await writeFile(join(output, `${item.id}-parse.json`), JSON.stringify(parsed, null, 2))
        outcomes.push({ id: item.id, parseOnly: true, ms: Date.now() - start, characters: parsed.text.length,
          embeddedImageRead: parsed.text.replace(/\s/g, '').includes('超过一个工作日'), tableRead: parsed.text.includes('三') && parsed.text.includes('补正'), ok: true, note: '解析返回成功不等于图片和表格完整读取；需看覆盖项' })
      } else {
        const prior = resumeRun ? JSON.parse(await readFile(join(sourceResults, `${item.id}.json`), 'utf8')) : null
        const submitted = await submit(item, prior ? { action: 'restart', sourceTaskId: prior.task.id } : {})
        assert.equal((await request(`/api/tasks/handbook-diagnosis/${submitted.taskId}/report`, {}, 1)).status, 404)
        const actual = await waitTask(submitted.taskId)
        await writeFile(join(output, `${item.id}.json`), JSON.stringify(actual, null, 2))
        const events = taskService.getEvents(submitted.taskId, accounts[0].user.id, 0, 10000)
        await writeFile(join(output, `${item.id}-events.json`), JSON.stringify(events, null, 2))
        // Evaluation evidence only: capture the real candidate inputs and final
        // scope structure, including model links; do not equate coverage with recall.
        await writeFile(join(output, `${item.id}-checkpoints.json`), JSON.stringify(taskService.listCheckpoints(submitted.taskId), null, 2))
        const observed = observations(item, actual.report)
        outcomes.push({ id: item.id, resumedFrom: prior?.task.id || '', status: actual.task.status, analysisStatus: actual.report?.analysisStatus, errorCode: actual.task.errorCode,
          error: actual.task.errorSummary, ms: Date.now() - start, firstFindingMs: actual.firstFindingMs, modelCalls: modelCalls.length - callStart,
          coverage: actual.report?.coverage, relationCoverage: actual.report?.relationCoverage,
          ok: actual.task.status === 'succeeded' && actual.report?.analysisStatus === (item.blocked ? 'blocked' : 'completed'), ...observed })
        if (item.id === 'T14' && actual.report?.analysisStatus === 'blocked') {
          const resumed = await submit(item, { action: 'restart', sourceTaskId: submitted.taskId, allowPartial: true })
          const result = await waitTask(resumed.taskId)
          await writeFile(join(output, `${item.id}-partial.json`), JSON.stringify(result, null, 2))
          outcomes.push({ id: 'T14-explicit-partial', status: result.task.status, analysisStatus: result.report?.analysisStatus,
            ok: result.task.status === 'succeeded' && result.report?.analysisStatus === 'completed' })
        }
        if (item.id === 'T08' && actual.report?.analysisStatus === 'completed') {
          const replay = await request(`/api/tasks/${submitted.taskId}/events?after=0`)
          const stream = await replay.text()
          assert.ok(stream.includes('event: task.succeeded'))
          await writeFile(join(output, 'T08-sse.txt'), stream)
          const followup = await submit(item, { action: 'followup', sourceTaskId: submitted.taskId, message: '请只解释两份文件的发薪日期差异，引用本次材料，不重写完整报告。' })
          const result = await waitTask(followup.taskId)
          await writeFile(join(output, 'T08-followup.json'), JSON.stringify(result, null, 2))
          outcomes.push({ id: 'T08-followup-SSE', status: result.task.status, ok: result.task.status === 'succeeded' })
        }
      }
    } catch (error) { outcomes.push({ id: item.id, ok: false, error: error.message, ms: Date.now() - start }); console.error(`${item.id}: ${error.message}`) }
    await persist()
  }
} finally {
  await persist()
  await new Promise((done) => server.close(done))
  const closingDeadline = Date.now() + 5000
  while (queue.activeCount && Date.now() < closingDeadline) await new Promise((done) => setTimeout(done, 50))
  if (queue.activeCount) { await queue.close(); throw new Error('评测工作尚未结束，保留数据库，不冒称完整退出。') }
  await queue.close(); db.close(); kb.close(); globalThis.fetch = nativeFetch
}
console.log(`测试记录：${output}；需人工核对诊断点，不能把HTTP成功率当作法律准确率。`)
if (outcomes.some((row) => !row.ok)) process.exitCode = 1
