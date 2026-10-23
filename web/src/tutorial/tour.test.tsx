import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { BarVariant } from '../components/AppChrome'
import { TopBar } from '../components/AppChrome'
import { runTour as run } from './runTour'
import { TourProvider } from './TourProvider'
import type { TourStep } from './steps'

// driver.js draws on a real layout; here it is a recorder of what the tour asks it to show.
type Popover = { title: string; progressText: string; nextBtnText: string; onNextClick: () => void; onCloseClick: () => void }
const h = vi.hoisted(() => ({ cfg: null as null | { onDestroyStarted: () => void }, highlight: vi.fn(), destroy: vi.fn() }))
vi.mock('driver.js', () => ({
  driver: (cfg: { onDestroyStarted: () => void }) => {
    h.cfg = cfg
    return { highlight: h.highlight, destroy: h.destroy }
  },
}))
vi.mock('../api/resources', () => ({ fetchTeamOrder: vi.fn(async () => [{ id: 7 }]) }))
const auth = vi.hoisted(() => ({ value: { user: null as null | { username: string; role: string }, canEdit: false, loading: false, openLogin: () => {}, logout: async () => {} } }))
vi.mock('../lib/auth', () => ({ useAuth: () => auth.value }))
// the provider's own steps are replaced by two present targets; the real list is checked in the REQ_FE_131 test
vi.mock('./steps', async (orig) => ({ ...(await orig<typeof import('./steps')>()), stepsFor: () => [step('a'), step('b')] }))

const running: { abort: () => void }[] = []
const runTour: typeof run = (...args) => {
  const r = run(...args)
  running.push(r)
  return r
}
const step = (id: string, extra: Partial<TourStep> = {}): TourStep => ({ id, target: `#${id}`, title: `Title ${id}`, body: 'body', ...extra })
const page = (...ids: string[]) => {
  document.body.innerHTML = ids.map((i) => `<div id="${i}"></div>`).join('')
}
const lastPopover = () => (h.highlight.mock.calls.at(-1)![0] as { popover: Popover }).popover

beforeEach(() => {
  h.highlight.mockClear()
  h.destroy.mockClear()
  window.localStorage.removeItem('erm.tutorialSeen')
  window.location.hash = '#/'
  auth.value = { ...auth.value, user: null, canEdit: false, loading: false }
  page('a', 'b')
})
afterEach(() => {
  running.splice(0).forEach((r) => r.abort()) // a tour left running would follow the next test's page
  document.body.innerHTML = ''
})

