/**
 * 运维管理台的独立认证与密钥工具。
 *
 * 设计边界：
 * - 与用户 JWT（auth-service）完全隔离：独立 secret、独立 issuer/audience；
 * - 单管理员：账号/密码哈希/TOTP 种子只从服务器环境变量读取，不落库；
 * - 密码用 scrypt 哈希，TOTP 用 Node 内置 crypto 实现（不新增依赖）；
 * - 登录令牌只走 Authorization 头、只存浏览器内存，不设 Cookie（无 CSRF 面）。
 */
import { createHmac, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { SignJWT, jwtVerify } from 'jose'

const scryptAsync = promisify(scrypt)
export const ADMIN_ISSUER = 'fafee-admin'
export const ADMIN_AUDIENCE = 'fafee-admin-ui'
export const ADMIN_SCRYPT_DEFAULTS = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64, maxmem: 32 * 1024 * 1024 })
export const ADMIN_DEFAULTS = Object.freeze({
  port: 8791,
  sessionTtlSeconds: 30 * 60,
  maxLoginFailures: 5,
  loginWindowSeconds: 10 * 60,
  loginLockSeconds: 15 * 60,
  maxInvitesPerRequest: 200,
  maxInvitesPerDay: 1000
})

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export class AdminAuthError extends Error {
  constructor(code, message, status = 401) {
    super(message)
    this.name = 'AdminAuthError'
    this.code = code
    this.status = status
  }
}

const readInt = (raw, fallback, { min, max }) => {
  if (raw == null || String(raw).trim() === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

const sha256 = (value) => createHash('sha256').update(String(value)).digest()
const constantTimeEqual = (a, b) => {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a))
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

/** RFC 4648 base32 解码；忽略空格/短横线，不接受非法字符。 */
export function base32Decode(input) {
  const normalized = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!normalized) return Buffer.alloc(0)
  let bits = 0
  let value = 0
  const bytes = []
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index < 0) throw new Error('TOTP 种子不是合法的 base32 字符串')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** base32 编码，用于 `admin-init` 生成 TOTP 种子。 */
export function base32Encode(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += BASE32_ALPHABET[(value >>> bits) & 31]
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/** RFC 6238 TOTP（默认 SHA1 / 30 秒 / 6 位）。 */
export function generateTotp(secret, { timestamp = Date.now(), stepSeconds = 30, digits = 6 } = {}) {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret
  if (!key?.length) throw new Error('TOTP 种子为空')
  const counter = Math.floor(timestamp / 1000 / stepSeconds)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(buffer).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(binary % (10 ** digits)).padStart(digits, '0')
}

/**
 * 校验 TOTP，允许 ±1 个时间步的时钟偏差。
 * @returns {{ ok: boolean, counter: number|null }}
 */
export function verifyTotp(secret, code, { now = Date.now(), window = 1, stepSeconds = 30, digits = 6 } = {}) {
  const normalized = String(code || '').trim()
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return { ok: false, counter: null }
  const currentCounter = Math.floor(now / 1000 / stepSeconds)
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset
    const expected = generateTotp(secret, { timestamp: counter * stepSeconds * 1000, stepSeconds, digits })
    if (constantTimeEqual(expected, normalized)) return { ok: true, counter }
  }
  return { ok: false, counter: null }
}

