import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, X } from 'lucide-react'
import { useWorkspaceText } from './WorkspaceContext'
import { RevisionDocument, downloadRevisionWord } from '../pages/ContractRewritePage'
import { buildHandbookAnnotations, handbookAnnotationText } from '../utils/handbook-annotations'

export default function HandbookAnnotatedDocument({ report, citation, onClose }) {
  const t = useWorkspaceText()
  const { documents, unresolved } = useMemo(() => buildHandbookAnnotations(report), [report])
  const match = citation?.location?.status === 'found' ? citation.location.matches[0] : null
  const [selectedFile, setSelectedFile] = useState('')
  const [error, setError] = useState('')
  const paper = useRef(null)
  const file = documents.find((document) => document.fileId === (selectedFile || match?.fileId)) || documents[0]
  useEffect(() => { if (match?.fileId) setSelectedFile(match.fileId) }, [match?.fileId])
  useEffect(() => {
    if (!file || !match || file.fileId !== match.fileId) return
    const line = file.text.slice(0, match.startOffset).split('\n').length - 1
    paper.current?.querySelector(`[data-source-line="${line}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [citation, match, file])
  if (!file) return null
  return <aside className="hb-source document-column" aria-label={t('员工手册诊断批注稿')}>
    <header className="document-header"><span>{t('员工手册诊断批注稿')}</span><div>
      <button type="button" aria-label={t('复制原文')} onClick={() => { navigator.clipboard.writeText(file.text).catch(() => setError('复制失败，请手动选择原文复制。')) }}><Copy size={18} />{t('复制')}</button>
      <button type="button" aria-label={t('下载诊断批注稿')} disabled={report.analysisStatus !== 'completed'} onClick={() => downloadRevisionWord({ name: file.fileName.replace(/\.[^.]+$/, ''), suffix: '诊断批注稿', text: handbookAnnotationText(file, unresolved), documentRevisions: file.revisions, preserveFileMarkers: true })}><Download size={18} />{t('下载')}</button>
      <button type="button" aria-label={t('关闭原文')} onClick={onClose}><X size={20} /></button>
    </div></header>
    {documents.length > 1 && <label className="hb-source-file">{t('文件')}<select aria-label={t('切换批注文件')} value={file.fileId} onChange={(event) => setSelectedFile(event.target.value)}>{documents.map((document) => <option key={document.fileId} value={document.fileId}>{document.fileName}</option>)}</select></label>}
    <p className="hb-source-caption">{file.fileName} · {t('原文保留，编号对应诊断问题；建议尚未应用。')}</p>
    {error && <p role="alert">{error}</p>}
    <div ref={paper} className="hb-source-paper document-content">
      <RevisionDocument contractText={file.text} revisions={file.revisions} preserveFileMarkers />
      {unresolved.length > 0 && <section className="hb-unlocated"><h2>{t('未定位诊断提示')}</h2>{unresolved.map(({ finding, markerNumber, reason }) => <article key={finding.id}><h3>{markerNumber}. {finding.title}</h3><p>{reason}</p><p>{finding.explanation}</p><p>{t('修改建议')}：{finding.recommendation}</p></article>)}</section>}
    </div>
  </aside>
}
