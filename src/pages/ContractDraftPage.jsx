import { selectConversationHistory } from '../utils/context-budget.js'
import { useComposerSend } from '../hooks/useComposerSend'
import QueuedMessages from '../components/QueuedMessages'
import SideChatEmptyState from '../components/SideChatEmptyState'
import SidebarSearch from '../components/SidebarSearch.jsx'
import ToolComposerControls from '../components/ToolComposerControls'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import MarkdownBody from '../components/MarkdownBody.jsx'
import { throttleWithTrailing, MARKDOWN_THROTTLE_MS } from '../utils/stream-buffer.js'
import { Check, ChevronLeft, ClipboardList, Copy, Download, FilePenLine, FileText, FolderOpen, Loader2, MessageCircle, PenLine, Plus, Square, Send, Trash2, X } from 'lucide-react'
import './ContractRewritePage.css'
import './ContractDraftPage.css'
import { useWorkspaceText, useWorkspaceLayout } from '../components/WorkspaceContext'
import { useConversationActions } from '../hooks/useConversationActions'
import { useSharedConversations, useSharedRequestState } from '../hooks/useSharedConversations'

import { useAuth } from '../components/AuthProvider'
import { authFetch } from '../utils/auth-api'
import { formatRelativeTime } from '../utils/relative-time.js'

const DRAFT_ENDPOINT = '/api/contract-draft'
const DRAFT_TASK_ENDPOINT = '/api/tasks/contract-draft'
const ACCEPTED = '.pdf,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.gif'
const MAX_FILE_SIZE = 80 * 1024 * 1024
const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled']
const isTerminalTask = (status) => TERMINAL_TASK_STATUSES.includes(status)
const hasDraftIntent = (message) => /起草|生成|重写|改写|重新生成|再生成|更新|修订|完善|拟定|编写|写一份|出一版|出一份|形成新稿/i.test(message)
  && /合同|协议|文档|草稿|全文|新稿|一版|版本/i.test(message)
const isCompletedDraft = (message) => message.type === 'draft' && message.draftText && message.completed && !message.failed && !message.interrupted
const TASK_STATUS_LABELS = {
  queued: '任务已排队，等待处理…',
  running: '任务正在处理中…',
  retry_waiting: '任务暂时失败，等待重试…',
  cancel_requested: '正在停止任务…',
  cancelled: '任务已停止。',
  failed: '任务未完成。'
}

const starterPrompts = [
  '起草一份年度采购框架协议，甲方为采购方，重点明确交付、验收与违约责任。',
  '起草一份软件开发服务合同，重点约定需求变更、知识产权和验收标准。',
  '起草一份保密协议，适用于双方在商务合作前交换技术与经营信息。'
]

const createConversation = (title = '新起草任务') => ({
  id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  title,
  messages: [],
  updatedAt: Date.now()
})

const initialConversations = [
  { id: 'annual-purchase', title: '年度采购框架协议', updatedAt: Date.now(), messages: [] },
  { id: 'software-service', title: '软件开发服务合同', updatedAt: Date.now() - 1, messages: [] },
  { id: 'nda', title: '保密协议（通用版）', updatedAt: Date.now() - 2, messages: [] }
]

const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const titleFromInstruction = (instruction) => instruction.replace(/\s+/g, ' ').slice(0, 22) || '合同起草任务'
const isSupported = (file) => ACCEPTED.includes(file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '') && file.size <= MAX_FILE_SIZE
const readStorage = (key, fallback) => { try { return JSON.parse(window.localStorage.getItem(key) || '') || fallback } catch { return fallback } }
const writeStorage = (key, value) => { try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* 存储不可用时不阻断起草 */ } }
const normalizeThreads = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').map((item) => ({ ...item, id: typeof item.id === 'string' ? item.id : createId('draft'), taskId: typeof item.taskId === 'string' ? item.taskId : null, title: typeof item.title === 'string' ? item.title : '历史起草任务', messages: Array.isArray(item.messages) ? item.messages : [], updatedAt: Number(item.updatedAt) || Date.now() })) : []
const normalizeTasks = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && typeof item.threadId === 'string').map((item) => ({ ...item, id: typeof item.id === 'string' ? item.id : createId('task'), title: typeof item.title === 'string' ? item.title : '新起草任务', prompt: typeof item.prompt === 'string' ? item.prompt : '', status: typeof item.status === 'string' ? item.status : '', operation: typeof item.operation === 'string' ? item.operation : '', updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now() })) : []

