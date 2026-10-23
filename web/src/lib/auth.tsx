import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { setSessionEndedHandler } from '../api/client'
import * as resources from '../api/resources'
import type { AuthUser } from '../api/types'
import { LoginDialog } from '../components/LoginDialog'
import { CanEditProvider } from './canEdit'

// Phase 6 (REQ_AUTH_001/005/006/007, REQ_FE_083): the real session state. `canEdit` is simply "someone is
// logged in" — every admin can edit everything (REQ_AUTH_002). The password is never kept here: it lives
// in the login dialog's own input state for the length of one submit and goes nowhere else.
export interface Auth {
  user: AuthUser | null
  canEdit: boolean
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  openLogin: () => void
  // REQ_AUTH_007: a request came back 401 while the page thought we were logged in.
  sessionEnded: boolean
  // Logout failed (the session is still alive) / password changed (session ended).
  authNotice: { kind: 'error' | 'info'; text: string } | null
  dismissAuthNotice: () => void
  // REQ_AUTH_010: the logged-in user reset their own password, which deleted their sessions.
  selfPasswordChanged: () => void
}

const noop = async () => undefined
const AuthContext = createContext<Auth>({
  user: null,
  canEdit: false,
  loading: false,
  login: noop,
  logout: noop,
  openLogin: () => undefined,
  sessionEnded: false,
  authNotice: null,
  dismissAuthNotice: () => undefined,
  selfPasswordChanged: () => undefined,
})

export function useAuth(): Auth {
  return useContext(AuthContext)
}

const WRITE_METHODS = ['post', 'put', 'patch', 'delete']

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [loginOpen, setLoginOpen] = useState(false)
  const [sessionEnded, setSessionEnded] = useState(false)
  const [authNotice, setAuthNotice] = useState<Auth['authNotice']>(null)
  const userRef = useRef<AuthUser | null>(null)

  // GET /api/me always answers 200 (REQ_AUTH_016); anything else is treated as anonymous.
  useEffect(() => {
    let cancelled = false
    void Promise.resolve(resources.fetchMe())
      .then((u) => {
        if (!cancelled) {
          userRef.current = u ?? null
          setUser(u ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // REQ_AUTH_007: the user stays "logged in" in the UI (forms stay populated, nothing unmounts); the banner
  // invites them to log in again. Nothing is resent: the field that was refused says it was not saved and the
  // user saves again. A 401 that arrives while nobody is logged in, or on a read, is not a session ending.
  useEffect(() => {
    setSessionEndedHandler((cfg) => {
      if (!userRef.current) return
      if (!WRITE_METHODS.includes((cfg.method ?? 'get').toLowerCase())) return
      setSessionEnded(true)
    })
    return () => setSessionEndedHandler(null)
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const u = await resources.login(username, password)
    userRef.current = u
    setUser(u)
    setLoginOpen(false)
    setAuthNotice(null)
    setSessionEnded(false)
  }, [])

  const endSessionNotice = useCallback(() => {
    setSessionEnded(false)
  }, [])

  const logout = useCallback(async () => {
    try {
      await resources.logout()
    } catch (err) {
      // A 401 means the session is already gone — that is a successful logout. Anything else: the server
      // session may still be alive, so keep the user logged in and say so (it would return on reload).
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status !== 401) {
        console.error('auth.logout_failed', { status })
        setAuthNotice({ kind: 'error', text: 'Could not log out — try again' })
        return
      }
    }
    userRef.current = null
    setUser(null)
    endSessionNotice()
    setAuthNotice(null)
  }, [endSessionNotice])

  const dismissAuthNotice = useCallback(() => setAuthNotice(null), [])

  const selfPasswordChanged = useCallback(() => {
    userRef.current = null
    setUser(null)
    endSessionNotice()
    setAuthNotice({ kind: 'info', text: 'Password changed — log in again' })
    setLoginOpen(true)
  }, [endSessionNotice])

  const openLogin = useCallback(() => {
    setLoginOpen(true)
  }, [])

  const value = useMemo<Auth>(
    () => ({
      user,
      canEdit: user != null,
      loading,
      login,
      logout,
      openLogin,
      sessionEnded,
      authNotice,
      dismissAuthNotice,
      selfPasswordChanged,
    }),
    [user, loading, login, logout, openLogin, sessionEnded, authNotice, dismissAuthNotice, selfPasswordChanged],
  )

  return (
    <AuthContext.Provider value={value}>
      <CanEditProvider value={value.canEdit}>
        {children}
        {loginOpen && <LoginDialog login={login} onClose={() => setLoginOpen(false)} />}
      </CanEditProvider>
    </AuthContext.Provider>
  )
}
