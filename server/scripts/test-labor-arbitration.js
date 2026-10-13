import assert from 'node:assert/strict'
import express from 'express'
import { estimateTokens, selectHistoryByTokens } from '../../src/utils/context-budget.js'
import { formatArbitrationResult, formatArbitrationDraft, remarkArbitrationText } from '../../src/utils/arbitration-result.js'

// 所有材料虚构，模型调用由 fetch 桩拦截；不请求外部模型、不写项目数据库。
process.env.DEEPSEEK_API_KEY = 'arbitration-test-only'
const nativeFetch = globalThis.fetch
let modelResult = {
  conversationTitle: '解除补偿与加班费争议', answer: '依据企业提供的意见作初步分析。',
  overallRisk: 'medium', riskBasis: ['解除依据及工资记录待核对。'],
  caseInfo: [{ label: '企业', value: '示例甲公司', source: '用户陈述', status: 'claimed' }],
  claims: [{ claim: '加班费请求', companyPosition: '补充考勤后判断', defenseAdvice: '核对实际加班与工资记录。',
    riskLevel: 'high', reasoning: '无审批不等于未加班。', legalBasis: [{ name: '虚构法规不得采信', article: '第九条' }] }],
  disputes: [{ topic: '实际加班情况', unknowns: ['考勤与审批记录'] }],
  defenseDraft: '### 劳动人事争议仲裁答辩意见书\n\n答辩人：【待补充】\n\n答辩请求：请结合核实后的事实处理加班费请求。\n\n#### 关于加班费请求\n\n**答辩结论**：待核对考勤后明确。\n\n**答辩建议**：补充考勤。\n\n**法条依据**：待核对。\n\n**具体分析**：材料不足，不能确认。\n\n此致【待补充】劳动人事争议仲裁委员会',
  followUpQuestions: ['请补充考勤记录。']
}
let finishReason = 'stop'
let captured = null
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).endsWith('/chat/completions'), '模型测试只允许被拦截的 chat 请求')
  captured = JSON.parse(options.body)
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(modelResult) } }],
    usage: { prompt_tokens: 4200, completion_tokens: 1700, total_tokens: 5900 } }), { status: 200 })
}

