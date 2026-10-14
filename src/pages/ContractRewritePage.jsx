import { reduceReviewPresentation, isReviewProgressVisible } from '../utils/review-presentation.js'
import { throttleWithTrailing, MARKDOWN_THROTTLE_MS } from '../utils/stream-buffer.js'
import MarkdownBody from '../components/MarkdownBody.jsx'
import { selectConversationHistory } from '../utils/context-budget.js'
import { useComposerSend } from '../hooks/useComposerSend'
import QueuedMessages from '../components/QueuedMessages'
import SideChatEmptyState from '../components/SideChatEmptyState'
import SidebarSearch from '../components/SidebarSearch.jsx'
import ToolComposerControls from '../components/ToolComposerControls'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronLeft, Copy, Download, FileText, FolderOpen, Loader2, MessageCircle, PenLine, Plus, Send, Square, Trash2, X, Zap } from 'lucide-react'
import './ContractRewritePage.css'
import ContractWorkbenchLayout from '../components/ContractWorkbenchLayout'
import { useWorkspaceText, useWorkspaceLayout } from '../components/WorkspaceContext'
import { useConversationActions } from '../hooks/useConversationActions'
import { useSharedConversations, useSharedRequestState } from '../hooks/useSharedConversations'

import { useAuth } from '../components/AuthProvider'
import { authFetch } from '../utils/auth-api'
import { formatRelativeTime } from '../utils/relative-time.js'
import { getThreadRequestState, isThreadRequestRunning, patchThreadRequestState } from '../utils/thread-request-state.js'
import {
  ANNOTATION_OPERATIONS,
  ANNOTATION_OPERATION_LABELS,
  annotationTargetOf,
  EMPTY_ANNOTATION_EDITS,
  attachRevisionsToLines,
  buildDisplayRevisions,
  buildRevisionPlainText,
  clearAnnotationEdit,
  countAppliedAnnotationEdits,
  isFileMarker,
  mergeQuoteMarks,
  normalizeAnnotationEdits,
  setAnnotationEdit
} from '../utils/revision-annotations.js'

const TASK_ENDPOINT = '/api/tasks/contract-review'
const CHAT_ENDPOINT = '/api/contract-chat'
const ACCEPTED = '.pdf,.doc,.docx,.rtf,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.gif'
const MAX_FILE_SIZE = 80 * 1024 * 1024
const CLIENT_STORAGE_PREFIX = 'fafee-client-id-v2'

const getExtension = (name = '') => name.toLowerCase().match(/\.[^.]+$/)?.[0] || ''
const isSupported = (file) => ACCEPTED.includes(getExtension(file.name)) && file.size <= MAX_FILE_SIZE
const inline = (text) => text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : <React.Fragment key={index}>{part}</React.Fragment>)
const createId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const hasReviewDocument = (message) => Boolean(message && (
  message.contractText || message.originalText || message.rewrite || message.revisions?.length
))
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
    interrupted: message.interrupted === true,
    originalText: asText(message.originalText),
    contractText: asText(message.contractText),
    rewrite: asText(message.rewrite),
    files,
    revisions: Array.isArray(message.revisions)
      ? message.revisions.filter((rev) => rev && typeof rev === 'object' && !Array.isArray(rev))
      : [],
    // 人工编辑过的批注意见随消息一起持久化，刷新后复制/下载仍是最后确定的版本。
    annotationEdits: normalizeAnnotationEdits(message.annotationEdits),
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
const readOrCreateClientId = (userId) => {
  const storageKey = `${CLIENT_STORAGE_PREFIX}:${userId}`
  try {
    const saved = window.localStorage.getItem(storageKey)
    if (saved && /^[a-zA-Z0-9_-]{12,128}$/.test(saved)) return saved
    const next = window.crypto?.randomUUID?.() || createId('client')
    window.localStorage.setItem(storageKey, next)
    return next
  } catch {
    return createId('client')
  }
}
const displayTitle = (content, fallback = '新对话') => content.trim().replace(/\s+/g, ' ').slice(0, 22) || fallback
const isRequestAbort = (error) => error?.name === 'AbortError' || error?.code === 'REQUEST_ABORTED' || error?.code === 'LLM_REQUEST_ABORTED'
const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'cancelled']
const isTerminalStatus = (status) => TERMINAL_TASK_STATUSES.includes(status)
const STATUS_LABELS = {
  queued: '任务已排队，等待处理。',
  running: '任务正在处理中。',
  retry_waiting: '任务暂时失败，等待重试。',
  cancel_requested: '正在停止任务…',
  cancelled: '任务已取消。',
  failed: '任务未完成。'
}
const createRequestAbortError = () => {
  const error = new Error('请求已停止')
  error.name = 'AbortError'
  error.code = 'REQUEST_ABORTED'
  return error
}
const buildConversationHistory = (messages = [], question = '') => selectConversationHistory(messages
  .map((message) => {
    if (!message?.content || !['user', 'assistant'].includes(message.role)) return null
    const prefix = message.interrupted ? '【上一轮回答在用户插话时被中断，以下内容可能不完整】\n' : ''
    return { role: message.role, content: `${prefix}${message.content}` }
  })
  .filter(Boolean), { question }).history

const LEVEL_META = {
  高: { key: 'high', label: '高风险', cls: 'level-high' },
  中: { key: 'mid', label: '中风险', cls: 'level-mid' },
  低: { key: 'low', label: '低风险', cls: 'level-low' },
  待判断: { key: 'unrated', label: '风险待判断', cls: 'level-unrated' }
}
const levelMeta = (level) => LEVEL_META[level] || LEVEL_META.待判断

const ACTION_META = {
  modify: { label: '修订', cls: 'action-modify' },
  add: { label: '新增', cls: 'action-add' },
  delete: { label: '删除', cls: 'action-delete' }
}
const actionMeta = (action) => ACTION_META[action] || ACTION_META.modify

// 修订稿文档：正文仅高亮真正发生变化的局部片段，并在对应行下方显示紧凑编号修订卡。
// 原句、行号和 quoteSpans 均来自服务端校验，完整条款改写默认折叠，降低长文视觉负担。
// spans 基于原始行偏移，渲染前先扣除 trim 掉的前导空白，避免错位。
// 每条批注支持人工编辑：编辑只覆盖展示字段（意见/批注/处理方式），定位数据仍来自服务端。
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
    parts.push(<span className="quote-mark" key={`m-${index}`}>{inline(text.slice(span.start, span.end))}{span.markerNumbers.length ? <sup className="quote-marker">{span.markerNumbers.slice().sort((a, b) => a - b).join('·')}</sup> : null}</span>)
    cursor = span.end
  })
  if (cursor < text.length) parts.push(<React.Fragment key="tail">{text.slice(cursor)}</React.Fragment>)
  return parts
}

