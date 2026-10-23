// REQ_FE_101 / REQ_FE_102 / REQ_FE_066: the order of the controls in the one top bar of each page kind, and the zoom row.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { TeamRoadmapPage } from './TeamRoadmapPage'
import { CompanyPage } from './CompanyPage'
import * as resources from '../api/resources'
import { CanEditProvider } from '../lib/canEdit'
import { companyFixture } from '../lib/companyFixtures'
import { barOrder, ALL_BAR_CONTROLS, T } from '../test/barOrder'
import type { CompanyTrace, RoadmapFull } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))
// Clicking the stub selects deliverable 3 (Platform in companyFixture), enough to show the team-roadmap button.
vi.mock('../timeline/Timeline', () => ({ Timeline: ({ onSelect }: { onSelect?: (id: number, type: 'deliverable') => void }) => <div data-testid="tl" onClick={() => onSelect?.(3, 'deliverable')} /> }))

const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null, created_at: '', updated_at: '',
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [{ id: 1, roadmap_id: 1, name: 'Self-Serve', position: 0 }],
  deliverables: [], milestones: [], dependencies: [],
}

// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function fresh() {
  cleanup()
  vi.resetAllMocks()
  window.localStorage.clear()
  vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
  vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap)
  vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(companyFixture())
  vi.mocked(resources.fetchIcons).mockResolvedValue([])
  vi.mocked(resources.fetchWorkstreamOrder).mockResolvedValue([])
}
beforeEach(fresh)

describe('REQ_FE_101 the team roadmap top bar', () => {
  it('REQ_FE_101 REQ_IMP_026 admin: logo, selector, See workstreams (all teams), separator, Workstream, Deliverable, Milestone, space, range, copies, deps, Download CSV, theme, account; anonymous: the same bar without the add buttons; the Workstream button has the tooltip and opens the Manage workstreams page; there is no second toolbar', async () => {
    await step('admin: logo, selector, See workstreams (all teams), separator, Workstream, Deliverable, Milestone, space, range, copies, deps, Download CSV, theme, account', async () => {
      render(<TeamRoadmapPage teamId={1} />)
      await screen.findByTestId('add-deliverable')
      expect(barOrder(ALL_BAR_CONTROLS)).toEqual([
        T('logo'),
        T('team-selector'),
        T('see-combined-roadmaps'),
        T('see-team-roadmaps'),
        '.sep',
        T('add-workstream'),
        T('add-deliverable'),
        T('add-milestone'),
        '.spacer',
        T('range'),
        T('sw-copies'),
        T('sw-deps'),
        T('download-csv'),
        '.sep',
        T('theme-toggle'),
        T('login-button'), // no AuthProvider here: the default context is anonymous
      ])
      expect(screen.getByTestId('team-selector')).toHaveTextContent('Onboarding')
      expect(screen.getByTestId('team-selector')).toHaveAttribute('title', 'Switch team')
      expect(screen.getByTestId('team-selector')).toHaveAttribute('href', '#/teams')
      const csv = screen.getByTestId('download-csv') // REQ_IMP_026
      expect(csv).toHaveAttribute('href', '/api/roadmaps/1/export.csv')
      expect(csv).toHaveAttribute('download')
      expect(csv).toHaveAttribute('title', 'Download this roadmap as a CSV file')
    })

    await step('anonymous: the same bar without the add buttons', async () => {
      fresh()
      render(
        <CanEditProvider value={false}>
          <TeamRoadmapPage teamId={1} />
        </CanEditProvider>,
      )
      await screen.findByTestId('sw-copies')
      expect(barOrder(ALL_BAR_CONTROLS)).toEqual([
        T('logo'),
        T('team-selector'),
        T('see-combined-roadmaps'),
        T('see-team-roadmaps'),
        '.sep',
        '.spacer',
        T('range'),
        T('sw-copies'),
        T('sw-deps'),
        T('download-csv'),
        '.sep',
        T('theme-toggle'),
        T('login-button'),
      ])
    })

    await step('the Workstream button has the tooltip "New workstream" and opens the Manage workstreams page', async () => {
      fresh()
      render(<TeamRoadmapPage teamId={1} />)
      const btn = await screen.findByTestId('add-workstream')
      expect(btn).toHaveAttribute('title', 'New workstream')
      window.location.hash = '#/teams/1/roadmaps/1'
      fireEvent.click(btn)
      expect(window.location.hash).toBe('#/teams/1/workstreams')
    })

    await step('there is no second toolbar, no Teams / Company link', async () => {
      fresh()
      render(<TeamRoadmapPage teamId={1} />)
      await screen.findByTestId('add-deliverable')
      expect(screen.queryByTestId('toolbar')).not.toBeInTheDocument()
      expect(screen.queryByTestId('nav-company')).not.toBeInTheDocument()
    })
  })

  it('REQ_FE_101 the team bar is already there while the roadmap loads (it does not flip from the minimal bar)', async () => {
    vi.mocked(resources.fetchRoadmap).mockReturnValue(new Promise(() => {}))
    render(<TeamRoadmapPage teamId={1} />)
    await screen.findByText('Loading…')
    expect(screen.getByTestId('topbar')).toHaveAttribute('data-variant', 'team')
  })

  it('REQ_FE_066 the zoom is a right-aligned row of its own, not in the top bar; by workstream the team-roadmap button is the left end of the zoom row, which sits above the timeline', async () => {
    await step('the zoom is a right-aligned row of its own, not in the top bar', async () => {
      render(<TeamRoadmapPage teamId={1} />)
      await screen.findByTestId('zoom-row')
      expect(within(screen.getByTestId('topbar')).queryByTestId('zoomseg')).toBeNull()
      expect(screen.getByTestId('zoom-row')).toContainElement(screen.getByTestId('zoomseg'))
      expect(screen.getByTestId('zoom-row')).toHaveTextContent(/^ZoomYearHalf yearQuarterMonth$/)
    })

    await step('by workstream: the team-roadmap button is the left end of the zoom row, which sits above the timeline', async () => {
      fresh()
      render(<CompanyPage mode="workstreams" />)
      const row = await screen.findByTestId('zoom-row')
      expect(screen.queryByTestId('team-roadmap')).toBeNull() // REQ_FE_053: shown once something is selected
      fireEvent.click(await screen.findByTestId('tl'))
      expect(row.firstElementChild).toBe(screen.getByTestId('team-roadmap'))
      expect(within(row).getByTestId('zoomseg')).toBeInTheDocument()
      expect(within(screen.getByTestId('topbar')).queryByTestId('team-roadmap')).toBeNull()
    })
  })
})

