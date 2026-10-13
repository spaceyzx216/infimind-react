import MaterialReviewPanel from '../components/MaterialReviewPanel.jsx'
import { useComposerSend } from '../hooks/useComposerSend'
import QueuedMessages from '../components/QueuedMessages'
import SideChatEmptyState from '../components/SideChatEmptyState'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Ban,
  Brain,
  Copy,
  Download,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  History,
  Loader2,
  MessageCircle,
  PenLine,
  Plus,
  RotateCw,
  Scale,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  Zap,
  X
} from 'lucide-react'
import ContractWorkbenchLayout from '../components/ContractWorkbenchLayout'
import { useWorkspaceText, useWorkspaceLayout } from '../components/WorkspaceContext'
import { useConversationActions } from '../hooks/useConversationActions'
import { authFetch } from '../utils/auth-api.js'
import ToolComposerControls from '../components/ToolComposerControls'
import { formatRelativeTime } from '../utils/relative-time.js'
import { reduceLaborProgress } from '../utils/labor-progress.js'
import { throttleWithTrailing, MARKDOWN_THROTTLE_MS } from '../utils/stream-buffer.js'
import { ReviewRoundsPanel, RevisionDocument, downloadRevisionWord } from './ContractRewritePage.jsx'
import './ContractRewritePage.css'
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILES,
  MAX_FILE_SIZE,
  describeRejection,
  mergeSelectedFiles
} from '../utils/file-selection.js'
import './LaborContractAnalysisPage.css'

const PRODUCT_ID = 'labor-contract-analysis'
const LAST_TASK_KEY = 'fafee-labor-contract-analysis-last-task-v1'
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])
const INFO_LABELS = [
  ['employer', '用人单位'], ['employee', '劳动者'], ['contractType', '合同类型'], ['term', '合同期限'],
  ['probation', '试用期'], ['position', '岗位 / 工作内容'], ['workLocation', '工作地点'],
  ['remuneration', '劳动报酬'], ['workingHours', '工作时间'], ['socialInsurance', '社会保险'],
  ['signedDate', '签订日期'], ['applicabilityContext', '适用前提']
]
const DISPATCH_INFO_LABELS = [
  ['dispatchingUnit', '派遣单位'], ['usingUnit', '用工单位'], ['workerCount', '派遣人数'],
  ['positions', '派遣岗位 / 工作内容'], ['workLocation', '工作地点'], ['dispatchTerm', '派遣期限'],
  ['wageArrangement', '工资福利安排'], ['socialInsurance', '社会保险安排'], ['serviceFee', '服务费与结算'],
  ['reviewPerspectiveSummary', '所选视角摘要']
]
const MATERIAL_ROLE_LABELS = {
  direct_labor_contract: '普通劳动合同',
  dispatch_agreement: '劳务派遣协议',
  dispatch_employment_contract: '派遣劳动合同',
  supporting_attachment: '其他用工附件',
  unsupported: '其他/暂不支持'
}
const BLOCKED_PARSE_STATUSES = new Set(['empty', 'failed', 'rejected'])
function materialClassificationNotice(results, clarified = false) {
  return results.map((item) => {
    const name = `《${item.fileName || '上传文件'}》`
    if (item.parseStatus === 'empty') return `${name}没有读取到可分析文字，请换用清晰扫描件或可复制文字的PDF/Word。`
    if (item.parseStatus === 'failed') return `${name}读取失败，请检查文件能否正常打开，或重新导出后上传。`
    if (item.parseStatus === 'rejected') return item.reason || `${name}不符合上传要求，请更换文件。`
    if (item.parseStatus === 'unavailable' || (item.suggestedType === 'unsupported' && item.classificationStatus === 'unavailable')) return `${name}暂时无法完成识别，材料已保留，请稍后再次发送。`
    if (item.suggestedType === 'unsupported') return clarified
      ? `${name}仍无法从正文确认材料类型，请补充包含标题、相关主体和正文的完整文件，或移除该文件。`
      : `${name}暂时无法确认材料类型。请在下方说明文件用途，或由谁与谁签署，然后发送。`
    return ''
  }).filter(Boolean).join('；')
}
const TASK_STATUS = {
  queued: '等待处理', running: '正在分析', retry_waiting: '稍后重试', cancel_requested: '正在停止',
  succeeded: '分析已完成', failed: '分析未完成', cancelled: '已停止'
}
const formatSize = (bytes) => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
  : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} B`
const formatDate = (value) => value
  ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  : ''

function normalizeLaborReportMarkdown(value) {
  return String(value || '')
    .replace(/（模型判断，仅供参考）/g, '')
    .replace(/\*\*([^*\n]+?)[：:]\*\*/g, '**$1**：')
}

async function readError(response, fallback) {
  const payload = await response.json().catch(() => ({}))
  return payload.error || fallback || `请求失败（${response.status}）`
}

async function consumeSSE(response, onEvent, signal) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('当前浏览器无法读取任务进度')
  const decoder = new TextDecoder()
  let buffer = ''
  const cancelReader = () => { void reader.cancel().catch(() => {}) }
  const consumeBlock = (block) => {
    const event = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() || 'message'
    const data = [...block.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]).join('\n')
    if (!data) return
    try { onEvent(event, JSON.parse(data)) } catch { onEvent(event, { message: data }) }
  }
  signal?.addEventListener('abort', cancelReader, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw new DOMException('进度订阅已结束', 'AbortError')
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

function LocationText({ location }) {
  const t = useWorkspaceText()
  if (!location || location.status === 'not-found') return <span className="lca-location-missing">{t("没有在提取文本中找到可核对的位置")}</span>
  return (
    <div className="lca-location-list">
      {location.matches.map((match, index) => (
        <span key={`${match.fileId}-${match.lineStart}-${index}`}>
          {match.fileName}{t("· 第")}{match.lineStart}{match.lineEnd !== match.lineStart ? `–${match.lineEnd}` : ''}{t("行")}</span>
      ))}
      {location.status === 'ambiguous' && <small>{t("原文重复出现，请逐处核对。")}</small>}
    </div>
  )
}

function deduplicateSupportingMaterials(materials = []) {
  const seen = new Set()
  return materials.filter((source) => {
    const title = String(source?.title || source?.sourceName || '').replace(/\s+/g, ' ').trim()
    const content = String(source?.text || '').replace(/\s+/g, ' ').trim()
    const key = `${source?.sourceType || ''}\u0000${title}\u0000${content}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function supportingMaterialExcerpt(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text
}

function splitSourceTextIntoLines(value) {
  const text = String(value || '')
  const lines = []
  const breaks = /\r\n|\r|\n/g
  let start = 0
  let match
  while ((match = breaks.exec(text))) {
    lines.push({ text: text.slice(start, match.index), start, end: match.index })
    start = match.index + match[0].length
  }
  lines.push({ text: text.slice(start), start, end: text.length })
  return lines
}

function renderSourceLineText(text, ranges) {
  if (!ranges.length) return text || '\u00a0'
  const sorted = ranges.map((range) => ({
    start: Math.max(0, Math.min(text.length, range.start)),
    end: Math.max(0, Math.min(text.length, range.end))
  })).filter((range) => range.end > range.start).sort((a, b) => a.start - b.start)
  const merged = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  const nodes = []
  let cursor = 0
  for (const [index, range] of merged.entries()) {
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start))
    nodes.push(<mark key={`mark-${index}`}>{text.slice(range.start, range.end)}</mark>)
    cursor = range.end
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes.length ? nodes : '\u00a0'
}