export function RevisionDocument({
  contractText,
  revisions,
  preserveFileMarkers = false,
  annotationEdits = null,
  onAnnotationChange = null,
  onAnnotationReset = null
}) {
  // Server offsets refer to physical source lines. Hide marker presentation,
  // never remove a line before applying those verified offsets.
  const lines = useMemo(() => String(contractText || '').split('\n'), [contractText])
  const displayRevisions = useMemo(
    () => buildDisplayRevisions(Array.isArray(revisions) ? revisions : [], annotationEdits),
    [revisions, annotationEdits]
  )
  // 人工编辑只在传入回调时开启：未接线的页面（如员工手册诊断）保持只读，行为不变。
  const editable = typeof onAnnotationChange === 'function'
  const { byLine, quoteMarks } = useMemo(() => attachRevisionsToLines(lines, displayRevisions), [displayRevisions, lines])
  const renderBlock = (rev) => (
    <SandwichBlock
      key={rev.findingId}
      revision={rev}
      editable={editable}
      edited={Boolean(rev.edited)}
      onSave={editable ? (patch) => onAnnotationChange(rev.findingId, patch, annotationTargetOf(rev)) : null}
      onReset={editable && typeof onAnnotationReset === 'function' ? () => onAnnotationReset(rev.findingId) : null}
    />
  )
  return (
    <article className="contract-document revision-document">
      <section className="contract-body">
        {lines.map((raw, i) => {
          const line = raw.trim()
          const revs = byLine.get(i) || []
          const spans = quoteMarks.get(i)
          if (!preserveFileMarkers && isFileMarker(raw)) return revs.length ? <div className="revision-stack" key={`marker-${i}`}>{revs.map(renderBlock)}</div> : null
          if (!line) return revs.length ? <div className="revision-stack" key={`gap-${i}`}>{revs.map(renderBlock)}</div> : null
          // Keep physical line indices for server-verified annotations, while
          // presenting multi-file boundaries as readable document titles.
          const fileMarker = preserveFileMarkers && line.match(/^=== 文件[：:]\s*(.*?)\s*===$/)
          if (fileMarker) return <h3 className="clause-heading" key={`file-${i}`}>{fileMarker[1]}</h3>
          const heading = line.match(/^(#{1,4})\s+(.+)$/)
          if (heading) {
            const Tag = `h${Math.min(heading[1].length + 1, 4)}`
            return <React.Fragment key={`l-${i}`}>
              <Tag className="clause-heading" data-source-line={i}>{heading[2]}</Tag>
              {revs.length > 0 && <div className="revision-stack">{revs.map(renderBlock)}</div>}
            </React.Fragment>
          }
          return <React.Fragment key={`l-${i}`}>
            <p className="clause-text" data-source-line={i}>{spans ? <MarkedLineText raw={raw} spans={spans} /> : inline(line)}</p>
            {revs.length > 0 && <div className="revision-stack">{revs.map(renderBlock)}</div>}
          </React.Fragment>
        })}
      </section>
    </article>
  )
}

// 批注编辑表单：只改意见文字与处理方式，原片段/行号/高亮位置保持服务端校验结果不变。
function AnnotationEditForm({ revision: rev, edited, onSave, onCancel, onReset }) {
  const t = useWorkspaceText()
  const initial = useMemo(() => ({
    title: rev.title || '',
    operation: rev.isLocalized ? (rev.operation || 'replace') : '',
    rewrittenText: rev.rewrittenText || '',
    noticeText: rev.noticeText || '',
    riskNote: rev.riskNote || '',
    fullRewrittenText: rev.fullRewrittenText || ''
  }), [rev])
  const [draft, setDraft] = useState(initial)
  const update = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }))
  const changeOperation = (event) => {
    const operation = event.target.value
    setDraft((current) => ({
      ...current,
      operation,
      // 提示改成修订时，把提示内容带过去，避免用户面对空白建议框。
      rewrittenText: operation !== 'notice' && !current.rewrittenText.trim() ? current.noticeText : current.rewrittenText
    }))
  }
  const submit = (event) => {
    event?.preventDefault()
    const draftFields = rev.isLocalized ? ['operation', 'rewrittenText', 'noticeText', 'riskNote', 'fullRewrittenText'] : ['title', 'rewrittenText', 'riskNote']
    const patch = {}
    draftFields.forEach((field) => {
      const next = draft[field] ?? ''
      const current = rev[field] ?? ''
      if (next !== current) patch[field] = next
    })
    onSave(patch)
  }
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onCancel(); return }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(event)
  }
  const contentField = rev.isLocalized
    ? (draft.operation === 'notice' ? { field: 'noticeText', label: '提示内容' } : draft.operation === 'delete' ? null : { field: 'rewrittenText', label: '建议修改为' })
    : (rev.action === 'delete' ? null : { field: 'rewrittenText', label: rev.action === 'add' ? '新增条款内容' : '修订后条款' })
  return (
    <form className="annotation-edit-form" onSubmit={submit} onKeyDown={onKeyDown}>
      <p className="annotation-edit-head">
        <b>{rev.isLocalized ? `${t("编辑批注")} #${rev.markerNumber}` : (rev.action === 'add' ? t("新增条款建议") : rev.action === 'delete' ? t("删除条款建议") : t("条款修订建议"))}</b>
        <span>{t("编辑只影响意见内容；原文高亮位置不会改变。")}</span>
      </p>
      {rev.isLocalized && <label className="annotation-field">
        <span>{t("处理方式")}</span>
        <select value={draft.operation} onChange={changeOperation}>
          {ANNOTATION_OPERATIONS.map((operation) => <option key={operation} value={operation}>{t(ANNOTATION_OPERATION_LABELS[operation])}</option>)}
        </select>
      </label>}
      {!rev.isLocalized && <label className="annotation-field">
        <span>{t("批注标题")}</span>
        <input type="text" value={draft.title} onChange={update('title')} placeholder={t("条款调整建议")} />
      </label>}
      {contentField && <label className="annotation-field">
        <span>{t(contentField.label)}</span>
        <textarea rows={4} autoFocus value={draft[contentField.field]} onChange={update(contentField.field)} placeholder={t("填写最终确认给对方的表述")} />
      </label>}
      <label className="annotation-field">
        <span>{t("批注说明")}</span>
        <textarea rows={3} value={draft.riskNote} onChange={update('riskNote')} placeholder={t("说明风险依据、需要确认的事实")} />
      </label>
      {rev.isLocalized && rev.fullRewrittenText && <label className="annotation-field">
        <span>{t("完整条款建议")}</span>
        <textarea rows={4} value={draft.fullRewrittenText} onChange={update('fullRewrittenText')} />
      </label>}
      {rev.originalText && <p className="annotation-origin"><b>{t("原片段")}</b>{rev.originalText}</p>}
      <div className="annotation-edit-actions">
        <button type="submit" className="annotation-primary">{t("保存批注")}</button>
        <button type="button" onClick={onCancel}>{t("取消")}</button>
        {edited && onReset && <button type="button" className="annotation-reset" onClick={() => { onReset(); onCancel() }}>{t("恢复 AI 原稿")}</button>}
        <small>{t("⌘/Ctrl + Enter 保存，Esc 取消")}</small>
      </div>
    </form>
  )
}

function AnnotationActions({ edited, onEdit, onReset }) {
  const t = useWorkspaceText()
  return (
    <div className="annotation-actions">
      {edited && <span className="annotation-edited-badge" title={t("这条意见已被人工修改，复制和下载都按修改后的内容导出。")}>{t("已人工修改")}</span>}
      <button type="button" className="annotation-edit-button" onClick={onEdit}><PenLine size={13} />{t("编辑")}</button>
      {edited && onReset && <button type="button" className="annotation-reset-button" onClick={onReset}>{t("恢复 AI 原稿")}</button>}
    </div>
  )
}

