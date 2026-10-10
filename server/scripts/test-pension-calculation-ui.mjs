import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { pensionHistoryKey } from '../../src/utils/pension-history.js'

// Standalone actual-page review with fictional authentication. Actual App and
// login protection are tested separately by test-pension-routes-ui.py.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const output = process.env.PENSION_TEST_OUTPUT || mkdtempSync(join(tmpdir(), 'pension-simple-ui-'))
mkdirSync(output, { recursive: true })
const verificationPath = join(output, 'verification.json')
writeFileSync(verificationPath, JSON.stringify({ status: 'running' }))
const entryDir = mkdtempSync(join(tmpdir(), 'pension-simple-entry-'))
const entry = join(entryDir, 'entry.jsx')
const modulePath = (value) => JSON.stringify(value.replaceAll('\\', '/'))
writeFileSync(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Routes, Route, Link } from 'react-router-dom';
import { AuthProvider } from ${modulePath(join(root, 'src/components/AuthProvider.jsx'))};
import PensionCalculationPage from ${modulePath(join(root, 'src/pages/PensionCalculationPage.jsx'))};
import PensionCalculatorContent from ${modulePath(join(root, 'src/pages/PensionCalculatorContent.jsx'))};
import ${modulePath(join(root, 'src/index.css'))};
if (!window.location.hash) window.location.hash = '/tools/pension-calc1';
createRoot(document.getElementById('root')).render(window.location.hash === '#/embedded' ? <PensionCalculatorContent /> : <AuthProvider><HashRouter><Routes>
<Route path="/tools/:toolId" element={<PensionCalculationPage />} />
<Route path="/tools" element={<main><h1>独立验收入口</h1><Link to="/tools/pension-calc1">企业职工养老</Link></main>} />
</Routes></HashRouter></AuthProvider>);`)
const bundle = await build({
  configFile: false, envFile: false, root, publicDir: false, plugins: [react()], logLevel: 'error',
  define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: { 'react-dom/client': require.resolve('react-dom/client'),
    'react-router-dom': require.resolve('react-router-dom'), react: dirname(require.resolve('react/package.json')) } },
  build: { write: false, minify: true, cssCodeSplit: false,
    lib: { entry, name: 'PensionReview', formats: ['iife'] }, rollupOptions: { output: { inlineDynamicImports: true } } }
})
const files = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((part) => part.output)
const logo = `data:image/png;base64,${readFileSync(join(root, 'public/logo.png')).toString('base64')}`
const code = files.filter((part) => part.type === 'chunk').map((part) => part.code.replaceAll('"/logo.png"', JSON.stringify(logo))).join('\n')
const css = files.filter((part) => part.type === 'asset' && part.fileName.endsWith('.css')).map((part) => part.source).join('\n')
// This downloadable review file cannot access company APIs or real accounts.
const authShim = `window.fetch = async (input) => {
  const user = { id:'fictional-pension-review', username:'验收账号', email:'review@example.invalid' };
  const path = String(input);
  const value = path === '/api/auth/refresh' ? { accessToken:'fictional-review-token', accessTokenExpiresAt:'2030-01-01T00:00:00.000Z', user }
    : path === '/api/auth/me' ? { user } : path === '/api/account/balance' ? { balances: [], isAvailable: true } : null;
  if (!value) throw new Error('独立审阅页不连接外部服务');
  return new Response(JSON.stringify(value), { status:200, headers:{'Content-Type':'application/json'} });
};`
const htmlPath = join(output, 'index.html')
writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>养老保险测算基础页（模拟账号）</title><style>${css}</style></head><body class="loaded"><div id="root"></div><script>${authShim}${code.replaceAll('</script', '<\\/script')}</script></body></html>`)
const edge = process.env.PLAYWRIGHT_EXECUTABLE_PATH || (existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined)
const browser = await chromium.launch({ headless: true, ...(edge ? { executablePath: edge } : {}) })
const checks = [], screenshots = [], errors = [], externalRequests = []
const note = (name) => { checks.push(name); console.log(`PASS ${name}`) }
const fixture = { gender:'male', currentAge:'59', retirementAge:'60', actualYears:'19', deemedYears:'0',
  recordMonth:'2025-12', currentAgeExtraMonths:'0', retirementAgeExtraMonths:'0', actualExtraMonths:'0', deemedExtraMonths:'0',
  pastAvgIndex:'100', accountBalance:'90000', localAvgWage:'8000', wageGrowth:'0', accountInterest:'0', currentMonthlyWage:'8000', futureWageGrowth:'0', grade:'100' }
