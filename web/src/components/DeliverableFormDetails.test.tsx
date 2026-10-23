// REQ_FE_120 / REQ_FE_121: the shared deliverable form's date limits and details.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DeliverableEditForm } from './DeliverableEditForm'
import { DependenciesField } from './DependencyPicker'
import * as resources from '../api/resources'
import type { Deliverable, DependencyEdge, RoadmapFull, Team, Workstream } from '../api/types'
import { step } from '../testSteps'
import { roadmapDeps } from '../test/deps'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

const team: Team = { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' }
const del: Deliverable = {
  id: 10, roadmap_id: 1, team_id: 1, name: 'Mid', start_date: '2026-03-10', end_date: '2026-04-10',
  color: '#2f6bd7', responsible_person: '', description_html: '', status: 'planned', risk_note: '',
  icons: [], workstream_ids: [1], workstreams: [{ id: 1, row: 0 }], links: [], created_at: '', updated_at: '',
}
const ws: Workstream[] = [{ id: 1, roadmap_id: 1, name: 'Core', position: 0 }]
const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null, created_at: '', updated_at: '',
  team, workstreams: ws, deliverables: [del], milestones: [], dependencies: [],
}
const end = (id: number, name: string, start: string, endD: string) => ({ id, name, team_name: 'T', roadmap_id: 1, start_date: start, end_date: endD })
const edges: DependencyEdge[] = [
  { from_kind: 'deliverable', from_id: 5, to_kind: 'deliverable', to_id: 10, other: end(5, 'Design', '2026-02-01', '2026-03-02') },
  { from_kind: 'deliverable', from_id: 10, to_kind: 'deliverable', to_id: 6, other: end(6, 'Launch', '2026-04-10', '2026-06-01') },
]

function renderForm(d: Deliverable = del) {
  return render(<DeliverableEditForm deliverable={d} team={team} workstreams={ws} roadmap={roadmap} onSaved={vi.fn()} />)
}

// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function fresh() {
  cleanup()
  vi.resetAllMocks()
  roadmap.dependencies = roadmapDeps(edges, { kind: 'deliverable', ...end(10, del.name, del.start_date, del.end_date) })
  vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
}
beforeEach(fresh)

describe('REQ_FE_120 date limits name the limiting item', () => {
  it('REQ_FE_120 each date shows its limit and the inputs carry min and max; without dependencies the hints say nothing limits the dates and there is no min or max; the picker lists a prerequisite with its end date in US format', async () => {
    await step('each date shows its limit and the inputs carry min and max', async () => {
      renderForm()
      expect(await screen.findByText('Earliest start Mar 3, 2026 — Design ends Mar 2, 2026')).toBeInTheDocument()
      expect(screen.getByText('Latest end Apr 9, 2026 — Launch starts Apr 10, 2026')).toBeInTheDocument()
      expect(screen.getByLabelText('Start date')).toHaveAttribute('min', '2026-03-03')
      expect(screen.getByLabelText('End date')).toHaveAttribute('max', '2026-04-09')
    })

    await step('without dependencies the hints say nothing limits the dates and there is no min or max', async () => {
      fresh()
      roadmap.dependencies = []
      renderForm()
      await screen.findByLabelText('Search deliverables and milestones') // the dependencies have loaded
      expect(screen.getByText('No prerequisite limits the start')).toBeInTheDocument()
      expect(screen.getByText('No dependent limits the end')).toBeInTheDocument()
      expect(screen.getByLabelText('Start date')).not.toHaveAttribute('min')
    })

    await step('the picker lists a prerequisite with its end date in US format', async () => {
      fresh()
      render(<DependenciesField item={{ kind: 'deliverable', id: 10 }} edges={[edges[0]]} onChanged={vi.fn()} />)
      expect(await screen.findByText(/ends Mar 2, 2026/)).toBeInTheDocument()
    })
  })

  it('REQ_FE_120 a date the server refuses names the item in US format', async () => {
    vi.mocked(resources.patchDeliverable).mockRejectedValue({
      response: { data: { error: { code: 'date_order', message: 'm', earliest_start: '2026-03-03' } } },
    })
    renderForm({ ...del, end_date: '2026-04-09' })
    await screen.findByText('Earliest start Mar 3, 2026 — Design ends Mar 2, 2026')
    // The boundary day passes the client check, so the request goes out and the server's 409 is what is shown.
    const start = screen.getByLabelText('Start date')
    fireEvent.change(start, { target: { value: '2026-03-03' } })
    fireEvent.blur(start)
    expect(await screen.findByRole('alert')).toHaveTextContent('Can’t start before Mar 3, 2026 — Design ends Mar 2, 2026')
  })
})

describe('REQ_FE_121 form details', () => {
  it('REQ_FE_121 unticking the last workstream shows the message and saves nothing; the risk note box is tinted red and the icon tiles are labelled "Icon labels"; a link row has a 1/3 label and a 2/3 URL, and Add link focuses the new label', async () => {
    await step('unticking the last workstream shows the message and saves nothing', () => {
      renderForm()
      fireEvent.click(screen.getByRole('checkbox', { name: /Core/ }))
      expect(screen.getByRole('alert')).toHaveTextContent('At least one workstream is required')
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })

    await step('the risk note box is tinted red and the icon tiles are labelled "Icon labels"', () => {
      fresh()
      renderForm({ ...del, status: 'at_risk', risk_note: 'x' })
      expect(screen.getByPlaceholderText(/What is the risk/)).toHaveClass('risk-note')
      expect(screen.getByText('Icon labels')).toBeInTheDocument()
      expect(screen.queryByText('Icons')).not.toBeInTheDocument()
    })

    await step('a link row has a 1/3 label with its placeholder and 40 character limit, a 2/3 URL, and Add link focuses the new label', async () => {
      fresh()
      renderForm()
      fireEvent.click(screen.getByRole('button', { name: '+ Add link' }))
      const label = screen.getByLabelText('Link label')
      expect(label).toHaveAttribute('placeholder', 'Label, e.g. Jira epic')
      expect(label).toHaveAttribute('maxlength', '40')
      expect(label).toHaveClass('basis-1/3')
      expect(screen.getByLabelText('Link URL')).toHaveClass('basis-2/3')
      await waitFor(() => expect(label).toHaveFocus())
    })

    await step('removing a link row saves the set without it', async () => {
      fresh()
      vi.mocked(resources.patchDeliverable).mockResolvedValue(del)
      renderForm({ ...del, links: [{ id: 1, position: 0, label: 'RFC', url: 'https://rfc.example.com' }] })
      fireEvent.click(screen.getByRole('button', { name: 'Remove link RFC' }))
      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { links: [] }))
    })

    await step('the Depends on hint says "this deliverable" for a deliverable and "this milestone" for a milestone', async () => {
      fresh()
      render(<DependenciesField item={{ kind: 'deliverable', id: 10 }} edges={[]} onChanged={vi.fn()} />)
      expect(screen.getByTestId('dep-hint')).toHaveTextContent('A prerequisite must end before this deliverable starts. Greyed options say why.')
      cleanup()
      render(<DependenciesField item={{ kind: 'milestone', id: 3 }} edges={[]} onChanged={vi.fn()} itemKind="milestone" />)
      expect(screen.getByTestId('dep-hint')).toHaveTextContent('A prerequisite must end before this milestone starts. Greyed options say why.')
    })
  })
})
