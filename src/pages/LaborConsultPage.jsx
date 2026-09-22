import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ExternalLink,
  FileText,
  Gavel,
  History,
  Library,
  Loader2,
  MessageCircle,
  PanelLeft,
  PenLine,
  Plus,
  RefreshCw,
  Scale,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import './ContractRewritePage.css'
import './LaborConsultPage.css'
// 附件格式白名单与选择逻辑统一走共享模块：此前三处副本已经漂移（本页含 .markdown、合同页不含），
// 且用字符串 includes 判断会把无扩展名文件误放行。
import { ACCEPTED_EXTENSIONS, mergeSelectedFiles, describeRejection } from '../utils/file-selection.js'
// 会话标题与相对时间：标题启发式必须与服务端共用同一份定义，
// 否则 LLM 提炼失败时的回退路径会与"即时标题"不一致，用户会看到标题来回跳。
import { buildConversationTitle, shouldAutoTitle, firstQuestionOf, DEFAULT_TITLE } from '../utils/conversation-title.js'
import { formatRelativeTime, RELATIVE_TIME_TICK_MS } from '../utils/relative-time.js'
// 流式渲染节流：把"每个 SSE 事件一次渲染"降到"每帧一次"。
// 这是老浏览器（2018 MacBook Air 的 Safari、360 浏览器）长思考崩溃的核心修复，
// 实测量级见 stream-buffer.js 的说明（一轮问答 5475 个事件）。
import { createStreamBuffer, throttleWithTrailing, MARKDOWN_THROTTLE_MS } from '../utils/stream-buffer.js'

const CONSULT_ENDPOINT = '/api/labor-consult'
const THREAD_STORAGE_KEY = 'fafee-labor-consult-threads-v1'
/**
 * 持久化时单条「思考过程」的保留上限。
 * 深度思考档单条思考可达 4 万字，而 writeStorage 的 catch 是**静默**的——
 * 超出 localStorage 配额后整个会话历史会停止保存且没有任何提示。
 * 思考只是"可回看的附注"，截断它远比丢掉全部历史划算。
 */
const MAX_PERSISTED_REASONING = 8000
const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`)

const starterPrompts = [
  '员工入职三个月没签书面劳动合同，现在离职要求二倍工资，公司该怎么应对？',
  '员工严重违纪但公司规章制度没有经过民主程序和公示，解除会不会被认定违法？',
  '公司给员工调岗降薪，员工不同意并申请仲裁，公司有哪些抗辩空间？',
  '保安岗位签了竞业限制协议，员工离职后去了同行，公司能主张违约金吗？'
]

const modeOptions = [
  { key: 'fast', label: '快速', hint: '响应更快，适合明确问题的条文与流程确认' },
  { key: 'thinking', label: '深度思考', hint: '适合复杂案件分析与策略推演' }
]

const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createConversation = (title = DEFAULT_TITLE) => ({
  id: createId('labor'),
  title,
  messages: [],
  updatedAt: Date.now()
})
const readStorage = (key, fallback) => { try { return JSON.parse(window.localStorage.getItem(key) || '') || fallback } catch { return fallback } }
const writeStorage = (key, value) => { try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* 存储不可用时不影响咨询 */ } }
/**
 * 读取本地会话。
 *
 * 顺带清掉"挂了但一句没问"的空会话：`createConversation()` 在页面挂载时就会建一条，
 * 用户若直接刷新离开，它会被持久化下来。攒久了侧边栏就是一串同名的「新的用工咨询」——
 * 正是本次要解决的观感问题。只保留最近的一条空会话（也就是当前这条）。
 */
const normalizeThreads = (value) => {
  const threads = Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object').map((item) => ({
      ...item,
      id: typeof item.id === 'string' ? item.id : createId('labor'),
      title: typeof item.title === 'string' ? item.title : '历史咨询',
      messages: Array.isArray(item.messages) ? item.messages : [],
      updatedAt: Number(item.updatedAt) || Date.now()
    }))
    : []
  const isEmpty = (item) => item.messages.length === 0
  const newestEmpty = threads.filter(isEmpty).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return threads.filter((item) => !isEmpty(item) || item === newestEmpty)
}

/**
 * 思考过程面板。
 *
 * 设计取向是**不喧宾夺主**：
 *  - 平时只占一行（灰底、小字、无边框），远弱于正文的视觉权重；
 *  - 流式思考期间自动展开并跟随滚动底部，把"静默等待"变成"可见进展"；
 *  - 正文一开始就自动折叠，正文始终是唯一的主体。
 *
 * ⚠️ 性能约束（老浏览器崩溃的根因之一）：单条思考可达 4.7 万字，
 * 而流式期间会更新上千次。这里的每一处实现都是为了**不强制重排**：
 *  - 滚动用 rAF 推迟到帧边界，不在 React 提交阶段读取 scrollHeight（读它 = 强制同步布局）；
 *  - 用户一旦自己往上滚就不再自动跟随（`stick`），避免与用户的滚动意图打架；
 *  - 折叠时**完全不渲染正文**，思考再长也不占 DOM/布局；
 *  - 流式期间只渲染**尾部窗口**（见 LIVE_REASONING_WINDOW）：布局开销与实际文本长度解耦。
 */
function ReasoningPanel({ text, live, open, onToggle }) {
  const bodyRef = useRef(null)
  // 是否贴底跟随。用户手动上滚后置 false，滚回底部再恢复——否则每来一块内容
  // 都会把他拽回底部，长思考下等于无法阅读。
  const stickRef = useRef(true)
  /**
   * 流式期间只把尾部这么多字放进 DOM。
   *
   * 为什么必须做：`max-height: 260px` 只裁剪**绘制**，浏览器仍要为整个文本节点
   * 算出行盒。4.7 万字的节点每帧重排一次，正是老 Safari 卡死的地方。
   * 思考是"刚刚在想什么"的实时反馈，看尾部即可——完整内容在流结束后（或折叠再展开）照常可读。
   *
   * 2 万字的取值：实测快速档思考仅约 4.4 千字、深度档可达 4.7 万字，
   * 取 2 万既覆盖了绝大多数正常思考（不触发截断），又把最坏情况砍掉一半以上。
   */
  const LIVE_REASONING_WINDOW = 20000
  const streaming = live && open && text.length > LIVE_REASONING_WINDOW
  const shown = streaming ? text.slice(-LIVE_REASONING_WINDOW) : text

  useEffect(() => {
    if (!live || !open) return
    const body = bodyRef.current
    if (!body) return
    // 推迟到帧边界：React 提交后立刻写 scrollTop 会触发同步布局，
    // 而这个面板每帧都可能更新。rAF 让写入与绘制对齐。
    const handle = requestAnimationFrame(() => {
      if (stickRef.current !== false) body.scrollTop = body.scrollHeight
    })
    return () => cancelAnimationFrame(handle)
  }, [text, live, open])

  const handleScroll = () => {
    const body = bodyRef.current
    if (!body) return
    // 距底部 24px 内视为"仍在跟随"，容忍亚像素与字体度量误差
    stickRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24
  }

  return (
    <div className={`labor-reasoning${live ? ' is-live' : ''}`}>
      <button type="button" className="labor-reasoning-head" onClick={onToggle} aria-expanded={open}>
        <Brain size={14} className={live ? 'reasoning-pulse' : ''} />
        <span className="reasoning-label">{live ? '正在思考…' : '思考过程'}</span>
        <span className="reasoning-meta">{text.length} 字</span>
        <ChevronDown size={14} className={`reasoning-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <div className="labor-reasoning-body" ref={bodyRef} onScroll={handleScroll}>
          {streaming && <p className="reasoning-window-note">…已折叠前 {text.length - LIVE_REASONING_WINDOW} 字，完整思考在结束后可回看</p>}
          {shown}
        </div>
      )}
    </div>
  )
}

