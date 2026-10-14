import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const output = mkdtempSync(join(tmpdir(), 'fafee-material-ui-'))
const path = (p) => JSON.stringify(join(root, p).replaceAll('\\', '/'))
const entry = join(output, 'entry.jsx')
writeFileSync(entry, `import React from 'react'; import {createRoot} from 'react-dom/client';
import App from ${path('src/App.jsx')}; import Panel from ${path('src/components/MaterialReviewPanel.jsx')};
import ${path('src/index.css')};
createRoot(document.getElementById('root')).render(location.pathname === '/review' ? <div style={{maxWidth:800,margin:'40px auto'}}><Panel taskId="ui-task" /></div> : <App/>);`)
const bundle = await build({ define: { 'process.env.NODE_ENV': '"production"' }, configFile: false, envFile: false, root, publicDir: false, plugins: [react()], logLevel: 'error',
  resolve: { alias: { react: dirname(require.resolve('react/package.json')), 'react-dom/client': require.resolve('react-dom/client') } },
  build: { write: false, cssCodeSplit: false, minify: true, lib: { entry, name: 'MaterialReview', formats: ['iife'] }, rollupOptions: { output: { inlineDynamicImports: true } } } })
const files = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((b) => b.output)
const code = files.filter((f) => f.type === 'chunk').map((f) => f.code).join('\n')
const css = files.filter((f) => f.type === 'asset' && f.fileName.endsWith('.css')).map((f) => f.source).join('\n')
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="loaded"><div id="root"></div><script>${code}</script></body></html>`
writeFileSync(join(output, 'index.html'), html)
const server = createServer((req, res) => {
  if (req.url === '/logo.png') { res.setHeader('Content-Type', 'image/png'); res.end(readFileSync(join(root, 'public/logo.png'))); return }
  res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html)
})
await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
const base = `http://127.0.0.1:${server.address().port}`
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const browser = await chromium.launch({ headless: true, ...(existsSync(edge) ? { executablePath: edge } : {}) })
const errors = [], checks = []
let expired = false, allFailed = false, manyRegions = false
const png = readFileSync(join(root, 'public/logo.png'))
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()), p = url.pathname
    if (/\/regions\/word-\d+$/.test(p)) return route.fulfill(expired ? { status: 410, contentType: 'application/json', body: '{"error":"原件已到保存期限，无法查看原图"}' } : { status: 200, contentType: 'image/png', body: png })
    const body = p.endsWith('/materials') ? (allFailed ? { documents: [], failures: [{ fileId: 'failed', fileName: '虚构坏文件.xlsx', reason: '文件内容与扩展名不一致' }], coverage: { parsed: 0, partial: true } } : { documents: [{ fileId: 'file-a', fileName: '虚构工资截图.png', completeness: 'complete', warnings: ['OCR文字待核对'], ocrRegionCount: 1 }], coverage: { parsed: 2, indexed: ['a', 'b'], selected: ['b'], checked: [], partial: true } })
      : p.endsWith('/materials/file-a') ? { fileId: 'file-a', fileName: '虚构工资截图.png', text: '工资8000元', warnings: [], regions: manyRegions ? Array.from({length:101},(_,i)=>({id:`word-${i}`,text:`字段${i}`,reason:'关键文字待核对',candidates:[]})) : [{ id: 'word-0', text: '8000', reason: '关键文字待核对', candidates: ['80000'] }] }
        : p === '/api/auth/refresh' ? { accessToken: 'browser-test-only', expiresAt: '2099-01-01' }
          : p === '/api/auth/me' ? { user: { id: 'material-ui-user', username: '虚构用户', email: 'test@example.invalid' } }
            : { tasks: [], threads: [], conversations: [], messages: [], balances: [] }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(base + '/review', { waitUntil: 'networkidle' })
  await page.locator('.material-review-panel > summary').click()
  await page.getByRole('button', { name: /查看识别文字与原图/ }).click()
  await page.getByRole('button', { name: '8000 · 关键文字待核对' }).click()
  await page.getByAltText('原图核对：8000').waitFor()
  assert.match(await page.locator('.material-review-panel').innerText(), /不会自动修改原文/)
  await page.waitForFunction(() => getComputedStyle(document.body).opacity === '1')
  await page.screenshot({ path: join(output, 'ocr-review.png'), fullPage: true })
  checks.push('展开读取范围、可疑文字和鉴权图片预览')
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.material-review-panel > summary').click()
  expired = true
  await page.getByRole('button', { name: /查看识别文字与原图/ }).click()
  await page.getByRole('button', { name: '8000 · 关键文字待核对' }).click()
  await page.getByRole('alert').filter({ hasText: '原件已到保存期限' }).waitFor()
  checks.push('刷新恢复与原件到期提示')
  allFailed = true
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.material-review-panel > summary').click()
  await page.getByRole('alert').filter({ hasText: '虚构坏文件.xlsx' }).waitFor()
  checks.push('全部解析失败的提示刷新后仍保留')
  expired = false; allFailed = false; manyRegions = true
  await page.reload({waitUntil:'networkidle'})
  await page.locator('.material-review-panel > summary').click()
  await page.getByRole('button',{name:/查看识别文字与原图/}).click()
  await page.getByRole('button',{name:'字段0 · 关键文字待核对'}).waitFor()
  assert.equal(await page.locator('.material-review-regions button').count(),100)
  await page.getByRole('navigation',{name:'OCR核对区域分页'}).getByRole('button',{name:'下一页'}).click()
  await page.getByRole('button',{name:'字段100 · 关键文字待核对'}).waitFor()
  assert.equal(await page.locator('.material-review-regions button').count(),1)
  await page.getByRole('button',{name:'字段100 · 关键文字待核对'}).click()
  await page.getByAltText('原图核对：字段100').waitFor()
  checks.push('大量可疑区域分页并保持稳定原图定位')
  for (const route of ['/contract-rewrite', '/contract-draft', '/labor-consult', '/tools/labor-contract', '/tools/arbitration', ...(existsSync(join(root, 'src/pages/HandbookDiagnosisPage.jsx')) ? ['/tools/handbook'] : [])]) {
    await page.goto(base + route, { waitUntil: 'networkidle' })
    const input = page.locator('input[type="file"]')
    await input.waitFor({ state: 'attached' })
    const accepted = await input.getAttribute('accept')
    for (const ext of ['.xlsx', '.pptx', '.csv', '.md']) assert.ok(accepted.includes(ext), `${route}: ${ext}`)
    checks.push(`${route}实际页面挂载与统一上传格式`)
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'verification.json'), JSON.stringify({ checks, errors }, null, 2))
  console.log(JSON.stringify({ output, checks, errors }, null, 2))
} catch (error) { console.log(JSON.stringify({ output, errors, message: error.message })); throw error } finally { await browser.close(); await new Promise((resolveClosed) => server.close(resolveClosed)) }
