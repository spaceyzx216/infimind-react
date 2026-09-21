import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowLeft,
  Brain,
  ChevronDown,
  ChevronLeft,
  CircleDollarSign,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  History,
  Loader2,
  Menu,
  MessageCircle,
  PanelLeft,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import './ContractRewritePage.css'
import { ACCEPTED_EXTENSIONS, mergeSelectedFiles, describeRejection } from '../utils/file-selection.js'
import { getThreadRequestState, isThreadRequestRunning, patchThreadRequestState } from '../utils/thread-request-state.js'

const REVIEW_ENDPOINT = '/api/contract-rewrite'
const CHAT_ENDPOINT = '/api/contract-chat'
const BALANCE_ENDPOINT = '/api/account/balance'
const THREAD_STORAGE_KEY = 'fafee-contract-threads-v1'
const TASK_STORAGE_KEY = 'fafee-contract-tasks-v1'
const CLIENT_STORAGE_KEY = 'fafee-contract-client-id-v1'

const inline = (text) => text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : <React.Fragment key={index}>{part}</React.Fragment>)
const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const stripLegacyFileMarkers = (text = '') => text
  .split('\n')
  .filter((line) => !/^===\s*文件\s*[：:]/.test(line.trim()))
  .join('\n')
const createThread = (title = '新对话', taskId = null) => ({ id: createId('thread'), title, taskId, createdAt: Date.now(), updatedAt: Date.now(), messages: [] })
const asText = (value, fallback = '') => typeof value === 'string' ? value : fallback
const asTimestamp = (value, fallback = Date.now()) => Number.isFinite(Number(value)) ? Number(value) : fallback
const normalizeStoredMessage = (message) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const files = Array.isArray(message.files)
    ? message.files
      .filter((file) => file && typeof file === 'object' && !Array.isArray(file))
      .map((file) => ({
        ...file,
        name: asText(file.name, '合同文件'),
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0
      }))
    : []
  return {
    ...message,
    id: asText(message.id, createId('message')),
    role: message.role === 'user' ? 'user' : 'assistant',
    content: asText(message.content),
    status: asText(message.status),
    originalText: asText(message.originalText),
    contractText: asText(message.contractText),
    rewrite: asText(message.rewrite),
    files,
    revisions: Array.isArray(message.revisions)
      ? message.revisions.filter((rev) => rev && typeof rev === 'object' && !Array.isArray(rev))
      : [],
    rewriteStats: message.rewriteStats && typeof message.rewriteStats === 'object' ? message.rewriteStats : null,
    reviewRounds: Array.isArray(message.reviewRounds)
      ? message.reviewRounds.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).map((item) => ({
          round: Number.isFinite(Number(item.round)) ? Number(item.round) : 0,
          newCount: Number.isFinite(Number(item.newCount)) ? Number(item.newCount) : 0,
          newFindings: Array.isArray(item.newFindings) ? item.newFindings.filter((f) => f && typeof f === 'object') : []
        }))
      : [],
    createdAt: asTimestamp(message.createdAt)
  }
}
const normalizeStoredThreads = (value) => {
  if (!Array.isArray(value)) return []
  return value.flatMap((thread) => {
    if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return []
    const messages = Array.isArray(thread.messages)
      ? thread.messages.map(normalizeStoredMessage).filter(Boolean)
      : []
    return [{
      ...thread,
      id: asText(thread.id, createId('thread')),
      title: asText(thread.title, '历史对话'),
      taskId: typeof thread.taskId === 'string' ? thread.taskId : null,
      createdAt: asTimestamp(thread.createdAt),
      updatedAt: asTimestamp(thread.updatedAt, asTimestamp(thread.createdAt)),
      messages
    }]
  })
}
const normalizeStoredTasks = (value) => {
  if (!Array.isArray(value)) return []
  return value.flatMap((task) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return []
    const threadId = asText(task.threadId)
    if (!threadId) return []
    return [{
      ...task,
      id: asText(task.id, createId('task')),
      title: asText(task.title, '历史审查任务'),
      prompt: asText(task.prompt),
      mode: task.mode === 'fast' ? 'fast' : 'thinking',
      threadId,
      createdAt: asTimestamp(task.createdAt)
    }]
  })
}
const readStorage = (key, fallback, normalize) => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '')
    return normalize(value)
  } catch { return fallback }
}
const writeStorage = (key, value) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* 浏览器禁用或存储空间不足时不阻断页面 */ }
}
const readOrCreateClientId = () => {
  try {
    const saved = window.localStorage.getItem(CLIENT_STORAGE_KEY)
    if (saved && /^[a-zA-Z0-9_-]{12,128}$/.test(saved)) return saved
    const next = window.crypto?.randomUUID?.() || createId('client')
    window.localStorage.setItem(CLIENT_STORAGE_KEY, next)
    return next
  } catch {
    return createId('client')
  }
}
const displayTitle = (content, fallback = '新对话') => content.trim().replace(/\s+/g, ' ').slice(0, 22) || fallback

const LEVEL_META = {
  高: { key: 'high', label: '高风险', cls: 'level-high' },
  中: { key: 'mid', label: '中风险', cls: 'level-mid' },
  低: { key: 'low', label: '低风险', cls: 'level-low' }
}
const levelMeta = (level) => LEVEL_META[level] || LEVEL_META.中

const ACTION_META = {
  modify: { label: '修订', cls: 'action-modify' },
  add: { label: '新增', cls: 'action-add' },
  delete: { label: '删除', cls: 'action-delete' }
}
const actionMeta = (action) => ACTION_META[action] || ACTION_META.modify

