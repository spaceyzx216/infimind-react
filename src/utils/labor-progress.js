import { reduceReviewPresentation } from './review-presentation.js'

// Reduce persisted events without rendering each historical stage on refresh.
export function reduceLaborProgress(report, event, data = {}) {
  if (!['review.round', 'analysis.delta', 'review.delta', 'rewrite.result', 'analysis.section', 'analysis.reset'].includes(event)
    && !(event === 'stage.complete' && data.stage === 'review')) return report
  const next = { ...reduceReviewPresentation(report, event, data) }
  if (event === 'analysis.reset') {
    // 后端在同一任务重跑生成前会发这条：必须清掉上一轮的流式草稿，
    // 否则结构分析是非 replace 追加，新旧两遍会首尾相接。
    next.analysisOverview = ''
    next.reviewReport = ''
    next.firstRoundReport = undefined
    next.revisions = []
    next.reviewRounds = []
    next.activeReviewRound = null
    return next
  }
  if (event === 'review.round') {
    if (data.phase === 'start') next.activeReviewRound = Number(data.round) || 1
    if (data.phase === 'end') {
      next.activeReviewRound = null
      const snapshot = { round: Number(data.round) || 0, newCount: Number(data.newCount) || 0, newFindings: Array.isArray(data.newFindings) ? data.newFindings : [] }
      next.reviewRounds = [...(next.reviewRounds || []).filter((item) => item.round !== snapshot.round), snapshot]
    }
  }
  if (event === 'stage.complete' && data.stage === 'review' && Array.isArray(data.roundSnapshots)) next.reviewRounds = data.roundSnapshots
  if (event === 'analysis.delta' && typeof data.content === 'string') next.analysisOverview = data.replace ? data.content : `${next.analysisOverview || ''}${data.content}`
  if (event === 'review.delta' && typeof data.content === 'string') next.reviewReport = data.content
  if (event === 'rewrite.result') {
    if (Array.isArray(data.added)) {
      // 逐批增量：按 findingId 合并，避免整篇数组反复重发。
      const merged = new Map((Array.isArray(next.revisions) ? next.revisions : [])
        .map((item) => [item?.findingId || item?.editId || item?.id, item]))
      for (const item of data.added) merged.set(item?.findingId || item?.editId || item?.id, item)
      next.revisions = [...merged.values()]
    } else {
      next.revisions = Array.isArray(data.revisions) ? data.revisions : []
    }
    next.revisionStats = data.stats || {}
  }
  if (event === 'analysis.section' && data.section && data.item !== undefined) {
    const { section, item } = data
    if (section === 'contractInfo' || section === 'agreementInfo') next[section] = { ...(next[section] || {}), ...item }
    else if (section === 'warnings') next.warnings = Array.isArray(item) ? item : []
    else {
      const list = Array.isArray(next[section]) ? next[section] : []
      const keyOf = (value) => value?.id || `${value?.topic || ''}|${value?.title || ''}|${value?.item || value?.title || value}`
      if (!list.some((value) => keyOf(value) === keyOf(item))) next[section] = [...list, item]
    }
  }
  return next
}
