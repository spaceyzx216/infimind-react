/**
 * 运维管理台（邀请码）回归测试。
 *
 * 覆盖：
 *   1. 邀请码格式/哈希/规范化与「库内只存哈希 + AES-GCM 密文」
 *   2. 管理员密码 scrypt 校验、TOTP（RFC 6238 向量）、独立管理 JWT
 *   3. 发码/列表/停用/统计/审计的业务规则与并发安全边界
 *   4. 注册链路对停用/过期/已使用邀请码的拒绝
 *   5. HTTP 层：无令牌 401、登录限速锁定、CSP/安全响应头、明文的加密展示与解密接口
 *   6. loadAdminConfig fail-closed、旧库字段迁移与历史明文回填
 *
 * 全部使用内存库/临时库，不调用模型，不写现役业务库。
 * 用法：npm run test:admin
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { base32Encode, createAdminToken, generateTotp, hashAdminPassword, loadAdminConfig, verifyAdminPassword, verifyAdminToken, verifyTotp, ADMIN_ISSUER, ADMIN_AUDIENCE } from '../services/admin-auth.js'
import { createAdminService } from '../services/admin-service.js'
import { createAdminApp } from '../routes/admin.js'
import { createAuthService } from '../services/auth-service.js'
import { createBusinessDatabase } from '../services/business-db.js'
import { generateInviteCode, hashInviteCode, normalizeInviteCode, isValidInviteCodeFormat } from '../services/invite-code.js'
import { decryptInviteCode, encryptInviteCode, generateInviteCodeKey, loadInviteCodeKey } from '../services/invite-crypto.js'
import { backfillInvitePlaintext } from './backfill-invite-plaintext.js'

const CLOCK = Date.UTC(2026, 0, 1, 12, 0, 0)
const USER_JWT_SECRET = 'test-only-user-jwt-secret-with-at-least-32-bytes'
const ADMIN_PASSWORD = 'test-admin-password-0123456789'
let passed = 0
let failed = 0
const test = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ❌ ${name}`)
    console.error(`     ${error.message}`)
  }
}
const expectCode = async (fn, code) => {
  try {
    await fn()
  } catch (error) {
    assert.equal(error?.code, code)
    return error
  }
  throw new Error(`expected error code ${code}`)
}

console.log('\n=== 运维管理台（邀请码）回归测试 ===\n')

const passwordHash = await hashAdminPassword(ADMIN_PASSWORD)
const totpSecret = base32Encode(randomBytes(20))
const inviteCodeKey = loadInviteCodeKey(generateInviteCodeKey())
const config = {
  username: 'ops',
  passwordHash,
  totpSecret,
  jwtSecret: 'test-only-admin-jwt-secret-with-at-least-32-bytes',
  inviteCodeKey,
  port: 0,
  sessionTtlSeconds: 30 * 60,
  maxLoginFailures: 3,
  loginWindowSeconds: 10 * 60,
  loginLockSeconds: 15 * 60,
  maxInvitesPerRequest: 5,
  maxInvitesPerDay: 100,
  issuer: ADMIN_ISSUER,
  audience: ADMIN_AUDIENCE
}

const database = createBusinessDatabase(':memory:')
const adminService = createAdminService({ database, config, now: () => CLOCK })
const authService = createAuthService(database, { jwtSecret: USER_JWT_SECRET, now: () => CLOCK })

console.log('1. 邀请码格式与哈希')
await test('生成的邀请码符合 7 位大写字母数字且哈希稳定', () => {
  const code = generateInviteCode()
  assert.match(code, /^[A-Z0-9]{7}$/)
  assert.equal(isValidInviteCodeFormat(code), true)
  assert.equal(normalizeInviteCode(` ${code.toLowerCase()} `), code)
  assert.equal(hashInviteCode(` ${code.toLowerCase()} `), hashInviteCode(code))
  assert.equal(hashInviteCode(code).length, 64)
})
await test('加密模块：往返可解密，错误密钥/AAD/篡改必须失败', () => {
  assert.equal(hashInviteCode(generateInviteCode()).length, 64)
  const otherKey = loadInviteCodeKey(generateInviteCodeKey())
  const ciphertext = encryptInviteCode('ABC1234', 'invite-id-1', inviteCodeKey)
  assert.notEqual(ciphertext, 'ABC1234')
  assert.equal(ciphertext.includes('ABC1234'), false)
  assert.equal(decryptInviteCode(ciphertext, 'invite-id-1', inviteCodeKey), 'ABC1234')
  assert.throws(() => decryptInviteCode(ciphertext, 'invite-id-1', otherKey))
  assert.throws(() => decryptInviteCode(ciphertext, 'invite-id-2', inviteCodeKey))
  const tampered = ciphertext.slice(0, -2) + (ciphertext.endsWith('AA') ? 'BB' : 'AA')
  assert.throws(() => decryptInviteCode(tampered, 'invite-id-1', inviteCodeKey))
})
await test('库内只存 sha256 + 密文，不存明文列', () => {
  const columns = database.prepare('PRAGMA table_info(invite_codes)').all().map((column) => column.name)
  assert.ok(!columns.includes('code'))
  assert.ok(columns.includes('code_hash'))
  assert.ok(columns.includes('code_ciphertext'))
  assert.ok(columns.includes('label'))
  assert.ok(columns.includes('expires_at'))
  assert.ok(columns.includes('disabled_at'))
})

console.log('\n2. 管理员密码 / TOTP / JWT')
await test('scrypt 密码哈希校验正确且拒绝错误密码', async () => {
  assert.equal(await verifyAdminPassword(ADMIN_PASSWORD, passwordHash), true)
  assert.equal(await verifyAdminPassword(`${ADMIN_PASSWORD}x`, passwordHash), false)
})
await test('TOTP 符合 RFC 6238 测试向量（6 位截断）', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'))
  assert.equal(generateTotp(secret, { timestamp: 59_000 }), '287082')
  assert.equal(verifyTotp(secret, '287082', { now: 59_000 }).ok, true)
  assert.equal(verifyTotp(secret, '287082', { now: 89_000 }).ok, true) // ±1 步
  assert.equal(verifyTotp(secret, '000000', { now: 59_000 }).ok, false)
  assert.equal(verifyTotp(secret, '28708', { now: 59_000 }).ok, false)
})
await test('管理 JWT 独立 issuer/audience，并拒绝过期、错误密钥与用户 JWT', async () => {
  const token = await createAdminToken(config, { now: CLOCK })
  const payload = await verifyAdminToken(config, token.token, { now: CLOCK })
  assert.equal(payload.sub, 'ops')
  assert.equal(payload.role, 'ops')
  await expectCode(() => verifyAdminToken(config, 'not-a-token', { now: CLOCK }), 'ADMIN_TOKEN_INVALID')
  await expectCode(() => verifyAdminToken({ ...config, jwtSecret: 'another-admin-secret-at-least-32-bytes-long' }, token.token, { now: CLOCK }), 'ADMIN_TOKEN_INVALID')
  const expired = await createAdminToken(config, { now: CLOCK - (config.sessionTtlSeconds + 60) * 1000 })
  await expectCode(() => verifyAdminToken(config, expired.token, { now: CLOCK }), 'ADMIN_TOKEN_INVALID')
  const userLogin = await createAuthService(database, { jwtSecret: USER_JWT_SECRET, now: () => CLOCK })
  const registered = await userLogin.register({ inviteCode: (await adminService.createInvites({ actor: 'ops', count: 1 })).codes[0], username: 'jwt用户', email: 'jwt@example.com', password: 'password-12345' })
  assert.ok(registered.user.id)
})

console.log('\n3. 发码 / 列表 / 停用 / 统计 / 审计')
let created
await test('生成邀请码：返回明文，库内只有哈希 + AES-256-GCM 密文，审计不含明文', async () => {
  created = adminService.createInvites({ actor: 'ops', count: 3, label: '批次A', note: '测试批次' })
  assert.equal(created.codes.length, 3)
  assert.equal(created.items.length, 3)
  for (const code of created.codes) assert.match(code, /^[A-Z0-9]{7}$/)
  const rows = database.prepare("SELECT id, code_hash, code_ciphertext, label, note, created_by, expires_at FROM invite_codes WHERE label = '批次A'").all()
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.ok(!Object.values(row).includes(created.codes[0]))
    assert.equal(row.created_by, 'ops')
    const decrypted = decryptInviteCode(row.code_ciphertext, row.id, inviteCodeKey)
    assert.ok(created.codes.includes(decrypted), '库内密文必须能用管理员密钥还原出本轮明文')
  }
  const hashes = new Set(rows.map((row) => row.code_hash))
  for (const code of created.codes) assert.ok(hashes.has(hashInviteCode(code)))
  const audit = database.prepare("SELECT detail_json FROM admin_audit_log WHERE action = 'invite.create' ORDER BY created_at DESC").all()
  for (const row of audit) for (const code of created.codes) assert.ok(!row.detail_json.includes(code))
})
await test('列表返回可解密明文，状态/搜索/分页正确', () => {
  const page = adminService.listInvites({ q: '批次A', page: 1, pageSize: 2 })
  assert.equal(page.total, 3)
  assert.equal(page.items.length, 2)
  for (const item of page.items) {
    assert.equal(typeof item.hashPrefix, 'string')
    assert.equal(typeof item.code, 'string')
    assert.ok(created.codes.includes(item.code))
    assert.equal(item.state, 'unused')
  }
  const all = adminService.listInvites({ q: '批次A', pageSize: 10 })
  assert.deepEqual(all.items.map((item) => item.code).sort(), [...created.codes].sort())
  const missing = adminService.listInvites({ q: '不存在的关键词zzz' })
  assert.equal(missing.total, 0)
  const used = adminService.listInvites({ status: 'used' })
  assert.equal(used.items.every((item) => item.state === 'used'), true)
})
await test('历史无密文码显示哈希前缀；用已知明文回填后可再次解密', () => {
  const legacyCode = generateInviteCode()
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)')
    .run('legacy-unused', hashInviteCode(legacyCode), new Date(CLOCK).toISOString())
  const beforeItem = adminService.listInvites({ status: 'unused', pageSize: 100 }).items.find((item) => item.id === 'legacy-unused')
  assert.ok(beforeItem)
  assert.equal(beforeItem.code, null, '没有密文的历史码只能展示哈希前缀')
  const summary = backfillInvitePlaintext(database, [legacyCode, 'NOT-A-REAL-CODE'], inviteCodeKey)
  assert.equal(summary.matched, 1)
  assert.equal(summary.updated, 1)
  assert.equal(summary.unmatched, 1)
  const afterItem = adminService.listInvites({ status: 'unused', pageSize: 100 }).items.find((item) => item.id === 'legacy-unused')
  assert.equal(afterItem.code, legacyCode)
  const copyAll = adminService.listInviteCodes({ actor: 'ops', status: 'unused' })
  assert.ok(copyAll.codes.includes(legacyCode))
  assert.ok(created.codes.every((code) => copyAll.codes.includes(code)))
  assert.equal(copyAll.unavailable, 0)
})
await test('停用：可用码停用成功；重复停用/不存在给出明确错误', async () => {
  const first = created.items[0]
  const result = adminService.disableInvite({ id: first.id, actor: 'ops' })
  assert.equal(result.ok, true)
  await expectCode(() => adminService.disableInvite({ id: first.id, actor: 'ops' }), 'INVITE_ALREADY_DISABLED')
  await expectCode(() => adminService.disableInvite({ id: 'missing-id', actor: 'ops' }), 'INVITE_NOT_FOUND')
  const listed = adminService.listInvites({ status: 'disabled' })
  assert.equal(listed.items.some((item) => item.id === first.id), true)
  const audit = database.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'invite.disable'").get().count
  assert.equal(audit >= 1, true)
})
await test('统计与过期过滤', () => {
  const expiredId = 'expired-invite'
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(expiredId, hashInviteCode('EXPIRED'), new Date(CLOCK - 1000).toISOString(), new Date(CLOCK - 1000).toISOString())
  const stats = adminService.getStats()
  assert.equal(stats.total >= 4, true)
  assert.equal(stats.expired >= 1, true)
  assert.equal(stats.unused + stats.used + stats.disabled + stats.expired, stats.total)
  const expired = adminService.listInvites({ status: 'expired' })
  assert.equal(expired.items.some((item) => item.id === expiredId), true)
})
await test('已使用邀请码展示账号状态（有效 → 到期）', async () => {
  const expiresAt = new Date(CLOCK + 60 * 60 * 1000).toISOString()
  const batch = adminService.createInvites({ actor: 'ops', count: 1, label: '账号状态', expiresAt })
  const registered = await authService.register({ inviteCode: batch.codes[0], username: '状态展示用户', email: 'account-state@example.com', password: 'password-12345' })
  let used = adminService.listInvites({ status: 'used' })
  let item = used.items.find((row) => row.id === batch.items[0].id)
  assert.equal(item.usedBy.state, 'active')
  assert.equal(item.usedBy.expiresAt, expiresAt)
  assert.equal(item.usedBy.disabledAt, null)
  database.prepare('UPDATE users SET expires_at = ? WHERE id = ?').run(new Date(CLOCK - 1000).toISOString(), registered.user.id)
  used = adminService.listInvites({ status: 'used' })
  item = used.items.find((row) => row.id === batch.items[0].id)
  assert.equal(item.usedBy.state, 'expired')
  assert.equal(item.usedBy.expiresAt, new Date(CLOCK - 1000).toISOString())
})
await test('过期时间必须晚于当前时间，单日上限生效', async () => {
  await expectCode(() => adminService.createInvites({ actor: 'ops', count: 1, expiresAt: new Date(CLOCK - 1000).toISOString() }), 'INVITE_EXPIRES_INVALID')
  const limited = createAdminService({ database, config: { ...config, maxInvitesPerDay: 4 }, now: () => CLOCK })
  await expectCode(() => limited.createInvites({ actor: 'ops', count: 1 }), 'INVITE_DAILY_LIMIT')
})

console.log('\n4. 注册链路拒绝停用 / 过期 / 已使用')
await test('停用的邀请码不能注册', async () => {
  const codes = adminService.createInvites({ actor: 'ops', count: 1 }).codes
  const row = database.prepare('SELECT id FROM invite_codes WHERE code_hash = ?').get(hashInviteCode(codes[0]))
  adminService.disableInvite({ id: row.id, actor: 'ops' })
  await expectCode(() => authService.register({ inviteCode: codes[0], username: '停用用户', email: 'disabled@example.com', password: 'password-12345' }), 'INVITE_DISABLED')
})
await test('过期的邀请码不能注册', async () => {
  const code = generateInviteCode()
  database.prepare('INSERT INTO invite_codes (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run('expired-register', hashInviteCode(code), new Date(CLOCK).toISOString(), new Date(CLOCK - 1000).toISOString())
  await expectCode(() => authService.register({ inviteCode: code, username: '过期用户', email: 'expired@example.com', password: 'password-12345' }), 'INVITE_EXPIRED')
})
await test('正常邀请码只能注册一个账号', async () => {
  const code = adminService.createInvites({ actor: 'ops', count: 1 }).codes[0]
  const first = await authService.register({ inviteCode: code, username: '正常用户', email: 'normal@example.com', password: 'password-12345' })
  assert.equal(first.user.username, '正常用户')
  await expectCode(() => authService.register({ inviteCode: code, username: '重复用户', email: 'normal2@example.com', password: 'password-12345' }), 'INVITE_USED')
})

console.log('\n5. HTTP 层与安全响应头')
const adminApp = createAdminApp({ database, config, now: () => CLOCK })
const adminServer = await new Promise((resolve) => {
  const listener = adminApp.listen(0, '127.0.0.1', () => resolve(listener))
})
const baseUrl = `http://127.0.0.1:${adminServer.address().port}`
const request = (path, options = {}) => fetch(`${baseUrl}${path}`, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } })
const jsonBody = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
let adminToken = ''
await test('健康检查与静态管理页', async () => {
  const health = await request('/admin/api/health')
  assert.equal(health.status, 200)
  assert.equal((await health.json()).ok, true)
  const page = await request('/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(page.headers.get('x-frame-options'), 'DENY')
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('x-powered-by'), null)
  const script = await request('/admin.js')
  assert.equal(script.status, 200)
})
await test('无令牌访问管理接口返回 401，用户 JWT 不能访问', async () => {
  const response = await request('/admin/api/invites')
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'ADMIN_AUTH_REQUIRED')
  const login = await authService.login({ identifier: 'normal@example.com', password: 'password-12345' })
  const withUserJwt = await request('/admin/api/invites', { headers: { Authorization: `Bearer ${login.accessToken}` } })
  assert.equal(withUserJwt.status, 401)
})
await test('错误验证码登录失败但不会锁死正确登录（限速 3 次）', async () => {
  const bad = await request('/admin/api/login', { method: 'POST', ...jsonBody({ username: 'ops', password: ADMIN_PASSWORD, totp: '000000' }) })
  assert.equal(bad.status, 401)
  const totp = generateTotp(totpSecret, { timestamp: CLOCK })
  const ok = await request('/admin/api/login', { method: 'POST', ...jsonBody({ username: 'ops', password: ADMIN_PASSWORD, totp }) })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  adminToken = body.token
  assert.equal(body.user.username, 'ops')
  assert.ok(body.expiresAt)
})
await test('带令牌完成发码、列表、停用与审计查询', async () => {
  const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
  const me = await request('/admin/api/me', { headers })
  assert.equal((await me.json()).user.username, 'ops')
  const created = await request('/admin/api/invites', { method: 'POST', headers, body: JSON.stringify({ count: 2, label: 'HTTP批次', note: 'http test' }) })
  assert.equal(created.status, 201)
  const payload = await created.json()
  assert.equal(payload.codes.length, 2)
  const list = await request('/admin/api/invites?status=unused&pageSize=50', { headers })
  const listPayload = await list.json()
  const listedCodes = new Set(listPayload.items.map((item) => item.code))
  assert.ok(payload.codes.every((code) => listedCodes.has(code)), '列表必须能展示可解密明文')
  const copyAll = await request('/admin/api/invites/codes?status=unused', { headers })
  assert.equal(copyAll.status, 200)
  const copyPayload = await copyAll.json()
  assert.ok(payload.codes.every((code) => copyPayload.codes.includes(code)))
  const auditAll = await request('/admin/api/audit?pageSize=100', { headers })
  const auditText = JSON.stringify(await auditAll.json())
  for (const code of payload.codes) assert.ok(!auditText.includes(code), '审计日志不得出现明文')
  const target = payload.items[0]
  const disable = await request(`/admin/api/invites/${target.id}/disable`, { method: 'POST', headers })
  assert.equal(disable.status, 200)
  const stats = await request('/admin/api/stats', { headers })
  assert.equal(stats.status, 200)
  const audit = await request('/admin/api/audit?action=invite.create', { headers })
  assert.equal(audit.status, 200)
  assert.equal((await audit.json()).items.length >= 1, true)
  const missing = await request('/admin/api/nope', { headers })
  assert.equal(missing.status, 404)
})
await test('登录连续失败触发 429 锁定（独立实例验证，不影响上面的登录）', async () => {
  const lockedApp = createAdminApp({
    database,
    config: { ...config, maxLoginFailures: 2, loginLockSeconds: 60 },
    now: () => CLOCK
  })
  const lockedServer = await new Promise((resolve) => { const listener = lockedApp.listen(0, '127.0.0.1', () => resolve(listener)) })
  const lockedBase = `http://127.0.0.1:${lockedServer.address().port}`
  const doLogin = (totp) => fetch(`${lockedBase}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ops', password: ADMIN_PASSWORD, totp }) })
  assert.equal((await doLogin('000000')).status, 401)
  assert.equal((await doLogin('000000')).status, 429)
  assert.equal((await doLogin(generateTotp(totpSecret, { timestamp: CLOCK }))).status, 429)
  await new Promise((resolve) => lockedServer.close(resolve))
})

console.log('\n6. 配置 fail-closed 与旧库迁移')
await test('缺少/非法 ADMIN_* 时 loadAdminConfig 返回 error', () => {
  assert.equal(loadAdminConfig({}).config, null)
  const missing = loadAdminConfig({ ADMIN_USERNAME: 'ops' })
  assert.match(missing.error, /缺少环境变量/)
  const weakSecret = loadAdminConfig({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD_HASH: passwordHash, ADMIN_TOTP_SECRET: totpSecret, ADMIN_JWT_SECRET: 'short' })
  assert.equal(weakSecret.config, null)
  const badHash = loadAdminConfig({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD_HASH: 'bad-format', ADMIN_TOTP_SECRET: totpSecret, ADMIN_JWT_SECRET: config.jwtSecret })
  assert.equal(badHash.config, null)
  const valid = loadAdminConfig({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD_HASH: passwordHash, ADMIN_TOTP_SECRET: totpSecret, ADMIN_JWT_SECRET: config.jwtSecret, ADMIN_CODE_KEY: generateInviteCodeKey(), ADMIN_PORT: '8791' })
  assert.equal(valid.config.port, 8791)
  assert.equal(valid.config.sessionTtlSeconds, 1800)
  assert.ok(Buffer.isBuffer(valid.config.inviteCodeKey))
  const missingCodeKey = loadAdminConfig({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD_HASH: passwordHash, ADMIN_TOTP_SECRET: totpSecret, ADMIN_JWT_SECRET: config.jwtSecret })
  assert.equal(missingCodeKey.config, null)
})
await test('旧 invitation/users 表结构启动时自动补齐并回填账号到期时间', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fafee-admin-migrate-'))
  const file = join(dir, 'legacy.db')
  const legacy = new Database(file)
  legacy.exec(`
    CREATE TABLE invite_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, used_at TEXT, used_by TEXT, expires_at TEXT);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
      invite_code_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
  `)
  legacy.prepare('INSERT INTO invite_codes (id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run('legacy-invite', 'legacy-hash', '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z')
  legacy.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('legacy-user', 'legacy', 'legacy@example.com', 'hash', 'salt', 'legacy-invite', '2026-01-01T00:00:00.000Z')
  legacy.close()
  const migrated = createBusinessDatabase(file)
  const inviteColumns = migrated.prepare('PRAGMA table_info(invite_codes)').all().map((column) => column.name)
  assert.ok(inviteColumns.includes('label') && inviteColumns.includes('note') && inviteColumns.includes('created_by') && inviteColumns.includes('expires_at') && inviteColumns.includes('disabled_at') && inviteColumns.includes('code_ciphertext'))
  const userColumns = migrated.prepare('PRAGMA table_info(users)').all().map((column) => column.name)
  assert.ok(userColumns.includes('expires_at') && userColumns.includes('disabled_at'))
  const migratedUser = migrated.prepare('SELECT expires_at, disabled_at FROM users WHERE id = ?').get('legacy-user')
  assert.equal(migratedUser.expires_at, '2026-12-31T00:00:00.000Z', '已有账号必须从原邀请码回填到期时间')
  assert.equal(migratedUser.disabled_at, null)
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit_log'").get())
  migrated.close()
  rmSync(dir, { recursive: true, force: true })
})

await new Promise((resolve) => adminServer.close(resolve))
database.close()

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===\n`)
process.exit(failed ? 1 : 0)
