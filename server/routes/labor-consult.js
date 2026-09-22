/**
 * 用工咨询接口。
 *
 * POST /api/labor-consult          SSE 流式咨询
 * POST /api/labor-consult/verify   JSON，仅做引用校验（供前端复核与回归测试）
 * POST /api/labor-consult/forget   JSON，清理会话留存的上传材料
 * POST /api/labor-consult/title    JSON，依据首轮提问提炼会话标题
 * GET  /api/labor/status           JSON，法规白名单与案例库状态
 * GET  /api/labor/laws             JSON，法规时效基准表
 *
 * 与合同审查/起草的区别：本接口不做文件上传与多 Agent 管线，而是
 * 「本地知识库检索 + 法规白名单注入 + 案例检索 → 单次流式回答 → 服务端引用校验」。
 */
import { Router } from 'express'
import multer from 'multer'
import { initialize as initKnowledgeBase, searchEvidence, getEvidenceRetrievalHealth } from '../services/knowledge-base.js'
import { extractText } from '../services/file-parser.js'
import { isAcceptableFile, MAX_FILE_SIZE, MAX_FILES } from '../services/upload-config.js'
import {
  initialize as initLabor,
  listLawsForBaseline,
  searchCases,
  getLaborStatus,
  seedLawWhitelist
} from '../services/law-whitelist.js'
import { verifyOutput, renderCitationNotice } from '../services/citation-verifier.js'
import { mergeMaterials, getMaterials, clearMaterials, MAX_TOTAL_TEXT } from '../services/consult-material-store.js'
import { rewriteFollowUpQuery } from '../services/query-rewriter.js'
import { refineConversationTitle, isTitleRefineEnabled, toClientResult } from '../services/title-refiner.js'
import { initializeLaborKb, searchLaborKb, getLaborKbStatus, getLaborSearchHealth } from '../services/labor-kb.js'
import { initializeLaborVector } from '../services/labor-vector.js'
import { buildLaborConsultSystemPrompt, buildLaborConsultUserMessage } from '../prompts/labor-consult.js'
import { streamChat, getFlashModel } from '../services/llm-client.js'
import { extractKeywords } from '../services/cjk-tokenizer.js'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  // 浏览器 FormData 以 UTF-8 写入中文 filename；Busboy 默认 Latin-1 会造成文件名乱码。
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_FILE_SIZE }
})

const MAX_MESSAGE_LENGTH = 8000
const MAX_HISTORY = 12
const EVIDENCE_LIMIT = 10
const CASE_LIMIT = 5
/** 实务问答条目数：这是答复质量的主要来源，配额给得比其它两路高 */
const KB_LIMIT = 6
/** 附件正文合并上限见 consult-material-store.MAX_TOTAL_TEXT（单一定义，避免两处漂移） */
/**
 * 输出 token 上限（两档统一给到 API 允许的最大值）。
 *
 * ⚠️ 思考（reasoning）与正文**共用**这个上限，而档位越高思考越长：
 * 实测 ~25K 字符输入 + `max` 档，思考可达 1.3~2.0 万字，8K 上限会让模型在思考阶段
 * 就被 `finish=length` 截断、正文 0 字（连续三次全失败）。`high` 档同样存在该风险，只是概率低。
 *
 * 为什么直接给最大值是安全的：max_tokens 是**上限而非目标**，只按实际生成量计费。
 * 给足不增加成本，却彻底消除"思考挤掉正文"这一类失败。
 * API 明确回包：valid range of max_tokens is [1, 393216]。
 */
const MAX_OUTPUT_TOKENS = Number(process.env.LABOR_MAX_TOKENS || 393216)

