import { buildReviewResult, renderReviewReport } from './annotation-locator.js'
import { mergeRevisions } from './revision-merger.js'

// Rebuild the display only from parsed source and completed checkpoints.
// The task remains failed; a readable result is not a completion certificate.
export function buildCommercialRecovery(checkpoints, error) {
  const values = new Map(checkpoints.map(({ stage, result }) => [stage, result]))
  const source = values.get('material-source') || {}
  const contractText = values.get('parsing')?.parsedText || (source.documents || []).map((d) => d.text).join('\n\n')
  if (!contractText?.trim()) return null
  const analysis = values.get('analysis')?.analysisReport || checkpoints.filter((c) => c.stage.startsWith('commercial-analysis:')).map((c) => c.result.report).filter(Boolean).join('\n\n')
  const review = values.get('review') || {}
  const candidates = [...(review.combinedFindings || [])]
  for (const checkpoint of checkpoints.filter((c) => c.stage.startsWith('commercial-review:'))) {
    try { candidates.push(...(JSON.parse(checkpoint.result.output).findings || [])) } catch { /* Ignore unvalidated checkpoint variants. */ }
  }
  const located = buildReviewResult({ contractText, modelOutput: JSON.stringify({ findings: candidates, completeness: [] }) })
  const groups = values.get('consolidation')?.revisionGroups || located.findings
  const revisions = checkpoints.filter((c) => c.stage.startsWith('commercial-rewrite-batch:')).flatMap((c) => {
    try { return JSON.parse(c.result.output).revisions || [] } catch { return [] }
  })
  const merged = mergeRevisions(groups, JSON.stringify({ revisions }), contractText)
  const coverage = values.get('material-coverage') || {}
  const scope = `已保留 ${located.findings.length} 项定位到原文的提示及已完成的结构分析。剩余条款与最终复核仍需继续，不能据此认定其没有风险。`
  return {
    contractText, analysis: analysis || '', revisions: merged.revisions, reviewComplete: false,
    review: `${located.findings.length ? renderReviewReport(located) : '# 已读取合同原文\n尚未取得可核验的风险审查结果。'}\n\n# 当前核对范围\n${scope}\n\n${error.message}`,
    reviewRounds: review.roundSnapshots || [], reviewStats: located.stats,
    stats: { total: located.findings.length, groups: groups.length, blocks: merged.revisions.length }, materialCoverage: coverage
  }
}
