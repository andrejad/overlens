import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DependencyPicker, DependenciesField } from './DependencyPicker'
import { DeliverableEditForm } from './DeliverableEditForm'
import { CanEditProvider } from '../lib/canEdit'
import * as resources from '../api/resources'
import { step } from '../testSteps'
import { roadmapDeps } from '../test/deps'
import type { Candidate, Deliverable, DependencyEdge, RoadmapFull, Team } from '../api/types'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

function cand(id: number, name: string, team: string, blocked: Candidate['blocked'] = null): Candidate {
  return { id, name, team_id: 1, team_name: team, team_tag: team.slice(0, 3).toUpperCase(), roadmap_id: 1, start_date: '2026-01-01', end_date: '2026-01-31', blocked }
}

const candidates = [
  cand(1, 'Signup', 'Onboarding'),
  cand(2, 'Billing', 'Payments', 'ends_too_late'),
  cand(3, 'Invoices', 'Payments', 'already_prerequisite'),
  cand(4, 'Checkout', 'Payments', 'would_cycle'),
]

describe('REQ_DEP_007/008 dependency picker', () => {
  it('REQ_FE_119 Escape in the search box only clears a typed search (default prevented); an empty box lets it through', () => {
    render(<DependencyPicker candidates={candidates} onPick={vi.fn()} />)
    const box = screen.getByLabelText('Search deliverables and milestones')
    fireEvent.change(box, { target: { value: 'pay' } })
    expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(false) // false = preventDefault was called
    expect(box).toHaveValue('')
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(true)
  })

  it('REQ_DEP_008 entries read "<tag> - <name>" in the server order, with no group headings; the search matches the name, the team tag and the displayed label', async () => {
    render(<DependencyPicker candidates={candidates} onPick={vi.fn()} />)
    const box = screen.getByLabelText('Search deliverables and milestones')
    await step('entries are "<tag> - <name>" in the server order with no group headings', () => {
      expect(screen.queryByRole('group')).toBeNull()
      expect(screen.getAllByRole('option').map((o) => o.textContent?.replace(/ends too late|already a prerequisite|would create a loop/, ''))).toEqual([
        'ONB - Signup',
        'PAY - Billing',
        'PAY - Invoices',
        'PAY - Checkout',
      ])
    })
    await step('searching by name keeps only the matching entry', () => {
      fireEvent.change(box, { target: { value: 'sign' } })
      expect(screen.getByText('ONB - Signup')).toBeInTheDocument()
      expect(screen.queryByText('PAY - Billing')).not.toBeInTheDocument()
    })
    await step('the search also matches the team tag and the displayed "<tag> - <name>" label', () => {
      fireEvent.change(box, { target: { value: 'pay' } })
      expect(screen.getAllByRole('option')).toHaveLength(3)
      fireEvent.change(box, { target: { value: 'onb - sig' } })
      expect(screen.getAllByRole('option')).toHaveLength(1)
    })
  })

  it('REQ_DEP_007 REQ_DEP_026 greys out blocked candidates, deliverables and milestones alike, with the server reason and does not pick them', async () => {
    await step('a blocked deliverable is greyed out with the reason and cannot be picked', () => {
      const onPick = vi.fn()
      render(<DependencyPicker candidates={candidates} onPick={onPick} />)
      const billing = screen.getByRole('option', { name: /Billing/ })
      expect(billing).toBeDisabled()
      expect(billing).toHaveTextContent('ends too late')
      expect(screen.getByRole('option', { name: /Invoices/ })).toHaveTextContent('already a prerequisite')
      expect(screen.getByRole('option', { name: /Checkout/ })).toHaveTextContent('would create a loop')
      fireEvent.click(billing)
      expect(onPick).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('option', { name: /Signup/ }))
      expect(onPick).toHaveBeenCalledWith(candidates[0])
    })
    cleanup()
    await step('a blocked milestone is greyed out with the server reason and cannot be picked', () => {
      const onPick = vi.fn()
      const milestones: Candidate[] = [
        { ...cand(1, 'Beta launch', 'Onboarding'), kind: 'milestone' },
        { ...cand(2, 'GA', 'Payments', 'ends_too_late'), kind: 'milestone' },
        { ...cand(3, 'Audit', 'Payments', 'would_cycle'), kind: 'milestone' },
      ]
      render(<DependencyPicker candidates={milestones} onPick={onPick} />)
      const ga = screen.getByRole('option', { name: /GA/ })
      expect(ga).toBeDisabled()
      expect(ga).toHaveTextContent('ends too late')
      expect(screen.getByRole('option', { name: /Audit/ })).toHaveTextContent('would create a loop')
      fireEvent.click(ga)
      expect(onPick).not.toHaveBeenCalled()
    })
  })
})

