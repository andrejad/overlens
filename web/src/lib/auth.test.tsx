import { useEffect, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { api } from '../api/client'
import * as resources from '../api/resources'
import { AuthProvider, useAuth } from './auth'
import { useCanEdit } from './canEdit'
import { AccountControl, SessionBanner, TopBar } from '../components/AppChrome'
import { step } from '../testSteps'
import { RoadmapTitle } from '../components/RoadmapTitle'
import type { Roadmap } from '../api/types'

vi.mock('../api/resources')

const admin = { id: 1, username: 'andreja', role: 'admin' }

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: {} } })
}

// A stand-in for "the current page": counts its own mounts, holds typed text and a zoom-like value,
// and exposes what auth says. Logging in must never remount it or lose any of that (REQ_AUTH_005).
let mounts = 0
function Page() {
  const { user, canEdit, loading } = useAuth()
  const [text, setText] = useState('')
  const [scroll] = useState(() => 'zoom=quarter')
  useEffect(() => {
    mounts++
  }, [])
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : user ? `user:${user.username}` : 'anonymous'}</span>
      <span data-testid="can">{String(canEdit)}</span>
      <span data-testid="hook">{String(useCanEdit())}</span>
      <span data-testid="zoom">{scroll}</span>
      <input aria-label="draft" value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  )
}

function shell() {
  return render(
    <AuthProvider>
      <AccountControl />
      <SessionBanner />
      <Page />
    </AuthProvider>,
  )
}

describe('REQ_AUTH_016 / REQ_FE_083 auth provider', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mounts = 0
  })

  it('REQ_AUTH_016 REQ_FE_083 an anonymous visitor (me.user = null) gets canEdit=false, and the CanEditProvider API follows', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
    shell()
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous'))
    expect(screen.getByTestId('can')).toHaveTextContent('false')
    expect(screen.getByTestId('hook')).toHaveTextContent('false')
    expect(screen.getByTestId('login-button')).toBeInTheDocument()
  })

  it('REQ_FE_083 nobody can edit while /api/me is still loading, and a failing probe means anonymous', async () => {
    vi.mocked(resources.fetchMe).mockRejectedValue(httpError(500))
    shell()
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    expect(screen.getByTestId('can')).toHaveTextContent('false')
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous'))
  })
})

describe('REQ_AUTH_005 login dialog', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mounts = 0
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
  })

  async function openDialog() {
    shell()
    fireEvent.click(await screen.findByTestId('login-button'))
    return screen.getByRole('dialog', { name: 'Log in' })
  }

  it('REQ_AUTH_005 success closes the dialog and the same page becomes editable — no remount, draft and zoom kept', async () => {
    vi.mocked(resources.login).mockResolvedValue(admin)
    shell()
    await screen.findByTestId('login-button')
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'half-typed' } })
    expect(mounts).toBe(1)
    fireEvent.click(screen.getByTestId('login-button'))

    const dialog = screen.getByRole('dialog', { name: 'Log in' })
    expect(dialog).toHaveTextContent('Reading needs no account')
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'andreja' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-secret-1' } })
    fireEvent.click(screen.getByTestId('login-submit'))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(resources.login).toHaveBeenCalledWith('andreja', 'pw-secret-1')
    expect(screen.getByTestId('can')).toHaveTextContent('true')
    expect(screen.getByTestId('state')).toHaveTextContent('user:andreja')
    expect(mounts).toBe(1) // never remounted
    expect(screen.getByLabelText('draft')).toHaveValue('half-typed')
    expect(screen.getByTestId('zoom')).toHaveTextContent('zoom=quarter')
    expect(window.localStorage.length).toBe(0) // nothing, certainly no credentials, in storage
  })

  it('REQ_AUTH_017 bad credentials show an inline error, keep the dialog open and clear the password', async () => {
    vi.mocked(resources.login).mockRejectedValue(httpError(401))
    await openDialog()
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'andreja' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Wrong username or password')
    expect(screen.getByRole('dialog', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByTestId('can')).toHaveTextContent('false')
  })

  it('REQ_AUTH_011 a lockout (429) shows a clear locked-out message', async () => {
    vi.mocked(resources.login).mockRejectedValue(httpError(429))
    await openDialog()
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'andreja' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('login-error')).toHaveTextContent(/locked/i)
    expect(screen.getByTestId('login-error')).toHaveTextContent('15 minutes')
  })
})

