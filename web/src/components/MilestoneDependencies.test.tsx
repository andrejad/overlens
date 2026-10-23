import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DependenciesField, DependencyPicker } from './DependencyPicker'
import { SidePanel } from './SidePanel'
import { DeliverableEditForm } from './DeliverableEditForm'
import { CanEditProvider } from '../lib/canEdit'
import * as resources from '../api/resources'
import { step } from '../testSteps'
import { roadmapDeps } from '../test/deps'
import type { Candidate, Deliverable, DependencyEdge, RoadmapFull, Team } from '../api/types'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

function cand(kind: 'deliverable' | 'milestone', id: number, name: string, team: string, blocked: Candidate['blocked'] = null): Candidate {
  return { kind, id, name, team_id: 1, team_name: team, team_tag: team.slice(0, 3).toUpperCase(), roadmap_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', blocked }
}
// candidates in the order the picker keeps them (it never re-sorts)
const candidates = [
  cand('deliverable', 1, 'Signup', 'Onboarding'),
  cand('milestone', 1, 'Beta launch', 'Onboarding'),
  cand('milestone', 2, 'GA', 'Payments', 'ends_too_late'),
  cand('milestone', 3, 'Audit', 'Payments', 'would_cycle'),
]

describe('REQ_DEP_026 the picker lists milestones next to deliverables', () => {
  it('REQ_DEP_026 REQ_DEP_008 milestones sit in the one list beside the deliverables, labelled with the team tag, and carry a diamond; one search finds them by name and by team', async () => {
    render(<DependencyPicker candidates={candidates} onPick={vi.fn()} />)
    await step('milestones are in the one list, labelled with the team tag, with a diamond; deliverables have none', () => {
      expect(screen.queryByRole('group')).toBeNull()
      expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-kind'))).toEqual(['deliverable', 'milestone', 'milestone', 'milestone'])
      const beta = screen.getByRole('option', { name: /Beta launch/ })
      expect(beta).toHaveTextContent('ONB - Beta launch')
      expect(within(beta).getByTestId('ms-marker')).toBeInTheDocument()
      expect(within(screen.getByRole('option', { name: /Signup/ })).queryByTestId('ms-marker')).toBeNull()
    })
    await step('one search finds milestones by name and by team', () => {
      fireEvent.change(screen.getByLabelText('Search deliverables and milestones'), { target: { value: 'beta' } })
      expect(screen.getByRole('option', { name: /Beta launch/ })).toBeInTheDocument()
      expect(screen.queryByRole('option', { name: /Signup/ })).toBeNull()
      fireEvent.change(screen.getByLabelText('Search deliverables and milestones'), { target: { value: 'payments' } })
      expect(screen.getAllByRole('option')).toHaveLength(2)
    })
  })

  it('REQ_DEP_026 a deliverable and a milestone with the same number are two options', () => {
    const onPick = vi.fn()
    render(<DependencyPicker candidates={[cand('deliverable', 5, 'Plan', 'T'), cand('milestone', 5, 'Kickoff', 'T')]} onPick={onPick} />)
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.click(screen.getByRole('option', { name: /Kickoff/ }))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'milestone', id: 5 }))
  })
})

