import { Router } from 'express'
import { AuthError } from '../services/auth-service.js'
import { clearRefreshCookie, createRequireAuth, refreshTokenFromRequest, requireAuthCookieRequest, setAuthNoStore, setRefreshCookie } from '../middleware/auth.js'

const sendAuthError = (response, error) => {
  setAuthNoStore(response)
  if (error instanceof AuthError) return response.status(error.status).json({ error: error.message, code: error.code })
  console.error('[auth] Request failed:', error)
  return response.status(500).json({ error: '认证服务暂时不可用', code: 'AUTH_INTERNAL_ERROR' })
}

export function createAuthRouter(authService) {
  const router = Router()
  const requireAccessToken = createRequireAuth(authService)

  router.post('/register', async (request, response) => {
    try {
      const user = await authService.register(request.body || {})
      setAuthNoStore(response)
      return response.status(201).json(user)
    } catch (error) {
      return sendAuthError(response, error)
    }
  })

  router.post('/login', requireAuthCookieRequest, async (request, response) => {
    try {
      const result = await authService.login(request.body || {})
      setAuthNoStore(response)
      setRefreshCookie(response, result.refreshToken, authService.refreshTokenTtlMs)
      return response.json({ user: result.user, accessToken: result.accessToken, accessTokenExpiresAt: result.accessTokenExpiresAt })
    } catch (error) {
      return sendAuthError(response, error)
    }
  })

  router.post('/refresh', requireAuthCookieRequest, async (request, response) => {
    try {
      const result = await authService.refresh(refreshTokenFromRequest(request))
      setAuthNoStore(response)
      return response.json(result)
    } catch (error) {
      clearRefreshCookie(response)
      return sendAuthError(response, error)
    }
  })

  router.get('/me', requireAccessToken, (request, response) => {
    setAuthNoStore(response)
    return response.json({ user: request.user })
  })

  router.post('/logout', requireAuthCookieRequest, (request, response) => {
    authService.logout(refreshTokenFromRequest(request))
    clearRefreshCookie(response)
    setAuthNoStore(response)
    return response.json({ ok: true })
  })

  return router
}
