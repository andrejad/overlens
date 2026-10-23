import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { SidePanel } from './SidePanel'
import * as resources from '../api/resources'
import { CanEditProvider } from '../lib/canEdit'
import type { RoadmapFull } from '../api/types'
import { step } from '../testSteps'
import { roadmapDeps } from '../test/deps'

vi.mock('../api/resources')
// TipTap needs a real DOM editor; a textarea that commits on blur stands in for the shared DescriptionEditor.
vi.mock('./DescriptionEditor', () => ({
  DescriptionEditor: ({ html, onCommit }: { html: string; onCommit: (h: string) => void }) => (
    <textarea aria-label="Description editor" defaultValue={html} onBlur={(e) => onCommit(e.target.value)} />
  ),
}))

const end = (id: number, name: string, s: string, e: string, kind?: 'milestone') => ({ kind, id, name, team_name: 'Billing', roadmap_id: 2, start_date: s, end_date: e })

const roadmap: RoadmapFull = {
  id: 1,
  team_id: 1,
  title: 'Plan',
 
  range_start: null,
  range_end: null,
  created_at: '',
  updated_at: '',
 
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [
    { id: 1, roadmap_id: 1, name: 'Core', position: 0 },
    { id: 2, roadmap_id: 1, name: 'Mobile', position: 1 },
  ] as RoadmapFull['workstreams'],
  deliverables: [],
  milestones: [
    { id: 20, roadmap_id: 1, workstream_id: 1, name: 'Launch', date: '2026-03-01', row: 0, description_html: '<p>Go <b>live</b></p>' },
    { id: 21, roadmap_id: 1, workstream_id: 2, name: 'Neighbour', date: '2026-03-10', row: 0, description_html: '' },
  ],
  dependencies: [
    { from_kind: 'deliverable', from_id: 11, to_kind: 'milestone', to_id: 20, from: end(11, 'Prereq', '2026-01-01', '2026-02-01'), to: end(20, 'Launch', '2026-03-01', '2026-03-01', 'milestone') },
    { from_kind: 'milestone', from_id: 20, to_kind: 'deliverable', to_id: 12, from: end(20, 'Launch', '2026-03-01', '2026-03-01', 'milestone'), to: end(12, 'After', '2026-04-01', '2026-05-01') },
  ] as RoadmapFull['dependencies'],
}

const panel = (extra: Partial<React.ComponentProps<typeof SidePanel>> = {}, rm = roadmap) => (
  <SidePanel roadmap={rm} selection={{ id: 20, type: 'milestone' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} {...extra} />
)
const edit = () => fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
const blurDate = (v: string) => {
  const el = screen.getByLabelText('Date')
  fireEvent.focus(el)
  fireEvent.change(el, { target: { value: v } })
  fireEvent.blur(el)
}

// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function setup() {
  cleanup()
  vi.resetAllMocks()
  window.localStorage.clear()
  vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
  vi.mocked(resources.patchMilestone).mockResolvedValue(roadmap.milestones[0])
}
beforeEach(setup)

describe('REQ_FE_024 milestone view mode', () => {
  it('REQ_FE_024 REQ_FE_100 shows date, workstream, team, the description and the read-only lists, with no explanatory text; an empty description shows nothing; a read-only visitor sees the lists but no Edit, (move) or Delete', async () => {
    await step('shows date, workstream, team, the description and the read-only lists, with no explanatory text', () => {
      render(panel())
      expect(screen.getByRole('heading', { name: 'Launch' })).toBeInTheDocument()
      expect(screen.getByText('Mar 1, 2026 (Sun)')).toBeInTheDocument()
      expect(screen.getByText('Core')).toBeInTheDocument()
      expect(screen.getByText('Onboarding')).toBeInTheDocument()
      expect(screen.getByTestId('milestone-description').innerHTML).toBe('<p>Go <b>live</b></p>')
      expect(screen.getByTestId('panel-depends-on')).toHaveTextContent('Prereq')
      expect(screen.getByTestId('panel-blocks')).toHaveTextContent('After')
      expect(screen.queryByText(/can be|dragging|drag /i)).not.toBeInTheDocument()
    })

    await step('an empty description shows nothing', () => {
      setup()
      render(panel({ selection: { id: 21, type: 'milestone' } }))
      expect(screen.queryByTestId('milestone-description')).not.toBeInTheDocument()
    })

    await step('a read-only visitor sees the lists but no Edit, (move) or Delete', () => {
      setup()
      render(<CanEditProvider value={false}>{panel()}</CanEditProvider>)
      expect(screen.getByTestId('panel-depends-on')).toHaveTextContent('Prereq')
      expect(screen.getByTestId('panel-blocks')).toHaveTextContent('After')
      expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()
      expect(screen.queryByTestId('panel-delete')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '(move)' })).not.toBeInTheDocument()
    })
  })
})

