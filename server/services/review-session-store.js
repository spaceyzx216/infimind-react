import { randomUUID } from 'node:crypto'

const TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSIONS = 500
const MAX_SESSIONS_PER_CLIENT = 30
const sessions = new Map()

export const normalizeClientId = (value) => {
  const clientId = typeof value === 'string' ? value.trim() : ''
  return /^[a-zA-Z0-9_-]{12,128}$/.test(clientId) ? clientId : ''
}

const prune = () => {
  const expiresBefore = Date.now() - TTL_MS
  for (const [id, session] of sessions) if (session.createdAt < expiresBefore) sessions.delete(id)

  const clientSessionIds = new Map()
  for (const [id, session] of sessions) {
    if (!session.clientId) continue
    if (!clientSessionIds.has(session.clientId)) clientSessionIds.set(session.clientId, [])
    clientSessionIds.get(session.clientId).push(id)
  }
  for (const ids of clientSessionIds.values()) {
    while (ids.length > MAX_SESSIONS_PER_CLIENT) sessions.delete(ids.shift())
  }

  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
}

export function createReviewSession({ clientId, contractText, analysisReport, reviewReport, reviewResult }) {
  prune()
  const id = randomUUID()
  const session = {
    id,
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

export function getReviewSession(id, clientId = '') {
  prune()
  if (typeof id !== 'string') return null
  const session = sessions.get(id) || null
  if (!session) return null
  const requestedClientId = normalizeClientId(clientId)
  if (session.clientId && session.clientId !== requestedClientId) return null
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
