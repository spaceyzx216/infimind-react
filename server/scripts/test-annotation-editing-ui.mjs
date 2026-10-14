// 批注人工编辑的浏览器回归：商业合同审查 + 劳动合同分析。
//
// 验收契约（用户口径）：批注稿里每条批注都能人工改写；复制与下载 Word 导出的都是
// 最后确认的意见，而不是模型初稿；刷新后编辑仍在。
//
// 运行前提：前端 Vite 已在 5173（`npm run dev`）。全部 `/api/**` 被拦截并注入合成数据，
// 不触达真实后端、模型、数据库；不写任何业务文件（下载内容在内存里截获）。
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { annotationTargetOf, buildDisplayRevisions } from '../../src/utils/revision-annotations.js'

const BASE = process.env.FAFEE_UI_BASE || 'http://localhost:5173'
const USER_ID = 'annotation-edit-ui'
const CONTRACT = [
  '# 采购框架协议',
  '',
  '第一条 甲方应在收到发票后九十个自然日内付款。',
  '第二条 乙方逾期交货的，按日万分之五支付违约金。'
].join('\n')

const revisions = [
  {
    findingId: 'finding-pay',
    action: 'modify',
    level: '高',
    lineStart: 2,
    lineEnd: 2,
    rewrittenText: '第一条 甲方应在收到发票后三十个自然日内付款。',
    riskNote: '账期过长，占用乙方现金流。',
    localizedEdits: [{
      editId: 'finding-pay-local-1',
      markerNumber: 1,
      operation: 'replace',
      targetQuote: '九十个自然日内付款',
      replacementText: '三十个自然日内付款',
      riskNote: '账期超出行业惯例。',
      quoteSpans: [{ line: 2, start: 13, end: 22 }]
    }]
  },
  {
    findingId: 'finding-penalty',
    action: 'add',
    level: '中',
    title: '补充违约金上限',
    insertAfterLine: 3,
    anchorText: '第二条 乙方逾期交货的，按日万分之五支付违约金。',
    rewrittenText: '违约金累计不超过合同总价的百分之五。',
    riskNote: '避免违约金过高被调减。'
  }
]

const launch = async () => {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' })
  } catch {
    return await chromium.launch({ headless: true })
  }
}

// 截获 Blob 导出内容：下载走的是 Blob + a[download]，用 createObjectURL 钩子在内存里取回。
const captureExports = () => {
  window.__exported = []
  const original = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (blob) => { window.__exported.push(blob); return original(blob) }
  window.__exportedText = async () => (window.__exported.at(-1) ? window.__exported.at(-1).text() : '')
  navigator.clipboard.writeText = async (text) => { window.__copied = text }
}
const lastExportText = (page) => page.evaluate(() => window.__exportedText())
const copiedText = (page) => page.evaluate(() => window.__copied || '')

const mockApi = async (page, extra) => page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url())
  // 返回 true 以便 extra 里的处理结果能被识别为“已响应”，避免二次 fulfill。
  const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).then(() => true)
  if (url.pathname === '/api/auth/refresh') return send({ accessToken: 'synthetic-token', expiresAt: '2099-01-01' })
  if (url.pathname === '/api/auth/me') return send({ user: { id: USER_ID, username: '合成测试', email: 'ui@example.test' } })
  const handled = extra ? await extra(url, send) : null
  if (handled) return handled
  return send({ tasks: [], threads: [], conversations: [], messages: [], balances: [] })
})

const errorsOf = (page) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

