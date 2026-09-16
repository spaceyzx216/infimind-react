import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { SignJWT, jwtVerify } from 'jose'

const scryptAsync = promisify(scrypt)
const PASSWORD_KEY_LENGTH = 64
const PASSWORD_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }
const PASSWORD_MIN_LENGTH = 8
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REFRESH_COOKIE = 'fafee_refresh'
const DEFAULT_ISSUER = 'fafee-api'
const DEFAULT_AUDIENCE = 'fafee-web'

export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.status = status
  }
}

const normalizeInviteCode = (value) => String(value || '').trim().toUpperCase()
const hashSecret = (value) => createHash('sha256').update(value).digest('hex')
const normalizeUsername = (value) => String(value || '').trim()
const normalizeEmail = (value) => String(value || '').trim().toLowerCase()
const publicUser = (row) => row ? ({ id: row.id, username: row.username, email: row.email }) : null
const toIso = (timestamp) => new Date(timestamp).toISOString()
const seconds = (timestamp) => Math.floor(timestamp / 1000)

const validateRegistration = ({ inviteCode, username, email, password }) => {
  if (!normalizeInviteCode(inviteCode)) throw new AuthError('INVITE_REQUIRED', '请输入邀请码')
  const normalizedUsername = normalizeUsername(username)
  if (!normalizedUsername || normalizedUsername.length < 2 || normalizedUsername.length > 32 || !/^[\p{L}\p{N}_-]+$/u.test(normalizedUsername)) {
    throw new AuthError('USERNAME_INVALID', '用户名需为 2～32 位字母、数字、中文、下划线或短横线')
  }
  const normalizedEmail = normalizeEmail(email)
  if (!normalizedEmail || normalizedEmail.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new AuthError('EMAIL_INVALID', '请输入有效邮箱')
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
    throw new AuthError('PASSWORD_INVALID', `密码长度需为 ${PASSWORD_MIN_LENGTH}～128 位`)
  }
  return { inviteCode: normalizeInviteCode(inviteCode), username: normalizedUsername, email: normalizedEmail, password }
}

const validateLogin = ({ identifier, password }) => {
  const normalizedIdentifier = String(identifier || '').trim()
  if (!normalizedIdentifier || typeof password !== 'string' || !password) throw new AuthError('CREDENTIALS_INVALID', '请输入用户名或邮箱和密码')
  return { identifier: normalizedIdentifier, password }
}

const derivePasswordHash = async (password, salt) => Buffer.from(await scryptAsync(password, salt, PASSWORD_KEY_LENGTH, PASSWORD_SCRYPT_OPTIONS)).toString('hex')