describe('REQ_FE_102 the company view top bar', () => {
  it('REQ_FE_102 company view (admin): logo, All teams, Teams roadmaps, separator, Order, space, range, copies, deps, separator, theme, account; the trace: the same without the Order button and the copies and dependencies switches', async () => {
    await step('company view (admin): logo, All teams, Teams roadmaps, separator, Order, space, range, copies, deps, separator, theme, account; no add or export buttons, no view switch', async () => {
      render(<CompanyPage mode="workstreams" />)
      await screen.findByTestId('tl')
      expect(barOrder(ALL_BAR_CONTROLS)).toEqual([
        T('logo'),
        T('see-combined-roadmaps'),
        T('see-team-roadmaps'),
        '.sep',
        T('order-button'),
        '.spacer',
        T('range'),
        T('sw-copies'),
        T('sw-deps'),
        '.sep',
        T('theme-toggle'),
        T('login-button'),
      ])
      expect(screen.queryByTestId('team-selector')).toBeNull() // REQ_FE_102: no "All teams" selector
      expect(screen.getByTestId('see-team-roadmaps')).toHaveAttribute('href', '#/teams')
      expect(screen.queryByTestId('company-switch')).toBeNull()
    })

    await step('the trace: no Order button and no copies or dependencies switches; the zoom row stays', async () => {
      fresh()
      const trace: CompanyTrace = { root: { kind: 'deliverable', id: 3, name: 'API Gateway' } as never, prerequisites: [], dependents: [], edges: [] }
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(trace)
      render(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-title')
      expect(barOrder(ALL_BAR_CONTROLS)).toEqual([
        T('logo'),
        T('see-combined-roadmaps'),
        T('see-team-roadmaps'),
        '.sep',
        '.spacer',
        T('range'),
        '.sep',
        T('theme-toggle'),
        T('login-button'),
      ])
      expect(screen.getByTestId('zoom-row')).toBeInTheDocument()
    })
  })
})