describe('REQ_DEP_003/020 dependencies field', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_DEP_003 a 409 cycle on pick is shown inline naming the loop', async () => {
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue(candidates)
    vi.mocked(resources.addDependency).mockRejectedValue({
      response: { data: { error: { code: 'cycle', message: 'x', path: ['X', 'Y'] } } },
    })
    render(<DependenciesField item={{ kind: 'deliverable', id: 9 }} edges={[]} onChanged={vi.fn()} />)
    fireEvent.click(await screen.findByRole('option', { name: /Signup/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('X → Y → X')
  })

  it('REQ_DEP_008 picking adds the dependency and reports the change', async () => {
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue(candidates)
    vi.mocked(resources.addDependency).mockResolvedValue({ from_kind: 'deliverable', from_id: 1, to_kind: 'deliverable', to_id: 9, other: null })
    const onChanged = vi.fn()
    render(<DependenciesField item={{ kind: 'deliverable', id: 9 }} edges={[]} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('option', { name: /Signup/ }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(resources.addDependency).toHaveBeenCalledWith({ kind: 'deliverable', id: 9 }, { kind: 'deliverable', id: 1 })
  })

  it('REQ_DEP_020 read-only visitors get no picker and no remove buttons, for a deliverable or a milestone', async () => {
    await step('a milestone gets no picker', () => {
      render(
        <CanEditProvider value={false}>
          <DependenciesField item={{ kind: 'milestone', id: 9 }} edges={[]} onChanged={vi.fn()} />
        </CanEditProvider>,
      )
      expect(screen.queryByLabelText('Search deliverables and milestones')).toBeNull()
      expect(resources.fetchDependencyCandidates).not.toHaveBeenCalled()
    })
    cleanup()
    const edge: DependencyEdge = {
      from_kind: 'deliverable', from_id: 1, to_kind: 'deliverable', to_id: 9,
      other: { id: 1, name: 'Signup', team_name: 'Onboarding', roadmap_id: 1, start_date: '2026-01-01', end_date: '2026-01-31' },
    }
    render(
      <CanEditProvider value={false}>
        <DependenciesField item={{ kind: 'deliverable', id: 9 }} edges={[edge]} onChanged={vi.fn()} />
      </CanEditProvider>,
    )
    await step('a deliverable lists its prerequisites with no picker and no remove buttons', () => {
      expect(screen.getByText('Signup')).toBeInTheDocument()
      expect(screen.queryByLabelText('Search deliverables and milestones')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Remove prerequisite/ })).not.toBeInTheDocument()
      expect(resources.fetchDependencyCandidates).not.toHaveBeenCalled()
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
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null,
  created_at: '', updated_at: '', team, workstreams: [], deliverables: [del], milestones: [], dependencies: [],
}
const end = (id: number, start: string, endD: string) => ({ id, name: `n${id}`, team_name: 'T', roadmap_id: 1, start_date: start, end_date: endD })
const edges: DependencyEdge[] = [
  { from_kind: 'deliverable', from_id: 5, to_kind: 'deliverable', to_id: 10, other: end(5, '2026-02-01', '2026-03-05') },
  { from_kind: 'deliverable', from_id: 10, to_kind: 'deliverable', to_id: 6, other: end(6, '2026-05-01', '2026-06-01') },
]

describe('REQ_DEP_004/006 edit form date bounds', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    roadmap.dependencies = roadmapDeps(edges, { kind: 'deliverable', ...end(10, del.start_date, del.end_date) })
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
  })

  it('REQ_DEP_006 shows the earliest allowed start and latest allowed end, and does not save a start before or an end after them', async () => {
    const mount = async () => {
      cleanup()
      render(<DeliverableEditForm deliverable={del} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)
      return screen.findByTestId('start-limit')
    }
    await step('the bounds are shown', async () => {
      expect(await mount()).toHaveTextContent('Earliest start Mar 6, 2026')
      expect(screen.getByTestId('end-limit')).toHaveTextContent('Latest end Apr 30, 2026')
    })
    await step('a start before the earliest allowed start is not saved', async () => {
      await mount()
      const start = screen.getByLabelText('Start date')
      fireEvent.change(start, { target: { value: '2026-03-01' } })
      fireEvent.blur(start)
      expect(await screen.findByRole('alert')).toHaveTextContent('Can’t start before Mar 6, 2026')
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })
    await step('an end after the latest allowed end is not saved', async () => {
      await mount()
      const endInput = screen.getByLabelText('End date')
      fireEvent.change(endInput, { target: { value: '2026-05-15' } })
      fireEvent.blur(endInput)
      expect(await screen.findByRole('alert')).toHaveTextContent('Can’t end after Apr 30, 2026')
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })
    await step('a server 409 date_order the form did not know about is shown with the formatted date', async () => {
      vi.mocked(resources.patchDeliverable).mockRejectedValue({
        response: { data: { error: { code: 'date_order', message: 'm', earliest_start: '2026-03-06' } } },
      })
      cleanup()
      render(<DeliverableEditForm deliverable={del} team={team} workstreams={[]} roadmap={{ ...roadmap, dependencies: [] }} onSaved={vi.fn()} />)
      const start = screen.getByLabelText('Start date')
      fireEvent.change(start, { target: { value: '2026-03-01' } })
      fireEvent.blur(start)
      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent('Can’t start before Mar 6, 2026')
      expect(alert).not.toHaveTextContent('2026-03-06')
      expect(alert).not.toHaveTextContent('Could not save')
    })
  })
})