/**
 * 正文渲染。
 *
 * `React.memo` 在这里不是可选的优化：正文每收到一块增量都会重渲染，
 * 而 Markdown 解析是"解析整篇"——不比较就重解析，一轮问答要解析 2700 多次（O(n²)），
 * 这正是 2018 款 MacBook Air 上 Safari 崩溃的主因。比较 content 后，
 * 解析次数降到与节流频率一致（约 30 次/轮）。
 */
const AnswerBody = React.memo(function AnswerBody({ content }) {
  return (
    <div className="labor-answer">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
})

/** 引用核实徽标 */
function CitationBadge({ citation }) {
  const tone = citation.ok ? 'ok' : citation.level === 'warn' ? 'warn' : 'error'
  const Icon = citation.ok ? ShieldCheck : AlertTriangle
  const article = citation.articleNo ? `第${citation.articleNo}条` : ''
  return (
    <li className={`citation-item ${tone}`}>
      <Icon size={15} />
      <div>
        <strong>《{citation.lawName}》{article}</strong>
        <span className="citation-label">{citation.label}</span>
        {citation.note && <small>{citation.note}</small>}
        {citation.versionLabel && <small className="citation-meta">{citation.versionLabel}{citation.effectiveFrom ? ` · 自 ${citation.effectiveFrom} 起施行` : ''}</small>}
      </div>
    </li>
  )
}

/** 右侧证据抽屉 */
function EvidencePanel({ payload, baseline, status, metaLoading, metaError, onRetry }) {
  const [tab, setTab] = useState('case')
  // 只展示现行有效的法规：已失效 / 已被取代的条目不在界面保留。
  // 注意：它们仍然留在服务端白名单里——引用校验需要据此把"已废止法规"判为不通过。
  const activeLaws = useMemo(
    () => baseline.filter((item) => item.status === 'effective' && !item.effectiveTo),
    [baseline]
  )
  // 服务未连通时，四个页签显示 "—" 而不是 0，避免把"没连上"误读成"没检索到"
  const count = (value) => (metaLoading || metaError ? '—' : value)
  const tabs = [
    { key: 'kb', label: '实务问答', count: count(payload?.kbEntries?.length || 0), icon: BookOpen },
    { key: 'case', label: '案例', count: count(payload?.cases?.length || 0), icon: Gavel },
    { key: 'evidence', label: '合同范本', count: count(payload?.evidence?.length || 0), icon: Library },
    { key: 'law', label: '法规基准', count: count(activeLaws.length), icon: Scale }
  ]
  const active = tabs.find((item) => item.key === tab) || tabs[0]
  return (
    <aside className="labor-evidence">
      <header className="labor-evidence-head">
        <div>
          <strong>证据与依据</strong>
          <small>
            {metaError
              ? '无法连接后端服务'
              : metaLoading
                ? '正在读取知识库状态…'
                : status
                  ? `实务问答 ${status.kb?.entries ?? 0} 条 · 案例 ${status.cases} 条 · 法规 ${status.effectiveLaws}/${status.laws} 条现行有效`
                  : '知识库状态未知'}
          </small>
        </div>
      </header>
      {metaError && (
        <div className="labor-service-error">
          <p><AlertTriangle size={14} />{metaError}</p>
          <button type="button" onClick={onRetry}>重新连接</button>
        </div>
      )}
      <nav className="labor-evidence-tabs">
        {tabs.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.key}
              type="button"
              className={item.key === active.key ? 'active' : ''}
              onClick={() => setTab(item.key)}
            >
              <Icon size={15} />{item.label}<em>{item.count}</em>
            </button>
          )
        })}
      </nav>
      <div className="labor-evidence-body">
        {active.key === 'kb' && (
          metaError
            ? <p className="labor-empty">后端服务未启动或不可达，无法检索实务问答库。</p>
            : !payload?.kbEntries?.length
              ? <p className="labor-empty">本次未检索到实务问答条目。问答库覆盖用工模式、招聘入职、工资工时、社保、工伤、离职解除等专题。</p>
              : payload.kbEntries.map((item) => (
                <article className="labor-kb-card" key={item.id}>
                  <div className="labor-card-head">
                    <span className="labor-tag">{item.id}</span>
                    <strong>{item.questionNo} {item.title}</strong>
                  </div>
                  <p className="labor-card-meta">{[item.book, item.chapter, item.section].filter(Boolean).join(' › ')}</p>
                  <p className="labor-card-line">{item.content}</p>
                  {item.caseRefs?.length > 0 && (
                    <p className="labor-card-cases"><b>条目内引用案号</b>{item.caseRefs.join('、')}</p>
                  )}
                </article>
              ))
        )}
        {active.key === 'case' && (
          metaError
            ? <p className="labor-empty">后端服务未启动或不可达。请在项目根目录另开一个终端运行 <code>npm run server</code> 后点击「重新连接」。</p>
            : !payload?.cases?.length
              ? <p className="labor-empty">本次未检索到相关案例。案例库以人社部、最高法联合发布的劳动人事争议典型案例为主。</p>
              : payload.cases.map((item) => (
                <article className="labor-case-card" key={item.id}>
                  <div className="labor-card-head">
                    <span className="labor-tag">{item.id}</span>
                    <strong>{item.title}</strong>
                  </div>
                  <p className="labor-card-meta">
                    {[item.caseNo, item.court, item.caseType, item.batch].filter(Boolean).join(' · ') || '来源信息未标注'}
                  </p>
                  {item.disputeFocus && <p className="labor-card-line"><b>争议焦点</b>{item.disputeFocus}</p>}
                  {item.holding && <p className="labor-card-line"><b>裁判要点</b>{item.holding}</p>}
                </article>
              ))
        )}
        {active.key === 'evidence' && (
          metaError
            ? <p className="labor-empty">后端服务未启动或不可达，无法检索知识库证据。</p>
            : !payload?.evidence?.length
              ? <p className="labor-empty">本次未检索到知识库证据。劳动合同范本与风险点仍在补充中。</p>
              : payload.evidence.map((item) => (
                <article className="labor-evidence-card" key={item.id}>
                  <div className="labor-card-head">
                    <span className="labor-tag">{item.id}</span>
                    <strong>{item.title || item.sourceName || '知识库条款'}</strong>
                  </div>
                  <p className="labor-card-meta">{item.sourceName}{item.category ? ` · ${item.category}` : ''}</p>
                  <p className="labor-card-line">{item.text}</p>
                </article>
              ))
        )}
        {active.key === 'law' && (
          metaError
            ? <p className="labor-empty">后端服务未启动或不可达，无法读取法规时效基准。</p>
            : metaLoading
              ? <p className="labor-empty">正在载入法规时效基准…</p>
              : (
                <>
                  <p className="labor-note">
                    本表为服务端维护的现行有效法规清单，法条引用核实以此为准。
                    未收录的法规会被标注“未收录，需人工核实”，不会凭模型记忆引用。
                  </p>
                  {activeLaws.length
                    ? activeLaws.map((item) => (
                      <article className={`labor-law-row ${item.status}`} key={item.title}>
                        <strong>《{item.title}》</strong>
                        <span>{item.versionLabel || '版本未标注'} · 自 {item.effectiveFrom} 起施行</span>
                        {item.reviewStatus !== 'verified' && <span className="labor-law-pending">待人工复核</span>}
                      </article>
                    ))
                    : <p className="labor-empty">法规基准表为空，请运行 npm run verify:laws 检查白名单。</p>}
                </>
              )
        )}
      </div>
    </aside>
  )
}

