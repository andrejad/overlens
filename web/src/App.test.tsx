import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import * as resources from './api/resources'
import { companyFixture } from './lib/companyFixtures'
import { step } from './testSteps'

vi.mock('./api/resources')
vi.mock('./pages/CompanyPage', () => ({
  CompanyPage: (p: { mode: string; traceId?: number }) => <div data-testid="company-stub">{`${p.mode}:${p.traceId ?? ''}`}</div>,
}))
vi.mock('./pages/ManageWorkstreamsPage', () => ({ ManageWorkstreamsPage: (p: { teamId: number }) => <div data-testid="workstreams-stub">{p.teamId}</div> }))
vi.mock('./pages/TeamRoadmapPage', () => ({ TeamRoadmapPage: (p: { teamId: number }) => <div data-testid="team-stub">{p.teamId}</div> }))

async function go(hash: string) {
  await act(async () => {
    window.location.hash = hash
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resources.fetchMe).mockResolvedValue(null)
  // the saved team order: Platform, Security, Onboarding (not alphabetical)
  const [onb, plt, sec] = companyFixture().map((i) => i.team)
  vi.mocked(resources.fetchTeamOrder).mockResolvedValue([plt, sec, onb].map(({ id, name, tag }) => ({ id, name, tag })))
  window.location.hash = '#/'
  window.localStorage.setItem('erm.tutorialSeen', 'true') // REQ_FE_130: the tour would open by itself on a first visit
})

describe('REQ_FE_091/098 routes', () => {
  it('REQ_FE_091 the top bar leads to the company views with "See all combined roadmaps", for anonymous visitors too; there is no Teams / Company link', async () => {
    render(<App />)
    expect(await screen.findByTestId('company-stub')).toHaveTextContent('workstreams:') // REQ_FE_091: the default page is the company view
    cleanup()
    window.location.hash = '#/teams'
    render(<App />)
    expect(await screen.findByTestId('see-combined-roadmaps')).toHaveAttribute('href', '#/')
    expect(screen.queryByTestId('main-nav')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-teams')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-company')).not.toBeInTheDocument()
  })

  it('REQ_FE_091 / REQ_FE_098 each company address shows its page ("#/company" leads to "#/company/workstreams"), and a reload (a fresh render) keeps the route; the team route and its Manage workstreams page', async () => {
    await step('each company address shows its page, and a reload keeps the route', async () => {
      cleanup()
      window.location.hash = '#/company/workstreams'
      const first = render(<App />)
      expect(await screen.findByTestId('company-stub')).toHaveTextContent('workstreams:')
      first.unmount()
      render(<App />)
      expect(await screen.findByTestId('company-stub')).toHaveTextContent('workstreams:')
      await go('#/company') // "#/company" leads to the company view's own address
      expect(screen.getByTestId('company-stub')).toHaveTextContent('workstreams:')
      await waitFor(() => expect(window.location.hash).toBe('#/company/workstreams'))
      await go('#/company/trace/17')
      expect(screen.getByTestId('company-stub')).toHaveTextContent('trace:17')
    })

    await step('the team route and its Manage workstreams page', async () => {
      cleanup()
      window.location.hash = '#/'
      render(<App />)
      await go('#/teams/5')
      expect(screen.getByTestId('team-stub')).toHaveTextContent('5')
      await go('#/teams/5/workstreams')
      expect(screen.getByTestId('workstreams-stub')).toHaveTextContent('5')
    })
  })

  it('REQ_DEP_021 L12: a malformed trace address reaches the trace page (no id), not the team list', async () => {
    render(<App />)
    for (const h of ['#/company/trace/', '#/company/trace/abc', '#/company/trace/99999999999999999999']) {
      await go(h)
      expect(screen.getByTestId('company-stub'), h).toHaveTextContent(/^trace:$/)
    }
  })

  it('REQ_FE_098 the team list (#/teams) shows the teams in the saved team order, each linking to its roadmap at #/teams/<id>', async () => {
    window.location.hash = '#/teams'
    render(<App />)
    const rows = await screen.findAllByTestId('team-row')
    expect(rows.map((r) => r.textContent)).toEqual(['Platform (PLT)', 'Security (SEC)', 'Onboarding (ONB)'])
    expect(rows.map((r) => r.querySelector('a')?.getAttribute('href'))).toEqual(['#/teams/2', '#/teams/3', '#/teams/1'])
    expect(resources.fetchTeamOrder).toHaveBeenCalledTimes(1)
    expect(resources.fetchTeams).not.toHaveBeenCalled()
  })
})