export async function hashAdminPassword(password, options = {}) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 128) {
    throw new Error('管理员密码长度需为 16～128 位')
  }
  const { N, r, p, keyLength, maxmem } = { ...ADMIN_SCRYPT_DEFAULTS, ...options }
  const salt = randomBytes(16)
  const derived = Buffer.from(await scryptAsync(password, salt, keyLength, { N, r, p, maxmem }))
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export function parsePasswordHash(stored) {
  const parts = String(stored || '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [, N, r, p, salt, hash] = parts
  const options = { N: Number(N), r: Number(r), p: Number(p) }
  if (!Number.isInteger(options.N) || !Number.isInteger(options.r) || !Number.isInteger(options.p)) return null
  if (options.N < 1024 || options.N > 1_048_576 || options.r < 1 || options.r > 32 || options.p < 1 || options.p > 16) return null
  let saltBuffer
  let hashBuffer
  try {
    saltBuffer = Buffer.from(salt, 'base64url')
    hashBuffer = Buffer.from(hash, 'base64url')
  } catch {
    return null
  }
  if (saltBuffer.length < 8 || hashBuffer.length < 16) return null
  return { ...options, salt: saltBuffer, hash: hashBuffer }
}

export async function verifyAdminPassword(password, stored) {
  const parsed = parsePasswordHash(stored)
  if (!parsed || typeof password !== 'string') return false
  const derived = Buffer.from(await scryptAsync(password, parsed.salt, parsed.hash.length, {
    N: parsed.N, r: parsed.r, p: parsed.p, maxmem: ADMIN_SCRYPT_DEFAULTS.maxmem
  }))
  return constantTimeEqual(derived, parsed.hash)
}

/** 用户名比较也走常数时间，避免通过响应时间探测账号。 */
export const verifyAdminUsername = (candidate, expected) => constantTimeEqual(sha256(candidate), sha256(expected))

/**
 * 从环境变量读取管理台配置。任何必填项缺失/非法都返回 error，由调用方 fail closed。
 * @returns {{ config: object|null, error: string }}
 */
export function loadAdminConfig(env = process.env) {
  const required = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'ADMIN_TOTP_SECRET', 'ADMIN_JWT_SECRET']
  const missing = required.filter((key) => !String(env[key] || '').trim())
  if (missing.length) return { config: null, error: `缺少环境变量 ${missing.join(', ')}，管理台未启动` }
  const username = String(env.ADMIN_USERNAME).trim()
  if (username.length < 2 || username.length > 64) return { config: null, error: 'ADMIN_USERNAME 长度需为 2～64' }
  if (!parsePasswordHash(env.ADMIN_PASSWORD_HASH)) return { config: null, error: 'ADMIN_PASSWORD_HASH 格式非法（需用 admin-init 生成）' }
  if (Buffer.byteLength(String(env.ADMIN_JWT_SECRET), 'utf8') < 32) return { config: null, error: 'ADMIN_JWT_SECRET 至少 32 字节' }
  let totpBytes
  try {
    totpBytes = base32Decode(env.ADMIN_TOTP_SECRET)
  } catch (error) {
    return { config: null, error: error.message }
  }
  if (totpBytes.length < 10) return { config: null, error: 'ADMIN_TOTP_SECRET 至少 10 字节' }
  const port = readInt(env.ADMIN_PORT, ADMIN_DEFAULTS.port, { min: 1, max: 65535 })
  const sessionTtlSeconds = readInt(env.ADMIN_SESSION_TTL_SECONDS, ADMIN_DEFAULTS.sessionTtlSeconds, { min: 60, max: 24 * 60 * 60 })
  const maxLoginFailures = readInt(env.ADMIN_MAX_LOGIN_FAILURES, ADMIN_DEFAULTS.maxLoginFailures, { min: 1, max: 100 })
  const loginWindowSeconds = readInt(env.ADMIN_LOGIN_WINDOW_SECONDS, ADMIN_DEFAULTS.loginWindowSeconds, { min: 60, max: 24 * 60 * 60 })
  const loginLockSeconds = readInt(env.ADMIN_LOGIN_LOCK_SECONDS, ADMIN_DEFAULTS.loginLockSeconds, { min: 60, max: 7 * 24 * 60 * 60 })
  const maxInvitesPerRequest = readInt(env.ADMIN_MAX_INVITES_PER_REQUEST, ADMIN_DEFAULTS.maxInvitesPerRequest, { min: 1, max: 1000 })
  const maxInvitesPerDay = readInt(env.ADMIN_MAX_INVITES_PER_DAY, ADMIN_DEFAULTS.maxInvitesPerDay, { min: 1, max: 100000 })
  return {
    config: {
      username,
      passwordHash: env.ADMIN_PASSWORD_HASH,
      totpSecret: env.ADMIN_TOTP_SECRET,
      jwtSecret: env.ADMIN_JWT_SECRET,
      port,
      sessionTtlSeconds,
      maxLoginFailures,
      loginWindowSeconds,
      loginLockSeconds,
      maxInvitesPerRequest,
      maxInvitesPerDay,
      issuer: ADMIN_ISSUER,
      audience: ADMIN_AUDIENCE
    },
    error: ''
  }
}

const adminSigningKey = (config) => new TextEncoder().encode(config.jwtSecret)

export async function createAdminToken(config, { now = Date.now() } = {}) {
  const issuedAt = Math.floor(now / 1000)
  const expiresAt = issuedAt + config.sessionTtlSeconds
  const token = await new SignJWT({ role: 'ops' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(config.username)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(randomUUID())
    .sign(adminSigningKey(config))
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString() }
}

export async function verifyAdminToken(config, token, { now = Date.now() } = {}) {
  if (!token) throw new AdminAuthError('ADMIN_AUTH_REQUIRED', '请先登录管理台', 401)
  try {
    const { payload } = await jwtVerify(token, adminSigningKey(config), {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
      currentDate: new Date(now)
    })
    if (payload.role !== 'ops' || payload.sub !== config.username) throw new Error('admin claims mismatch')
    return payload
  } catch (error) {
    if (error instanceof AdminAuthError) throw error
    throw new AdminAuthError('ADMIN_TOKEN_INVALID', '管理会话已失效，请重新登录', 401)
  }
}

/**
 * 登录失败限速/锁定。管理服务只监听回环，仍保留这层防止本机脚本暴力尝试。
 */
export function createAdminLoginLimiter({ maxFailures = ADMIN_DEFAULTS.maxLoginFailures, windowMs = ADMIN_DEFAULTS.loginWindowSeconds * 1000, lockMs = ADMIN_DEFAULTS.loginLockSeconds * 1000, now = () => Date.now() } = {}) {
  const failures = []
  let lockedUntil = 0
  const check = () => {
    const current = now()
    if (lockedUntil > current) return { locked: true, retryAfterSeconds: Math.ceil((lockedUntil - current) / 1000) }
    if (lockedUntil && lockedUntil <= current) lockedUntil = 0
    return { locked: false, retryAfterSeconds: 0 }
  }
  const fail = () => {
    const current = now()
    while (failures.length && failures[0] <= current - windowMs) failures.shift()
    failures.push(current)
    if (failures.length >= maxFailures) {
      lockedUntil = current + lockMs
      failures.length = 0
      return { locked: true, retryAfterSeconds: Math.ceil(lockMs / 1000) }
    }
    return { locked: false, retryAfterSeconds: 0 }
  }
  const succeed = () => {
    failures.length = 0
    lockedUntil = 0
  }
  return { check, fail, succeed }
}

export { constantTimeEqual }