let listener
try {
  const { initialize } = await import('../services/law-whitelist.js')
  initialize(':memory:')
  const { runLaborArbitration, getArbitrationDateChecks, validateArbitrationDateAssertions } = await import('../workflows/labor-arbitration.js')
  const { createTaskRouter } = await import('../routes/tasks.js')
  const { createTaskProcessor } = await import('../services/task-processor.js')
  const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `第${index}条虚构对话` }))
  assert.equal(selectHistoryByTokens(history, 10000).history.length, 20, '短对话不得按8条或12条截断')
  const longTurns = [{ role: 'user', content: '旧'.repeat(150) }, { role: 'assistant', content: '旧答复' },
    { role: 'user', content: '最新问题' }, { role: 'assistant', content: '最新答复' }]
  const kept = selectHistoryByTokens(longTurns, 60)
  assert.deepEqual(kept.history, longTurns.slice(2), '按预算保留完整的最近轮次')
  assert.equal(kept.droppedMessages, 2)
  assert.equal(selectHistoryByTokens(longTurns, 0).history.length, 0)
  assert.equal(selectHistoryByTokens([{ role: 'system', content: '不得注入' }], 1000).history.length, 0)
  assert.equal(estimateTokens('abcd中文'), 3)
  const dateChecks = getArbitrationDateChecks('2025年12月10日通知，2025年12月31日终止。2025年2月30日为无效日期。')
  assert.equal(dateChecks.length, 1)
  assert.equal(dateChecks[0].days, 21)
  assert.throws(() => validateArbitrationDateAssertions({ answer: '2025年12月10日通知，距12月31日终止超过30日。' }, dateChecks), (error) => error.code === 'arbitration_result_inconsistent')
  assert.doesNotThrow(() => validateArbitrationDateAssertions({ answer: '2025年12月10日至2025年12月31日未超过30日。' }, dateChecks))
  assert.doesNotThrow(() => validateArbitrationDateAssertions({ answer: '2025年12月10日提供材料；2023年1月1日至2025年12月31日超过30日。' }, dateChecks))

  const result = await runLaborArbitration({ input: { action: 'analyze', mode: 'fast', message: '示例甲公司收到加班费请求，仅有企业陈述。', history } })
  assert.equal(result.conversationTitle, '解除补偿与加班费争议')
  assert.equal(result.claims[0].legalBasis[0].status, 'needs_review')
  assert.equal(result.overallRisk, 'medium')
  assert.ok(result.defenseDraft.includes('【待补充】'), '首轮应保留完整草稿及缺失字段')
  assert.equal(result.contextUsage.promptTokens, 4200)
  assert.equal(result.usage.total_tokens, 5900)
  assert.equal(captured.model, 'deepseek-flash')
  assert.equal(captured.thinking.type, 'disabled')
  assert.equal(captured.max_tokens, 393216, '快速模式使用模型允许的最高输出预算')
  assert.ok(captured.messages[1].content.includes('第0条虚构对话'))
  const markdown = formatArbitrationResult(result)
  const headings = ['案件风险判断', '基本信息梳理', '请求事项分析', '核心争议点总结', '劳动仲裁答辩意见（草稿）']
  for (let index = 1; index < headings.length; index += 1) assert.ok(markdown.indexOf(headings[index - 1]) < markdown.indexOf(headings[index]))
  assert.ok(markdown.includes('**答辩建议**'))
  assert.ok(markdown.indexOf('**法条依据**') < markdown.indexOf('**具体分析**'), '标签顺序对齐小程序')
  assert.ok(markdown.includes('（当事方陈述，待核实）'))
  assert.ok(!markdown.includes('|') && !markdown.includes('21.8%'))
  const draftSections = '答辩人：【待补充】\n\n#### 关于加班费\n\n正文\n\n#### 关于年休假\n\n正文'
  const normalizedDraft = formatArbitrationDraft(draftSections)
  assert.equal((normalizedDraft.match(/^---$/gm) || []).length, 2)
  assert.equal(formatArbitrationDraft(normalizedDraft), normalizedDraft, '分隔线处理应幂等')
  assert.doesNotThrow(() => formatArbitrationResult({ caseInfo: [null], claims: [null], references: [null] }))
  const cell = (value) => ({ type: 'tableCell', children: [{ type: 'text', value }] })
  const tree = { type: 'root', children: [{ type: 'table', children: [
    { type: 'tableRow', children: [cell('请求'), cell('建议')] },
    { type: 'tableRow', children: [cell('加班费'), cell('核对考勤')] }
  ] }] }
  remarkArbitrationText()(tree)
  assert.equal(tree.children[0].type, 'paragraph')
  assert.ok(JSON.stringify(tree).includes('核对考勤'), '表格转文字不得丢失内容')

  modelResult = { ...modelResult, conversationTitle: '公司违法需要承担赔偿', defenseDraft: '' }
  const reply = await runLaborArbitration({ input: { action: 'followup', mode: 'thinking', message: '补充考勤情况。', history } })
  assert.equal(reply.conversationTitle, '', '拒绝把模型法律定性当作标题')
  assert.equal(captured.thinking.type, 'enabled')
  assert.equal(captured.max_tokens, 393216, '深度模式使用相同最高预算，保留原思考强度')
  await assert.rejects(runLaborArbitration({ input: { action: 'draft', message: '生成草稿' } }), (error) => error.code === 'arbitration_draft_missing')
  finishReason = 'length'
  await assert.rejects(runLaborArbitration({ input: { action: 'analyze', message: '初步分析' } }), (error) => error.code === 'arbitration_output_truncated')
  await assert.rejects(runLaborArbitration({ isCancellationRequested: () => true }), (error) => error.code === 'TASK_CANCELLED')
  finishReason = 'stop'
  const savedModelResult = modelResult
  modelResult = {}
  await assert.rejects(runLaborArbitration({ input: { message: '虚构案件' } }), (error) => error.code === 'arbitration_result_invalid')
  modelResult = { ...savedModelResult, overallRisk: 'low', riskBasis: [], caseInfo: [null], claims: [null], defenseDraft: '' }
  const unsupportedRisk = await runLaborArbitration({ input: { message: '材料不足' } })
  assert.equal(unsupportedRisk.overallRisk, 'unknown', '没有依据的风险档位不得展示')
  modelResult = savedModelResult
  const caches = new Map()
  const originalText = '虚构公司于2026年1月终止合同，争议工资记录编号CASE-PRIMARY-471。'
  await runLaborArbitration({ task: { id: 'source-task' }, input: { message: '分析仲裁请求' },
    files: [{ id: 'file-one', originalname: '虚构申请书.txt', mimetype: 'text/plain', buffer: Buffer.from(originalText) }],
    checkpoint: (stage, value) => caches.set(stage, { result: value }) })
  assert.equal(caches.get('parsing').result.documents[0].text, originalText)
  await assert.rejects(runLaborArbitration({ input: { message: '不应依据空文件作结论' }, files: [{ id: 'empty-file', originalname: '空文件.txt', mimetype: 'text/plain', buffer: Buffer.from('') }] }), (error) => error.code === 'arbitration_documents_unreadable')
  await runLaborArbitration({ input: { action: 'followup', message: '重新核对金额' }, sourceDocuments: caches.get('parsing').result.documents,
    checkpoint: () => { throw new Error('追问不得复制历史原文到新缓存') } })
  assert.ok(captured.messages[1].content.includes('CASE-PRIMARY-471'), '追问必须带入已上传的本案原文')
  let cancelled = false
  await assert.rejects(runLaborArbitration({ input: { message: '取消解析' }, files: [{ id: 'new-file', originalname: 'new.txt', mimetype: 'text/plain', buffer: Buffer.from('虚构新材料') }],
    checkpoint: () => { cancelled = true }, isCancellationRequested: () => cancelled }), (error) => error.code === 'TASK_CANCELLED')

  // Worker 使用任务平台已有的用户归属、文件期限、解析检查点；不读真实数据库。
  let workerResult
  let persistedTitle
  const task = { id: 'followup-task', userId: 'owner', productId: 'labor-arbitration', threadId: 'case-one', createdAt: new Date().toISOString(), status: 'queued' }
  let prior = { ...task, id: 'source-task', status: 'cancelled' }
  const originalFiles = [{ id: 'file-one', cleanupAt: new Date(Date.now() + 60000).toISOString() }]
  const workerService = {
    getTaskInternal: () => task, isTerminal: (status) => ['succeeded', 'failed', 'cancelled'].includes(status),
    claimTask: () => ({ ...task, status: 'running' }), isCancellationRequested: () => false,
    appendEvent: () => {}, saveCheckpoint: () => {},
    getFiles: (id) => id === 'source-task' ? originalFiles : [],
    getTaskInput: (id) => id === 'source-task' ? { fileRefs: [{ id: 'file-one' }] } : { action: 'followup', message: '继续分析' },
    listThreadTasks: (userId, productId, threadId) => { assert.equal(userId, 'owner'); assert.equal(productId, task.productId); assert.equal(threadId, task.threadId); return [prior] },
    getCheckpoint: () => caches.get('parsing'),
    completeTask: (_, result) => { workerResult = result; return { status: 'succeeded' } },
    failTask: (_, error) => ({ status: 'failed', errorCode: error.code, error: error.message }),
    updateThreadTitle: (_, __, ___, title) => { persistedTitle = title }
  }
  const worker = createTaskProcessor({ taskService: workerService, fileStore: { readFiles: async (files) => { assert.equal(files.length, 0, '有缓存时不重复读原文件'); return [] } },
    laborArbitrationWorkflow: async ({ sourceDocuments }) => { assert.ok(sourceDocuments[0].text.includes('CASE-PRIMARY-471')); return { conversationTitle: '工资争议答辩准备' } } })
  assert.equal((await worker.processTask(task.id)).status, 'succeeded')
  assert.equal(workerResult.conversationTitle, persistedTitle)
  prior = { ...prior, userId: 'intruder' }
  assert.match((await worker.processTask(task.id)).error, /无权访问/)
  prior = { ...prior, userId: 'owner' }
  originalFiles[0].cleanupAt = new Date(Date.now() - 1000).toISOString()
  assert.equal((await worker.processTask(task.id)).status, 'succeeded', '原件到期后仍可使用已保存正文')
  const savedParsing = caches.get('parsing')
  caches.delete('parsing')
  assert.equal((await worker.processTask(task.id)).errorCode, 'arbitration_source_unavailable')
  caches.set('parsing', savedParsing)
  prior = { ...prior, status: 'failed', errorCode: 'queue_unavailable' }
  const recoveryWorker = createTaskProcessor({ taskService: workerService, fileStore: { readFiles: async (files) => { assert.equal(files.length, 0, '队列失败已回滚的历史文件不再读取'); return [] } },
    laborArbitrationWorkflow: async () => ({ conversationTitle: '重新提交的虚构案件' }) })
  assert.equal((await recoveryWorker.processTask(task.id)).status, 'succeeded')
  prior = { ...prior, status: 'succeeded', errorCode: '', result: { conversationTitle: '首轮案件主题' } }
  originalFiles[0].cleanupAt = new Date(Date.now() + 60000).toISOString()
  await worker.processTask(task.id)
  assert.equal(persistedTitle, '首轮案件主题', '服务端与页面均沿用首轮模型主题')

  // 路由使用内存服务桩，验证长历史、权限归属及失败入口，不触碰已有任务。
  const created = []
  let priorRouteTasks = []
  const taskService = {
    getActiveTaskByThread: () => null, listThreadTasks: () => priorRouteTasks,
    getTaskInput: () => ({ fileRefs: [{ id: 'expired-file' }] }),
    createTask: (input) => { created.push(input); return { ...input, status: 'queued' } }
  }
  const app = express()
  app.use((req, res, next) => { req.user = { id: 'synthetic-user' }; next() })
  app.use('/api', createTaskRouter({ taskService, taskQueue: { enqueue: async () => {} }, fileStore: {}, fakeLlm: true }))
  listener = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  const endpoint = `http://127.0.0.1:${listener.address().port}/api/tasks/labor-arbitration`
  const form = (overrides = {}) => {
    const body = new FormData()
    const fields = { threadId: 'synthetic-thread', action: 'analyze', message: '虚构案件', history: JSON.stringify(history), ...overrides }
    for (const [name, value] of Object.entries(fields)) body.append(name, value)
    return body
  }
  const response = await nativeFetch(endpoint, { method: 'POST', body: form() })
  assert.equal(response.status, 202)
  assert.equal(created[0].input.history.length, 0, 'v2不采信客户端提交的历史作为案件事实')
  assert.equal(created[0].workflowVersion, 'labor-arbitration-v2')
  assert.equal(created[0].input.schemaVersion, 2)
  assert.equal(created[0].userId, 'synthetic-user')
  assert.equal(created[0].productId, 'labor-arbitration')
  const largeHistory = [{ role: 'user', content: '长'.repeat(400000) }, { role: 'assistant', content: '短答复' }]
  assert.equal((await nativeFetch(endpoint, { method: 'POST', body: form({ history: JSON.stringify(largeHistory) }) })).status, 202, '超过1MB的历史字段仍应接受')
  assert.equal((await nativeFetch(endpoint, { method: 'POST', body: form({ history: '{}' }) })).status, 400)
  assert.equal((await nativeFetch(endpoint, { method: 'POST', body: form({ history: 'broken-json' }) })).status, 400)
  assert.equal((await nativeFetch(endpoint, { method: 'POST', body: form({ threadId: '' }) })).status, 400)
  priorRouteTasks = [{ id: 'rolled-back', status: 'failed', errorCode: 'queue_unavailable', createdAt: '2020-01-01', files: [] }]
  assert.equal((await nativeFetch(endpoint, { method: 'POST', body: form() })).status, 202, '创建时回滚的上传不得阻塞重试')
  priorRouteTasks[0].errorCode = 'task_failed'
  assert.equal((await nativeFetch(endpoint, { method: 'POST', body: form() })).status, 202, '原件到期允许正文复用或重传')
  priorRouteTasks[0].resultExpiresAt = '2020-01-01'
  assert.equal((await nativeFetch(endpoint, { method: 'POST', body: form() })).status, 410, '案件到期禁止继续分析')
  console.log('PASS arbitration: token预算、文本/草稿格式、日期矛盾拦截、风险依据、旧材料与检查点、标题、权限、到期、取消、队列回滚重试与任务入口（无外部模型调用）')
} finally {
  globalThis.fetch = nativeFetch
  if (listener) await new Promise((resolve) => listener.close(resolve))
}
