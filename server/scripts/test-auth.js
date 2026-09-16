import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import { createRequireAuth } from '../middleware/auth.js'
import { createAuthRouter } from '../routes/auth.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { createAuthService } from '../services/auth-service.js'

const JWT_SECRET = 'test-only-jwt-secret-with-at-least-thirty-two-bytes'
let clock = Date.UTC(2026, 0, 1, 0, 0, 0)
const database = createBusinessDatabase(':memory:')
const authService = createAuthService(database, { jwtSecret: JWT_SECRET, now: () => clock })
const app = express()
app.use(express.json())
app.use('/api/auth', createAuthRouter(authService))
app.use('/api', createRequireAuth(authService))
app.get('/api/protected', (request, response) => response.json({ userId: request.user.id }))
app.get('/api/protected-sse', (request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  response.write(`event: ready\ndata: ${JSON.stringify({ userId: request.user.id })}\n\n`)
  response.end()
})

const server = await new Promise((resolve) => {
  const listener = app.listen(0, () => resolve(listener))
})
const baseUrl = `http://127.0.0.1:${server.address().port}`
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } })
const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const authHeaders = { 'X-Fafee-Auth': '1' }
const cookieFrom = (response) => response.headers.get('set-cookie')?.split(';')[0] || ''
const bearer = (token) => ({ Authorization: `Bearer ${token}` })
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const signExternalToken = async ({ secret = JWT_SECRET, issuer = 'fafee-api', audience = 'fafee-web', alg = 'HS256', subject = 'unknown' } = {}) => new SignJWT({})
  .setProtectedHeader({ alg })
  .setSubject(subject)
  .setIssuer(issuer)
  .setAudience(audience)
  .setIssuedAt(Math.floor(clock / 1000))
  .setExpirationTime(Math.floor((clock + 60_000) / 1000))
  .sign(new TextEncoder().encode(secret))