describe('REQ_FE_100 milestone edit mode', () => {
  it('REQ_FE_100 Edit is in the panel header and the form has Name, Date, Workstream, Responsible, Status, Description, Links, Team (move), Depends on in that order; Done returns to view mode and sends nothing', async () => {
    await step('Edit is in the panel header and the form has Name, Date, Workstream, Responsible, Status, Description, Links, Team (move), Depends on in that order', async () => {
      render(panel())
      expect(screen.getByRole('button', { name: /Edit/ }).closest('.p-head')).not.toBeNull()
      edit()
      const form = screen.getByTestId('milestone-edit-form')
      const labels = Array.from(form.querySelectorAll('label')).map((l) => l.textContent)
      expect(labels.slice(0, 8)).toEqual(['Name', 'Date', 'Workstream', 'Responsible person', 'Status', 'Description', 'Links', 'Team'])
      expect(screen.getByRole('button', { name: '(move)' })).toBeInTheDocument()
      expect(await screen.findByLabelText('Search deliverables and milestones')).toBeInTheDocument()
      expect(screen.queryByTestId('dep-bounds')).not.toBeInTheDocument()
    })

    await step('Done returns to view mode and sends nothing', () => {
      setup()
      render(panel())
      edit()
      fireEvent.click(screen.getByTestId('edit-done'))
      expect(screen.queryByTestId('milestone-edit-form')).not.toBeInTheDocument()
      expect(screen.getByText('Mar 1, 2026 (Sun)')).toBeInTheDocument()
      expect(resources.patchMilestone).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /Edit/ })).toHaveFocus()
    })
  })

  it('REQ_FE_026 REQ_FE_100 the name, a valid typed date, the workstream and the description each save by themselves on leaving the field, sending only that field', async () => {
    await step('the name saves by itself on leaving the field and sends only that field', async () => {
      const saved = { ...roadmap.milestones[0], name: 'Go live' }
      vi.mocked(resources.patchMilestone).mockResolvedValue(saved)
      const onUpdated = vi.fn()
      render(panel({ onMilestoneUpdated: onUpdated }))
      edit()
      const name = screen.getByLabelText('Name')
      fireEvent.focus(name)
      fireEvent.change(name, { target: { value: '  Go live ' } })
      fireEvent.blur(name)
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { name: 'Go live' }))
      expect(onUpdated).toHaveBeenCalledWith(saved)
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    })

    await step('a valid typed date saves alone', async () => {
      setup()
      render(panel())
      edit()
      blurDate('2026-03-05')
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { date: '2026-03-05' }))
    })

    await step('the workstream dropdown lists the workstreams of the roadmap and saves only workstream_id', async () => {
      setup()
      render(panel())
      edit()
      const select = screen.getByLabelText('Workstream', { selector: 'select' })
      expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Core', 'Mobile'])
      fireEvent.change(select, { target: { value: '2' } })
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { workstream_id: 2 }))
    })

    await step('the description saves by itself with only description_html', async () => {
      setup()
      render(panel())
      edit()
      const d = screen.getByLabelText('Description editor')
      fireEvent.change(d, { target: { value: '<p>New</p>' } })
      fireEvent.blur(d)
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { description_html: '<p>New</p>' }))
    })
  })

  it('REQ_FE_027 an empty name is refused under the field and nothing is sent; a refused workstream change shows the server message under the dropdown', async () => {
    await step('an empty name is refused under the field and nothing is sent', () => {
      render(panel())
      edit()
      const name = screen.getByLabelText('Name')
      fireEvent.change(name, { target: { value: '  ' } })
      fireEvent.blur(name)
      expect(screen.getByRole('alert')).toHaveTextContent('A milestone needs a name')
      expect(name).toHaveClass('bad')
      expect(resources.patchMilestone).not.toHaveBeenCalled()
    })

    await step('a refused workstream change shows the server message under the dropdown', async () => {
      setup()
      vi.mocked(resources.patchMilestone).mockRejectedValue({ response: { data: { error: { message: 'No such workstream' } } } })
      render(panel())
      edit()
      fireEvent.change(screen.getByLabelText('Workstream', { selector: 'select' }), { target: { value: '2' } })
      expect(await screen.findByRole('alert')).toHaveTextContent('No such workstream')
    })
  })

  it('REQ_FE_100 REQ_DEP_026 the allowed range is shown under the date in US format, naming the limiting items; a date the server refuses stays typed with the allowed range under it', async () => {
    await step('the allowed range is shown under the date in US format, naming the limiting items', async () => {
      const dependencies = roadmapDeps([
        { from_kind: 'deliverable', to_kind: 'milestone', from_id: 11, to_id: 20, other: end(11, 'Prereq', '2026-01-01', '2026-02-20') },
        { from_kind: 'milestone', to_kind: 'deliverable', from_id: 20, to_id: 12, other: end(12, 'After', '2026-04-01', '2026-05-01') },
      ], end(20, 'Launch', '2026-03-01', '2026-03-01', 'milestone'))
      render(panel({}, { ...roadmap, dependencies }))
      edit()
      await waitFor(() => expect(screen.getByTestId('date-limit')).toHaveTextContent('Earliest date Feb 21, 2026 — Prereq ends Feb 20, 2026'))
      expect(screen.getByTestId('date-limit-latest')).toHaveTextContent('Latest date Mar 31, 2026 — After starts Apr 1, 2026')
      blurDate('2026-02-10')
      expect(screen.getByRole('alert')).toHaveTextContent('Can’t be before Feb 21, 2026 — Prereq ends Feb 20, 2026')
      expect(screen.getByLabelText('Date')).toHaveValue('2026-02-10')
      expect(resources.patchMilestone).not.toHaveBeenCalled()
    })

    await step('a date the server refuses stays typed with the allowed range in US format under it', async () => {
      setup()
      vi.mocked(resources.patchMilestone).mockRejectedValue({
        response: { data: { error: { code: 'date_order', message: 'x', earliest_date: '2026-02-21', latest_date: '2026-03-31' } } },
      })
      render(panel({}, { ...roadmap, dependencies: [] })) // no limits known here: only the server refuses
      edit()
      blurDate('2026-04-15')
      expect(await screen.findByRole('alert')).toHaveTextContent('between Feb 21, 2026 and Mar 31, 2026')
      expect(screen.getByLabelText('Date')).toHaveValue('2026-04-15')
    })
  })

  it('REQ_FE_010 a typed date that would collide on the milestone\'s row is refused before sending', () => {
    render(panel({}, { ...roadmap, milestones: [...roadmap.milestones, { id: 22, roadmap_id: 1, workstream_id: 1, name: 'Next to it', date: '2026-03-10', row: 0 }] }))
    edit()
    blurDate('2026-03-12')
    expect(screen.getByRole('alert')).toHaveTextContent('That spot is taken')
    expect(resources.patchMilestone).not.toHaveBeenCalled()
  })

  it('REQ_FE_062 a typed date past the 3-year span is refused with the span message', () => {
    render(panel({}, { ...roadmap, dependencies: [] })) // only the span limits the date
    edit()
    blurDate('2030-06-01')
    expect(screen.getByRole('alert')).toHaveTextContent('Maximum of 3 years of planning exceeded')
    expect(resources.patchMilestone).not.toHaveBeenCalled()
  })

  it('REQ_FE_100 the 200-character limit counts characters like the server, not UTF-16 units', async () => {
    const name = '🙂'.repeat(150)
    vi.mocked(resources.patchMilestone).mockResolvedValue({ ...roadmap.milestones[0], name })
    render(panel())
    edit()
    const field = screen.getByLabelText('Name')
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: name } })
    fireEvent.blur(field)
    await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { name }))
    vi.mocked(resources.patchMilestone).mockClear()
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: 'x'.repeat(201) } })
    fireEvent.blur(field)
    expect(screen.getByRole('alert')).toHaveTextContent('at most 200')
    expect(resources.patchMilestone).not.toHaveBeenCalled()
  })
})