function SandwichBlock({ revision: rev, editable = false, edited = false, onSave, onReset }) {
  const t = useWorkspaceText()
  const [editing, setEditing] = useState(false)
  const meta = levelMeta(rev.level)
  const act = actionMeta(rev.action)
  if (editing) {
    return (
      <div className={`annotation-edit-card ${meta.cls}`}>
        <span className="local-edit-badge">{rev.markerNumber || '·'}</span>
        <AnnotationEditForm
          revision={rev}
          edited={edited}
          onSave={(patch) => { onSave?.(patch); setEditing(false) }}
          onCancel={() => setEditing(false)}
          onReset={onReset}
        />
      </div>
    )
  }
  if (rev.isLocalized) {
    const operationLabel = ANNOTATION_OPERATION_LABELS[rev.operation] || ANNOTATION_OPERATION_LABELS.replace
    const suggestion = rev.operation === 'delete'
      ? '删除该问题片段'
      : rev.operation === 'notice'
        ? (rev.noticeText || rev.riskNote || '请结合实际业务确认并补全该项')
        : (rev.rewrittenText || '请结合批注对该片段作局部调整')
    const showFullRevision = rev.fullRewrittenText && rev.fullRewrittenText !== rev.rewrittenText
    return (
      <div className={`local-edit-card ${meta.cls}${edited ? ' annotation-edited' : ''}`}>
        <span className="local-edit-badge">{rev.markerNumber}</span>
        <div className="local-edit-content">
          <div className="local-edit-suggestion"><span>{t(operationLabel)}</span><strong>{suggestion}</strong></div>
          <details className="local-edit-details">
            <summary>{t("查看批注")}{showFullRevision ? t("与完整修订条款") : ''}</summary>
            <p><b>{t("原片段")}</b>{rev.originalText}</p>
            {rev.riskNote && <p><b>{t("说明")}</b>{rev.riskNote}</p>}
            {showFullRevision && <p className="full-revision"><b>{t("完整条款")}</b>{rev.fullRewrittenText}</p>}
          </details>
          {editable && <AnnotationActions edited={edited} onEdit={() => setEditing(true)} onReset={onReset} />}
        </div>
      </div>
    )
  }
  const preview = rev.action === 'delete'
    ? '建议删除该条款'
    : (rev.rewrittenText || '请参考批注手动修订')
  return (
    <div className={`compact-revision-card ${meta.cls} ${act.cls}${edited ? ' annotation-edited' : ''}`}>
      <div className="compact-revision-head"><span>{t(act.label)}</span><strong>{rev.title || t("条款调整建议")}</strong></div>
      {rev.action === 'add' && rev.anchorText && <p className="compact-anchor">{t("插入于“")}{rev.anchorText}{t("”之后")}</p>}
      <p className="compact-preview">{preview.length > 180 ? `${preview.slice(0, 180)}…` : preview}</p>
      <details>
        <summary>{t("查看完整修订与批注")}</summary>
        {preview.length > 180 && <p><b>{t("完整修订")}</b>{preview}</p>}
        {rev.riskNote && <p><b>{t("批注")}</b>{rev.riskNote}</p>}
      </details>
      {editable && <AnnotationActions edited={edited} onEdit={() => setEditing(true)} onReset={onReset} />}
    </div>
  )
}