try {
  const [concurrentCode, loginCode] = authService.createInviteCodes(2)
  const concurrentBodies = [
    { inviteCode: concurrentCode, username: '并发用户甲', email: 'race-a@example.com', password: 'password-a-123' },
    { inviteCode: concurrentCode, username: '并发用户乙', email: 'race-b@example.com', password: 'password-b-123' }
  ]
  const concurrentResponses = await Promise.all(concurrentBodies.map((body) => request('/api/auth/register', { method: 'POST', ...json(body) })))
  assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [201, 400], '同一邀请码并发注册必须只有一个成功')

  const invalidInvite = await request('/api/auth/register', { method: 'POST', ...json({ inviteCode: 'FF-NOT-VALID', username: '无效邀请码', email: 'invalid@example.com', password: 'password-a-123' }) })
  assert.equal(invalidInvite.status, 400)

  const registration = await request('/api/auth/register', { method: 'POST', ...json({ inviteCode: loginCode, username: '登录测试用户', email: 'login@example.com', password: 'password-login-123' }) })
  assert.equal(registration.status, 201)
  const user = (await registration.json()).user
  assert.equal(user.username, '登录测试用户')
  assert.equal((await request('/api/auth/register', { method: 'POST', ...json({ inviteCode: loginCode, username: '重复邀请码用户', email: 'used@example.com', password: 'password-used-123' }) })).status, 400)

  const missingHeader = await request('/api/auth/login', { method: 'POST', ...json({ identifier: 'login@example.com', password: 'password-login-123' }) })
  assert.equal(missingHeader.status, 403)
  const wrongPassword = await request('/api/auth/login', { method: 'POST', headers: { ...authHeaders, ...json({}).headers }, body: JSON.stringify({ identifier: '登录测试用户', password: 'wrong-password' }) })
  assert.equal(wrongPassword.status, 401)

  const login = await request('/api/auth/login', { method: 'POST', headers: { ...authHeaders, ...json({}).headers }, body: JSON.stringify({ identifier: 'login@example.com', password: 'password-login-123' }) })
  assert.equal(login.status, 200)
  assert.match(login.headers.get('cache-control') || '', /no-store/)
  const cookie = cookieFrom(login)
  assert.match(cookie, /^fafee_refresh=/)
  const loginPayload = await login.json()
  assert.ok(loginPayload.accessToken)
  assert.equal(loginPayload.user.id, user.id)

  const me = await request('/api/auth/me', { headers: bearer(loginPayload.accessToken) })
  assert.equal(me.status, 200)
  assert.equal((await me.json()).user.id, user.id)
  assert.equal((await request('/api/protected', { headers: bearer(loginPayload.accessToken) })).status, 200)
  assert.equal((await request('/api/protected')).status, 401)
  assert.equal((await request('/api/protected', { headers: bearer('not-a-jwt') })).status, 401)
  assert.equal((await request('/api/protected-sse', { headers: bearer(loginPayload.accessToken) })).status, 200)

  const forged = await signExternalToken({ secret: 'different-test-secret-with-at-least-thirty-two-bytes' })
  const wrongIssuer = await signExternalToken({ issuer: 'other-api' })
  const wrongAudience = await signExternalToken({ audience: 'other-web' })
  const wrongAlgorithm = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: user.id, iss: 'fafee-api', aud: 'fafee-web', exp: Math.floor((clock + 60_000) / 1000) })}.`
  for (const token of [forged, wrongIssuer, wrongAudience, wrongAlgorithm]) assert.equal((await request('/api/protected', { headers: bearer(token) })).status, 401)

  const userRow = database.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').get(user.id)
  assert.notEqual(userRow.password_hash, 'password-login-123')
  assert.notEqual(userRow.password_salt, 'password-login-123')
  const inviteRow = database.prepare('SELECT code_hash FROM invite_codes WHERE used_by = ?').get(user.id)
  assert.notEqual(inviteRow.code_hash, loginCode)
  const refreshRow = database.prepare('SELECT token_hash FROM auth_refresh_tokens WHERE user_id = ?').get(user.id)
  assert.ok(refreshRow?.token_hash)
  assert.notEqual(refreshRow.token_hash, cookie.replace(/^fafee_refresh=/, ''))

  const refreshed = await request('/api/auth/refresh', { method: 'POST', headers: { ...authHeaders, Cookie: cookie } })
  assert.equal(refreshed.status, 200)
  const refreshPayload = await refreshed.json()
  assert.notEqual(refreshPayload.accessToken, loginPayload.accessToken)
  const concurrentRefresh = await Promise.all([1, 2].map(() => request('/api/auth/refresh', { method: 'POST', headers: { ...authHeaders, Cookie: cookie } })))
  assert.deepEqual(concurrentRefresh.map((response) => response.status), [200, 200])

  const logout = await request('/api/auth/logout', { method: 'POST', headers: { ...authHeaders, Cookie: cookie } })
  assert.equal(logout.status, 200)
  assert.equal((await request('/api/auth/refresh', { method: 'POST', headers: { ...authHeaders, Cookie: cookie } })).status, 401)
  assert.equal((await request('/api/protected', { headers: bearer(loginPayload.accessToken) })).status, 200, '退出前签发的 JWT 在到期前仍可使用')

  clock += authService.accessTokenTtlMs + 1000
  assert.equal((await request('/api/protected', { headers: bearer(loginPayload.accessToken) })).status, 401, 'JWT 到期后必须拒绝')

  const persistentDirectory = mkdtempSync(join(tmpdir(), 'fafee-auth-'))
  const persistentPath = join(persistentDirectory, 'auth.db')
  const persistentDatabase = createBusinessDatabase(persistentPath)
  const persistentService = createAuthService(persistentDatabase, { jwtSecret: JWT_SECRET })
  const persistentInvite = persistentService.createInviteCodes(1)[0]
  const persistentUser = await persistentService.register({ inviteCode: persistentInvite, username: '持久化用户', email: 'persistent@example.com', password: 'persistent-password-123' })
  const persistentLogin = await persistentService.login({ identifier: persistentUser.user.email, password: 'persistent-password-123' })
  persistentDatabase.close()
  const reopenedDatabase = createBusinessDatabase(persistentPath)
  const reopenedService = createAuthService(reopenedDatabase, { jwtSecret: JWT_SECRET })
  assert.equal((await reopenedService.refresh(persistentLogin.refreshToken)).user.id, persistentUser.user.id, '重开数据库后未过期刷新令牌必须可用')
  reopenedDatabase.close()
  rmSync(persistentDirectory, { recursive: true, force: true })

  console.log('Authentication regression passed: invite race, JWT validation, refresh persistence boundary, logout and protected SSE are covered.')
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  database.close()
}
