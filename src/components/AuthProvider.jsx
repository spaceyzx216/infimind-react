import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AUTH_EXPIRED_EVENT, clearInMemoryAccessToken, getCurrentUser, loginUser, logoutUser, registerUser, retryPendingLogout, subscribeAuthEvents } from '../utils/auth-api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [status, setStatus] = useState('loading')
  const [authError, setAuthError] = useState('')

  const refreshUser = useCallback(async () => {
    try {
      const logoutFinished = await retryPendingLogout()
      if (!logoutFinished) {
        setUser(null)
        setAuthError('退出未完成，请检查网络后重试。')
        setStatus('ready')
        return null
      }
      const currentUser = await getCurrentUser()
      setUser(currentUser)
      setAuthError('')
      setStatus('ready')
      return currentUser
    } catch (error) {
      setUser(null)
      setAuthError(error.message || '暂时无法验证登录状态')
      setStatus('ready')
      return null
    }
  }, [])

  useEffect(() => {
    refreshUser()
    const handleExpired = () => {
      clearInMemoryAccessToken()
      setUser(null)
      setStatus('ready')
    }
    const unsubscribe = subscribeAuthEvents((event) => {
      if (event?.type === 'logout') handleExpired()
      if (event?.type === 'login') {
        clearInMemoryAccessToken()
        setUser(null)
        setStatus('loading')
        refreshUser()
      }
    })
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired)
    return () => {
      unsubscribe()
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired)
    }
  }, [refreshUser])

  const value = useMemo(() => ({
    user,
    status,
    authError,
    login: async (input) => {
      const result = await loginUser(input)
      setUser(result.user)
      setAuthError('')
      setStatus('ready')
      return result.user
    },
    register: registerUser,
    logout: async () => {
      try {
        await logoutUser()
        setUser(null)
        setAuthError('')
        setStatus('ready')
        return true
      } catch (error) {
        setUser(null)
        setAuthError(error.message || '退出未完成，请检查网络后重试。')
        setStatus('ready')
        return false
      }
    },
    refreshUser
  }), [authError, refreshUser, status, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