// 审查轮次进度面板：在对话气泡中实时展示「第X轮发现/新增了哪些问题」。
// 每轮一个折叠条目，展开后罗列该轮新增的风险点（等级 + 标题 + 位置 + 风险摘要）。
export function ReviewRoundsPanel({ rounds, thinking, finished = false, stoppedEarly = false, activeRound = null, interrupted = false, firstRoundInReport = false }) {
  const t = useWorkspaceText()
  if (!rounds.length && !thinking) return null
  const totalFindings = rounds.reduce((sum, r) => sum + (r.newCount || 0), 0)
  return (
    <div className="review-rounds-panel">
      <div className="rounds-panel-head">
        <span className="rounds-panel-title">{t("三轮审查进度")}</span>
        <span className="rounds-panel-summary">{rounds.length}{t("/3 轮完成")}{stoppedEarly ? t(" · 未发现新问题，审查结束") : ''}{totalFindings > 0 ? (t(" · 累计发现 ") + (totalFindings) + t(" 条问题")) : ''}</span>
      </div>
      <div className="rounds-panel-body">
        {[1, 2, 3].map((roundNum) => {
          const round = rounds.find((r) => r.round === roundNum)
          const isThinking = thinking && !finished && !interrupted && !round && roundNum === (activeRound || rounds.length + 1)
          const isPending = !round && !isThinking
          return (
            <div key={roundNum} className={`round-item ${round ? 'round-done' : ''} ${isThinking ? 'round-thinking' : ''} ${isPending ? 'round-pending' : ''}`}>
              <div className="round-item-head">
                <span className="round-badge">{roundNum}</span>
                <span className="round-label">{roundNum === 1 ? t("首轮审查") : roundNum === 2 ? t("二轮复审") : t("三轮复审")}</span>
                <span className="round-status">
                  {round ? (round.newCount > 0 ? (t("新增 ") + (round.newCount) + t(" 条")) : t("未发现新问题")) : isThinking ? <Loader2 size={13} className="spinner" /> : interrupted && roundNum === activeRound ? t("连接中断") : finished ? stoppedEarly ? t("无需继续") : t("未执行") : t("待开始")}
                </span>
              </div>
              {round && !(firstRoundInReport && roundNum === 1) && round.newFindings?.length > 0 && (
                <ul className="round-findings">
                  {round.newFindings.map((finding, idx) => {
                    const meta = levelMeta(finding.level)
                    return (
                      <li key={idx} className={`round-finding ${meta.cls}`}>
                        <span className={`finding-level-tag ${meta.cls}`}>{meta.label}</span>
                        <span className="finding-title">{finding.title}</span>
                        {finding.location && <span className="finding-location">{finding.location}</span>}
                        {finding.risk && <div className="finding-risk"><MarkdownBody content={finding.risk} /></div>}
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

// Word 批注稿导出：与页面批注卡共用 buildDisplayRevisions(revisions, annotationEdits)，
// 因此下载的一定是人工确认后的最终意见；多行意见保留换行，便于直接发给对方。
export function downloadRevisionWord({ name = '合同审查稿', text = '', documentRevisions = [], annotationEdits = null, preserveFileMarkers = false, suffix = '审查批注稿' } = {}) {
    const revisions = buildDisplayRevisions(Array.isArray(documentRevisions) ? documentRevisions : [], annotationEdits)
    const renderInline = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')
    // 按行号把修订块分组（与 RevisionDocument 的 byLine 逻辑一致：add 挂在 insertAfterLine 后）
    const lines = String(text || '').split('\n')
    const { byLine: revByEndLine, quoteMarks: marksByLine } = attachRevisionsToLines(lines, revisions)
    const renderMarkedLine = (raw, lineIndex) => {
      const spans = marksByLine.get(lineIndex) || []
      if (!spans.length) return renderInline(raw.trim())
      const { text: lineText, merged } = mergeQuoteMarks(raw, spans)
      if (!merged.length) return renderInline(lineText)
      let cursor = 0
      let html = ''
      merged.forEach((mark) => {
        html += renderInline(lineText.slice(cursor, mark.start))
        html += `<span class="mark">${renderInline(lineText.slice(mark.start, mark.end))}${mark.markerNumbers.length ? `<sup>${mark.markerNumbers.slice().sort((a, b) => a - b).join('·')}</sup>` : ''}</span>`
        cursor = mark.end
      })
      return html + renderInline(lineText.slice(cursor))
    }
    const renderRevBlock = (rev) => {
      if (rev.isLocalized) {
        const label = rev.operation === 'delete' ? '删除此处' : rev.operation === 'insert-after' ? '在此后补充' : rev.operation === 'notice' ? '提示' : '改为'
        const replacement = rev.operation === 'delete'
          ? '删除该问题片段'
          : rev.operation === 'notice'
            ? (rev.noticeText || rev.riskNote || '请结合实际业务确认并补全该项')
            : (rev.rewrittenText || '请结合批注局部调整')
        // 与批注卡、复制文本同一口径：只要完整条款建议和局部建议不同就导出，
        // 否则人工改过的「完整条款建议」会静默丢失。
        const fallbackClause = rev.fullRewrittenText && rev.fullRewrittenText !== rev.rewrittenText
          ? `<p class="note"><b>完整条款建议</b>${renderInline(rev.fullRewrittenText)}</p>` : ''
        return `<div class="local-edit"><span class="badge">${rev.markerNumber}</span><div><p><b>${label}</b>${renderInline(replacement)}</p>${rev.riskNote ? `<p class="note"><b>批注</b>${renderInline(rev.riskNote)}</p>` : ''}${fallbackClause}</div></div>`
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
      if (!preserveFileMarkers && isFileMarker(raw)) return revHtml
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
    anchor.href = url; anchor.download = `${name}-${suffix}.doc`; anchor.click(); URL.revokeObjectURL(url)
  }

function ContractRewritePage() {
  const t = useWorkspaceText()
  const { user } = useAuth()
  const { settings, sidebarCollapsed, initialConversationId, isSideChat } = useWorkspaceLayout()
  const inputRef = useRef(null)
  const searchRef = useRef(null)
  const threadEndRef = useRef(null)
  const conversationRef = useRef(null)
  const activeThreadIdRef = useRef('')
  const inFlightThreadsRef = useRef(new Set())
  const requestRunsRef = useRef(new Map())
  const interruptingThreadsRef = useRef(new Set())
  // 已在恢复订阅中的 thread，避免刷新/切换对话时重复挂载同一个任务的事件流。
  const watchThreadsRef = useRef(new Set())
  // 用户是否贴近底部：用于流式输出时决定是否自动跟随滚动
  const stickToBottomRef = useRef(true)
  const threadStorageKey = `fafee-history-v2:${user.id}:contract-review:threads`
  const taskStorageKey = `fafee-history-v2:${user.id}:contract-review:tasks`
  const [threads, setThreads] = useSharedConversations(threadStorageKey, () => {
    const saved = readStorage(threadStorageKey, [], normalizeStoredThreads)
    return saved.length ? saved : [createThread('商业合同审查与批注')]
  }, undefined, createThread)
  const [tasks, setTasks] = useState(() => isSideChat ? [] : readStorage(taskStorageKey, [], normalizeStoredTasks))
  const [activeThreadId, setActiveThreadId] = useState(initialConversationId)
  const [files, setFiles] = useState([])
  const [instruction, setInstruction] = useState('')
  const [mode, setMode] = useState('thinking')
  const [clientId] = useState(() => readOrCreateClientId(user.id))
  const [threadRequests, setThreadRequests] = useSharedRequestState(threadStorageKey)
  const [documentOpen, setDocumentOpen] = useState(false)
  const [documentMessageId, setDocumentMessageId] = useState('')
  const [copiedAt, setCopiedAt] = useState(0)
  const [historyQuery, setHistoryQuery] = useState('')
  const threadsRef = useRef(threads)

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

  useEffect(() => {
    if (threads.length && !threads.some((thread) => thread.id === activeThreadId)) setActiveThreadId(threads[0].id)
  }, [activeThreadId, threads])

  // 「已复制」只在复制成功后短暂提示，避免按钮文案长期停留。
  useEffect(() => {
    if (!copiedAt) return undefined
    const timer = window.setTimeout(() => setCopiedAt(0), 2200)
    return () => window.clearTimeout(timer)
  }, [copiedAt])

  useEffect(() => { activeThreadIdRef.current = activeThread?.id || '' }, [activeThread?.id])
  useEffect(() => { threadsRef.current = threads }, [threads])

  useEffect(() => { if (!isSideChat) writeStorage(taskStorageKey, tasks) }, [taskStorageKey, tasks, isSideChat])

  // 后台任务入口收敛后，历史对话的 taskId 是用户查看后台任务状态的唯一入口。
  // 只在切换对话时触发一次；进行中的状态由 requestRunsRef / watchThreadsRef 去重，
  // 不能依赖 threads，否则每条流式消息都会重跑并造成恢复风暴。
  useEffect(() => {
    const thread = threadsRef.current.find((item) => item.id === activeThreadId)
    if (!thread?.taskId) return
    if (requestRunsRef.current.has(thread.id) || watchThreadsRef.current.has(thread.id)) return
    const lastMessage = thread.messages[thread.messages.length - 1]
    if (lastMessage?.role === 'assistant' && ((lastMessage.completed && hasReviewDocument(lastMessage)) || lastMessage.interrupted || lastMessage.failed)) return
    const assistantId = lastMessage?.role === 'assistant' ? lastMessage.id : null
    let cancelled = false
    watchThreadsRef.current.add(thread.id)
    fetchTaskDetail(thread.taskId).then((task) => {
      if (cancelled || !task) return
      if (isTerminalStatus(task.status)) {
        if (assistantId) applyRecoveredTask(thread.id, assistantId, task)
        return
      }
      if (assistantId) void resumeThreadTask(thread.id, thread.taskId, assistantId)
    }).catch(() => {}).finally(() => {
      if (requestRunsRef.current.has(thread.id)) return
      watchThreadsRef.current.delete(thread.id)
    })
    return () => { cancelled = true }
  }, [activeThreadId])

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
  const refineThreadTitle = async (threadId, question) => {
    try {
      const response = await authFetch('/api/conversation-title', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: String(question || '').slice(0, 500) })
      })
      const result = await response.json().catch(() => ({}))
      if (response.ok && result.ok && result.title) updateThread(threadId, (thread) => ({ ...thread, title: result.title }))
    } catch { /* 标题提炼失败时保留本地标题 */ }
  }
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
  const uploadFiles = (incoming) => {
    const next = incoming.filter(isSupported).slice(0, 6)
    if (activeThread?.id) updateThreadRequest(activeThread.id, {
      error: next.length !== incoming.length ? '仅支持 PDF、Word、PNG、JPG、WebP，且单个文件不超过 80MB。' : ''
    })
    setFiles(next)
  }

  const readSSE = async (response, onEvent, signal) => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    const cancelReader = () => { void reader.cancel().catch(() => {}) }
    if (signal?.aborted) {
      cancelReader()
      throw createRequestAbortError()
    }
    signal?.addEventListener('abort', cancelReader, { once: true })
    try {
      while (true) {
        if (signal?.aborted) throw createRequestAbortError()
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
      if (signal?.aborted) throw createRequestAbortError()
    } finally {
      signal?.removeEventListener('abort', cancelReader)
      reader.releaseLock()
    }
  }

  const clearCurrentRun = (threadId, runId) => {
    const current = requestRunsRef.current.get(threadId)
    if (!current || current.runId !== runId) return false
    requestRunsRef.current.delete(threadId)
    inFlightThreadsRef.current.delete(threadId)
    updateThreadRequest(threadId, { loading: false, stage: '', cancelPending: false })
    return true
  }

  const fetchTaskDetail = async (taskId) => {
    const response = await authFetch(`/api/tasks/${taskId}`, { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const payload = await response.json().catch(() => ({}))
    return payload.task || null
  }

  const waitForTaskTerminal = async (taskId, attempts = 120) => {
    let latest = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await fetchTaskDetail(taskId)
      if (latest && ['succeeded', 'failed', 'cancelled'].includes(latest.status)) return latest
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return latest
  }

  const markRunInterrupted = (threadId, run, status) => {
    const patch = {
      interrupted: true,
      interruptedAt: Date.now(),
      completed: false,
      failed: false,
      status,
      phase: '',
      revisions: [],
      contractText: '',
      originalText: ''
    }
    if (run.partialContent) patch.content = run.partialContent
    updateMessage(threadId, run.assistantId, patch)
    return { id: run.assistantId, role: 'assistant', content: run.partialContent || '', interrupted: true }
  }

  // 未终态任务在页面重新打开后继续订阅事件，回填最终结果或终态状态。
  const resumeThreadTask = async (threadId, taskId, assistantId) => {
    if (!taskId || !assistantId) return
    let seq = 0
    const controller = new AbortController()
    const run = { runId: createId('request'), controller, assistantId, taskId, partialContent: '', superseded: false, kind: 'task' }
    requestRunsRef.current.set(threadId, run)
    inFlightThreadsRef.current.add(threadId)
    watchThreadsRef.current.add(threadId)
    updateThreadRequest(threadId, { loading: true, error: '', cancelPending: false, stage: 'resuming' })
    let analysis = ''
    let review = ''
    let reviewRounds = []
    let presentation = {}
    // 恢复/重连路径同样按时间窗合并正文提交。
    const analysisStream = throttleWithTrailing(() => {
      updateMessage(threadId, assistantId, { content: analysis, analysis, status: '正在分析合同结构…' })
    }, MARKDOWN_THROTTLE_MS)
    const reviewStream = throttleWithTrailing(({ content }) => {
      updateMessage(threadId, assistantId, { content, analysis, review, reviewRounds, status: '正在审查风险条款…' })
    }, MARKDOWN_THROTTLE_MS)
    try {
      for (let reconnect = 0; reconnect < 20; reconnect += 1) {
        const response = await authFetch(`/api/tasks/${taskId}/events?after=${seq}`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal })
        if (!response.ok || !response.body) throw new Error('任务进度订阅失败。')
        await readSSE(response, (event, data) => {
          seq = Math.max(seq, Number(data?._seq) || 0)
          const nextPresentation = reduceReviewPresentation(presentation, event, data)
          if (nextPresentation !== presentation) updateMessage(threadId, assistantId, nextPresentation)
          presentation = nextPresentation
          if (event === 'stage.start') {
            if (data.stage === 'analysis') {
              analysis = ''
              run.partialContent = ''
              updateMessage(threadId, assistantId, { content: '', analysis: '' })
            }
            updateThreadRequest(threadId, { stage: data.stage || '' })
            updateMessage(threadId, assistantId, { status: data.label || '正在处理…' })
          }
          if (event === 'stage.progress') updateMessage(threadId, assistantId, { status: data.message || '正在处理…' })
          if (event === 'review.round' && data.phase === 'end') {
            reviewRounds = [...reviewRounds.filter((item) => item.round !== data.round), {
              round: data.round, newCount: data.newCount, newFindings: data.newFindings || []
            }]
            updateMessage(threadId, assistantId, { reviewRounds })
          }
          if (event === 'stage.complete' && data.stage === 'review' && Array.isArray(data.roundSnapshots)) {
            reviewRounds = data.roundSnapshots
            updateMessage(threadId, assistantId, { reviewRounds })
          }
          // 兼容 SSE 路径同样走节流与实时正文语义。
          if (event !== 'analysis.delta' && event !== 'review.delta') { analysisStream.flush(); reviewStream.flush() }
          if (event === 'analysis.delta') { analysis += data.content || ''; run.partialContent = analysis; analysisStream() }
          if (event === 'review.delta') {
            review = data.replace ? (data.content || '') : review + (data.content || '')
            const combined = data.live ? review
              : typeof presentation.firstRoundReport === 'string' ? presentation.firstRoundReport : analysis ? `${analysis}\n\n---\n\n${review}` : review
            run.partialContent = combined
            reviewStream({ content: combined })
          }
        }, controller.signal)
        analysisStream.flush()
        reviewStream.flush()
        const detail = await fetchTaskDetail(taskId)
        if (detail && isTerminalStatus(detail.status)) return applyRecoveredTask(threadId, assistantId, detail)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      updateThreadRequest(threadId, { error: '任务进度连接中断，请稍后重新打开该对话恢复。' })
    } catch (resumeError) {
      if (!run.superseded) updateThreadRequest(threadId, { error: resumeError.message || '任务恢复未完成。' })
    } finally {
      const current = requestRunsRef.current.get(threadId)
      if (current?.runId === run.runId && !run.superseded && !run.cancelPending) clearCurrentRun(threadId, run.runId)
      watchThreadsRef.current.delete(threadId)
    }
  }

  const applyRecoveredTask = (threadId, assistantId, task) => {
    const result = task?.result || {}
    updateMessage(threadId, assistantId, {
      content: (() => {
        const analysis = result.analysis || ''
        const review = result.review || ''
        return typeof result.firstRoundReport === 'string' ? result.firstRoundReport : analysis ? (review ? `${analysis}\n\n---\n\n${review}` : analysis) : (review || task?.errorSummary || '合同审查已完成。')
      })(),
      firstRoundReport: result.firstRoundReport,
      firstRoundComplete: Boolean(result.reviewRounds?.some((round) => Number(round.round) === 1)),
      reviewFinished: result.reviewComplete !== false,
      reviewStoppedEarly: result.reviewRounds?.at(-1)?.round < 3 && result.reviewRounds?.at(-1)?.newCount === 0,
      activeReviewRound: null,
      analysis: result.analysis || '',
      review: result.review || '',
      reviewRounds: Array.isArray(result.reviewRounds) ? result.reviewRounds : [],
      originalText: result.contractText || '',
      contractText: result.contractText || '',
      revisions: Array.isArray(result.revisions) ? result.revisions : [],
      rewriteStats: result.stats || null,
      phase: result.contractText || result.revisions?.length ? 'rewrite' : '',
      status: task?.status === 'succeeded' ? '' : (task?.errorSummary || STATUS_LABELS[task.status] || ''),
      completed: task?.status === 'succeeded',
      failed: task?.status === 'failed',
      taskId: task.id,
      reviewComplete: result.reviewComplete,
      interrupted: task?.status === 'cancelled'
    })
    return task
  }

  const continueReview = async (message) => {
    try {
      const response = await authFetch(`/api/tasks/${message.taskId}/retry`, { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || '暂时无法继续核对，请稍后再试。')
      updateMessage(activeThread.id, message.id, { failed: false, status: '继续核对尚未完成的内容…' })
      void resumeThreadTask(activeThread.id, message.taskId, message.id)
    } catch (error) { updateThreadRequest(activeThread.id, { error: error.message }) }
  }

  const interruptActiveRequest = async (threadId, { waitForTask = false } = {}) => {
    const run = requestRunsRef.current.get(threadId)
    if (!run) return null
    if (run.interruptPromise) return run.interruptPromise
    interruptingThreadsRef.current.add(threadId)
    run.cancelPending = true
    run.interruptPromise = (async () => {
      updateThreadRequest(threadId, { loading: true, cancelPending: true, stage: 'cancelling' })
      // Do not abort creation: its response is needed to cancel the actual server job.
      await run.ready
      let task = null
      if (run.taskId) {
        const response = await authFetch(`/api/tasks/${run.taskId}/cancel`, { method: 'POST', headers: { Accept: 'application/json' } })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || '上一轮审查任务暂时无法停止。')
        task = payload.task || null
        if (waitForTask && !['succeeded', 'failed', 'cancelled'].includes(task?.status)) {
          task = await waitForTaskTerminal(run.taskId)
          if (!task || !['succeeded', 'failed', 'cancelled'].includes(task.status)) throw new Error('上一轮审查仍在停止中，请稍后再提交。')
        }
      }
      run.superseded = true
      run.controller.abort()
      const interruptedMessage = markRunInterrupted(threadId, run, task?.status === 'succeeded' ? '上一轮已完成，已插入新消息' : '已被新消息打断')
      clearCurrentRun(threadId, run.runId)
      return { task, interruptedMessage }
    })().catch((error) => {
      run.cancelPending = false
      updateThreadRequest(threadId, { loading: true, cancelPending: false, stage: '', error: error.message || '上一轮请求暂时无法停止。' })
      throw error
    }).finally(() => {
      run.interruptPromise = null
      interruptingThreadsRef.current.delete(threadId)
    })
    return run.interruptPromise
  }

  const sendMessage = async (snapshot = null) => {
    if (!activeThread) return
    const threadId = activeThread.id
    const instructionSnapshot = snapshot ? snapshot.text.trim() : instruction.trim()
    const filesSnapshot = snapshot ? snapshot.files : [...files]
    const hasNewInput = Boolean(instructionSnapshot || filesSnapshot.length)
    let interruption = null
    const existingRun = requestRunsRef.current.get(threadId)
    if (existingRun) {
      if (interruptingThreadsRef.current.has(threadId)) return
      if (!hasNewInput) {
        await interruptActiveRequest(threadId)
        return
      }
      interruption = await interruptActiveRequest(threadId, { waitForTask: filesSnapshot.length > 0 })
    }
    if (requestRunsRef.current.has(threadId) || interruptingThreadsRef.current.has(threadId) || !hasNewInput) return

    const sourceThread = threadsRef.current.find((thread) => thread.id === threadId) || activeThread
    let historyMessages = sourceThread.messages || []
    if (interruption?.interruptedMessage) {
      historyMessages = historyMessages.map((message) => message.id === interruption.interruptedMessage.id
        ? { ...message, ...interruption.interruptedMessage }
        : message)
    }
    const requestMode = snapshot?.mode || mode
    const content = instructionSnapshot || '请根据合同类型匹配知识库中的优秀模板和已批注风险案例，完成合规审查并生成带修改说明的合同稿。'
    const history = buildConversationHistory(historyMessages, content)
    const uploadedFiles = filesSnapshot.map((file) => ({ name: file.name, size: file.size }))
    const userMessage = { id: createId('message'), role: 'user', content, files: uploadedFiles, createdAt: Date.now() }
    const shouldRefineTitle = sourceThread.messages.length === 0
    const assistantId = createId('message')
    let resolveReady
    const run = {
      ready: new Promise((resolve) => { resolveReady = resolve }),
      runId: createId('request'),
      controller: new AbortController(),
      assistantId,
      taskId: null,
      partialContent: '',
      superseded: false,
      kind: uploadedFiles.length ? 'task' : 'chat'
    }
    requestRunsRef.current.set(threadId, run)
    inFlightThreadsRef.current.add(threadId)
    appendMessage(threadId, userMessage)
    if (shouldRefineTitle) void refineThreadTitle(threadId, [content, ...uploadedFiles.map((file) => file.name)].join('；'))
    appendMessage(threadId, { id: assistantId, role: 'assistant', content: '', mode: requestMode, createdAt: Date.now(), status: uploadedFiles.length ? '正在读取合同文件…' : '正在思考…' })
    if (!snapshot) { setInstruction(''); setFiles([]) }
    updateThreadRequest(threadId, { loading: true, error: '', cancelPending: false, stage: uploadedFiles.length ? 'parsing' : 'chat', mode: requestMode })
    let analysis = ''
    let review = ''
    let originalText = ''
    let rewriteRevisions = []
    let rewriteStats = null
    let reviewRounds = []
    let presentation = {}
    try {
      if (uploadedFiles.length) {
        const form = new FormData()
        form.append('message', content)
        form.append('mode', requestMode)
        form.append('threadId', threadId)
        form.append('temporary', String(isSideChat))
        form.append('title', sourceThread.title || '商业合同审查')
        form.append('history', JSON.stringify(history))
        filesSnapshot.forEach((file) => form.append('files', file))
        const response = await authFetch(TASK_ENDPOINT, { method: 'POST', headers: { Accept: 'application/json', 'X-Client-ID': clientId }, body: form, signal: run.controller.signal })
        const createdPayload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(createdPayload.error || '审查任务暂不可用。')
        const taskId = createdPayload.taskId
        if (!taskId) throw new Error('任务服务未返回任务 ID。')
        run.taskId = taskId
        resolveReady()
        updateThread(threadId, (thread) => ({ ...thread, taskId }))
        let lastEventSeq = 0
        // 正文节流：结构分析与实时审查正文都是高频增量，逐块 setState 会让整篇
        // Markdown 每块重解析一次（O(n²)）。按 MARKDOWN_THROTTLE_MS 合并提交。
        const analysisStream = throttleWithTrailing(() => {
          updateMessage(threadId, assistantId, { content: analysis, analysis, status: '正在分析合同结构…' })
        }, MARKDOWN_THROTTLE_MS)
        const reviewStream = throttleWithTrailing(({ content }) => {
          updateMessage(threadId, assistantId, { content, analysis, review, reviewRounds, status: '正在审查风险条款…' })
        }, MARKDOWN_THROTTLE_MS)
        const applyTaskEvent = (event, data) => {
          // 非增量事件按顺序落盘：先冲刷节流缓冲，避免正文顺序错乱。
          if (event !== 'analysis.delta' && event !== 'review.delta') {
            analysisStream.flush()
            reviewStream.flush()
          }
          lastEventSeq = Math.max(lastEventSeq, Number(data?._seq) || 0)
          const nextPresentation = reduceReviewPresentation(presentation, event, data)
          if (nextPresentation !== presentation) updateMessage(threadId, assistantId, nextPresentation)
          presentation = nextPresentation
          if (event === 'stage.start') {
            if (data.stage === 'analysis') {
              analysis = ''
              run.partialContent = ''
              updateMessage(threadId, assistantId, { content: '', analysis: '' })
            }
            updateThreadRequest(threadId, { stage: data.stage || '' })
            updateMessage(threadId, assistantId, { status: data.label || '正在处理…' })
          }
          if (event === 'stage.progress') {
            updateMessage(threadId, assistantId, { status: data.message || '正在处理…' })
          }
          if (event === 'stage.complete' && data.stage === 'review' && Array.isArray(data.roundSnapshots)) {
            reviewRounds = data.roundSnapshots
            updateMessage(threadId, assistantId, { reviewRounds })
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
          if (event === 'analysis.delta') { analysis += data.content || ''; run.partialContent = analysis; analysisStream() }
          if (event === 'review.delta') {
            review = data.replace ? (data.content || '') : review + (data.content || '')
            // 实时审查正文（live）自身已包含分析+发现，跨轮持续刷新；
            // 首轮报告仍按既有语义优先，避免与 firstRoundReport 契约冲突。
            const combined = data.live ? review
              : typeof presentation.firstRoundReport === 'string' ? presentation.firstRoundReport : analysis ? `${analysis}\n\n---\n\n${review}` : review
            run.partialContent = combined
            reviewStream({ content: combined })
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
          if (event === 'rewrite.delta') {
            // 逐批修订增量：右栏批注稿可以边生成边看，不必等全部批次结束。
            updateThreadRequest(threadId, { stage: 'rewrite' })
            if (Array.isArray(data.revisions)) rewriteRevisions = data.revisions
            if (data.contractText) originalText = data.contractText
            rewriteStats = { ...(rewriteStats || {}), done: data.done || 0, total: data.total || 0, blocks: rewriteRevisions.length }
            updateMessage(threadId, assistantId, {
              contractText: originalText,
              originalText,
              revisions: rewriteRevisions,
              rewriteStats,
              status: `正在生成批注稿 ${data.done || 0}/${data.total || 0}…`
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
          if (event === 'error') updateThreadRequest(threadId, { error: data.message || '审查暂未完成，已完成进度保留。' })
        }
        let latestTask = null
        for (let reconnect = 0; reconnect < 20; reconnect += 1) {
          const eventResponse = await authFetch(`/api/tasks/${taskId}/events?after=${lastEventSeq}`, { headers: { Accept: 'text/event-stream' }, signal: run.controller.signal })
          if (!eventResponse.ok || !eventResponse.body) throw new Error(await eventResponse.text() || '任务进度订阅失败。')
          await readSSE(eventResponse, applyTaskEvent, run.controller.signal)
          const detail = await fetchTaskDetail(taskId)
          if (detail) {
            latestTask = detail
            if (latestTask && ['succeeded', 'failed', 'cancelled'].includes(latestTask.status)) break
          }
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        if (!latestTask || !['succeeded', 'failed', 'cancelled'].includes(latestTask.status)) throw new Error('任务进度连接中断，请稍后从任务列表恢复。')
        const persistedResult = latestTask.result || {}
        if (persistedResult.analysis) analysis = persistedResult.analysis
        if (persistedResult.review) review = persistedResult.review
        if (Array.isArray(persistedResult.reviewRounds)) reviewRounds = persistedResult.reviewRounds
        if (!originalText && persistedResult.contractText) originalText = persistedResult.contractText
        if (!rewriteRevisions.length && Array.isArray(persistedResult.revisions)) rewriteRevisions = persistedResult.revisions
        if (!rewriteStats && persistedResult.stats) rewriteStats = persistedResult.stats
        if (latestTask.status !== 'succeeded') {
          applyRecoveredTask(threadId, assistantId, latestTask)
          if (persistedResult.contractText && activeThreadIdRef.current === threadId) { setDocumentMessageId(assistantId); setDocumentOpen(true) }
          return
        }
        const firstRoundReport = typeof persistedResult.firstRoundReport === 'string' ? persistedResult.firstRoundReport : presentation.firstRoundReport
        // 收尾正文用「完整报告」（分析 + 已归并的三轮审查结果）：此前只取首轮报告，
        // 第 2/3 轮的发现与归并结果在正文里永远看不到。首轮报告仍单独保存供轮次面板使用。
        const completeReport = analysis ? (review ? `${analysis}\n\n---\n\n${review}` : analysis) : review
        const finalContent = completeReport || (typeof firstRoundReport === 'string' ? firstRoundReport : '') || '合同审查已完成。'
        analysisStream.flush()
        reviewStream.flush()
        updateMessage(threadId, assistantId, {
          content: finalContent,
          firstRoundReport,
          firstRoundComplete: Boolean(reviewRounds.some((round) => Number(round.round) === 1)),
          reviewFinished: true,
          reviewStoppedEarly: reviewRounds.at(-1)?.round < 3 && reviewRounds.at(-1)?.newCount === 0,
          activeReviewRound: null,
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
        resolveReady()
        const response = await authFetch(CHAT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Client-ID': clientId }, body: JSON.stringify({ message: content, mode: requestMode, threadId, history }), signal: run.controller.signal })
        if (!response.ok || !response.body) throw new Error(await response.text() || '对话服务暂不可用。')
        let answer = ''
        await readSSE(response, (event, data) => {
          if (event === 'chat.start') updateMessage(threadId, assistantId, { model: data.model, status: requestMode === 'thinking' ? '正在深度思考…' : '正在快速回复…' })
          if (event === 'chat.delta') { answer += data.content || ''; run.partialContent = answer; updateMessage(threadId, assistantId, { content: answer, status: '' }) }
          if (event === 'error') throw new Error(data.message || '对话未完成，请稍后重试。')
        }, run.controller.signal)
        updateMessage(threadId, assistantId, { status: '', completed: true })
      }
    } catch (requestError) {
      if (!run.superseded) {
        if (isRequestAbort(requestError)) {
          const interruptedMessage = markRunInterrupted(threadId, run, '已停止生成')
          void interruptedMessage
        } else {
          updateMessage(threadId, assistantId, { content: run.partialContent || '本次处理未完成。', status: '', failed: true })
          updateThreadRequest(threadId, { error: requestError.message || '请求未完成，请稍后重试。' })
        }
      }
    } finally {
      resolveReady()
      const current = requestRunsRef.current.get(threadId)
      if (current?.runId === run.runId && !run.superseded && !run.cancelPending) clearCurrentRun(threadId, run.runId)
    }
  }
  const openTask = (task) => { selectConversation(task.threadId); setInstruction(task.prompt || ''); setMode(task.mode || 'thinking') }
  const deleteTask = (event, taskId) => { event.stopPropagation(); setTasks((items) => items.filter((task) => task.id !== taskId)) }
  const openDocument = (messageId) => { setDocumentMessageId(messageId); setDocumentOpen(true) }

  // 导出 Word：沿用页面的局部编号批注，避免导出后重新退化成整段三明治卡片。
  const { visibleItems: matchingThreads, titleOf, renderTitle, historyControls, getHistoryMenuProps } = useConversationActions({
    items: threads, active: activeThread, toolKey: 'contract-review', query: historyQuery,
    onNew: () => createConversation(), onSelect: (item) => selectConversation(item.id)
  })

  // 人工编辑的批注重写：按批注 id 覆盖意见字段，随消息持久化；复制与下载都从这里取最终版本。
  const documentAnnotationEdits = selectedDocument?.annotationEdits && Object.keys(selectedDocument.annotationEdits).length
    ? selectedDocument.annotationEdits
    : EMPTY_ANNOTATION_EDITS
  // 只统计锚点仍然对得上的编辑，避免标题栏出现“有修改但看不到”的计数。
  const editedAnnotationCount = countAppliedAnnotationEdits(documentRevisions, documentAnnotationEdits)
  const patchDocumentAnnotationEdits = (updater) => {
    if (!selectedDocument?.id) return
    updateMessage(activeThread.id, selectedDocument.id, { annotationEdits: updater(documentAnnotationEdits) })
  }
  const handleAnnotationChange = (key, patch, target) => patchDocumentAnnotationEdits((edits) => setAnnotationEdit(edits, key, patch, target))
  const handleAnnotationReset = (key) => patchDocumentAnnotationEdits((edits) => clearAnnotationEdit(edits, key))
  const handleResetAllAnnotations = () => patchDocumentAnnotationEdits(() => EMPTY_ANNOTATION_EDITS)
  const exportWord = () => downloadRevisionWord({
    name: activeThread?.title,
    text: documentContractText || selectedDocument?.rewrite || '',
    documentRevisions,
    annotationEdits: documentAnnotationEdits
  })
  const copyAnnotatedDocument = () => {
    const content = buildRevisionPlainText({
      title: activeThread?.title || '商业合同审查批注稿',
      text: documentContractText || selectedDocument?.rewrite || '',
      revisions: documentRevisions,
      annotationEdits: documentAnnotationEdits
    })
    navigator.clipboard?.writeText(content).then(() => setCopiedAt(Date.now())).catch(() => updateThreadRequest(activeThread.id, { error: '复制失败，请手动选择批注稿内容复制。' }))
  }

  const queuedComposer = useComposerSend({ tool: 'contract-review', conversationId: activeThread?.id, busy: loading, blocked: Boolean(activeRequest.cancelPending), capture: () => ({ text: instruction, files: [...files], mode }), clear: resetComposer, onSend: sendMessage, onStop: () => interruptActiveRequest(activeThread.id, { waitForTask: true }) })

  const status = stage === 'cancelling' ? '正在停止上一轮审查…' : stage === 'parsing' ? '正在读取合同文件…' : stage === 'analysis' ? '正在识别合同结构…' : stage === 'knowledge' ? '正在匹配参考资料…' : stage === 'review' ? '正在审查风险条款…' : stage === 'consolidation' ? '正在归并重复和关联问题…' : stage === 'rewrite' ? '正在生成局部批注稿…' : activeRequest.mode === 'thinking' ? '正在深度思考…' : '正在快速回复…'
  const hasComposerInput = Boolean(files.length || instruction.trim())
  const composerActionLabel = loading
    ? (hasComposerInput ? '停止当前生成并发送' : '停止生成')
    : '发送消息'

  const sidebar = (
    <>
      <SidebarSearch inputRef={searchRef} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={t("搜索历史审查")} />
      <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>{t("法飞飞")}</strong></div>
      <button className="sidebar-action" onClick={() => createConversation()}><PenLine size={20} />{t("新对话")}</button>
      <button className="sidebar-action" onClick={() => setTaskModalOpen(true)}><FolderOpen size={20} />{t("新审查任务")}</button>
      <p className="history-label">{t("历史对话")}</p>
      <nav className="history-list">{matchingThreads.map((thread) => {
        const running = isThreadRequestRunning(threadRequests, thread.id)
        return <button className={`${thread.id === activeThread?.id ? 'selected' : ''}${running ? ' thread-running' : ''}`} key={thread.id} {...getHistoryMenuProps(thread)} onClick={() => selectConversation(thread.id)}><span className="history-thread-icon" title={running ? t("该会话正在后台处理中") : ''}>{running ? <Loader2 size={16} className="spinner" /> : <MessageCircle size={16} />}</span><span className="history-row-copy"><span className="history-row-title">{renderTitle(thread)}</span><small className="history-row-time">{formatRelativeTime(thread.updatedAt)}</small></span><i className="history-delete" title={running ? t("处理中，暂不能删除") : t("删除对话")} onClick={(event) => deleteConversation(event, thread.id)}><Trash2 size={14} /></i></button>
      })}</nav>
      {tasks.length > 0 && <><p className="history-label task-label">{t("审查任务")}</p><nav className="history-list task-list">{tasks.map((task) => <button key={task.id} className={task.threadId === activeThread?.id ? 'selected' : ''} onClick={() => openTask(task)}><FolderOpen size={16} /><span>{task.title}</span><i className="history-delete" title={t("删除任务")} onClick={(event) => deleteTask(event, task.id)}><Trash2 size={14} /></i></button>)}</nav></>}
      {historyControls}
    </>
  )
  const headerLeft = settings.analysisPanel && documentOpen
    ? <button className="icon-button" aria-label={t("返回对话")} onClick={() => setDocumentOpen(false)}><ChevronLeft size={21} /></button>
    : null
  const composer = (
    <div className="composer-wrap"><div className="composer"><QueuedMessages composer={queuedComposer} />
      <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage() } }} placeholder={t("上传合同或输入你特别关注的审查重点…")} />
      {files.length > 0 && <div className="pending-files">{files.map((file) => <span key={file.name}><FileText size={14} />{file.name}<button aria-label={(t("移除 ") + (file.name))} onClick={() => setFiles((items) => items.filter((item) => item !== file))}><X size={13} /></button></span>)}</div>}
      <div className="composer-bottom"><ToolComposerControls onUpload={() => inputRef.current?.click()} mode={mode} onModeChange={setMode} messages={activeThread?.messages || []} question={instruction} hasPendingFiles={files.length > 0}/><button className="voice-send" onClick={queuedComposer.send} disabled={Boolean(activeRequest.cancelPending) || (!loading && !hasComposerInput)} aria-label={queuedComposer.label || t(composerActionLabel)} title={composerActionLabel}>{loading ? (hasComposerInput ? <Send size={19} /> : <Square size={17} />) : <Send size={19} />}</button></div>
      <input ref={inputRef} hidden type="file" multiple accept={ACCEPTED} onChange={(event) => { uploadFiles([...event.target.files]); event.target.value = '' }} />
    </div></div>
  )
  const documentPane = settings.analysisPanel && documentOpen && selectedDocument && (
    <section className="document-column">
      <header className="document-header"><span>{t("审查修订稿")}</span><div>
        {editedAnnotationCount > 0 && <span className="annotation-edit-status"><button type="button" onClick={handleResetAllAnnotations}>{t("已人工修改 ")}{editedAnnotationCount}{t(" 条 · 全部恢复")}</button></span>}
        <button title={t("复制批注稿（含最终确认意见）")} onClick={copyAnnotatedDocument}><Copy size={18} />{copiedAt ? t("已复制") : t("复制")}</button>
        <button title={t("下载 Word 批注稿（含最终确认意见）")} onClick={exportWord}><Download size={18} />{t("下载")}</button>
        <button className="close-document" aria-label={t("关闭文档")} onClick={() => setDocumentOpen(false)}><X size={21} /></button></div></header>
      <div className="document-scroll">
        {documentContractText
          ? <RevisionDocument
            contractText={documentContractText}
            revisions={documentRevisions}
            annotationEdits={documentAnnotationEdits}
            onAnnotationChange={handleAnnotationChange}
            onAnnotationReset={handleAnnotationReset}
          />
          : <div className="document-empty"><FileText size={32} /><p>{selectedDocument?.status || t("暂无修订内容")}</p></div>}
        {documentRevisions.length > 0 && <aside className="revision-summary">
          <p><b>{selectedDocument?.rewriteStats?.total || documentRevisions.length}</b>{t("个问题，生成")}<b>{selectedDocument?.rewriteStats?.blocks || documentRevisions.length}</b>{t("个就近修订标记")}{selectedDocument?.rewriteStats ? (t("（修订 ") + (selectedDocument.rewriteStats.modify || 0) + t(" · 新增 ") + (selectedDocument.rewriteStats.add || 0) + t(" · 删除 ") + (selectedDocument.rewriteStats.delete || 0) + "）") : ''}{selectedDocument?.rewriteStats?.groups && selectedDocument.rewriteStats.groups < (selectedDocument.rewriteStats.total || 0) ? t("，同一条款的相关问题已统一处理") : ''}</p>
          <p className="revision-summary-tip">{t("正文中的浅橙色片段和编号对应下方局部修改；完整修订条款与批注默认收起，可按需展开查看。")}</p>
          <p className="revision-summary-tip">{editedAnnotationCount
            ? <>{t("已人工修改 ")}{editedAnnotationCount}{t(" 条批注；复制和下载导出的都是修改后确认的意见。")}</>
            : t("每条批注都可以点“编辑”直接改写成你的最终意见；复制和下载导出的都是最终确认的版本。")}</p>
        </aside>}
      </div>
    </section>
  )

  return <>
    <ContractWorkbenchLayout
      className={`contract-review${settings.analysisPanel && documentOpen ? ' document-expanded' : ''}`}
      sidebarCollapsed={sidebarCollapsed}
      hideSidebar={settings.analysisPanel && documentOpen}
      sidebar={sidebar}
      headerLeft={headerLeft}
      title={titleOf(activeThread)}
      subtitle={t("AI 生成内容仅供参考，请结合实际情况判断")}
      conversationRef={conversationRef}
      composer={composer}
      documentPane={documentPane}
    >
        <div className="conversation-inner">
          {isSideChat && !activeMessages.length && <SideChatEmptyState />}
          {!isSideChat && activeMessages.length === 0 && <div className="assistant-turn welcome-turn"><div><p>{t("你好，我是法飞飞合同审查助手。上传合同后，我会结合对应合同类型的优质模板和风险案例，帮你梳理风险、生成修改建议，并输出一份可继续编辑的批注稿。")}</p></div></div>}
          {activeMessages.map((message) => message.role === 'user'
            ? <div className="user-turn" key={message.id}><p>{message.content}</p>{message.files?.map((file) => <div className="attached-file" key={`${message.id}-${file.name}`}><FileText size={18} /><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></div>)}</div>
: <div className="assistant-turn result-turn" key={message.id}><div>
              {message.status && <p className="assistant-status">{!message.interrupted && !message.failed && <Loader2 size={15} className="spinner" />}{t(message.status)}</p>}
              {message.content && <div className="assistant-content"><MarkdownBody content={message.content} /></div>}
              {message.interrupted && <small className="message-interrupted">{t("已被新消息打断，以上内容可能不完整。")}</small>}
              {isReviewProgressVisible(message) && <ReviewRoundsPanel
                rounds={message.reviewRounds || []}
                thinking={loading && stage === 'review' && activeMessages[activeMessages.length - 1]?.id === message.id}
                finished={Boolean(message.completed || message.failed || message.reviewFinished)}
                activeRound={message.activeReviewRound}
                stoppedEarly={Boolean(message.reviewStoppedEarly)}
                firstRoundInReport={typeof message.firstRoundReport === 'string'}
                interrupted={Boolean(message.interrupted)}
              />}
              {message.failed && <small className="message-failed">{t(message.reviewComplete === false ? "已完成内容已保存，请继续核对剩余条款。" : "本次核对尚未结束，请查看具体原因后重试。")}</small>}
              {message.failed && message.taskId && <button type="button" className="tool-text" disabled={loading} onClick={() => continueReview(message)}>{t("继续核对")}</button>}
              {hasReviewDocument(message) && <button className="open-document-card" onClick={() => openDocument(message.id)}><FileText size={25} /><span><strong>{t("商业合同审查批注稿")}</strong><small>{message.rewriteStats?.total ? ((message.rewriteStats.total) + t(" 个问题 · ") + (message.rewriteStats.blocks || message.revisions?.length || 0) + t(" 个就近标记 · ")) : (message.revisions?.length ? ((message.revisions.length) + t(" 个修订标记 · ")) : '')}{t("点击展开文档")}</small></span></button>}
            </div></div>)}
          {loading && <div className="assistant-turn loading-turn"><div><p>{t(status)}</p></div></div>}
          {error && <p className="chat-error">{error}</p>}
          {!isSideChat && !activeMessages.length && <div className="starter-prompts"><button onClick={() => setInstruction('请从甲方视角重点审查付款、验收和违约责任。')}>{t("从甲方视角审查付款与违约责任")}<span>→</span></button><button onClick={() => setInstruction('请检查合同是否缺少核心条款。')}>{t("检查是否缺少核心条款")}<span>→</span></button></div>}
        </div>
    </ContractWorkbenchLayout>
  </>
}

export default ContractRewritePage
