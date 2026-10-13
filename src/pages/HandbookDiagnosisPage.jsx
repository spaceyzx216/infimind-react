import MaterialReviewPanel from '../components/MaterialReviewPanel.jsx'
import SourcePane from '../components/HandbookAnnotatedDocument.jsx'
import { summarizeHandbookReport, canShowHandbookClause } from '../utils/handbook-annotations'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BookOpen, Check, ChevronRight, Copy, FileText, History, Loader2, PenLine, Send, Square, Trash2, X } from 'lucide-react'
import { useAuth } from '../components/AuthProvider'
import { useWorkspaceLayout, useWorkspaceText } from '../components/WorkspaceContext'
import ToolComposerControls from '../components/ToolComposerControls'
import { useConversationActions } from '../hooks/useConversationActions'
import { authFetch, apiError } from '../utils/auth-api'
import { ACCEPTED_EXTENSIONS, mergeSelectedFiles, describeRejection } from '../utils/file-selection'
import { formatRelativeTime } from '../utils/relative-time'
import { HANDBOOK_PRODUCT, HANDBOOK_TERMINAL, HANDBOOK_STATUS, formatHandbookReport, formatHandbookAuthorityStatus, readHandbookEvents } from '../utils/handbook-result'
import MarkdownBody from '../components/MarkdownBody'
import './ContractRewritePage.css'
import './LaborConsultPage.css'
import './HandbookDiagnosisPage.css'

const createId = () => crypto.randomUUID()
const reportUrl = (id) => `/api/tasks/handbook-diagnosis/${encodeURIComponent(id)}/report`
const matchLabel = (citation) => citation.location?.status === 'found'
  ? `${citation.location.matches[0].fileName} · ${citation.location.matches[0].sectionTitle}` : '引用待核实'

