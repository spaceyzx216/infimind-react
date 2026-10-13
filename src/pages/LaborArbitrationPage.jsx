import MaterialReviewPanel from '../components/MaterialReviewPanel.jsx'
import { useComposerSend } from '../hooks/useComposerSend'
import QueuedMessages from '../components/QueuedMessages'
import SideChatEmptyState from '../components/SideChatEmptyState'
import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, ArrowUpRight, FileText, History, Loader2,
  MessageCircle, PenLine, Plus, Send, BookOpen, Trash2, X
} from 'lucide-react'
import { useAuth } from '../components/AuthProvider'
import { authFetch } from '../utils/auth-api'
import { ACCEPTED_EXTENSIONS, mergeSelectedFiles, describeRejection } from '../utils/file-selection.js'
import { formatRelativeTime } from '../utils/relative-time.js'
import { formatArbitrationResult, remarkArbitrationText } from '../utils/arbitration-result.js'
import ToolComposerControls from '../components/ToolComposerControls'
import { useWorkspaceText, useWorkspaceLayout } from '../components/WorkspaceContext'
import { useConversationActions } from '../hooks/useConversationActions'
import { useSharedConversations, useSharedRequestState } from '../hooks/useSharedConversations'

import { CONTEXT_WINDOW_TOKENS, OUTPUT_RESERVE_TOKENS, CONTEXT_SAFETY_TOKENS, estimateTokens, selectHistoryByTokens } from '../utils/context-budget.js'
import { restoreArbitrationConversation, resolveArbitrationAction, isArbitrationDraftStale } from '../utils/arbitration-history.js'
import './ContractRewritePage.css'
import './LaborConsultPage.css'
import './LaborArbitrationPage.css'

const STORAGE_KEY = 'fafee-labor-arbitration-v1'
const TERMINAL = ['succeeded', 'failed', 'cancelled']
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createConversation = () => ({ id: createId('arbitration'), title: '新案件', messages: [], updatedAt: Date.now(), sourceExpiresAt: null, resultExpiresAt: null })
const readConversations = (key) => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '[]')
    return Array.isArray(value) && value.length
      ? value.map((item) => ({ ...item, messages: Array.isArray(item.messages) ? item.messages : [] }))
      : [createConversation()]
  } catch { return [createConversation()] }
}
const formatSize = (bytes) => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : `${Math.max(1, Math.ceil(bytes / 1024))} KB`
function historyText(message) {
  if (message.type === 'user') {
    const files = message.files?.length ? `\n上传材料：${message.files.map((file) => file.name).join('、')}` : ''
    return `${message.content || ''}${files}`
  }
  return message.result ? formatArbitrationResult(message.result) : String(message.content || '')
}

function ArbitrationReport({ result, onGenerateDraft, draftCount, disabled, stale }) {
  const t = useWorkspaceText()
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(result.defenseDraft)
      setCopied(true)
      setCopyError('')
    } catch { setCopyError('复制失败，请选中文书正文手动复制。') }
  }
  return <div className="arb-report">
    <div className="labor-answer arb-answer"><ReactMarkdown remarkPlugins={[remarkGfm, remarkArbitrationText]}>{formatArbitrationResult(result)}</ReactMarkdown></div>
    {result.caseRecord?.requests?.length > 0 && <details className="arb-materials arb-sources"><summary>{t("查看材料依据")}</summary>
      {result.caseRecord.requests.map((request) => <div key={request.id}><strong>{request.text}</strong><div>
        {(request.sources || []).map((source, index) => <p key={`${source.sourceId}-${index}`}>{source.located ? `${source.sourceName}${source.line ? (t(" · 第") + (source.line) + t("行")) : ''}` : t("来源未定位，待核实")}：{source.quote}</p>)}
        {(result.retrievalSnapshot || []).filter((reference) => reference.requestId === request.id).map((reference) => <p key={reference.id}>{t("参考：")}{reference.title}{t("（仅作比较或表达参考，不是本案证据）")}</p>)}
      </div></div>)}
      {(result.caseRecord.facts || []).map((fact) => <div key={fact.id}><strong>{({ applicant_statement: t("申请人主张"), company_statement: t("企业陈述"), document_record: t("文件记载"), unknown: t("待核实") })[fact.kind] || t("待核实")}：{fact.text}</strong><div>
        {(fact.sources || []).map((source, index) => <p key={`${source.sourceId}-${index}`}>{source.located ? `${source.sourceName}${source.line ? (t(" · 第") + (source.line) + t("行")) : ''}` : t("来源未定位")}：{source.quote}</p>)}
      </div></div>)}
    </details>}
    {stale && <p className="assistant-status">{t("材料或案件信息已更新，建议生成新版本；当前旧版仍可查看、复制。")}</p>}
    <div className="arb-result-actions">
      {result.defenseDraft && <button type="button" onClick={() => { void copyDraft() }}>{copied ? t("已复制") : t("复制答辩意见")}</button>}
      <button type="button" disabled={disabled} onClick={onGenerateDraft}><PenLine size={14} />{result.defenseDraft || draftCount ? t("生成答辩意见新版本") : t("生成完整答辩意见")}</button>
      {result.defenseDraft && <small>{t("第")}{draftCount || 1}{t("版 · 提交前请复核")}</small>}
    </div>
    {copyError && <p role="alert" className="chat-error">{copyError}</p>}
  </div>
}

