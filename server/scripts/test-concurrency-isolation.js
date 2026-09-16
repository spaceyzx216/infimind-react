import assert from 'node:assert/strict'
import {
  getThreadRequestState,
  isThreadRequestRunning,
  patchThreadRequestState
} from '../../src/utils/thread-request-state.js'
import { createReviewSession, getReviewSession } from '../services/review-session-store.js'

let requests = {}
requests = patchThreadRequestState(requests, 'thread-a', { loading: true, stage: 'review' })
assert.equal(isThreadRequestRunning(requests, 'thread-a'), true)
assert.equal(isThreadRequestRunning(requests, 'thread-b'), false)

requests = patchThreadRequestState(requests, 'thread-b', { loading: true, stage: 'chat' })
requests = patchThreadRequestState(requests, 'thread-a', { loading: false, stage: '' })
assert.equal(getThreadRequestState(requests, 'thread-a').loading, false)
assert.equal(getThreadRequestState(requests, 'thread-b').loading, true)
assert.equal(getThreadRequestState(requests, 'thread-b').stage, 'chat')

const reviewResult = {
  documentHash: 'concurrency-test',
  findings: [],
  unresolved: [],
  stats: { confirmed: 0 }
}
const clientA = 'client-concurrency-a'
const clientB = 'client-concurrency-b'
const userA = 'user-concurrency-a'
const userB = 'user-concurrency-b'
const sessionA = createReviewSession({
  userId: userA,
  clientId: clientA,
  contractText: '甲方合同',
  analysisReport: '',
  reviewReport: '',
  reviewResult
})
const sessionB = createReviewSession({
  userId: userB,
  clientId: clientB,
  contractText: '乙方合同',
  analysisReport: '',
  reviewReport: '',
  reviewResult
})

assert.equal(getReviewSession(sessionA.id, userA)?.contractText, '甲方合同')
assert.equal(getReviewSession(sessionB.id, userB)?.contractText, '乙方合同')
assert.equal(getReviewSession(sessionA.id, userB), null)
assert.equal(getReviewSession(sessionB.id, userA), null)
assert.equal(getReviewSession(sessionA.id), null)

assert.throws(() => createReviewSession({
  contractText: '无归属用户的会话',
  analysisReport: '',
  reviewReport: '',
  reviewResult
}), /real user ID/)

console.log('Concurrency isolation regression passed: per-thread request state and per-client review sessions are independent.')
