import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { TeamRoadmapPage } from './TeamRoadmapPage'
import * as resources from '../api/resources'
import * as prefs from '../lib/prefs'
import type { RoadmapFull } from '../api/types'

vi.mock('../api/resources')
// Stubbed to a button that invokes onPatchMilestone directly (a finished drag), plus enough of
// `dupsOn`/`roadmap.milestones` surfaced as text so Phase 4's dupsOn-as-real-state and
// milestone-create wiring can be asserted here without duplicating Timeline.test.tsx's own coverage.
vi.mock('../timeline/Timeline', () => ({
  Timeline: (props: {
    onPatchMilestone?: (id: number, patch: Record<string, unknown>) => Promise<unknown> | void
    dupsOn?: boolean
    roadmap?: { milestones: unknown[] }
    selected?: { id: number } | null
    onSelect?: (id: number, type: 'deliverable' | 'milestone') => void
  }) => (
    <div>
      <button onClick={() => props.onSelect?.(30, 'deliverable')}>select-d30</button>
      <button onClick={() => props.onSelect?.(7, 'milestone')}>select-m7</button>
      <span data-testid="tl-selected">{props.selected ? String(props.selected.id) : 'none'}</span>
      <button onClick={() => props.onPatchMilestone?.(7, { workstream_id: 1, row: 1 })}>trigger-milestone-patch</button>
      <span data-testid="tl-dupson">{String(props.dupsOn)}</span>
      <span data-testid="tl-ms-count">{props.roadmap?.milestones.length}</span>
    </div>
  ),
}))

const roadmap: RoadmapFull = {
  id: 1,
  team_id: 1,
  title: 'Plan',
 
  range_start: null,
  range_end: null,
  created_at: '',
  updated_at: '',
 
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [{ id: 1, roadmap_id: 1, name: 'Self-Serve', position: 0 }],
  deliverables: [],
  milestones: [{ id: 7, roadmap_id: 1, workstream_id: 1, name: 'Launch', date: '2026-01-01', row: 0 }],
  dependencies: [],
}

describe('REQ_FE_014 team roadmap page saving a milestone drag', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_FE_014 a finished milestone drag handed up by the timeline is saved through patchMilestone', async () => {
    vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
    vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap)
    vi.mocked(resources.patchMilestone).mockResolvedValue({ ...roadmap.milestones[0], row: 1 })

    render(<TeamRoadmapPage teamId={1} />)

    fireEvent.click(await screen.findByText('trigger-milestone-patch'))

    await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(7, { workstream_id: 1, row: 1 }))
  })
})

describe('REQ_FE_051/071 the copies toggle is real, flippable state', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.localStorage.clear()
  })

  it('REQ_FE_051 flipping the toolbar switch changes what Timeline is given as dupsOn', async () => {
    vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
    vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap)

    render(<TeamRoadmapPage teamId={1} />)

    expect(await screen.findByTestId('tl-dupson')).toHaveTextContent('true')
    fireEvent.click(screen.getByRole('switch', { name: /copies/i }))
    expect(screen.getByTestId('tl-dupson')).toHaveTextContent('false')
    expect(prefs.getCopiesVisible()).toBe(false)
  })
})

describe('REQ_FE_090 the milestone create flow', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_FE_090 creating a milestone from the toolbar appends it to the roadmap Timeline sees', async () => {
    vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
    vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap)
    vi.mocked(resources.createMilestone).mockResolvedValue({
      id: 99,
      roadmap_id: 1,
      workstream_id: 1,
      name: 'Beta launch',
      date: '2026-05-01',
      row: 0,
    })

    render(<TeamRoadmapPage teamId={1} />)

    expect(await screen.findByTestId('tl-ms-count')).toHaveTextContent('1')

    fireEvent.click(screen.getByTitle('New milestone'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta launch' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-05-01' } })
    fireEvent.click(screen.getByText('Create milestone'))

    await waitFor(() => expect(screen.getByTestId('tl-ms-count')).toHaveTextContent('2'))
    // the dialog itself closes after a successful create
    expect(screen.queryByText('New milestone')).not.toBeInTheDocument()
  })
})

describe('REQ_FE_118 deleting a milestone through the panel', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_FE_118 after Delete the milestone is no longer given to the timeline and the selection is cleared', async () => {
    vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
    vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap)
    vi.mocked(resources.deleteMilestone).mockResolvedValue(undefined)
    render(<TeamRoadmapPage teamId={1} />)
    fireEvent.click(await screen.findByText('select-m7'))
    expect(screen.getByTestId('tl-selected')).toHaveTextContent('7')
    expect(screen.getByTestId('tl-ms-count')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('panel-delete'))
    vi.mocked(resources.fetchRoadmap).mockResolvedValue({ ...roadmap, milestones: [] }) // what the server holds after the delete
    fireEvent.click(screen.getByTestId('delete-item-confirm'))
    await waitFor(() => expect(resources.deleteMilestone).toHaveBeenCalledWith(7))
    await waitFor(() => expect(screen.getByTestId('tl-ms-count')).toHaveTextContent('0'))
    expect(screen.getByTestId('tl-selected')).toHaveTextContent('none')
    expect(screen.getByText('Select a deliverable or milestone')).toBeInTheDocument()
  })
})

describe('REQ_FE_098 the team roadmap page', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('REQ_FE_098 #/teams/<id> shows the team\'s one roadmap, found through team.roadmap_id', async () => {
    vi.mocked(resources.fetchTeam).mockResolvedValue({ ...roadmap.team, id: 4, roadmap_id: 42 })
    vi.mocked(resources.fetchRoadmap).mockResolvedValue({ ...roadmap, id: 42, title: 'Team four plan' })
    render(<TeamRoadmapPage teamId={4} />)
    expect(await screen.findByText('Team four plan')).toBeInTheDocument()
    expect(resources.fetchTeam).toHaveBeenCalledWith(4)
    expect(resources.fetchRoadmap).toHaveBeenCalledWith(42)
  })

  it('REQ_FE_101 a team id the server does not know shows "That team was not found." instead of Loading forever', async () => {
    vi.mocked(resources.fetchTeam).mockRejectedValue({ isAxiosError: true, response: { status: 404, data: { error: { code: 'not_found', message: 'team 99 not found' } } } })
    render(<TeamRoadmapPage teamId={99} />)
    expect(await screen.findByText('That team was not found.')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('REQ_FE_101 a roadmap that fails to load shows "Could not load the roadmap." instead of Loading forever', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
    vi.mocked(resources.fetchRoadmap).mockRejectedValue(new Error('network down'))
    render(<TeamRoadmapPage teamId={1} />)
    expect(await screen.findByText('Could not load the roadmap.')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    spy.mockRestore()
  })
})