export default function HandbookDiagnosisPage() {
  const t = useWorkspaceText()
  const { user } = useAuth()
  const { sidebarCollapsed, isSideChat, initialConversationId, settings } = useWorkspaceLayout()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTask = useRef(searchParams.get('taskId') || '')
  const storageKey = `fafee-handbook-last-task:${user.id}`
  const [task, setTask] = useState(null)
  const [report, setReport] = useState(null)
  const [diagnosisTaskId, setDiagnosisTaskId] = useState('')
  const [reply, setReply] = useState('')
  const [history, setHistory] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [threadId, setThreadId] = useState(createId)
  const [draft, setDraft] = useState('')
  const [focus, setFocus] = useState('')
  const [files, setFiles] = useState([])
  const [intent, setIntent] = useState('analyze')
  const [mode, setMode] = useState('thinking')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [sourceOpen, setSourceOpen] = useState(false)
  const [citation, setCitation] = useState(null)
  const [copied, setCopied] = useState('')
  const [deleting, setDeleting] = useState(null)
  const [deletingBusy, setDeletingBusy] = useState(false)
  const fileInput = useRef(null)
  const selectedId = useRef('')
  const selection = useRef(0)
  const lock = useRef(false)
  const restored = useRef(false)
  const mounted = useRef(true)
  const lastSequence = useRef(0)
  const watching = Boolean(task && !HANDBOOK_TERMINAL.has(task.status))
  const taskId = task?.id || ''
  const active = watching || submitting

  const setParams = useCallback((id) => setSearchParams({ ...(id ? { taskId: id } : {}), ...(isSideChat ? { sideChat: initialConversationId } : {}) }, { replace: true }), [setSearchParams, isSideChat, initialConversationId])
  const loadHistory = useCallback(async (offset = 0) => {
    const response = await authFetch(`/api/tasks?productId=${HANDBOOK_PRODUCT}&limit=20&offset=${offset}`)
    if (!response.ok) throw await apiError(response, '历史诊断加载失败')
    const payload = await response.json()
    if (!mounted.current) return
    setHistory((previous) => offset ? [...new Map([...previous, ...(payload.tasks || [])].map((item) => [item.id, item])).values()] : payload.tasks || [])
    setHasMore(Boolean(payload.hasMore))
  }, [])
  const fetchReport = useCallback(async (id) => {
    const response = await authFetch(reportUrl(id))
    if (!response.ok) throw await apiError(response, '诊断报告加载失败')
    return response.json()
  }, [])
  const selectTask = useCallback(async (id) => {
    const version = ++selection.current
    selectedId.current = id
    setError(''); setReport(null); setReply(''); setTask(null); setCitation(null); setSourceOpen(false); setDraft(''); setFiles([])
    try {
      const payload = await fetchReport(id)
      if (!mounted.current || version !== selection.current) return
      let base = payload.report
      let baseId = id
      const sourceTaskId = payload.sourceTaskId || (payload.report?.kind === 'followup' ? payload.report.sourceTaskId : '')
      if (sourceTaskId) {
        const source = await fetchReport(sourceTaskId)
        if (!mounted.current || version !== selection.current) return
        base = source.report; baseId = sourceTaskId; setReply(payload.report?.answer || '')
      }
      setTask(payload.task); setReport(base); setDiagnosisTaskId(baseId); setThreadId(payload.task.threadId || id)
      setIntent(base?.analysisStatus === 'completed' ? 'followup' : 'analyze'); setParams(id)
      lastSequence.current = payload.task.lastEventSeq || 0
      if (!isSideChat) localStorage.setItem(storageKey, id)
    } catch (cause) { if (mounted.current && version === selection.current) setError(cause.message) }
  }, [fetchReport, isSideChat, setParams, storageKey])
  const beginNew = useCallback(() => {
    selection.current += 1; selectedId.current = ''; lastSequence.current = 0
    setTask(null); setReport(null); setReply(''); setDiagnosisTaskId(''); setThreadId(createId()); setDraft(''); setFiles([]); setFocus(''); setIntent('analyze'); setError(''); setSourceOpen(false); setCitation(null); setParams('')
    if (!isSideChat) localStorage.removeItem(storageKey)
  }, [isSideChat, setParams, storageKey])
  useEffect(() => {
    mounted.current = true
    if (!restored.current) {
      restored.current = true
      void loadHistory().catch((cause) => { if (mounted.current) setError(cause.message) })
      const id = initialTask.current || (!isSideChat ? localStorage.getItem(storageKey) : '')
      if (id) void selectTask(id)
      else if (initialConversationId) {
        void authFetch(`/api/tasks/handbook-diagnosis/thread/${encodeURIComponent(initialConversationId)}`).then((response) => response.json()).then((payload) => {
          if (mounted.current && payload.tasks?.length) void selectTask(payload.tasks.at(-1).id)
        })
      }
    }
    return () => { mounted.current = false }
  }, [initialConversationId, isSideChat, loadHistory, selectTask, storageKey])

  useEffect(() => {
    if (!taskId || !watching) return undefined
    const controller = new AbortController()
    let sequence = lastSequence.current
    let terminal = false
    const receive = (event, payload, seq) => {
      if (!mounted.current || selectedId.current !== taskId || controller.signal.aborted || (seq && seq <= sequence)) return
      sequence = Math.max(sequence, seq); lastSequence.current = sequence
      if (event === 'handbook.snapshot') {
        setReport((previous) => ({ ...previous, ...payload.result })); setDiagnosisTaskId(taskId)
      }
      if (['stage.start', 'stage.complete', 'model.progress', 'stage.warning'].includes(event)) setTask((current) => current?.id === taskId ? { ...current, stageSummary: payload.label || payload.summary || payload.message || '', currentStage: payload.stage || current.currentStage, lastEventSeq: sequence } : current)
      if (event === 'task.retry_waiting') setTask((current) => current?.id === taskId ? { ...current, status: 'retry_waiting' } : current)
      if (event === 'task.cancel_requested') setTask((current) => current?.id === taskId ? { ...current, status: 'cancel_requested' } : current)
      if (['task.succeeded', 'task.failed', 'task.cancelled'].includes(event)) terminal = true
    }
    const watch = async () => {
      while (!controller.signal.aborted && selectedId.current === taskId) {
        try {
          const response = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/events?after=${sequence}`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal })
          if (!response.ok) throw await apiError(response, '检查进度连接失败')
          setError((previous) => previous.startsWith('检查进度暂时断开') ? '' : previous)
          await readHandbookEvents(response, receive, controller.signal)
          if (controller.signal.aborted || selectedId.current !== taskId) return
          const payload = await fetchReport(taskId)
          if (controller.signal.aborted || selectedId.current !== taskId) return
          setTask(payload.task)
          if (payload.report?.kind === 'followup') setReply(payload.report.answer || '')
          else if (payload.report) { setReport(payload.report); setDiagnosisTaskId(taskId) }
          if (terminal || HANDBOOK_TERMINAL.has(payload.task.status)) {
            if (payload.report?.analysisStatus === 'completed') setIntent('followup')
            await loadHistory(); return
          }
        } catch (cause) {
          if (controller.signal.aborted || selectedId.current !== taskId) return
          setError(`检查进度暂时断开，正在重新连接。${cause.message}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    void watch()
    return () => controller.abort()
  }, [taskId, watching, fetchReport, loadHistory])

  const heads = useMemo(() => [...new Map([...history].reverse().map((item) => [item.threadId || item.id, item])).values()].reverse(), [history])
  const { visibleItems, renderTitle, historyControls, getHistoryMenuProps } = useConversationActions({ items: heads, active: task, toolKey: HANDBOOK_PRODUCT, query: historyQuery, onNew: beginNew, onSelect: (item) => { void selectTask(item.id) } })
  const selectFiles = (incoming) => {
    const merged = mergeSelectedFiles(files, Array.from(incoming || []))
    setFiles(merged.files); setError(describeRejection(merged)); setIntent('analyze'); setReport(null); setReply(''); setCitation(null); setSourceOpen(false)
  }
  const submit = async (action = intent, allowPartial = false) => {
    if (lock.current || active) return
    if (action === 'analyze' && !draft.trim() && !files.length) { setError('请上传员工手册或粘贴制度正文'); return }
    if (action === 'followup' && !draft.trim()) return
    lock.current = true; setSubmitting(true); setError('')
    const requestVersion = selection.current
    try {
      const body = new FormData()
      body.append('action', action); body.append('threadId', threadId); body.append('mode', mode); body.append('temporary', String(isSideChat))
      if (action === 'analyze') { body.append('text', draft); body.append('focus', focus); files.forEach((file) => body.append('files', file, file.name)) }
      else { body.append('sourceTaskId', action === 'restart' ? task.id : diagnosisTaskId); body.append('message', draft); body.append('allowPartial', String(allowPartial)) }
      const response = await authFetch('/api/tasks/handbook-diagnosis', { method: 'POST', body })
      if (!response.ok) throw await apiError(response, '诊断任务提交失败')
      const payload = await response.json()
      if (payload.productId !== HANDBOOK_PRODUCT || !payload.taskId) throw new Error('诊断任务返回异常，请重试')
      if (!mounted.current || selection.current !== requestVersion) return
      selectedId.current = payload.taskId; lastSequence.current = payload.task?.lastEventSeq || 0
      if (action !== 'followup') { setReport(null); setDiagnosisTaskId(payload.taskId); setSourceOpen(false); setCitation(null) }
      setReply(''); setTask(payload.task); setThreadId(payload.threadId); setDraft(''); setFiles([]); setParams(payload.taskId)
      if (!isSideChat) localStorage.setItem(storageKey, payload.taskId)
      await loadHistory()
    } catch (cause) { if (mounted.current && requestVersion === selection.current) setError(cause.message) }
    finally { lock.current = false; if (mounted.current) setSubmitting(false) }
  }
  const cancel = async () => {
    try {
      const response = await authFetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' })
      if (!response.ok) throw await apiError(response, '停止检查失败')
      const payload = await response.json()
      if (selectedId.current === taskId) setTask(payload.task || { ...task, status: 'cancel_requested' })
    } catch (cause) { setError(cause.message) }
  }
  const removeThread = async () => {
    setDeletingBusy(true); setError('')
    try {
      const response = await authFetch(`/api/tasks/handbook-diagnosis/thread/${encodeURIComponent(deleting.threadId || deleting.id)}`, { method: 'DELETE' })
      if (!response.ok) throw await apiError(response, '删除诊断失败')
      if ((task?.threadId || task?.id) === (deleting.threadId || deleting.id)) beginNew()
      setDeleting(null); await loadHistory()
    } catch (cause) { setError(cause.message) } finally { setDeletingBusy(false) }
  }
  const copy = async (value, key) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); setTimeout(() => setCopied(''), 1500) }
    catch { setError('复制失败，请选择文本后手动复制') }
  }
  const completedCount = report?.coverage?.filter((item) => item.status === 'completed').length || 0
  const viewCitation = (item) => { if (settings.analysisPanel) { setCitation(item); setSourceOpen(true) } }
  const statusText = !report && intent === 'analyze' && (draft.trim() || files.length) && !active ? '新材料尚未检查' : report?.analysisStatus === 'completed' ? '本次正文检查完成' : report?.analysisStatus === 'blocked' ? '材料待处理' : HANDBOOK_STATUS[task?.status] || '员工手册诊断'
  const summary = report ? summarizeHandbookReport(report) : null
  const canContinuePartial = report?.analysisStatus === 'blocked' && report.sourceDocuments?.length && report.unreadableMaterials?.every((item) => !item.reason.includes('未确认包含制度正文'))

  return <main className={`contract-chat labor-consult handbook-workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${sourceOpen ? 'hb-source-open' : ''}`}>
    <aside className="chat-sidebar hb-history" aria-label={t('历史诊断')}>
      <label className="sidebar-search"><History size={17} /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={t('搜索历史诊断')} aria-label={t('搜索历史诊断')} /></label>
      <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>{t('法飞飞')}</strong></div>
      <button className="sidebar-action" type="button" onClick={beginNew}><PenLine size={20} />{t('新诊断')}</button>
      <p className="history-label">{t('历史诊断')}</p>
      <nav className="history-list">{visibleItems.map((item) => <div key={item.threadId || item.id} className="hb-history-row">
        <button type="button" className={(task?.threadId || task?.id) === (item.threadId || item.id) ? 'selected' : ''} {...getHistoryMenuProps(item)} onClick={() => { void selectTask(item.id) }}><span className="history-thread-icon"><BookOpen size={16} /></span><span className="history-thread-main"><span className="history-thread-title">{renderTitle(item)}</span><small className="history-thread-time">{formatRelativeTime(item.createdAt)}</small></span></button>
        <button className="hb-history-delete" type="button" aria-label={`删除诊断：${item.title}`} disabled={!HANDBOOK_TERMINAL.has(item.status)} onClick={() => setDeleting(item)}><Trash2 size={14} /></button>
      </div>)}</nav>{historyControls}
      {hasMore && <button className="hb-load-more" type="button" onClick={() => { void loadHistory(history.length).catch((cause) => setError(cause.message)) }}>{t('加载更早诊断')}</button>}
    </aside>
    <section className="chat-column hb-main">
      <header className="chat-header"><div className="header-left" /><div className="chat-title"><strong>{task?.title || t('新的员工手册诊断')}</strong><small>{t('面向企业方的制度检查 · 关联原文与修改建议 · 不构成正式法律意见')}</small></div><div className="header-tools">{report && <button className="icon-button" type="button" aria-label={t('复制报告')} title={t('复制报告')} onClick={() => { void copy(formatHandbookReport(report), 'report') }}>{copied === 'report' ? <Check size={18} /> : <Copy size={18} />}</button>}{settings.analysisPanel && report?.sourceDocuments?.length > 0 && <button className="icon-button" type="button" aria-label={t(sourceOpen ? '收起原文' : '查看原文')} title={t(sourceOpen ? '收起原文' : '查看原文')} onClick={() => setSourceOpen((value) => !value)}><FileText size={18} /></button>}</div></header>
      <div className="conversation" aria-live="polite" aria-busy={active}><div className="conversation-inner hb-body">
        {!task && !report && <><div className="assistant-turn welcome-turn"><div><p>{t('你好，我是法飞飞员工手册诊断助手。你可以上传员工手册、考勤制度、劳动合同等材料，也可以直接粘贴制度正文。我会检查条款问题与文件之间的矛盾，关联原文，并给出局部修改建议。')}</p></div></div><div className="starter-prompts"><button type="button" onClick={() => fileInput.current?.click()}>{t('上传员工手册，检查条款问题与修改建议')}<span>→</span></button><button type="button" onClick={() => { setFocus('重点检查考勤、奖惩与解除劳动合同规定'); fileInput.current?.click() }}>{t('重点检查考勤、奖惩与解除劳动合同规定')}<span>→</span></button><button type="button" onClick={() => { setFocus('重点核对员工手册、劳动合同与考勤制度之间的矛盾'); fileInput.current?.click() }}>{t('一起上传员工手册、劳动合同和考勤制度，核对矛盾')}<span>→</span></button></div></>}
        {task && (report?.analysisStatus !== 'completed' || (watching && intent === 'followup')) && <div className={`hb-progress ${report?.analysisStatus === 'blocked' ? 'is-blocked' : ''}`} role="status"><div>{active ? <Loader2 size={18} className="hb-spin" /> : <BookOpen size={18} />}<strong>{t(watching && intent === 'followup' ? '正在处理报告追问' : statusText)}</strong></div><p>{task.stageSummary || report?.scope?.description}</p>{report && report.analysisStatus !== 'blocked' && <small>{t('正文单元')} {completedCount}/{report.coverage?.length || 0} · {t('关联核对')} {report.relationCoverage?.completed || 0}/{report.relationCoverage?.total || 0}{report.analysisStatus !== 'completed' && ` · ${t('全文核对尚未完成')}`}</small>}
          {!active && ['failed', 'cancelled'].includes(task.status) && <><p>{task.errorSummary || t('检查已停止，已完成部分仍保留。')}</p><button type="button" onClick={() => { void submit('restart') }}>{t('继续未完成检查')}</button></>}
          {canContinuePartial && !active && <button type="button" onClick={() => { void submit('restart', true) }}>{t('仅检查已读取部分')}</button>}
        </div>}
        {report && <>
          <section className="hb-summary assistant-content"><h2>{t('诊断摘要')}</h2>{report.analysisStatus === 'completed' && <p className="hb-muted">{t('本次正文检查完成')}</p>}<p>{report.analysisStatus === 'completed' ? (summary.count ? `本次发现 ${summary.count} 项诊断提示，其中 ${summary.conflicts} 项涉及条款之间的矛盾。` : '本次可读正文检查完成，未生成条款问题。') : '本次检查尚未完成，以下仅展示已经校验的结果。'}</p>{summary.files.length > 0 && <p><strong>{t('涉及材料')}：</strong>{summary.files.join('、')}</p>}{summary.priorities.length > 0 && <p><strong>{t('优先处理')}：</strong>{summary.priorities.join('；')}</p>}<p className="hb-muted">{report.scope?.description}</p>{Object.values(report.scope?.background || {}).filter(Boolean).length > 0 && <p className="hb-muted">{Object.values(report.scope.background).filter(Boolean).join(' · ')}</p>}{report.unreadableMaterials?.map((item, index) => <p key={index} className="hb-warning">{item.fileName}：{item.reason}</p>)}</section>
          {report.analysisStatus !== 'blocked' && <section className="hb-findings"><div className="hb-section-title"><h2>{t('重点问题与修改建议')}</h2><small>{report.findings?.length || 0} {t('项提示')}</small></div>
            {!report.findings?.length && <p className="hb-muted">{t(report.analysisStatus === 'completed' ? '本次未生成条款问题；请结合检查范围与待核实事项复核。' : '已校验的问题会随检查进度逐步显示。')}</p>}
            {report.findings?.map((finding, index) => <article key={finding.id} className="hb-finding" data-testid="handbook-finding"><div className="hb-finding-title"><span>{index + 1}</span><h3>{finding.title}</h3><small className={`hb-level ${finding.level}`}>{t(finding.status === 'pending' ? '待核实' : ({ high: '高风险', medium: '中风险', low: '低风险' }[finding.level] || '风险提示'))}</small></div><div className="hb-markdown assistant-content"><MarkdownBody content={finding.explanation} /></div>
              <div className="hb-citations">{finding.evidence.map((item, position) => <button key={position} type="button" disabled={item.location.status !== 'found'} onClick={() => viewCitation(item)} aria-label={`${t('定位原文')}：${finding.title} ${position + 1}`}><FileText size={14} /><span>{matchLabel(item)}<q>{item.quote}</q></span><ChevronRight size={14} /></button>)}</div>
              <strong>{t('修改建议')}</strong><div className="hb-markdown assistant-content"><MarkdownBody content={finding.recommendation || t('请结合缺失背景进一步核实。')} /></div>{finding.relatedChanges.length > 0 && <p>{t('关联修改')}：{finding.relatedChanges.join('；')}</p>}{canShowHandbookClause(finding, report.sourceDocuments) && <div className="hb-suggestion"><header><strong>{t('示例条款')}</strong><button type="button" onClick={() => { void copy(finding.suggestedClause, finding.id) }}>{copied === finding.id ? <Check size={14} /> : <Copy size={14} />}{t('复制')}</button></header><p>{finding.suggestedClause}</p></div>}<details><summary>{t('适用条件与依据详情')}</summary>{finding.verificationNote && <p className="hb-warning">{finding.verificationNote}</p>}{finding.conditions.length > 0 && <><strong>{t('适用条件')}</strong><ul>{finding.conditions.map((item) => <li key={item}>{item}</li>)}</ul></>}{finding.authorities.map((item, position) => <div className="hb-authority" key={position}><p>{t('待核实依据')}：{item.title} {item.article}{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">{t('查看来源')}</a>}</p><small>{formatHandbookAuthorityStatus(item)}</small>{item.versionLabel && <p>{t('版本')}：{item.versionLabel}</p>}{item.quote && <blockquote>{item.quote}</blockquote>}{item.supportReason && <div className="hb-markdown assistant-content"><MarkdownBody content={item.supportReason} /></div>}<p className="hb-muted">{item.note}</p>{item.provisionText && <details><summary>{t('查看法条原文')}</summary><p>{item.provisionText}</p></details>}</div>)}</details>
            </article>)}
          </section>}
          {settings.analysisPanel && report.sourceDocuments?.length > 0 && <button className="open-document-card hb-document-card" type="button" onClick={() => setSourceOpen(true)}><FileText size={25} /><span><strong>{t('员工手册诊断批注稿')}</strong><small>{report.sourceDocuments.length} {t('份原文 · 查看诊断标记与条款建议')}</small></span><ChevronRight size={19} /></button>}
          {report.pendingQuestions?.length > 0 && <details open className="hb-disclosure"><summary>{t('待核实事项')}<small>{report.pendingQuestions.length}</small></summary><ul>{report.pendingQuestions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
          <details className="hb-disclosure hb-check-details"><summary>{t('检查范围与进度')}<small>{completedCount}/{report.coverage?.length || 0}</small></summary><p>{report.scope?.description}</p><p>{t('关联核对')}：{report.relationCoverage?.completed || 0}/{report.relationCoverage?.total || 0}</p><ul>{report.coverage?.map((item) => <li key={item.chunkId}>{item.sectionTitle} · {t(item.status === 'completed' ? '已检查' : '待检查')}</li>)}</ul></details>
          {report.analysisStatus !== 'blocked' && <details className="hb-disclosure"><summary>{t('程序核对清单')}<small>{t('未审核证据')}</small></summary>{report.procedureChecklist?.map((item) => <div className="hb-procedure" key={item.id}><strong>{item.title}</strong><p>{item.description}</p><p>{t('准备材料')}：{item.materials.join('、')}</p><small>{item.note}</small></div>)}</details>}
          <details className="hb-disclosure"><summary>{t('参考资料与检查限制')}</summary>{report.referenceVersions?.map((item) => <p key={item.id}>{item.title} · {item.version} · {t('仅作参考')}</p>)}<ul>{report.warnings?.map((item) => <li key={item}>{item}</li>)}</ul></details>
        </>}
        {reply && <div className="hb-reply"><strong>{t('报告追问')}</strong><div className="hb-markdown assistant-content"><MarkdownBody content={reply} /></div></div>}
        {error && <div className="hb-error" role="alert">{error}<button type="button" aria-label={t('关闭提示')} onClick={() => setError('')}><X size={14} /></button></div>}
      </div></div>
      <div className="composer-wrap">
      <MaterialReviewPanel taskId={task?.id} running={active} />
      <form className="composer hb-composer" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        {report?.analysisStatus === 'completed' && <div className="hb-intent"><button type="button" className={intent === 'followup' ? 'is-active' : ''} onClick={() => { setIntent('followup'); setDraft(''); setFiles([]) }}>{t('追问报告')}</button><button type="button" className={intent === 'analyze' ? 'is-active' : ''} onClick={() => { setIntent('analyze'); setDraft('') }}>{t('提交新版正文')}</button></div>}
        {files.length > 0 && <div className="hb-files">{files.map((file) => <span key={file.name}><FileText size={13} />{file.name}<button type="button" aria-label={`移除文件：${file.name}`} disabled={active} onClick={() => setFiles((previous) => previous.filter((item) => item.name !== file.name))}><X size={13} /></button></span>)}</div>}
        {intent === 'analyze' && <details className="hb-focus"><summary>{t('检查侧重点（可选）')}</summary><input aria-label={t('检查侧重点')} value={focus} onChange={(event) => setFocus(event.target.value)} placeholder={t('例如：重点检查考勤与奖惩规定')} disabled={active} /></details>}
        <textarea aria-label={t(intent === 'followup' ? '报告追问' : '员工手册正文')} value={draft} onChange={(event) => { setDraft(event.target.value); if (intent === 'analyze') { setReport(null); setReply(''); setCitation(null); setSourceOpen(false) } }} placeholder={t(intent === 'followup' ? '就本次报告继续提问…' : '上传员工手册，或粘贴需要检查的制度正文…')} disabled={active} onKeyDown={(event) => { if (event.isComposing) return; const sendKey = settings.sendKey === 'command-enter' ? (event.ctrlKey || event.metaKey) : !event.shiftKey; if (event.key === 'Enter' && sendKey) { event.preventDefault(); void submit() } }} />
        <div className="composer-bottom"><ToolComposerControls onUpload={() => fileInput.current?.click()} uploadLabel={t('上传员工手册')} disabled={active} mode={mode} onModeChange={setMode} question={draft} hasPendingFiles={Boolean(files.length)} messages={report ? [{ result: report }] : []} />{watching ? <button className="voice-send stop" type="button" aria-label={t('停止检查')} onClick={() => { void cancel() }} disabled={task.status === 'cancel_requested'}><Square size={19} /></button> : <button className="voice-send" type="submit" aria-label={t(intent === 'followup' ? '发送追问' : '开始诊断')} disabled={submitting || (!draft.trim() && !files.length)}>{submitting ? <Loader2 className="hb-spin" size={20} /> : <Send size={19} />}</button>}</div>
        <input ref={fileInput} type="file" multiple accept={ACCEPTED_EXTENSIONS} hidden onChange={(event) => { selectFiles(event.target.files); event.target.value = '' }} />
      </form>
      <p className="labor-disclaimer"><BookOpen size={13} />{t('本诊断为辅助分析，不构成正式法律意见；条款适用及制度制定、实施程序请由专业人士复核。')}</p>
      </div>
    </section>
    {settings.analysisPanel && sourceOpen && report?.sourceDocuments?.length > 0 && <SourcePane report={report} citation={citation} onClose={() => setSourceOpen(false)} />}
    {deleting && <div className="hb-dialog-backdrop"><div className="hb-dialog" role="dialog" aria-modal="true" aria-labelledby="hb-delete-title"><h2 id="hb-delete-title">{t('删除这段诊断？')}</h2><p>{t('这会删除本会话的诊断记录、原文和关联上传文件。')}</p><strong>{deleting.title}</strong><div><button type="button" disabled={deletingBusy} onClick={() => setDeleting(null)}>{t('保留')}</button><button type="button" disabled={deletingBusy} onClick={() => { void removeThread() }}>{t(deletingBusy ? '正在删除…' : '确认删除')}</button></div></div></div>}
  </main>
}