// 场景 1：商业合同审查 —— 就地改批注，复制/下载取改后意见，刷新后仍在。
async function commercialReview(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = errorsOf(page)
  await page.addInitScript(captureExports)
  await mockApi(page)
  // 历史会话直接落盘：审查结果本来就存在 localStorage，这里只复用真实读写路径。
  await page.goto(`${BASE}/contract-rewrite`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ key, contract, revs }) => {
    const now = Date.now()
    localStorage.setItem(key, JSON.stringify([{
      id: 'thread-edit', title: '商业合同审查与批注', taskId: null, createdAt: now, updatedAt: now,
      messages: [{
        id: 'message-edit', role: 'assistant', content: '审查完成。', status: '', completed: true, createdAt: now,
        contractText: contract, originalText: contract, revisions: revs,
        rewriteStats: { total: 2, blocks: 2, modify: 1, add: 1, delete: 0 }
      }]
    }]))
  }, { key: `fafee-history-v2:${USER_ID}:contract-review:threads`, contract: CONTRACT, revs: revisions })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.open-document-card').click()
  const cards = page.locator('.revision-stack .local-edit-card, .revision-stack .compact-revision-card')
  await cards.first().waitFor()
  assert.equal(await cards.count(), 2)

  // 1.1 无编辑时复制的是模型意见，且带“最终确认意见”表头。
  await page.locator('.document-header button', { hasText: '复制' }).click()
  const before = await copiedText(page)
  assert.ok(before.includes('第一条 甲方应在收到发票后九十个自然日内付款【1】。'))
  assert.ok(before.includes('【1】改为：三十个自然日内付款'))
  assert.ok(before.includes('商业合同审查与批注（最终确认意见）'))

  // 1.2 就地编辑第 1 条批注：改意见与批注说明。
  await cards.first().locator('.annotation-edit-button').click()
  const form = page.locator('.annotation-edit-card .annotation-edit-form')
  await form.waitFor()
  await page.screenshot({ path: process.env.FAFEE_UI_SHOT_FORM || '/tmp/annotation-edit-form.png' })
  await form.locator('textarea').first().fill('三十个自然日内付款（财务已确认）')
  await form.locator('textarea').nth(1).fill('账期已与财务确认，按三十日执行。')
  await form.getByRole('button', { name: '保存批注' }).click()
  await form.waitFor({ state: 'detached' })
  assert.ok((await cards.first().innerText()).includes('三十个自然日内付款（财务已确认）'))
  assert.equal(await cards.first().locator('.annotation-edited-badge').count(), 1)
  assert.equal(await page.locator('.annotation-edit-status button').count(), 1)
  await page.screenshot({ path: process.env.FAFEE_UI_SHOT_SAVED || '/tmp/annotation-edit-saved.png' })
  assert.ok((await page.locator('.annotation-edit-status button').innerText()).includes('1'))

  // 1.3 复制导出的是改后意见。
  await page.locator('.document-header button', { hasText: '复制' }).click()
  const after = await copiedText(page)
  assert.ok(after.includes('【1】改为：三十个自然日内付款（财务已确认）'))
  assert.ok(after.includes('批注：账期已与财务确认，按三十日执行。'))
  assert.ok(!after.includes('【1】改为：三十个自然日内付款\n'))
  assert.ok(after.includes('其中 1 条已人工修改'))
  assert.equal(await page.locator('.document-header button', { hasText: '已复制' }).count(), 1)

  // 1.4 下载 Word 走的也是改后意见，且不再出现模型原文。
  await page.locator('.document-header button', { hasText: '下载' }).click()
  const doc = await lastExportText(page)
  assert.ok(doc.includes('三十个自然日内付款（财务已确认）'))
  assert.ok(doc.includes('账期已与财务确认，按三十日执行。'))
  assert.ok(!doc.includes('【1】改为：三十个自然日内付款<'))
  assert.ok(doc.includes('<span class="badge">1</span>'))
  // 人工改过的完整条款建议在页面、复制、Word 三处同口径出现，不能只在页面可见。
  assert.ok(doc.includes('完整条款建议'))
  assert.ok(doc.includes('第一条 甲方应在收到发票后三十个自然日内付款。'))
  assert.ok(after.includes('完整条款建议：第一条 甲方应在收到发票后三十个自然日内付款。'))

  // 1.5 刷新后编辑仍在（随消息持久化），恢复原稿后回到模型意见。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.open-document-card').click()
  await page.locator('.revision-stack .local-edit-card').first().waitFor()
  assert.ok((await cards.first().innerText()).includes('三十个自然日内付款（财务已确认）'))
  await cards.first().locator('.annotation-edit-button').click()
  await page.locator('.annotation-edit-card .annotation-edit-form').getByRole('button', { name: '恢复 AI 原稿' }).click()
  await page.locator('.annotation-edit-card .annotation-edit-form').waitFor({ state: 'detached' })
  assert.ok((await cards.first().innerText()).includes('三十个自然日内付款'))
  assert.equal(await cards.first().locator('.annotation-edited-badge').count(), 0)

  // 1.6 非局部批注（新增条款）也能编辑标题与正文。
  await cards.nth(1).locator('.annotation-edit-button').click()
  const compactForm = page.locator('.annotation-edit-card .annotation-edit-form')
  await compactForm.locator('input').fill('补充违约金上限（已确认）')
  await compactForm.locator('textarea').first().fill('违约金累计不超过合同总价的百分之三。')
  await compactForm.getByRole('button', { name: '保存批注' }).click()
  await compactForm.waitFor({ state: 'detached' })
  await page.locator('.document-header button', { hasText: '复制' }).click()
  const finalText = await copiedText(page)
  assert.ok(finalText.includes('【新增】补充违约金上限（已确认）'))
  assert.ok(finalText.includes('违约金累计不超过合同总价的百分之三。'))

  // 1.7 全部恢复：回到模型初稿。
  await page.locator('.annotation-edit-status button').click()
  assert.equal(await page.locator('.annotation-edited-badge').count(), 0)
  await page.locator('.document-header button', { hasText: '复制' }).click()
  const restored = await copiedText(page)
  assert.ok(restored.includes('【1】改为：三十个自然日内付款'))
  assert.ok(restored.includes('【新增】补充违约金上限'))
  assert.ok(!restored.includes('已人工修改'))
  await page.screenshot({ path: process.env.FAFEE_UI_SHOT || '/tmp/annotation-edit-commercial.png' })

  // 1.7b 人工输入的特殊字符在 Word 导出里被转义，不破坏文档结构。
  await cards.first().locator('.annotation-edit-button').click()
  const escapeForm = page.locator('.annotation-edit-card .annotation-edit-form')
  await escapeForm.locator('textarea').first().fill('**加粗** <b>标签</b> & "引号"')
  await escapeForm.getByRole('button', { name: '保存批注' }).click()
  await escapeForm.waitFor({ state: 'detached' })
  await page.locator('.document-header button', { hasText: '下载' }).click()
  const escapedDoc = await lastExportText(page)
  // `&` 与 `<` 被转义（`>` 在文本节点里无需转义），用户输入不会变成真的标签。
  assert.ok(escapedDoc.includes('<strong>加粗</strong> &lt;b>标签&lt;/b> &amp; "引号"'))
  assert.ok(!escapedDoc.includes('<b>标签</b>'))
  assert.ok(!escapedDoc.includes('&amp;lt;'))

  // 1.8 手机上仍能就地编辑，且不产生横向溢出。
  await page.setViewportSize({ width: 390, height: 844 })
  await cards.first().locator('.annotation-edit-button').click()
  const mobileForm = page.locator('.annotation-edit-card .annotation-edit-form')
  await mobileForm.waitFor()
  assert.ok(await page.locator('.contract-review').evaluate((el) => el.scrollWidth <= el.clientWidth))
  await mobileForm.getByRole('button', { name: '取消' }).click()
  await mobileForm.waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 1600, height: 1000 })

  // 1.9 同一会话重跑、位置序号相同但条款不同（对齐 applyRecoveredTask 落地新结果的路径）：
  //     锚点指纹让上一版的人工意见失效，不能把旧意见当成新条款的最终意见导出。
  const rerunRevision = {
    findingId: 'finding-pay', action: 'modify', level: '中', lineStart: 3, lineEnd: 3,
    rewrittenText: '第二条 乙方逾期交货的，按日万分之三支付违约金。', riskNote: '重跑意见。',
    localizedEdits: [{
      editId: 'finding-pay-local-1', markerNumber: 1, operation: 'replace',
      targetQuote: '按日万分之五支付违约金', replacementText: '按日万分之三支付违约金',
      riskNote: '重跑意见。', quoteSpans: [{ line: 3, start: 8, end: 19 }]
    }]
  }
  await page.evaluate(({ key, contract, revs, edits }) => {
    const now = Date.now()
    localStorage.setItem(key, JSON.stringify([{
      id: 'thread-rerun', title: '重跑后的审查', taskId: 'task-rerun', createdAt: now, updatedAt: now,
      messages: [{
        id: 'message-rerun', role: 'assistant', content: '重跑完成。', status: '', completed: true, createdAt: now,
        contractText: contract, originalText: contract, revisions: revs, annotationEdits: edits
      }]
    }]))
  }, {
    key: `fafee-history-v2:${USER_ID}:contract-review:threads`,
    contract: CONTRACT,
    revs: [rerunRevision],
    edits: { 'finding-pay-local-1': { rewrittenText: '三十个自然日内付款（财务已确认）', target: annotationTargetOf(buildDisplayRevisions([revisions[0]])[0]) } }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.open-document-card').click()
  const rerunCard = page.locator('.revision-stack .local-edit-card').first()
  await rerunCard.waitFor()
  const rerunText = await rerunCard.innerText()
  assert.ok(rerunText.includes('按日万分之三支付违约金'))
  assert.ok(!rerunText.includes('三十个自然日内付款（财务已确认）'))
  assert.equal(await rerunCard.locator('.annotation-edited-badge').count(), 0)
  assert.equal(await page.locator('.annotation-edit-status button').count(), 0)
  await page.locator('.document-header button', { hasText: '复制' }).click()
  const rerunCopied = await copiedText(page)
  assert.ok(rerunCopied.includes('【1】改为：按日万分之三支付违约金'))
  assert.ok(!rerunCopied.includes('三十个自然日内付款（财务已确认）'))

  assert.deepEqual(errors, [])
  await page.close()
  return ['商业合同审查：就地编辑/复制/下载/刷新持久化/恢复原稿/全部恢复/重跑换条款后旧意见失效']
}

// 场景 2：劳动合同分析 —— 报告任务结果只读，编辑按任务 id 存在本浏览器。
async function laborAnalysis(browser) {
  const taskId = 'task-annotation-edit'
  const sourceText = '劳动合同\n甲方：虚构测试公司\n第三条 月工资为8000元。\n'
  const task = {
    id: taskId, threadId: taskId, productId: 'labor-contract-analysis', title: '劳动合同测试', action: 'analyze',
    mode: 'fast', analysisType: 'ordinary_labor_contract', reviewPerspective: 'using_unit',
    createdAt: new Date().toISOString(), files: [], status: 'succeeded',
    result: {
      productId: 'labor-contract-analysis', analysisStatus: 'completed', schemaVersion: 3, kind: 'analysis',
      analysisType: 'ordinary_labor_contract',
      sourceDocuments: [{ fileId: 'f1', fileName: '劳动合同.txt', text: sourceText }],
      contractInfo: { employer: '虚构测试公司', employee: '虚构员工' },
      score: { value: 82 },
      reviewReport: '# 逐条批注\n\n合成报告。',
      revisions: [{
        findingId: 'finding-1', action: 'modify', level: '高', lineStart: 3, lineEnd: 3,
        rewrittenText: '第三条 月工资为8000元，于每月10日前支付。', riskNote: '支付日期缺失。',
        localizedEdits: [{
          editId: 'finding-1-local-1', markerNumber: 1, operation: 'replace',
          targetQuote: '月工资为8000元。', replacementText: '月工资为8000元，于每月10日前支付。',
          riskNote: '未约定支付日期。', quoteSpans: [{ line: 3, start: 0, end: 10 }]
        }]
      }]
    }
  }
  // 重新分析出的新报告：result.sourceTaskId 指回原任务，批注 ID 仍是位置序号。
  const reanalyzed = {
    ...task, id: 'task-reanalyzed',
    result: {
      ...task.result,
      sourceTaskId: taskId,
      reviewReport: '# 逐条批注\n\n重新分析报告。',
      revisions: [{
        findingId: 'finding-1', action: 'modify', level: '中', lineStart: 3, lineEnd: 3,
        rewrittenText: '第三条 月工资为8000元，按公司薪酬制度发放。', riskNote: '重跑后的新意见。',
        localizedEdits: [{
          editId: 'finding-1-local-1', markerNumber: 1, operation: 'replace',
          targetQuote: '月工资为8000元。', replacementText: '月工资为8000元，按公司薪酬制度发放。',
          riskNote: '重跑后的新意见。', quoteSpans: [{ line: 3, start: 0, end: 10 }]
        }]
      }]
    }
  }
  const threadTasks = [task, reanalyzed]
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = errorsOf(page)
  await page.addInitScript(captureExports)
  await mockApi(page, async (url, send) => {
    if (url.pathname === '/api/tasks/labor-contract-analysis/thread/' + taskId) return send({ tasks: threadTasks })
    if (url.pathname === '/api/tasks/labor-contract-analysis/thread/' + reanalyzed.id) return send({ tasks: threadTasks })
    if (url.pathname.startsWith('/api/tasks/labor-contract-analysis/source/')) return send({ documents: task.result.sourceDocuments })
    if (url.pathname === '/api/tasks') return send({ tasks: threadTasks })
    if (url.pathname === `/api/tasks/${taskId}`) return send({ task })
    if (url.pathname === `/api/tasks/${reanalyzed.id}`) return send({ task: reanalyzed })
    return null
  })
  await page.goto(`${BASE}/tools/labor-contract?taskId=${taskId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.lca-open-report-card').first().click()
  const card = page.locator('.lca-report-pane .local-edit-card').first()
  await card.waitFor({ timeout: 20000 })

  await card.locator('.annotation-edit-button').click()
  const form = page.locator('.lca-report-pane .annotation-edit-card .annotation-edit-form')
  await form.waitFor()
  await form.locator('textarea').first().fill('月工资为8000元，于每月15日前支付。')
  await form.locator('textarea').nth(1).fill('支付日期已与 HR 确认。')
  await form.getByRole('button', { name: '保存批注' }).click()
  await form.waitFor({ state: 'detached' })
  assert.ok((await card.innerText()).includes('月工资为8000元，于每月15日前支付。'))
  assert.equal(await card.locator('.annotation-edited-badge').count(), 1)
  await page.screenshot({ path: process.env.FAFEE_UI_SHOT_LABOR_SAVED || '/tmp/annotation-edit-labor-saved.png' })

  await page.locator('.lca-report-pane .document-header button', { hasText: '复制' }).click()
  const copied = await copiedText(page)
  assert.ok(copied.includes('【1】改为：月工资为8000元，于每月15日前支付。'))
  assert.ok(copied.includes('批注：支付日期已与 HR 确认。'))

  await page.locator('.lca-report-pane .document-header button', { hasText: '下载' }).click()
  const doc = await lastExportText(page)
  assert.ok(doc.includes('月工资为8000元，于每月15日前支付。'))
  assert.ok(doc.includes('支付日期已与 HR 确认。'))

  // 刷新后编辑仍在：任务结果来自服务端，编辑存在本浏览器的批注编辑表里。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.lca-open-report-card').first().click()
  const reloaded = page.locator('.lca-report-pane .local-edit-card').first()
  await reloaded.waitFor({ timeout: 20000 })
  assert.ok((await reloaded.innerText()).includes('月工资为8000元，于每月15日前支付。'))
  assert.equal(await reloaded.locator('.annotation-edited-badge').count(), 1)
  // 重新分析出的新报告用同一份原文、同样的位置序号批注 ID：上一版的人工意见不能串过来。
  await page.locator('.lca-open-report-card').nth(1).click()
  const freshCard = page.locator('.lca-report-pane .local-edit-card').first()
  await freshCard.waitFor({ timeout: 20000 })
  const freshText = await freshCard.innerText()
  assert.ok(freshText.includes('月工资为8000元，按公司薪酬制度发放。'))
  assert.ok(!freshText.includes('于每月15日前支付。'))
  assert.equal(await freshCard.locator('.annotation-edited-badge').count(), 0)
  assert.equal(await page.locator('.annotation-edit-status button').count(), 0)

  // 回到第一份报告：编辑仍在，全部恢复后回到模型意见。
  await page.locator('.lca-open-report-card').first().click()
  const restoredCard = page.locator('.lca-report-pane .local-edit-card').first()
  await restoredCard.waitFor({ timeout: 20000 })
  assert.ok((await restoredCard.innerText()).includes('月工资为8000元，于每月15日前支付。'))
  await page.locator('.annotation-edit-status button').click()
  assert.equal(await page.locator('.annotation-edited-badge').count(), 0)
  assert.ok((await restoredCard.innerText()).includes('月工资为8000元，于每月10日前支付。'))
  await page.screenshot({ path: process.env.FAFEE_UI_SHOT_LABOR || '/tmp/annotation-edit-labor.png' })
  assert.deepEqual(errors, [])
  await page.close()
  return ['劳动合同分析：就地编辑/复制/下载/刷新持久化/全部恢复']
}

const browser = await launch()
try {
  const commercial = await commercialReview(browser)
  const labor = await laborAnalysis(browser)
  console.log(`PASS browser annotation editing:\n - ${[...commercial, ...labor].join('\n - ')}`)
} finally {
  await browser.close()
}