const passwordMatches = async (password, row) => {
  const expected = Buffer.from(row.password_hash, 'hex')
  const actual = Buffer.from(await derivePasswordHash(password, Buffer.from(row.password_salt, 'hex')), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const serializeInviteCode = () => `FF-${randomBytes(12).toString('hex').toUpperCase()}`
const tokenHash = (token) => hashSecret(token)

export function createAuthService(database, options = {}) {
  if (!database) throw new Error('createAuthService requires a business database')
  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret, 'utf8') < 32) throw new Error('JWT_SECRET is required and must contain at least 32 bytes')

  const issuer = options.issuer ?? process.env.JWT_ISSUER ?? DEFAULT_ISSUER
  const audience = options.audience ?? process.env.JWT_AUDIENCE ?? DEFAULT_AUDIENCE
  const accessTtlMs = options.accessTtlMs ?? ACCESS_TOKEN_TTL_MS
  const refreshTtlMs = options.refreshTtlMs ?? REFRESH_TOKEN_TTL_MS
  const now = options.now ?? (() => Date.now())
  const signingKey = new TextEncoder().encode(jwtSecret)
  const removeExpiredRefreshTokens = database.prepare('DELETE FROM auth_refresh_tokens WHERE expires_at <= ?')
  const findUserByRefreshToken = database.prepare(`
    SELECT u.id, u.username, u.email
    FROM auth_refresh_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
  `)
  const findUserById = database.prepare('SELECT id, username, email FROM users WHERE id = ?')

  const registerUserTransaction = database.transaction(({ inviteCode, username, email, passwordHash, passwordSalt }) => {
    const invite = database.prepare('SELECT id, used_at FROM invite_codes WHERE code_hash = ?').get(hashSecret(inviteCode))
    if (!invite) throw new AuthError('INVITE_INVALID', '邀请码无效或不存在')
    if (invite.used_at) throw new AuthError('INVITE_USED', '该邀请码已使用')
    const userId = randomUUID()
    const createdAt = toIso(now())
    try {
      database.prepare('INSERT INTO users (id, username, email, password_hash, password_salt, invite_code_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(userId, username, email, passwordHash, passwordSalt, invite.id, createdAt)
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw new AuthError('ACCOUNT_EXISTS', '用户名或邮箱已注册', 409)
      throw error
    }
    const updated = database.prepare('UPDATE invite_codes SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL').run(createdAt, userId, invite.id)
    if (updated.changes !== 1) throw new AuthError('INVITE_USED', '该邀请码已使用')
    return { id: userId, username, email }
  }).immediate

  const createRefreshToken = database.transaction((userId) => {
    const token = randomBytes(32).toString('base64url')
    const createdAt = now()
    const expiresAt = createdAt + refreshTtlMs
    database.prepare('INSERT INTO auth_refresh_tokens (id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), tokenHash(token), userId, toIso(createdAt), toIso(expiresAt))
    return { token, expiresAt: toIso(expiresAt) }
  }).immediate

  const revokeRefreshToken = database.transaction((token) => {
    if (token) database.prepare('UPDATE auth_refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(toIso(now()), tokenHash(token))
  }).immediate

  const findRefreshUser = database.transaction((token) => {
    if (!token) return null
    const nowValue = toIso(now())
    removeExpiredRefreshTokens.run(nowValue)
    return publicUser(findUserByRefreshToken.get(tokenHash(token), nowValue))
  }).immediate

  const issueAccessToken = async (user) => {
    const issuedAt = now()
    const expiresAt = issuedAt + accessTtlMs
    const accessToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(seconds(issuedAt))
      .setExpirationTime(seconds(expiresAt))
      .setJti(randomUUID())
      .sign(signingKey)
    return { accessToken, accessTokenExpiresAt: toIso(expiresAt) }
  }

  return {
    async register({ inviteCode, username, email, password }) {
      const input = validateRegistration({ inviteCode, username, email, password })
      const passwordSalt = randomBytes(16)
      const passwordHash = await derivePasswordHash(input.password, passwordSalt)
      return { user: publicUser(registerUserTransaction({ ...input, passwordHash, passwordSalt: passwordSalt.toString('hex') })) }
    },
    async login({ identifier, password }) {
      const input = validateLogin({ identifier, password })
      const row = database.prepare('SELECT id, username, email, password_hash, password_salt FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE').get(input.identifier, input.identifier.toLowerCase())
      if (!row || !(await passwordMatches(input.password, row))) throw new AuthError('LOGIN_INVALID', '用户名或邮箱、密码不匹配', 401)
      removeExpiredRefreshTokens.run(toIso(now()))
      const user = publicUser(row)
      const refresh = createRefreshToken(user.id)
      return { user, refreshToken: refresh.token, refreshTokenExpiresAt: refresh.expiresAt, ...(await issueAccessToken(user)) }
    },
    async refresh(refreshToken) {
      const user = findRefreshUser(refreshToken)
      if (!user) throw new AuthError('REFRESH_INVALID', '登录已过期，请重新登录', 401)
      return { user, ...(await issueAccessToken(user)) }
    },
    async getUserByAccessToken(accessToken) {
      if (!accessToken) throw new AuthError('ACCESS_TOKEN_MISSING', '请先登录', 401)
      try {
        const { payload } = await jwtVerify(accessToken, signingKey, { algorithms: ['HS256'], issuer, audience, currentDate: new Date(now()) })
        if (!payload.sub) throw new Error('JWT has no subject')
        const user = publicUser(findUserById.get(payload.sub))
        if (!user) throw new Error('JWT user no longer exists')
        return user
      } catch (error) {
        if (error instanceof AuthError) throw error
        throw new AuthError('ACCESS_TOKEN_INVALID', '登录状态已失效，请重新登录', 401)
      }
    },
    logout(refreshToken) {
      revokeRefreshToken(refreshToken)
    },
    createInviteCodes(count = 1) {
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('邀请码数量需为 1～1000')
      const insert = database.prepare('INSERT INTO invite_codes (id, code_hash, created_at) VALUES (?, ?, ?)')
      return database.transaction((amount) => {
        const codes = []
        while (codes.length < amount) {
          const code = serializeInviteCode()
          try {
            insert.run(randomUUID(), hashSecret(code), toIso(now()))
            codes.push(code)
          } catch (error) {
            if (!String(error?.code || '').startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw error
          }
        }
        return codes
      })(count)
    },
    accessTokenTtlMs: accessTtlMs,
    refreshTokenTtlMs: refreshTtlMs,
    refreshCookie: REFRESH_COOKIE,
    issuer,
    audience
  }
}

export { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, REFRESH_COOKIE }