const buildDisplayRevisions = (revisions = []) => {
  let markerNumber = 0
  return revisions.flatMap((revision) => {
    const edits = Array.isArray(revision.localizedEdits) ? revision.localizedEdits : []
    if (revision.action === 'add' || !edits.length) return [{ ...revision, isLocalized: false, markerNumber: null }]
    return edits.map((edit, index) => {
      markerNumber += 1
      return {
        ...revision,
        findingId: edit.editId || `${revision.findingId}-local-${index + 1}`,
        parentFindingId: revision.findingId,
        memberFindingIds: Array.isArray(edit.memberFindingIds) ? edit.memberFindingIds : revision.memberFindingIds,
        isLocalized: true,
        markerNumber,
        operation: edit.operation || 'replace',
        lineStart: Number.isInteger(edit.lineStart) ? edit.lineStart : revision.lineStart,
        lineEnd: Number.isInteger(edit.lineEnd) ? edit.lineEnd : revision.lineEnd,
        originalText: edit.targetQuote || revision.quoteText || revision.originalText,
        quoteText: edit.targetQuote || revision.quoteText,
        quoteSpans: Array.isArray(edit.quoteSpans) ? edit.quoteSpans : [],
        quoteStatus: Array.isArray(edit.quoteSpans) && edit.quoteSpans.length ? 'exact' : 'none',
        rewrittenText: edit.replacementText || '',
        riskNote: edit.riskNote || revision.riskNote,
        fullRewrittenText: revision.rewrittenText || '',
        localizationStatus: edit.localizationStatus || ''
      }
    })
  })
}

// 修订稿文档：正文仅高亮真正发生变化的局部片段，并在对应行下方显示紧凑编号修订卡。
// 原句、行号和 quoteSpans 均来自服务端校验，完整条款改写默认折叠，降低长文视觉负担。
// spans 基于原始行偏移，渲染前先扣除 trim 掉的前导空白，避免错位。
function MarkedLineText({ raw, spans }) {
  const trimOffset = raw.length - raw.trimStart().length
  const text = raw.trim()
  const merged = []
  spans.slice().sort((a, b) => a.start - b.start).forEach((span) => {
    const start = Math.max(0, span.start - trimOffset)
    const end = Math.max(start, Math.min(span.end - trimOffset, text.length))
    if (end <= start) return
    const last = merged[merged.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      if (span.markerNumber && !last.markerNumbers.includes(span.markerNumber)) last.markerNumbers.push(span.markerNumber)
    } else {
      merged.push({ start, end, markerNumbers: span.markerNumber ? [span.markerNumber] : [] })
    }
  })
  if (!merged.length) return inline(text)
  const parts = []
  let cursor = 0
  merged.forEach((span, index) => {
    if (span.start > cursor) parts.push(<React.Fragment key={`t-${index}`}>{text.slice(cursor, span.start)}</React.Fragment>)
    parts.push(<span className="quote-mark" key={`m-${index}`}>{inline(text.slice(span.start, span.end))}{span.markerNumbers.length ? <sup className="quote-marker">{span.markerNumbers.join('·')}</sup> : null}</span>)
    cursor = span.end
  })
  if (cursor < text.length) parts.push(<React.Fragment key="tail">{text.slice(cursor)}</React.Fragment>)
  return parts
}

