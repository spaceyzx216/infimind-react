// 劳动合同分析的浏览器回归：**流式与批注契约**。
//
// 为什么重写这个脚本：旧版引用了一批已不存在或已改名的选择器与文案
// （`折叠任务记录`、`关闭审查批注稿`、`.lca-streamed-review`、"回放"），
// 无法运行，等于流式契约没有回归保护；也没有注册进 package.json。
//
// 运行前提：前端 Vite 已在 5173（`npm run dev`）。全部 `/api/**` 被拦截并注入合成数据，
// 不触达真实后端、模型、数据库；不写任何业务文件。
//
// 覆盖的契约：
//   1. 结构分析逐块流式：每个分片的文字都必须出现在正文里（不丢字、不改顺序）
//   2. 运行中显示「重点风险与处理建议」，且不提前露出批注稿入口
//   3. 三轮审查面板统一列出每一轮的新增问题（含首轮）
//   4. 完成态正文为「逐条批注」，并包含第 2/3 轮补充发现
//   5. 正文包含「问题核对说明」（质量核对被合并的重复项去向）
//   6. 终态可打开批注稿并渲染增量批注
//   7. 刷新已完成任务：正文不重复追加
//   8. 失败且无可用结果时不出现误导性的"已完成"文案
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const BASE = process.env.LABOR_UI_BASE || 'http://localhost:5173'
const PRODUCT = 'labor-contract-analysis'
const MISLEADING = '覆盖核对仍无法完整结束'
const SOURCE = '劳动合同\n甲方：虚构测试公司\n月工资为8000元。\n'
  + Array.from({ length: 60 }, (_, index) => `第${index + 1}项约定：这是用于验证完整合同阅读位置的虚构内容。`).join('\n')

// 本机约定：优先系统 Chrome（与仓库其它 Playwright 脚本一致），没有则退回自带 Chromium。
const launch = async () => {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' })
  } catch {
    return await chromium.launch({ headless: true })
  }
}

// 结构分析拆成三个带唯一标记的分片：任何一个分片丢失都能被断言抓到
// （throttleWithTrailing 只保留最后一次参数的坑就是这样被子代理实测发现的）。
const structureChunks = [
  '# 合同基础识别\n- 合同类型：劳动合同\n- 合同子类型：固定期限\n- 类型判定依据：分片标记甲\n',
  '\n# 条款结构图\n- 工资条款｜月工资8000元｜文本状态：完整（分片标记乙）\n',
  '\n# 要素完整性核查\n- 主体与授权：已体现（分片标记丙）\n\n# 文本一致性与待确认事项\n- 格式与编号：编号连续\n'
]
const structureMarkdown = structureChunks.join('')

const reviewBody = [
  '# 审查结论',
  '合成审查结论：工资支付安排与加班费基数需要在签约前补全。',
  '',
  '# 重点风险与处理建议',
  '',
  '## 【高】工资支付日期缺失',
  '- 定位：L3',
  '- 位置：第三条',
  '- 原文：月工资为8000元。',
  '- 风险：未约定支付日期，存在拖欠争议风险。',
  '- 建议：补充支付日期。',
  '',
  '# 审查说明',
  '结果供合同完善参考；签署、重大金额、强监管或争议项目应结合具体事实由专业人士复核。'
].join('\n')
// 真实契约：首轮报告 = 结构分析 + 审查报告
const firstRoundWithStructure = [structureMarkdown, reviewBody].join('\n\n')
// 后端真实形态：持久化的 firstRoundReport 是**进行中变体**（重点风险与处理建议），
// 终稿是 result.reviewReport（逐条批注 + 完整性清单）。两者必须按状态分别进入正文。
const firstRoundPersisted = firstRoundWithStructure
const finalReport = [
  '# 审查结论',
  '合成审查结论：工资支付安排与加班费基数需要在签约前补全。',
  '',
  '# 逐条批注',
  '',
  '## 【高】工资支付日期缺失',
  '- 定位：L3',
  '- 风险：未约定支付日期，存在拖欠争议风险。',
  '',
  '# 完整性清单',
  '- 重复项已合并：重复的工资问题——与「工资支付日期缺失」属于同一缺陷（并入 工资支付日期缺失）',
  '',
  '# 审查说明',
  '结果供合同完善参考；签署、重大金额、强监管或争议项目应结合具体事实由专业人士复核。'
].join('\n')

