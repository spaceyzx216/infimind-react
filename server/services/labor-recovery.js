// Rebuild the readable labor-contract analysis display from completed checkpoints only.
// Mirrors buildCommercialRecovery: the task stays failed, and a readable result is not a
// completion certificate. 恢复只做读取与拼装，不调用模型，不产生新的法律结论。
const findingKey = (finding) => [
  finding?.title,
  finding?.level,
  finding?.quote || finding?.targetQuote,
  finding?.location?.matches?.[0]?.lineStart,
  finding?.location?.lineStart
].map((value) => String(value ?? '').replace(/\s+/g, '')).join('|')

function dedupeFindings(findings) {
  const seen = new Set()
  const result = []
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) continue
    const key = findingKey(finding)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(finding)
  }
  return result
}

export function buildLaborRecovery(checkpoints, error, { task = {}, events = [] } = {}) {
  const values = new Map((Array.isArray(checkpoints) ? checkpoints : []).map(({ stage, result }) => [stage, result]))
  const source = values.get('material-source') || values.get('source') || values.get('parsing') || {}
  const documents = (Array.isArray(source.documents) ? source.documents : []).filter((document) => document?.text?.trim())
  const reason = String(error?.message || '任务处理失败').slice(0, 300)
  // 追问的回答是流式增量（followup.delta），而失败清理会删掉这些事件；
  // 所以要在 failTask 之前把它们取回来，否则刷新后用户刚看到的回答就没了。
  const streamedAnswer = (Array.isArray(events) ? events : [])
    .filter((event) => event?.event === 'followup.delta' && typeof event?.data?.content === 'string')
    .map((event) => event.data.content).join('').trim()
  if (streamedAnswer && String(task?.action || '') === 'followup') {
    const answerNotice = `本次追问未完成：${reason}。以下是已生成的部分回答，尚未核对完成。`
    return {
      schemaVersion: 3,
      productId: 'labor-contract-analysis',
      kind: 'followup',
      analysisStatus: 'partial',
      recoveredFromFailure: true,
      analysisType: task.analysisType || 'ordinary_labor_contract',
      answer: streamedAnswer,
      sourceAvailable: documents.length > 0,
      reviewComplete: false,
      revisions: [],
      warnings: [answerNotice]
    }
  }
  if (!documents.length) return null

  const review = values.get('review') || {}
  const pages = values.get('review-pages') || {}
  const generated = review.generated && typeof review.generated === 'object' ? review.generated : {}
  const roundPayload = pages.payload && typeof pages.payload === 'object' ? pages.payload : {}
  const findings = dedupeFindings([
    ...(Array.isArray(review.combinedFindings) ? review.combinedFindings : []),
    ...(Array.isArray(roundPayload.findings) ? roundPayload.findings : [])
  ])
  const rewrites = values.get('rewrite-batches') || {}
  const revisions = (Array.isArray(rewrites.revisions) ? rewrites.revisions : [])
    .filter((revision) => revision && typeof revision === 'object' && !Array.isArray(revision))
  const coverage = values.get('material-coverage') || {}
  const roundSnapshots = Array.isArray(review.roundSnapshots) ? review.roundSnapshots : []
  const firstRoundReport = typeof review.firstRoundReport === 'string' ? review.firstRoundReport : ''
  // 结构分析报告（合同基础识别/条款结构图/要素完整性核查/文本一致性与待确认事项）与审查报告分开保存，恢复时一并带回。
  const structureOverview = typeof values.get('analysis-overview')?.text === 'string' ? values.get('analysis-overview').text : ''
  const coverageIds = ['coverage', 'topicChecks'].filter((key) => Array.isArray(generated[key]) && generated[key].length)
  const topicChecks = coverageIds.length ? generated[coverageIds[0]] : []
  const notice = `本次分析在保存已完成内容后停止：${reason}。已完成内容已保存；未核对范围不代表没有风险，请人工补查后再定稿。`
  const warnings = [notice]
  if (coverage.partial) warnings.push('覆盖核对未完成：部分内容块或基础检查项尚未确认。')

  return {
    schemaVersion: 3,
    productId: 'labor-contract-analysis',
    kind: 'analysis',
    // 恢复稿不是完成证书：既不用 completed，也不据此允许追问或计入已完成报告。
    analysisStatus: 'partial',
    reviewComplete: false,
    recoveredFromFailure: true,
    reviewStatus: 'draft-pending-mentor-and-legal-review',
    contractInfo: generated.contractInfo && typeof generated.contractInfo === 'object' ? generated.contractInfo : {},
    agreementInfo: generated.agreementInfo && typeof generated.agreementInfo === 'object' ? generated.agreementInfo : {},
    conclusion: typeof generated.conclusion === 'string' ? generated.conclusion : '',
    findings,
    missingItems: [
      ...(Array.isArray(generated.missingItems) ? generated.missingItems : []),
      { topic: '覆盖核对', item: '本次分析未完整结束', reason: notice }
    ],
    score: generated.score && typeof generated.score === 'object' ? generated.score : { value: null, status: 'unavailable' },
    coverage: topicChecks,
    topicChecks,
    reviewRounds: roundSnapshots,
    reviewStoppedEarly: true,
    reviewStoppedReason: reason,
    firstRoundReport,
    reviewReport: firstRoundReport,
    analysis: firstRoundReport,
    review: firstRoundReport,
    analysisOverview: structureOverview,
    structure: values.get('structure') || null,
    revisions,
    revisionStats: { groups: revisions.length, blocks: revisions.length },
    sourceDocuments: documents.map(({ fileId, fileName, role, text }) => ({ fileId, fileName, role, text })),
    materialCoverage: coverage,
    warnings
  }
}