const LABOR_TOPICS = [
  ['劳动关系认定与主体', ['劳动关系', '用人单位', '事实劳动关系', '劳务派遣', '外包', '主体资格']],
  ['劳动合同订立与二倍工资', ['书面劳动合同', '二倍工资', '订立', '续签', '无固定期限']],
  ['试用期与录用条件', ['试用期', '录用条件', '不符合录用条件', '转正']],
  ['劳动报酬与加班费', ['工资', '加班费', '加班', '绩效', '提成', '拖欠工资', '最低工资']],
  ['工时与休息休假', ['工时', '休息休假', '年休假', '带薪年休假', '调休', '综合计算工时']],
  ['社会保险与公积金', ['社会保险', '社保', '公积金', '未缴社保', '补缴']],
  ['工伤与职业病', ['工伤', '工伤认定', '职业病', '工伤待遇', '工亡']],
  ['女职工与特殊保护', ['女职工', '三期', '产假', '哺乳期', '未成年工']],
  ['规章制度与员工手册', ['规章制度', '员工手册', '民主程序', '公示', '违纪']],
  ['竞业限制与保密', ['竞业限制', '保密', '商业秘密', '违约金', '竞业禁止']],
  ['解除终止与经济补偿', ['解除', '终止', '经济补偿', '赔偿金', '违法解除', 'N+1', '裁员']],
  ['仲裁时效与程序', ['仲裁', '时效', '仲裁时效', '管辖', '举证', '一裁终局']]
]

/** 依据用户提问构造劳动专项检索计划；命中主题优先，未命中则回退到通用主题。 */
function buildLaborReviewPlan(message) {
  const text = String(message || '')
  const matched = LABOR_TOPICS.filter(([, terms]) => terms.some((term) => text.includes(term)))
  const selected = (matched.length ? matched : LABOR_TOPICS.slice(0, 6)).slice(0, 5)
  const keywords = extractKeywords(text, { limit: 10 })
  return {
    contractType: '劳动合同',
    userFocus: text.trim(),
    topics: selected.map(([label, terms], index) => ({
      id: `labor-topic-${index + 1}`,
      label,
      terms,
      query: [...terms, ...keywords].join(' OR '),
      priority: matched.length ? 'high' : 'normal'
    }))
  }
}

/**
 * 降级原因 → 用户可读标签。
 * 直接把 `qdrant_unreachable` 这类内部标记推到前端对用户没有意义，
 * 但它必须可见——项目已因"静默降级"吃过两次亏。
 */
const DEGRADE_REASON_LABELS = {
  qdrant_unreachable: '向量库未部署或不可达',
  not_configured: '未配置检索服务',
  rate_limit: '上游限流',
  network: '网络异常或超时',
  auth: '密钥无效',
  server: '上游服务异常',
  mode_unsupported: '重排模式不支持',
  index_empty: '向量索引为空',
  index_corrupt: '向量索引数据损坏，需强制重建',
  model_mismatch: '索引模型与当前配置不一致，需重建',
  dim_mismatch: '向量维度与索引不一致',
  disabled: '能力已关闭',
  unknown: '原因未知'
}
const describeDegrade = (reason) => DEGRADE_REASON_LABELS[reason] || reason || '原因未知'

/**
 * 合并多路 searchEvidence 的降级元信息：任一路降级即整体降级，
 * 并保留各自原因，让用户知道具体是哪一路不可用。
 */
function mergeEvidenceRetrieval(results) {
  const settled = results
    .filter((item) => item.status === 'fulfilled' && item.value?.retrieval)
    .map((item) => item.value.retrieval)
  if (!settled.length) return null
  const reasonsOf = (path) => [...new Set(
    settled.filter((item) => item[path]?.degraded).map((item) => item[path].reason || 'unknown')
  )]
  const vectorReasons = reasonsOf('vector')
  const rerankReasons = reasonsOf('rerank')
  return {
    vector: { used: settled.some((item) => item.vector?.used), degraded: vectorReasons.length > 0, reason: vectorReasons.join('、') },
    rerank: { used: settled.some((item) => item.rerank?.used), degraded: rerankReasons.length > 0, reason: rerankReasons.join('、') }
  }
}

/**
 * 本地知识库检索：分别按"劳动合同"类型与跨类型各查一次。
 * 前者保证条款口径贴合劳动场景；后者补足风险规则（劳动类风险规则可能挂在其他素材上）。
 *
 * 两路只读同一个 SQLite 连接、候选集各自为局部变量，彼此不依赖——曾经串行执行导致耗时相加
 * （实测 986ms），改为并行后取决于较慢的一路（实测 569ms）。
 *
 * @returns {Promise<Array & { retrieval: object|null }>} 降级信息挂在 `retrieval` 上供调用方写入 warnings
 */