function DraftDocument({ draftText, pendingItems, confirmed, onConfirm, completed, generating, status, error }) {
  const t = useWorkspaceText()
  if (!draftText) return <div className="draft-document-empty">{generating && <Loader2 size={29} className="spinner" />}<p role="status">{error || t(status || (generating ? "正在生成合同草稿…" : "合同起草未完成。"))}</p></div>
  const contractMarkdown = completed ? draftText
    .replace(/^##\s+待确认信息\s*[\s\S]*?(?=^##\s+合同正文\s*$)/m, '')
    .replace(/^##\s+合同正文\s*$/m, '') : draftText
  return (
    <article className={`draft-document ${completed ? '' : 'draft-document-streaming'}`}>
      {completed && <aside className="draft-confirm-panel">
        <div><ClipboardList size={18} /><strong>{confirmed ? t("信息已确认") : t("待确认信息")}</strong></div>
        <p>{confirmed ? t("仍请在签署前复核交易事实与授权文件。") : t("以下事项会影响合同内容，请确认或补充。")}</p>
        {(pendingItems.length ? pendingItems : [t("正在识别待确认的交易信息…")]).map((item) => (
          <button type="button" key={item} className={confirmed ? 'confirmed' : ''} onClick={onConfirm}>
            <span>{confirmed ? <Check size={13} /> : '•'}</span>{item}
          </button>
        ))}
        <button type="button" className="confirm-all" onClick={onConfirm}>{confirmed ? t("已全部确认") : t("全部确认")}</button>
      </aside>}
      <div className="draft-markdown"><MarkdownBody content={contractMarkdown} /></div>
    </article>
  )
}

function ContractDraftPage() {
  const t = useWorkspaceText()
  const { user } = useAuth()
  const { settings, sidebarCollapsed, initialConversationId, isSideChat } = useWorkspaceLayout()
  const inputRef = useRef(null)
  const searchRef = useRef(null)
  const documentScrollRef = useRef(null)
  const followDraftRef = useRef(true)
  const inFlightRef = useRef(new Set())
  const requestRunsRef = useRef(new Map())
  const watchConversationsRef = useRef(new Set())
  const activeIdRef = useRef('')
  const threadStorageKey = `fafee-history-v2:${user.id}:contract-draft:threads`
  const taskStorageKey = `fafee-history-v2:${user.id}:contract-draft:tasks`
  const [conversations, setConversations] = useSharedConversations(threadStorageKey, () => {
    const saved = normalizeThreads(readStorage(threadStorageKey, []))
    return saved.length ? saved : initialConversations
  }, undefined, createConversation)
  const [tasks, setTasks] = useState(() => isSideChat ? [] : normalizeTasks(readStorage(taskStorageKey, [])))
  const [activeId, setActiveId] = useState(initialConversationId)
  const [instruction, setInstruction] = useState('')
  const [mode, setMode] = useState('thinking')
  const [files, setFiles] = useState([])
  const [requests, setRequests] = useSharedRequestState(threadStorageKey)
  const [documentOpen, setDocumentOpen] = useState(false)
  const [selectedDraftId, setSelectedDraftId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) || conversations[0], [activeId, conversations])
  const latestDraft = useMemo(() => [...(activeConversation?.messages || [])].reverse().find((message) => message.type === 'draft'), [activeConversation])
  const activeDraft = useMemo(() => activeConversation?.messages?.find((message) => message.id === selectedDraftId && message.type === 'draft') || latestDraft, [activeConversation, selectedDraftId, latestDraft])
  const latestDraftId = latestDraft?.id
  const latestMessageId = activeConversation?.messages?.at(-1)?.id
  const activeRequest = requests[activeConversation?.id] || {}
  const isGenerating = Boolean(activeRequest.loading)
  const isDraftGenerating = isGenerating && activeDraft?.id === latestDraftId && Boolean(activeDraft) && !activeDraft.completed && !activeDraft.failed && !activeDraft.interrupted
  const canExportDraft = Boolean(activeDraft && isCompletedDraft(activeDraft))

  useEffect(() => {
    setSelectedDraftId(latestDraftId || '')
    setDocumentOpen(Boolean(latestDraftId && latestDraftId === latestMessageId))
    setConfirmed(false)
    followDraftRef.current = true
  }, [activeConversation?.id, latestMessageId, latestDraftId])
  useEffect(() => {
    const panel = documentScrollRef.current
    if (panel && followDraftRef.current && isDraftGenerating) panel.scrollTop = panel.scrollHeight
  }, [activeDraft?.draftText, documentOpen, isDraftGenerating])

  useEffect(() => { if (conversations.length && !conversations.some((item) => item.id === activeId)) setActiveId(conversations[0].id) }, [activeId, conversations])
  useEffect(() => { activeIdRef.current = activeConversation?.id || '' }, [activeConversation?.id])
  useEffect(() => { if (!isSideChat) writeStorage(taskStorageKey, tasks) }, [taskStorageKey, tasks, isSideChat])
  useEffect(() => {
    const conversation = conversations.find((item) => item.id === activeId)
    const taskMessage = [...(conversation?.messages || [])].reverse().find((message) => message?.taskId)
    const taskId = taskMessage?.taskId || conversation?.taskId
    if (!conversation || !taskId || taskMessage?.completed || taskMessage?.failed || taskMessage?.interrupted) return
    if (requestRunsRef.current.has(conversation.id) || watchConversationsRef.current.has(conversation.id)) return
    const assistantId = taskMessage?.id
    if (!assistantId) return
    let cancelled = false
    watchConversationsRef.current.add(conversation.id)
    fetchTaskDetail(taskId).then((task) => {
      if (cancelled || !task) return
      upsertTask(task, { threadId: conversation.id, title: conversation.title, id: taskId })
      if (isTerminalTask(task.status)) applyDraftTask(conversation.id, assistantId, task)
      else void resumeDraftTask(conversation.id, assistantId, taskId)
    }).catch(() => {}).finally(() => {
      if (!requestRunsRef.current.has(conversation.id)) watchConversationsRef.current.delete(conversation.id)
    })
    return () => { cancelled = true }
  }, [activeId])
  useEffect(() => {
    const onKeyDown = (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus() } }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const updateConversation = (conversationId, updater) => {
    setConversations((items) => items.map((item) => item.id === conversationId ? { ...updater(item), updatedAt: Date.now() } : item))
  }
  const refineConversationTitle = async (conversationId, question) => {
    try {
      const response = await authFetch('/api/conversation-title', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: String(question || '').slice(0, 500) })
      })
      const result = await response.json().catch(() => ({}))
      if (response.ok && result.ok && result.title) {
        updateConversation(conversationId, (conversation) => ({ ...conversation, title: result.title }))
      }
    } catch { /* 标题提炼失败时保留本地标题 */ }
  }
  const appendMessage = (conversationId, message) => updateConversation(conversationId, (conversation) => ({ ...conversation, messages: [...conversation.messages, message] }))
  const updateMessage = (conversationId, messageId, patch) => updateConversation(conversationId, (conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => message.id === messageId ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) } : message)
  }))
  const patchRequest = (conversationId, patch) => setRequests((items) => ({ ...items, [conversationId]: { ...(items[conversationId] || {}), ...patch } }))
  const resetComposer = () => { setInstruction(''); setFiles([]) }
  const fetchTaskDetail = async (taskId) => {
    const response = await authFetch(`/api/tasks/${taskId}`, { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const payload = await response.json().catch(() => ({}))
    return payload.task || null
  }
  const upsertTask = (task, fallback = {}) => {
    const taskId = task?.id || task?.taskId || fallback.id
    if (!taskId) return
    const next = {
      ...fallback,
      ...task,
      id: taskId,
      title: task?.title || fallback.title || '合同起草任务',
      prompt: typeof task?.prompt === 'string' ? task.prompt : (fallback.prompt || ''),
      threadId: task?.threadId || fallback.threadId || '',
      status: task?.status || fallback.status || '',
      operation: task?.operation || fallback.operation || '',
      updatedAt: Date.now()
    }
    setTasks((items) => {
      const index = items.findIndex((item) => item.id === taskId)
      if (index < 0) return [next, ...items]
      const copy = [...items]
      copy[index] = { ...copy[index], ...next }
      return copy
    })
  }
  const uploadFiles = (incoming) => {
    const next = incoming.filter(isSupported).slice(0, 6)
    setFiles(next)
    if (activeConversation?.id) patchRequest(activeConversation.id, {
      error: next.length !== incoming.length ? '仅支持 PDF、Word、PNG、JPG、WebP，且单个文件不超过 80MB。' : ''
    })
  }

  const consumeSSE = async (response, onEvent, signal) => {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('浏览器不支持流式响应')
    const decoder = new TextDecoder()
    let buffer = ''
    const cancelReader = () => { void reader.cancel().catch(() => {}) }
    const consumeBlock = (block) => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || 'message'
      const serialized = [...block.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]).join('\n')
      if (!serialized) return
      let data
      try { data = JSON.parse(serialized) } catch { data = { content: serialized } }
      onEvent(event, data)
    }
    signal?.addEventListener('abort', cancelReader, { once: true })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (signal?.aborted) throw new DOMException('请求已停止', 'AbortError')
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() || ''
        blocks.forEach(consumeBlock)
        if (done) break
      }
      if (buffer.trim()) consumeBlock(buffer)
    } finally {
      signal?.removeEventListener('abort', cancelReader)
    }
  }

  const applyDraftTask = (conversationId, assistantId, task) => {
    if (!task) return
    const result = task.result || {}
    const succeeded = task.status === 'succeeded' && Boolean(result.draftText)
    upsertTask(task, { threadId: conversationId })
    if (succeeded) {
      updateMessage(conversationId, assistantId, {
        type: 'draft',
        taskId: task.id,
        draftText: result.draftText,
        pendingItems: Array.isArray(result.pendingItems) ? result.pendingItems : [],
        title: result.title || task.title || '合同草稿',
        contractType: result.contractType || null,
        operation: result.operation || task.operation || '',
        status: '',
        completed: true,
        failed: false,
        interrupted: false
      })
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        taskId: task.id,
        title: result.title || conversation.title
      }))
      return
    }
    updateMessage(conversationId, assistantId, {
      taskId: task.id,
      status: task.status === 'cancelled' ? TASK_STATUS_LABELS.cancelled : (task.errorSummary || TASK_STATUS_LABELS[task.status] || '合同起草未完成。'),
      completed: false,
      failed: task.status === 'failed',
      interrupted: task.status === 'cancelled'
    })
  }

  const clearCurrentRun = (conversationId, runId) => {
    const current = requestRunsRef.current.get(conversationId)
    if (!current || current.runId !== runId) return false
    requestRunsRef.current.delete(conversationId)
    inFlightRef.current.delete(conversationId)
    watchConversationsRef.current.delete(conversationId)
    patchRequest(conversationId, { loading: false, cancelPending: false })
    return true
  }

  const streamDraftTask = async (conversationId, assistantId, taskId, run) => {
    let sequence = 0
    let latestTask = null
    // 草稿正文是高频增量：本地累积、按时间窗提交，避免每块都重解析整篇 Markdown。
    let draftBuffer = ''
    const draftStream = throttleWithTrailing(() => {
      if (!draftBuffer) return
      updateMessage(conversationId, assistantId, { type: 'draft', draftText: draftBuffer, status: '正在生成合同正文…' })
    }, MARKDOWN_THROTTLE_MS)
    for (let reconnect = 0; reconnect < 20; reconnect += 1) {
      const response = await authFetch(`/api/tasks/${taskId}/events?after=${sequence}`, { headers: { Accept: 'text/event-stream' }, signal: run.controller.signal })
      if (!response.ok || !response.body) throw new Error(await response.text() || '起草任务进度订阅失败。')
      await consumeSSE(response, (event, data) => {
        const eventSequence = Number(data?._seq) || 0
        if (eventSequence && eventSequence <= sequence) return
        sequence = Math.max(sequence, eventSequence)
        if (event === 'stage.start') {
          if (data.stage === 'generation') { draftStream.cancel(); draftBuffer = '' }
          updateMessage(conversationId, assistantId, {
            status: data.label || '正在处理…',
            ...(data.stage === 'generation' ? { type: 'draft', draftText: '', pendingItems: [], completed: false, failed: false, interrupted: false, error: '' } : {})
          })
        }
        if (event === 'draft.delta') {
          if (data.content) { draftBuffer += data.content; draftStream() }
        }
        if (event === 'stage.progress') updateMessage(conversationId, assistantId, { status: data.message || '正在处理…' })
        if (event === 'draft.complete') updateMessage(conversationId, assistantId, { type: 'draft', status: '合同正文已生成，正在保存正式版本…', pendingItems: Array.isArray(data.pendingItems) ? data.pendingItems : [], contractType: data.contractType || null })
        if (event === 'task.retry_waiting') updateMessage(conversationId, assistantId, { status: data.message || TASK_STATUS_LABELS.retry_waiting })
        if (event === 'task.cancel_requested') updateMessage(conversationId, assistantId, { status: TASK_STATUS_LABELS.cancel_requested })
        if (event === 'error') throw Object.assign(new Error(data.message || '合同起草失败。'), { taskFailed: true })
      }, run.controller.signal)
      latestTask = await fetchTaskDetail(taskId)
      if (latestTask && isTerminalTask(latestTask.status)) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    // 收尾前把节流窗口里的最后一段正文落地。
    draftStream.flush()
    if (!latestTask || !isTerminalTask(latestTask.status)) throw new Error('起草任务进度连接中断，请重新打开该对话恢复。')
    applyDraftTask(conversationId, assistantId, latestTask)
    if (latestTask.status === 'failed') throw Object.assign(new Error(latestTask.errorSummary || TASK_STATUS_LABELS[latestTask.status] || '合同起草未完成。'), { taskFailed: true })
  }

  const runLegacyDraft = async ({ conversationId, assistantId, content, history, currentDraft, filesSnapshot, requestMode, run }) => {
    // 兼容 SSE 路径同样是高频增量，按时间窗合并提交。
    let draftBuffer = ''
    let answerBuffer = ''
    const draftStream = throttleWithTrailing(() => {
      if (!draftBuffer) return
      updateMessage(conversationId, assistantId, { draftText: draftBuffer, status: '正在生成合同正文…' })
    }, MARKDOWN_THROTTLE_MS)
    const answerStream = throttleWithTrailing(() => {
      if (!answerBuffer) return
      updateMessage(conversationId, assistantId, { content: answerBuffer, status: '' })
    }, MARKDOWN_THROTTLE_MS)
    const body = filesSnapshot.length ? new FormData() : null
    if (body) {
      body.append('message', content)
      body.append('history', JSON.stringify(history))
      body.append('mode', requestMode)
      if (currentDraft) body.append('currentDraft', JSON.stringify(currentDraft))
      filesSnapshot.forEach((file) => body.append('files', file))
    }
    const response = await authFetch(DRAFT_ENDPOINT, {
      method: 'POST',
      headers: body ? { Accept: 'text/event-stream' } : { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: body || JSON.stringify({ message: content, history, currentDraft, mode: requestMode }),
      signal: run.controller.signal
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || `起草请求失败（${response.status}）`)
    }
    await consumeSSE(response, (event, data) => {
      if (event === 'draft.start') { draftStream.cancel(); draftBuffer = ''; updateMessage(conversationId, assistantId, { type: 'draft', draftText: '', status: data.label || '正在起草合同…', model: data.model }) }
      if (event === 'draft.progress') updateMessage(conversationId, assistantId, { status: data.label || '正在读取参考文件…' })
      if (event === 'draft.type') updateMessage(conversationId, assistantId, { status: data.label || '正在加载合同专项条款框架…', contractType: data })
      if (event === 'draft.delta') { if (data.content) { draftBuffer += data.content; draftStream() } }
      if (event === 'draft.complete') {
        draftStream.cancel()
        draftBuffer = data.draftText || draftBuffer
        updateMessage(conversationId, assistantId, { type: 'draft', draftText: draftBuffer, pendingItems: Array.isArray(data.pendingItems) ? data.pendingItems : [], title: data.title || '合同草稿', status: '', contractType: data.contractType, completed: true, failed: false })
        updateConversation(conversationId, (conversation) => ({ ...conversation, title: data.title || conversation.title }))
      }
      if (event === 'chat.start') {
        updateMessage(conversationId, assistantId, { type: 'assistant', status: data.label || '正在回复…', model: data.model })
        if (activeIdRef.current === conversationId) setDocumentOpen(false)
      }
      if (event === 'chat.delta') { if (data.content) { answerBuffer += data.content; answerStream() } }
      if (event === 'chat.complete') updateMessage(conversationId, assistantId, { status: '', completed: true })
      if (event === 'error') updateMessage(conversationId, assistantId, { failed: true, status: '', error: data.message || '合同起草失败' })
    }, run.controller.signal)
    draftStream.flush()
    answerStream.flush()
  }

  const resumeDraftTask = async (conversationId, assistantId, taskId) => {
    if (!taskId || requestRunsRef.current.has(conversationId)) return
    const run = { runId: createId('request'), controller: new AbortController(), assistantId, taskId, superseded: false }
    requestRunsRef.current.set(conversationId, run)
    inFlightRef.current.add(conversationId)
    patchRequest(conversationId, { loading: true, error: '', cancelPending: false })
    updateMessage(conversationId, assistantId, { type: 'draft', draftText: '', pendingItems: [], failed: false, interrupted: false, completed: false, error: '' })
    try {
      await streamDraftTask(conversationId, assistantId, taskId, run)
    } catch (error) {
      if (!run.superseded && !run.controller.signal.aborted) updateMessage(conversationId, assistantId, { failed: !run.taskId || Boolean(error.taskFailed), status: '', error: error.message || '合同起草失败' })
    } finally {
      clearCurrentRun(conversationId, run.runId)
    }
  }

  const createDraft = async (snapshot = null) => {
    const request = snapshot ? snapshot.text.trim() : instruction.trim()
    const selectedFiles = snapshot ? snapshot.files : files
    const requestMode = snapshot?.mode || mode
    if ((!request && !selectedFiles.length) || isGenerating || !activeConversation || inFlightRef.current.has(activeConversation.id)) return
    const conversationId = activeConversation.id
    const assistantId = createId('assistant')
    const previousDraft = [...activeConversation.messages].reverse().find(isCompletedDraft)
    const recentConversation = activeConversation.messages
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .map((message) => ({ role: message.type === 'user' ? 'user' : 'assistant', content: message.content || '' }))
      .filter((message) => message.content)
    // The full draft is mandatory input via currentDraft, separate from history.
    const history = selectConversationHistory(recentConversation, { question: request, mandatoryText: previousDraft?.draftText || '' }).history
    const currentDraft = previousDraft ? {
      draftText: previousDraft.draftText,
      title: previousDraft.title || activeConversation.title,
      pendingItems: previousDraft.pendingItems || [],
      contractType: previousDraft.contractType || null
    } : null
    const uploadedFiles = selectedFiles.map((file) => ({ name: file.name, size: file.size }))
    const filesSnapshot = [...selectedFiles]
    const content = request || '请结合附件参考材料起草一份规范、可执行的合同初稿。'
    const shouldRefineTitle = activeConversation.messages.length === 0
    const startsDraft = hasDraftIntent(content)
    let resolveReady
    const run = { runId: createId('request'), controller: new AbortController(), assistantId, taskId: null, superseded: false, ready: new Promise((resolve) => { resolveReady = resolve }) }
    appendMessage(conversationId, { id: createId('user'), type: 'user', content, files: uploadedFiles })
    appendMessage(conversationId, { id: assistantId, type: startsDraft ? 'draft' : 'assistant', content: '', draftText: '', pendingItems: [], status: selectedFiles.length ? '正在读取参考文件…' : '正在理解本次需求…' })
    updateConversation(conversationId, (conversation) => ({ ...conversation, title: conversation.messages.length ? conversation.title : titleFromInstruction(request) }))
    if (shouldRefineTitle) void refineConversationTitle(conversationId, [content, ...uploadedFiles.map((file) => file.name)].join('；'))
    if (!snapshot) resetComposer()
    requestRunsRef.current.set(conversationId, run)
    inFlightRef.current.add(conversationId)
    patchRequest(conversationId, { loading: true, error: '', cancelPending: false })
    setDocumentOpen(startsDraft)
    setConfirmed(false)
    followDraftRef.current = true

    try {
      const taskBody = new FormData()
      taskBody.append('message', content)
      taskBody.append('threadId', conversationId)
      taskBody.append('temporary', String(isSideChat))
      taskBody.append('title', activeConversation.title || titleFromInstruction(request))
      taskBody.append('history', JSON.stringify(history))
      taskBody.append('mode', requestMode)
      if (previousDraft?.taskId) taskBody.append('parentTaskId', previousDraft.taskId)
      if (currentDraft) taskBody.append('currentDraft', JSON.stringify(currentDraft))
      filesSnapshot.forEach((file) => taskBody.append('files', file))
      const taskResponse = await authFetch(DRAFT_TASK_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json' }, body: taskBody, signal: run.controller.signal })
      const taskPayload = await taskResponse.json().catch(() => ({}))
      const shouldUseLegacySse = taskPayload.code === 'draft_sse_required' || taskPayload.code === 'draft_intent_clarification'
      if (shouldUseLegacySse) {
        resolveReady()
        await runLegacyDraft({ conversationId, assistantId, content, history, currentDraft, filesSnapshot, requestMode, run })
        return
      }
      if (!taskResponse.ok) throw new Error(taskPayload.error || `起草任务创建失败（${taskResponse.status}）`)
      const taskId = taskPayload.taskId
      if (!taskId) throw new Error('任务服务未返回任务 ID。')
      run.taskId = taskId
      resolveReady()
      updateConversation(conversationId, (conversation) => ({ ...conversation, taskId }))
      updateMessage(conversationId, assistantId, { type: 'draft', taskId, status: TASK_STATUS_LABELS.queued })
      upsertTask(taskPayload.task, { id: taskId, threadId: conversationId, title: taskPayload.task?.title || activeConversation.title, prompt: content, operation: taskPayload.operation, status: taskPayload.status || 'queued' })
      if (run.superseded) {
        await authFetch(`/api/tasks/${taskId}/cancel`, { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => {})
        return
      }
      await streamDraftTask(conversationId, assistantId, taskId, run)
    } catch (error) {
      if (!run.superseded && !run.controller.signal.aborted) updateMessage(conversationId, assistantId, { failed: !run.taskId || Boolean(error.taskFailed), status: '', error: error.message || '合同起草失败' })
    } finally {
      resolveReady()
      if (!run.cancelPending) clearCurrentRun(conversationId, run.runId)
    }
  }

  const cancelDraft = async () => {
    const conversationId = activeConversation?.id
    const run = conversationId ? requestRunsRef.current.get(conversationId) : null
    if (!run || run.cancelPending) return
    run.cancelPending = true
    patchRequest(conversationId, { loading: true, cancelPending: true, error: '' })
    try {
      await run.ready
      if (requestRunsRef.current.get(conversationId) !== run) return
      let task = null
      if (run.taskId) {
        const response = await authFetch(`/api/tasks/${run.taskId}/cancel`, { method: 'POST', headers: { Accept: 'application/json' } })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || '起草任务暂时无法停止。')
        task = payload.task || null
        const deadline = Date.now() + 60000
        while (!isTerminalTask(task?.status)) {
          if (Date.now() >= deadline) throw new Error('尚未确认任务已停止，请稍后重试。')
          await new Promise((resolve) => setTimeout(resolve, 300))
          task = await fetchTaskDetail(run.taskId)
        }
        upsertTask(task, { id: run.taskId, threadId: conversationId })
      }
      run.superseded = true
      run.controller.abort()
      if (task?.status === 'succeeded') applyDraftTask(conversationId, run.assistantId, task)
      else updateMessage(conversationId, run.assistantId, { status: TASK_STATUS_LABELS.cancelled, interrupted: true, completed: false, failed: false })
      clearCurrentRun(conversationId, run.runId)
    } catch (error) {
      run.cancelPending = false
      patchRequest(conversationId, { cancelPending: false, error: error.message || '起草任务暂时无法停止。' })
    }
  }

  const queuedComposer = useComposerSend({ tool: 'contract-draft', conversationId: activeConversation?.id, busy: isGenerating, blocked: Boolean(activeRequest.cancelPending), capture: () => ({ text: instruction, files: [...files], mode }), clear: resetComposer, onSend: createDraft, onStop: cancelDraft })

  const startConversation = () => {
    const next = createConversation()
    setConversations((items) => [next, ...items])
    setActiveId(next.id)
    setDocumentOpen(false)
    resetComposer()
  }
  const deleteConversation = (event, conversationId) => {
    event.stopPropagation()
    if (inFlightRef.current.has(conversationId)) return
    setConversations((items) => { const remaining = items.filter((item) => item.id !== conversationId); return remaining.length ? remaining : [createConversation()] })
    setTasks((items) => items.filter((task) => task.threadId !== conversationId))
    setRequests((items) => { const next = { ...items }; delete next[conversationId]; return next })
    setDocumentOpen(false)
  }
  const createTask = (event) => {
    event.preventDefault()
    const title = taskTitle.trim() || '新起草任务'
    const next = createConversation(title)
    setConversations((items) => [next, ...items]); setActiveId(next.id)
    setInstruction(taskPrompt.trim()); setTaskTitle(''); setTaskPrompt(''); setTaskModalOpen(false); setDocumentOpen(false)
  }
  const openTask = (task) => { setActiveId(task.threadId); setInstruction(task.prompt || ''); setDocumentOpen(false); setFiles([]) }
  const deleteTask = (event, taskId) => { event.stopPropagation(); setTasks((items) => items.filter((task) => task.id !== taskId)) }

  const downloadDraft = () => {
    if (!canExportDraft) return
    const escaped = activeDraft.draftText
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>').replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>').replace(/\n/g, '<br>')
    const blob = new Blob([`<html><head><meta charset="utf-8"></head><body style="font-family:Microsoft YaHei,SimSun,sans-serif;line-height:1.9;color:#111">${escaped}</body></html>`], { type: 'application/msword;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = `${activeDraft.title || activeConversation.title}-初稿.doc`
    anchor.click()
    URL.revokeObjectURL(href)
  }

  const { visibleItems: matchingConversations, titleOf, renderTitle, historyControls, getHistoryMenuProps } = useConversationActions({
    items: conversations, active: activeConversation, toolKey: 'contract-draft', query: historyQuery,
    onNew: startConversation, onSelect: (item) => { setActiveId(item.id); setDocumentOpen(false); resetComposer() }
  })

  return (
    <main className={`contract-chat contract-draft ${settings.analysisPanel && documentOpen ? 'document-expanded' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {!(settings.analysisPanel && documentOpen) && <aside className="chat-sidebar">
        <SidebarSearch inputRef={searchRef} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={t("搜索历史草稿")} />
        <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>{t("法飞飞")}</strong></div>
        <button type="button" className="sidebar-action" onClick={startConversation}><PenLine size={20} />{t("新对话")}</button>
        <button type="button" className="sidebar-action" onClick={() => setTaskModalOpen(true)}><FolderOpen size={20} />{t("新起草任务")}</button>
        <p className="history-label">{t("历史对话")}</p>
        <nav className="history-list">{matchingConversations.map((conversation) => <button type="button" key={conversation.id} {...getHistoryMenuProps(conversation)} className={`${conversation.id === activeConversation.id ? 'selected' : ''}${requests[conversation.id]?.loading ? ' thread-running' : ''}`} onClick={() => { setActiveId(conversation.id); setDocumentOpen(false); resetComposer() }}><span className="history-thread-icon">{requests[conversation.id]?.loading ? <Loader2 size={16} className="spinner" /> : <MessageCircle size={16} />}</span><span className="history-row-copy"><span className="history-row-title">{renderTitle(conversation)}</span><small className="history-row-time">{formatRelativeTime(conversation.updatedAt)}</small></span><i className="history-delete" title={requests[conversation.id]?.loading ? t("处理中，暂不能删除") : t("删除对话")} onClick={(event) => deleteConversation(event, conversation.id)}><Trash2 size={14} /></i></button>)}</nav>
        {tasks.length > 0 && <><p className="history-label task-label">{t("起草任务")}</p><nav className="history-list task-list">{tasks.map((task) => <button type="button" key={task.id} className={task.threadId === activeConversation?.id ? 'selected' : ''} onClick={() => openTask(task)}><FolderOpen size={16} /><span>{task.title}</span><i className="history-delete" title={t("删除任务")} onClick={(event) => deleteTask(event, task.id)}><Trash2 size={14} /></i></button>)}</nav></>}
        {historyControls}
      </aside>}

      <section className="chat-column">
        <header className="chat-header">
          <div className="header-left">{settings.analysisPanel && documentOpen ? <button type="button" className="icon-button" aria-label={t("返回对话")} onClick={() => setDocumentOpen(false)}><ChevronLeft size={21} /></button> : null}</div>
          <div className="chat-title"><strong>{titleOf(activeConversation)}</strong><small>{t("AI 生成内容仅供参考，请结合实际情况判断")}</small></div><div className="header-tools" />
        </header>
        <div className="conversation"><div className="conversation-inner">
          {isSideChat && !activeConversation?.messages?.length && <SideChatEmptyState />}
          {!isSideChat && !activeConversation?.messages?.length && <div className="assistant-turn welcome-turn"><div><p>{t("你好，我是法飞飞合同起草助手。请描述合同类型、合作背景和关键要求；我会为你生成可继续编辑的合同草稿，并提示需要补全的交易信息。")}</p></div></div>}
          {activeConversation?.messages?.map((message) => message.type === 'user'
            ? <div className="user-turn" key={message.id}><p>{message.content}</p>{message.files?.map((file) => <div className="attached-file" key={`${message.id}-${file.name}`}><FileText size={18} /><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></div>)}</div>
            : <div className="assistant-turn result-turn" key={message.id}><div>{message.status && <p className="assistant-status">{!message.interrupted && !message.failed && !message.completed && <Loader2 size={15} className="spinner" />}{t(message.status)}</p>}{message.content && !message.draftText && <MarkdownBody content={message.content} />}{message.draftText && message.completed && <p>{message.content || t("合同初稿已生成。请结合右侧“待确认信息”补全交易事实后再定稿。")}</p>}{message.failed && <small className="message-failed">{message.error || t("合同起草失败，请检查服务配置后重试。")}</small>}{message.draftText && !settings.analysisPanel && <div className="assistant-content draft-inline-output"><MarkdownBody content={message.draftText} /><button type="button" className="tool-text" onClick={() => navigator.clipboard?.writeText(message.draftText)}>{t('复制')}</button></div>}{message.type === 'draft' && <button type="button" className="open-document-card" onClick={() => { setSelectedDraftId(message.id); setConfirmed(false); setDocumentOpen(true) }}><FilePenLine size={25} /><span><strong>{message.title || activeConversation.title}{t("（初稿）")}</strong><small>{message.completed ? <>{t("合同初稿 ·")}{message.pendingItems?.length || 0}{t("项待确认信息 · 点击展开文档")}</> : t(message.error || message.status || "正在生成合同草稿…")}</small></span></button>}</div></div>)}
          {activeRequest.error && <p className="chat-error">{activeRequest.error}</p>}
          {!isSideChat && !activeConversation?.messages?.length && <div className="starter-prompts">{starterPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setInstruction(t(prompt))}>{t(prompt)}<span>→</span></button>)}</div>}
        </div></div>
        <div className="composer-wrap"><div className="composer"><QueuedMessages composer={queuedComposer} /><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); createDraft() } }} placeholder={t("上传参考文件或输入你想起草的合同要求…")} disabled={false} />{files.length > 0 && <div className="pending-files">{files.map((file) => <span key={file.name}><FileText size={14} />{file.name}<button type="button" aria-label={(t("移除 ") + (file.name))} onClick={() => setFiles((items) => items.filter((item) => item !== file))}><X size={13} /></button></span>)}</div>}<div className="composer-bottom"><ToolComposerControls mode={mode} onModeChange={setMode} modeDisabled={isGenerating} onUpload={() => inputRef.current?.click()} uploadLabel={t("上传参考文件")} disabled={false} messages={activeConversation?.messages || []} question={instruction} hasPendingFiles={files.length > 0} /><button type="button" className="voice-send" aria-label={queuedComposer.label || (isGenerating ? t('停止起草任务') : t('发送消息'))} onClick={queuedComposer.send} disabled={Boolean(activeRequest.cancelPending) || (!isGenerating && !instruction.trim() && !files.length)}>{activeRequest.cancelPending ? <Loader2 size={20} className="spinner" /> : isGenerating && !instruction.trim() && !files.length ? <Square size={17} /> : <Send size={19} />}</button></div><input ref={inputRef} hidden type="file" multiple accept={ACCEPTED} onChange={(event) => { uploadFiles([...event.target.files]); event.target.value = '' }} /></div></div>
      </section>

      {settings.analysisPanel && documentOpen && <section className="document-column" aria-label={t("合同草稿")}><header className="document-header"><span>{t("合同草稿")}</span><div><button type="button" disabled={!canExportDraft} onClick={() => navigator.clipboard?.writeText(activeDraft?.draftText || '')}><Copy size={18} />{t("复制")}</button><button type="button" disabled={!canExportDraft} onClick={downloadDraft}><Download size={18} />{t("下载 Word")}</button><button type="button" className="close-document" aria-label={t("关闭合同草稿")} onClick={() => setDocumentOpen(false)}><X size={21} /></button></div></header><div className="document-scroll" ref={documentScrollRef} onScroll={(event) => { const panel = event.currentTarget; followDraftRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80 }}>
          {activeDraft?.draftText && !activeDraft.completed && <p className="draft-stream-status" role="status">{isDraftGenerating && <Loader2 size={15} className="spinner" />}{activeDraft.error || t(activeDraft.status || "正在生成合同草稿…")}</p>}
          <DraftDocument draftText={activeDraft?.draftText || ''} pendingItems={activeDraft?.pendingItems || []} confirmed={confirmed} onConfirm={() => setConfirmed(true)} completed={Boolean(activeDraft?.completed)} generating={isDraftGenerating} status={activeDraft?.status} error={activeDraft?.error} />{activeDraft?.completed && activeDraft?.draftText && <aside className="draft-document-note"><strong>{t("起草说明")}</strong><p>{t("本草稿由 AI 根据当前输入生成；请在签署前核对主体、授权、金额、期限、税务与公司治理等交易事实，并视需要由专业人士复核。")}</p></aside>}</div></section>}
      {taskModalOpen && <div className="task-modal-backdrop" onMouseDown={() => setTaskModalOpen(false)}><form className="task-modal" onSubmit={createTask} onMouseDown={(event) => event.stopPropagation()}><div><strong>{t("新起草对话")}</strong><button type="button" aria-label={t("关闭")} onClick={() => setTaskModalOpen(false)}><X size={19} /></button></div><label>{t("任务名称")}<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder={t("例如：年度采购框架协议")} autoFocus /></label><label>{t("起草要求")}<textarea value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder={t("可填写合同类型、交易背景、主体角色和重点条款")} /></label><p>{t("创建对话后发送要求，完整合同会进入后台任务并支持恢复。")}</p><footer><button type="button" onClick={() => setTaskModalOpen(false)}>{t("取消")}</button><button className="task-primary" type="submit">{t("创建对话")}</button></footer></form></div>}
    </main>
  )
}

export default ContractDraftPage
