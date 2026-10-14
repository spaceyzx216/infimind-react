import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

// Every API request is intercepted; only synthetic documents enter the browser.
const directory = mkdtempSync(join(tmpdir(), 'fafee-document-entry-ui-'))
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) })
const source = '第一条 付款期限为十五日。\n第二条 解除条件由双方确认。'
const revision = { findingId: 'synthetic-risk', action: 'modify', title: '虚构付款提示', level: '中', lineStart: 0, lineEnd: 0,
  originalText: '付款期限为十五日', rewrittenText: '付款期限由双方书面确认。', riskNote: '虚构提示，非法律意见。',
  localizedEdits: [{ editId: 'synthetic-edit', lineStart: 0, lineEnd: 0, targetQuote: '付款期限为十五日', replacementText: '付款期限由双方书面确认',
    quoteSpans: [{ line: 0, start: 4, end: 12 }], operation: 'replace' }] }
const standard = { role: 'assistant', id: 'answer', content: '虚构已保存报告。', contractText: source, revisions: [revision], phase: 'rewrite', completed: true }
const cases = [
  { name: 'zero-revisions', message: { ...standard, revisions: [] }, cards: 0 },
  { name: 'duplicate-numbers', message: { ...standard, revisions: [{ ...revision, localizedEdits: [
    { ...revision.localizedEdits[0], editId: 'first', markerNumber: 1 }, { ...revision.localizedEdits[0], editId: 'second', markerNumber: 1 }
  ] }] }, cards: 2 },
  { name: 'missing-phase', message: { ...standard, phase: undefined }, cards: 1 },
  { name: 'original-only', message: { ...standard, contractText: undefined, originalText: source, revisions: [] }, cards: 0 },
  { name: 'persisted-report-only', message: { ...standard, contractText: undefined, revisions: [], phase: undefined }, cards: 1 },
  { name: 'disabled-panel-manual-open', message: standard, panelEnabled: false, cards: 1 },
  { name: 'malformed-edit', message: { ...standard, revisions: [{ ...revision, localizedEdits: [null, revision.localizedEdits[0]] }] }, cards: 1 },
  { name: 'file-marker-line-offset', message: { ...standard, contractText: `=== 文件：虚构合同 ===\n${source}`, revisions: [{ ...revision,
    lineStart: 2, lineEnd: 2, localizedEdits: [{ ...revision.localizedEdits[0], lineStart: 2, lineEnd: 2,
      targetQuote: '解除条件由双方确认', quoteSpans: [{ line: 2, start: 4, end: 12 }] }] }] }, cards: 1 },
  { name: 'invalid-line-keeps-document', message: { ...standard, revisions: [{ ...revision, lineStart: 999, lineEnd: 999,
    localizedEdits: [{ ...revision.localizedEdits[0], lineStart: 999, lineEnd: 999, quoteSpans: [] }] }] }, cards: 0 },
  { name: 'dropped-rewrite-event', fresh: true, cards: 1 }
]
const outcomes = []
try {
  for (const scenario of cases) {
    if (process.env.FAFEE_DOCUMENT_CASE && scenario.name !== process.env.FAFEE_DOCUMENT_CASE) continue
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await context.addInitScript(({ scenario, source }) => {
      localStorage.setItem('fafee-workspace-settings-v1:browser-test', JSON.stringify({ analysisPanel: scenario.panelEnabled !== false }))
      if (!scenario.fresh) localStorage.setItem('fafee-history-v2:browser-test:contract-review:threads', JSON.stringify([{
        id: 'entry-test', taskId: 'doc-task', title: '虚构入口测试', createdAt: Date.now(), updatedAt: Date.now(),
        messages: [{ id: 'question', role: 'user', content: '虚构审查。' }, scenario.message]
      }]))
      void source
    }, { scenario, source })
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      let body = { tasks: [], threads: [], conversations: [], messages: [], balances: [] }
      if (path === '/api/auth/refresh') body = { accessToken: 'synthetic-token', expiresAt: '2099-01-01' }
      else if (path === '/api/auth/me') body = { user: { id: 'browser-test', username: 'Synthetic' } }
      else if (path === '/api/tasks/contract-review') body = { taskId: 'doc-task' }
      else if (path === '/api/tasks/doc-task/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: done\ndata: {"_seq":1}\n\n' })
      else if (path === '/api/tasks/doc-task') body = { task: { id: 'doc-task', status: 'succeeded',
        result: { contractText: source, revisions: [revision], analysis: '虚构分析。', review: '虚构审查。', stats: { total: 1 } } } }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    try {
      await page.goto((process.env.FAFEE_UI_TEST_URL || 'http://localhost:5173') + '/contract-rewrite', { waitUntil: 'networkidle' })
      if (scenario.fresh) {
        await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from(source) })
        await page.locator('.composer textarea').fill('虚构审查。')
        await page.locator('.voice-send').click()
        await page.locator('.open-document-card').waitFor({ state: 'visible', timeout: 5000 })
      }
      const entry = page.locator('.open-document-card')
      assert.equal(await entry.count(), 1, 'A saved document must offer its entry independently of phase or risk count')
      if (scenario.panelEnabled === false) {
        assert.equal(await entry.isVisible(), false, 'Disabled analysis panel intentionally hides the entry')
        await page.evaluate(() => {
          const key = 'fafee-workspace-settings-v1:browser-test'
          const value = JSON.stringify({ analysisPanel: true })
          localStorage.setItem(key, value)
          window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
        })
      }
      await entry.click({ timeout: 1500 })
      assert.equal(await page.locator('.document-column').count(), 1, 'An explicit document click must open the panel')
      assert.ok((await page.locator('.revision-document').innerText()).includes('第二条'), 'Original text must remain available')
      assert.equal(await page.locator('.local-edit-card').count(), scenario.cards, 'Verified line offsets must keep the expected annotation cards')
      if (scenario.name === 'file-marker-line-offset') {
        assert.equal(await page.locator('.clause-text[data-source-line="2"] .quote-marker').count(), 1, 'Physical source lines must survive hidden file markers')
        const downloaded = page.waitForEvent('download', { timeout: 5000 }).then((value) => ({ value }), (error) => ({ error }))
        await page.locator('.document-header').getByRole('button', { name: '下载', exact: true }).click({ timeout: 1500 })
        const { value: download, error: downloadError } = await downloaded
        if (downloadError) throw downloadError
        const html = readFileSync(await download.path(), 'utf8')
        assert.equal((html.match(/class="local-edit"/g) || []).length, 1, 'Word export must preserve the same source-anchored annotation')
        assert.ok(html.includes('class="mark"') && html.includes('<sup>1</sup>'), 'Word export must keep source highlight numbering')
        assert.ok(!html.includes('=== 文件'), 'Hidden file markers must not appear in exported prose')
      }
      assert.deepEqual(errors, [], 'Malformed optional data must not crash the page')
      await page.screenshot({ path: join(directory, `${scenario.name}.png`) })
      outcomes.push({ name: scenario.name, passed: true })
    } catch (error) {
      outcomes.push({ name: scenario.name, passed: false, error: error.message, pageErrors: errors })
      await page.screenshot({ path: join(directory, `${scenario.name}-failed.png`) }).catch(() => {})
    } finally { await context.close() }
  }
} finally { await browser.close() }
writeFileSync(join(directory, 'outcomes.json'), JSON.stringify(outcomes, null, 2))
console.log(JSON.stringify({ directory, outcomes }))
assert.ok(outcomes.every((item) => item.passed), 'Document entry scenarios must all pass')
