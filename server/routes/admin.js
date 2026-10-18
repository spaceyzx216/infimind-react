/**
 * 运维管理台（邀请码）HTTP 面。
 *
 * 安全边界：
 * - 只由 server/index.js 在 `127.0.0.1:ADMIN_PORT` 上启动，绝不挂到公开 8790 应用；
 * - 不启用 CORS、不写 Cookie；管理令牌只走 Authorization: Bearer（浏览器内存）；
 * - 独立 ADMIN_JWT_SECRET / issuer / audience，普通用户 JWT 无法访问；
 * - 页面与接口都带严格 CSP / no-store / frame-deny 等响应头；
 * - 登录失败限速 + 锁定，所有动作写审计（不记录明文码/密码/TOTP）。
 */
import express from 'express'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AdminAuthError,
  createAdminLoginLimiter,
  createAdminToken,
  verifyAdminPassword,
  verifyAdminToken,
  verifyAdminUsername,
  verifyTotp
} from '../services/admin-auth.js'
import { AdminError, createAdminService, INVITE_STATES } from '../services/admin-service.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ADMIN_UI_DIR = join(__dirname, '..', 'admin-ui')

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store'
})

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const isLoopback = (request) => LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress || '')

const bearerToken = (request) => {
  const match = String(request.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

const clientMeta = (request) => ({
  ip: String(request.socket?.remoteAddress || '').replace(/^::ffff:/, ''),
  userAgent: String(request.get('User-Agent') || '')
})

const sendError = (response, error) => {
  if (error instanceof AdminAuthError || error instanceof AdminError) {
    if (error.retryAfterSeconds) response.setHeader('Retry-After', String(error.retryAfterSeconds))
    return response.status(error.status).json({ error: error.message, code: error.code })
  }
  console.error('[admin] request failed:', error?.message || error)
  return response.status(500).json({ error: '管理台暂时不可用', code: 'ADMIN_INTERNAL_ERROR' })
}

const parseLoginBody = (body) => {
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const totp = typeof body?.totp === 'string' ? body.totp.trim() : ''
  if (!username || username.length > 64 || !password || password.length > 128) {
    throw new AdminAuthError('ADMIN_LOGIN_INVALID', '账号、密码或动态验证码不正确', 401)
  }
  if (!/^\d{6}$/.test(totp)) throw new AdminAuthError('ADMIN_LOGIN_INVALID', '账号、密码或动态验证码不正确', 401)
  return { username, password, totp }
}

/**
 * 创建管理台 Express 应用（不负责 listen，便于测试）。
 * @param {{ database: object, config: object, now?: () => number }} options
 */
export function createAdminApp({ database, config, now = () => Date.now() } = {}) {
  if (!database) throw new Error('createAdminApp requires a business database')
  if (!config) throw new Error('createAdminApp requires admin config')

  const app = express()
  app.disable('x-powered-by')
  app.set('etag', false)
  app.set('trust proxy', false)

  const adminService = createAdminService({ database, config, now })
  const limiter = createAdminLoginLimiter({
    maxFailures: config.maxLoginFailures,
    windowMs: config.loginWindowSeconds * 1000,
    lockMs: config.loginLockSeconds * 1000,
    now
  })

  app.use((request, response, next) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(header, value)
    if (!isLoopback(request)) {
      return response.status(403).json({ error: '仅允许回环地址访问', code: 'ADMIN_LOOPBACK_ONLY' })
    }
    return next()
  })

  const requireAdmin = async (request, response, next) => {
    try {
      request.admin = await verifyAdminToken(config, bearerToken(request), { now: now() })
      return next()
    } catch (error) {
      return sendError(response, error)
    }
  }

  app.use('/admin/api', express.json({ limit: '64kb', strict: true }))

  app.get('/admin/api/health', (request, response) => {
    response.json({ ok: true, service: 'fafee-admin', time: new Date(now()).toISOString() })
  })

  app.post('/admin/api/login', async (request, response) => {
    let credentials
    try {
      credentials = parseLoginBody(request.body)
    } catch (error) {
      return sendError(response, error)
    }
    const lock = limiter.check()
    if (lock.locked) {
      const meta = clientMeta(request)
      adminService.recordAudit({ actor: credentials.username.slice(0, 64), action: 'admin.login', result: 'locked', detail: { retryAfterSeconds: lock.retryAfterSeconds }, ...meta })
      const error = new AdminAuthError('ADMIN_LOGIN_LOCKED', '尝试次数过多，请稍后再试', 429)
      error.retryAfterSeconds = lock.retryAfterSeconds
      return sendError(response, error)
    }
    const meta = clientMeta(request)
    try {
      const usernameOk = verifyAdminUsername(credentials.username, config.username)
      const passwordOk = await verifyAdminPassword(credentials.password, config.passwordHash)
      const totp = verifyTotp(config.totpSecret, credentials.totp, { now: now() })
      if (!usernameOk || !passwordOk || !totp.ok) {
        const next = limiter.fail()
        adminService.recordAudit({ actor: credentials.username.slice(0, 64), action: 'admin.login', result: 'fail', detail: { locked: next.locked }, ...meta })
        const error = new AdminAuthError('ADMIN_LOGIN_INVALID', '账号、密码或动态验证码不正确', 401)
        if (next.locked) {
          error.code = 'ADMIN_LOGIN_LOCKED'
          error.message = '尝试次数过多，请稍后再试'
          error.status = 429
          error.retryAfterSeconds = next.retryAfterSeconds
        }
        return sendError(response, error)
      }
      limiter.succeed()
      const token = await createAdminToken(config, { now: now() })
      adminService.recordAudit({ actor: config.username, action: 'admin.login', result: 'ok', ...meta })
      return response.json({ token: token.token, expiresAt: token.expiresAt, user: { username: config.username } })
    } catch (error) {
      return sendError(response, error)
    }
  })

  app.get('/admin/api/me', requireAdmin, (request, response) => {
    response.json({ user: { username: request.admin.sub } })
  })

  app.get('/admin/api/invites', requireAdmin, (request, response) => {
    try {
      const result = adminService.listInvites({
        status: INVITE_STATES.includes(String(request.query.status || '')) ? request.query.status : 'all',
        q: request.query.q,
        page: request.query.page,
        pageSize: request.query.pageSize
      })
      response.json(result)
    } catch (error) {
      sendError(response, error)
    }
  })

  app.post('/admin/api/invites', requireAdmin, (request, response) => {
    try {
      const result = adminService.createInvites({
        actor: request.admin.sub,
        count: request.body?.count,
        label: request.body?.label,
        note: request.body?.note,
        expiresAt: request.body?.expiresAt,
        ...clientMeta(request)
      })
      response.status(201).json(result)
    } catch (error) {
      sendError(response, error)
    }
  })

  app.post('/admin/api/invites/:id/disable', requireAdmin, (request, response) => {
    try {
      const result = adminService.disableInvite({ id: request.params.id, actor: request.admin.sub, ...clientMeta(request) })
      response.json(result)
    } catch (error) {
      sendError(response, error)
    }
  })

  app.get('/admin/api/stats', requireAdmin, (request, response) => {
    try {
      response.json(adminService.getStats())
    } catch (error) {
      sendError(response, error)
    }
  })

  app.get('/admin/api/audit', requireAdmin, (request, response) => {
    try {
      response.json(adminService.listAudit({ page: request.query.page, pageSize: request.query.pageSize, action: request.query.action }))
    } catch (error) {
      sendError(response, error)
    }
  })

  app.use('/admin/api', (request, response) => {
    response.status(404).json({ error: '接口不存在', code: 'ADMIN_NOT_FOUND' })
  })

  app.use(express.static(ADMIN_UI_DIR, {
    index: 'index.html',
    dotfiles: 'deny',
    etag: false,
    maxAge: 0,
    fallthrough: true
  }))

  app.use((request, response) => {
    response.status(404).type('text/plain; charset=utf-8').send('Not found')
  })

  // eslint-disable-next-line no-unused-vars
  app.use((error, request, response, next) => {
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: '请求体过大', code: 'ADMIN_BODY_TOO_LARGE' })
    if (error instanceof SyntaxError) return response.status(400).json({ error: '请求格式无效', code: 'ADMIN_BAD_JSON' })
    return sendError(response, error)
  })

  return app
}