describe('REQ_DEP_023 REQ_DEP_026 the "Depends on" field for either kind of dependent', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_DEP_023 kind and id go to the server for every pairing: a deliverable picks a milestone, a milestone picks a deliverable, and only the edges INTO the item are its prerequisites', async () => {
    await step('a deliverable picks a milestone as prerequisite: kind and id go to the server', async () => {
      vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue(candidates)
      vi.mocked(resources.addDependency).mockResolvedValue({ from_kind: 'milestone', from_id: 4, to_kind: 'deliverable', to_id: 9, other: null })
      const onChanged = vi.fn()
      render(<DependenciesField item={{ kind: 'deliverable', id: 9 }} edges={[]} onChanged={onChanged} />)
      fireEvent.click(await screen.findByRole('option', { name: /Beta launch/ }))
      await waitFor(() => expect(onChanged).toHaveBeenCalled())
      expect(resources.fetchDependencyCandidates).toHaveBeenCalledWith(9, 'deliverable')
      expect(resources.addDependency).toHaveBeenCalledWith({ kind: 'deliverable', id: 9 }, { kind: 'milestone', id: 1 })
    })
    cleanup()
    vi.resetAllMocks()
    await step('a milestone is the dependent: its own candidates are asked for and a deliverable can be picked', async () => {
      vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue(candidates)
      vi.mocked(resources.addDependency).mockResolvedValue({ from_kind: 'deliverable', from_id: 1, to_kind: 'milestone', to_id: 4, other: null })
      const onChanged = vi.fn()
      render(<DependenciesField item={{ kind: 'milestone', id: 9 }} edges={[]} onChanged={onChanged} />)
      fireEvent.click(await screen.findByRole('option', { name: /Signup/ }))
      await waitFor(() => expect(onChanged).toHaveBeenCalled())
      expect(resources.fetchDependencyCandidates).toHaveBeenCalledWith(9, 'milestone')
      expect(resources.addDependency).toHaveBeenCalledWith({ kind: 'milestone', id: 9 }, { kind: 'deliverable', id: 1 })
    })
    cleanup()
    vi.resetAllMocks()
    await step('only the edges INTO the item are its prerequisites; a milestone prerequisite is marked and removed by kind', async () => {
      vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
      vi.mocked(resources.removeDependency).mockResolvedValue(undefined)
      const into: DependencyEdge = {
        from_kind: 'milestone', to_kind: 'deliverable', from_id: 4, to_id: 9,
        other: { kind: 'milestone', id: 4, name: 'Beta launch', team_name: 'Onboarding', roadmap_id: 1, start_date: '2026-03-01', end_date: '2026-03-01' },
      }
      const out: DependencyEdge = {
        from_kind: 'deliverable', to_kind: 'milestone', from_id: 9, to_id: 4,
        other: { kind: 'milestone', id: 4, name: 'Dependent milestone', team_name: 'Onboarding', roadmap_id: 1, start_date: '2026-05-01', end_date: '2026-05-01' },
      }
      const onChanged = vi.fn()
      render(<DependenciesField item={{ kind: 'deliverable', id: 9 }} edges={[into, out]} onChanged={onChanged} />)
      expect(screen.getByText('Beta launch')).toBeInTheDocument()
      expect(screen.queryByText('Dependent milestone')).toBeNull()
      expect(screen.getByTestId('ms-marker')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Remove prerequisite Beta launch' }))
      await waitFor(() => expect(onChanged).toHaveBeenCalled())
      expect(resources.removeDependency).toHaveBeenCalledWith({ kind: 'deliverable', id: 9 }, { kind: 'milestone', id: 4 })
    })
  })
})

const team: Team = { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' }
const del: Deliverable = {
  id: 10, roadmap_id: 1, team_id: 1, name: 'Mid', start_date: '2026-03-10', end_date: '2026-04-10',
  color: '#2f6bd7', responsible_person: '', description_html: '', status: 'planned', risk_note: '',
  icons: [], workstream_ids: [], workstreams: [], links: [], created_at: '', updated_at: '',
}
const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null, created_at: '', updated_at: '',
  team, workstreams: [{ id: 1, roadmap_id: 1, name: 'Platform', position: 0 }], deliverables: [del],
  milestones: [{ id: 20, roadmap_id: 1, workstream_id: 1, name: 'Launch', date: '2026-03-01', row: 0 }], dependencies: [],
}
const msEnd = (id: number, name: string, date: string) => ({ kind: 'milestone' as const, id, name, team_name: 'T', roadmap_id: 1, start_date: date, end_date: date })
const delEnd = (id: number, name: string, s: string, e: string) => ({ kind: 'deliverable' as const, id, name, team_name: 'T', roadmap_id: 1, start_date: s, end_date: e })