describe('guided tour', () => {
  it.each<BarVariant>(['minimal', 'team', 'company'])('REQ_FE_129 the Help button is in the %s top bar, logged out and logged in', (variant) => {
    for (const user of [null, { username: 'jane', role: 'admin' }]) {
      auth.value = { ...auth.value, user, canEdit: !!user }
      const { unmount } = render(<TopBar variant={variant} teamName="T" />)
      expect(screen.getByTestId('help-tour')).toHaveAccessibleName('Take the tour')
      unmount()
    }
  })

  it('REQ_FE_129 the Help button starts the tour from its first step even when it was seen before', async () => {
    window.localStorage.setItem('erm.tutorialSeen', 'true')
    render(
      <TourProvider>
        <TopBar />
      </TourProvider>,
    )
    expect(h.highlight).not.toHaveBeenCalled()
    act(() => screen.getByTestId('help-tour').click())
    await waitFor(() => expect(h.highlight).toHaveBeenCalled())
    expect(lastPopover().title).toBe('Title a')
    expect(lastPopover().progressText).toBe('1 of 2')
  })

  it('REQ_FE_130 opens by itself once the login state is known, only while the flag is unset', async () => {
    auth.value = { ...auth.value, loading: true }
    const { rerender } = render(<TourProvider>x</TourProvider>)
    expect(h.highlight).not.toHaveBeenCalled()
    auth.value = { ...auth.value, loading: false }
    rerender(<TourProvider>x</TourProvider>)
    await waitFor(() => expect(h.highlight).toHaveBeenCalledTimes(1))
  })

  it('REQ_FE_130 does not open by itself when the tour was seen', () => {
    window.localStorage.setItem('erm.tutorialSeen', 'true')
    render(<TourProvider>x</TourProvider>)
    expect(h.highlight).not.toHaveBeenCalled()
  })

  it('REQ_FE_130 Esc and Skip both mark the tour as seen', async () => {
    const { unmount } = render(<TourProvider>x</TourProvider>)
    await waitFor(() => expect(h.highlight).toHaveBeenCalled())
    act(() => h.cfg!.onDestroyStarted()) // Esc
    expect(window.localStorage.getItem('erm.tutorialSeen')).toBe('true')
    unmount()

    window.localStorage.removeItem('erm.tutorialSeen')
    h.highlight.mockClear()
    render(<TourProvider>x</TourProvider>)
    await waitFor(() => expect(h.highlight).toHaveBeenCalled())
    act(() => lastPopover().onCloseClick()) // Skip
    expect(window.localStorage.getItem('erm.tutorialSeen')).toBe('true')
  })

  it('REQ_FE_131 editing and admin steps are for logged-in people, the Log in step for everyone else', async () => {
    const { stepsFor } = await vi.importActual<typeof import('./steps')>('./steps')
    const anon = stepsFor(false).map((s) => s.id)
    const editor = stepsFor(true).map((s) => s.id)
    expect(anon).toContain('login')
    expect(anon.at(-1)).toBe('login')
    expect(anon).not.toContain('add-deliverable')
    expect(anon.some((id) => id.startsWith('admin-'))).toBe(false)
    expect(editor).not.toContain('login')
    for (const id of ['add-deliverable', 'add-milestone', 'add-workstream', 'drag', 'dots', 'full-edit', 'delete', 'account', 'admin-users', 'admin-teams', 'admin-icons', 'admin-audit']) {
      expect(editor).toContain(id)
    }
  })

  it('REQ_FE_134 REQ_FE_132 ending the tour while a step is still waiting for the team list leaves the start page in place: the late step opens nothing', async () => {
    window.location.hash = '#/teams'
    let resolveTeam!: (id: number) => void
    runTour([step('a', { route: 'team' })], () => new Promise<number | null>((r) => (resolveTeam = r)))
    act(() => h.cfg!.onDestroyStarted()) // Esc while the step is being prepared
    resolveTeam(5)
    await new Promise((r) => setTimeout(r, 300))
    expect(window.location.hash).toBe('#/teams')
    expect(h.highlight).not.toHaveBeenCalled()
  })

  it('REQ_FE_133 a step whose element is missing is skipped silently and the total goes down by one when the tour reaches it', async () => {
    page('a', 'c')
    runTour([step('a'), step('b'), step('c')], async () => null)
    await waitFor(() => expect(h.highlight).toHaveBeenCalledTimes(1))
    expect(lastPopover().progressText).toBe('1 of 3')
    act(() => lastPopover().onNextClick())
    await waitFor(() => expect(h.highlight).toHaveBeenCalledTimes(2), { timeout: 4000 })
    expect(lastPopover().title).toBe('Title c')
    expect(lastPopover().progressText).toBe('2 of 2')
    expect(lastPopover().nextBtnText).toBe('Done')
  }, 8000)

  it('REQ_FE_134 ending the tour returns to the page it started on', async () => {
    window.location.hash = '#/teams'
    page('a')
    runTour([step('a', { route: 'company' })], async () => null)
    await waitFor(() => expect(window.location.hash).toBe('#/')) // the tour opened another page itself
    await waitFor(() => expect(h.highlight).toHaveBeenCalled())
    act(() => h.cfg!.onDestroyStarted())
    expect(window.location.hash).toBe('#/teams')
    expect(h.destroy).toHaveBeenCalled()
  })
})
