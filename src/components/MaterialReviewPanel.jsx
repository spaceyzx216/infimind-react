import { useEffect, useRef, useState } from 'react'
import { authFetch } from '../utils/auth-api.js'
import './MaterialReviewPanel.css'

export default function MaterialReviewPanel({ taskId, running = false }) {
  const [summary, setSummary] = useState(null)
  const [document, setDocument] = useState(null)
  const [selected, setSelected] = useState(null)
  const [image, setImage] = useState('')
  const [error, setError] = useState('')
  const [regionPage, setRegionPage] = useState(0)
  const sequence = useRef(0)
  const base = `/api/tasks/${encodeURIComponent(taskId || '')}/materials`
  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setSummary(null); setDocument(null); setSelected(null); setError(''); setRegionPage(0); sequence.current++
    if (!taskId) return () => controller.abort()
    const load = async () => {
      try {
        const response = await authFetch(base, { signal: controller.signal })
        if (!response.ok) return
        const data = await response.json()
        if (alive) setSummary(data)
      } catch { /* Existing task errors remain in the tool's own UI. */ }
    }
    void load()
    const timer = running ? setInterval(load, 5000) : null
    return () => { alive = false; controller.abort(); clearInterval(timer) }
  }, [taskId, running, base])
  useEffect(() => {
    let alive = true, url = ''
    const controller = new AbortController()
    setImage('')
    if (!selected || !document) return () => controller.abort()
    void authFetch(`${base}/${encodeURIComponent(document.fileId)}/regions/${encodeURIComponent(selected.id)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error || '原图不可读取')
        const blob = await response.blob()
        if (alive) { url = URL.createObjectURL(blob); setImage(url) }
      }).catch((cause) => { if (alive) setError(cause.message) })
    return () => { alive = false; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [selected, document, base])
  const inspect = async (fileId) => {
    const request = ++sequence.current
    setError(''); setSelected(null); setDocument(null); setRegionPage(0)
    try {
      const response = await authFetch(`${base}/${encodeURIComponent(fileId)}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '材料不可读取')
      if (request === sequence.current) setDocument(data)
    } catch (cause) { if (request === sequence.current) setError(cause.message) }
  }
  if (!summary?.documents?.length && !summary?.failures?.length) return null
  const coverage = summary.coverage
  const regions = document?.regions || [], pageSize = 100
  const changeRegionPage = (page) => { setRegionPage(page); setSelected(null); setError('') }
  return <details className="material-review-panel">
    <summary>材料读取范围与 OCR 核对</summary>
    {coverage && <p>已解析 {coverage.parsed || 0} 个内容块 · 已整理摘录 {coverage.indexed?.length || 0} 块 · 本轮选取 {coverage.selected?.length || 0} 块 · 已进入模型 {coverage.entered?.length || 0} 块 · 已完成检查 {coverage.checked?.length || 0} 块</p>}
    {coverage?.simulated && <p>当前为测试模式，模型处理与检查记录为流程模拟。</p>}
    {coverage?.partial && <p>本轮包含未检查或未读取内容；请结合下方提示核对分析范围。</p>}
    {(summary.failures || []).map((failure) => <p key={failure.fileId || failure.fileName} role="alert">{failure.fileName}：{failure.reason}</p>)}
    {summary.documents.map((d) => <div key={d.fileId} className="material-review-file">
      <strong>{d.fileName}</strong>{d.completeness === 'partial' && <span> · 部分内容未读取</span>}
      {d.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
      <button type="button" onClick={() => { void inspect(d.fileId) }}>查看识别文字{d.ocrRegionCount ? `与原图（${d.ocrRegionCount}处待核对）` : ''}</button>
    </div>)}
    {document && <section aria-label="OCR原图核对">
      <h4>{document.fileName}</h4>
      <p>识别文字为机器读取结果。金额、日期、姓名和否定词请对照原件；此处不会自动修改原文。</p>
      <div className="material-review-regions">{regions.slice(regionPage * pageSize,(regionPage+1) * pageSize).map((region) => <button type="button" key={region.id} aria-pressed={selected?.id === region.id} onClick={() => { setError(''); setSelected(region) }}>{region.location ? `${region.location}：` : ''}{region.text} · {region.reason}</button>)}</div>
      {regions.length > pageSize && <nav aria-label="OCR核对区域分页">
        <button type="button" disabled={regionPage === 0} onClick={() => changeRegionPage(regionPage-1)}>上一页</button>
        <span> 第{regionPage+1}页，共{Math.ceil(regions.length/pageSize)}页（{regions.length}处） </span>
        <button type="button" disabled={(regionPage+1)*pageSize >= regions.length} onClick={() => changeRegionPage(regionPage+1)}>下一页</button>
      </nav>}
      {selected && <div className="material-review-comparison"><p>识别文字：<strong>{selected.text}</strong></p>
        {image && <img src={image} onLoad={(event) => event.currentTarget.scrollIntoView({ block: 'nearest' })} alt={`原图核对：${selected.text}`} />}
        {selected.candidates?.length > 0 && <details><summary>另一次识别结果（仅供核对）</summary><pre>{selected.candidates.join('\n')}</pre></details>}
      </div>}
      <details><summary>完整解析文字</summary><pre>{document.text}</pre></details>
    </section>}
    {error && <p role="alert">{error}</p>}
  </details>
}
