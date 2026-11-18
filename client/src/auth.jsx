import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api } from './api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [setup, setSetup] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    Promise.all([api('/setup/status').catch(() => null), api('/auth/me').catch(() => null)])
      .then(([status, me]) => {
        if (!alive) return
        setSetup(Boolean(status?.setup))
        setUser(me?.user || null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const result = await api('/auth/me')
      setUser(result.user)
      return result.user
    } catch {
      setUser(null)
      return null
    }
  }, [])

  const login = useCallback(async (username, password) => {
    const result = await api('/auth/login', { method: 'POST', body: { username, password } })
    setUser(result.user)
    return result.user
  }, [])

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      // session may already be gone
    }
    setUser(null)
  }, [])

  const completeSetup = useCallback(async () => {
    setSetup(true)
    await refresh()
  }, [refresh])

  return (
    <AuthContext.Provider
      value={{ user, setup, loading, login, logout, refresh, completeSetup, setSetup }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