function RevisionDocument({ contractText, revisions }) {
  const lines = useMemo(() => stripLegacyFileMarkers(contractText || '').split('\n'), [contractText])
  const displayRevisions = useMemo(() => buildDisplayRevisions(Array.isArray(revisions) ? revisions : []), [revisions])
  const { byLine, quoteMarks } = useMemo(() => {
    const map = new Map()
    const marks = new Map()
    displayRevisions.forEach((rev) => {
      const start = Number.isInteger(rev.lineStart) ? rev.lineStart : -1
      const end = Number.isInteger(rev.lineEnd) ? rev.lineEnd : start
      const isAdd = rev.action === 'add'
      // add 修订块挂在服务端解析出的插入锚点行（insertAfterLine）之后；锚点缺失时退回 finding 所在行。
      const attachLine = isAdd && Number.isInteger(rev.insertAfterLine) && rev.insertAfterLine >= 0 && rev.insertAfterLine < lines.length
        ? rev.insertAfterLine
        : end
      if (attachLine < 0 || attachLine >= lines.length) return
      if (!map.has(attachLine)) map.set(attachLine, [])
      map.get(attachLine).push(rev)
      // 只要存在服务端验证过的 spans 就逐片段标记；归并组不再因 quoteStatus=none 而回退整段。
      if (!isAdd && Array.isArray(rev.quoteSpans) && rev.quoteSpans.length) {
        rev.quoteSpans.forEach((span) => {
          if (!span || !Number.isInteger(span.line) || span.line < 0 || span.line >= lines.length) return
          if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) return
          if (!marks.has(span.line)) marks.set(span.line, [])
          marks.get(span.line).push({ start: span.start, end: span.end, markerNumber: rev.markerNumber })
        })
      }
    })
    return { byLine: map, quoteMarks: marks }
  }, [displayRevisions, lines])
  return (
    <article className="contract-document revision-document">
      <section className="contract-body">
        {lines.map((raw, i) => {
          const line = raw.trim()
          const revs = byLine.get(i) || []
          const spans = quoteMarks.get(i)
          if (!line) return revs.length ? <div className="revision-stack" key={`gap-${i}`}>{revs.map((rev) => <SandwichBlock key={rev.findingId} revision={rev} />)}</div> : null
          const heading = line.match(/^(#{1,4})\s+(.+)$/)
          if (heading) {
            const Tag = `h${Math.min(heading[1].length + 1, 4)}`
            return <React.Fragment key={`l-${i}`}>
              <Tag className="clause-heading">{heading[2]}</Tag>
              {revs.length > 0 && <div className="revision-stack">{revs.map((rev) => <SandwichBlock key={rev.findingId} revision={rev} />)}</div>}
            </React.Fragment>
          }
          return <React.Fragment key={`l-${i}`}>
            <p className="clause-text">{spans ? <MarkedLineText raw={raw} spans={spans} /> : inline(line)}</p>
            {revs.length > 0 && <div className="revision-stack">{revs.map((rev) => <SandwichBlock key={rev.findingId} revision={rev} />)}</div>}
          </React.Fragment>
        })}
      </section>
    </article>
  )
}

function SandwichBlock({ revision: rev }) {
  const meta = levelMeta(rev.level)
  const act = actionMeta(rev.action)
  if (rev.isLocalized) {
    const operationLabel = rev.operation === 'delete' ? '删除此处' : rev.operation === 'insert-after' ? '在此后补充' : rev.operation === 'notice' ? '提示' : '改为'
    const suggestion = rev.operation === 'delete'
      ? '删除该问题片段'
      : rev.operation === 'notice'
        ? (rev.riskNote || '请结合实际业务确认并补全该项')
      : (rev.rewrittenText || '请结合批注对该片段作局部调整')
    const showFullRevision = rev.operation !== 'notice' && rev.fullRewrittenText && rev.fullRewrittenText !== rev.rewrittenText
    return (
      <div className={`local-edit-card ${meta.cls}`}>
        <span className="local-edit-badge">{rev.markerNumber}</span>
        <div className="local-edit-content">
          <div className="local-edit-suggestion"><span>{operationLabel}</span><strong>{suggestion}</strong></div>
          <details className="local-edit-details">
            <summary>查看批注{showFullRevision ? '与完整修订条款' : ''}</summary>
            <p><b>原片段</b>{rev.originalText}</p>
            {rev.riskNote && <p><b>说明</b>{rev.riskNote}</p>}
            {showFullRevision && <p className="full-revision"><b>完整条款</b>{rev.fullRewrittenText}</p>}
          </details>
        </div>
      </div>
    )
  }
  const preview = rev.action === 'delete'
    ? '建议删除该条款'
    : (rev.rewrittenText || '请参考批注手动修订')
  return (
    <div className={`compact-revision-card ${meta.cls} ${act.cls}`}>
      <div className="compact-revision-head"><span>{act.label}</span><strong>{rev.title || '条款调整建议'}</strong></div>
      {rev.action === 'add' && rev.anchorText && <p className="compact-anchor">插入于“{rev.anchorText}”之后</p>}
      <p className="compact-preview">{preview.length > 180 ? `${preview.slice(0, 180)}…` : preview}</p>
      <details>
        <summary>查看完整修订与批注</summary>
        {preview.length > 180 && <p><b>完整修订</b>{preview}</p>}
        {rev.riskNote && <p><b>批注</b>{rev.riskNote}</p>}
      </details>
    </div>
  )
}

// 审查轮次进度面板：在对话气泡中实时展示「第X轮发现/新增了哪些问题」。
// 每轮一个折叠条目，展开后罗列该轮新增的风险点（等级 + 标题 + 位置 + 风险摘要）。
function ReviewRoundsPanel({ rounds, thinking }) {
  if (!rounds.length && !thinking) return null
  const totalFindings = rounds.reduce((sum, r) => sum + (r.newCount || 0), 0)
  return (
    <div className="review-rounds-panel">
      <div className="rounds-panel-head">
        <span className="rounds-panel-title">三轮审查进度</span>
        <span className="rounds-panel-summary">{rounds.length}/3 轮完成{totalFindings > 0 ? ` · 累计发现 ${totalFindings} 条问题` : ''}</span>
      </div>
      <div className="rounds-panel-body">
        {[1, 2, 3].map((roundNum) => {
          const round = rounds.find((r) => r.round === roundNum)
          const isThinking = thinking && !round && roundNum === (rounds.length + 1)
          const isPending = !round && !isThinking
          return (
            <div key={roundNum} className={`round-item ${round ? 'round-done' : ''} ${isThinking ? 'round-thinking' : ''} ${isPending ? 'round-pending' : ''}`}>
              <div className="round-item-head">
                <span className="round-badge">{roundNum}</span>
                <span className="round-label">{roundNum === 1 ? '首轮审查' : roundNum === 2 ? '二轮复审' : '三轮复审'}</span>
                <span className="round-status">
                  {round ? (round.newCount > 0 ? `新增 ${round.newCount} 条` : '未发现新问题') : isThinking ? <Loader2 size={13} className="spinner" /> : '待开始'}
                </span>
              </div>
              {round && round.newFindings.length > 0 && (
                <ul className="round-findings">
                  {round.newFindings.map((finding, idx) => {
                    const meta = levelMeta(finding.level)
                    return (
                      <li key={idx} className={`round-finding ${meta.cls}`}>
                        <span className={`finding-level-tag ${meta.cls}`}>{meta.label}</span>
                        <span className="finding-title">{finding.title}</span>
                        {finding.location && <span className="finding-location">{finding.location}</span>}
                        {finding.risk && <span className="finding-risk">{finding.risk}</span>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ContractRewritePage() {
  const inputRef = useRef(null)
  const searchRef = useRef(null)
  const threadEndRef = useRef(null)
  const conversationRef = useRef(null)
  const activeThreadIdRef = useRef('')
  const inFlightThreadsRef = useRef(new Set())
  // 用户是否贴近底部：用于流式输出时决定是否自动跟随滚动
  const stickToBottomRef = useRef(true)
  const [threads, setThreads] = useState(() => {
    const saved = readStorage(THREAD_STORAGE_KEY, [], normalizeStoredThreads)
    return saved.length ? saved : [createThread('商业合同审查与批注')]
  })
  const [tasks, setTasks] = useState(() => readStorage(TASK_STORAGE_KEY, [], normalizeStoredTasks))
  const [activeThreadId, setActiveThreadId] = useState('')
  const [files, setFiles] = useState([])
  const [instruction, setInstruction] = useState('')
  const [mode, setMode] = useState('thinking')
  const [clientId] = useState(readOrCreateClientId)
  const [threadRequests, setThreadRequests] = useState({})
  const [documentOpen, setDocumentOpen] = useState(false)
  const [documentMessageId, setDocumentMessageId] = useState('')
  const [historyQuery, setHistoryQuery] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const [balanceOpen, setBalanceOpen] = useState(false)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceError, setBalanceError] = useState('')
  const [balanceData, setBalanceData] = useState(null)

  const activeThread = threads.find((thread) => thread.id === activeThreadId) || threads[0]
  const activeMessages = activeThread?.messages || []
  const activeRequest = getThreadRequestState(threadRequests, activeThread?.id)
  const loading = activeRequest.loading
  const stage = activeRequest.stage
  const error = activeRequest.error
  const selectedDocument = activeMessages.find((message) => message.id === documentMessageId)
  // 修订稿文档数据：合同原文 + 结构化修订块（三明治视图）。两者均来自后端 rewrite.result 事件。
  const documentContractText = selectedDocument?.contractText || selectedDocument?.originalText || ''
  const documentRevisions = selectedDocument?.revisions || []
  const cnyBalance = balanceData?.balances?.find((item) => item.currency === 'CNY') || null
  const matchingThreads = useMemo(() => [...threads]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .filter((thread) => thread.title.toLowerCase().includes(historyQuery.trim().toLowerCase())), [historyQuery, threads])

  useEffect(() => {
    if (threads.length && !threads.some((thread) => thread.id === activeThreadId)) setActiveThreadId(threads[0].id)
  }, [activeThreadId, threads])

  useEffect(() => { activeThreadIdRef.current = activeThread?.id || '' }, [activeThread?.id])

  useEffect(() => { writeStorage(THREAD_STORAGE_KEY, threads) }, [threads])
  useEffect(() => { writeStorage(TASK_STORAGE_KEY, tasks) }, [tasks])

  // 仅在用户已贴近底部时跟随滚动；流式增量更新时用 instant 避免动画抢夺滚动控制
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const node = conversationRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [activeMessages, loading])

  // 监听对话区滚动：用户主动上滑时停止跟随，回到底部附近时恢复跟随
  useEffect(() => {
    const node = conversationRef.current
    if (!node) return
    const onScroll = () => {
      const threshold = 80
      stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < threshold
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [documentOpen])
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const updateThread = (threadId, updater) => setThreads((items) => items.map((thread) => thread.id === threadId ? { ...updater(thread), updatedAt: Date.now() } : thread))
  const appendMessage = (threadId, message) => updateThread(threadId, (thread) => ({ ...thread, title: thread.messages.length === 0 && message.role === 'user' ? displayTitle(message.content, thread.title) : thread.title, messages: [...thread.messages, message] }))
  const updateMessage = (threadId, messageId, patch) => updateThread(threadId, (thread) => ({ ...thread, messages: thread.messages.map((message) => message.id === messageId ? { ...message, ...patch } : message) }))
  const updateThreadRequest = (threadId, patch) => setThreadRequests((items) => patchThreadRequestState(items, threadId, patch))

  const resetComposer = () => { setFiles([]); setInstruction('') }
  const createConversation = (title = '新对话', taskId = null) => {
    const next = createThread(title, taskId)
    setThreads((items) => [next, ...items])
    setActiveThreadId(next.id)
    setDocumentOpen(false)
    resetComposer()
    return next
  }
  const deleteConversation = (event, threadId) => {
    event.stopPropagation()
    if (inFlightThreadsRef.current.has(threadId)) return
    setThreads((items) => {
      const remaining = items.filter((thread) => thread.id !== threadId)
      return remaining.length ? remaining : [createThread('新对话')]
    })
    setTasks((items) => items.filter((task) => task.threadId !== threadId))
    setThreadRequests((items) => {
      if (!Object.prototype.hasOwnProperty.call(items, threadId)) return items
      const next = { ...items }
      delete next[threadId]
      return next
    })
    setDocumentOpen(false)
  }
  const selectConversation = (threadId) => {
    setActiveThreadId(threadId)
    setDocumentOpen(false)
    resetComposer()
    stickToBottomRef.current = true
  }
  const loadBalance = async () => {
    setBalanceLoading(true)
    setBalanceError('')
    try {
      const response = await fetch(BALANCE_ENDPOINT, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || '暂时无法读取剩余用量。')
      setBalanceData(payload)
    } catch (requestError) {
      setBalanceError(requestError.message || '暂时无法读取剩余用量。')
    } finally {
      setBalanceLoading(false)
    }
  }
  const toggleBalancePanel = () => {
    const nextOpen = !balanceOpen
    setBalanceOpen(nextOpen)
    if (nextOpen) loadBalance()
  }
  const uploadFiles = (incoming) => {
    // ⚠️ 追加而不是替换：旧实现 setFiles(本次选择) 会丢掉上一次的选择，
    // 用户分两次选文件时表现出来就是"只能上传一份"。
    const { files: merged, unsupported, overflow } = mergeSelectedFiles(files, incoming)
    if (activeThread?.id) updateThreadRequest(activeThread.id, { error: describeRejection({ unsupported, overflow }) })
    setFiles(merged)
  }

  const readSSE = async (response, onEvent) => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const packets = buffer.split('\n\n')
      buffer = packets.pop() || ''
      for (const packet of packets) {
        const event = packet.match(/^event:\s*(.+)$/m)?.[1]?.trim()
        const dataText = [...packet.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]).join('\n')
        if (!event || !dataText) continue
        let data
        try { data = JSON.parse(dataText) } catch { data = { content: dataText } }
        onEvent(event, data)
      }
    }
  }

  const sendMessage = async () => {
    if ((!files.length && !instruction.trim()) || !activeThread) return
    const threadId = activeThread.id
    if (inFlightThreadsRef.current.has(threadId)) return
    inFlightThreadsRef.current.add(threadId)
    const requestMode = mode
    const content = instruction.trim() || '请根据合同类型匹配知识库中的优秀模板和已批注风险案例，完成合规审查并生成带修改说明的合同稿。'
    const uploadedFiles = files.map((file) => ({ name: file.name, size: file.size }))
    const userMessage = { id: createId('message'), role: 'user', content, files: uploadedFiles, createdAt: Date.now() }
    const assistantId = createId('message')
    appendMessage(threadId, userMessage)
    appendMessage(threadId, { id: assistantId, role: 'assistant', content: '', mode: requestMode, createdAt: Date.now(), status: files.length ? '正在读取合同文件…' : '正在思考…' })
    setInstruction('')
    setFiles([])
    updateThreadRequest(threadId, { loading: true, error: '', stage: files.length ? 'parsing' : 'chat', mode: requestMode })
    let analysis = ''
    let review = ''
    let originalText = ''
    let rewriteRevisions = []
    let rewriteStats = null
    let reviewRounds = []
    try {
      if (uploadedFiles.length) {
        const form = new FormData()
        form.append('message', content)
        form.append('mode', requestMode)
        form.append('threadId', threadId)
        files.forEach((file) => form.append('files', file))
        const response = await fetch(REVIEW_ENDPOINT, { method: 'POST', headers: { Accept: 'text/event-stream', 'X-Client-ID': clientId }, body: form })
        if (!response.ok || !response.body) throw new Error(await response.text() || '审查服务暂不可用。')
        await readSSE(response, (event, data) => {
          if (event === 'stage.start') {
            updateThreadRequest(threadId, { stage: data.stage || '' })
            updateMessage(threadId, assistantId, { status: data.label || '正在处理…' })
          }
          if (event === 'stage.progress') {
            updateMessage(threadId, assistantId, { status: data.message || '正在处理…' })
          }
          if (event === 'review.round') {
            // 三轮审核进度：start 显示当前轮次状态，end 追加本轮新增问题清单
            updateThreadRequest(threadId, { stage: 'review' })
            if (data.phase === 'end') {
              // 本轮结束：记录新增问题快照，供对话区实时罗列
              const snapshot = {
                round: Number(data.round) || 0,
                newCount: Number(data.newCount) || 0,
                newFindings: Array.isArray(data.newFindings) ? data.newFindings : []
              }
              reviewRounds = [...reviewRounds.filter((r) => r.round !== snapshot.round), snapshot]
              updateMessage(threadId, assistantId, { reviewRounds, status: data.message || `第 ${data.round}/${data.total} 轮审查完成` })
            } else {
              updateMessage(threadId, assistantId, { status: data.message || `第 ${data.round}/${data.total} 轮审查中…` })
            }
          }
          if (event === 'analysis.delta') { analysis += data.content || ''; updateMessage(threadId, assistantId, { content: analysis, analysis, status: '正在分析合同结构…' }) }
          if (event === 'review.delta') {
            review += data.content || ''
            // 拼接展示：分析报告 + 审查报告，而不是用审查覆盖分析
            const combined = analysis ? `${analysis}\n\n---\n\n${review}` : review
            updateMessage(threadId, assistantId, { content: combined, analysis, review, reviewRounds, status: '正在审查风险条款…' })
          }
          if (event === 'review.original') {
            // 兼容事件：保留原合同文本，供修订稿文档渲染原文
            originalText = data.text || ''
            const reviewSession = data.reviewSession || {}
            updateMessage(threadId, assistantId, {
              originalText,
              reviewSessionId: reviewSession.id || '',
              reviewStats: reviewSession.stats || null,
              analysis,
              review
            })
          }
          if (event === 'rewrite.result') {
            // 结构化修订结果：合同原文 + 修订块数组。前端据此渲染「行内三明治视图」。
            updateThreadRequest(threadId, { stage: 'rewrite' })
            rewriteRevisions = Array.isArray(data.revisions) ? data.revisions : []
            rewriteStats = data.stats || null
            originalText = data.contractText || originalText
            updateMessage(threadId, assistantId, {
              contractText: data.contractText || originalText,
              revisions: rewriteRevisions,
              rewriteStats,
              originalText: data.contractText || originalText,
              analysis,
              review,
              status: '正在生成修订稿…'
            })
          }
          if (event === 'error') throw new Error(data.message || '审查未完成，请稍后重试。')
        })
        const finalContent = analysis ? (review ? `${analysis}\n\n---\n\n${review}` : analysis) : (review || '合同审查已完成。')
        updateMessage(threadId, assistantId, {
          content: finalContent,
          analysis,
          review,
          reviewRounds,
          originalText,
          contractText: originalText,
          revisions: rewriteRevisions,
          rewriteStats,
          phase: 'rewrite',
          status: '',
          completed: true
        })
        // 审核改写一体完成后，自动展开修订稿文档供用户查看
        if (rewriteRevisions.length || originalText) {
          if (activeThreadIdRef.current === threadId) {
            setDocumentMessageId(assistantId)
            setDocumentOpen(true)
          }
        }
      } else {
        const history = activeMessages.slice(-10).map((message) => ({ role: message.role, content: message.content })).filter((message) => message.content)
        const response = await fetch(CHAT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Client-ID': clientId }, body: JSON.stringify({ message: content, mode: requestMode, threadId, history }) })
        if (!response.ok || !response.body) throw new Error(await response.text() || '对话服务暂不可用。')
        let answer = ''
        await readSSE(response, (event, data) => {
          if (event === 'chat.start') updateMessage(threadId, assistantId, { model: data.model, status: requestMode === 'thinking' ? '正在深度思考…' : '正在快速回复…' })
          if (event === 'chat.delta') { answer += data.content || ''; updateMessage(threadId, assistantId, { content: answer, status: '' }) }
          if (event === 'error') throw new Error(data.message || '对话未完成，请稍后重试。')
        })
        updateMessage(threadId, assistantId, { status: '', completed: true })
      }
    } catch (requestError) {
      updateMessage(threadId, assistantId, { content: '本次处理未完成。', status: '', failed: true })
      updateThreadRequest(threadId, { error: requestError.message || '请求未完成，请稍后重试。' })
    } finally {
      inFlightThreadsRef.current.delete(threadId)
      updateThreadRequest(threadId, { loading: false, stage: '' })
    }
  }

  const createTask = (event) => {
    event.preventDefault()
    const title = taskTitle.trim() || '新审查任务'
    const thread = createConversation(title)
    const task = { id: createId('task'), title, prompt: taskPrompt.trim(), mode, threadId: thread.id, createdAt: Date.now() }
    setTasks((items) => [task, ...items])
    setInstruction(task.prompt)
    setTaskTitle('')
    setTaskPrompt('')
    setTaskModalOpen(false)
  }
  const openTask = (task) => { selectConversation(task.threadId); setInstruction(task.prompt || ''); setMode(task.mode || 'thinking') }
  const deleteTask = (event, taskId) => { event.stopPropagation(); setTasks((items) => items.filter((task) => task.id !== taskId)) }
  const openDocument = (messageId) => { setDocumentMessageId(messageId); setDocumentOpen(true) }

  // 导出 Word：沿用页面的局部编号批注，避免导出后重新退化成整段三明治卡片。
  const exportWord = () => {
    const name = activeThread?.title || '商业合同审查稿'
    const text = documentContractText || selectedDocument?.rewrite || ''
    const revisions = buildDisplayRevisions(Array.isArray(documentRevisions) ? documentRevisions : [])
    const renderInline = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // 按行号把修订块分组（与 RevisionDocument 的 byLine 逻辑一致：add 挂在 insertAfterLine 后）
    const lines = stripLegacyFileMarkers(text).split('\n')
    const revByEndLine = new Map()
    const marksByLine = new Map()
    revisions.forEach((rev) => {
      const end = Number.isInteger(rev.lineEnd) ? rev.lineEnd : -1
      const attach = rev.action === 'add' && Number.isInteger(rev.insertAfterLine) && rev.insertAfterLine >= 0 && rev.insertAfterLine < lines.length
        ? rev.insertAfterLine
        : end
      if (attach < 0 || attach >= lines.length) return
      if (!revByEndLine.has(attach)) revByEndLine.set(attach, [])
      revByEndLine.get(attach).push(rev)
      if (rev.action !== 'add' && Array.isArray(rev.quoteSpans)) {
        rev.quoteSpans.forEach((span) => {
          if (!span || !Number.isInteger(span.line) || !Number.isInteger(span.start) || !Number.isInteger(span.end)) return
          if (!marksByLine.has(span.line)) marksByLine.set(span.line, [])
          marksByLine.get(span.line).push({ ...span, markerNumber: rev.markerNumber })
        })
      }
    })
    const renderMarkedLine = (raw, lineIndex) => {
      const trimOffset = raw.length - raw.trimStart().length
      const text = raw.trim()
      const marks = (marksByLine.get(lineIndex) || []).map((span) => ({
        start: Math.max(0, span.start - trimOffset),
        end: Math.min(text.length, span.end - trimOffset),
        markerNumber: span.markerNumber
      })).filter((span) => span.end > span.start).sort((left, right) => left.start - right.start)
      if (!marks.length) return renderInline(text)
      let cursor = 0
      let html = ''
      marks.forEach((mark) => {
        if (mark.start < cursor) return
        html += renderInline(text.slice(cursor, mark.start))
        html += `<span class="mark">${renderInline(text.slice(mark.start, mark.end))}${mark.markerNumber ? `<sup>${mark.markerNumber}</sup>` : ''}</span>`
        cursor = mark.end
      })
      return html + renderInline(text.slice(cursor))
    }
    const renderRevBlock = (rev) => {
      if (rev.isLocalized) {
        const label = rev.operation === 'delete' ? '删除此处' : rev.operation === 'insert-after' ? '在此后补充' : rev.operation === 'notice' ? '提示' : '改为'
        const replacement = rev.operation === 'delete'
          ? '删除该问题片段'
          : rev.operation === 'notice'
            ? (rev.riskNote || '请结合实际业务确认并补全该项')
            : (rev.rewrittenText || '请结合批注局部调整')
        return `<div class="local-edit"><span class="badge">${rev.markerNumber}</span><div><p><b>${label}</b>${renderInline(replacement)}</p>${rev.riskNote ? `<p class="note"><b>批注</b>${renderInline(rev.riskNote)}</p>` : ''}</div></div>`
      }
      const label = rev.action === 'add' ? '新增' : rev.action === 'delete' ? '删除' : '修订'
      const anchor = rev.action === 'add' && rev.anchorText ? `<p class="anchor">插入于“${renderInline(rev.anchorText)}”之后</p>` : ''
      const body = rev.action === 'delete' ? '建议删除该条款' : renderInline(rev.rewrittenText || '请参考批注手动修订')
      return `<div class="compact-rev"><p><b>${label}</b>${body}</p>${anchor}${rev.riskNote ? `<p class="note"><b>批注</b>${renderInline(rev.riskNote)}</p>` : ''}</div>`
    }
    const htmlBody = lines.map((raw, i) => {
      const line = raw.trim()
      const revs = revByEndLine.get(i) || []
      const revHtml = revs.map(renderRevBlock).join('')
      if (!line) return revHtml
      // Markdown 前缀被剥离后，服务端基于原始行计算的字符偏移已不再适用；
      // 标题与列表项仅输出正文，避免 Word 中出现错位标记。
      if (/^#\s+/.test(line)) return `<h1>${renderInline(line.replace(/^#\s+/, ''))}</h1>${revHtml}`
      if (/^##\s+/.test(line)) return `<h2>${renderInline(line.replace(/^##\s+/, ''))}</h2>${revHtml}`
      if (/^[-*+]\s+/.test(line)) return `<p class="li">${renderInline(line.replace(/^[-*+]\s+/, ''))}</p>${revHtml}`
      return `<p>${renderMarkedLine(raw, i)}</p>${revHtml}`
    }).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:SimSun,serif;margin:48px;color:#111;line-height:1.85}h1{text-align:center;font-size:22pt}h2{margin-top:24px;font-size:15pt}p{font-size:12pt}p.li{margin-left:24px;text-indent:-12pt}.mark{background:#fff0e5;border-bottom:1px solid #e35f00}.mark sup,.badge{color:#fff;background:#e35f00;border-radius:9px;font-size:8pt;font-weight:bold}.mark sup{padding:1px 4px;margin-left:2px}.local-edit{display:flex;margin:5px 0 12px 22px;padding:7px 10px;background:#fffaf6;border:1px solid #f2ded0}.badge{display:inline-block;min-width:16px;height:16px;margin-right:8px;text-align:center}.local-edit p,.compact-rev p{margin:0;font-size:10.5pt}.local-edit b,.compact-rev b{margin-right:8px;color:#9e352d}.note{margin-top:4px!important;color:#765c50}.compact-rev{margin:7px 0 14px 22px;padding:8px 12px;border-left:3px solid #fd7002;background:#fafafa}.anchor{color:#777}</style></head><body>${htmlBody}</body></html>`
    const url = URL.createObjectURL(new Blob([html], { type: 'application/msword' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `${name}-审查批注稿.doc`; anchor.click(); URL.revokeObjectURL(url)
  }

  const status = stage === 'parsing' ? '正在读取合同文件…' : stage === 'analysis' ? '正在识别合同结构…' : stage === 'knowledge' ? '正在匹配参考资料…' : stage === 'review' ? '正在审查风险条款…' : stage === 'consolidation' ? '正在归并重复和关联问题…' : stage === 'rewrite' ? '正在生成局部批注稿…' : activeRequest.mode === 'thinking' ? '正在深度思考…' : '正在快速回复…'

  return <main className={`contract-chat ${documentOpen ? 'document-expanded' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {!documentOpen && <aside className="chat-sidebar">
      <label className="sidebar-search"><History size={17} /><input ref={searchRef} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索历史对话" /><kbd>⌘ K</kbd></label>
      <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>法飞飞</strong></div>
      <button className="sidebar-action" onClick={() => createConversation()}><PenLine size={20} />新对话</button>
      <button className="sidebar-action" onClick={() => setTaskModalOpen(true)}><FolderOpen size={20} />新审查任务</button>
      <p className="history-label">历史对话</p>
      <nav className="history-list">{matchingThreads.map((thread) => {
        const running = isThreadRequestRunning(threadRequests, thread.id)
        return <button className={`${thread.id === activeThread?.id ? 'selected' : ''}${running ? ' thread-running' : ''}`} key={thread.id} onClick={() => selectConversation(thread.id)}><span className="history-thread-icon" title={running ? '该会话正在后台处理中' : ''}>{running ? <Loader2 size={16} className="spinner" /> : <MessageCircle size={16} />}</span><span>{thread.title}</span><i className="history-delete" title={running ? '处理中，暂不能删除' : '删除对话'} onClick={(event) => deleteConversation(event, thread.id)}><Trash2 size={14} /></i></button>
      })}</nav>
      {tasks.length > 0 && <><p className="history-label task-label">审查任务</p><nav className="history-list task-list">{tasks.map((task) => <button key={task.id} className={task.threadId === activeThread?.id ? 'selected' : ''} onClick={() => openTask(task)}><FolderOpen size={16} /><span>{task.title}</span><i className="history-delete" title="删除任务" onClick={(event) => deleteTask(event, task.id)}><Trash2 size={14} /></i></button>)}</nav></>}
      <div className="sidebar-footer-wrap">
        {balanceOpen && <section className="balance-popover" role="dialog" aria-label="剩余用量">
          <header><span className="footer-avatar">法</span><strong>法飞飞合同助手</strong><button type="button" aria-label="关闭用量面板" onClick={() => setBalanceOpen(false)}><X size={16} /></button></header>
          <div className="balance-title"><CircleDollarSign size={19} /><strong>剩余用量</strong><button type="button" className="balance-refresh" onClick={loadBalance} disabled={balanceLoading} title="刷新用量"><RefreshCw size={16} className={balanceLoading ? 'spinner' : ''} /></button></div>
          {balanceLoading && !balanceData && <p className="balance-state"><Loader2 size={15} className="spinner" />正在查询剩余用量…</p>}
          {balanceError && <p className="balance-error">{balanceError}</p>}
          {!balanceLoading && !balanceError && balanceData && !cnyBalance && <p className="balance-state">暂未返回人民币用量。</p>}
          {!balanceError && cnyBalance && <section className="balance-summary">
            <div className="balance-summary-head"><span>当前剩余用量</span></div>
            <div className="balance-list">
              <div className="balance-item">
                <div><span>人民币</span><b>¥ {cnyBalance.total}</b></div>
                <p>充值用量 ¥ {cnyBalance.toppedUp} · 赠送用量 ¥ {cnyBalance.granted}</p>
              </div>
            </div>
          </section>}
          {balanceData && <small className={balanceData.isAvailable ? 'balance-available' : 'balance-unavailable'}>{balanceData.isAvailable ? '当前用量可正常使用' : '当前用量不足，暂不可使用'}</small>}
          <a className="balance-top-up" href="https://platform.deepseek.com/" target="_blank" rel="noreferrer">充值用量<ExternalLink size={14} /></a>
        </section>}
        <button className="sidebar-footer account-trigger" type="button" onClick={toggleBalancePanel} aria-expanded={balanceOpen}>
          <span className="footer-avatar">法</span><span>法飞飞合同助手</span><ChevronDown size={17} className={balanceOpen ? 'balance-chevron open' : 'balance-chevron'} />
        </button>
      </div>
    </aside>}

    <section className="chat-column">
      <header className="chat-header">
        <div className="header-left">{documentOpen ? <button className="icon-button" aria-label="返回对话" onClick={() => setDocumentOpen(false)}><ChevronLeft size={21} /></button> : <><button className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? '展开历史对话栏' : '折叠历史对话栏'} title={sidebarCollapsed ? '展开历史对话栏' : '折叠历史对话栏'} onClick={() => setSidebarCollapsed((value) => !value)}><PanelLeft size={21} /></button><Link className="icon-button" aria-label="返回首页" to="/"><ArrowLeft size={20} /></Link></>}</div>
        <div className="chat-title"><strong>{activeThread?.title || '商业合同审查助手'}</strong><small>AI 生成内容仅供参考，请结合实际情况判断</small></div>
        <div className="header-tools" />
      </header>

      <div className="conversation" ref={conversationRef}>
        <div className="conversation-inner">
          {activeMessages.length === 0 && <div className="assistant-turn welcome-turn"><div><p>你好，我是法飞飞合同审查助手。上传合同后，我会结合对应合同类型的优质模板和风险案例，帮你梳理风险、生成修改建议，并输出一份可继续编辑的批注稿。</p></div></div>}
          {activeMessages.map((message) => message.role === 'user'
            ? <div className="user-turn" key={message.id}><p>{message.content}</p>{message.files?.map((file) => <div className="attached-file" key={`${message.id}-${file.name}`}><FileText size={18} /><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></div>)}</div>
            : <div className="assistant-turn result-turn" key={message.id}><div>{message.status && !message.content ? <p className="assistant-status"><Loader2 size={15} className="spinner" />{message.status}</p> : <>{message.content && <div className="assistant-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>}{(message.reviewRounds?.length > 0 || (loading && stage === 'review' && activeMessages[activeMessages.length - 1]?.id === message.id)) && <ReviewRoundsPanel rounds={message.reviewRounds || []} thinking={loading && stage === 'review'} />}{message.failed && <small className="message-failed">请检查服务配置后重新发送。</small>}{message.phase === 'rewrite' && (message.revisions?.length > 0 || message.contractText || message.rewrite) && <button className="open-document-card" onClick={() => openDocument(message.id)}><FileText size={25} /><span><strong>商业合同审查批注稿</strong><small>{message.rewriteStats?.total ? `${message.rewriteStats.total} 个问题 · ${message.rewriteStats.blocks || message.revisions?.length || 0} 个就近标记 · ` : (message.revisions?.length ? `${message.revisions.length} 个修订标记 · ` : '')}点击展开文档</small></span></button>}</>}</div></div>)}
          {loading && <div className="assistant-turn loading-turn"><div><p>{status}</p></div></div>}
          {error && <p className="chat-error">{error}</p>}
          {!activeMessages.length && <div className="starter-prompts"><button onClick={() => setInstruction('请从甲方视角重点审查付款、验收和违约责任。')}>从甲方视角审查付款与违约责任 <span>→</span></button><button onClick={() => setInstruction('请检查合同是否缺少核心条款。')}>检查是否缺少核心条款 <span>→</span></button></div>}
        </div>
      </div>

      <div className="composer-wrap"><div className="composer">
        <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage() } }} placeholder="上传合同或输入你特别关注的审查重点…" disabled={loading} />
        {files.length > 0 && <div className="pending-files">{files.map((file) => <span key={file.name}><FileText size={14} />{file.name}<button aria-label={`移除 ${file.name}`} onClick={() => setFiles((items) => items.filter((item) => item !== file))}><X size={13} /></button></span>)}</div>}
        <div className="composer-bottom"><div className="composer-tools"><button onClick={() => inputRef.current?.click()} title="上传合同"><Plus size={24} /></button><i /><div className="mode-switch" aria-label="模型模式"><button className={mode === 'fast' ? 'active' : ''} onClick={() => setMode('fast')} title="使用 DeepSeek-v4-flash"><Zap size={16} />快速</button><button className={mode === 'thinking' ? 'active' : ''} onClick={() => setMode('thinking')} title="使用 DeepSeek-v4-pro"><Brain size={16} />深度思考</button></div><button className="tool-text mobile-hide" onClick={() => setTaskModalOpen(true)}><Menu size={18} />更多</button></div><button className="voice-send" onClick={sendMessage} disabled={loading || (!files.length && !instruction.trim())} aria-label="发送消息">{loading ? <Loader2 size={20} className="spinner" /> : <Send size={19} />}</button></div>
        <input ref={inputRef} hidden type="file" multiple accept={ACCEPTED_EXTENSIONS} onChange={(event) => { uploadFiles([...event.target.files]); event.target.value = '' }} />
      </div></div>
    </section>

    {documentOpen && selectedDocument && <section className="document-column">
      <header className="document-header"><span>审查修订稿</span><div><button title="复制原文" onClick={() => navigator.clipboard?.writeText(documentContractText)}><Copy size={18} />复制</button><button title="下载 Word" onClick={exportWord}><Download size={18} />下载</button><button className="close-document" aria-label="关闭文档" onClick={() => setDocumentOpen(false)}><X size={21} /></button></div></header>
      <div className="document-scroll">
        {documentRevisions.length > 0
          ? <RevisionDocument contractText={documentContractText} revisions={documentRevisions} />
          : <div className="document-empty"><FileText size={32} /><p>{selectedDocument?.status || '暂无修订内容'}</p></div>}
        {documentRevisions.length > 0 && <aside className="revision-summary">
          <p><b>{selectedDocument?.rewriteStats?.total || documentRevisions.length}</b> 个问题，生成 <b>{selectedDocument?.rewriteStats?.blocks || documentRevisions.length}</b> 个就近修订标记{selectedDocument?.rewriteStats ? `（修订 ${selectedDocument.rewriteStats.modify || 0} · 新增 ${selectedDocument.rewriteStats.add || 0} · 删除 ${selectedDocument.rewriteStats.delete || 0}）` : ''}{selectedDocument?.rewriteStats?.groups && selectedDocument.rewriteStats.groups < (selectedDocument.rewriteStats.total || 0) ? '，同一条款的相关问题已统一处理' : ''}</p>
          <p className="revision-summary-tip">正文中的浅橙色片段和编号对应下方局部修改；完整修订条款与批注默认收起，可按需展开查看。</p>
        </aside>}
      </div>
    </section>}

    {taskModalOpen && <div className="task-modal-backdrop" role="presentation" onMouseDown={() => setTaskModalOpen(false)}><form className="task-modal" onSubmit={createTask} onMouseDown={(event) => event.stopPropagation()}><div><strong>新审查任务</strong><button type="button" aria-label="关闭" onClick={() => setTaskModalOpen(false)}><X size={19} /></button></div><label>任务名称<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="例如：供应商年度采购合同" autoFocus /></label><label>审查要求<textarea value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder="可填写审查视角、关注条款或交付要求" /></label><p>创建后会打开独立对话，可上传合同后开始审查。</p><footer><button type="button" onClick={() => setTaskModalOpen(false)}>取消</button><button className="task-primary" type="submit">创建任务</button></footer></form></div>}
  </main>
}

export default ContractRewritePage