/**
 * 一张画布式的 Markdown 节流器：按 messageId 维护"最近一次已解析文本"。
 *
 * 用 ref 而不是 state 承载它——它是调度装置，不该参与渲染。
 * `setStreamedMarkdown` 只接受**真正的文本变化**，因为写入相同字符串
 * 依然会让 `AnswerBody` 的 memo 失效（props 引用未变但 state 更新仍触发父级渲染）。
 */
function createMarkdownScheduler({ getContent, setMarkdown }) {
  const latest = new Map()
  const parse = (messageId) => {
    const content = getContent(messageId)
    if (!content || latest.get(messageId) === content) return
    latest.set(messageId, content)
    setMarkdown((prev) => ({ ...prev, [messageId]: content }))
  }
  const throttled = throttleWithTrailing(parse, MARKDOWN_THROTTLE_MS)
  return {
    /**
     * 记录一份**权威**的完整正文。
     *
     * 调用方（流式结尾）手里有缓冲算出的确切文本，比回读 React state 可靠：
     * setState 异步，此刻刚补写的内容可能还没进 state。异步读取正是"结尾丢失"的来源，
     * 所以权威值直接落 Map，后续任何 parse 读到脏数据都会被它纠正。
     */
    prime(messageId, content) {
      if (typeof content === 'string' && content) latest.set(messageId, content)
    },
    /** 该消息有新正文到达时调用（已按帧合并过） */
    schedule(messageId) {
      throttled(messageId)
    },
    /** 流结束时立即解析尾部，保证最后一段内容一定落地 */
    finalize(messageId, content) {
      if (typeof content === 'string' && content) {
        // 权威值：绕过节流与 state 回读，直接落快照
        throttled.cancel()
        latest.set(messageId, content)
        setMarkdown((prev) => ({ ...prev, [messageId]: content }))
        return
      }
      // 无尾部增量（缓冲已在上一帧提交过）→ 仍要执行可能挂起的尾调用
      throttled.flush()
      parse(messageId)
    },
    /** 丢弃挂起调用（开始新一轮/卸载时） */
    cancel() {
      throttled.cancel()
    }
  }
}

