import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { TeamRoadmapPage } from './TeamRoadmapPage'
import { CanEditProvider } from '../lib/canEdit'
import * as resources from '../api/resources'
import * as prefs from '../lib/prefs'
import { step } from '../testSteps'
import type { ItemRef, RoadmapFull } from '../api/types'

vi.mock('../api/resources')
vi.mock('../timeline/Timeline', () => ({
  Timeline: (props: {
    dupsOn?: boolean
    showDependencies?: boolean
    onCreateDependency?: (from: ItemRef, to: ItemRef) => Promise<void>
    onDeleteDependency?: (from: ItemRef, to: ItemRef) => Promise<void>
  }) => (
    <div>
      <span data-testid="tl-dupson">{String(props.dupsOn)}</span>
      <span data-testid="tl-deps">{String(props.showDependencies)}</span>
      <span data-testid="tl-can-connect">{String(!!props.onCreateDependency)}</span>
      <button onClick={() => void props.onCreateDependency?.({ kind: 'deliverable', id: 1 }, { kind: 'deliverable', id: 2 })}>connect</button>
      <button onClick={() => void props.onCreateDependency?.({ kind: 'milestone', id: 1 }, { kind: 'deliverable', id: 2 })}>connect milestone</button>
      <button onClick={() => void props.onDeleteDependency?.({ kind: 'deliverable', id: 2 }, { kind: 'milestone', id: 1 })}>disconnect milestone</button>
      <button onClick={() => void props.onDeleteDependency?.({ kind: 'deliverable', id: 1 }, { kind: 'deliverable', id: 2 })}>disconnect</button>
    </div>
  ),
}))

const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null,
  created_at: '', updated_at: '',
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [], deliverables: [], milestones: [], dependencies: [],
}

function setup() {
  vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
  vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap)
}

describe('REQ_DEP_013/014/015 dependencies toggle on the page', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.localStorage.clear()
  })

  it('REQ_DEP_013 toggling passes showDependencies to Timeline and persists it', async () => {
    setup()
    render(<TeamRoadmapPage teamId={1} />)
    expect(await screen.findByTestId('tl-deps')).toHaveTextContent('false')
    fireEvent.click(screen.getByRole('switch', { name: /show dependencies/i }))
    expect(screen.getByTestId('tl-deps')).toHaveTextContent('true')
    expect(prefs.getDependenciesVisible()).toBe(true)
  })

  // The page wires the real Toolbar to Timeline (mocked above to expose its props), so these check
  // what the user sees on the copies switch as well as what Timeline is told.
  it('REQ_DEP_014 dependencies on: Timeline gets copies off, and the copies switch is disabled with an explanatory tooltip and its normal label', async () => {
    setup()
    prefs.setCopiesVisible(true)
    render(<TeamRoadmapPage teamId={1} />)
    const copies = await screen.findByRole('switch', { name: /copies/i })
    expect(copies).not.toHaveAttribute('aria-disabled') // a normal, working switch while arrows are off
    expect(copies).toHaveTextContent('Hide copies')
    fireEvent.click(screen.getByRole('switch', { name: /show dependencies/i }))
    expect(screen.getByTestId('tl-dupson')).toHaveTextContent('false')
    const locked = screen.getByRole('switch', { name: /copies/i })
    expect(locked).toHaveAttribute('aria-disabled', 'true')
    expect(locked.getAttribute('title')).toMatch(/locked while arrows are on/i)
    expect(locked).toHaveTextContent('Show copies') // not relabelled: the normal label for copies being hidden
    fireEvent.click(locked) // a click on a disabled switch does nothing
    expect(screen.getByTestId('tl-dupson')).toHaveTextContent('false')
    expect(prefs.getCopiesVisible()).toBe(true)
  })

  it('REQ_DEP_015 dependencies off again: the copies setting is exactly what it was before (shown stays shown, hidden stays hidden), and the switch works again', async () => {
    await step('a copies setting of "shown" is restored as shown, and the switch works again', async () => {
      setup()
      prefs.setCopiesVisible(true)
      render(<TeamRoadmapPage teamId={1} />)
      expect(await screen.findByTestId('tl-dupson')).toHaveTextContent('true')
      fireEvent.click(screen.getByRole('switch', { name: /show dependencies/i }))
      expect(prefs.getCopiesVisible()).toBe(true) // the stored setting is untouched while arrows are on
      fireEvent.click(screen.getByRole('switch', { name: /hide dependencies/i }))
      expect(screen.getByTestId('tl-dupson')).toHaveTextContent('true')
      const copies = screen.getByRole('switch', { name: /copies/i })
      expect(copies).not.toHaveAttribute('aria-disabled')
      fireEvent.click(copies)
      expect(screen.getByTestId('tl-dupson')).toHaveTextContent('false')
    })
    cleanup()
    vi.resetAllMocks()
    window.localStorage.clear()
    await step('a copies setting of "hidden" is restored as hidden, not reset to shown', async () => {
      setup()
      prefs.setCopiesVisible(false)
      render(<TeamRoadmapPage teamId={1} />)
      expect(await screen.findByTestId('tl-dupson')).toHaveTextContent('false')
      fireEvent.click(screen.getByRole('switch', { name: /show dependencies/i }))
      fireEvent.click(screen.getByRole('switch', { name: /hide dependencies/i }))
      expect(screen.getByTestId('tl-dupson')).toHaveTextContent('false')
      expect(prefs.getCopiesVisible()).toBe(false)
    })
  })
})

