import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  ChevronLeft,
  ClipboardList,
  Copy,
  Download,
  FilePenLine,
  FileText,
  FolderOpen,
  History,
  Loader2,
  MessageCircle,
  PanelLeft,
  PenLine,
  Plus,
  Send,
  Trash2,
  X
} from 'lucide-react'
import './ContractRewritePage.css'
import './ContractDraftPage.css'
import ToolOverviewLink from '../components/ToolOverviewLink'
import { useAuth } from '../components/AuthProvider'
import { authFetch } from '../utils/auth-api'

const DRAFT_ENDPOINT = '/api/contract-draft'
const ACCEPTED = '.pdf,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.gif'
const MAX_FILE_SIZE = 80 * 1024 * 1024

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
const normalizeThreads = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').map((item) => ({ ...item, id: typeof item.id === 'string' ? item.id : createId('draft'), title: typeof item.title === 'string' ? item.title : '历史起草任务', messages: Array.isArray(item.messages) ? item.messages : [], updatedAt: Number(item.updatedAt) || Date.now() })) : []
const normalizeTasks = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && typeof item.threadId === 'string').map((item) => ({ ...item, id: typeof item.id === 'string' ? item.id : createId('task'), title: typeof item.title === 'string' ? item.title : '新起草任务', prompt: typeof item.prompt === 'string' ? item.prompt : '' })) : []