function LaborConsultPage() {
  const inFlightRef = useRef(new Set())
  const searchRef = useRef(null)
  const fileInputRef = useRef(null)
  const [conversations, setConversations] = useState(() => {
    const saved = normalizeThreads(readStorage(THREAD_STORAGE_KEY, []))
    return saved.length ? saved : [createConversation()]
  })
  const [activeId, setActiveId] = useState('')
  const [question, setQuestion] = useState('')
  const [files, setFiles] = useState([])
  const [mode, setMode] = useState('thinking')
  const [requests, setRequests] = useState({})
  const [baseline, setBaseline] = useState([])
  const [status, setStatus] = useState(null)
  const [metaLoading, setMetaLoading] = useState(true)
  const [metaError, setMetaError] = useState('')
  const [historyQuery, setHistoryQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [balanceOpen, setBalanceOpen] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceError, setBalanceError] = useState('')
  const [balanceData, setBalanceData] = useState(null)
  /**
   * 会话列表的相对时间基准。
   * 相对时间必须自己会走：不刷新的话「1分钟前」会一直挂在那里，用户过一小时
   * 回来看到的还是「1分钟前」。粒度最细是分钟，30s 一跳足够，也不会造成明显重渲染。
   */
  const [now, setNow] = useState(() => Date.now())
  /**
   * 流式期间的正文 Markdown 快照（messageId → 已解析的文本）。
   *
   * 为什么不直接用 `message.content`：Markdown 每次解析都要处理**整篇**文本，
   * 而正文会更新上千次 → O(n²)。这里让正文按 MARKDOWN_THROTTLE_MS 节流更新，
   * 流结束后再移除快照、回到 message.content 的那一份完整文本。
   */
  const [streamedMarkdown, setStreamedMarkdown] = useState({})
  /**
   * 正文 Markdown 节流调度器。用 ref 承载：它是调度装置，不该触发渲染。
   * getContent 读的是**最新**的 state（通过 ref 转发），因此节流不会读到过期内容。
   */
  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations
  const markdownThrottleRef = useRef(null)
  if (!markdownThrottleRef.current) {
    markdownThrottleRef.current = createMarkdownScheduler({
      getContent: (messageId) => {
        for (const conversation of conversationsRef.current) {
          const message = conversation.messages.find((item) => item.id === messageId)
          if (message) return message.content || ''
        }
        return ''
      },
      setMarkdown: setStreamedMarkdown
    })
  }

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId) || conversations[0],
    [activeId, conversations]
  )
  const activeRequest = requests[activeConversation?.id] || {}
  const isAsking = Boolean(activeRequest.loading)
  const matchingConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((item) => item.title.toLowerCase().includes(historyQuery.trim().toLowerCase())),
    [conversations, historyQuery]
  )
  const cnyBalance = balanceData?.balances?.find((item) => item.currency === 'CNY')
  const latestEvidence = useMemo(() => {
    const messages = [...(activeConversation?.messages || [])].reverse()
    return messages.find((message) => message.type === 'assistant' && message.evidence)?.evidence || null
  }, [activeConversation])

  useEffect(() => {
    if (conversations.length && !conversations.some((item) => item.id === activeId)) setActiveId(conversations[0].id)
  }, [activeId, conversations])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  // 卸载时清掉挂起的节流尾调用，避免对已卸载组件 setState
  useEffect(() => () => markdownThrottleRef.current?.cancel(), [])
  useEffect(() => {
    // 写入前裁剪思考过程：它是全量会话里最占空间、又最不重要的一部分。
    writeStorage(THREAD_STORAGE_KEY, conversations.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => (
        typeof message.reasoning === 'string' && message.reasoning.length > MAX_PERSISTED_REASONING
          ? { ...message, reasoning: `${message.reasoning.slice(0, MAX_PERSISTED_REASONING)}\n\n…（思考过程过长，此处仅保留开头部分）` }
          : message
      ))
    })))
  }, [conversations])

  // 拉取法规基准与知识库状态（用于右侧面板与提示词一致性展示）
  // 关键：接口不可达时必须给出错误态与重试入口，不能永远停在"正在载入…"。
  // 常见原因是后端未启动：需在项目根目录另开终端运行 npm run server。
  const loadMeta = useCallback(async (signal) => {
    setMetaLoading(true)
    setMetaError('')
    const withTimeout = async (url) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
      try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      const [statusPayload, lawsPayload] = await Promise.all([
        withTimeout('/api/labor/status'),
        withTimeout('/api/labor/laws')
      ])
      if (signal?.aborted) return
      if (statusPayload) setStatus(statusPayload)
      if (lawsPayload?.laws) setBaseline(lawsPayload.laws)
    } catch (error) {
      if (signal?.aborted) return
      const offline = error.name === 'AbortError' || /Failed to fetch|NetworkError|ECONNREFUSED|HTTP 5/i.test(error.message)
      setMetaError(offline
        ? '无法连接后端服务（连接被拒绝）。请在项目根目录另开终端执行 npm run server。'
        : `读取知识库状态失败：${error.message}`)
    } finally {
      if (!signal?.aborted) setMetaLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    loadMeta(controller.signal)
    return () => controller.abort()
  }, [loadMeta])

  // 余额查询：与合同审查、合同起草两个工作台保持一致的交互
  const loadBalance = async () => {
    setBalanceLoading(true)
    setBalanceError('')
    try {
      const response = await fetch('/api/account/balance', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || '暂时无法读取剩余用量。')
      setBalanceData(payload)
    } catch (error) {
      setBalanceError(error.message || '暂时无法读取剩余用量。')
    } finally {
      setBalanceLoading(false)
    }
  }
  const toggleBalance = () => {
    const next = !balanceOpen
    setBalanceOpen(next)
    if (next) loadBalance()
  }

  const updateConversation = (conversationId, updater) => {
    setConversations((items) => items.map((item) => item.id === conversationId ? { ...updater(item), updatedAt: Date.now() } : item))
  }
  const appendMessage = (conversationId, message) => updateConversation(conversationId, (conversation) => ({ ...conversation, messages: [...conversation.messages, message] }))
  const updateMessage = (conversationId, messageId, patch) => updateConversation(conversationId, (conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => message.id === messageId
      ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) }
      : message)
  }))
  const patchRequest = (conversationId, patch) => setRequests((items) => ({ ...items, [conversationId]: { ...(items[conversationId] || {}), ...patch } }))

  const consumeSSE = async (response, onEvent) => {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('浏览器不支持流式响应')
    const decoder = new TextDecoder()
    let buffer = ''
    const consumeBlock = (block) => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || 'message'
      const serialized = [...block.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]).join('\n')
      if (!serialized) return
      try { onEvent(event, JSON.parse(serialized)) } catch { onEvent(event, { content: serialized }) }
    }
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      blocks.forEach(consumeBlock)
      if (done) break
    }
    if (buffer.trim()) consumeBlock(buffer)
  }

  /**
   * 后台把本地启发式标题升级为 LLM 提炼版。
   *
   * 时机刻意放在**作答结束之后**：起标题是锦上添花，绝不能和正文抢延迟
   * （深度思考档已经要等 168 秒）。失败/超时一律静默保留本地标题——
   * 这不是"静默降级"违规，因为降级后的结果（一个可辨识的裁剪标题）本身就是完整可用的。
   *
   * `firstQuestionRef` 保证只命名**首轮**：追问轮不改标题，否则标题会随每一轮漂移，
   * 用户刚记住的名字就变了。
   */
  const refineTitle = async (conversationId, firstQuestion) => {
    if (!firstQuestion) return
    try {
      const response = await fetch('/api/labor-consult/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: firstQuestion })
      })
      if (!response.ok) return
      const payload = await response.json().catch(() => ({}))
      if (!payload?.ok || typeof payload.title !== 'string') return
      setConversations((items) => items.map((item) => (
        // 再确认一次：期间用户可能已经删掉该会话，或者标题已被别的路径改写
        item.id === conversationId && shouldAutoTitle(item.title, firstQuestion)
          ? { ...item, title: payload.title }
          : item
      )))
    } catch { /* 提炼失败保留本地标题，不打扰用户 */ }
  }

  const ask = async () => {
    const content = question.trim()
    if ((!content && !files.length) || isAsking || !activeConversation || inFlightRef.current.has(activeConversation.id)) return
    const conversationId = activeConversation.id
    const assistantId = createId('assistant')
    const history = activeConversation.messages
      .filter((message) => (message.type === 'user' || message.type === 'assistant') && message.content)
      .slice(-6)
      .map((message) => ({ role: message.type === 'user' ? 'user' : 'assistant', content: message.content }))

    const uploadedFiles = files.map((file) => ({ name: file.name, size: file.size }))
    const displayContent = content || `请分析我上传的 ${uploadedFiles.length} 份材料涉及的劳动用工问题。`
    // 首轮判定必须在 appendMessage 之前取，追加后就再也分不出哪条是首轮了。
    const isFirstTurn = !firstQuestionOf(activeConversation)

    appendMessage(conversationId, { id: createId('user'), type: 'user', content: displayContent, files: uploadedFiles })
    appendMessage(conversationId, { id: assistantId, type: 'assistant', content: '', status: files.length ? '正在读取附件…' : '正在检索法规与类案…' })
    // 即时命名：先用本地启发式给出一个可辨识的标题（零延迟零成本），
    // 作答结束后再由 refineTitle 静默升级为 LLM 提炼版。
    // 命名依据统一走 firstQuestionOf（= 用户提问，仅附件轮则用文件名），
    // 保证"即时标题"与"LLM 提炼所用文本"始终同源，不会一个用提问、一个用合成文案。
    const titleSource = files.length && !content ? uploadedFiles[0].name : displayContent
    if (isFirstTurn) {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        title: buildConversationTitle(titleSource)
      }))
    }
    setQuestion('')
    setFiles([])
    inFlightRef.current.add(conversationId)
    patchRequest(conversationId, { loading: true, error: '' })

    /**
     * 流式渲染节流（老浏览器崩溃的修复核心）。
     *
     * 旧实现：每个 SSE 事件一次 setState → 一轮问答 5475 次完整渲染，
     * 且正文每块都重解析整篇 Markdown。Safari / 360 浏览器直接崩。
     *
     * 现在：事件先进缓冲，**每帧至多提交一次**（≈60/秒上限，实际远低于此）；
     * 正文再按 MARKDOWN_THROTTLE_MS 节流成 Markdown 快照。
     *
     * ⚠️ 必须在 try 之外创建、且 finally 里收尾：中途抛错时未提交的增量
     * 若不落盘，用户会看到"回答少了一截"或思考面板停在半途。
     */
    const buffer = createStreamBuffer((patch) => {
      const isFirstContent = Boolean(patch.content)
      updateMessage(conversationId, assistantId, (current) => ({
        ...(patch.reasoning ? { reasoning: `${current.reasoning || ''}${patch.reasoning}` } : {}),
        ...(patch.content ? { content: `${current.content || ''}${patch.content}` } : {}),
        ...(isFirstContent ? { status: '' } : {}),
        // 思考的**首块**自动展开，让用户看到进展
        ...(patch.reasoning && !current.reasoning ? { reasoningOpen: true } : {}),
        // 正文首块到达 = 思考结束，自动折叠思考区。
        // 只在首次折叠，之后尊重用户手动的展开/收起，避免边写边被强行收起。
        ...(isFirstContent && current.reasoning ? { reasoningOpen: false } : {})
      }))
      if (patch.content) markdownThrottleRef.current?.schedule(assistantId)
    })
    markdownThrottleRef.current?.cancel()

    try {
      // 有附件时走 multipart/form-data；无附件时保持 JSON，减少不必要的编码开销
      const form = files.length ? new FormData() : null
      if (form) {
        form.append('message', content)
        form.append('mode', mode)
        form.append('history', JSON.stringify(history))
        // 会话 id：服务端据此把附件材料归到同一次咨询，追问轮无需重新上传即可复用
        form.append('conversationId', conversationId)
        files.forEach((file) => form.append('files', file))
      }
      const response = await fetch(CONSULT_ENDPOINT, {
        method: 'POST',
        headers: form ? { Accept: 'text/event-stream' } : { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: form || JSON.stringify({ message: content, mode, history, conversationId })
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || `咨询请求失败（${response.status}）`)
      }
      await consumeSSE(response, (event, data) => {
        if (event === 'consult.progress') {
          updateMessage(conversationId, assistantId, { status: data.label || '正在读取附件…' })
        }
        if (event === 'consult.start') {
          const parts = [`已载入 ${data.kbEntries || 0} 条实务问答、${data.laws} 条法规基准、${data.cases} 条案例`]
          if (data.attachments?.length) parts.push(`解析附件 ${data.attachments.length} 份`)
          updateMessage(conversationId, assistantId, {
            status: `${parts.join('、')}，正在分析…`,
            model: data.model,
            warnings: data.warnings || []
          })
        }
        if (event === 'consult.evidence') {
          updateMessage(conversationId, assistantId, { evidence: data })
        }
        // ⚠️ reasoning / delta 两路都只**累积到缓冲**，不直接 setState。
        // 实测一轮问答下发 2713 + 2762 个事件，逐个渲染会让老浏览器卡死（见 stream-buffer.js）。
        if (event === 'consult.reasoning') {
          buffer.addReasoning(data.content || '')
        }
        if (event === 'consult.delta') {
          buffer.addContent(data.content || '')
        }
        if (event === 'consult.citations') {
          updateMessage(conversationId, assistantId, { citations: data.citations || [], citationSummary: data.summary, citationNotice: data.notice || '' })
        }
        if (event === 'error') {
          updateMessage(conversationId, assistantId, { failed: true, status: '', error: data.message || '咨询未完成，请稍后重试。' })
        }
      })
    } catch (error) {
      updateMessage(conversationId, assistantId, { failed: true, status: '', error: error.message || '咨询未完成，请稍后重试。' })
    } finally {
      // ⚠️ 顺序与"必须执行"都很关键：
      // 1) 记录缓冲里的尾部正文——必须在 flush 之前取（flush 会清空缓冲）；
      // 2) flush 缓冲，补写最后一块思考/正文（否则"回答少了一截"）；
      // 3) 用同一份文本同步写 Markdown 快照，避免回读 state 时的异步竞态；
      // 4) 最后清掉快照——此后渲染直接读 message.content，少一层 state。
      const tailContent = buffer.contentText
      buffer.flush()
      markdownThrottleRef.current?.finalize(assistantId, tailContent)
      setStreamedMarkdown((prev) => {
        if (!(assistantId in prev)) return prev
        const next = { ...prev }
        delete next[assistantId]
        return next
      })
      inFlightRef.current.delete(conversationId)
      patchRequest(conversationId, { loading: false })
      // 一次性命名：只对首轮触发，且不 await——标题不该拖住"作答完成"这个状态
      if (isFirstTurn) refineTitle(conversationId, titleSource)
    }
  }

  const startConversation = () => {
    const next = createConversation()
    setConversations((items) => [next, ...items])
    setActiveId(next.id)
    setQuestion('')
    setFiles([])
  }

  const uploadFiles = (incoming) => {
    // ⚠️ 必须**追加**而不是替换：用户常常分几次选文件（先选合同，再选员工手册），
    // 旧实现 setFiles(本次选择) 会把上一次的整个丢掉，表现出来就是"只能上传一份"。
    const { files: merged, unsupported, overflow } = mergeSelectedFiles(files, incoming)
    setFiles(merged)
    patchRequest(activeConversation?.id, { error: describeRejection({ unsupported, overflow }) })
  }
  const removeFile = (name) => setFiles((items) => items.filter((item) => item.name !== name))
  const deleteConversation = (event, conversationId) => {
    event.stopPropagation()
    if (inFlightRef.current.has(conversationId)) return
    // 通知服务端释放该会话留存的上传材料（失败不影响本地删除）
    fetch('/api/labor-consult/forget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId })
    }).catch(() => {})
    setConversations((items) => {
      const remaining = items.filter((item) => item.id !== conversationId)
      return remaining.length ? remaining : [createConversation()]
    })
    setRequests((items) => { const next = { ...items }; delete next[conversationId]; return next })
  }

  return (
    <main className={`contract-chat labor-consult ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${panelOpen ? '' : 'panel-collapsed'}`}>
      <aside className="chat-sidebar">
        <label className="sidebar-search">
          <History size={17} />
          <input ref={searchRef} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索历史咨询" />
        </label>
        <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>法飞飞</strong></div>
        <button type="button" className="sidebar-action" onClick={startConversation}><PenLine size={20} />新咨询</button>
        <p className="history-label">历史咨询</p>
        <nav className="history-list">
          {matchingConversations.map((conversation) => {
            const pending = Boolean(requests[conversation.id]?.loading)
            return (
              <button
                type="button"
                key={conversation.id}
                className={`${conversation.id === activeConversation?.id ? 'selected' : ''}${pending ? ' thread-running' : ''}`}
                onClick={() => { setActiveId(conversation.id); setQuestion('') }}
              >
                <span className="history-thread-icon">
                  {pending ? <Loader2 size={16} className="spinner" /> : <MessageCircle size={16} />}
                </span>
                <span className="history-thread-main">
                  <span className="history-thread-title">{conversation.title}</span>
                  <small className="history-thread-time">{formatRelativeTime(conversation.updatedAt, now)}</small>
                </span>
                <i className="history-delete" title="删除咨询" onClick={(event) => deleteConversation(event, conversation.id)}><Trash2 size={14} /></i>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-footer-wrap">
          {balanceOpen && (
            <section className="balance-popover" role="dialog" aria-label="剩余用量">
              <header>
                <span className="footer-avatar">法</span><strong>法飞飞用工咨询助手</strong>
                <button type="button" aria-label="关闭用量面板" onClick={() => setBalanceOpen(false)}><X size={16} /></button>
              </header>
              <div className="balance-title">
                <CircleDollarSign size={19} /><strong>剩余用量</strong>
                <button type="button" className="balance-refresh" onClick={loadBalance} disabled={balanceLoading} title="刷新用量">
                  <RefreshCw size={16} className={balanceLoading ? 'spinner' : ''} />
                </button>
              </div>
              {balanceLoading && !balanceData && <p className="balance-state"><Loader2 size={15} className="spinner" />正在查询剩余用量…</p>}
              {balanceError && <p className="balance-error">{balanceError}</p>}
              {!balanceLoading && !balanceError && balanceData && !cnyBalance && <p className="balance-state">暂未返回人民币用量。</p>}
              {!balanceError && cnyBalance && (
                <section className="balance-summary">
                  <div className="balance-summary-head"><span>当前剩余用量</span></div>
                  <div className="balance-list">
                    <div className="balance-item">
                      <div><span>人民币</span><b>¥ {cnyBalance.total}</b></div>
                      <p>充值用量 ¥ {cnyBalance.toppedUp} · 赠送用量 ¥ {cnyBalance.granted}</p>
                    </div>
                  </div>
                </section>
              )}
              {balanceData && (
                <small className={balanceData.isAvailable ? 'balance-available' : 'balance-unavailable'}>
                  {balanceData.isAvailable ? '当前用量可正常使用' : '当前用量不足，暂不可使用'}
                </small>
              )}
              <a className="balance-top-up" href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">充值用量<ExternalLink size={14} /></a>
            </section>
          )}
          <button type="button" className="sidebar-footer account-trigger" onClick={toggleBalance} aria-expanded={balanceOpen}>
            <span className="footer-avatar">法</span><span>法飞飞用工咨询助手</span>
            <ChevronDown size={17} className={balanceOpen ? 'balance-chevron open' : 'balance-chevron'} />
          </button>
        </div>
      </aside>

      <section className="chat-column">
        <header className="chat-header">
          <div className="header-left">
            <button
              type="button"
              className="icon-button sidebar-toggle"
              aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <PanelLeft size={21} />
            </button>
            <Link className="icon-button" to="/" aria-label="返回首页"><ArrowLeft size={20} /></Link>
          </div>
          <div className="chat-title">
            <strong>{activeConversation?.title || '用工咨询助手'}</strong>
            <small>面向企业方的劳动法咨询 · 回答会经过服务端法条引用核实 · 不构成正式法律意见</small>
          </div>
          <div className="header-tools">
            <button
              type="button"
              className="icon-button"
              aria-label={panelOpen ? '收起证据面板' : '展开证据面板'}
              onClick={() => setPanelOpen((value) => !value)}
            >
              {panelOpen ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
            </button>
          </div>
        </header>

        <div className="conversation">
          <div className="conversation-inner">
            {!activeConversation?.messages?.length && (
              <div className="assistant-turn welcome-turn">
                <div>
                  <p>你好，我是法飞飞用工咨询助手。请描述你的用工场景或争议情况，也可以直接上传劳动合同、员工手册、规章制度、仲裁裁决书、考勤或工资记录等材料，我会先给出结论，再给案件分析与可执行的应对建议。</p>
                  <p className="labor-welcome-note">
                    所有法条引用都会在服务端做一次“是否存在、是否现行有效”的核实；未收录的法规会明确标注，不会凭记忆引用。
                    上传材料后，我会逐字引用材料原文并标明来源，材料中未写明的事实不会当成已存在。
                  </p>
                </div>
              </div>
            )}

            {activeConversation?.messages?.map((message) => message.type === 'user'
              ? (
                <div className="user-turn" key={message.id}>
                  <p>{message.content}</p>
                  {message.files?.map((file) => (
                    <div className="attached-file" key={`${message.id}-${file.name}`}>
                      <FileText size={18} /><span>{file.name}</span><small>{formatSize(file.size)}</small>
                    </div>
                  ))}
                </div>
              )
              : (
                <div className="assistant-turn result-turn" key={message.id}>
                  <div>
                    {message.status && <p className="assistant-status"><Loader2 size={15} className="spinner" />{message.status}</p>}
                    {message.warnings?.map((warning) => (
                      <p className="labor-warning" key={warning}><AlertTriangle size={14} />{warning}</p>
                    ))}
                    {message.reasoning && (
                      <ReasoningPanel
                        text={message.reasoning}
                        live={!message.content && !message.failed}
                        open={Boolean(message.reasoningOpen)}
                        onToggle={() => updateMessage(activeConversation.id, message.id, (current) => ({ reasoningOpen: !current.reasoningOpen }))}
                      />
                    )}
                    {message.content && (
                      // 流式期间用节流后的快照（更新频率受控），流结束后快照被清除，
                      // 自动回到 message.content 的那一份完整文本。
                      <AnswerBody content={streamedMarkdown[message.id] || message.content} />
                    )}
                    {message.citations?.length > 0 && (
                      <section className="labor-citations">
                        <header>
                          <ShieldCheck size={16} />
                          <strong>法规引用核实</strong>
                          <span className={message.citationSummary?.hasProblems ? 'has-problems' : 'all-ok'}>
                            {message.citationSummary?.ok}/{message.citationSummary?.total} 处通过
                          </span>
                        </header>
                        <ul>{message.citations.map((citation, index) => <CitationBadge citation={citation} key={`${citation.raw}-${index}`} />)}</ul>
                      </section>
                    )}
                    {message.failed && <small className="message-failed">{message.error || '咨询未完成，请稍后重试。'}</small>}
                  </div>
                </div>
              ))}

            {activeRequest.error && <p className="chat-error">{activeRequest.error}</p>}

            {!activeConversation?.messages?.length && (
              <div className="starter-prompts">
                {starterPrompts.map((prompt) => (
                  <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}<span>→</span></button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                  event.preventDefault()
                  ask()
                }
              }}
              placeholder="描述你的用工场景或争议情况，也可上传劳动合同、员工手册、裁决书等材料…"
              disabled={isAsking}
            />
            {files.length > 0 && (
              <div className="pending-files">
                {files.map((file) => (
                  <span key={file.name} title={`${file.name} · ${formatSize(file.size)}`}>
                    <FileText size={14} />{file.name}
                    <button type="button" aria-label={`移除 ${file.name}`} onClick={() => removeFile(file.name)}><X size={13} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="composer-bottom">
              <div className="composer-tools labor-modes">
                <button
                  type="button"
                  className="labor-upload-button"
                  title="上传材料（劳动合同、员工手册、裁决书、考勤或工资记录等）"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isAsking}
                >
                  <Plus size={18} />
                </button>
                {modeOptions.map((item) => (
                  <button
                    type="button"
                    key={item.key}
                    title={item.hint}
                    className={mode === item.key ? 'active' : ''}
                    onClick={() => setMode(item.key)}
                    disabled={isAsking}
                  >
                    <Sparkles size={14} />{item.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="voice-send"
                aria-label="发送"
                onClick={ask}
                disabled={(!question.trim() && !files.length) || isAsking}
              >
                {isAsking ? <Loader2 size={20} className="spinner" /> : <Send size={19} />}
              </button>
            </div>
            <input
              ref={fileInputRef}
              hidden
              type="file"
              multiple
              accept={ACCEPTED_EXTENSIONS}
              onChange={(event) => { uploadFiles([...event.target.files]); event.target.value = '' }}
            />
          </div>
          <p className="labor-disclaimer">
            <BookOpen size={13} />
            本回答为辅助分析，不构成正式法律意见；重大金额、群体性争议、工伤认定与行政处罚事项请由专业人士复核。
          </p>
        </div>
      </section>

      {panelOpen && (
        <EvidencePanel
          payload={latestEvidence}
          baseline={baseline}
          status={status}
          metaLoading={metaLoading}
          metaError={metaError}
          onRetry={() => loadMeta()}
        />
      )}
    </main>
  )
}

export default LaborConsultPage
