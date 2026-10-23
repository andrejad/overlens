import { useEffect, useState } from 'react'
import { createUser, fetchUsers, patchUser } from '../../api/resources'
import type { User } from '../../api/types'
import { useAuth } from '../../lib/auth'
import { apiError, sessionRefusal } from '../../lib/apiError'
import { BTN, BTN_PRIMARY, INPUT } from '../../lib/ui'

// REQ_AUTH_013-015: admins create admins, reset passwords, disable/enable. No delete exists.
function userError(err: unknown, what: 'create' | 'reset' | 'patch'): string {
  const refused = sessionRefusal(err)
  if (refused) return refused
  const e = apiError(err)
  if (e.code === 'last_admin') return "The last active admin can't be disabled."
  if (e.code === 'self_disable') return "You can't disable your own account."
  if (e.code === 'duplicate_name') return 'That username is already taken.'
  if (e.status === 422 && e.fields?.password) return 'The password must be 8 to 128 characters.'
  if (e.status === 422 && e.fields?.username) return 'The username must be 1 to 64 characters with no control characters.'
  return what === 'create' ? 'Could not create the admin.' : what === 'reset' ? 'Could not reset the password.' : 'Could not update the user.'
}

export function UsersCard() {
  const { user: me, selfPasswordChanged } = useAuth()
  const [users, setUsers] = useState<User[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [createError, setCreateError] = useState('')
  const [resetId, setResetId] = useState<number | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetchUsers()
      .then((u) => !cancelled && setUsers(u))
      .catch(() => !cancelled && setLoadError('Could not load the users.'))
    return () => {
      cancelled = true
    }
  }, [])

  function replace(u: User) {
    setUsers((list) => (list ?? []).map((x) => (x.id === u.id ? u : x)))
  }

  async function create() {
    setCreateError('')
    try {
      const u = await createUser(newName.trim(), newPassword)
      setUsers((list) => [...(list ?? []), u])
      setNewName('')
      setNewPassword('')
      setAdding(false)
      setNotice(`Added ${u.username}.`)
    } catch (err) {
      setNewPassword('')
      setCreateError(userError(err, 'create'))
    }
  }

  async function reset(u: User) {
    setRowError(null)
    try {
      await patchUser(u.id, { password: resetPassword })
      setResetId(null)
      setResetPassword('')
      setNotice(`Password reset for ${u.username}.`)
      // REQ_AUTH_010: resetting your own password deleted your sessions — treat ours as over.
      if (me?.id === u.id) selfPasswordChanged()
    } catch (err) {
      setResetPassword('')
      setRowError({ id: u.id, message: userError(err, 'reset') })
    }
  }

  async function setDisabled(u: User, disabled: boolean) {
    setRowError(null)
    try {
      replace(await patchUser(u.id, { disabled }))
    } catch (err) {
      setRowError({ id: u.id, message: userError(err, 'patch') })
    }
  }

  return (
    <section className="bg-surface border border-border rounded-lg p-4" id="admin-users" aria-labelledby="admin-users-h">
      <div className="flex items-center gap-3 mb-1">
        <h2 id="admin-users-h" className="font-semibold text-lg flex-1">
          Users
        </h2>
        <button type="button" className={BTN} onClick={() => {
            setAdding((a) => !a)
            setNewName('')
            setNewPassword('')
            setCreateError('')
          }}>
          Add admin
        </button>
      </div>
      <p className="text-sm text-text-2 mb-3">
        Admins can read and edit everything. Everyone else reads anonymously — no account needed.
      </p>
      {adding && (
        <div className="flex items-end gap-2 flex-wrap mb-3" role="group" aria-label="New admin">
          <label className="text-xs text-text-2 flex flex-col gap-1">
            New username
            <input className={`${INPUT} w-auto`} value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" />
          </label>
          <label className="text-xs text-text-2 flex flex-col gap-1">
            New password
            <input
              className={`${INPUT} w-auto`}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <button type="button" className={BTN_PRIMARY} onClick={() => void create()}>
            Create admin
          </button>
          {createError && (
            <span className="text-danger text-xs" role="alert">
              {createError}
            </span>
          )}
        </div>
      )}
      {notice && (
        <p className="text-ok text-xs mb-2" role="status">
          {notice}
        </p>
      )}
      {loadError && (
        <p className="text-danger text-sm" role="alert">
          {loadError}
        </p>
      )}
      {users === null && !loadError && <p className="text-text-2 text-sm">Loading…</p>}
      {users && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-2 text-xs">
              <th className="py-1">Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-border align-top" data-testid={`user-row-${u.username}`}>
                <td className="py-1.5">{u.username}</td>
                <td>{u.role}</td>
                <td>{u.disabled ? 'disabled' : 'active'}</td>
                <td>{u.created_at.slice(0, 10)}</td>
                <td className="text-right">
                  {resetId === u.id ? (
                    <span className="inline-flex items-center gap-2">
                      <input
                        className={`${INPUT} w-auto`}
                        type="password"
                        aria-label={`New password for ${u.username}`}
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                      <button type="button" className={BTN_PRIMARY} onClick={() => void reset(u)}>
                        Set password
                      </button>
                      <button
                        type="button"
                        className={BTN}
                        onClick={() => {
                          setResetId(null)
                          setResetPassword('')
                          setRowError(null)
                        }}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="inline-flex gap-2">
                      <button
                        type="button"
                        className={BTN}
                        onClick={() => {
                          setResetId(u.id)
                          setResetPassword('')
                          setRowError(null)
                        }}
                      >
                        Reset password
                      </button>
                      <button type="button" className={BTN} onClick={() => void setDisabled(u, !u.disabled)}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </span>
                  )}
                  {resetId === u.id && me?.id === u.id && (
                    <div className="text-text-2 text-xs mt-1" role="note" data-testid="self-reset-warning">
                      This is your own account: changing the password ends your session and you will need to log in again.
                    </div>
                  )}
                  {rowError?.id === u.id && (
                    <div className="text-danger text-xs mt-1" role="alert">
                      {rowError.message}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