export default function LaborArbitrationPage() {
  const t = useWorkspaceText()
  const { user } = useAuth()
  const { sidebarCollapsed: collapsed, initialConversationId, isSideChat } = useWorkspaceLayout()
  const storageKey = `${STORAGE_KEY}:${user?.id || 'guest'}`
  const [conversations, setConversations] = useSharedConversations(storageKey, () => readConversations(storageKey), undefined, createConversation)
  const [activeId, setActiveId] = useState(initialConversationId)
  const [question, setQuestion] = useState('')
  const [files, setFiles] = useState([])
  const [mode, setMode] = useState('thinking')
  const [search, setSearch] = useState('')
  const [requests, setRequests] = useSharedRequestState(storageKey)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)
  const bottomRef = useRef(null)
  const activeRunsRef = useRef(new Map())
  const conversationsRef = useRef(conversations)
  conversationsRef.current = conversations
  const submitLocksRef = useRef(new Set())
  const draftsRef = useRef(new Map())
  const activeConversation = conversations.find((item) => item.id === activeId) || conversations[0]
  const composerRef = useRef(null)
  composerRef.current = { id: activeConversation?.id, question, files }
  const activeRequest = requests[activeConversation?.id] || {}
  const now = Date.now()
  const sessionExpired = Boolean(activeConversation?.resultExpiresAt && new Date(activeConversation.resultExpiresAt).getTime() <= now)
  const readOnly = sessionExpired
  const readOnlyMessage = '案件会话已到期，请新建案件继续。'
  const [materialBusy, setMaterialBusy] = useState(false)

  useEffect(() => { if (!conversations.some((item) => item.id === activeId) && conversations.length) setActiveId(conversations[0].id) }, [activeId, conversations])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [activeConversation?.messages?.length])
  useEffect(() => () => { for (const run of activeRunsRef.current.values()) run.controller.abort() }, [])

  const hasAnalysis = resolveArbitrationAction(activeConversation?.messages) === 'followup'
  const draftCount = activeConversation?.messages?.filter((item) => item.type === 'assistant' && item.result?.defenseDraft).length || 0

  const updateConversation = (conversationId, updater, touch = true) => {
    const next = conversationsRef.current.map((item) => item.id === conversationId
      ? { ...item, ...(typeof updater === 'function' ? updater(item) : updater), ...(touch ? { updatedAt: Date.now() } : {}) }
      : item)
    conversationsRef.current = next
    setConversations(next)
  }
  const updateMessage = (conversationId, messageId, patch) => updateConversation(conversationId, (item) => ({
    messages: item.messages.map((message) => message.id === messageId
      ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) }
      : message)
  }))

  const startConversation = () => {
    draftsRef.current.set(activeConversation.id, { question, files, mode })
    const next = createConversation()
    conversationsRef.current = [next, ...conversationsRef.current]
    setConversations(conversationsRef.current)
    setActiveId(next.id)
    setQuestion('')
    setFiles([])
    setError('')
  }
  const selectConversation = (id) => {
    draftsRef.current.set(activeConversation.id, { question, files, mode })
    const saved = draftsRef.current.get(id)
    setActiveId(id)
    setQuestion(saved?.question || '')
    setFiles(saved?.files || [])
    setMode(saved?.mode || 'thinking')
    setError('')
  }

  const deleteConversation = async (event, conversationId) => {
    event.stopPropagation()
    if (activeRunsRef.current.has(conversationId)) return
    try {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId)
    if (conversation?.messages?.some((message) => message.taskId)) {
      const response = await authFetch(`/api/tasks/labor-arbitration/thread/${encodeURIComponent(conversationId)}`, { method: 'DELETE', headers: { Accept: 'application/json' } })
      if (!response.ok && response.status !== 404) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error || '案件删除失败，请稍后重试。')
        if (!payload.deleted) return
      }
    }
    const remaining = conversationsRef.current.filter((item) => item.id !== conversationId)
    const next = remaining.length ? remaining : [createConversation()]
    conversationsRef.current = next
    setConversations(next)
    draftsRef.current.delete(conversationId)
    if (activeId === conversationId) { setActiveId(next[0].id); setQuestion(''); setFiles([]) }
    } catch { setError('删除请求未完成，请稍后重试。') }
  }

  const selectFiles = (incoming) => {
    const merged = mergeSelectedFiles(files, incoming)
    setFiles(merged.files)
    setError(describeRejection(merged))
  }

  const consumeTaskEvents = async (response, onEvent, signal) => {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('任务进度连接不可用。')
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    const cancelReader = () => { void reader.cancel().catch(() => {}) }
    if (signal?.aborted) {
      cancelReader()
      throw new Error('任务进度订阅已停止。')
    }
    signal?.addEventListener('abort', cancelReader, { once: true })
    try {
      while (true) {
        if (signal?.aborted) throw new Error('任务进度订阅已停止。')
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const packets = buffer.split(/\r?\n\r?\n/)
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
      if (signal?.aborted) throw new Error('任务进度订阅已停止。')
    } finally {
      signal?.removeEventListener('abort', cancelReader)
      reader.releaseLock()
    }
  }

  const isCurrentRun = (conversationId, run) => activeRunsRef.current.get(conversationId) === run && !run.controller.signal.aborted
  const finishTask = (conversationId, assistantId, task) => {
    updateConversation(conversationId, (item) => {
      const result = task.status === 'succeeded' ? task.result : null
      const version = result?.defenseDraft ? item.messages.filter((message) => message.id !== assistantId && message.result?.defenseDraft).length + 1 : undefined
      const deadlines = (task.files || []).map((file) => new Date(file.cleanupAt).getTime()).filter(Number.isFinite)
      if (item.sourceExpiresAt) deadlines.push(new Date(item.sourceExpiresAt).getTime())
      return {
        ...(task.retentionPolicy ? { retentionPolicy: task.retentionPolicy } : {}),
        ...(Object.hasOwn(task, 'resultExpiresAt') ? { resultExpiresAt: task.resultExpiresAt } : {}),
        ...(deadlines.length ? { sourceExpiresAt: new Date(Math.min(...deadlines)).toISOString() } : {}),
        ...(result?.conversationTitle && !item.titleGenerated ? { title: result.conversationTitle, titleGenerated: true } : {}),
        messages: item.messages.map((message) => message.id !== assistantId ? message : {
          ...message, taskId: task.id, status: '', recoverable: false, result, version,
          stopped: task.status === 'cancelled', failed: task.status === 'failed',
          error: task.status === 'failed' ? task.errorSummary || '分析未完成，请稍后重试。' : ''
        })
      }
    }, false)
    void authFetch(`/api/tasks/labor-arbitration/thread/${encodeURIComponent(conversationId)}`).then(async (response) => {
      if (response.ok) updateConversation(conversationId, { materials: (await response.json()).materials || [] }, false)
    }).catch(() => {})
  }
  const clearRun = (conversationId, run) => {
    if (activeRunsRef.current.get(conversationId) !== run) return
    activeRunsRef.current.delete(conversationId)
    setRequests((items) => ({ ...items, [conversationId]: { loading: false } }))
  }
  const pollTask = async (conversationId, assistantId, taskId, run) => {
    let after = 0
    let reconnectFailures = 0
    while (isCurrentRun(conversationId, run)) {
      try {
        const eventResponse = await authFetch(`/api/tasks/${taskId}/events?after=${after}`, {
          headers: { Accept: 'text/event-stream' },
          signal: run.controller.signal
        })
        if (!eventResponse.ok) throw new Error(eventResponse.status === 404 ? '任务已失效，请重新提交材料。' : '读取任务进度失败。')
        await consumeTaskEvents(eventResponse, (event, data) => {
          after = Math.max(after, Number(data?._seq) || 0)
          if (!isCurrentRun(conversationId, run) || run.interrupting) return
          if (event === 'arbitration.progress') updateMessage(conversationId, assistantId, { taskId, status: run.cancelPending ? '正在停止分析…' : (data.label || '正在处理仲裁材料…') })
          if (event === 'task.cancel_requested') updateMessage(conversationId, assistantId, { taskId, status: '正在停止分析…' })
        }, run.controller.signal)
        reconnectFailures = 0
      } catch (streamError) {
        if (run.controller.signal.aborted) throw streamError
        reconnectFailures += 1
        if (reconnectFailures >= 4) throw streamError
        await new Promise((resolve) => setTimeout(resolve, reconnectFailures * 500))
      }

      const response = await authFetch(`/api/tasks/${taskId}`, { headers: { Accept: 'application/json' }, signal: run.controller.signal })
      if (!response.ok) throw new Error(response.status === 404 ? '任务已失效，请重新提交材料。' : '读取任务状态失败，请稍后重试。')
      const payload = await response.json().catch(() => ({}))
      const task = payload.task
      if (!isCurrentRun(conversationId, run)) return
      if (TERMINAL.includes(task?.status)) {
        if (!run.interrupting) { finishTask(conversationId, assistantId, task); clearRun(conversationId, run) }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
  }
  const watchTask = (conversationId, assistantId, taskId, run) => {
    void pollTask(conversationId, assistantId, taskId, run).catch((failure) => {
      if (!isCurrentRun(conversationId, run) || run.interrupting) return
      updateMessage(conversationId, assistantId, { status: '', failed: false, recoverable: true, error: `任务连接中断：${failure.message} 后台可能仍在处理，可恢复查看。` })
      clearRun(conversationId, run)
    })
  }
  const resumeTask = (conversationId, assistantId, taskId) => {
    const existing = activeRunsRef.current.get(conversationId)
    if (existing && !existing.controller.signal.aborted) return existing
    const run = { controller: new AbortController(), taskId, assistantId, cancelPending: false }
    activeRunsRef.current.set(conversationId, run)
    setRequests((items) => ({ ...items, [conversationId]: { loading: true, taskId } }))
    updateMessage(conversationId, assistantId, { status: '正在恢复任务进度…', recoverable: false })
    watchTask(conversationId, assistantId, taskId, run)
    return run
  }

  // Refresh/focus merges all server turns; it never submits another task.
  useEffect(() => {
    let disposed = false
    let syncing = false
    const controller = new AbortController()
    const restore = async () => {
      if (syncing || disposed) return
      syncing = true
      try {
        if (isSideChat) return
        const threads = new Map()
        let offset = 0
        while (!disposed) {
          const response = await authFetch(`/api/tasks?limit=100&productId=labor-arbitration&offset=${offset}`, { signal: controller.signal })
          if (!response.ok) throw new Error('读取案件列表失败')
          const payload = await response.json()
          for (const task of payload.tasks || []) if (task.threadId && !threads.has(task.threadId)) threads.set(task.threadId, task)
          if (!payload.hasMore || !payload.tasks?.length) break
          offset += payload.tasks.length
        }
        for (const item of conversationsRef.current) if (item.messages.some((message) => message.taskId)) threads.set(item.id, threads.get(item.id) || { threadId: item.id })
        for (const [id, recent] of threads) {
          if (disposed) break
          if (activeRunsRef.current.has(id) || submitLocksRef.current.has(id)) continue
          let tasks = [], materials = [], pageOffset = 0, removed = false
          while (!disposed) {
            const response = await authFetch(`/api/tasks/labor-arbitration/thread/${encodeURIComponent(id)}?offset=${pageOffset}`, { signal: controller.signal })
            if (response.status === 404 && pageOffset === 0) { removed = true; break }
            if (!response.ok) throw new Error('读取案件历史失败')
            const payload = await response.json()
            tasks = [...(payload.tasks || []), ...tasks]
            materials = payload.materials || materials
            if (!payload.hasMore || !payload.tasks?.length) break
            pageOffset += payload.tasks.length
          }
          if (disposed || activeRunsRef.current.has(id) || submitLocksRef.current.has(id)) continue
          const existing = conversationsRef.current.find((item) => item.id === id)
          if (removed) {
            conversationsRef.current = conversationsRef.current.filter((item) => item.id !== id)
            if (composerRef.current.id === id) {
              const next = createConversation()
              conversationsRef.current = [next, ...conversationsRef.current]
              setActiveId(next.id)
              setError('该案件已在服务器删除。未发送内容已保留在新案件中。')
            }
          } else {
            const restored = restoreArbitrationConversation(existing || { id, title: recent.title || '仲裁案件', messages: [] }, tasks, materials)
            conversationsRef.current = existing ? conversationsRef.current.map((item) => item.id === id ? restored : item) : [...conversationsRef.current, restored]
          }
          if (!conversationsRef.current.length) conversationsRef.current = [createConversation()]
          setConversations(conversationsRef.current)
          for (const task of tasks.filter((item) => !TERMINAL.includes(item.status))) {
            const assistant = conversationsRef.current.find((item) => item.id === id)?.messages.find((message) => message.type === 'assistant' && message.taskId === task.id)
            if (assistant) resumeTask(id, assistant.id, task.id)
          }
        }
      } catch {
        if (!disposed) setError('历史记录暂未同步，请稍后返回页面重试；本地记录仍可查看。')
      } finally { syncing = false }
    }
    void restore()
    const onFocus = () => { void restore() }
    window.addEventListener('focus', onFocus)
    return () => { disposed = true; controller.abort(); window.removeEventListener('focus', onFocus) }
  }, [storageKey])

  const toggleMaterial = async (material) => {
    if (materialBusy || activeRequest.loading || readOnly) return
    setMaterialBusy(true)
    try {
      const response = await authFetch(`/api/tasks/labor-arbitration/thread/${encodeURIComponent(activeConversation.id)}/materials`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: material.id, enabled: !material.enabled })
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || '材料操作失败')
      updateConversation(activeConversation.id, { materials: payload.materials }, false)
      setError('')
    } catch (failure) { setError(failure.message) }
    finally { setMaterialBusy(false) }
  }

  const restoreSubmissionInput = (conversationId, run) => {
    const submitted = run.submission
    if (!submitted) return
    if (composerRef.current.id === conversationId) {
      if (!composerRef.current.question.trim()) setQuestion(submitted.text)
      setFiles((items) => mergeSelectedFiles(items, submitted.files).files)
    } else {
      const saved = draftsRef.current.get(conversationId) || { question: '', files: [], mode: submitted.mode }
      draftsRef.current.set(conversationId, { ...saved, question: saved.question || submitted.text, files: mergeSelectedFiles(saved.files, submitted.files).files })
    }
  }

  const interruptTask = async (conversationId, run) => {
    run.interrupting = true
    run.cancelPending = true
    setRequests((items) => ({ ...items, [conversationId]: { loading: true, taskId: run.taskId, cancelPending: true } }))
    updateMessage(conversationId, run.assistantId, { status: '正在停止上一条回答…' })
    try {
      // 上传尚未拿到任务ID时先等创建响应，避免取消请求遗漏后台任务。
      if (!run.taskId && run.creationPromise) await run.creationPromise
      if (!run.taskId) throw new Error('任务尚未创建成功，请重试。')
      const response = await authFetch(`/api/tasks/${run.taskId}/cancel`, { method: 'POST', headers: { Accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || '停止请求未成功，请重试。')
      let task = payload.task
      for (let attempt = 0; !TERMINAL.includes(task?.status) && attempt < 120; attempt += 1) {
        await delay(500)
        const statusResponse = await authFetch(`/api/tasks/${run.taskId}`, { headers: { Accept: 'application/json' }, signal: run.controller.signal })
        if (!statusResponse.ok) throw new Error('无法确认旧任务已停止，请稍后重试。')
        task = (await statusResponse.json()).task
      }
      if (!TERMINAL.includes(task?.status)) throw new Error('旧任务仍在停止中，请稍后重试；新问题已保留。')
      finishTask(conversationId, run.assistantId, task)
      run.controller.abort()
      clearRun(conversationId, run)
    } catch (failure) {
      run.interrupting = false
      run.cancelPending = false
      clearRun(conversationId, run)
      run.controller.abort()
      if (run.taskId) resumeTask(conversationId, run.assistantId, run.taskId)
      else {
        updateMessage(conversationId, run.assistantId, { status: '', failed: true, error: failure.message })
        restoreSubmissionInput(conversationId, run)
      }
      throw failure
    }
  }

  const submit = async (action = '', suggestedQuestion = '', snapshot = null) => {
    const conversationId = activeConversation.id
    if (materialBusy || submitLocksRef.current.has(conversationId) || activeRunsRef.current.get(conversationId)?.cancelPending) return
    if (activeConversation.resultExpiresAt && new Date(activeConversation.resultExpiresAt).getTime() <= Date.now()) {
      setError('案件会话已到期，请新建案件继续。')
      return
    }
    const text = suggestedQuestion || (snapshot ? snapshot.text.trim() : question.trim())
    const selectedFiles = snapshot ? snapshot.files : [...files]
    let resolvedAction = resolveArbitrationAction(activeConversation.messages, action)
    if (!text && !selectedFiles.length && resolvedAction !== 'draft') return
    submitLocksRef.current.add(conversationId)
    try {
      let previousRun = activeRunsRef.current.get(conversationId)
      if (!previousRun) {
        const pending = [...activeConversation.messages].reverse().find((item) => item.type === 'assistant' && (item.status || item.recoverable))
        if (pending?.taskId) previousRun = resumeTask(conversationId, pending.id, pending.taskId)
        else if (pending?.recoverable) {
          const response = await authFetch(`/api/tasks/labor-arbitration/thread/${encodeURIComponent(conversationId)}`, { headers: { Accept: 'application/json' } })
          if (!response.ok && response.status !== 404) throw new Error('尚不能确认上次提交状态，请恢复查看后再发送。')
          const tasks = response.ok ? (await response.json()).tasks || [] : []
          const knownIds = new Set(activeConversation.messages.map((message) => message.taskId).filter(Boolean))
          const task = [...tasks].reverse().find((item) => !knownIds.has(item.id))
          if (task && !TERMINAL.includes(task.status)) previousRun = resumeTask(conversationId, pending.id, task.id)
          else if (task) finishTask(conversationId, pending.id, task)
          else updateMessage(conversationId, pending.id, { recoverable: false, failed: true, error: '上次提交未成功。' })
        }
      }
      if (previousRun) await interruptTask(conversationId, previousRun)
    } catch (failure) {
      setError(failure.message)
      submitLocksRef.current.delete(conversationId)
      return
    }
    const currentConversation = conversationsRef.current.find((item) => item.id === conversationId)
    resolvedAction = resolveArbitrationAction(currentConversation.messages, action)
    const assistantId = createId('message')
    const userText = resolvedAction === 'draft'
      ? (text || (draftCount ? '根据最新对话生成答辩文书新版本。' : '请生成完整答辩文书草稿。'))
      : text || `请分析我上传的 ${selectedFiles.length} 份仲裁材料。`
    const selectedHistory = selectHistoryByTokens(currentConversation.messages
      .filter((message) => !message.failed && !message.status && !message.stopped && !message.recoverable)
      .map((message) => ({ role: message.type === 'user' ? 'user' : 'assistant', content: historyText(message) })),
    CONTEXT_WINDOW_TOKENS - OUTPUT_RESERVE_TOKENS - CONTEXT_SAFETY_TOKENS - 100000 - estimateTokens(userText))
    const history = selectedHistory.history
    const userMessage = { id: createId('message'), type: 'user', content: userText, files: selectedFiles.map((file) => ({ name: file.name, size: file.size })) }
    const assistantMessage = { id: assistantId, type: 'assistant', userMessageId: userMessage.id, status: selectedFiles.length ? '正在读取上传材料…' : '正在整理案件信息…' }
    updateConversation(conversationId, (item) => ({
      title: item.title === '新案件' ? (selectedFiles[0]?.name?.replace(/\.[^.]+$/, '') || userText.slice(0, 28)) : item.title,
      messages: [...item.messages, userMessage, assistantMessage]
    }))
    if (!snapshot && composerRef.current.id === conversationId) {
      if (composerRef.current.question === question) setQuestion('')
      setFiles((items) => items.filter((file) => !selectedFiles.includes(file)))
    } else if (!snapshot) {
      const saved = draftsRef.current.get(conversationId)
      if (saved) draftsRef.current.set(conversationId, { ...saved, question: saved.question === question ? '' : saved.question, files: saved.files.filter((file) => !selectedFiles.includes(file)) })
    }
    setError('')
    setRequests((items) => ({ ...items, [conversationId]: { loading: true } }))
    const run = { controller: new AbortController(), cancelPending: false, assistantId, taskId: null, submission: { text, files: selectedFiles, mode } }
    activeRunsRef.current.set(conversationId, run)

    try {
      const form = new FormData()
      form.append('threadId', conversationId)
      form.append('action', resolvedAction)
      form.append('message', text || userText)
      form.append('mode', snapshot?.mode || mode)
      form.append('temporary', String(isSideChat))
      form.append('history', JSON.stringify(history))
      form.append('historyDroppedMessages', String(selectedHistory.droppedMessages))
      form.append('title', activeConversation.title === '新案件' ? userText.slice(0, 80) : activeConversation.title)
      selectedFiles.forEach((file) => form.append('files', file))
      run.creationPromise = (async () => {
      const response = await authFetch('/api/tasks/labor-arbitration', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: form,
        signal: run.controller.signal
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || !payload.taskId) {
        const failure = new Error(payload.error || '仲裁任务创建失败，请稍后重试。')
        failure.responseStatus = response.status
        throw failure
      }
      run.taskId = payload.taskId
      updateConversation(conversationId, (item) => ({
        resultExpiresAt: payload.task?.resultExpiresAt ?? null,
        retentionPolicy: payload.task?.retentionPolicy,
        sourceExpiresAt: item.sourceExpiresAt || (payload.task?.files?.length ? payload.task.files[0].cleanupAt : null)
      }))
      setRequests((items) => ({ ...items, [conversationId]: { loading: true, taskId: payload.taskId, cancelPending: run.cancelPending } }))
      updateMessage(conversationId, userMessage.id, { taskId: payload.taskId })
      updateMessage(conversationId, assistantId, { taskId: payload.taskId, status: run.interrupting ? '正在停止上一条回答…' : '任务已提交，正在处理中…' })
      return payload.taskId
      })()
      submitLocksRef.current.delete(conversationId)
      const taskId = await run.creationPromise
      submitLocksRef.current.delete(conversationId)
      if (isCurrentRun(conversationId, run) && !run.interrupting) watchTask(conversationId, assistantId, taskId, run)
    } catch (requestError) {
      if (isCurrentRun(conversationId, run) && !run.interrupting) {
        updateMessage(conversationId, assistantId, { status: '', failed: Boolean(requestError.responseStatus), recoverable: !requestError.responseStatus, error: requestError.message || '任务提交状态暂时无法确认，请恢复查看。' })
        restoreSubmissionInput(conversationId, run)
        clearRun(conversationId, run)
      }
    } finally {
      submitLocksRef.current.delete(conversationId)
    }
  }

  const cancelCurrent = async () => {
    const conversationId = activeConversation.id
    const run = activeRunsRef.current.get(conversationId)
    if (!run || run.cancelPending) return
    try { await interruptTask(conversationId, run) } catch (failure) { setError(failure.message) }
  }

  const { visibleItems: matchingConversations, titleOf, renderTitle, historyControls, getHistoryMenuProps } = useConversationActions({
    items: conversations, active: activeConversation, toolKey: 'labor-arbitration', query: search,
    onNew: startConversation, onSelect: (item) => selectConversation(item.id)
  })

  const queuedComposer = useComposerSend({ tool: 'arbitration', conversationId: activeConversation?.id, busy: Boolean(activeRequest.loading), blocked: readOnly || materialBusy || Boolean(activeRequest.cancelPending), capture: () => ({ text: question, files: [...files], mode }), clear: () => { setQuestion(''); setFiles([]) }, onSend: (snapshot) => submit('', '', snapshot), onStop: cancelCurrent })

  return (
    <main className={`contract-chat labor-consult labor-arbitration ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="chat-sidebar">
        <label className="sidebar-search"><History size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索案件会话")} /></label>
        <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>{t("法飞飞")}</strong></div>
        <button type="button" className="sidebar-action" onClick={startConversation}><PenLine size={19} />{t("新建案件")}</button>
        <p className="history-label">{t("案件会话")}</p>
        <nav className="history-list">
          {matchingConversations.map((conversation) => <button type="button" key={conversation.id} {...getHistoryMenuProps(conversation)} data-thread-id={conversation.id} className={`${conversation.id === activeId ? 'selected' : ''}${requests[conversation.id]?.loading ? ' thread-running' : ''}`} onClick={() => selectConversation(conversation.id)}>
            <span className="history-thread-icon">{requests[conversation.id]?.loading ? <Loader2 size={16} className="spinner" /> : <MessageCircle size={16} />}</span>
            <span className="history-thread-main"><span className="history-thread-title">{renderTitle(conversation)}</span><small className="history-thread-time">{formatRelativeTime(conversation.updatedAt, now)}</small></span>
            <i className="history-delete" title={t("删除案件会话")} onClick={(event) => { void deleteConversation(event, conversation.id) }}><Trash2 size={14} /></i>
          </button>)}
        </nav>
        {historyControls}
      </aside>

      <section className="chat-column">
        <header className="chat-header"><div className="header-left" /><div className="chat-title"><strong>{titleOf(activeConversation)}</strong><small>{t("企业侧案件分析与答辩准备 · 结果需人工复核")}</small></div><div className="header-tools" /></header>
        <div className="conversation">
          <div className="conversation-inner">
            {isSideChat && !activeConversation.messages.length && <SideChatEmptyState />}
            {readOnly && <p className="arb-readonly-note" role="status"><AlertTriangle size={15} />{readOnlyMessage}</p>}
            {!isSideChat && !activeConversation.messages.length && <div className="assistant-turn welcome-turn arb-welcome-turn"><div>
              <p>{t("你好，我是法飞飞劳动仲裁答辩助手。请描述公司的仲裁案件，也可以直接上传仲裁申请书、已有答辩意见、劳动合同、工资或考勤记录等材料。我会先梳理请求、风险和答辩方向，必要时在对话中追问；你可以补充信息，也可以直接要求生成答辩意见草稿。")}</p>
              <div className="starter-prompts">
                {[t("公司收到仲裁申请书，先帮我梳理请求和答辩方向。"), t("员工主张违法解除赔偿，公司需要准备哪些证据？"), t("员工要求加班费和未休年休假工资，公司可以怎样答辩？"), t("我已有一份答辩意见，请帮我检查论证和证据缺口。")].map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}<ArrowUpRight size={15} /></button>)}
              </div>
            </div></div>}

            {activeConversation.messages.map((message) => message.type === 'user'
              ? <div className="user-turn" key={message.id}><p>{message.content}</p>{message.files?.map((file) => <div className="attached-file" key={`${message.id}-${file.name}`}><FileText size={17} /><span>{file.name}</span><small>{formatSize(file.size)}</small></div>)}</div>
              : <div className="assistant-turn result-turn" key={message.id}><div>
                {message.status && <p className="assistant-status"><Loader2 size={15} className="spinner" />{message.status}</p>}
                {message.result && <ArbitrationReport result={message.result} draftCount={message.version} disabled={readOnly || activeRequest.loading} stale={isArbitrationDraftStale(message.result, [...activeConversation.messages].reverse().find((item) => item.result?.caseRecord)?.result.caseRecord, activeConversation.materials)} onGenerateDraft={() => submit('draft')} />}
                {message.failed && <p className="arb-message-error"><AlertTriangle size={15} />{message.error || t("本次任务未完成。")}</p>}
                {message.stopped && <p className="assistant-status">{t("本次回答已停止，可继续补充或提问。")}</p>}
                {message.recoverable && <p className="assistant-status">{message.error}<button type="button" onClick={() => message.taskId ? resumeTask(activeConversation.id, message.id, message.taskId) : window.location.reload()}>{t("恢复查看")}</button></p>}
              </div></div>)}

            {activeConversation.materials?.length > 0 && <details className="arb-materials"><summary>{t("案件材料（")}{activeConversation.materials.length}）</summary>
              <p>{t("停用的材料不再参与后续分析，历史答复保留。替换材料时，先停用旧文件，再上传新文件。")}</p>
              {activeConversation.materials.map((material) => <div key={material.id}><span>{material.name}<small>{!material.enabled ? t("已停用") : !material.available ? t("需重新上传") : !material.originalAvailable ? t("原件已清理，正文可用") : t("正在使用")}</small></span><button type="button" disabled={materialBusy || readOnly || activeRequest.loading || (!material.available && !material.enabled)} onClick={() => { void toggleMaterial(material) }}>{material.enabled ? t("停止使用") : t("恢复使用")}</button></div>)}
            </details>}
            {error && <p className="chat-error">{error}</p>}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="composer-wrap"><MaterialReviewPanel taskId={[...(activeConversation?.messages || [])].reverse().find((m) => m.taskId)?.taskId || activeConversation?.taskId} running={Boolean(activeRequest.loading)} /><div className="composer"><QueuedMessages composer={queuedComposer} />
          <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit() } }} placeholder={readOnly ? readOnlyMessage : activeRequest.loading ? t("输入新问题并发送可停止当前回答；留空点击停止…") : hasAnalysis ? t("补充案件事实、上传新证据，或继续询问…") : t("描述公司的仲裁案件，也可上传仲裁申请书、答辩意见或证据材料…")} disabled={readOnly} />
          {files.length > 0 && <div className="pending-files">{files.map((file) => <span key={`${file.name}-${file.lastModified}`} title={`${file.name} · ${formatSize(file.size)}`}><FileText size={14} />{file.name}<button type="button" aria-label={(t("移除 ") + (file.name))} onClick={() => setFiles((items) => items.filter((item) => item !== file))}><X size={13} /></button></span>)}</div>}
          <div className="composer-bottom"><ToolComposerControls onUpload={() => fileInputRef.current?.click()} uploadLabel={t("上传仲裁材料")} disabled={readOnly} mode={mode} onModeChange={setMode} messages={activeConversation.messages.map((message) => ({ ...message, content: historyText(message) }))} question={question} hasPendingFiles={files.length > 0}>
            <input ref={fileInputRef} hidden type="file" multiple accept={ACCEPTED_EXTENSIONS} onChange={(event) => { selectFiles([...event.target.files]); event.target.value = '' }} />
          </ToolComposerControls><button type="button" className={`voice-send${activeRequest.loading && !question.trim() && !files.length ? ' stop' : ''}`} aria-label={queuedComposer.label || (activeRequest.loading && !question.trim() && !files.length ? t("停止分析") : activeRequest.loading ? t("停止当前回答并发送") : t("发送"))} onClick={queuedComposer.send} disabled={readOnly || activeRequest.cancelPending || (!activeRequest.loading && !question.trim() && !files.length)}>{activeRequest.loading && !question.trim() && !files.length ? <X size={18} /> : <Send size={18} />}</button></div>
        </div><p className="labor-disclaimer"><BookOpen size={13} />{t("本回答为企业答辩辅助，不构成正式法律意见；答辩文书提交前请由专业人员复核。")}</p></div>
      </section>
    </main>
  )
}
