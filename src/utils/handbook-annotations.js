const compact = (value) => String(value || '').replace(/\s/g, '')

export function canShowHandbookClause(finding, documents = []) {
  if (!finding.suggestedClause || finding.status === 'pending' || finding.locationStatus === 'unverified' || !finding.evidence?.length) return false
  return finding.evidence.every((citation) => {
    const matches = citation.location?.matches || []
    if (citation.location?.status !== 'found' || matches.length !== 1) return false
    const match = matches[0], document = documents.find((item) => item.fileId === match.fileId)
    return document && Number.isInteger(match.startOffset) && Number.isInteger(match.endOffset)
      && match.startOffset >= 0 && match.endOffset > match.startOffset && match.endOffset <= document.text.length
      && compact(citation.quote) && compact(document.text.slice(match.startOffset, match.endOffset)) === compact(citation.quote)
      && !document.parseMetadata?.ocrRegionCount && !document.parseMetadata?.ocrRegions?.length
      && !document.pages?.some((page) => page.method && page.method !== 'text')
      && !document.parseMetadata?.blocks?.some((block) => block.source?.method?.includes('ocr'))
  })
}

function spansAt(text, start, end) {
  const spans = []
  let offset = 0
  text.split('\n').forEach((line, index) => {
    const left = Math.max(start, offset), right = Math.min(end, offset + line.length)
    if (right > left) spans.push({ line: index, start: left - offset, end: right - offset })
    offset += line.length + 1
  })
  return spans
}

// Locations are accepted only against the saved source, never searched again
// across a document. A clause proposal is an annotation, not a local replacement.
export function buildHandbookAnnotations(report = {}) {
  const documents = (report.sourceDocuments || []).map((document) => ({ ...document, revisions: [] }))
  const unresolved = []
  for (const [index, finding] of (report.findings || []).entries()) {
    let placed = 0
    for (const [position, citation] of (finding.evidence || []).entries()) {
      const matches = citation.location?.matches || []
      if (citation.location?.status !== 'found' || matches.length !== 1) continue
      const match = matches[0], document = documents.find((item) => item.fileId === match.fileId)
      if (!document || !Number.isInteger(match.startOffset) || !Number.isInteger(match.endOffset)
        || match.startOffset < 0 || match.endOffset <= match.startOffset || match.endOffset > document.text.length) continue
      const quote = document.text.slice(match.startOffset, match.endOffset)
      if (!compact(citation.quote) || compact(quote) !== compact(citation.quote)) continue
      const quoteSpans = spansAt(document.text, match.startOffset, match.endOffset)
      if (!quoteSpans.length) continue
      const ocr = Boolean(document.parseMetadata?.ocrRegionCount || document.parseMetadata?.ocrRegions?.length
        || document.pages?.some((page) => page.method && page.method !== 'text')
        || document.parseMetadata?.blocks?.some((block) => block.source?.method?.includes('ocr')))
      const pending = ocr || finding.status === 'pending' || finding.locationStatus === 'unverified'
      const related = (finding.evidence || []).flatMap((item) => item.location?.status === 'found'
        ? item.location.matches.map((location) => `${location.fileName} · ${location.sectionTitle}`) : [])
      const note = [finding.title, pending ? '原文或适用条件待确认，本批注仅作提示。' : '',
        finding.explanation, finding.recommendation, ...(finding.conditions || []).map((item) => `适用条件：${item}`),
        ...(finding.relatedChanges || []).map((item) => `关联修改：${item}`), `关联原文：${[...new Set(related)].join('；')}`].filter(Boolean).join('\n\n')
      const id = `${finding.id}:citation:${position}`
      document.revisions.push({ findingId: finding.id, title: finding.title,
        level: pending ? '待判断' : ({ high: '高', medium: '中', low: '低' }[finding.level] || '待判断'), action: 'modify',
        lineStart: quoteSpans[0].line, lineEnd: quoteSpans.at(-1).line, rewrittenText: canShowHandbookClause(finding, documents) ? finding.suggestedClause : '',
        localizedEdits: [{ editId: id, markerNumber: index + 1, operation: 'notice', targetQuote: quote,
          quoteSpans, lineStart: quoteSpans[0].line, lineEnd: quoteSpans.at(-1).line,
          noticeText: [finding.title, pending ? '原文或适用条件待确认。' : '', finding.recommendation].filter(Boolean).join('\n'),
          riskNote: note, localizationStatus: 'handbook-notice', replacementText: '' }] })
      placed++
    }
    if (!placed || placed < (finding.evidence || []).length) unresolved.push({ finding, markerNumber: index + 1,
      reason: placed ? '部分引用没有唯一、有效的原文位置。' : '尚无可验证的原文位置。' })
  }
  return { documents, unresolved }
}

export function handbookAnnotationText(document, unresolved = []) {
  if (!unresolved.length) return document.text
  return document.text + '\n\n# 未定位诊断提示\n\n' + unresolved.map(({ finding, markerNumber, reason }) =>
    `${markerNumber}. ${finding.title}\n${reason}\n${finding.explanation || ''}\n` +
    (finding.evidence || []).map((item) => `原文引用（位置待确认）：${item.quote || ''}`).join('\n') +
    `\n修改建议：${finding.recommendation || '待确认'}\n${(finding.conditions || []).map((item) => `适用条件：${item}`).join('\n')}`
  ).join('\n\n')
}

export function summarizeHandbookReport(report) {
  const findings = report.findings || []
  const conflicts = findings.filter((item) => item.kind === 'conflict').length
  const files = new Set(findings.flatMap((item) => (item.evidence || []).flatMap((citation) =>
    citation.location?.status === 'found' ? citation.location.matches.map((match) => match.fileName) : [])))
  return { count: findings.length, conflicts, files: [...files],
    priorities: findings.filter((item) => item.level === 'high').map((item) => item.title) }
}
