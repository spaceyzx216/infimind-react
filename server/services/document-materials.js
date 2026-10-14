import { createHash } from 'node:crypto'
import { estimateTokens } from '../../src/utils/context-budget.js'

export const DOCUMENT_PARSER_VERSION = 4
export const MAX_DOCUMENT_CHARACTERS = 2_000_000
export const DOCUMENT_CHUNK_TOKENS = 6000
export const fingerprint = (value) => createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex')

export function assertDocumentLength(text) {
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw Object.assign(new Error('单文件解析正文超过200万字符，请拆分后提交；正文未被截断。'), { code: 'document_too_large', retryable: false })
  return text
}

// Offsets always address the immutable extracted text, never a model summary.
export function splitDocument(text, { fileId = '', fileName = '', budget = DOCUMENT_CHUNK_TOKENS, sections = [] } = {}) {
  if (!Number.isFinite(budget) || budget < 32) throw new Error('材料分块预算无效')
  const blocks = []
  let start = 0
  while (start < text.length) {
    const section = sections.find((item) => start >= item.start && start < item.end)
    const nextSection = sections.find((item) => item.start > start)
    const boundaryEnd = Math.min(text.length, section?.end ?? nextSection?.start ?? text.length)
    let low = start + 1, high = boundaryEnd
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (estimateTokens(text.slice(start, mid)) <= budget) low = mid
      else high = mid - 1
    }
    let end = low
    const newline = text.lastIndexOf('\n', end - 1)
    if (end < boundaryEnd && newline > start + (end - start) / 2) end = newline + 1
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    if (end <= start) end = Math.min(start + 2, text.length)
    blocks.push({ id: fingerprint(`${fileId}:${start}:${end}:${text.slice(start, end)}`).slice(0, 24), fileId, fileName,
      start, end, text: text.slice(start, end), source: section?.source || {}, context: section?.header || '',
      continuation: Boolean(section && start > section.start) })
    start = end
  }
  return blocks
}

export function finalizeDocument(result, file) {
  const text = assertDocumentLength(String(result.text || ''))
  const metadata = result.metadata || {}
  const unreadableParts = metadata.unreadableParts || []
  const warnings = [...new Set([...(metadata.warnings || []), ...unreadableParts])]
  const incompletePages = metadata.pages?.some((page) => page.error || !page.text?.trim())
  const fileId = String(file.id || fingerprint(file.buffer).slice(0, 24))
  return { ...result, text, metadata: { ...metadata, warnings, unreadableParts, parserVersion: DOCUMENT_PARSER_VERSION,
    fingerprint: fingerprint(text), completeness: !text.trim() ? 'empty' : unreadableParts.length || incompletePages ? 'partial' : 'complete',
    blocks: splitDocument(text, { fileId, fileName: file.originalname, sections: metadata.sections || (metadata.format === 'image' ? [{ start: 0, end: text.length, source: { method: 'ocr' }, header: 'OCR文字待核对' }] : []) }),
    ocrRegions: (metadata.ocrRegions || []).map((r) => r.origin?.kind === 'file-image' ? { ...r, origin: { ...r.origin, hash: fingerprint(file.buffer) } } : r) } }
}

export function documentBlocks(documents) {
  return documents.flatMap((doc) => splitDocument(assertDocumentLength(String(doc.text || '')), {
    fileId: String(doc.fileId || doc.id || fingerprint(doc.fileName || doc.name || doc.text).slice(0, 24)),
    fileName: doc.fileName || doc.name || '', sections: doc.parseMetadata?.sections || doc.metadata?.sections || [] }))
}

export const isWholeDocumentQuestion = (query) => !String(query || '').trim() || /全文|整体|全面|所有|完整|逐条|审查|评估|诊断/.test(query)

export function selectMaterialBlocks(documents, query, budget = 24000) {
  const blocks = documentBlocks(documents)
  const terms = [...new Set((String(query || '').match(/[A-Za-z0-9]{2,}|[\u4e00-\u9fff]{2,}/g) || [])
    .flatMap((term) => /[\u4e00-\u9fff]/.test(term) ? [term, ...Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2))] : [term.toLowerCase()]))]
  const ranked = blocks.map((block, index) => ({ index, score: terms.reduce((n, term) => n + ((block.text + block.context).toLowerCase().includes(term) ? term.length : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const indices = new Set()
  let used = 0
  for (const { index } of ranked) {
    for (const at of [index, index - 1, index + 1]) {
      const block = blocks[at]
      if (!block || indices.has(at) || (at !== index && block.fileId !== blocks[index].fileId)) continue
      const cost = estimateTokens(block.text + block.context)
      if (used + cost > budget) continue
      used += cost; indices.add(at)
    }
  }
  const selected = blocks.filter((_, i) => indices.has(i))
  return { blocks: selected, coverage: { parsed: blocks.length, selected: selected.map((b) => b.id), checked: [], partial: selected.length !== blocks.length } }
}

export function materialNotice(documents, coverage) {
  const warnings = documents.flatMap((d) => d.parseMetadata?.warnings || d.parseWarnings || d.metadata?.warnings || [])
  return [...new Set([...warnings, ...(coverage?.partial ? ['本轮按问题选择材料片段，未逐块检查全文。'] : [])])].join('\n')
}

export function formatMaterialBlocks(blocks) {
  return blocks.map((b) => `【材料 ${b.fileName}${b.source.page ? `｜第${b.source.page}页` : b.source.slide ? `｜幻灯片${b.source.slide}` : b.source.sheet ? `｜工作表${b.source.sheet}` : b.source.table ? `｜表格${b.source.table}` : ''}${b.source.method?.includes('ocr') ? '｜OCR文字待核对' : ''}｜块 ${b.id}｜原文字符 ${b.start + 1}-${b.end}】\n${b.context ? `表格开头上下文：${b.context}\n` : ''}${b.text}`).join('\n\n')
}
