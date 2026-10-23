import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import axios from 'axios'
import { BTN, BTN_PRIMARY, INPUT } from '../lib/ui'
import { Dialog } from './Dialog'

// REQ_AUTH_005: a dialog over the current page, never a route — wireframes/login-modal.html. The
// password lives only in this input's state and is sent once; it is never logged or stored.
function loginError(err: unknown): string {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined
  if (status === 401) return 'Wrong username or password.'
  if (status === 429) return 'Too many failed attempts. Logging in is locked for 15 minutes — try again later.'
  return 'Could not log in. Please try again.'
}

export function LoginDialog({
  login,
  onClose,
}: {
  login: (username: string, password: string) => Promise<void>
  onClose: () => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await login(username.trim(), password)
    } catch (err) {
      console.error('auth.login_failed', { status: axios.isAxiosError(err) ? err.response?.status : undefined })
      setError(loginError(err))
      setPassword('')
      setBusy(false)
    }
  }

  return (
    <Dialog label="Log in" onClose={onClose} overlayClassName="items-center z-[70]" className="w-[420px] p-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold text-lg">Log in to edit</h2>
        <button type="button" className="btn icon ghost sm" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <p className="text-sm text-text-2 mb-3">
        Reading needs no account. You stay signed in on this browser until you log out or clear cookies.
      </p>
      <form onSubmit={submit}>
        <div className="field mb-2">
          <label htmlFor="login-username" className="text-xs font-medium text-text-2">
            Username
          </label>
          <input
            id="login-username"
            autoFocus
            autoComplete="username"
            className={`${INPUT} w-full`}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="login-password" className="text-xs font-medium text-text-2">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            className={`${INPUT} w-full`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <div className="hint bad text-danger text-xs mt-2" role="alert" data-testid="login-error">
            {error}
          </div>
        )}
        <div className="form-foot flex items-center justify-end gap-2 mt-3">
          <span className="flex-1 text-xs text-text-3">You stay on this page.</span>
          <button type="button" className={BTN} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={BTN_PRIMARY} disabled={busy} data-testid="login-submit">
            Log in
          </button>
        </div>
      </form>
    </Dialog>
  )
}
