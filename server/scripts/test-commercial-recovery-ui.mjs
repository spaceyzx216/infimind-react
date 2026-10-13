import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const directory = mkdtempSync(join(tmpdir(), 'fafee-commercial-recovery-ui-'))
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let resumed = false, posts = 0
  const source = 'Article 1 Fictional source text.'
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let body = { tasks: [], threads: [], conversations: [], messages: [], balances: [] }
    if (path === '/api/auth/refresh') body = { accessToken: 'synthetic-token', expiresAt: '2099-01-01' }
    else if (path === '/api/auth/me') body = { user: { id: 'browser-test', username: 'Synthetic' } }
    else if (path === '/api/tasks/contract-review') body = { taskId: 'synthetic-recovery' }
    else if (path === '/api/tasks/synthetic-recovery/retry') { resumed = true; posts++; body = { task: { id: 'synthetic-recovery', status: 'queued' } } }
    else if (path === '/api/tasks/synthetic-recovery/events') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: resumed
        ? 'event: done\ndata: {"_seq":3}\n\n'
        : 'event: error\ndata: {"_seq":1,"message":"The next block needs checking."}\n\nevent: done\ndata: {"_seq":2}\n\n' })
    } else if (path === '/api/tasks/synthetic-recovery') body = { task: {
      id: 'synthetic-recovery', status: resumed ? 'succeeded' : 'failed', errorSummary: 'The next block needs checking.',
      result: { analysis: 'Completed mock structure', review: resumed ? 'Completed mock review' : 'No verified review yet; remaining clauses need checking.',
        contractText: source, revisions: [], reviewComplete: resumed ? undefined : false, stats: { total: 0 } }
    } }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto((process.env.FAFEE_UI_TEST_URL || 'http://localhost:5173') + '/contract-rewrite', { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from(source) })
  await page.locator('.composer textarea').fill('Synthetic review')
  await page.locator('.voice-send').click()
  const retry = page.getByRole('button', { name: '继续核对', exact: true })
  await retry.waitFor({ state: 'visible' })
  assert.ok((await page.locator('.document-column').innerText()).includes(source))
  assert.equal(await page.getByText('请检查服务配置后重新发送。', { exact: true }).count(), 0)
  assert.equal(await page.getByText('部分完成', { exact: true }).count(), 0)
  await page.screenshot({ path: join(directory, 'retained-results.png') })
  await retry.click()
  await page.waitForFunction(() => document.querySelector('.assistant-content')?.textContent.includes('Completed mock review'))
  assert.equal(posts, 1)
  assert.equal(await retry.count(), 0)
  assert.deepEqual(errors, [])
  console.log(`PASS browser recovery: source/results retained, continue completes same message, no generic error or partial label; screenshot=${directory}`)
} finally { await browser.close() }