const finding = (title, risk, level = '高') => ({ level, title, risk, location: 'L3', quote: '月工资为8000元。' })
const roundSnapshots = [
  { round: 1, newCount: 1, newFindings: [finding('工资支付日期缺失', '未约定支付日期，存在拖欠争议风险。')] },
  { round: 2, newCount: 1, newFindings: [finding('加班费计算基数未约定', '基数不明，加班费争议风险较高。', '中')] },
  { round: 3, newCount: 1, newFindings: [finding('社保缴纳主体未明确', '缴纳主体不明，存在补缴风险。', '中')] }
]

const revision = (id, text) => ({ findingId: id, level: '高', action: 'modify', title: `问题${id}`, lineStart: 3, lineEnd: 3,
  originalText: '月工资为8000元。', rewrittenText: text, riskNote: '合成修订', issueCount: 1,
  localizedEdits: [{ editId: `edit-${id}`, operation: 'replace', lineStart: 3, lineEnd: 3,
    targetQuote: '月工资为8000元。', replacementText: text, quoteSpans: [{ line: 3, start: 0, end: 10 }] }] })

const taskBase = { threadId: 'task-0', productId: PRODUCT, title: '劳动合同测试', action: 'analyze', mode: 'fast',
  analysisType: 'ordinary_labor_contract', reviewPerspective: 'using_unit', createdAt: new Date().toISOString(), files: [] }
const makeTask = (overrides) => ({ id: 'task-0', ...taskBase, ...overrides })

const openPage = async (page, { task, events = [] }) => {
  const threadTasks = [task]
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/auth/refresh') return send({ accessToken: 'synthetic-token', expiresAt: '2099-01-01' })
    if (url.pathname === '/api/auth/me') return send({ user: { id: 'browser-test', username: '合成测试', email: 'ui@example.test' } })
    if (url.pathname === '/api/tasks') return send({ tasks: threadTasks })
    if (url.pathname.endsWith('/events')) {
      const after = Number(url.searchParams.get('after')) || 0
      const body = events.slice(after).map(([event, data], index) => `event: ${event}\ndata: ${JSON.stringify({ ...data, _seq: after + index + 1 })}\n\n`).join('')
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
    }
    if (url.pathname.includes('/thread/')) return send({ tasks: threadTasks })
    if (url.pathname.includes('/source/')) return send({ documents: task.result?.sourceDocuments || [], expiresAt: null })
    if (url.pathname.startsWith('/api/tasks/')) return send({ task })
    return send({ tasks: threadTasks, threads: [], conversations: [], messages: [], balances: [] })
  })
  // 运行中的任务会保持 SSE 连接，networkidle 永远等不到：只等 DOM。
  await page.goto(`${BASE}/tools/labor-contract?taskId=${task.id}`, { waitUntil: 'domcontentloaded' })
}

const labels = []
const check = (label) => labels.push(label)

// 场景 1：只有结构分析在流式（任务仍在跑）。这里不推首轮报告，
// 因此正文里的分片标记只可能来自 analysis.delta —— 丢字会被直接抓到。
async function scenarioStreaming() {
  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const task = makeTask({ id: 'task-stream', status: 'running', result: null })
    const events = [
      ['stage.start', { stage: 'parsing', label: '正在读取合同原文…' }],
      ['stage.start', { stage: 'structure', label: '正在分析合同结构…' }],
      ...structureChunks.map((content) => ['analysis.delta', { content }])
    ]
    await openPage(page, { task, events })

    const body = page.locator('.lca-review-chat-output')
    await body.waitFor({ timeout: 20000 })
    await page.waitForFunction(() => (document.querySelector('.lca-review-chat-output')?.textContent || '').includes('分片标记丙'),
      null, { timeout: 20000 })
    const text = (await body.textContent()) || ''

    // 1：三个分片必须齐全且顺序正确（throttleWithTrailing 丢中间分片的回归）
    const positions = ['分片标记甲', '分片标记乙', '分片标记丙'].map((marker) => text.indexOf(marker))
    assert.ok(positions.every((index) => index >= 0), `结构分析分片不得丢字，实际正文：${text.slice(0, 200)}`)
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2], '分片顺序必须与推送顺序一致')
    assert.ok(text.includes('合同基础识别') && text.includes('条款结构图') && text.includes('要素完整性核查'), '结构分析各小节都要在正文里')
    check('结构分析逐块流式且不丢字')

    // 2（前半）：运行中不得提前露出批注稿入口
    assert.equal(await page.locator('.lca-open-report-card').count(), 0, '运行中不得露出批注稿入口')
    check('运行中不出现批注稿入口')

    // 3：运行中刷新（事件从 seq 0 回放）不得重复追加已流出的正文
    await page.reload({ waitUntil: 'domcontentloaded' })
    const chat = page.locator('.lca-review-chat-output')
    await chat.waitFor({ timeout: 20000 })
    await page.waitForFunction(() => (document.querySelector('.lca-review-chat-output')?.textContent || '').includes('分片标记丙'),
      null, { timeout: 20000 })
    const replayed = (await chat.textContent()) || ''
    for (const marker of ['分片标记甲', '分片标记乙', '分片标记丙']) {
      assert.equal(replayed.split(marker).length - 1, 1, `回放后「${marker}」只能出现一次（不得重复追加）`)
    }
    check('运行中刷新回放不重复追加')

    assert.deepEqual(errors, [], `运行中页面报错：${JSON.stringify(errors)}`)
  } finally {
    await page.close()
    await browser.close()
  }
}

