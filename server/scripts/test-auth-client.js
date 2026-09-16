import assert from 'node:assert/strict'

const storage = new Map()
global.sessionStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
}
global.localStorage = {
  setItem: () => {},
  getItem: () => null,
  removeItem: () => {}
}
global.window = { dispatchEvent: () => {}, addEventListener: () => {} }
global.BroadcastChannel = undefined

const response = (status, payload = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' }
})
const { authFetch, clearInMemoryAccessToken, getAccessTokenExpiry, loginUser, logoutUser } = await import('../../src/utils/auth-api.js')

let fetchImpl = async () => response(500)
global.fetch = (...args) => fetchImpl(...args)

let loginCalls = 0
fetchImpl = async (input) => {
  loginCalls += 1
  assert.equal(input, '/api/auth/login')
  return response(200, { user: { id: 'client-test-user' }, accessToken: 'access-old', accessTokenExpiresAt: 'later' })
}
await loginUser({ identifier: 'client-test@example.com', password: 'password-123' })
assert.equal(loginCalls, 1)

let networkCalls = 0
fetchImpl = async () => {
  networkCalls += 1
  throw new Error('offline')
}
await assert.rejects(() => authFetch('/api/protected'), /offline/)
assert.equal(networkCalls, 1, '网络失败不得自动重发')

const requestCalls = []
let resourceAttempts = 0
const uploadBody = new FormData()
uploadBody.set('file', new Blob(['upload-body']), 'sample.txt')
fetchImpl = async (input, options = {}) => {
  requestCalls.push({ input, options })
  if (input === '/api/resource') {
    resourceAttempts += 1
    return resourceAttempts === 1 ? response(401, { error: 'expired' }) : response(200, { ok: true })
  }
  if (input === '/api/auth/refresh') return response(200, { user: { id: 'client-test-user' }, accessToken: 'access-new', accessTokenExpiresAt: 'later' })
  throw new Error(`unexpected request: ${input}`)
}
const uploadResult = await authFetch('/api/resource', { method: 'POST', body: uploadBody })
assert.equal(uploadResult.status, 200)
const resourceCalls = requestCalls.filter((call) => call.input === '/api/resource')
assert.equal(resourceCalls.length, 2, '业务 401 只允许刷新后重试一次')
assert.equal(resourceCalls[0].options.body, uploadBody, '第一次上传必须保留原请求体')
assert.equal(resourceCalls[1].options.body, uploadBody, '刷新后重试必须复用原请求体')
assert.equal(resourceCalls[0].options.headers.get('Authorization'), 'Bearer access-old')
assert.equal(resourceCalls[1].options.headers.get('Authorization'), 'Bearer access-new')

clearInMemoryAccessToken()
let releaseRefresh
const refreshStarted = new Promise((resolve) => { releaseRefresh = resolve })
const raceCalls = []
fetchImpl = async (input, options = {}) => {
  raceCalls.push({ input, options })
  if (input === '/api/auth/refresh') return refreshStarted
  if (input === '/api/auth/logout') return response(200, { ok: true })
  throw new Error(`late protected request should not be sent: ${input}`)
}
const inFlightRequest = authFetch('/api/protected', { method: 'POST', body: uploadBody })
await new Promise((resolve) => setTimeout(resolve, 0))
await logoutUser()
releaseRefresh(response(200, { user: { id: 'client-test-user' }, accessToken: 'late-token', accessTokenExpiresAt: 'later' }))
const raceResult = await inFlightRequest
assert.equal(raceResult.status, 401, '退出期间迟到的刷新结果不得恢复登录')
assert.equal(raceCalls.filter((call) => call.input === '/api/protected').length, 0, '退出期间不得继续发送旧业务请求')
assert.equal(getAccessTokenExpiry(), '', '迟到的刷新响应不得写回已退出账号的访问令牌')

console.log('Client authentication regression passed: network no-retry, upload-body retry and logout/refresh race are covered.')