describe('REQ_DEP_003 connecting dependencies from the timeline', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.localStorage.clear()
  })

  it('REQ_DEP_003 REQ_DEP_025 a 409 cycle shows a message naming the loop (a milestone on it marked with a diamond), then the roadmap is refetched', async () => {
    await step('a loop of deliverables is named, and the roadmap is refetched', async () => {
      setup()
      vi.mocked(resources.addDependency).mockRejectedValue({
        response: { data: { error: { code: 'cycle', message: 'loop', path: ['A', 'B', 'C'] } } },
      })
      render(<TeamRoadmapPage teamId={1} />)
      fireEvent.click(await screen.findByText('connect'))
      expect(await screen.findByRole('alert')).toHaveTextContent('A → B → C → A')
      expect(resources.addDependency).toHaveBeenCalledWith({ kind: 'deliverable', id: 2 }, { kind: 'deliverable', id: 1 }) // the first is the dependent
      await waitFor(() => expect(resources.fetchRoadmap).toHaveBeenCalledTimes(2))
    })
    cleanup()
    vi.resetAllMocks()
    window.localStorage.clear()
    await step('a loop through a milestone names it with a diamond on the milestone', async () => {
      setup()
      vi.mocked(resources.addDependency).mockRejectedValue({
        response: { data: { error: { code: 'cycle', message: 'loop', path: [{ kind: 'deliverable', name: 'Build' }, { kind: 'milestone', name: 'Beta' }] } } },
      })
      render(<TeamRoadmapPage teamId={1} />)
      fireEvent.click(await screen.findByText('connect milestone'))
      expect(await screen.findByRole('alert')).toHaveTextContent('Build → ◆ Beta → Build')
    })
  })

  it('REQ_DEP_001 a created and a deleted dependency both refetch the roadmap', async () => {
    setup()
    vi.mocked(resources.addDependency).mockResolvedValue({ from_kind: 'deliverable', from_id: 1, to_kind: 'deliverable', to_id: 2, other: null })
    vi.mocked(resources.removeDependency).mockResolvedValue()
    render(<TeamRoadmapPage teamId={1} />)
    fireEvent.click(await screen.findByText('connect'))
    await waitFor(() => expect(resources.fetchRoadmap).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByText('disconnect'))
    await waitFor(() => expect(resources.removeDependency).toHaveBeenCalledWith({ kind: 'deliverable', id: 2 }, { kind: 'deliverable', id: 1 }))
    await waitFor(() => expect(resources.fetchRoadmap).toHaveBeenCalledTimes(3))
  })

  it('REQ_DEP_027 a dependency whose prerequisite is a milestone is created and deleted with its kinds', async () => {
    setup()
    vi.mocked(resources.addDependency).mockResolvedValue({ from_kind: 'milestone', from_id: 4, to_kind: 'deliverable', to_id: 2, other: null })
    vi.mocked(resources.removeDependency).mockResolvedValue()
    render(<TeamRoadmapPage teamId={1} />)
    fireEvent.click(await screen.findByText('connect milestone'))
    await waitFor(() => expect(resources.addDependency).toHaveBeenCalledWith({ kind: 'deliverable', id: 2 }, { kind: 'milestone', id: 1 }))
    fireEvent.click(screen.getByText('disconnect milestone'))
    await waitFor(() => expect(resources.removeDependency).toHaveBeenCalledWith({ kind: 'milestone', id: 1 }, { kind: 'deliverable', id: 2 }))
  })

  it('REQ_DEP_020 read-only visitors get no connect callbacks', async () => {
    setup()
    render(
      <CanEditProvider value={false}>
        <TeamRoadmapPage teamId={1} />
      </CanEditProvider>,
    )
    expect(await screen.findByTestId('tl-can-connect')).toHaveTextContent('false')
  })
})