// 场景 2：进入首轮审查（任务仍在跑）。验证运行中的标题文案与三轮面板。
async function scenarioReviewing() {
  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const task = makeTask({ id: 'task-review', status: 'running', result: null })
    const events = [
      ['stage.start', { stage: 'structure', label: '正在分析合同结构…' }],
      ['analysis.delta', { content: structureChunks.join('') }],
      ['review.round', { round: 1, total: 3, phase: 'start', message: '正在进行第 1 轮审查（共 3 轮）' }],
      ['review.delta', { content: firstRoundWithStructure, firstRoundReport: firstRoundWithStructure, round: 1, replace: true }],
      ['review.round', { round: 1, total: 3, phase: 'end', newCount: 1, newFindings: roundSnapshots[0].newFindings, message: '第 1 轮审查完成，新增 1 条问题' }]
    ]
    await openPage(page, { task, events })

    const body = page.locator('.lca-review-chat-output')
    await body.waitFor({ timeout: 20000 })
    await page.waitForFunction(() => (document.querySelector('.lca-review-chat-output')?.textContent || '').includes('重点风险与处理建议'),
      null, { timeout: 20000 })
    const text = (await body.textContent()) || ''
    assert.ok(text.includes('重点风险与处理建议'), '运行中应显示「重点风险与处理建议」')
    assert.ok(!text.includes('逐条批注'), '运行中不应显示完成态标题')
    check('运行中显示「重点风险与处理建议」')

    const panel = page.locator('.review-rounds-panel')
    const panelText = await panel.textContent()
    assert.ok(panelText.includes('三轮审查进度'), '必须显示三轮审查进度面板')
    assert.ok((await panel.locator('.round-findings').count()) > 0, '首轮新增问题必须列在面板里')
    assert.ok(panelText.includes('工资支付日期缺失'), '首轮新增问题标题必须可见')
    check('三轮面板列出首轮新增问题')

    assert.deepEqual(errors, [], `审查中页面报错：${JSON.stringify(errors)}`)
  } finally {
    await page.close()
    await browser.close()
  }
}