function AnalysisResult({ result, streaming = false, sourceTaskId = '', documentMode = false, onSourceDocuments }) {
  const t = useWorkspaceText()
  const isDispatch = result?.analysisType === 'labor_dispatch_agreement'
  const info = isDispatch ? (result?.agreementInfo || {}) : (result?.contractInfo || {})
  const infoLabels = isDispatch ? DISPATCH_INFO_LABELS : INFO_LABELS
  const scopeConfirmationRequired = result?.analysisStatus === 'scope-confirmation-required'
  const findings = Array.isArray(result?.findings) ? result.findings : []
  const missingItems = Array.isArray(result?.missingItems) ? result.missingItems : []
  const [activeFindingId, setActiveFindingId] = useState(null)
  const [sourceOpen, setSourceOpen] = useState(documentMode || result?.schemaVersion >= 3)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceDocuments, setSourceDocuments] = useState(() => result?.sourceDocuments || [])
  const [sourceLoadedForTask, setSourceLoadedForTask] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [selectedSourceFileId, setSelectedSourceFileId] = useState('')
  const sourceLineRefs = useRef(new Map())
  const sourceLoadAttemptedRef = useRef('')
  const completed = result?.analysisStatus === 'completed'
    || (result?.productId === PRODUCT_ID && result?.kind !== 'followup' && !streaming && result?.analysisStatus !== 'streaming')
  const hasContractInfo = Object.values(info).some(Boolean)
  const activeFinding = findings.find((item) => item.id === activeFindingId) || findings[0] || null
  const activeSourceMatches = useMemo(() => ['found', 'ambiguous'].includes(activeFinding?.location?.status)
    ? (activeFinding.location.matches || []).filter((match) => Number(match.lineStart) > 0 && Number(match.lineEnd) >= Number(match.lineStart))
    : [], [activeFinding])
  const loadSource = useCallback(async () => {
    if (!sourceTaskId || sourceLoading) return
    if (result?.sourceDocuments?.length) {
      setSourceDocuments(result.sourceDocuments)
      setSourceLoadedForTask(sourceTaskId)
      setSourceError('')
      return
    }
    if (sourceLoadedForTask === sourceTaskId) return
    setSourceLoading(true)
    setSourceError('')
    try {
      const response = await authFetch(`/api/tasks/labor-contract-analysis/source/${encodeURIComponent(sourceTaskId)}`, {
        headers: { Accept: 'application/json' }, cache: 'no-store'
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload.error || '合同原文暂时无法读取。')
      }
      const documents = Array.isArray(payload.documents) ? payload.documents.filter((document) => document?.text) : []
      setSourceDocuments(documents)
      setSelectedSourceFileId((current) => documents.some((document) => document.fileId === current) ? current : documents[0]?.fileId || '')
      setSourceLoadedForTask(sourceTaskId)
    } catch (error) {
      setSourceError(error.message || '合同原文暂时无法读取。')
    } finally {
      setSourceLoading(false)
    }
  }, [sourceLoading, sourceLoadedForTask, sourceTaskId, result?.sourceDocuments])
  useEffect(() => {
    if (sourceDocuments.length && sourceTaskId) onSourceDocuments?.(sourceTaskId, sourceDocuments)
  }, [sourceDocuments, sourceTaskId, onSourceDocuments])
  const openFindingInSource = (finding) => {
    setActiveFindingId(finding.id)
    const firstMatch = finding.location?.matches?.[0]
    if (firstMatch?.fileId) setSelectedSourceFileId(firstMatch.fileId)
    setSourceOpen(true)
    void loadSource()
  }
  const supportingMaterials = deduplicateSupportingMaterials(activeFinding?.supportingMaterials)
  const authorityCount = findings.reduce((count, item) => count + (item.authorities?.length || 0), 0)

  useEffect(() => {
    if (!sourceOpen || !sourceDocuments.length || !activeSourceMatches.length) return
    const firstMatch = activeSourceMatches.find((match) => !selectedSourceFileId || match.fileId === selectedSourceFileId) || activeSourceMatches[0]
    const line = Number(firstMatch.lineStart)
    if (firstMatch.fileId) setSelectedSourceFileId(firstMatch.fileId)
    requestAnimationFrame(() => sourceLineRefs.current.get(`${firstMatch.fileId || firstMatch.fileName}:${line}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }, [activeFindingId, activeSourceMatches, selectedSourceFileId, sourceDocuments, sourceOpen])

  useEffect(() => {
    if ((!documentMode && result?.schemaVersion < 3) || !sourceTaskId || sourceLoadAttemptedRef.current === sourceTaskId) return
    sourceLoadAttemptedRef.current = sourceTaskId
    void loadSource()
  }, [documentMode, loadSource, result?.schemaVersion, sourceTaskId])

  if (documentMode && !(result?.schemaVersion >= 3 && Array.isArray(result.revisions))) {
    const contractText = sourceDocuments.map((document) => `=== 文件：${document.fileName || '上传文件'} ===\n${document.text || ''}`).join('\n\n')
    const revisions = Array.isArray(result?.revisions) ? result.revisions : []
    return (
      <div className="lca-result lca-contract-review-report lca-document-mode">
        <section className="lca-review-annotated-document">
          <div className="lca-review-document-heading"><div><h2>{t("合同原文批注")}</h2><p>{t("只读原文；橙色标记对应风险位置，展开标记可查看处理建议。")}</p></div><span>{revisions.length ? ((revisions.length) + t(" 处批注")) : t("旧报告未保存批注")}</span></div>
          {sourceLoading && <p className="lca-muted-copy">{t("正在读取合同原文…")}</p>}
          {sourceError && <p className="lca-source-message" role="status">{sourceError}</p>}
          {!sourceLoading && sourceDocuments.length === 0 && !sourceError && <p className="lca-muted-copy">{t("正在读取合同原文…")}</p>}
          {sourceDocuments.length > 0 && <RevisionDocument contractText={contractText} revisions={revisions} preserveFileMarkers />}
          {sourceDocuments.length === 0 && <button type="button" className="lca-load-source-button" onClick={() => { sourceLoadAttemptedRef.current = ''; void loadSource() }}>{sourceError ? t("重试读取原文") : t("读取合同原文")}</button>}
          {!revisions.length && sourceDocuments.length > 0 && <p className="lca-muted-copy">{t("这份历史报告没有保存原文批注；重新分析后可生成带定位标记的批注稿。")}</p>}
        </section>
      </div>
    )
  }

  if (result?.schemaVersion >= 3 && Array.isArray(result.revisions)) {
    const contractText = sourceDocuments.map((document) => `=== 文件：${document.fileName || '上传文件'} ===\n${document.text || ''}`).join('\n\n')
    const score = Number.isFinite(result.score?.value) ? result.score.value : null
    if (documentMode) return (
      <div className="lca-result lca-contract-review-report lca-document-mode">
        <section className="lca-review-annotated-document">
          <div className="lca-review-document-heading"><div><h2>{t("合同原文批注")}</h2><p>{t("只读原文；橙色标记对应风险位置，展开标记可查看处理建议。")}</p></div><span>{result.revisions.length ? ((result.revisions.length) + t(" 处批注")) : t("暂无可定位批注")}</span></div>
          {sourceLoading && <p className="lca-muted-copy">{t("正在读取合同原文…")}</p>}
          {sourceError && <p className="lca-source-message" role="status">{sourceError}</p>}
          {!sourceLoading && sourceDocuments.length === 0 && !sourceError && <p className="lca-muted-copy">{t("正在读取合同原文…")}</p>}
          {sourceDocuments.length > 0 && <RevisionDocument contractText={contractText} revisions={result.revisions} preserveFileMarkers />}
          {sourceDocuments.length === 0 && <button type="button" className="lca-load-source-button" onClick={() => { sourceLoadAttemptedRef.current = ''; void loadSource() }}>{sourceError ? t("重试读取原文") : t("读取合同原文")}</button>}
        </section>
        <aside className="revision-summary">
          <p>{result.revisions.length ? (t("已定位 ") + (result.revisions.length) + t(" 处原文批注。")) : t("本次没有生成可定位的原文批注。")}{score !== null ? (t(" 参考分 ") + (score) + "/100。") : ''}</p>
          <p className="revision-summary-tip">{t("分析结论和风险依据在对话正文中；展开编号批注可查看完整处理建议。")}</p>
        </aside>
        {result.warnings?.length > 0 && <details className="lca-review-warnings"><summary>{t("复核提醒（")}{result.warnings.length}）</summary><ul>{result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></details>}
      </div>
    )
    return (
      <div className="lca-result lca-contract-review-report">
        <header className="lca-review-note"><ShieldCheck size={19} aria-hidden="true" /><div><strong>{t("劳动合同审查结果")}</strong><p>{t("结合关注重点审阅合同并标注已定位的原文；风险等级和参考分由模型辅助判断，请结合实际复核。")}</p></div></header>
        <div className="lca-review-result-summary">
          <div><span>{t("合同基本信息")}</span><dl className="lca-narrative-facts lca-review-facts">
            {INFO_LABELS.filter(([key]) => result.contractInfo?.[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{result.contractInfo[key]}</dd></div>)}
          </dl></div>
          {score !== null && <div className="lca-model-score"><span>{t("参考分")}</span><strong>{score}<small>/100</small></strong></div>}
        </div>
        {result.conclusion && <p className="lca-review-conclusion">{result.conclusion}</p>}
        <section className="lca-review-annotated-document">
          <div className="lca-review-document-heading"><div><h2>{t("合同原文批注")}</h2><p>{t("只读原文；高亮表示已定位的风险片段，批注可展开查看处理建议。")}</p></div><span>{t("风险等级由模型辅助判断")}</span></div>
          {sourceLoading && <p className="lca-muted-copy">{t("正在读取合同原文…")}</p>}
          {sourceError && <p className="lca-source-message" role="status">{sourceError}</p>}
          {!sourceLoading && !sourceError && sourceDocuments.length === 0 && <p className="lca-muted-copy">{t("点击下方按钮读取原文批注稿。")}</p>}
          {sourceDocuments.length > 0 && <RevisionDocument contractText={contractText} revisions={result.revisions} preserveFileMarkers />}
          {sourceDocuments.length === 0 && <button type="button" className="lca-load-source-button" onClick={() => { sourceLoadAttemptedRef.current = ''; void loadSource() }}>{t("读取合同原文")}</button>}
        </section>
        {result.warnings?.length > 0 && <details className="lca-review-warnings"><summary>{t("复核提醒（")}{result.warnings.length}）</summary><ul>{result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></details>}
      </div>
    )
  }

  return (
    <div className="lca-result lca-readable-report">
      <div className={`lca-review-note${scopeConfirmationRequired ? ' lca-scope-note' : ''}`}>
        {scopeConfirmationRequired ? <CircleAlert size={19} aria-hidden="true" /> : streaming ? <Loader2 size={19} className="lca-spin" aria-hidden="true" /> : <ShieldCheck size={19} aria-hidden="true" />}
        <div>
          <strong>{scopeConfirmationRequired ? t("材料类型待确认，未执行风险分析") : streaming ? t("正在生成分析报告") : t("分析草案，待 Mentor / 法务复核")}</strong>
          <p>{scopeConfirmationRequired
            ? t("文本中出现劳务派遣合同/协议特征。该材料是否纳入首版范围尚待 Mentor 确认，当前没有检索法规或生成风险结论。")
            : streaming ? t("下方内容会在报告校验完成后出现；风险提示只标注已定位的原文。")
              : isDispatch ? t("派遣协议是主要分析对象；配套劳动合同和附件只作交叉核对。法规记录状态与条文适用性分开显示。结果待 Mentor / 法务复核。")
                : t("合同文本用于确认实际约定；法规记录状态与条文适用性分开显示。此结果不构成个案法律意见。")}</p>
          {result?.privacyNotice && <small className="lca-privacy-notice">{result.privacyNotice}</small>}
        </div>
      </div>

      <section className="lca-conclusion" aria-labelledby="lca-conclusion-title">
        <div className="lca-conclusion-header">
          <div><span>{t("审查结论")}</span><h2 id="lca-conclusion-title">{scopeConfirmationRequired ? t("当前材料还不能进入劳动合同分析") : completed ? (isDispatch ? t("派遣协议专项检查已完成") : t("合同重点事项已检查")) : (t("正在分析") + (isDispatch ? t("劳务派遣协议") : t("劳动合同")))}</h2></div>
          {!scopeConfirmationRequired && !isDispatch && completed && Number.isFinite(result?.score?.value) && <div className="lca-score-value" aria-label={(t("合同参考分 ") + (result.score.value) + t(" 分"))}><span>{t("参考分")}</span><strong>{result.score.value}<small>/ 100</small></strong></div>}
        </div>
        <p>{scopeConfirmationRequired
          ? t("材料是否属于首版范围尚待确认，因此没有生成风险判断。")
          : streaming
            ? t("系统正在读取材料、检查合同条款并定位原文。")
            : ((findings.length) + t(" 条风险提示，") + (missingItems.length) + t(" 项待补充信息。逐条查看原文、适用前提和建议；法规状态与条文对本合同的适用性分开核对。"))}</p>
        {!scopeConfirmationRequired && !isDispatch && completed && !Number.isFinite(result?.score?.value) && <p className="lca-muted-copy">{t("此报告没有可展示的参考分。")}</p>}
        {!scopeConfirmationRequired && isDispatch && <p className="lca-dispatch-perspective">{t("本次审查视角：")}{result?.reviewPerspectiveLabel || (result?.reviewPerspective === 'using_unit' ? t("用工单位") : t("派遣单位"))}{t("；报告仍会提示双方各自需要确认的事项。")}</p>}
      </section>

      <div className="lca-report-layout">
        <div className="lca-report-main">
          {(hasContractInfo || completed) && <details className="lca-report-disclosure" open={streaming || completed}>
            <summary><span><strong>{isDispatch ? t("协议基本信息") : t("合同基本信息")}</strong><small>{infoLabels.filter(([key]) => info[key]).length || t("查看识别结果")}</small></span><ChevronRight size={17} aria-hidden="true" /></summary>
            {hasContractInfo ? <dl className="lca-narrative-facts">
              {infoLabels.filter(([key]) => info[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{info[key]}</dd></div>)}
            </dl> : <p className="lca-muted-copy">{t("未能从文本中可靠提取合同基本信息。")}</p>}
          </details>}

          {(findings.length > 0 || completed || streaming) && <section className="lca-priority-section" aria-labelledby="lca-findings-title">
            <div className="lca-report-section-heading">
              <h2 id="lca-findings-title">{isDispatch ? t("需要你留意的协议事项") : t("需要你留意的条款")}</h2>
              <span>{findings.length ? ((findings.length) + t(" 条提示")) : streaming ? t("正在检查") : t("暂未生成风险提示")}</span>
            </div>
            {findings.length ? (
              <div className="lca-narrative-findings">
                {findings.map((finding, index) => (
                  <article className={`lca-narrative-finding${activeFinding?.id === finding.id ? ' active' : ''}`} key={finding.id}>
                    <button className="lca-finding-select" type="button" onClick={() => setActiveFindingId(finding.id)} aria-pressed={activeFinding?.id === finding.id}>
                      <span>{finding.topic || (t("风险提示 ") + (index + 1))}</span><strong>{finding.title}</strong><ChevronRight size={18} aria-hidden="true" />
                    </button>
                    <div className="lca-risk-level-placeholder" aria-label={(t("风险等级：") + (finding.level || t("待判断")))}><span>{t("风险等级")}</span><span className="lca-risk-level-blank" aria-hidden="true">{finding.level || ''}</span></div>
                    {finding.explanation && <p className="lca-narrative-copy">{finding.explanation}</p>}
                    <div className="lca-narrative-quote">
                      <span><FileText size={14} />{t("原文摘录")}</span>
                      {finding.quote ? <blockquote>“{finding.quote}”</blockquote> : <p>{t("未定位到可核验的原句，请勿仅凭此项判断合同内容。")}</p>}
                      <LocationText location={finding.location} />
                    </div>
                    {['found', 'ambiguous'].includes(finding.location?.status) && finding.location?.matches?.some((match) => Number(match.lineStart) > 0) && <button className="lca-source-jump" type="button" onClick={() => openFindingInSource(finding)}>{t("在合同原文中查看")}</button>}
                    {finding.applicableConditions?.length > 0 && <p className="lca-narrative-context"><strong>{t("适用前提：")}</strong>{finding.applicableConditions.join('；')}</p>}
                    {finding.recommendation && <p className="lca-narrative-recommendation"><strong>{t("可以怎么处理：")}</strong>{finding.recommendation}</p>}
                    {finding.suggestedClause && <details className="lca-narrative-clause"><summary>{t("查看建议条款文本")}</summary><blockquote>{finding.suggestedClause}</blockquote></details>}
                    {!finding.suggestedClause && <p className="lca-clause-unavailable">{t("本项未提供可直接使用的建议条款文本。")}</p>}
                  </article>
                ))}
              </div>
            ) : <p className="lca-muted-copy">{streaming ? t("正在定位原文并核对依据…") : t("暂未生成可定位的重点风险提示；仍建议结合合同全文和待核对事项复核。")}</p>}
          </section>}

          {(completed || streaming) && <section className="lca-source-viewer" aria-labelledby="lca-source-title">
            <div className="lca-source-viewer-heading">
              <div><h2 id="lca-source-title">{isDispatch ? t("上传材料原文") : t("合同原文")}</h2><p>{t("只读文本；点击提示可跳到对应行并高亮。")}</p></div>
              <button type="button" onClick={() => {
                const nextOpen = !sourceOpen
                setSourceOpen(nextOpen)
                if (nextOpen) void loadSource()
              }} aria-expanded={sourceOpen}>{sourceOpen ? t("收起全文") : t("查看全文")}</button>
            </div>
            {sourceOpen && <div className="lca-source-viewer-body">
              {sourceLoading && <p className="lca-muted-copy">{t("正在读取合同原文…")}</p>}
              {sourceError && <p className="lca-source-message" role="status">{sourceError}</p>}
              {sourceDocuments.length > 0 && <>
                {sourceDocuments.length > 1 && <label className="lca-source-file-select">{t("文件")}<select value={selectedSourceFileId} onChange={(event) => setSelectedSourceFileId(event.target.value)}>{sourceDocuments.map((document) => <option key={document.fileId} value={document.fileId}>{document.role ? `${MATERIAL_ROLE_LABELS[document.role] || document.role} · ` : ''}{document.fileName}</option>)}</select></label>}
                {activeFinding?.location?.status === 'ambiguous' && <p className="lca-source-message">{t("原文有重复内容，已标出可能对应的位置，请结合上下文核对。")}</p>}
                <div className="lca-source-text" aria-label={((sourceDocuments.find((document) => document.fileId === selectedSourceFileId)?.fileName || t("合同")) + t("原文"))}>
                  {(() => {
                    const document = sourceDocuments.find((item) => item.fileId === selectedSourceFileId) || sourceDocuments[0]
                    if (!document) return null
                    const lines = splitSourceTextIntoLines(document.text)
                    return <>
                      <div className="lca-source-document-name">{document.role ? `${MATERIAL_ROLE_LABELS[document.role] || document.role} · ` : ''}{document.fileName}</div>
                      <pre>{lines.map((line, index) => {
                        const lineNumber = index + 1
                        const lineMatches = activeSourceMatches.filter((match) => match.fileId ? match.fileId === document.fileId : match.fileName === document.fileName)
                        const lineRanges = lineMatches.flatMap((match) => {
                          const hasOffsets = Number.isInteger(Number(match.startOffset)) && Number.isInteger(Number(match.endOffset))
                            && Number(match.endOffset) > Number(match.startOffset)
                          if (hasOffsets) {
                            const start = Math.max(line.start, Number(match.startOffset))
                            const end = Math.min(line.end, Number(match.endOffset))
                            return end > start ? [{ start: start - line.start, end: end - line.start }] : []
                          }
                          return lineNumber >= Number(match.lineStart) && lineNumber <= Number(match.lineEnd)
                            ? [{ start: 0, end: line.text.length }]
                            : []
                        })
                        const isHighlighted = lineRanges.length > 0
                        const refMatch = lineMatches.find((match) => lineNumber >= Number(match.lineStart) && lineNumber <= Number(match.lineEnd))
                        return <span
                          key={lineNumber}
                          className={isHighlighted ? 'lca-source-line highlighted' : 'lca-source-line'}
                          ref={(element) => {
                            const key = `${refMatch?.fileId || refMatch?.fileName || document.fileId}:${lineNumber}`
                            if (element) sourceLineRefs.current.set(key, element)
                            else sourceLineRefs.current.delete(key)
                          }}
                        ><i>{lineNumber}</i><span>{renderSourceLineText(line.text, lineRanges)}</span></span>
                      })}</pre>
                    </>
                  })()}
                </div>
              </>}
            </div>}
          </section>}

          {!scopeConfirmationRequired && (missingItems.length > 0 || result?.contextQuestions?.length > 0 || result?.lawCandidates?.length > 0 || result?.warnings?.length > 0 || completed) && <section className="lca-final-check" aria-labelledby="lca-final-check-title">
            <span>{t("最后核对")}</span>
            <h2 id="lca-final-check-title">{isDispatch ? t("协作和签署前，还需要确认什么") : t("提交或签署前，还需要确认什么")}</h2>
            <p className="lca-final-check-status">{completed ? t("合同条款已完成检查") : t("检查进行中")}{missingItems.length ? (" · " + (missingItems.length) + t(" 项信息待补充")) : ''}{authorityCount ? (" · " + (authorityCount) + t(" 条已收录法规记录")) : ''}</p>
            {missingItems.length > 0 && <ul className="lca-final-list">{missingItems.map((item, index) => <li key={`${item.topic}-${item.item}-${index}`}><strong>{item.topic}</strong><span>{item.item}</span>{item.reason && <p>{item.reason}</p>}</li>)}</ul>}
            {result?.contextQuestions?.length > 0 && <div className="lca-final-subsection"><strong>{t("需要补充的适用前提")}</strong><ul>{result.contextQuestions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ul></div>}
            {result?.lawCandidates?.length > 0 && <div className="lca-final-subsection lca-unverified-laws"><strong>{t("待用户核验的法规线索")}</strong><p>{t("这些线索不是已确认的法律依据，不能单独用于判断合同或协议违法。请核对官方原文、地区和施行时间。")}</p><ul>{result.lawCandidates.map((item, index) => <li key={`${item.title}-${index}`}><b>{item.title}</b>{item.reason && `：${item.reason}`}</li>)}</ul></div>}
            {result?.warnings?.length > 0 && <div className="lca-final-subsection lca-final-warnings"><strong>{t("复核提醒")}</strong><ul>{result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></div>}
            {completed && !missingItems.length && !result?.contextQuestions?.length && !result?.lawCandidates?.length && !result?.warnings?.length && <p>{t("当前结果未列出额外待核对事项；法规记录状态不等于法律适用性已经确认，仍请结合实际复核。")}</p>}
          </section>}
        </div>

        <aside className="lca-evidence-rail" aria-label={t("所选风险的依据与核验信息")}>
          <div className="lca-evidence-rail-heading"><Scale size={17} /><div><strong>{t("依据与核验")}</strong><small>{activeFinding ? activeFinding.title : t("选择一条风险查看相关材料")}</small></div></div>
          {activeFinding?.authorities?.length > 0 ? <section className="lca-evidence-group">
            <h3>{t("法规记录")}</h3>
            {activeFinding.authorities.map((authority, index) => <article className="lca-evidence-entry" key={`${authority.title}-${authority.article}-${index}`}>
              <strong>{authority.title}{authority.article ? ` · ${authority.article}` : ''}</strong>
              <small>{authority.lawStatusLabel}{t("；该条文是否适用于本合同仍需复核")}</small>
              {authority.sourceUrl && <a href={authority.sourceUrl} target="_blank" rel="noreferrer">{t("查看官方来源")}</a>}
            </article>)}
          </section> : <section className="lca-evidence-group"><h3>{t("法规记录")}</h3><p>{activeFinding ? t("本项没有可引用的已收录法规记录；不以范本或风险规则替代法律依据。") : t("选择风险提示后，显示该项关联的法规记录。")}</p></section>}
          <section className="lca-evidence-group">
            <h3>{t("范本与风险规则")}</h3>
            {supportingMaterials.length ? supportingMaterials.map((source) => <article className="lca-evidence-entry" key={`${source.sourceType || 'material'}-${source.id || source.title}`}>
              <strong>{source.title || source.sourceName || t("劳动合同资料")}</strong>
              {source.text && <p>{supportingMaterialExcerpt(source.text)}</p>}
              <small>{source.sourceType === 'risk-rule' ? t("风险规则") : isDispatch ? t("派遣协议范本") : t("合同范本")}{t("· 仅用于条款对照和提示，不是法律依据")}</small>
            </article>) : <p>{t("本项没有检索到相关范本或风险规则。")}</p>}
          </section>
          <p className="lca-evidence-disclaimer">{t("依据仅用于帮助核对。法规记录状态、合同适用前提和法律结论需要分别判断。")}</p>
        </aside>
      </div>
    </div>
  )
}

export default function LaborContractAnalysisPage() {
  const t = useWorkspaceText()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const queryTaskId = searchParams.get('taskId') || ''
  const fileInputRef = useRef(null)
  const [files, setFiles] = useState([])
  const [fileRoles, setFileRoles] = useState([])
  const [classificationResults, setClassificationResults] = useState([])
  const [classifying, setClassifying] = useState(false)
  const classifyRequestRef = useRef(0)
  const submissionLockRef = useRef(false)
  const [analysisType, setAnalysisType] = useState('ordinary_labor_contract')
  const [reviewPerspective, setReviewPerspective] = useState('')
  const [focus, setFocus] = useState('')
  const [mode, setMode] = useState('thinking')
  const [task, setTask] = useState(null)
  const [threadTasks, setThreadTasks] = useState([])
  const [history, setHistory] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const { settings, sidebarCollapsed, initialConversationId, isSideChat } = useWorkspaceLayout()
  const lastTaskStorageKey = LAST_TASK_KEY
  const setAnalysisParams = useCallback((params, options) => setSearchParams({ ...params, ...(isSideChat ? { sideChat: initialConversationId } : {}) }, options), [setSearchParams, isSideChat, initialConversationId])
  const [reportSources, setReportSources] = useState({})
  const rememberReportSource = useCallback((id, documents) => {
    setReportSources((current) => current[id] === documents ? current : { ...current, [id]: documents })
  }, [])
  const [historyQuery, setHistoryQuery] = useState('')
  const [pendingDeleteThread, setPendingDeleteThread] = useState(null)
  const [deletingThreadId, setDeletingThreadId] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const historySearchRef = useRef(null)
  const searchShortcutLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K'
  const [partialReports, setPartialReports] = useState({})
  const [partialAnswers, setPartialAnswers] = useState({})
  const [reportOpen, setReportOpen] = useState(false)
  const [openReportTaskId, setOpenReportTaskId] = useState('')
  const conversationRef = useRef(null)
  const previousTaskRef = useRef(null)
  const selectionRequestRef = useRef(0)

  const currentThreadId = task?.threadId || task?.id || ''
  const visibleTasks = threadTasks.length
    ? threadTasks.map((item) => item.id === task?.id ? task : item)
    : task ? [task] : []
  const reports = visibleTasks.filter((item) => item.status === 'succeeded' && item.result?.analysisStatus === 'completed')
  const latestReportTask = reports.at(-1) || null

  useLayoutEffect(() => {
    const conversation = conversationRef.current
    if (conversation) conversation.scrollTop = conversation.scrollHeight
  }, [currentThreadId, task?.id])

  useEffect(() => {
    const previous = previousTaskRef.current
    previousTaskRef.current = task ? { id: task.id, status: task.status } : null
    if (previous && task && previous.id === task.id && !TERMINAL_STATUSES.has(previous.status)
      && task.status === 'succeeded' && task.action !== 'followup' && task.result?.analysisStatus === 'completed') {
      setOpenReportTaskId(task.id)
      setReportOpen(true)
    }
  }, [task?.id, task?.status, task?.result?.analysisStatus])

  useEffect(() => {
    const handleSearchShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        historySearchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  }, [])

  useEffect(() => {
    if (!pendingDeleteThread) return undefined
    const handleDialogKeys = (event) => {
      if (event.key === 'Escape' && !deletingThreadId) {
        setPendingDeleteThread(null)
        setDeleteError('')
      }
    }
    window.addEventListener('keydown', handleDialogKeys)
    return () => window.removeEventListener('keydown', handleDialogKeys)
  }, [pendingDeleteThread, deletingThreadId])

  const sourceTaskId = latestReportTask?.result?.sourceTaskId || latestReportTask?.id || ''
  const isRunning = Boolean(task && !TERMINAL_STATUSES.has(task.status))
  const fileAccept = ACCEPTED_EXTENSIONS

  const fetchTask = useCallback(async (taskId) => {
    const response = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    })
    if (!response.ok) return null
    const payload = await response.json().catch(() => ({}))
    return payload.task?.productId === PRODUCT_ID ? payload.task : null
  }, [])

  const fetchThread = useCallback(async (selected) => {
    const threadId = selected.threadId || selected.id
    const response = await authFetch(`/api/tasks/labor-contract-analysis/thread/${encodeURIComponent(threadId)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    })
    if (!response.ok) throw new Error(await readError(response, '会话记录读取失败'))
    const payload = await response.json().catch(() => ({}))
    return Array.isArray(payload.tasks) && payload.tasks.length ? payload.tasks : [selected]
  }, [])

  const refineAnalysisTitle = async (threadId, question) => {
    if (!threadId || !question?.trim()) return
    try {
      const response = await authFetch(`/api/tasks/labor-contract-analysis/thread/${encodeURIComponent(threadId)}/title`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.slice(0, 500) })
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok || !result.title) return
      const title = result.title
      setHistory((items) => items.map((item) => (item.threadId || item.id) === threadId ? { ...item, title } : item))
      setThreadTasks((items) => items.map((item) => (item.threadId || item.id) === threadId ? { ...item, title } : item))
      setTask((item) => item && (item.threadId || item.id) === threadId ? { ...item, title } : item)
    } catch { /* 标题提炼失败时保留服务端原标题 */ }
  }

  const refreshHistory = useCallback(async () => {
    if (isSideChat) return
    const response = await authFetch('/api/tasks?limit=100', {
      headers: { Accept: 'application/json' }, cache: 'no-store'
    })
    if (!response.ok) throw new Error(await readError(response, '任务记录读取失败'))
    const payload = await response.json().catch(() => ({}))
    setHistory((payload.tasks || []).filter((item) => item.productId === PRODUCT_ID))
  }, [isSideChat])

  useEffect(() => {
    let active = true
    const load = async () => {
      if (isSideChat) { setLoadingHistory(false); return }
      setLoadingHistory(true)
      try {
        const [historyResponse, storedTaskId] = await Promise.all([
          authFetch('/api/tasks?limit=100', { headers: { Accept: 'application/json' }, cache: 'no-store' }),
          Promise.resolve(isSideChat ? '' : window.localStorage.getItem(lastTaskStorageKey) || '')
        ])
        if (!historyResponse.ok) throw new Error(await readError(historyResponse, '任务记录读取失败'))
        const payload = await historyResponse.json().catch(() => ({}))
        if (!active) return
        const ownTasks = (payload.tasks || []).filter((item) => item.productId === PRODUCT_ID)
        setHistory(ownTasks)
        const preferredId = queryTaskId || storedTaskId
        if (preferredId) {
          const restored = await fetchTask(preferredId)
          if (active && restored) {
            const items = await fetchThread(restored)
            if (active) {
              const latest = items.at(-1) || restored
              setThreadTasks(items)
              setTask(latest)
              setMode(latest.mode === 'fast' ? 'fast' : 'thinking')
              setAnalysisType(latest.analysisType || latest.result?.analysisType || 'ordinary_labor_contract')
              setReviewPerspective(latest.reviewPerspective || latest.result?.reviewPerspective || '')
            }
          }
          else if (active && queryTaskId) setAnalysisParams({}, { replace: true })
        }
      } catch (loadError) {
        if (active) setError(loadError.message || '任务记录读取失败')
      } finally {
        if (active) setLoadingHistory(false)
      }
    }
    void load()
    return () => { active = false }
  }, [fetchTask, fetchThread, queryTaskId, setAnalysisParams, lastTaskStorageKey, isSideChat])

  useEffect(() => {
    if (!task?.id || ['succeeded', 'cancelled'].includes(task.status)) return undefined
    const controller = new AbortController()
    let active = true
    let sequence = 0
    const replayBoundary = Number(task.lastEventSeq) || 0
    let restoring = replayBoundary > 0
    let restoredReport = { schemaVersion: 3, analysisStatus: 'streaming', analysisType: task.analysisType || 'ordinary_labor_contract', revisions: [] }
    let restoredAnswer = ''
    const finishRestore = () => {
      if (!restoring || !active) return
      restoring = false
      setPartialReports((items) => ({ ...items, [task.id]: restoredReport }))
      setPartialAnswers((items) => ({ ...items, [task.id]: restoredAnswer }))
      requestAnimationFrame(() => {
        if (active && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight
      })
    }
    const patchProgress = (event, data) => {
      if (!active) return
      if (event === 'followup.delta' && typeof data?.content === 'string') {
        setPartialAnswers((items) => ({ ...items, [task.id]: `${items[task.id] || ''}${data.content}` }))
      } else {
        setPartialReports((items) => {
          const report = items[task.id] || { schemaVersion: 3, analysisStatus: 'streaming', analysisType: task.analysisType || 'ordinary_labor_contract', revisions: [] }
          const next = reduceLaborProgress(report, event, data)
          return next === report ? items : { ...items, [task.id]: next }
        })
      }
      if (event.endsWith('.delta') || task.status === 'failed') return
      setTask((current) => {
        if (current?.id !== task.id) return current
        const next = { ...current, lastEventSeq: sequence }
        if (event === 'model.progress') next.stageSummary = `${data.message || '正在处理'} · 已校验 ${data.completed || 0} 项`
        if (event === 'stage.start') { next.currentStage = data.stage; next.stageSummary = data.label || '' }
        if (event === 'stage.progress') next.stageSummary = data.message || next.stageSummary
        if (event === 'stage.complete') next.stageSummary = data.summary || next.stageSummary
        if (event === 'task.retry_waiting') next.status = 'retry_waiting'
        if (event === 'task.cancel_requested') next.status = 'cancel_requested'
        return next
      })
    }
    const reviewStream = throttleWithTrailing((data) => patchProgress('review.delta', data), MARKDOWN_THROTTLE_MS)
    const overviewStream = throttleWithTrailing((data) => patchProgress('analysis.delta', data), MARKDOWN_THROTTLE_MS)
    const receive = (event, data) => {
      const eventSequence = Number(data?._seq) || 0
      if (eventSequence && eventSequence <= sequence) return
      sequence = Math.max(sequence, eventSequence)
      if (restoring && eventSequence <= replayBoundary) {
        restoredReport = reduceLaborProgress(restoredReport, event, data)
        if (event === 'followup.delta' && typeof data?.content === 'string') restoredAnswer += data.content
        if (eventSequence === replayBoundary) finishRestore()
        return
      }
      finishRestore()
      if (event === 'review.delta' && data?.replace) reviewStream(data)
      else if (event === 'analysis.delta' && data?.replace) overviewStream(data)
      else {
        reviewStream.flush()
        overviewStream.flush()
        patchProgress(event, data)
      }
    }
    const watch = async () => {
      const deadline = Date.now() + 30 * 60 * 1000
      while (active && !controller.signal.aborted && Date.now() < deadline) {
        try {
          const response = await authFetch(`/api/tasks/${task.id}/events?after=${sequence}`, {
            headers: { Accept: 'text/event-stream' }, signal: controller.signal
          })
          if (!response.ok || !response.body) throw new Error(await readError(response, '任务进度连接失败'))
          await consumeSSE(response, receive, controller.signal)
          finishRestore()
          reviewStream.flush()
          overviewStream.flush()
        } catch (watchError) {
          if (!active || controller.signal.aborted) return
          setError(watchError.message || '任务进度连接中断，正在恢复…')
          await new Promise((resolve) => setTimeout(resolve, 900))
        }
        if (!active || controller.signal.aborted) return
        const latest = await fetchTask(task.id)
        if (latest) {
          setTask((current) => current?.id === task.id ? latest : current)
          if (TERMINAL_STATUSES.has(latest.status)) {
            if (!isSideChat) window.localStorage.setItem(lastTaskStorageKey, task.id)
            await refreshHistory().catch(() => {})
            const items = await fetchThread(latest).catch(() => [latest])
            if (active) setThreadTasks(items)
            return
          }
        } else {
          setError('任务记录不存在或当前账号无权查看。')
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      if (active && !controller.signal.aborted) setError('任务仍在运行；可重新打开任务记录查看进度。')
    }
    setError('')
    void watch()
    return () => { active = false; reviewStream.cancel(); overviewStream.cancel(); controller.abort() }
  }, [fetchTask, fetchThread, refreshHistory, task?.id])

  const classifyFiles = async (selectedFiles, preservedRoles = [], clarification = '') => {
    const requestId = ++classifyRequestRef.current
    if (!selectedFiles.length) {
      setClassificationResults([])
      setClassifying(false)
      return
    }
    setClassifying(true)
    setError('')
    setClassificationResults(selectedFiles.map((file, index) => ({
      fileName: file.name,
      parseStatus: 'pending',
      suggestedType: preservedRoles[index] || '',
      suggestedLabel: preservedRoles[index] ? MATERIAL_ROLE_LABELS[preservedRoles[index]] : '正在识别…',
      confidence: '',
      reason: '正在预解析正文并建议文书类型'
    })))

    try {
      const body = new FormData()
      selectedFiles.forEach((file) => body.append('files', file))
      if (clarification) body.append('clarification', clarification)
      const response = await authFetch('/api/tasks/labor-contract-analysis/classify', {
        method: 'POST', headers: { Accept: 'application/json' }, body
      })
      if (!response.ok) {
        const requestError = new Error(await readError(response, '文书类型识别失败'))
        requestError.rejected = response.status >= 400 && response.status < 500 && response.status !== 429
        throw requestError
      }
      const payload = await response.json()
      if (requestId !== classifyRequestRef.current) return
      const results = Array.isArray(payload.classifications) ? payload.classifications : []
      if (results.length !== selectedFiles.length) throw new Error('服务端返回的文书类型数量不匹配，请重新识别。')
      const normalizedResults = results.map((item, index) => ({
        ...item,
        fileName: selectedFiles[index]?.name || item.fileName || '上传文件'
      }))
      setClassificationResults(normalizedResults)
      const roles = normalizedResults.map((item, index) => (preservedRoles[index] !== 'unsupported' && preservedRoles[index]) || item.suggestedType || 'unsupported')
      setFileRoles(roles)
      if (normalizedResults.some((item) => item.suggestedType === 'dispatch_agreement')) {
        setAnalysisType('labor_dispatch_agreement')
      } else if (normalizedResults.some((item) => item.suggestedType === 'direct_labor_contract')) {
        setAnalysisType('ordinary_labor_contract')
      }
      setError(materialClassificationNotice(normalizedResults.map((item, index) => ({ ...item, suggestedType: roles[index] })), Boolean(clarification)))
      return { results: normalizedResults, roles }
    } catch (classificationError) {
      if (requestId === classifyRequestRef.current) {
        const failedResults = selectedFiles.map((file) => ({
          fileName: file.name,
          parseStatus: classificationError.rejected ? 'rejected' : 'unavailable',
          suggestedType: 'unsupported',
          suggestedLabel: '其他/暂不支持',
          confidence: 'low',
          reason: classificationError.message || '文书类型识别失败'
        }))
        setClassificationResults(failedResults)
        setError(materialClassificationNotice(failedResults))
      }
    } finally {
      if (requestId === classifyRequestRef.current) setClassifying(false)
    }
    return null
  }

  const addFiles = (incoming) => {
    const selected = mergeSelectedFiles(files, incoming)
    const preservedRoles = selected.files.map((file) => {
      const oldIndex = files.indexOf(file)
      return oldIndex >= 0 ? fileRoles[oldIndex] || '' : ''
    })
    setFiles(selected.files)
    setFileRoles(preservedRoles)
    setError(describeRejection(selected))
    if (selected.files.length !== files.length) void classifyFiles(selected.files, preservedRoles)
  }

  const removeSelectedFile = (index) => {
    const nextFiles = files.filter((_file, fileIndex) => fileIndex !== index)
    const nextRoles = fileRoles.filter((_role, fileIndex) => fileIndex !== index)
    classifyRequestRef.current += 1
    setFiles(nextFiles)
    setFileRoles(nextRoles)
    if (nextFiles.length) void classifyFiles(nextFiles, nextRoles)
    else {
      setClassificationResults([])
      setClassifying(false)
    }
  }

  const selectTask = async (taskId) => {
    const requestId = ++selectionRequestRef.current
    setError('')
    const selected = await fetchTask(taskId)
    if (requestId !== selectionRequestRef.current) return
    if (!selected) {
      setError('任务记录不存在或当前账号无权查看。')
      return
    }
    if (!isSideChat) window.localStorage.setItem(lastTaskStorageKey, taskId)
    const items = await fetchThread(selected)
    if (requestId !== selectionRequestRef.current) return
    const latest = items.at(-1) || selected
    setThreadTasks(items)
    setTask(latest)
    setMode(latest.mode === 'fast' ? 'fast' : 'thinking')
    setAnalysisType(latest.analysisType || latest.result?.analysisType || 'ordinary_labor_contract')
    setReviewPerspective(latest.reviewPerspective || latest.result?.reviewPerspective || '')
    setReportOpen(false)
    setOpenReportTaskId('')
    setAnalysisParams({ taskId }, { replace: true })
  }

  const cancelTaskAndWait = async (taskId) => {
    const response = await authFetch(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST', headers: { Accept: 'application/json' }
    })
    if (!response.ok) throw new Error(await readError(response, '停止当前任务失败'))
    let latest = (await response.json().catch(() => ({}))).task || null
    for (let attempt = 0; latest && !TERMINAL_STATUSES.has(latest.status) && attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      latest = await fetchTask(taskId)
    }
    if (!latest || !TERMINAL_STATUSES.has(latest.status)) throw new Error('当前任务仍在停止，请稍后再发送。')
    setTask(latest)
    setThreadTasks((items) => items.map((item) => item.id === latest.id ? latest : item))
    return latest
  }

  const submitTask = async (event, restartTask = null, snapshot = null) => {
    event?.preventDefault()
    if (submitting || submissionLockRef.current || classifying) return
    const focusSnapshot = restartTask ? snapshot ? [restartTask.prompt, snapshot.text.trim()].filter(Boolean).join('\n\n追加侧重点：') : restartTask.prompt || '请重新分析这份合同。' : snapshot ? snapshot.text.trim() : focus.trim()
    const filesSnapshot = restartTask ? [] : snapshot ? snapshot.files : [...files]
    if (isRunning && !focusSnapshot && !filesSnapshot.length) {
      await cancelTask()
      return
    }
    if (!isRunning && !filesSnapshot.length && (!task || !focusSnapshot)) return
    submissionLockRef.current = true
    setSubmitting(true)
    setError('')
    try {
      let analysisTypeSnapshot = snapshot?.analysisType || analysisType
      const perspectiveSnapshot = snapshot?.reviewPerspective || reviewPerspective
      let fileRolesSnapshot = snapshot ? snapshot.fileRoles : [...fileRoles]
      let classificationsSnapshot = snapshot ? snapshot.classificationResults : classificationResults
      if (filesSnapshot.length) {
        if (classificationsSnapshot.some((item) => BLOCKED_PARSE_STATUSES.has(item.parseStatus))) {
          setError(materialClassificationNotice(classificationsSnapshot))
          return
        }
        const allowedRoles = new Set(['direct_labor_contract', 'dispatch_employment_contract', 'dispatch_agreement', 'supporting_attachment', 'unsupported'])
        const serviceUnavailable = classificationsSnapshot.length !== filesSnapshot.length
          || classificationsSnapshot.some((item) => item.parseStatus === 'unavailable' || (item.suggestedType === 'unsupported' && item.classificationStatus === 'unavailable'))
        const needsClassification = serviceUnavailable || fileRolesSnapshot.length !== filesSnapshot.length
          || fileRolesSnapshot.some((role) => !allowedRoles.has(role) || role === 'unsupported')
        if (needsClassification) {
          if (!serviceUnavailable && !focusSnapshot) {
            setError(materialClassificationNotice(classificationsSnapshot))
            return
          }
          const selectionId = selectionRequestRef.current
          const refreshed = await classifyFiles(filesSnapshot, fileRolesSnapshot, focusSnapshot)
          if (!refreshed || selectionId !== selectionRequestRef.current) return
          fileRolesSnapshot = refreshed.roles
          classificationsSnapshot = refreshed.results
        }
        if (classificationsSnapshot.some((item) => item.parseStatus !== 'succeeded')) {
          setError(materialClassificationNotice(classificationsSnapshot))
          return
        }
        if (fileRolesSnapshot.length !== filesSnapshot.length || fileRolesSnapshot.some((role) => !allowedRoles.has(role) || role === 'unsupported')) {
          setError(materialClassificationNotice(classificationsSnapshot, Boolean(focusSnapshot)))
          return
        }
        const hasAgreement = fileRolesSnapshot.includes('dispatch_agreement')
        const hasDispatchContract = fileRolesSnapshot.includes('dispatch_employment_contract')
        const hasDirectContract = fileRolesSnapshot.includes('direct_labor_contract')
        const hasSupportingAttachment = fileRolesSnapshot.includes('supporting_attachment')
        if (hasDirectContract && (hasAgreement || hasDispatchContract)) {
          setError('普通劳动合同与派遣材料请分开分析；派遣协议和派遣劳动合同可一起上传交叉核对。')
          return
        }
        if (hasAgreement && fileRolesSnapshot.filter((role) => role === 'dispatch_agreement').length !== 1) {
          setError('一次分析请上传一份劳务派遣协议；多份协议请分别新建分析。')
          return
        }
        if (!hasAgreement && !hasDirectContract && !hasDispatchContract) {
          setError(hasSupportingAttachment
            ? '附件不能单独作为分析主文件，请同时上传劳动合同或劳务派遣协议。'
            : '请至少上传一份普通劳动合同或劳务派遣协议作为分析主文件。')
          return
        }
        if (hasAgreement && !['dispatch_unit', 'using_unit'].includes(perspectiveSnapshot)) {
          setError('请选择本次代表派遣单位还是用工单位。')
          return
        }
        analysisTypeSnapshot = hasAgreement ? 'labor_dispatch_agreement' : 'ordinary_labor_contract'
      }
      let action = restartTask ? 'restart-analysis' : filesSnapshot.length ? 'analyze' : task ? 'followup' : 'analyze'
      let sourceForRequest = restartTask?.id || (latestReportTask ? sourceTaskId : '')
      let reportForRequest = latestReportTask?.id || ''
      let focusForRequest = focusSnapshot

      if (isRunning && task) {
        const interruptedTask = task
        await cancelTaskAndWait(interruptedTask.id)
        if (filesSnapshot.length) {
          action = 'analyze'
          sourceForRequest = interruptedTask.id
          reportForRequest = ''
        } else if (interruptedTask.action === 'followup') {
          action = 'followup'
          sourceForRequest = interruptedTask.sourceTaskId || sourceForRequest
          reportForRequest = interruptedTask.reportTaskId || reportForRequest
        } else {
          action = 'restart-analysis'
          sourceForRequest = interruptedTask.action === 'restart-analysis'
            ? interruptedTask.sourceTaskId || interruptedTask.id
            : interruptedTask.id
          reportForRequest = ''
          focusForRequest = [interruptedTask.prompt, focusSnapshot]
            .filter(Boolean)
            .join('\n\n追加侧重点：')
        }
      }

      if (action === 'followup' && (!reportForRequest || !focusForRequest)) return
      if (action === 'restart-analysis' && !sourceForRequest) throw new Error('找不到可继续分析的原合同任务。')
      const body = new FormData()
      body.append('action', action)
      body.append('focus', action === 'followup' ? '' : focusForRequest)
      body.append('message', action === 'followup' ? focusForRequest : '')
      body.append('mode', snapshot?.mode || mode)
      body.append('temporary', String(isSideChat))
      if (action === 'analyze') {
        body.append('analysisType', analysisTypeSnapshot)
        body.append('documentTypes', JSON.stringify(fileRolesSnapshot))
        if (analysisTypeSnapshot === 'labor_dispatch_agreement') {
          body.append('reviewPerspective', perspectiveSnapshot)
        }
      }
      if (sourceForRequest) body.append('sourceTaskId', sourceForRequest)
      if (reportForRequest && action === 'followup') body.append('reportTaskId', reportForRequest)
      if (action === 'analyze') filesSnapshot.forEach((file) => body.append('files', file))
      const response = await authFetch('/api/tasks/labor-contract-analysis', {
        method: 'POST', headers: { Accept: 'application/json' }, body
      })
      if (!response.ok) throw new Error(await readError(response, '劳动合同分析任务创建失败'))
      const payload = await response.json()
      if (payload.productId !== PRODUCT_ID || !payload.taskId) throw new Error('服务端返回的任务类型不匹配，请稍后重试。')
      if (!isSideChat) window.localStorage.setItem(lastTaskStorageKey, payload.taskId)
      const created = payload.task || { id: payload.taskId, productId: PRODUCT_ID, status: payload.status, lastEventSeq: 0 }
      const createdThreadId = created.threadId || created.id
      const isFirstAnalysisInThread = action === 'analyze'
        && !threadTasks.some((item) => (item.threadId || item.id) === createdThreadId)
      setTask(created)
      setMode(created.mode === 'fast' ? 'fast' : mode)
      setThreadTasks((items) => [...items.filter((item) => item.id !== created.id), created])
      setAnalysisParams({ taskId: payload.taskId }, { replace: true })
      if (!snapshot) { setFiles([]); setFileRoles([]); setClassificationResults([]) }
      setClassifying(false)
      classifyRequestRef.current += 1
      if (!snapshot) setFocus('')
      if (action === 'followup') {
        setReportOpen(false)
      } else {
        setOpenReportTaskId('')
        setReportOpen(false)
      }
      await refreshHistory().catch(() => {})
      if (isFirstAnalysisInThread) {
        const titleInput = [focusForRequest, ...filesSnapshot.map((file) => file.name)]
          .filter(Boolean).join('；') || '劳动合同分析'
        void refineAnalysisTitle(createdThreadId, titleInput)
      }
    } catch (submitError) {
      setError(submitError.message || '劳动合同分析任务创建失败')
    } finally {
      submissionLockRef.current = false
      setSubmitting(false)
    }
  }

  const handleComposerSubmit = (event) => { event?.preventDefault(); queuedComposer.send() }

  const cancelTask = async () => {
    if (!task?.id || !isRunning) return
    setError('')
    try {
      const response = await authFetch(`/api/tasks/${task.id}/cancel`, { method: 'POST', headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(await readError(response, '停止任务失败'))
      const payload = await response.json().catch(() => ({}))
      if (payload.task) setTask(payload.task)
    } catch (cancelError) {
      setError(cancelError.message || '停止任务失败')
    }
  }

  const beginNew = () => {
    classifyRequestRef.current += 1
    setTask(null)
    setThreadTasks([])
    setFiles([])
    setFileRoles([])
    setClassificationResults([])
    setClassifying(false)
    setFocus('')
    setMode('thinking')
    setAnalysisType('ordinary_labor_contract')
    setReviewPerspective('')
    setAnalysisParams({}, { replace: true })
    setError('')
    setReportOpen(false)
    setOpenReportTaskId('')
    if (!isSideChat) window.localStorage.removeItem(lastTaskStorageKey)
  }

  const requestDeleteThread = (event, item) => {
    event.stopPropagation()
    if (!TERMINAL_STATUSES.has(item.status)) return
    setDeleteError('')
    setPendingDeleteThread({ id: item.threadId || item.id, title: item.title || '劳动合同分析' })
  }

  const confirmDeleteThread = async () => {
    if (!pendingDeleteThread || deletingThreadId) return
    const threadId = pendingDeleteThread.id
    setDeletingThreadId(threadId)
    setDeleteError('')
    try {
      const response = await authFetch(`/api/tasks/labor-contract-analysis/thread/${encodeURIComponent(threadId)}`, {
        method: 'DELETE', headers: { Accept: 'application/json' }
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok && payload.deleted !== true) {
        const message = response.status === 404 && !payload.code
          ? '本机后端还没有加载会话删除接口（404）。请重启后端服务后再试。'
          : payload.error || `删除会话失败（${response.status}）`
        throw new Error(message)
      }

      const deletedTaskIds = new Set(Array.isArray(payload.taskIds) ? payload.taskIds : [])
      setHistory((items) => items.filter((item) => (item.threadId || item.id) !== threadId))
      setPartialReports((items) => Object.fromEntries(Object.entries(items).filter(([taskId]) => !deletedTaskIds.has(taskId))))
      setPartialAnswers((items) => Object.fromEntries(Object.entries(items).filter(([taskId]) => !deletedTaskIds.has(taskId))))
      setPendingDeleteThread(null)
      if (deletedTaskIds.has(window.localStorage.getItem(lastTaskStorageKey) || '') || currentThreadId === threadId) {
        if (!isSideChat) window.localStorage.removeItem(lastTaskStorageKey)
      }
      if (currentThreadId === threadId) beginNew()
      if (!response.ok) setError(payload.error || '会话记录已删除，但临时文件清理未完成。')
      else setError('')
    } catch (deleteFailure) {
      setDeleteError(deleteFailure.message || '删除会话失败，请稍后重试。')
    } finally {
      setDeletingThreadId('')
    }
  }

  const conversationHeads = [...new Map(history.map((item) => [item.threadId || item.id, item]).reverse()).values()].reverse()
  const { visibleItems: matchingHistory, titleOf, renderTitle, historyControls, getHistoryMenuProps } = useConversationActions({
    items: conversationHeads, active: task, toolKey: 'labor-contract-analysis', query: historyQuery,
    onNew: beginNew, onSelect: (item) => { void selectTask(item.id) }
  })

  const sidebar = (
    <>
        <label className="sidebar-search"><History size={17} /><input ref={historySearchRef} value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder={t("搜索历史对话")} /><kbd>{searchShortcutLabel}</kbd></label>
        <div className="sidebar-brand"><span className="brand-orb"><img src="/logo.png" alt="" /></span><strong>{t("法飞飞")}</strong></div>
        <button className="sidebar-action" type="button" onClick={beginNew}><PenLine size={19} />{t("新建分析")}</button>
        <p className="history-label">{t("历史对话")}</p>
        <nav className="history-list lca-history-list" aria-label={t("劳动合同分析历史记录")}>
          {loadingHistory && <p className="lca-history-empty">{t("正在读取记录…")}</p>}
          {!loadingHistory && !matchingHistory.length && <p className="lca-history-empty">{history.length ? t("没有匹配的分析记录。") : t("完成一次分析后，记录会出现在这里。")}</p>}
          {matchingHistory.map((item) => (
            <div className="lca-history-row" key={item.id}>
              <button type="button" {...getHistoryMenuProps(item)} className={`${(item.threadId || item.id) === currentThreadId ? 'selected' : ''}${!TERMINAL_STATUSES.has(item.status) ? ' thread-running' : ''} lca-history-item`} title={`${item.title || t("劳动合同分析")} · ${TASK_STATUS[item.status] || item.status} · ${formatDate(item.createdAt)}`} onClick={() => void selectTask(item.id)}>
                <span className="history-thread-icon" aria-hidden="true">{!TERMINAL_STATUSES.has(item.status) ? <Loader2 size={16} className="spinner" /> : <MessageCircle size={16} />}</span>
                <span className="lca-history-copy"><span className="lca-history-title">{renderTitle(item)}</span><small>{formatRelativeTime(new Date(item.createdAt).getTime())}</small></span>
              </button>
              <button type="button" className="lca-history-delete" aria-label={(t("删除会话：") + (item.title || t("劳动合同分析")))} title={!TERMINAL_STATUSES.has(item.status) ? t("任务处理中，暂不能删除") : t("删除整段会话")} disabled={!TERMINAL_STATUSES.has(item.status)} onClick={(event) => requestDeleteThread(event, item)}><Trash2 size={15} /></button>
            </div>
          ))}
        </nav>
        {historyControls}
    </>
  )
  const reportViewTask = visibleTasks.find((item) => item.id === openReportTaskId)
    || (task?.id === openReportTaskId ? task : null)
  const reportViewData = reportViewTask?.result?.productId === PRODUCT_ID
    ? reportViewTask.result
    : partialReports[openReportTaskId] || null
  const reportIsStreaming = Boolean(reportViewTask && !TERMINAL_STATUSES.has(reportViewTask.status)
    && reportViewTask.action !== 'followup')
  const headerLeft = settings.analysisPanel && reportOpen
    ? <button className="icon-button" type="button" aria-label={t("返回对话")} onClick={() => setReportOpen(false)}><ChevronLeft size={21} /></button>
    : null
  const hasComposerInput = Boolean(files.length || focus.trim())
  const queuedComposer = useComposerSend({ tool: 'labor-contract', conversationId: currentThreadId, busy: isRunning || submitting, blocked: submitting || classifying, capture: () => ({ text: focus, files: [...files], mode, fileRoles: [...fileRoles], classificationResults, analysisType, reviewPerspective }), clear: () => { setFocus(''); setFiles([]); setFileRoles([]); setClassificationResults([]) }, onSend: (snapshot) => submitTask(null, snapshot && task && !latestReportTask && !snapshot.files.length ? task : null, snapshot), onStop: cancelTask })

  const composerActionLabel = isRunning
    ? hasComposerInput ? '停止当前任务并发送' : '停止生成'
    : files.length || !task ? '开始分析' : '发送'
  const composer = (
    <div className="composer-wrap"><MaterialReviewPanel taskId={task?.id} running={isRunning} />
      <form
        className="composer lca-composer"
        onSubmit={handleComposerSubmit}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false) }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files || [])) }}
      >
        <input ref={fileInputRef} className="lca-hidden-input" type="file" accept={fileAccept} multiple onChange={(event) => { addFiles(Array.from(event.target.files || [])); event.target.value = '' }} />
        {files.length > 0 && <div className="lca-analysis-options">
          {fileRoles.includes('dispatch_agreement') && <label>{t("分析视角")}<select value={reviewPerspective} onChange={(event) => { setReviewPerspective(event.target.value); setError((current) => current === '请选择本次代表派遣单位还是用工单位。' ? '' : current) }}>
            <option value="">{t("请选择您代表的一方")}</option><option value="dispatch_unit">{t("派遣单位")}</option><option value="using_unit">{t("用工单位")}</option>
          </select></label>}
        </div>}
        {files.length > 0 && <div className="lca-file-chips" aria-label={t("待上传文件")}>{files.map((file, index) => {
          return <span key={`${file.name}-${file.size}-${file.lastModified}`} title={file.name}>
            <FileText size={14} /><span>{file.name}</span><small>{formatSize(file.size)}</small>
            <button type="button" aria-label={(t("移除 ") + (file.name))} onClick={() => removeSelectedFile(index)}><X size={13} /></button>
          </span>
        })}</div>}
        <QueuedMessages composer={queuedComposer} />
        <textarea className="lca-chat-input" value={focus} maxLength={16000} onChange={(event) => setFocus(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); handleComposerSubmit(event) } }} placeholder={isRunning ? t("输入新问题后发送可打断当前生成；留空点击停止…") : files.length || !task ? t("上传劳动合同或派遣材料，可选填分析侧重点…") : t("围绕这份合同或报告继续提问…")} aria-label={files.length || !task ? t("分析侧重点，选填") : t("追问内容")} />
        {error && <p className="lca-inline-error" role="alert">{error}</p>}
        <div className="composer-bottom"><ToolComposerControls disabled={submitting} modeDisabled={isRunning || submitting} onUpload={() => fileInputRef.current?.click()} mode={mode} onModeChange={setMode} question={focus} hasPendingFiles={files.length > 0} messages={visibleTasks.flatMap((item) => [{ content: item.prompt }, { content: item.result?.answer || item.result?.reviewReport, result: item.result }])}>{dragging && <span>{t("松开以上传")}</span>}</ToolComposerControls><button className="voice-send" type="submit" disabled={submitting || classifying || (!isRunning && files.length > 0 && (classificationResults.length !== files.length || classificationResults.some((item) => BLOCKED_PARSE_STATUSES.has(item.parseStatus)))) || (!isRunning && !files.length && (!task || !focus.trim() || !latestReportTask))} aria-label={queuedComposer.label || t(composerActionLabel)} title={composerActionLabel}>{submitting ? <Loader2 size={17} className="lca-spin" /> : isRunning && !hasComposerInput ? <Square size={16} /> : <Send size={18} />}</button></div>
      </form>
      <p className="labor-disclaimer"><Scale size={13} />{t("本回答为辅助分析，不构成正式法律意见；重大金额、群体性争议、工伤认定与行政处罚事项请由专业人士复核。")}</p>
    </div>
  )

  const paneSourceId = reportViewData?.sourceTaskId || reportViewTask?.id || ''
  const paneOriginalText = (reportViewData?.sourceDocuments || reportSources[paneSourceId] || [])
    .map((document) => `=== 文件：${document.fileName || '上传文件'} ===\n${document.text || ''}`).join('\n\n')
  const reportPane = settings.analysisPanel && reportOpen && reportViewTask && (
    <section className="document-column lca-report-pane">
      <header className="document-header"><span>{reportViewTask.analysisType === 'labor_dispatch_agreement' ? t("劳务派遣协议审查批注稿") : t("劳动合同审查批注稿")}</span><div><button type="button" title={t("复制原文")} disabled={!paneOriginalText} onClick={() => { navigator.clipboard.writeText(paneOriginalText).catch(() => setError('复制失败，请手动选择原文复制。')) }}><Copy size={18} />{t("复制")}</button><button type="button" title={t("下载 Word 批注稿")} disabled={!paneOriginalText || reportIsStreaming} onClick={() => downloadRevisionWord({ name: reportViewTask.title, text: paneOriginalText, documentRevisions: reportViewData?.revisions || [], preserveFileMarkers: true })}><Download size={18} />{t("下载")}</button><small>{reportIsStreaming ? reportViewTask.stageSummary || t("正在生成") : TASK_STATUS[reportViewTask.status] || ''}</small><button className="close-document" type="button" aria-label={t("关闭审查批注稿")} onClick={() => setReportOpen(false)}><X size={21} /></button></div></header>
      <div className="document-scroll lca-report-scroll">
        <div className="lca-report-heading"><span>{reportViewTask.analysisType === 'labor_dispatch_agreement' ? t("劳务派遣协议分析") : t("劳动合同分析")}</span><h1>{reportViewTask.title || (reportViewTask.analysisType === 'labor_dispatch_agreement' ? t("劳务派遣协议审查批注稿") : t("劳动合同审查批注稿"))}</h1><p>{formatDate(reportViewTask.createdAt)}{reportViewTask.prompt ? (t(" · 侧重点：") + (reportViewTask.prompt)) : ''}</p></div>
        {reportViewData
            ? <AnalysisResult
              onSourceDocuments={rememberReportSource}
              key={`${reportViewTask.id}:${reportViewData?.sourceTaskId || reportViewTask.result?.sourceTaskId || reportViewTask.id}`}
              result={reportViewData}
              streaming={reportIsStreaming}
              sourceTaskId={reportViewData?.sourceTaskId || reportViewTask.result?.sourceTaskId || reportViewTask.id}
              documentMode
            />
            : reportIsStreaming
              ? <div className="lca-report-waiting"><Loader2 size={18} className="lca-spin" /><span>{reportViewTask.stageSummary || t("正在解析合同并生成分析报告…")}</span></div>
              : reportViewTask.status === 'failed'
                ? <div className="lca-failed-card"><CircleAlert size={18} /><div><strong>{t("本次分析未完成")}</strong><p>{reportViewTask.errorSummary || t("任务处理失败。")}</p></div></div>
                : reportViewTask.status === 'cancelled'
                  ? <div className="lca-cancelled-card"><Ban size={18} /><span>{t("任务已停止，未生成完整报告。")}</span></div>
                  : <div className="lca-report-waiting">{t("当前任务没有可展示的报告内容。")}</div>}
      </div>
    </section>
  )

  return (
    <ContractWorkbenchLayout
      className={`labor-contract-analysis lca-workspace${settings.analysisPanel && reportOpen ? ' document-expanded' : ''}`}
      sidebarClassName="lca-rail"
      sidebarCollapsed={sidebarCollapsed}
      hideSidebar={settings.analysisPanel && reportOpen}
      sidebar={sidebar}
      headerLeft={headerLeft}
      title={task ? titleOf(task) : t("劳动合同分析")}
      subtitle={t("从合同原文出发 · 风险提示需结合实际复核")}
      composer={composer}
      documentPane={reportPane}
      conversationRef={conversationRef}
    >
      <div className="conversation-inner lca-content">
        {isSideChat && !task && <SideChatEmptyState />}
        {!isSideChat && !task && (
          <div className="assistant-turn lca-intro">
            <p>{analysisType === 'labor_dispatch_agreement'
              ? t("你好，我是法飞飞劳动合同分析助手。上传劳务派遣协议后，可补充派遣劳动合同和附件，并选择派遣单位或用工单位视角。我会检查派遣专项事项、定位原文并列出待核对依据。")
              : t("你好，我是法飞飞劳动合同分析助手。上传劳动合同后，我会结合合同原文整理需要留意的条款、原文批注和处理建议。可选填关注点，完成后也可以继续问我这份合同的问题。")}</p>
            <div className="starter-prompts">
              <button type="button" onClick={() => setFocus('请重点看试用期和工作地点。')}>{t("重点看试用期和工作地点")}<span>→</span></button>
              <button type="button" onClick={() => setFocus('请重点看薪酬、工时和社保。')}>{t("重点看薪酬、工时和社保")}<span>→</span></button>
            </div>
          </div>
        )}
        {visibleTasks.map((item) => {
          const itemResult = item.status === 'succeeded' && item.result?.productId === PRODUCT_ID ? item.result : null
          const followup = itemResult?.kind === 'followup'
          const partialAnswer = partialAnswers[item.id] || ''
          const reportPartial = partialReports[item.id]
          const analysisRunning = !TERMINAL_STATUSES.has(item.status) && item.action !== 'followup'
          const analysisOverview = itemResult?.analysisOverview || reportPartial?.analysisOverview || ''
          const reviewReport = itemResult?.reviewReport || reportPartial?.reviewReport || ''
          const overviewSection = analysisOverview
            ? analysisOverview.startsWith('## 审查摘要') ? analysisOverview : `## 审查摘要\n${analysisOverview}`
            : ''
          const assistantReportText = [
            overviewSection,
            reviewReport
          ].filter(Boolean).join('\n\n---\n\n')
          const reviewProgressVisible = itemResult?.reviewRounds?.length > 0 || reportPartial?.reviewRounds?.length > 0
            || analysisRunning && (reportPartial?.activeReviewRound
              || item.id === task?.id && task.currentStage === 'review' && !task.lastEventSeq)
          return (
            <section className="lca-chat-turn" key={item.id}>
              <div className="lca-user-turn"><span>{item.prompt || (followup ? t("追问") : item.analysisType === 'labor_dispatch_agreement' ? t("请分析我上传的劳务派遣协议。") : t("请分析我上传的劳动合同。"))}</span>{item.files?.length > 0 && <small>{item.files.map((file) => file.originalName).join('、')}</small>}</div>
              <div className="assistant-turn lca-assistant-turn">
                <div className="lca-turn-meta"><strong>{t("法飞飞 ·")}{followup ? t("追问") : item.analysisType === 'labor_dispatch_agreement' ? t("劳务派遣协议分析") : t("劳动合同分析")}</strong><span>{formatDate(item.createdAt)}</span></div>
                {!TERMINAL_STATUSES.has(item.status) && item.action === 'followup' && !partialAnswer && <div className="lca-progress-card" aria-live="polite"><Loader2 size={18} className="lca-spin" /><div><strong>{item.stageSummary || t("正在整理追问回复…")}</strong></div></div>}
                {item.status === 'failed' && <div className="lca-failed-card"><CircleAlert size={18} /><div><strong>{t("本次")}{item.files?.length ? t("分析") : t("回复")}{t("未完成")}</strong><p>{/ECONNRESET|流连接中断|LLM_STREAM|terminated/i.test(item.errorSummary || '') ? t("模型连接中断，自动重试仍未完成。下方保留已收到的草稿和完成轮次，尚不是最终报告。") : item.errorSummary || t("任务处理失败，请稍后重试。")}</p></div></div>}
                {item.status === 'failed' && item.action !== 'followup' && <button type="button" className="lca-load-source-button" disabled={submitting || isRunning} onClick={() => void submitTask(null, item)}><RotateCw size={14} />{t("重新分析")}</button>}
                {item.status === 'cancelled' && <div className="lca-cancelled-card"><Ban size={18} /><span>{t("任务已停止，未生成完整结果。")}</span></div>}
                {(followup || (item.action === 'followup' && partialAnswer)) && <div className="lca-followup-answer"><ReactMarkdown remarkPlugins={[remarkGfm]}>{itemResult?.answer || partialAnswer}</ReactMarkdown>{itemResult && !itemResult.sourceAvailable && <small>{t("本轮仅依据旧报告解释，未重新读取合同原文。")}</small>}</div>}
                {analysisRunning && <div className="lca-progress-card" aria-live="polite"><Loader2 size={18} className="lca-spin" /><div><strong>{item.stageSummary || t("正在整理合同概况…")}</strong></div></div>}
                {assistantReportText && <div className="assistant-content lca-review-chat-output"><ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeLaborReportMarkdown(assistantReportText)}</ReactMarkdown></div>}
                {reviewProgressVisible && <ReviewRoundsPanel
                  rounds={itemResult?.reviewRounds || reportPartial?.reviewRounds || []}
                  thinking={analysisRunning && item.id === task?.id && task.currentStage === 'review'}
                  activeRound={reportPartial?.activeReviewRound}
                  finished={TERMINAL_STATUSES.has(item.status) || reportPartial?.reviewFinished}
                  interrupted={item.status === 'failed'}
                  stoppedEarly={itemResult?.reviewStoppedEarly || reportPartial?.reviewStoppedEarly}
                />}
                {!itemResult && reportPartial?.revisions?.length > 0 && <button type="button" className="open-document-card lca-open-report-card" onClick={() => { setOpenReportTaskId(item.id); setReportOpen(true) }}>
                  <FileText size={25} /><span><strong>{t("查看正在生成的原文批注稿")}</strong><small>{reportPartial.revisions.length}{t("组批注已补入完整原文")}</small></span>
                </button>}
                {itemResult && itemResult.kind !== 'followup' && <button type="button" className="open-document-card lca-open-report-card" onClick={() => { setOpenReportTaskId(item.id); setReportOpen(true) }}>
                  <FileText size={25} />
                  <span><strong>{item.analysisType === 'labor_dispatch_agreement' ? t("劳务派遣协议审查批注稿") : t("劳动合同审查批注稿")}</strong><small>{Number.isFinite(itemResult?.score?.value) ? (t("参考分 ") + (itemResult.score.value) + "/100 · ") : ''}{itemResult?.revisions?.length || 0}{t("处原文批注 · 点击查看")}</small></span>
                </button>}
                {itemResult && itemResult.kind !== 'followup' && itemResult.analysisStatus === 'scope-confirmation-required' && <p className="lca-muted-copy">{t("材料范围尚待确认，未执行风险分析。")}</p>}
              </div>
            </section>
          )
        })}
      </div>
      {pendingDeleteThread && <div className="lca-delete-overlay" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deletingThreadId) setPendingDeleteThread(null)
      }}>
        <section className="lca-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="lca-delete-title" aria-describedby="lca-delete-description">
          <div className="lca-delete-icon"><Trash2 size={19} /></div>
          <h2 id="lca-delete-title">{t("删除这段分析记录？")}</h2>
          <p className="lca-delete-name">{pendingDeleteThread.title}</p>
          <p id="lca-delete-description">{t("将清除整段会话及关联的分析报告、追问、任务记录和上传文件。此操作无法撤销。正在处理的会话不能删除。")}</p>
          {deleteError && <p className="lca-delete-error" role="alert">{deleteError}</p>}
          <div className="lca-delete-actions">
            <button type="button" disabled={Boolean(deletingThreadId)} onClick={() => setPendingDeleteThread(null)}>{t("取消")}</button>
            <button type="button" className="danger" disabled={Boolean(deletingThreadId)} onClick={() => void confirmDeleteThread()}>{deletingThreadId ? t("正在删除…") : t("删除会话")}</button>
          </div>
        </section>
      </div>}
    </ContractWorkbenchLayout>
  )
}