async function screenshot(page, name, fullPage = true) {
  if (name.includes('结果')) await page.getByTestId('pension-result').evaluate((element) => window.scrollTo({ top:element.getBoundingClientRect().top + window.scrollY - 24, behavior:'instant' }))
  await page.screenshot({ path:join(output, name), fullPage }); screenshots.push(name)
}
try {
  const context = await browser.newContext({ viewport: { width:1440, height:1000 }, reducedMotion:'reduce' })
  await context.route('**/*', async (route) => { if (/^https?:/.test(route.request().url())) { externalRequests.push(route.request().url()); await route.abort() } else await route.continue() })
  const historyKeys = ['pension-calc1', 'pension-calc2'].map((toolId) => pensionHistoryKey('fictional-pension-review', toolId))
  const legacyValue = JSON.stringify([{ id:'legacy-record', title:'已有历史', form:fixture, result:{ ruleVersion:'older-version', components:{total:999999} } }])
  await context.addInitScript(({ keys, value }) => {
    for (const key of keys) if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
    window.__pensionStorageCalls = []
    for (const method of ['getItem','setItem','removeItem','clear']) {
      const original = Storage.prototype[method]
      Storage.prototype[method] = function(...args) {
        if (method === 'clear' || keys.includes(args[0])) window.__pensionStorageCalls.push({ method, key:args[0] })
        return original.apply(this, args)
      }
    }
  }, { keys:historyKeys, value:legacyValue })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil:'networkidle' })
  await page.locator('.pension-calculation-page').waitFor()
  assert.equal(await page.getByRole('heading', { name:'养老保险测算', exact:true }).count(), 1)
  assert.equal(await page.locator('.chat-sidebar,.pension-history-row,[name="history-search"],textarea,.composer').count(), 0)
  assert.equal(await page.getByRole('button', { name:'新建测算', exact:true }).count(), 0)
  assert.equal(await page.locator('[name="accountBalance"]').inputValue(), '')
  assert.equal(await page.locator('[name="paymentDivisor"]').count(), 0)
  assert.equal(await page.getByRole('button', { name:'企业职工', exact:true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('.pension-form-section').count(), 4)
  assert.equal((await page.locator('[name="actualYears"]').boundingBox()).y, (await page.locator('[name="actualExtraMonths"]').boundingBox()).y)
  note('统一标题、四组简表及参保类型选择，无历史侧栏或对话')
  await screenshot(page, '桌面-养老统一基础表单.png')
  const indexHelp = page.locator('.pension-field').filter({ has:page.locator('[name="pastAvgIndex"]') }).locator('details')
  assert.equal(await indexHelp.getAttribute('open'), null)
  await indexHelp.locator('summary').click()
  assert.ok((await indexHelp.innerText()).includes('0.8填80'))
  await indexHelp.locator('summary').click()
  note('复杂字段说明可展开，默认收起')
  async function fill(values) { for (const [name,value] of Object.entries(values)) { const control = page.locator(`[name="${name}"]`); if (!await control.count()) continue; if (await control.evaluate((element) => element.tagName) === 'SELECT') await control.selectOption(value); else await control.fill(value) } }
  async function calculate() { await page.locator('button[type="submit"]').click(); await page.getByTestId('pension-result').waitFor() }
  async function switchType(name) { await page.getByRole('button', { name, exact:true }).click() }
  await page.locator('button[type="submit"]').click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByTestId('pension-result').count(), 0)
  assert.equal(await page.evaluate(() => document.activeElement.name), 'gender')
  note('空值阻止计算并聚焦首个错误字段')
  await switchType('个体工商户／灵活就业人员')
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.equal(await page.locator('[name="currentMonthlyWage"],[name="futureWageGrowth"]').count(), 0)
  await switchType('企业职工')
  assert.equal(await page.locator('[name="grade"]').count(), 0)
  note('身份切换清除错误，仅显示适用字段')
  await fill(fixture); await calculate()
  assert.equal(await page.getByTestId('pension-total').innerText(), '2,302.73元／月')
  assert.ok((await page.locator('.pension-result-grid').innerText()).includes('640.00'))
  assert.equal(await page.locator('.pension-result > details').count(), 1)
  assert.equal(await page.locator('.pension-result > details').getAttribute('open'), null)
  assert.equal(await page.evaluate(() => document.activeElement.dataset.testid), 'pension-result')
  note('职工手算一致，关键结果直显，过程依据合并收起并聚焦结果')
  await screenshot(page, '桌面-企业养老结果.png', false)
  await page.locator('[name="accountBalance"]').fill('100000')
  assert.equal(await page.getByTestId('pension-result').count(), 0)
  await page.getByRole('button', { name:'重新计算', exact:true }).waitFor()
  await calculate()
  assert.equal(await page.getByTestId('pension-total').innerText(), '2,374.68元／月')
  note('修改清除旧结果，重算更新金额')
  const originalUrl = page.url()
  await page.locator('[name="futureWageGrowth"]').fill('2')
  await switchType('个体工商户／灵活就业人员')
  assert.equal(page.url(), originalUrl)
  assert.equal(await page.locator('[name="accountBalance"]').inputValue(), '100000')
  assert.equal(await page.locator('[name="grade"]').inputValue(), '')
  assert.equal(await page.getByTestId('pension-result').count(), 0)
  await page.locator('[name="grade"]').fill('60')
  await calculate()
  assert.ok((await page.locator('.pension-result-grid').innerText()).includes('960.00'))
  await switchType('企业职工')
  assert.equal(await page.locator('[name="currentMonthlyWage"]').inputValue(), '8000')
  assert.equal(await page.locator('[name="futureWageGrowth"]').inputValue(), '2')
  assert.equal(await page.locator('[name="grade"]').count(), 0)
  assert.equal(await page.getByTestId('pension-result').count(), 0)
  await switchType('个体工商户／灵活就业人员')
  assert.equal(await page.locator('[name="grade"]').inputValue(), '60')
  note('同页切换保留共同条件及各自专属字段，结果不会跨身份混用')
  await fill(fixture); await calculate()
  assert.equal(await page.getByTestId('pension-total').innerText(), '2,302.73元／月')
  assert.ok((await page.locator('.pension-result-grid').innerText()).includes('1,600.00'))
  await page.getByText('测算说明', { exact:true }).click()
  assert.equal(await page.getByRole('table').locator('tbody tr').count(), 4)
  assert.equal(await page.locator('.pension-process li').count(), 4)
  assert.ok(await page.locator('.pension-sources a').count() > 0)
  await page.getByText('测算说明', { exact:true }).click()
  note('灵活就业20%缴费手算一致，说明含档次比较、过程和来源')
  await screenshot(page, '桌面-灵活就业养老结果.png', false)
  await page.locator('[name="grade"]').fill('0.6')
  assert.ok((await page.locator('.pension-inline-help').innerText()).includes('超出本页常用比较区间'))
  await page.getByRole('button', { name:'100%', exact:true }).click()
  assert.equal(await page.locator('[name="grade"]').inputValue(), '100')
  assert.equal(await page.locator('.pension-inline-help').count(), 0)
  note('档次快捷填写和百分数异常提示保留')
  await page.getByRole('button', { name:'重置条件', exact:true }).click()
  assert.equal(await page.locator('[name="grade"]').inputValue(), '')
  assert.equal(await page.locator('[name="currentAge"]').inputValue(), '')
  assert.equal(await page.locator('[name="accountInterest"]').inputValue(), '0')
  assert.equal(await page.getByTestId('pension-result').count(), 0)
  assert.equal(await page.getByRole('button', { name:'个体工商户／灵活就业人员', exact:true }).getAttribute('aria-pressed'), 'true')
  await switchType('企业职工')
  assert.equal(await page.locator('[name="currentMonthlyWage"]').inputValue(), '')
  assert.equal(await page.locator('[name="futureWageGrowth"]').inputValue(), '0')
  note('重置清空共同条件和两类专属字段，保留当前参保类型')
  await fill({ ...fixture, currentAgeExtraMonths:'6', actualExtraMonths:'6' }); await calculate()
  assert.equal(await page.getByTestId('pension-total').innerText(), '2,275.11元／月')
  assert.ok((await page.locator('.pension-facts').innerText()).includes('6个月'))
  note('年月精度手算一致，结果用年月显示')
  await fill({ ...fixture, retirementAgeExtraMonths:'3' }); await calculate()
  assert.equal(await page.getByTestId('pension-total').count(), 0)
  assert.ok((await page.getByTestId('pension-result').innerText()).includes('计发月数'))
  await page.getByText('测算说明', { exact:true }).click()
  assert.ok(!(await page.getByTestId('pension-result').innerText()).includes('null'))
  await page.locator('[name="paymentDivisor"]').fill('138'); await calculate()
  assert.equal(await page.getByTestId('pension-total').innerText(), '2,341.74元／月')
  note('非整岁缺失计发月数保留分项，补齐后可重算')
  await fill({ ...fixture, recordMonth:'2029-09', currentAgeExtraMonths:'6', actualYears:'14', actualExtraMonths:'6' }); await calculate()
  assert.equal(await page.getByTestId('pension-total').count(), 0)
  assert.ok((await page.getByTestId('pension-result').innerText()).includes('还差6个月'))
  assert.ok((await page.getByTestId('pension-result').innerText()).includes('2030-03'))
  note('跨年份不足缴费年限时提示差额，不显示可领合计')
  await fill({ ...fixture, deemedExtraMonths:'6' }); await calculate()
  assert.equal(await page.getByTestId('pension-total').count(), 0)
  assert.ok((await page.getByTestId('pension-result').innerText()).includes('视同'))
  note('视同缴费未知条件仍提示缺项，不补造合计')
  await fill({ ...fixture, retirementAge:'58' })
  await page.locator('button[type="submit"]').click()
  await page.getByRole('alert').waitFor()
  assert.equal(await page.getByTestId('pension-result').count(), 0)
  note('退休年龄小于记录年龄时阻止计算')
  await fill(fixture); await calculate()
  for (const width of [320,390,600,768,1024,1440,1920]) {
    await page.setViewportSize({ width, height:1000 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    assert.ok(await page.locator('button[type="submit"]').isVisible())
    note(`${width}px无页面横向溢出`)
  }
  await page.setViewportSize({ width:1440, height:1000 })
  assert.deepEqual(await page.evaluate(() => window.__pensionStorageCalls), [])
  assert.deepEqual(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), historyKeys), historyKeys.map(() => legacyValue))
  note('计算、切换和重置不读取或写入历史，原有数据完整保留')
  await page.reload({ waitUntil:'networkidle' }); await page.locator('.pension-calculation-page').waitFor()
  assert.equal(await page.locator('[name="currentAge"]').inputValue(), '')
  assert.equal(await page.getByTestId('pension-result').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.__pensionStorageCalls), [])
  note('刷新从空表开始，不自动恢复历史')
  await page.goto(pathToFileURL(htmlPath).href + '#/tools/pension-calc2', { waitUntil:'networkidle' })
  assert.equal(await page.getByRole('button', { name:'个体工商户／灵活就业人员', exact:true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('[name="currentMonthlyWage"]').count(), 0)
  await screenshot(page, '桌面-灵活就业基础表单.png')
  note('旧灵活就业地址默认选择正确身份')
  await page.goto(pathToFileURL(htmlPath).href + '?review=embedded#/embedded', { waitUntil:'networkidle' })
  await page.locator('.pension-content').waitFor()
  assert.equal(await page.locator('.pension-page-header,.pension-calculation-page').count(), 0)
  await fill(fixture); await calculate()
  assert.equal(await page.getByTestId('pension-total').innerText(), '2,302.73元／月')
  note('表单内容可独立挂载，不依赖路由、认证或工作台外壳')
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, [])
  note('无浏览器异常或外部请求')
} catch (error) { writeFileSync(verificationPath, JSON.stringify({ status:'failed', checks, screenshots, error:error.message, errors, externalRequests }, null, 2)); throw error }
finally { await browser.close() }
const sourceHashes = Object.fromEntries(['src/pages/PensionCalculationPage.jsx','src/pages/PensionCalculatorContent.jsx','src/pages/PensionCalculationPage.css','src/utils/pension-calculator.js','src/utils/pension-history.js'].map((file) => [file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')]))
writeFileSync(verificationPath, JSON.stringify({ status:'passed', checks, screenshots, sourceHashes, errors, externalRequests, scope:'actual page and bare calculator; standalone fictional authentication; actual App checked separately', htmlPath }, null, 2))
console.log(JSON.stringify({ status:'passed', checks:checks.length, screenshots:screenshots.length, output }))
