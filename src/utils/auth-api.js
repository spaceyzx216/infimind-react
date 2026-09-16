export const AUTH_EXPIRED_EVENT = 'fafee-auth-expired'

const AUTH_SYNC_KEY = 'fafee-auth-sync'
const PENDING_LOGOUT_KEY = 'fafee-pending-logout'
let accessToken = ''
let accessTokenExpiresAt = ''
let refreshInFlight = null
let authGeneration = 0
const listeners = new Set()
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('fafee-auth')

const isAuthEndpoint = (input) => String(typeof input === 'string' ? input : input?.url || '').includes('/api/auth/')
const parseJson = async (response) => response.json().catch(() => ({}))
const authHeaders = (headers = {}) => {
  const next = new Headers(headers)
  if (accessToken) next.set('Authorization', `Bearer ${accessToken}`)
  return next
}
const setAccessToken = (token = '', expiresAt = '') => {
  accessToken = token
  accessTokenExpiresAt = expiresAt
}
const pendingLogout = () => sessionStorage.getItem(PENDING_LOGOUT_KEY) === '1'
const markPendingLogout = () => sessionStorage.setItem(PENDING_LOGOUT_KEY, '1')
const clearPendingLogout = () => sessionStorage.removeItem(PENDING_LOGOUT_KEY)

const notify = (type) => {
  const event = { type }
  if (channel) channel.postMessage(event)
  else localStorage.setItem(AUTH_SYNC_KEY, JSON.stringify({ ...event, at: Date.now() }))
}

if (channel) channel.onmessage = (event) => listeners.forEach((listener) => listener(event.data))
else if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_SYNC_KEY || !event.newValue) return
    try { listeners.forEach((listener) => listener(JSON.parse(event.newValue))) } catch {}
  })
}

export const subscribeAuthEvents = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const apiError = async (response, fallback) => {
  const payload = await parseJson(response)
  return new Error(payload.error || fallback || `请求失败（${response.status}）`)
}

export class AuthNetworkError extends Error {
  constructor(message = '网络异常，请检查连接后重试') {
    super(message)
    this.name = 'AuthNetworkError'
  }
}

async function refreshAccessToken() {
  if (pendingLogout()) return null
  if (refreshInFlight) return refreshInFlight
  // A logout can happen in this tab or another tab while this request waits on
  // the network. Only the generation that started this refresh may write a token.
  const refreshGeneration = authGeneration
  refreshInFlight = (async () => {
    let response
    try {
      response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'X-Fafee-Auth': '1' }
      })
    } catch {
      throw new AuthNetworkError('暂时无法恢复登录状态，请检查网络后重试')
    }
    if (response.status === 401) {
      if (refreshGeneration === authGeneration) setAccessToken()
      return null
    }
    if (!response.ok) throw await apiError(response, '暂时无法恢复登录状态')
    const payload = await parseJson(response)
    // Check again immediately before the write: a late response must never
    // restore access after logout has invalidated this generation.
    if (!payload.accessToken || refreshGeneration !== authGeneration || pendingLogout()) return null
    setAccessToken(payload.accessToken, payload.accessTokenExpiresAt)
    return payload
  })().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

export async function authFetch(input, options = {}) {
  const { retryAuth = true, ...fetchOptions } = options
  if (!accessToken && retryAuth && !isAuthEndpoint(input)) {
    const restored = await refreshAccessToken()
    if (!restored) {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
      return new Response(null, { status: 401, statusText: 'Unauthorized' })
    }
  }
  const response = await fetch(input, { ...fetchOptions, headers: authHeaders(fetchOptions.headers), credentials: 'include' })
  if (response.status !== 401 || !retryAuth || isAuthEndpoint(input)) return response
  const refreshed = await refreshAccessToken()
  if (!refreshed) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    return response
  }
  return fetch(input, { ...fetchOptions, headers: authHeaders(fetchOptions.headers), credentials: 'include' })
}

export async function getCurrentUser() {
  if (pendingLogout()) return null
  const refresh = await refreshAccessToken()
  if (!refresh) return null
  const response = await authFetch('/api/auth/me', { retryAuth: false, cache: 'no-store', headers: { Accept: 'application/json' } })
  if (response.status === 401) return null
  if (!response.ok) throw await apiError(response, '暂时无法恢复登录状态')
  const payload = await parseJson(response)
  return payload.user || null
}

export async function registerUser(input) {
  const response = await fetch('/api/auth/register', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(input)
  })
  if (!response.ok) throw await apiError(response, '注册失败')
  return parseJson(response)
}

export async function loginUser(input) {
  const response = await fetch('/api/auth/login', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Fafee-Auth': '1' }, body: JSON.stringify(input)
  })
  if (!response.ok) throw await apiError(response, '登录失败')
  const payload = await parseJson(response)
  setAccessToken(payload.accessToken, payload.accessTokenExpiresAt)
  clearPendingLogout()
  notify('login')
  return payload
}

const requestLogout = async () => {
  const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'X-Fafee-Auth': '1' } })
  if (!response.ok) throw await apiError(response, '退出登录失败')
  clearPendingLogout()
  return parseJson(response)
}

export async function logoutUser() {
  authGeneration += 1
  setAccessToken()
  markPendingLogout()
  notify('logout')
  try {
    return await requestLogout()
  } catch (error) {
    throw new AuthNetworkError('退出未完成，请检查网络后重试')
  }
}

export async function retryPendingLogout() {
  if (!pendingLogout()) return true
  try {
    await requestLogout()
    return true
  } catch {
    return false
  }
}

export const getAccessTokenExpiry = () => accessTokenExpiresAt
export const clearInMemoryAccessToken = () => { authGeneration += 1; setAccessToken() }
