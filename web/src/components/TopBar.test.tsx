import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AuthProvider } from '../lib/auth'
import { TopBar } from './AppChrome'
import { TeamListPage } from '../pages/TeamListPage'
import * as prefs from '../lib/prefs'
import * as resources from '../api/resources'
import { barOrder, ALL_BAR_CONTROLS, T } from '../test/barOrder'
import { step } from '../testSteps'

vi.mock('../api/resources')

// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function fresh() {
  cleanup()
  vi.resetAllMocks()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.mocked(resources.fetchMe).mockResolvedValue(null)
  vi.mocked(resources.fetchTeamOrder).mockResolvedValue([])
}
beforeEach(fresh)

describe('REQ_FE_104 the theme toggle', () => {
  it('REQ_FE_104 toggling switches data-theme on <html> between light and dark and saves the choice; a stored theme is applied when the app loads and shown by the toggle; with nothing stored the app loads light', async () => {
    await step('toggling switches data-theme on <html> between light and dark and saves the choice', async () => {
      render(<TopBar />)
      const toggle = screen.getByTestId('theme-toggle')
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')

      fireEvent.click(toggle)
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
      expect(prefs.getTheme()).toBe('dark')

      fireEvent.click(toggle)
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
      expect(prefs.getTheme()).toBe('light')
    })

    await step('a stored theme is applied when the app loads, and the toggle starts from it', () => {
      fresh()
      prefs.setTheme('dark')
      expect(prefs.initTheme()).toBe('dark')
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })

    await step('the toggle shows the stored theme even before initTheme ran (a stored dark theme survives a fresh mount)', () => {
      fresh()
      prefs.setTheme('dark')
      render(<TopBar />)
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })

    await step('with nothing stored the app loads light', () => {
      fresh()
      expect(prefs.initTheme()).toBe('light')
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })
  })
})

describe('REQ_FE_103 the minimal top bar (team list, admin)', () => {
  it('REQ_FE_103 holds, left to right: a static logo, the two mode buttons, space, theme toggle, account; no product name text ("Overlens", REQ_OVR_014)', async () => {
    render(
      <AuthProvider>
        <TeamListPage />
      </AuthProvider>,
    )
    await screen.findByTestId('login-button')
    expect(barOrder(ALL_BAR_CONTROLS)).toEqual([T('logo'), T('see-combined-roadmaps'), T('see-team-roadmaps'), '.spacer', T('theme-toggle'), T('login-button')])
    expect(screen.getByTestId('logo').tagName).not.toBe('A') // the icon is not clickable
    expect(screen.getByTestId('logo').closest('a')).toBeNull()
    expect(screen.queryByTestId('app-name')).toBeNull()
    expect(screen.getByTestId('topbar')).not.toHaveTextContent('Overlens')
    // no Teams / Company links, no second toolbar
    expect(screen.queryByTestId('main-nav')).not.toBeInTheDocument()
    expect(screen.queryByTestId('toolbar')).not.toBeInTheDocument()
  })
})

describe('REQ_FE_123 the two mode buttons', () => {
  it('REQ_FE_123 both are always shown, labelled "See workstreams (all teams)" (#/) and "Teams roadmaps" (#/teams), with short forms; the one for the current page is highlighted', () => {
    render(<TopBar variant="team" teamName="Onboarding" />)
    const c = screen.getByTestId('see-combined-roadmaps')
    const t = screen.getByTestId('see-team-roadmaps')
    expect(c).toHaveAttribute('href', '#/')
    expect(c).toHaveTextContent('See workstreams (all teams)')
    expect(c).toHaveTextContent('All roadmaps')
    expect(t).toHaveAttribute('href', '#/teams')
    expect(t).toHaveTextContent('Teams roadmaps')
    expect(t).toHaveTextContent('Team roadmaps')
    expect(t).toHaveAttribute('aria-current', 'page')
    expect(c).not.toHaveAttribute('aria-current')
  })

  it('REQ_FE_123 on the company bar the combined button is the highlighted one', () => {
    render(<TopBar variant="company" />)
    expect(screen.getByTestId('see-combined-roadmaps')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('see-team-roadmaps')).not.toHaveAttribute('aria-current')
  })
})

describe('REQ_AUTH_005/006 the account control', () => {
  it('REQ_AUTH_005 anonymous: a ghost button "Admin login" opens the login dialog', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
    render(
      <AuthProvider>
        <TopBar />
      </AuthProvider>,
    )
    const btn = await screen.findByTestId('login-button')
    expect(btn).toHaveTextContent('Admin login')
    expect(btn.className).toMatch(/\bghost\b/)
    expect(screen.queryByTestId('account-menu')).not.toBeInTheDocument()
    fireEvent.click(btn)
    expect(screen.getByRole('dialog', { name: 'Log in' })).toBeInTheDocument()
  })

  it('REQ_AUTH_005 REQ_FE_084 the login button always reads the full text, with no short form at narrow widths', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
    render(
      <AuthProvider>
        <TopBar />
      </AuthProvider>,
    )
    const btn = await screen.findByTestId('login-button')
    expect(btn).toHaveTextContent(/^Admin login$/)
    expect(btn.querySelectorAll('span')).toHaveLength(0)
    expect(btn).toHaveAccessibleName('Admin login')
  })
})