describe('REQ_FE_118 milestone delete', () => {
  it('REQ_FE_118 REQ_FE_090 the delete dialog names the milestone and counts its dependency links in both directions; Cancel sends nothing; Delete sends DELETE once and reports the removal; a milestone without links has no links line and a refused delete keeps the dialog open with the message', async () => {
    await step('the dialog names the milestone and counts its dependency links in both directions; Cancel sends nothing', () => {
      render(panel())
      fireEvent.click(screen.getByTestId('panel-delete'))
      expect(screen.getByText('Delete "Launch"?')).toBeInTheDocument()
      expect(screen.getByText('Its 2 dependency links are removed too.')).toBeInTheDocument()
      expect(screen.queryByText(/disappears from all/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByTestId('delete-item-dialog')).not.toBeInTheDocument()
      expect(resources.deleteMilestone).not.toHaveBeenCalled()
    })

    await step('Delete sends DELETE once and reports the removal', async () => {
      setup()
      vi.mocked(resources.deleteMilestone).mockResolvedValue(undefined)
      const onDeleted = vi.fn()
      render(panel({ onMilestoneDeleted: onDeleted }))
      fireEvent.click(screen.getByTestId('panel-delete'))
      fireEvent.click(screen.getByTestId('delete-item-confirm'))
      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(20))
      expect(resources.deleteMilestone).toHaveBeenCalledWith(20)
    })

    await step('a milestone without links has no links line; a refused delete keeps the dialog open with the message', async () => {
      setup()
      vi.mocked(resources.deleteMilestone).mockRejectedValue({ response: { data: { error: { message: 'Nope' } } } })
      render(panel({ selection: { id: 21, type: 'milestone' } }))
      fireEvent.click(screen.getByTestId('panel-delete'))
      expect(screen.queryByText(/dependency links/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('delete-item-confirm'))
      expect(await screen.findByRole('alert')).toHaveTextContent('Nope')
      expect(screen.getByTestId('delete-item-dialog')).toBeInTheDocument()
    })
  })
})
