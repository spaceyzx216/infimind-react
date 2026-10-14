// Presentation state is replayable from persisted events; final findings remain separate.
export function reduceReviewPresentation(report, event, data = {}) {
  if (!['review.delta', 'review.round'].includes(event)
    && !(event === 'stage.complete' && data.stage === 'review')) return report
  const next = { ...report }
  if (event === 'review.delta') {
    if (typeof data.firstRoundReport === 'string') next.firstRoundReport = data.firstRoundReport
    else if (Number(data.round) === 1 && typeof data.content === 'string') {
      next.firstRoundReport = data.replace ? data.content : `${next.firstRoundReport || ''}${data.content}`
    }
  }
  if (event === 'review.round') {
    const round = Number(data.round) || 1
    if (data.phase === 'start') next.activeReviewRound = round
    if (data.phase === 'end') {
      next.activeReviewRound = null
      if (round === 1) next.firstRoundComplete = true
      if (round < 3 && Number(data.newCount) === 0) next.reviewStoppedEarly = true
    }
  }
  if (event === 'stage.complete' && data.stage === 'review') {
    next.reviewFinished = true
    if (data.roundSnapshots?.some((round) => Number(round.round) === 1)) next.firstRoundComplete = true
  }
  return next
}

export function isReviewProgressVisible(report = {}) {
  return Boolean(report?.firstRoundComplete || report?.activeReviewRound > 1
    || report?.reviewRounds?.some((round) => Number(round.round) === 1))
}
