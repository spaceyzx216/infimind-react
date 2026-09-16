import { randomUUID } from 'node:crypto'

const TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSIONS = 500
const MAX_SESSIONS_PER_USER = 30
const sessions = new Map()

export const normalizeClientId = (value) => {
  const clientId = typeof value === 'string' ? value.trim() : ''
  return /^[a-zA-Z0-9_-]{12,128}$/.test(clientId) ? clientId : ''
}

const prune = () => {
  const expiresBefore = Date.now() - TTL_MS
  for (const [id, session] of sessions) if (session.createdAt < expiresBefore) sessions.delete(id)

  const userSessionIds = new Map()
  for (const [id, session] of sessions) {
    if (!session.userId) continue
    if (!userSessionIds.has(session.userId)) userSessionIds.set(session.userId, [])
    userSessionIds.get(session.userId).push(id)
  }
  for (const ids of userSessionIds.values()) {
    while (ids.length > MAX_SESSIONS_PER_USER) sessions.delete(ids.shift())
  }

  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
}

export function createReviewSession({ userId, clientId, contractText, analysisReport, reviewReport, reviewResult }) {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('ReviewSession requires a real user ID')
  prune()
  const id = randomUUID()
  const session = {
    id,
    userId: userId.trim(),
    clientId: normalizeClientId(clientId),
    createdAt: Date.now(),
    contractText,
    analysisReport,
    reviewReport,
    documentHash: reviewResult.documentHash,
    findings: reviewResult.findings,
    unresolved: reviewResult.unresolved,
    stats: reviewResult.stats
  }
  sessions.set(id, session)
  prune()
  return session
}

export function getReviewSession(id, userId = '') {
  prune()
  if (typeof id !== 'string') return null
  const session = sessions.get(id) || null
  if (!session) return null
  if (typeof userId !== 'string' || session.userId !== userId.trim()) return null
  return session
}

export function publicReviewSession(session) {
  return {
    id: session.id,
    documentHash: session.documentHash,
    findings: session.findings,
    unresolved: session.unresolved,
    stats: session.stats
  }
}
