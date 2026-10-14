import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

// Uses an existing local frontend. All APIs are synthetic, including a local
// HTTP stream whose next event is released only after the browser assertion.
const frontend = process.env.FAFEE_UI_TEST_URL || 'http://localhost:5173'
const output = mkdtempSync(join(tmpdir(), 'fafee-review-output-ui-'))
const userId = 'review-output-test'
const taskId = 'synthetic-review-output'
const analysis = '## 合同基础识别\n\n这是虚构合同。根据《民法典》第五百七十七条核对责任。'
const risk = { level: '高', title: '虚构付款条件缺失', location: '第一条', risk: '请核对《民法典》第五百七十七条与付款条件。' }
const rounds = [{ round: 1, newCount: 1, newFindings: [risk] }, { round: 2, newCount: 0, newFindings: [] }, { round: 3, newCount: 0, newFindings: [] }]
let response, seq = 0, succeeded = false
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', new URL(frontend).origin)
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Client-ID')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  response = res
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  res.flushHeaders()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const streamUrl = `http://127.0.0.1:${server.address().port}/events`
const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, _seq: ++seq })}\n\n`)
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === `/api/tasks/${taskId}/events`) return route.continue({ url: streamUrl })
    let body = { tasks: [], threads: [], conversations: [], messages: [], balances: [] }
    if (path === '/api/auth/refresh') body = { accessToken: 'synthetic-token', expiresAt: '2099-01-01' }
    else if (path === '/api/auth/me') body = { user: { id: userId, username: '虚构测试用户' } }
    else if (path === '/api/tasks/contract-review') body = { taskId }
    else if (path === `/api/tasks/${taskId}`) body = { task: { id: taskId, status: succeeded ? 'succeeded' : 'running',
      result: succeeded ? { analysis, review: '## 审查说明\n\n虚构审查完成。', reviewRounds: rounds, revisions: [], contractText: '第一条 虚构服务合同。' } : null } }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(frontend + '/contract-rewrite', { waitUntil: 'networkidle' })
  assert.equal(await page.getByText('材料读取范围与 OCR 核对', { exact: true }).count(), 0)
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('第一条 虚构服务合同。') })
  await page.locator('.composer textarea').fill('从企业侧审查虚构合同')
  await page.locator('.voice-send').click()
  await page.waitForResponse((res) => res.url().includes('/events'))
  send('stage.start', { stage: 'analysis', label: '正在分析虚构合同' })
  send('analysis.delta', { content: analysis })
  await page.locator('.assistant-content .law-cite').waitFor()
  assert.equal(succeeded, false)
  assert.equal(await page.locator('.assistant-content').innerText(), analysis.replace('## ', ''))
  // Both tools inherit the user's workspace chat font size (default 16px).
  assert.equal(await page.locator('.assistant-content p').evaluate((el) => getComputedStyle(el).fontSize), '16px')
  assert.equal(await page.locator('.assistant-content h2').evaluate((el) => getComputedStyle(el).fontSize), '17px')
  assert.equal(await page.locator('.conversation-inner').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 820)
  send('analysis.delta', { content: '\n\n这是稍后收到的增量。' })
  await page.getByText('这是稍后收到的增量。', { exact: true }).waitFor()
  send('stage.start', { stage: 'analysis', label: '正在重试虚构分析' })
  send('analysis.delta', { content: analysis })
  await page.waitForFunction(() => !document.querySelector('.assistant-content')?.textContent.includes('这是稍后收到的增量。'))
  send('stage.start', { stage: 'review', label: '正在审查虚构合同' })
  send('review.round', { round: 1, total: 3, phase: 'end', newCount: 1, newFindings: [risk] })
  await page.locator('.round-finding').waitFor()
  assert.ok((await page.locator('.round-finding').innerText()).includes(risk.title))
  assert.equal(await page.locator('.round-finding .law-cite').count(), 1)
  // A recovered end event carries no snapshot and must not erase real findings.
  send('review.round', { round: 1, total: 3, phase: 'end', recovered: true, newCount: 0, newFindings: [] })
  send('stage.complete', { stage: 'review', roundSnapshots: rounds })
  send('review.delta', { content: '临时报告' })
  succeeded = true
  send('done', {})
  response.end()
  await page.getByText('虚构审查完成。', { exact: true }).waitFor()
  assert.equal(await page.getByText('临时报告', { exact: true }).count(), 0)
  assert.equal(await page.locator('.round-finding').count(), 1)
  assert.equal(await page.locator('.round-status').filter({ hasText: '待开始' }).count(), 0)
  await page.getByRole('button', { name: '关闭文档', exact: true }).click()
  await page.screenshot({ path: join(output, 'completed.png') })
  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.locator('.round-finding').count(), 1)
  assert.equal(await page.locator('.assistant-content .law-cite').count(), 1)
  assert.equal(await page.locator('.material-review-panel').count(), 0)
  // Reload an unfinished task to exercise the separate resubscription path.
  succeeded = false
  response = null
  seq = 0
  await page.evaluate((key) => {
    const threads = JSON.parse(localStorage.getItem(key))
    threads[0].messages.at(-1).completed = false
    localStorage.setItem(key, JSON.stringify(threads))
  }, `fafee-history-v2:${userId}:contract-review:threads`)
  const resumed = page.waitForResponse((res) => res.url().includes('/events'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await resumed
  send('stage.start', { stage: 'analysis', label: '恢复分析' })
  send('analysis.delta', { content: '恢复中的临时分析。' })
  await page.getByText('恢复中的临时分析。', { exact: true }).waitFor()
  send('stage.start', { stage: 'analysis', label: '重新分析' })
  send('analysis.delta', { content: analysis })
  send('stage.start', { stage: 'review', label: '恢复审查' })
  send('review.round', { round: 1, total: 3, phase: 'end', newCount: 1, newFindings: [risk] })
  await page.locator('.round-finding').waitFor()
  assert.equal(await page.getByText('恢复中的临时分析。', { exact: true }).count(), 0)
  send('stage.complete', { stage: 'review', roundSnapshots: rounds })
  succeeded = true
  send('done', {})
  response.end()
  await page.getByText('虚构审查完成。', { exact: true }).waitFor()
  assert.equal(await page.locator('.round-finding').count(), 1)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await page.locator('.contract-review').evaluate((el) => el.scrollWidth <= el.clientWidth))
  await page.screenshot({ path: join(output, 'mobile.png') })
  assert.deepEqual(errors, [])
  console.log(`PASS browser: real local SSE before completion, increments/retry reset, citation highlights, consultation typography, default risk details, final snapshot/history/resubscription, no OCR composer panel and mobile width; screenshots=${output}`)
} finally { response?.end(); await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
