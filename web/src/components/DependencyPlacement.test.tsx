// REQ_DEP_006 / REQ_DEP_008 in the two places a deliverable is edited: the side panel's quick-edit
// form and the full edit window. Both mount the same form, so each requirement is checked by
// rendering each surface, not by trusting that they share a component.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { EditModal } from './EditModal'
import { SidePanel } from './SidePanel'
import * as resources from '../api/resources'
import { step } from '../testSteps'
import { roadmapDeps } from '../test/deps'
import type { Candidate, Deliverable, DependencyEdge, RoadmapFull } from '../api/types'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

const del: Deliverable = {
  id: 10, roadmap_id: 1, team_id: 1, name: 'Mid', start_date: '2026-03-10', end_date: '2026-04-10',
  color: '#2f6bd7', responsible_person: '', description_html: '', status: 'planned', risk_note: '',
  icons: [], workstream_ids: [1], workstreams: [{ id: 1, row: 0 }], links: [], created_at: '', updated_at: '',
}
const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null,
  created_at: '', updated_at: '',
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [{ id: 1, roadmap_id: 1, name: 'General', position: 0 }], deliverables: [del], milestones: [], dependencies: [],
}
const end = (id: number, start: string, endD: string) => ({ id, name: `n${id}`, team_name: 'T', roadmap_id: 1, start_date: start, end_date: endD })
// one prerequisite ending 2026-03-05, one dependent starting 2026-05-01
const edges: DependencyEdge[] = [
  { from_kind: 'deliverable', from_id: 5, to_kind: 'deliverable', to_id: 10, other: end(5, '2026-02-01', '2026-03-05') },
  { from_kind: 'deliverable', from_id: 10, to_kind: 'deliverable', to_id: 6, other: end(6, '2026-05-01', '2026-06-01') },
]
const candidates: Candidate[] = [
  { id: 21, name: 'Signup', team_id: 2, team_name: 'Growth', team_tag: 'GRO', roadmap_id: 2, start_date: '2026-01-01', end_date: '2026-01-31', blocked: null },
  { id: 22, name: 'Billing', team_id: 3, team_name: 'Payments', team_tag: 'PAY', roadmap_id: 3, start_date: '2026-06-01', end_date: '2026-07-01', blocked: 'ends_too_late' },
]

function openInSidePanel() {
  render(
    <SidePanel roadmap={roadmap} selection={{ id: 10, type: 'deliverable' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />,
  )
  fireEvent.click(screen.getByText('Edit'))
}
const openInModal = () => render(<EditModal deliverable={del} roadmap={roadmap} onClose={vi.fn()} onSaved={vi.fn()} />)

beforeEach(() => {
  vi.resetAllMocks()
  roadmap.dependencies = roadmapDeps(edges, { kind: 'deliverable', ...end(10, del.start_date, del.end_date) })
  vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue(candidates)
})

describe('REQ_DEP_006 side panel shows the date bounds and refuses a violating date', () => {
  it('REQ_DEP_006 the side panel and the full edit window show the earliest allowed start and the latest allowed end, and the side panel refuses a start or an end outside them', async () => {
    await step('the side panel shows the earliest allowed start and the latest allowed end', async () => {
      openInSidePanel()
      const startLimit = await screen.findByTestId('start-limit')
      expect(within(screen.getByTestId('side-panel')).getByTestId('start-limit')).toBe(startLimit)
      expect(startLimit).toHaveTextContent('Earliest start Mar 6, 2026 — n5 ends Mar 5, 2026') // REQ_FE_120: the day after the prerequisite ends
      expect(screen.getByTestId('end-limit')).toHaveTextContent('Latest end Apr 30, 2026 — n6 starts May 1, 2026') // the day before the dependent starts
    })
    cleanup()
    await step('the side panel refuses to save a start earlier than the earliest allowed start, and the boundary day itself is not refused', async () => {
      openInSidePanel()
      await screen.findByTestId('start-limit')
      const start = screen.getByLabelText('Start date')
      fireEvent.change(start, { target: { value: '2026-03-05' } }) // the prerequisite's end day: one day too early
      fireEvent.blur(start)
      expect(await screen.findByRole('alert')).toHaveTextContent('Can’t start before Mar 6, 2026 — n5 ends Mar 5, 2026')
      expect(resources.patchDeliverable).not.toHaveBeenCalled()

      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...del, start_date: '2026-03-06' })
      fireEvent.change(start, { target: { value: '2026-03-06' } })
      fireEvent.blur(start)
      await vi.waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledTimes(1))
      expect(vi.mocked(resources.patchDeliverable).mock.calls[0][1]).toMatchObject({ start_date: '2026-03-06' })
    })
    cleanup()
    vi.mocked(resources.patchDeliverable).mockReset()
    await step('the side panel refuses to save an end later than the latest allowed end', async () => {
      openInSidePanel()
      await screen.findByTestId('start-limit')
      const endInput = screen.getByLabelText('End date')
      fireEvent.change(endInput, { target: { value: '2026-05-01' } }) // the dependent's start day: one day too late
      fireEvent.blur(endInput)
      expect(await screen.findByRole('alert')).toHaveTextContent('Can’t end after Apr 30, 2026 — n6 starts May 1, 2026')
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })
    cleanup()
    await step('the full edit window shows the same bounds', async () => {
      openInModal()
      expect(await screen.findByTestId('start-limit')).toHaveTextContent('Earliest start Mar 6, 2026 — n5 ends Mar 5, 2026')
      expect(screen.getByTestId('end-limit')).toHaveTextContent('Latest end Apr 30, 2026 — n6 starts May 1, 2026')
    })
  })
})

describe('REQ_DEP_008 the same searchable picker is in the side panel and in the full edit window', () => {
  async function expectPicker() {
    const search = await screen.findByLabelText('Search deliverables and milestones')
    expect(search).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'GRO - Signup' })).toBeInTheDocument() // tag-labelled, no team groups
    expect(screen.getByRole('option', { name: /PAY - Billing/ })).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'sign' } })
    expect(screen.getByRole('option', { name: /Signup/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Billing/ })).not.toBeInTheDocument()
  }

  it('REQ_DEP_008 the side panel quick-edit form and the full edit window both have the picker, searchable and tag-labelled, and ask the server for the candidates of the deliverable being edited', async () => {
    await step('the side panel quick-edit form has the picker, searchable and tag-labelled', async () => {
      openInSidePanel()
      await expectPicker()
      expect(resources.fetchDependencyCandidates).toHaveBeenCalledWith(10, 'deliverable')
    })
    cleanup()
    vi.mocked(resources.fetchDependencyCandidates).mockClear()
    await step('the full edit window has the picker, searchable and tag-labelled', async () => {
      openInModal()
      await expectPicker()
      expect(resources.fetchDependencyCandidates).toHaveBeenCalledWith(10, 'deliverable')
    })
  })
})