function DraftDocument({ draftText, pendingItems, confirmed, onConfirm }) {
  if (!draftText) return <div className="draft-document-empty"><Loader2 size={29} className="draft-spinner" /><p>正在生成合同草稿…</p></div>
  const contractMarkdown = draftText
    .replace(/^##\s+待确认信息\s*[\s\S]*?(?=^##\s+合同正文\s*$)/m, '')
    .replace(/^##\s+合同正文\s*$/m, '')
  return (
    <article className="draft-document">
      <aside className="draft-confirm-panel">
        <div><ClipboardList size={18} /><strong>{confirmed ? '信息已确认' : '待确认信息'}</strong></div>
        <p>{confirmed ? '仍请在签署前复核交易事实与授权文件。' : '以下事项会影响合同内容，请确认或补充。'}</p>
        {(pendingItems.length ? pendingItems : ['正在识别待确认的交易信息…']).map((item) => (
          <button type="button" key={item} className={confirmed ? 'confirmed' : ''} onClick={onConfirm}>
            <span>{confirmed ? <Check size={13} /> : '•'}</span>{item}
          </button>
        ))}
        <button type="button" className="confirm-all" onClick={onConfirm}>{confirmed ? '已全部确认' : '全部确认'}</button>
      </aside>
      <div className="draft-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{contractMarkdown}</ReactMarkdown></div>
    </article>
  )
}

function ContractDraftPage() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const inputRef = useRef(null)
  const searchRef = useRef(null)
  const inFlightRef = useRef(new Set())
  const threadStorageKey = `fafee-history-v2:${user.id}:contract-draft:threads`
  const taskStorageKey = `fafee-history-v2:${user.id}:contract-draft:tasks`
  const [conversations, setConversations] = useState(() => {
    const saved = normalizeThreads(readStorage(threadStorageKey, []))
    return saved.length ? saved : initialConversations
  })
  const [tasks, setTasks] = useState(() => normalizeTasks(readStorage(taskStorageKey, [])))
  const [activeId, setActiveId] = useState('')
  const [instruction, setInstruction] = useState('')
  const [files, setFiles] = useState([])
  const [requests, setRequests] = useState({})
  const [documentOpen, setDocumentOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [taskModalOpen, setTaskModalOpen] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskPrompt, setTaskPrompt] = useState('')
  const activeConversation = useMemo(() => conversations.find((item) => item.id === activeId) || conversations[0], [activeId, conversations])
  const activeDraft = useMemo(() => [...(activeConversation?.messages || [])].reverse().find((message) => message.type === 'draft' && message.draftText), [activeConversation])
  const activeRequest = requests[activeConversation?.id] || {}
  const isGenerating = Boolean(activeRequest.loading)
  const matchingConversations = useMemo(() => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).filter((item) => item.title.toLowerCase().includes(historyQuery.trim().toLowerCase())), [conversations, historyQuery])

  useEffect(() => { if (conversations.length && !conversations.some((item) => item.id === activeId)) setActiveId(conversations[0].id) }, [activeId, conversations])
  useEffect(() => { writeStorage(threadStorageKey, conversations) }, [threadStorageKey, conversations])
  useEffect(() => { writeStorage(taskStorageKey, tasks) }, [taskStorageKey, tasks])
  useEffect(() => {
    const onKeyDown = (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus() } }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const updateConversation = (conversationId, updater) => {
    setConversations((items) => items.map((item) => item.id === conversationId ? { ...updater(item), updatedAt: Date.now() } : item))
  }
  const appendMessage = (conversationId, message) => updateConversation(conversationId, (conversation) => ({ ...conversation, messages: [...conversation.messages, message] }))
  const updateMessage = (conversationId, messageId, patch) => updateConversation(conversationId, (conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => message.id === messageId ? { ...message, ...(typeof patch === 'function' ? patch(message) : patch) } : message)
  }))
  const patchRequest = (conversationId, patch) => setRequests((items) => ({ ...items, [conversationId]: { ...(items[conversationId] || {}), ...patch } }))
  const resetComposer = () => { setInstruction(''); setFiles([]) }
  const uploadFiles = (incoming) => {
    const next = incoming.filter(isSupported).slice(0, 6)
    setFiles(next)
    if (activeConversation?.id) patchRequest(activeConversation.id, {
      error: next.length !== incoming.length ? '仅支持 PDF、Word、PNG、JPG、WebP，且单个文件不超过 80MB。' : ''
    })
  }

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

  const createDraft = async () => {
    const request = instruction.trim()
    if ((!request && !files.length) || isGenerating || !activeConversation || inFlightRef.current.has(activeConversation.id)) return
    const conversationId = activeConversation.id
    const assistantId = createId('assistant')
    const previousDraft = [...activeConversation.messages].reverse().find((message) => message.type === 'draft' && message.draftText)
    const recentConversation = activeConversation.messages
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .slice(-5)
      .map((message) => ({ role: message.type === 'user' ? 'user' : 'assistant', content: message.content || '' }))
      .filter((message) => message.content)
    // 后续重生成必须看见当前草稿；放在最近对话末尾，让模型将它视为待更新版本。
    const history = previousDraft
      ? [...recentConversation, { role: 'assistant', content: `【当前合同草稿，用户可能要求基于此版本调整或重新生成】\n${previousDraft.draftText}` }]
      : recentConversation

    const uploadedFiles = files.map((file) => ({ name: file.name, size: file.size }))
    const content = request || '请结合附件参考材料起草一份规范、可执行的合同初稿。'
    appendMessage(conversationId, { id: createId('user'), type: 'user', content, files: uploadedFiles })
    appendMessage(conversationId, { id: assistantId, type: 'assistant', content: '', draftText: '', pendingItems: [], status: files.length ? '正在读取参考文件…' : '正在理解本次需求…' })
    updateConversation(conversationId, (conversation) => ({ ...conversation, title: conversation.messages.length ? conversation.title : titleFromInstruction(request) }))
    resetComposer()
    inFlightRef.current.add(conversationId)
    patchRequest(conversationId, { loading: true, error: '' })
    setDocumentOpen(false)
    setConfirmed(false)

    try {
      const body = files.length ? new FormData() : null
      if (body) { body.append('message', content); body.append('history', JSON.stringify(history)); files.forEach((file) => body.append('files', file)) }
      const response = await authFetch(DRAFT_ENDPOINT, { method: 'POST', headers: body ? { Accept: 'text/event-stream' } : { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: body || JSON.stringify({ message: content, history }) })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || `起草请求失败（${response.status}）`)
      }
      await consumeSSE(response, (event, data) => {
        if (event === 'draft.start') { updateMessage(conversationId, assistantId, { type: 'draft', status: data.label || '正在起草合同…', model: data.model }); setDocumentOpen(true) }
        if (event === 'draft.progress') updateMessage(conversationId, assistantId, { status: data.label || '正在读取参考文件…' })
        if (event === 'draft.type') updateMessage(conversationId, assistantId, { status: data.label || '正在加载合同专项条款框架…', contractType: data })
        if (event === 'draft.delta') updateMessage(conversationId, assistantId, (current) => ({ draftText: `${current.draftText || ''}${data.content || ''}`, status: '正在生成合同正文…' }))
        if (event === 'draft.complete') {
          updateMessage(conversationId, assistantId, { draftText: data.draftText || '', pendingItems: Array.isArray(data.pendingItems) ? data.pendingItems : [], title: data.title || '合同草稿', status: '', contractType: data.contractType })
          updateConversation(conversationId, (conversation) => ({ ...conversation, title: data.title || conversation.title }))
        }
        if (event === 'chat.start') updateMessage(conversationId, assistantId, { type: 'assistant', status: data.label || '正在回复…', model: data.model })
        if (event === 'chat.delta') updateMessage(conversationId, assistantId, (current) => ({ content: `${current.content || ''}${data.content || ''}`, status: '' }))
        if (event === 'chat.complete') updateMessage(conversationId, assistantId, { status: '' })
        if (event === 'error') updateMessage(conversationId, assistantId, { failed: true, status: '', error: data.message || '合同起草失败' })
      })
    } catch (error) {
      updateMessage(conversationId, assistantId, { failed: true, status: '', error: error.message || '合同起草失败' })
    } finally {
      inFlightRef.current.delete(conversationId)
      patchRequest(conversationId, { loading: false })
    }
  }

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
    setConversations((items) => [next, ...items]); setActiveId(next.id); setTasks((items) => [{ id: createId('task'), title, prompt: taskPrompt.trim(), threadId: next.id, createdAt: Date.now() }, ...items])
    setInstruction(taskPrompt.trim()); setTaskTitle(''); setTaskPrompt(''); setTaskModalOpen(false); setDocumentOpen(false)
  }
  const openTask = (task) => { setActiveId(task.threadId); setInstruction(task.prompt || ''); setDocumentOpen(false); setFiles([]) }
  const deleteTask = (event, taskId) => { event.stopPropagation(); setTasks((items) => items.filter((task) => task.id !== taskId)) }

  const downloadDraft = () => {
    if (!activeDraft?.draftText) return
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

  return (
    <main className={`contract-chat contract-draft ${documentOpen ? 'document-expanded' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      {!documentOpen && <aside className="chat-sidebar">
        <label className="sidebar-search"><History size={17} /><input ref={searchRef} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索历史对话" /><kbd>⌘ K</kbd></label>
        <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>法飞飞</strong></div>
        <button type="button" className="sidebar-action" onClick={startConversation}><PenLine size={20} />新对话</button>
        <button type="button" className="sidebar-action" onClick={() => setTaskModalOpen(true)}><FolderOpen size={20} />新起草任务</button>
        <p className="history-label">历史对话</p>
        <nav className="history-list">{matchingConversations.map((conversation) => <button type="button" key={conversation.id} className={`${conversation.id === activeConversation.id ? 'selected' : ''}${requests[conversation.id]?.loading ? ' thread-running' : ''}`} onClick={() => { setActiveId(conversation.id); setDocumentOpen(false); resetComposer() }}><span className="history-thread-icon">{requests[conversation.id]?.loading ? <Loader2 size={16} className="spinner" /> : <MessageCircle size={16} />}</span><span>{conversation.title}</span><i className="history-delete" title={requests[conversation.id]?.loading ? '处理中，暂不能删除' : '删除对话'} onClick={(event) => deleteConversation(event, conversation.id)}><Trash2 size={14} /></i></button>)}</nav>
        {tasks.length > 0 && <><p className="history-label task-label">起草任务</p><nav className="history-list task-list">{tasks.map((task) => <button type="button" key={task.id} className={task.threadId === activeConversation?.id ? 'selected' : ''} onClick={() => openTask(task)}><FolderOpen size={16} /><span>{task.title}</span><i className="history-delete" title="删除任务" onClick={(event) => deleteTask(event, task.id)}><Trash2 size={14} /></i></button>)}</nav></>}
        <div className="sidebar-footer-wrap">
          <div className="sidebar-footer account-trigger"><span className="footer-avatar">{user.username.slice(0, 1)}</span><span className="account-label"><strong>{user.username}</strong><small>{user.email}</small></span><button type="button" className="account-logout-button" onClick={async () => { if (await logout()) navigate('/auth?mode=login') }} aria-label="退出登录" title="退出登录"><span>退出</span></button></div>
        </div>
      </aside>}

      <section className="chat-column">
        <header className="chat-header">
          <div className="header-left">{documentOpen ? <button type="button" className="icon-button" aria-label="返回对话" onClick={() => setDocumentOpen(false)}><ChevronLeft size={21} /></button> : <><button type="button" className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? '展开历史对话栏' : '折叠历史对话栏'} onClick={() => setSidebarCollapsed((value) => !value)}><PanelLeft size={21} /></button><ToolOverviewLink /></>}</div>
          <div className="chat-title"><strong>{activeConversation?.title || '合同智能起草助手'}</strong><small>AI 生成内容仅供参考，请结合实际情况判断</small></div><div className="header-tools" />
        </header>
        <div className="conversation"><div className="conversation-inner">
          {!activeConversation?.messages?.length && <div className="assistant-turn welcome-turn"><div><p>你好，我是法飞飞合同起草助手。请描述合同类型、合作背景和关键要求；我会为你生成可继续编辑的合同草稿，并提示需要补全的交易信息。</p></div></div>}
          {activeConversation?.messages?.map((message) => message.type === 'user'
            ? <div className="user-turn" key={message.id}><p>{message.content}</p>{message.files?.map((file) => <div className="attached-file" key={`${message.id}-${file.name}`}><FileText size={18} /><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></div>)}</div>
            : <div className="assistant-turn result-turn" key={message.id}><div>{message.status && <p className="assistant-status"><Loader2 size={15} className="spinner" />{message.status}</p>}{message.content && !message.draftText && <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>}{message.draftText && <p>{message.content || '合同初稿已生成。请结合右侧“待确认信息”补全交易事实后再定稿。'}</p>}{message.failed && <small className="message-failed">{message.error || '合同起草失败，请检查服务配置后重试。'}</small>}{message.draftText && <button type="button" className="open-document-card" onClick={() => setDocumentOpen(true)}><FilePenLine size={25} /><span><strong>{message.title || activeConversation.title}（初稿）</strong><small>合同初稿 · {message.pendingItems?.length || 0} 项待确认信息 · 点击展开文档</small></span></button>}</div></div>)}
          {activeRequest.error && <p className="chat-error">{activeRequest.error}</p>}
          {!activeConversation?.messages?.length && <div className="starter-prompts">{starterPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setInstruction(prompt)}>{prompt}<span>→</span></button>)}</div>}
        </div></div>
        <div className="composer-wrap"><div className="composer"><textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); createDraft() } }} placeholder="上传参考文件或输入你想起草的合同要求…" disabled={isGenerating} />{files.length > 0 && <div className="pending-files">{files.map((file) => <span key={file.name}><FileText size={14} />{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles((items) => items.filter((item) => item !== file))}><X size={13} /></button></span>)}</div>}<div className="composer-bottom"><div className="composer-tools"><button type="button" onClick={() => inputRef.current?.click()} title="上传参考文件"><Plus size={24} /></button></div><button type="button" className="voice-send" aria-label="发送消息" onClick={createDraft} disabled={(!instruction.trim() && !files.length) || isGenerating}>{isGenerating ? <Loader2 size={20} className="spinner" /> : <Send size={19} />}</button></div><input ref={inputRef} hidden type="file" multiple accept={ACCEPTED} onChange={(event) => { uploadFiles([...event.target.files]); event.target.value = '' }} /></div></div>
      </section>

      {documentOpen && <section className="document-column"><header className="document-header"><span>合同草稿</span><div><button type="button" disabled={!activeDraft?.draftText} onClick={() => navigator.clipboard?.writeText(activeDraft?.draftText || '')}><Copy size={18} />复制</button><button type="button" disabled={!activeDraft?.draftText} onClick={downloadDraft}><Download size={18} />下载 Word</button><button type="button" className="close-document" aria-label="关闭合同草稿" onClick={() => setDocumentOpen(false)}><X size={21} /></button></div></header><div className="document-scroll"><DraftDocument draftText={activeDraft?.draftText || ''} pendingItems={activeDraft?.pendingItems || []} confirmed={confirmed} onConfirm={() => setConfirmed(true)} />{activeDraft?.draftText && <aside className="draft-document-note"><strong>起草说明</strong><p>本草稿由 AI 根据当前输入生成；请在签署前核对主体、授权、金额、期限、税务与公司治理等交易事实，并视需要由专业人士复核。</p></aside>}</div></section>}
      {taskModalOpen && <div className="task-modal-backdrop" onMouseDown={() => setTaskModalOpen(false)}><form className="task-modal" onSubmit={createTask} onMouseDown={(event) => event.stopPropagation()}><div><strong>新起草任务</strong><button type="button" aria-label="关闭" onClick={() => setTaskModalOpen(false)}><X size={19} /></button></div><label>任务名称<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="例如：年度采购框架协议" autoFocus /></label><label>起草要求<textarea value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder="可填写合同类型、交易背景、主体角色和重点条款" /></label><p>创建后会打开独立对话，并自动带入起草要求。</p><footer><button type="button" onClick={() => setTaskModalOpen(false)}>取消</button><button className="task-primary" type="submit">创建任务</button></footer></form></div>}
    </main>
  )
}

export default ContractDraftPage