describe('REQ_DEP_006 REQ_DEP_026 the limits in the side panel and the edit window', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.localStorage.clear()
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
  })

  it('REQ_DEP_026 the limits count milestones: a deliverable\'s edit form, a milestone\'s side panel, and no limit when there are no dependencies', async () => {
    await step('the edit form of a deliverable counts a prerequisite milestone\'s date and a dependent milestone\'s date', async () => {
      const dependencies = roadmapDeps([
        { from_kind: 'milestone', to_kind: 'deliverable', from_id: 7, to_id: 10, other: msEnd(7, 'Kickoff', '2026-03-05') },
        { from_kind: 'deliverable', to_kind: 'milestone', from_id: 10, to_id: 8, other: msEnd(8, 'Release', '2026-05-01') },
      ], delEnd(10, 'Mid', del.start_date, del.end_date))
      render(<DeliverableEditForm deliverable={del} team={team} workstreams={[]} roadmap={{ ...roadmap, dependencies }} onSaved={vi.fn()} />)
      expect(await screen.findByTestId('start-limit')).toHaveTextContent('Earliest start Mar 6, 2026 — Kickoff ends Mar 5, 2026')
      expect(screen.getByTestId('end-limit')).toHaveTextContent('Latest end Apr 30, 2026 — Release starts May 1, 2026')
    })
    cleanup()
    vi.resetAllMocks()
    window.localStorage.clear()
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
    await step('the side panel of a milestone shows the earliest and latest allowed date from its prerequisites and dependents', async () => {
      const dependencies = roadmapDeps([
        { from_kind: 'deliverable', to_kind: 'milestone', from_id: 10, to_id: 20, other: delEnd(10, 'Mid', '2026-02-01', '2026-02-20') },
        { from_kind: 'milestone', to_kind: 'deliverable', from_id: 20, to_id: 11, other: delEnd(11, 'After', '2026-04-01', '2026-05-01') },
      ], msEnd(20, 'Launch', '2026-03-01'))
      render(<SidePanel roadmap={{ ...roadmap, dependencies }} selection={{ id: 20, type: 'milestone' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
      await waitFor(() => expect(screen.getByTestId('date-limit')).toHaveTextContent('Earliest date Feb 21, 2026 — Mid ends Feb 20, 2026'))
      expect(screen.getByTestId('date-limit-latest')).toHaveTextContent('Latest date Mar 31, 2026 — After starts Apr 1, 2026')
      expect(screen.queryByTestId('dep-bounds')).toBeNull()
      expect(screen.getByLabelText('Date')).toHaveAttribute('min', '2026-02-21')
      expect(screen.getByLabelText('Date')).toHaveAttribute('max', '2026-03-31')
    })
    cleanup()
    vi.resetAllMocks()
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
    await step('a milestone with no dependencies shows no limits', async () => {
      render(<SidePanel roadmap={roadmap} selection={{ id: 20, type: 'milestone' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
      await screen.findByText('No prerequisites')
      expect(screen.getByTestId('date-limit')).toHaveTextContent('No prerequisite limits the date')
      expect(screen.getByTestId('date-limit-latest')).toHaveTextContent('No dependent limits the date')
    })
  })

  it('REQ_DEP_026 the side panel of a milestone has the "Depends on" picker for editors and none for read-only visitors', async () => {
    const { unmount } = render(<SidePanel roadmap={roadmap} selection={{ id: 20, type: 'milestone' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />)
    expect(screen.queryByLabelText('Search deliverables and milestones')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    expect(await screen.findByLabelText('Search deliverables and milestones')).toBeInTheDocument()
    expect(resources.fetchDependencyCandidates).toHaveBeenCalledWith(20, 'milestone')
    unmount()
    render(
      <CanEditProvider value={false}>
        <SidePanel roadmap={roadmap} selection={{ id: 20, type: 'milestone' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />
      </CanEditProvider>,
    )
    expect(await screen.findByText('Depends on')).toBeInTheDocument()
    expect(screen.queryByLabelText('Search deliverables and milestones')).toBeNull()
  })

  it('REQ_DEP_026 picking in the milestone panel tells the page to refetch', async () => {
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue(candidates)
    vi.mocked(resources.addDependency).mockResolvedValue({ from_kind: 'deliverable', from_id: 1, to_kind: 'milestone', to_id: 4, other: null })
    const changed = vi.fn()
    render(<SidePanel roadmap={roadmap} selection={{ id: 20, type: 'milestone' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} onDependenciesChanged={changed} />)
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    fireEvent.click(await screen.findByRole('option', { name: /Signup/ }))
    await waitFor(() => expect(changed).toHaveBeenCalled())
    expect(resources.addDependency).toHaveBeenCalledWith({ kind: 'milestone', id: 20 }, { kind: 'deliverable', id: 1 })
  })
})