describe('REQ_AUTH_006 account menu', () => {
  const fresh6 = () => {
    cleanup()
    vi.resetAllMocks()
    mounts = 0
    window.location.hash = '#/'
  }

  beforeEach(fresh6)

  it('REQ_AUTH_006 logged in: an account menu offers Admin (to #/admin) and Log out; the top bar chip shows the initials, name and role; anonymous: no account menu, just the Log in button', async () => {
    await step('logged in: an account menu offers Admin and Log out', async () => {
      vi.mocked(resources.fetchMe).mockResolvedValue(admin)
      vi.mocked(resources.logout).mockResolvedValue(undefined)
      shell()
      fireEvent.click(await screen.findByTestId('account-menu'))
      expect(screen.getByRole('menuitem', { name: 'Admin' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('menuitem', { name: 'Admin' }))
      expect(window.location.hash).toBe('#/admin')

      fireEvent.click(screen.getByTestId('account-menu'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }))
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous'))
      expect(resources.logout).toHaveBeenCalled()
      expect(screen.getByTestId('can')).toHaveTextContent('false')
      expect(screen.getByTestId('login-button')).toBeInTheDocument()
      expect(mounts).toBe(1)
    })
    fresh6()
    await step('the top bar chip shows the initials, the name and the role; the menu offers Admin and Log out', async () => {
      vi.mocked(resources.fetchMe).mockResolvedValue({ id: 1, username: 'jane.doe', role: 'admin' })
      render(
        <AuthProvider>
          <TopBar />
        </AuthProvider>,
      )
      const chip = await screen.findByTestId('account-menu')
      expect(chip).toHaveTextContent('JD')
      expect(chip).toHaveTextContent('jane.doe')
      expect(chip).toHaveAttribute('title', 'Signed in as jane.doe (admin) — account menu')
      expect(screen.queryByTestId('login-button')).not.toBeInTheDocument()
      fireEvent.click(chip)
      expect(screen.getByRole('menuitem', { name: 'Admin' })).toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument()
    })
    fresh6()
    await step('anonymous: no account menu, just the Log in button', async () => {
      vi.mocked(resources.fetchMe).mockResolvedValue(null)
      shell()
      await screen.findByTestId('login-button')
      expect(screen.queryByTestId('account-menu')).not.toBeInTheDocument()
    })
  })

  it('REQ_AUTH_006 the account menu closes on Escape (focus back on the chip) and on a click outside it; the chip\'s accessible name contains the visible user name', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue(admin)
    shell()
    const chip = await screen.findByTestId('account-menu')
    expect(chip).toHaveAccessibleName('Signed in as andreja — account menu')
    fireEvent.click(chip)
    screen.getByRole('menuitem', { name: 'Admin' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(chip).toHaveFocus()
    fireEvent.click(chip)
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Log out' })) // inside: stays open
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByLabelText('draft')) // outside: closes
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('REQ_AUTH_007 session ended (401) banner', () => {
  const fresh7 = () => {
    cleanup()
    vi.resetAllMocks()
    mounts = 0
    vi.mocked(resources.fetchMe).mockResolvedValue(admin)
  }

  beforeEach(fresh7)

  // A write through the real `api` instance (interceptors included) whose first attempt is a 401.
  function failingSave(okAfter = true) {
    let calls = 0
    return {
      calls: () => calls,
      run: () =>
        api
          .patch(
            '/deliverables/1',
            { name: 'typed text' },
            {
              adapter: async (config: InternalAxiosRequestConfig) => {
                calls++
                if (calls === 1 || !okAfter) {
                  throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, {
                    status: 401,
                    statusText: 'Unauthorized',
                    headers: {},
                    config,
                    data: { error: { code: 'unauthorized' } },
                  })
                }
                return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
              },
            },
          )
          .catch(() => undefined),
    }
  }

  it('REQ_AUTH_007 a 401 on a write shows the banner, keeps the form state and the edit controls; its button reopens the login dialog; after logging in again the login call and the /me probe returning 401 do not raise the banner', async () => {
    await step('a 401 on a write shows the banner and keeps the form state', async () => {
      shell()
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:andreja'))
      fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'my unsaved edit' } })

      await failingSave().run()

      const banner = await screen.findByTestId('session-banner')
      expect(banner).toHaveTextContent('Your session ended — log in to save')
      expect(screen.getByLabelText('draft')).toHaveValue('my unsaved edit')
      expect(screen.getByTestId('can')).toHaveTextContent('true') // nothing unmounted under the user
      expect(mounts).toBe(1)

      fireEvent.click(banner.querySelector('button') as HTMLButtonElement)
      expect(screen.getByRole('dialog', { name: 'Log in' })).toBeInTheDocument()
      expect(screen.getByLabelText('draft')).toHaveValue('my unsaved edit')
    })
    fresh7()
    await step('a rejected read, and a 401 write while anonymous, raise no banner', async () => {
      shell()
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:andreja'))
      await api
        .get('/deliverables/1', {
          adapter: async (config: InternalAxiosRequestConfig) => {
            throw new AxiosError('x', 'ERR_BAD_REQUEST', config, null, { status: 401, statusText: '', headers: {}, config, data: {} })
          },
        })
        .catch(() => undefined)
      expect(screen.queryByTestId('session-banner')).not.toBeInTheDocument()
      fresh7()
      vi.mocked(resources.fetchMe).mockResolvedValue(null)
      shell()
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous'))
      await failingSave().run()
      expect(screen.queryByTestId('session-banner')).not.toBeInTheDocument()
    })
    fresh7()
    await step('the login call and the /me probe returning 401 do not raise the banner', async () => {
      shell()
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:andreja'))
      for (const url of ['/login', '/me', '/logout']) {
        await api
          .request({
            url,
            method: 'post',
            adapter: async (config) => {
              throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, {
                status: 401,
                statusText: 'Unauthorized',
                headers: {},
                config,
                data: {},
              })
            },
          })
          .catch(() => undefined)
      }
      expect(screen.queryByTestId('session-banner')).not.toBeInTheDocument()
    })
  })
})