async function retrieveLaborEvidence(plan, limit = EVIDENCE_LIMIT) {
  const merged = new Map()
  const collect = (items) => {
    for (const item of items || []) {
      if (!merged.has(item.evidenceId)) merged.set(item.evidenceId, item)
    }
  }
  const [laborResult, crossResult] = await Promise.allSettled([
    searchEvidence(plan, { limit: Math.ceil(limit * 0.7) }),
    searchEvidence({ ...plan, contractType: '' }, { limit: Math.ceil(limit * 0.5) })
  ])
  // 单路失败不影响另一路（保持原有的"降级不中断"语义）
  if (laborResult.status === 'fulfilled') collect(laborResult.value)
  else console.warn('[labor-consult] 劳动合同类型检索失败:', laborResult.reason?.message)
  if (crossResult.status === 'fulfilled') collect(crossResult.value)
  else console.warn('[labor-consult] 跨类型检索失败:', crossResult.reason?.message)

  const items = [...merged.values()].slice(0, limit)
  items.retrieval = mergeEvidenceRetrieval([laborResult, crossResult])
  return items
}

const sseHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no'
}

const parseHistory = (raw) => {
  let history = raw
  if (typeof raw === 'string') {
    try { history = JSON.parse(raw || '[]') } catch { history = [] }
  }
  if (!Array.isArray(history)) return []
  return history
    .filter((item) => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    .slice(-MAX_HISTORY)
}

/**
 * 追问检索词放宽阈值：本轮提问短于此长度即视为"未独立表达主题"。
 *
 * 依据：实测「那这种情况怎么办」会被分词器抽成 `况怎么办` 这类碎片词，
 * 召回的是工作交接、恢复劳动关系等**与上文毫无关系**的条目——本功能赖以为生的
 * "证据驱动"在多轮下直接失效。
 */
const FOLLOWUP_QUERY_MAX_CHARS = Number(process.env.LABOR_FOLLOWUP_QUERY_MAX_CHARS || 20)

/**
 * 是否启用 LLM 检索词改写。
 * 关闭后只走启发式（短追问并入上一轮提问），可省下每轮约 2 秒；
 * 代价是"长句纯指代"的追问检索会跑偏（启发式的已知失效边界）。
 */
const QUERY_REWRITE_ENABLED = process.env.LABOR_QUERY_REWRITE !== 'off'

/**
 * 启发式检索词（改写失败时的回退路径，也是无上文时的唯一路径）。
 *
 * 追问常常不含主题词（"那这个怎么处理"），单独检索必然跑偏。因此当本轮提问过短、
 * 不足以独立表达主题时，把**上一条用户提问**并入检索词——它是用户自己对主题的表述，
 * 比助手的长回答更适合当检索上下文。
 *
 * 为什么只在"短提问"时并入：自足的长提问本身已含完整主题词，混入历史主题会稀释精度
 * （项目在"同义词等权会稀释字面匹配"上已经吃过一次亏）。
 *
 * 注意：这一启发式有明确失效边界——**长句纯指代**的追问（如"那按照您刚才说的这个思路
 * 我们接下来具体应该怎么操作呢"）不会被识别。真正的兜底是 query-rewriter 的 LLM 改写，
 * 本函数只在改写不可用时生效。
 */
function buildHeuristicQuery({ message, materials = [], history = [] }) {
  // 仅有附件、没有提问时，退化为"附件名 + 正文片段"
  if (!message) return materials.map((item) => `${item.name} ${item.text.slice(0, 500)}`).join(' ')
  if (message.length >= FOLLOWUP_QUERY_MAX_CHARS) return message
  const previousUser = [...history].reverse().find((item) => item.role === 'user' && item.content)
  return previousUser ? `${previousUser.content}\n${message}` : message
}

/**
 * 构造检索词：优先用 LLM 改写（补全指代），失败则回退到启发式。
 *
 * 只在**存在上文**时改写：首轮没有可解析的指代，改写纯属浪费一次调用与约 2 秒延迟。
 *
 * @returns {Promise<{ query: string, rewrite: { attempted: boolean, used: boolean, reason: string, elapsedMs: number } }>}
 *   改写状态放进 `rewrite` 并最终进入 SSE 的 retrieval 元信息——降级必须可见，
 *   否则"改写一直失败、检索一直在跑偏"会无人察觉（项目已因此吃过两次亏）。
 */
async function buildRetrievalQuery({ message, materials = [], history = [] }) {
  const heuristic = buildHeuristicQuery({ message, materials, history })
  const rewrite = { attempted: false, used: false, reason: '', elapsedMs: 0 }
  const hasContext = Array.isArray(history) && history.some((item) => item.role === 'user' && item.content)

  if (!message || !hasContext || !QUERY_REWRITE_ENABLED) {
    if (!QUERY_REWRITE_ENABLED) rewrite.reason = 'disabled'
    else if (!hasContext) rewrite.reason = 'no_context'
    return { query: heuristic, rewrite }
  }

  rewrite.attempted = true
  const result = await rewriteFollowUpQuery({ message, history })
  rewrite.elapsedMs = result.elapsedMs
  if (result.ok) {
    rewrite.used = true
    console.log(`[labor-consult] 检索词改写 ${result.elapsedMs}ms：「${message.slice(0, 40)}」→「${result.query.slice(0, 60)}」`)
    return { query: result.query, rewrite }
  }
  rewrite.reason = result.reason || 'unknown'
  // 完整错误只进服务端日志；reason 是可安全外发的短码（避免把带 Key 片段的错误文本下发）
  console.warn(`[labor-consult] 检索词改写失败（${rewrite.reason}）${result.error ? `: ${result.error}` : ''}，回退启发式检索词`)
  return { query: heuristic, rewrite }
}

/**
 * 解析上传的附件为纯文本。
 * 单个文件解析失败不中断整轮咨询：记入 failures，继续用其余材料作答。
 * @returns {{ materials: Array<{name:string,text:string}>, failures: string[] }}
 */
async function parseAttachments(files = [], onProgress) {
  const materials = []
  const failures = []
  for (const file of files) {
    try {
      onProgress?.(`正在读取附件：${file.originalname}`)
      const parsed = await extractText(file)
      const text = String(parsed?.text || '').trim()
      if (!text) {
        failures.push(`${file.originalname}：未提取到可用文字`)
        continue
      }
      materials.push({ name: file.originalname, text })
    } catch (error) {
      failures.push(`${file.originalname}：${error.message}`)
      console.error(`[labor-consult] 附件解析失败 ${file.originalname}:`, error.message)
    }
  }
  const total = materials.reduce((sum, item) => sum + item.text.length, 0)
  // 总量裁剪移到 consult-material-store：现在要对「本会话历轮材料的合并结果」裁剪，
  // 只裁本轮会让追问轮的总量失控。
  return { materials, failures, totalChars: total }
}

// ---------------------------------------------------------------------------
// GET /api/labor/status
// ---------------------------------------------------------------------------
router.get('/labor/status', (req, res) => {
  try {
    initLabor()
    const status = getLaborStatus()
    let kb = { entries: 0, withCaseRefs: 0, byBook: [] }
    try {
      initializeLaborKb()
      initializeLaborVector()
      kb = { ...getLaborKbStatus(), search: getLaborSearchHealth() }
    } catch (error) {
      console.warn('[labor-consult] 实务问答库状态读取失败:', error.message)
    }
    // 合同知识库（次要信号）的降级计数也一并暴露：此前它只打 console.warn，
    // 运维侧没有任何查询入口，无法发现"一直在降级"。
    const evidence = getEvidenceRetrievalHealth()
    res.json({ ...status, kb, evidence })
  } catch (error) {
    res.status(503).json({ error: '法规白名单暂不可用', detail: error.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/labor/laws —— 法规时效基准表（前端右侧面板展示，与提示词注入同源）
// ---------------------------------------------------------------------------
router.get('/labor/laws', (req, res) => {
  try {
    initLabor()
    res.json({ laws: listLawsForBaseline({ today: new Date() }) })
  } catch (error) {
    res.status(503).json({ error: '法规白名单暂不可用', detail: error.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/labor-consult/verify —— 仅校验引用，不调用模型
// ---------------------------------------------------------------------------
router.post('/labor-consult/verify', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (!text.trim()) return res.status(400).json({ error: '请提供需要校验的文本' })
  try {
    initLabor()
    const laws = listLawsForBaseline({ today: new Date() })
    const result = verifyOutput(text, { laws, today: new Date() })
    res.json({ ...result, notice: renderCitationNotice(result.citations) })
  } catch (error) {
    res.status(500).json({ error: error.message || '引用校验失败' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/labor-consult/forget —— 用户删除会话时清理服务端留存的上传材料
// 不做这件事的话，被删会话的合同原文会在 TTL（2 小时）内继续留在内存里。
// ---------------------------------------------------------------------------
router.post('/labor-consult/forget', (req, res) => {
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : ''
  if (!conversationId) return res.status(400).json({ error: '缺少 conversationId' })
  clearMaterials(conversationId)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// POST /api/labor-consult/title —— 依据首轮提问提炼会话标题
//
// 独立于 SSE 主链路：前端在提问瞬间先用本地启发式（conversation-title.js）命名，
// 作答结束后再调本接口把标题静默升级为 LLM 提炼版。
// 提炼是锦上添花，所以**任何失败都必须回退**——返回 ok:false，前端保留原标题。
// ---------------------------------------------------------------------------
router.post('/labor-consult/title', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question : ''
  if (!question.trim()) return res.status(400).json({ error: '请提供用于命名的问题文本' })
  if (!isTitleRefineEnabled()) return res.json({ ok: false, reason: 'disabled' })

  const result = await refineConversationTitle({ question })
  if (!result.ok && result.error) {
    // 原始错误只留在服务端：实测含 `Your api key: ****test is invalid` 这类片段
    console.warn('[labor-consult] 标题提炼失败:', result.reason, result.error)
  }
  // 只下发安全字段；前端据 ok:false 保留本地标题，不需要额外告警文案
  res.json(toClientResult(result))
})

// ---------------------------------------------------------------------------
// POST /api/labor-consult —— SSE 流式咨询
// ---------------------------------------------------------------------------
router.post('/labor-consult', upload.array('files', MAX_FILES), async (req, res) => {
  const startTime = Date.now()
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  const mode = req.body?.mode === 'fast' ? 'fast' : 'thinking'
  const region = typeof req.body?.region === 'string' ? req.body.region.trim() : ''
  // 客户端生成的会话 id：用于把附件材料归到同一次咨询下，供追问轮复用
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : ''
  const history = parseHistory(req.body?.history)
  const attachments = req.files || []

  if (!message && !attachments.length) {
    return res.status(400).json({ error: '请输入需要咨询的劳动法问题，或上传需要分析的材料' })
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `咨询内容超过 ${MAX_MESSAGE_LENGTH} 字，请精简后重试` })
  }
  if (attachments.length > MAX_FILES) {
    return res.status(400).json({ error: `一次最多上传 ${MAX_FILES} 个附件` })
  }
  for (const file of attachments) {
    if (!isAcceptableFile(file)) {
      return res.status(400).json({ error: `${file.originalname} 文件类型暂不支持` })
    }
  }

  let laws = []
  let evidence = []
  let cases = []
  const warnings = []

  // 先建立 SSE 通道：附件解析（OCR/Office 转换）可能耗时较久，需要即时反馈进度
  res.writeHead(200, sseHeaders)
  const writeSSE = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  // 两个模式统一走 flash，只靠思考档位区分（快速=high / 深度思考=max）。
  // 产品决策：不再用 pro 模型做深度思考，避免两套模型带来的口径差异与成本。
  const model = getFlashModel()

  try {
    initLabor()
    laws = listLawsForBaseline({ today: new Date() })
  } catch (error) {
    console.warn('[labor-consult] 法规白名单初始化失败:', error.message)
    warnings.push('法规白名单暂不可用，本次回答将无法核实法规时效性。')
  }

  // 附件解析：失败不中断整轮咨询，记入 warnings 继续作答。
  // 解析结果并入**会话材料集**——追问轮不再重新上传也能拿到此前提供的合同/制度原文。
  let materials = []
  if (attachments.length) {
    const parsed = await parseAttachments(attachments, (label) => writeSSE('consult.progress', { label }))
    warnings.push(...parsed.failures)
    const merged = mergeMaterials(conversationId, parsed.materials)
    materials = merged.materials
    if (merged.truncated) {
      warnings.push(`本会话材料正文合计超过 ${MAX_TOTAL_TEXT} 字符，已按比例截断，建议精简材料后重试`)
    }
    if (!parsed.materials.length && !message) {
      writeSSE('error', { message: `附件解析失败：${parsed.failures.join('；') || '未提取到可用文字'}` })
      writeSSE('done', {})
      return res.end()
    }
  } else {
    // 不带附件的追问：取回本会话此前上传的材料
    materials = getMaterials(conversationId)
  }

  const { query: retrievalQuery, rewrite: queryRewrite } = await buildRetrievalQuery({ message, materials, history })
  // 把真正用于检索的文本打出来：追问被改写后，不记录就无法判断检索是否真的用上了上下文
  console.log(`[labor-consult] 检索词(${retrievalQuery.length}字): `
    + `${retrievalQuery.slice(0, 160).replace(/\n/g, ' ⏎ ')}${retrievalQuery.length > 160 ? '…' : ''}`)

  // 三路检索：① 实务问答（主力）② 案例 ③ 合同范本条款/风险点
  // 三路检索互相独立，并行执行。
  // 串行时总耗时是各路径之和（实测约 1.9s）；并行后取决于最慢的一路（约 0.85s）。
  const retrievalStarted = Date.now()
  const [kbResult, evidenceResult, caseResult] = await Promise.allSettled([
    (async () => {
      initializeLaborKb()
      initializeLaborVector()
      // 混合检索：词法 + 语义 → RRF 融合 → 模型重排（含两次外部调用）
      return searchLaborKb(retrievalQuery, { limit: KB_LIMIT })
    })(),
    (async () => {
      initKnowledgeBase()
      return retrieveLaborEvidence(buildLaborReviewPlan(retrievalQuery))
    })(),
    Promise.resolve().then(() => searchCases(retrievalQuery, { limit: CASE_LIMIT, region }))
  ])
  const retrievalMs = Date.now() - retrievalStarted

  let kbEntries = []
  let kbRetrieval = null
  if (kbResult.status === 'fulfilled') {
    kbEntries = kbResult.value
    kbRetrieval = kbEntries.retrieval || null
    if (kbRetrieval && (kbRetrieval.vector.degraded || kbRetrieval.rerank.degraded)) {
      // 降级必须让用户看见，而不是静默回落成纯词法
      const parts = []
      if (kbRetrieval.vector.degraded) parts.push(`语义召回（${describeDegrade(kbRetrieval.vector.reason)}）`)
      if (kbRetrieval.rerank.degraded) parts.push(`模型重排（${describeDegrade(kbRetrieval.rerank.reason)}）`)
      warnings.push(`${parts.join('、')}已降级，本轮按词法结果排序。`)
    }
  } else {
    console.warn('[labor-consult] 实务问答检索失败:', kbResult.reason?.message)
    warnings.push('实务问答库检索失败，本次回答未使用库内实务经验。')
  }

  if (evidenceResult.status === 'fulfilled') {
    evidence = evidenceResult.value
    // 合同知识库的降级此前在 searchEvidence 内部就被吞掉，接口层永远看不到——
    // 结果这条路径 100% 降级却对用户完全不可见。现在把它一并写进 warnings。
    const evidenceRetrieval = evidence.retrieval
    if (evidenceRetrieval?.vector?.degraded || evidenceRetrieval?.rerank?.degraded) {
      const parts = []
      if (evidenceRetrieval.vector.degraded) parts.push(`合同知识库语义召回（${describeDegrade(evidenceRetrieval.vector.reason)}）`)
      if (evidenceRetrieval.rerank.degraded) parts.push(`合同知识库模型重排（${describeDegrade(evidenceRetrieval.rerank.reason)}）`)
      warnings.push(`${parts.join('、')}已降级，本轮仅使用其词法结果。`)
    }
  } else {
    console.warn('[labor-consult] 知识库检索失败:', evidenceResult.reason?.message)
    warnings.push('知识库检索失败，本次回答未使用库内证据。')
  }

  if (caseResult.status === 'fulfilled') {
    cases = caseResult.value
  } else {
    console.warn('[labor-consult] 案例检索失败:', caseResult.reason?.message)
    warnings.push('案例库检索失败，本次回答未引用案例。')
  }

  try {
    writeSSE('consult.start', {
      mode,
      model,
      today: new Date().toISOString(),
      laws: laws.length,
      kbEntries: kbEntries.length,
      retrieval: {
        ...(kbRetrieval || {}),
        totalMs: retrievalMs,
        // 改写状态随检索元信息一起下发：失败时前端与日志都能看到，
        // 避免"改写一直失败、检索一直跑偏"无人察觉
        queryRewrite
      },
      cases: cases.length,
      evidence: evidence.length,
      attachments: materials.map((item) => item.name),
      warnings
    })
    // 先把证据推给前端，右侧证据抽屉可即时渲染，不必等模型输出
    writeSSE('consult.evidence', {
      // 实务问答：与用户提问形态最接近，作为第一组证据
      kbEntries: kbEntries.map((item, index) => ({
        id: `B${index + 1}`,
        book: item.book,
        chapter: item.chapter,
        section: item.section,
        questionNo: item.questionNo,
        title: item.title,
        content: String(item.content || '').slice(0, 4000),
        caseRefs: item.caseRefs
      })),
      evidence: evidence.map((item, index) => ({
        id: `K${index + 1}`,
        kind: item.kind,
        title: [item.clauseNo, item.title].filter(Boolean).join(' '),
        category: item.category || '',
        sourceName: item.sourceName || '',
        referenceRole: item.referenceRole || '',
        text: String(item.text || '').slice(0, 1200)
      })),
      cases: cases.map((item, index) => ({
        id: `C${index + 1}`,
        title: item.title,
        caseNo: item.caseNo,
        court: item.court,
        region: item.region,
        caseType: item.caseType,
        batch: item.batch,
        disputeFocus: item.disputeFocus,
        holding: String(item.holding || '').slice(0, 900),
        legalBasis: item.legalBasis
      }))
    })

    const systemPrompt = buildLaborConsultSystemPrompt({ now: new Date(), laws })
    const userMessage = buildLaborConsultUserMessage({ message, evidence, cases, attachments: materials, kbEntries })

    let answer = ''
    let reasoning = ''
    for await (const chunk of streamChat(systemPrompt, userMessage, {
      model,
      temperature: 0.3,
      maxTokens: MAX_OUTPUT_TOKENS,
      history,
      // ⚠️ 快速模式**必须**开启 thinking，否则 reasoning_effort 会被丢弃：
      // llm-client.js 的 resolveThinkingOptions 只在 type==='enabled' 时才附带 reasoning_effort。
      // 早前快速模式是 { type: 'disabled' }，那时设档位是空指令。
      thinking: { type: 'enabled' },
      reasoningEffort: mode === 'fast' ? 'high' : 'max'
    })) {
      // 思考内容单独成路：前端以弱化样式流式展示，正文一到就自动折叠。
      // **绝不并入 answer**——引用校验只针对正文；思考里出现的法条往往是模型
      // 自我排除的候选（甚至是被否定的错误版本），混进去会产生大量假的"未收录"告警。
      if (chunk.reasoning) {
        reasoning += chunk.reasoning
        writeSSE('consult.reasoning', { content: chunk.reasoning })
      }
      if (!chunk.content) continue
      answer += chunk.content
      writeSSE('consult.delta', { content: chunk.content })
    }

    if (!answer.trim()) throw new Error('模型未返回内容')

    // 服务端引用校验：只标注，不改写模型输出。
    // excludeTitles 传入附件文件名与正文首行标题——模型会用书名号引用材料本身，
    // 那些不是法规，不应被判为"未收录法规"。
    const verified = verifyOutput(answer, {
      laws,
      today: new Date(),
      excludeTitles: materials.flatMap((item) => [item.name, ...String(item.text || '').split('\n').slice(0, 3)])
    })
    writeSSE('consult.citations', {
      citations: verified.citations,
      summary: verified.summary,
      notice: renderCitationNotice(verified.citations)
    })
    writeSSE('done', { elapsedMs: Date.now() - startTime, citations: verified.summary.total })
  } catch (error) {
    console.error('[labor-consult] 咨询失败:', error.message)
    writeSSE('error', { message: error.message || '咨询请求失败，请稍后重试' })
    writeSSE('done', {})
  } finally {
    res.end()
  }
})

// 启动时确保白名单与案例表存在（幂等）
export function bootstrapLaborKnowledge() {
  initLabor()
  return seedLawWhitelist()
}

export default router