async function scenarioCompleted() {
  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const task = makeTask({ id: 'task-done', status: 'succeeded', result: {
      productId: PRODUCT, schemaVersion: 3, analysisStatus: 'completed', reviewComplete: true,
      analysisType: 'ordinary_labor_contract', sourceTaskId: 'task-0', score: { value: 80 },
      analysisOverview: structureMarkdown, reviewReport: finalReport, firstRoundReport: firstRoundPersisted,
      qualityNotes: ['重复项已合并：重复的工资问题——与「工资支付日期缺失」属于同一缺陷（并入 工资支付日期缺失）'],
      warnings: [], reviewRounds: roundSnapshots,
      sourceDocuments: [{ fileId: 'file-0', fileName: '虚构合同.txt', text: SOURCE }],
      revisions: [revision('g1', '月工资为9000元，于次月十日前支付。')]
    } })
    await openPage(page, { task, events: [] })

    const body = page.locator('.lca-review-chat-output')
    await body.waitFor({ timeout: 20000 })
    const text = (await body.textContent()) || ''

    // 4 + 5
    // 终态必须切到终稿形态：后端持久化的 firstRoundReport 只是进行中变体。
    assert.ok(text.includes('逐条批注'), '完成态正文应为「逐条批注」（不得停留在「重点风险与处理建议」）')
    assert.ok(!text.includes('重点风险与处理建议'), '完成态不应继续显示进行中标题')
    assert.ok(text.includes('完整性清单') && text.includes('重复项已合并'), '完整性清单必须说明被合并的重复项去向')
    assert.ok(text.includes('第 2 轮补充发现') && text.includes('加班费计算基数未约定'), '正文必须包含第 2 轮补充发现')
    assert.ok(text.includes('第 3 轮补充发现') && text.includes('社保缴纳主体未明确'), '正文必须包含第 3 轮补充发现')
    check('完成态正文切到终稿形态并含补充发现与完整性清单')

    // 3（完成态）：三轮都列出
    const panel = page.locator('.review-rounds-panel')
    assert.equal(await panel.locator('.round-item.round-done').count(), 3, '三轮都应显示为已完成')
    const panelText = await panel.textContent()
    for (const title of ['工资支付日期缺失', '加班费计算基数未约定', '社保缴纳主体未明确']) {
      assert.ok(panelText.includes(title), `面板必须列出「${title}」`)
    }
    check('三轮面板统一列出每一轮的新增问题')

    // 6：终态可打开批注稿
    const card = page.locator('.lca-open-report-card').first()
    await card.waitFor({ timeout: 20000 })
    await card.click()
    await page.locator('.lca-report-pane').waitFor({ timeout: 20000 })
    await page.waitForFunction(() => document.body.textContent.includes('月工资为9000元，于次月十日前支付。'), null, { timeout: 20000 })
    check('终态可打开批注稿并渲染增量批注')

    // 7：刷新不重复追加
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.lca-review-chat-output').waitFor({ timeout: 20000 })
    // 刷新后要等正文重建完成再比对，否则读到的是恢复中的中间态。
    await page.waitForFunction(() => (document.querySelector('.lca-review-chat-output')?.textContent || '').includes('逐条批注'),
      null, { timeout: 20000 })
    const after = (await page.locator('.lca-review-chat-output').textContent()) || ''
    const count = (haystack, needle) => haystack.split(needle).length - 1
    // 注意：Markdown 标题已渲染成 <h1>，textContent 里没有字面的 "# "。
    assert.equal(count(after, '逐条批注'), 1, '逐条批注标题只能出现一次')
    assert.equal(count(after, '第 2 轮补充发现'), 1, '第 2 轮补充发现只能出现一次')
    assert.equal(count(after, '合同基础识别'), 1, '结构分析只能出现一次（不得重复追加）')
    assert.equal(after.length, text.length, '刷新后正文长度必须与刷新前一致')
    assert.ok(!after.includes(MISLEADING), '不得出现误导性的未完成文案')
    check('刷新恢复不重复追加正文')

    assert.deepEqual(errors, [], `完成态页面报错：${JSON.stringify(errors)}`)
  } finally {
    await page.close()
    await browser.close()
  }
}

async function scenarioFailed() {
  const browser = await launch()
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const task = makeTask({ id: 'task-failed', status: 'failed', errorSummary: '模型连接中断', result: null })
    await openPage(page, { task, events: [] })
    // 失败且无可用结果：对话区给"未完成 + 原因 + 重新分析"，不谎称已完成。
    await page.waitForFunction(() => document.body.textContent.includes('本次回复未完成'), null, { timeout: 20000 })
    const text = await page.locator('body').textContent()
    assert.ok(text.includes('模型连接中断'), '必须显示失败原因')
    assert.ok(text.includes('重新分析'), '必须提供重新分析入口')
    assert.ok(!text.includes(MISLEADING), '失败任务不得声称已完成')
    assert.equal(await page.locator('.lca-open-report-card').count(), 0, '失败且无可用结果时不得出现批注稿入口')
    check('失败任务显示未完成且无误导文案')
    assert.deepEqual(errors, [], `失败态页面报错：${JSON.stringify(errors)}`)
  } finally {
    await page.close()
    await browser.close()
  }
}

try {
  await scenarioStreaming()
  await scenarioReviewing()
  await scenarioCompleted()
  await scenarioFailed()
  console.log(`PASS labor-contract-ui: ${labels.length} 项流式/批注契约回归通过（合成数据，全 API 拦截）`)
  for (const label of labels) console.log(`  ✓ ${label}`)
} catch (error) {
  console.error(`FAIL labor-contract-ui: ${error.message}`)
  process.exitCode = 1
}
