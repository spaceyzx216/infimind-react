import { REFRESH_COOKIE } from '../services/auth-service.js'

const getCookie = (request, name) => {
  const header = request.get('Cookie') || ''
  const pair = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  if (!pair) return ''
  try {
    return decodeURIComponent(pair.slice(name.length + 1))
  } catch {
    return ''
  }
}

const configuredOrigins = () => new Set(String(process.env.AUTH_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean))

const isTrustedAuthOrigin = (request) => {
  const origin = request.get('Origin')
  if (!origin) return true
  const allowed = configuredOrigins()
  if (allowed.has(origin)) return true
  if (process.env.NODE_ENV !== 'production') {
    try {
      const hostname = new URL(origin).hostname
      if (hostname === 'localhost' || hostname === '127.0.0.1') return true
    } catch {}
  }
  const protocol = request.get('X-Forwarded-Proto') || request.protocol
  return origin === `${protocol}://${request.get('Host')}`
}

export const refreshTokenFromRequest = (request) => getCookie(request, REFRESH_COOKIE)

export const accessTokenFromRequest = (request) => {
  const authorization = request.get('Authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

export function createRequireAuth(authService) {
  return async (request, response, next) => {
    try {
      const user = await authService.getUserByAccessToken(accessTokenFromRequest(request))
      request.user = user
      return next()
    } catch {
      return response.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' })
    }
  }
}

export const requireAuthCookieRequest = (request, response, next) => {
  if (request.get('X-Fafee-Auth') !== '1') return response.status(403).json({ error: '认证请求来源无效', code: 'AUTH_REQUEST_REQUIRED' })
  if (!isTrustedAuthOrigin(request)) return response.status(403).json({ error: '认证请求来源无效', code: 'AUTH_ORIGIN_REJECTED' })
  return next()
}

const cookieAttributes = (maxAge) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export const setRefreshCookie = (response, token, ttlMs) => {
  response.setHeader('Set-Cookie', `${REFRESH_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(Math.floor(ttlMs / 1000))}`)
}

export const clearRefreshCookie = (response) => {
  response.setHeader('Set-Cookie', `${REFRESH_COOKIE}=; ${cookieAttributes(0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)
}

export const setAuthNoStore = (response) => response.setHeader('Cache-Control', 'no-store')