describe('REQ_AUTH_007 a refused field save', () => {
  const roadmap = { id: 7, title: 'Plan' } as Roadmap

  it('REQ_AUTH_007 a 401 on a field save shows the banner, keeps the typed value, says "Not saved — log in and save again", and logging in again resends nothing', async () => {
    cleanup()
    vi.resetAllMocks()
    vi.mocked(resources.fetchMe).mockResolvedValue(admin)
    vi.mocked(resources.login).mockResolvedValue(admin)
    let calls = 0
    vi.mocked(resources.renameRoadmap).mockImplementation(() => {
      calls++
      return api.patch('/roadmaps/7', { title: 'x' }, {
        adapter: async (config: InternalAxiosRequestConfig) => {
          throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, { status: 401, statusText: '', headers: {}, config, data: { error: { code: 'unauthorized' } } })
        },
      })
    })
    render(
      <AuthProvider>
        <SessionBanner />
        <RoadmapTitle roadmap={roadmap} onRenamed={() => undefined} />
      </AuthProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Click to rename the roadmap' }))
    const input = screen.getByLabelText('Roadmap title')
    fireEvent.change(input, { target: { value: 'Typed title' } })
    fireEvent.blur(input)

    const banner = await screen.findByTestId('session-banner')
    expect(banner).toHaveTextContent('Your session ended — log in to save')
    expect(screen.getByTestId('title-unsaved')).toHaveTextContent('Not saved — log in and save again')
    expect(screen.getByRole('button', { name: 'Click to rename the roadmap' })).toHaveTextContent('Typed title')

    fireEvent.click(banner.querySelector('button') as HTMLButtonElement)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'andreja' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-secret-1' } })
    fireEvent.click(screen.getByTestId('login-submit'))
    await waitFor(() => expect(screen.queryByTestId('session-banner')).not.toBeInTheDocument())
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(1) // nothing was resent
    expect(screen.getByRole('button', { name: 'Click to rename the roadmap' })).toHaveTextContent('Typed title')
  })
})

describe('REQ_AUTH_010 logout outcomes', () => {
  const fresh10 = () => {
    cleanup()
    vi.resetAllMocks()
    mounts = 0
    vi.mocked(resources.fetchMe).mockResolvedValue(admin)
  }

  beforeEach(fresh10)

  async function clickLogout() {
    fireEvent.click(await screen.findByTestId('account-menu'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }))
  }

  it('REQ_AUTH_010 a failed logout keeps the user logged in and says so (a network error too); a 401 from logout counts as success (the session is already gone)', async () => {
    await step('a failed logout keeps the user logged in and says so', async () => {
      vi.mocked(resources.logout).mockRejectedValue(httpError(500))
      shell()
      await clickLogout()
      expect(await screen.findByTestId('auth-notice')).toHaveTextContent('Could not log out — try again')
      expect(screen.getByTestId('state')).toHaveTextContent('user:andreja')
      expect(screen.getByTestId('can')).toHaveTextContent('true')
    })
    fresh10()
    await step('a network error on logout also keeps the user logged in', async () => {
      vi.mocked(resources.logout).mockRejectedValue(new Error('Network Error'))
      shell()
      await clickLogout()
      expect(await screen.findByTestId('auth-notice')).toHaveTextContent('Could not log out')
      expect(screen.getByTestId('can')).toHaveTextContent('true')
    })
    fresh10()
    await step('a 401 from logout counts as success', async () => {
      vi.mocked(resources.logout).mockRejectedValue(httpError(401))
      shell()
      await clickLogout()
      await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('anonymous'))
      expect(screen.queryByTestId('auth-notice')).not.toBeInTheDocument()
    })
  })
})

describe('REQ_AUTH_005 password hygiene', () => {
  it('REQ_AUTH_005 closing the login dialog leaves no password in the DOM, and reopening starts empty', async () => {
    vi.resetAllMocks()
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
    shell()
    fireEvent.click(await screen.findByTestId('login-button'))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.body.innerHTML).not.toContain('hunter2-secret')
    fireEvent.click(screen.getByTestId('login-button'))
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })
})
