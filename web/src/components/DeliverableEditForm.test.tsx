import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DeliverableEditForm } from './DeliverableEditForm'
import * as resources from '../api/resources'
import { CAP_MESSAGE } from '../timeline/axis'
import type { Deliverable, RoadmapFull, Team, Workstream } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({
  useEditor: () => null,
  EditorContent: () => null,
}))

const team: Team = { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' }

const deliverable: Deliverable = {
  id: 10,
  roadmap_id: 1,
  team_id: 1,
  name: 'Signup Flow',
  start_date: '2026-01-01',
  end_date: '2026-02-01',
  color: '#2f6bd7',
  responsible_person: 'Alex',
  description_html: '',
  status: 'planned',
  risk_note: '',
  icons: [],
  workstream_ids: [],
  workstreams: [],
  links: [],
  created_at: '',
  updated_at: '',
}

// M1/M4: the form now needs the full roadmap (for pack.ts/drag.ts's read-only wall and cap checks),
// not just the one deliverable — this is the default, minimal fixture most tests render against.
const roadmap: RoadmapFull = {
  id: 1,
  team_id: 1,
  title: 'Plan',
 
  range_start: null,
  range_end: null,
  created_at: '',
  updated_at: '',
 
  team,
  workstreams: [],
  deliverables: [deliverable],
  milestones: [],
  dependencies: [],
}

describe('REQ_FE_026/027 deliverable quick-edit autosave', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_FE_026 a valid text field saves on blur, sending only that field; a non-text control (status) saves the instant it is clicked', async () => {
    await step('a valid text field saves on blur, sending only that field', async () => {
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, name: 'Renamed' })
      const onSaved = vi.fn()
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={onSaved} />)

      const input = screen.getByLabelText('Title')
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.blur(input)

      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { name: 'Renamed' }))
      expect(onSaved).toHaveBeenCalled()
    })

    await step('a non-text control (status) saves the instant it is clicked', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, status: 'in_progress' })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'In progress' }))

      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { status: 'in_progress' }))
    })
  })

  it('REQ_FE_027 an invalid value shows its error inline, keeps what was typed, and does not save; an invalid field does not affect other valid fields; invalid fields get a red border (HEX, empty title, reversed dates, a rejected responsible-person save, a bad link)', async () => {
    await step('an invalid value shows its error inline, keeps what was typed, and does not save', () => {
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      const input = screen.getByLabelText('Title') as HTMLInputElement
      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.blur(input)

      expect(screen.getByRole('alert')).toHaveTextContent('A title is required')
      expect(input.value).toBe('   ')
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })

    await step('an invalid field does not affect other, already-valid fields', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, responsible_person: 'Jamie' })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      const responsible = screen.getByLabelText('Responsible person')
      fireEvent.change(responsible, { target: { value: 'Jamie' } })
      fireEvent.blur(responsible)
      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { responsible_person: 'Jamie' }))

      const nameInput = screen.getByLabelText('Title') as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: '' } })
      fireEvent.blur(nameInput)

      expect(screen.getByRole('alert')).toHaveTextContent('A title is required')
      expect((responsible as HTMLInputElement).value).toBe('Jamie')
    })

    await step('an invalid HEX gets a red border next to its message and is not saved', () => {
      cleanup()
      vi.resetAllMocks()
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)
      const hex = screen.getByLabelText('Deliverable color')
      fireEvent.change(hex, { target: { value: '#12' } })
      fireEvent.blur(hex)
      expect(hex).toHaveClass('bad')
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a color as #rrggbb')
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })

    await step('an empty title and a reversed date range get the red border', () => {
      cleanup()
      vi.resetAllMocks()
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)
      const name = screen.getByLabelText('Title')
      fireEvent.change(name, { target: { value: '' } })
      fireEvent.blur(name)
      expect(name).toHaveClass('bad')
      const end = screen.getByLabelText('End date')
      fireEvent.change(end, { target: { value: '2025-01-01' } })
      fireEvent.blur(end)
      expect(end).toHaveClass('bad')
      expect(screen.getByLabelText('Start date')).toHaveClass('bad')
    })

    await step('a rejected responsible-person save and a bad link get the red border', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockRejectedValue({ response: { data: { error: { message: 'too long' } } } })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)
      const r = screen.getByLabelText('Responsible person')
      fireEvent.change(r, { target: { value: 'x' } })
      fireEvent.blur(r)
      await waitFor(() => expect(r).toHaveClass('bad'))
      fireEvent.click(screen.getByRole('button', { name: '+ Add link' }))
      fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'nope' } })
      fireEvent.blur(screen.getByLabelText('Link URL'))
      expect(screen.getByLabelText('Link URL')).toHaveClass('bad')
      expect(screen.getByLabelText('Link label')).toHaveClass('bad')
    })
  })
  // An open form must not re-send stale values for fields the user never touched, once something else
  // (a drag, or the other mounted instance of this same form) changes the deliverable out from under it.
  it('REQ_FE_026 an external update to the deliverable (e.g. a drag) is not undone by blurring an untouched field; a field actively focused when an external update arrives keeps the user’s in-progress typing', async () => {
    await step('an external update to the deliverable (e.g. a drag) is not undone by blurring an untouched field', async () => {
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, responsible_person: 'Jamie' })
      const { rerender } = render(
        <DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />,
      )

      // Something else (a drag on the timeline) changes the dates while this form stays open.
      const dragged = { ...deliverable, start_date: '2026-03-01', end_date: '2026-03-15' }
      rerender(<DeliverableEditForm deliverable={dragged} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      // The user never touched the date fields; blurring an untouched field elsewhere (Responsible)
      // must not re-send the pre-drag dates.
      const responsible = screen.getByLabelText('Responsible person')
      fireEvent.change(responsible, { target: { value: 'Jamie' } })
      fireEvent.blur(responsible)

      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { responsible_person: 'Jamie' }))
      expect(resources.patchDeliverable).not.toHaveBeenCalledWith(10, expect.objectContaining({ start_date: expect.anything() }))
      expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe('2026-03-01')
    })

    await step('a field actively focused when an external update arrives keeps the user’s in-progress typing', async () => {
      cleanup()
      vi.resetAllMocks()
      const { rerender } = render(
        <DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />,
      )

      const name = screen.getByLabelText('Title') as HTMLInputElement
      fireEvent.focus(name)
      fireEvent.change(name, { target: { value: 'Still typing' } })

      // An external update (e.g. the full modal saving a different field) arrives while Title is focused.
      const updated = { ...deliverable, responsible_person: 'Someone else' }
      rerender(<DeliverableEditForm deliverable={updated} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      expect(name.value).toBe('Still typing')
    })
  })

  it('REQ_FE_026 changing both start and end sends them in one PATCH, not two sequential requests; changing only one date field still sends just that field', async () => {
    await step('changing both start and end sends them in one PATCH, not two sequential requests', async () => {
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, start_date: '2026-03-01', end_date: '2026-03-31' })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-03-01' } })
      fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-03-31' } })
      fireEvent.blur(screen.getByLabelText('End date'))

      await waitFor(() =>
        expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { start_date: '2026-03-01', end_date: '2026-03-31' }),
      )
      // Exactly one request for the pair — not a start_date request followed by a separate end_date one,
      // which could otherwise 422 on the first (against the *old* stored end) and still apply the second.
      expect(resources.patchDeliverable).toHaveBeenCalledTimes(1)
    })

    await step('changing only one date field still sends just that field', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, end_date: '2026-02-15' })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      const end = screen.getByLabelText('End date')
      fireEvent.change(end, { target: { value: '2026-02-15' } })
      fireEvent.blur(end)

      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { end_date: '2026-02-15' }))
    })
  })
  // pack.ts's sticky tie-break could otherwise resolve a typed-date conflict by silently relocating a
  // completely different, untouched deliverable to another row — a side effect REQ_FE_013 (a hard rule)
  // forbids. The edit itself must be rejected instead.
  it('REQ_FE_013 a typed date that would overlap an untouched neighbour in the same row is rejected, not silently relocating the neighbour; an edit into a free gap in the same row still saves normally', async () => {
    await step('a typed date that would overlap an untouched neighbour in the same row is rejected, not silently relocating the neighbour', () => {
      const ws1: Workstream = { id: 1, roadmap_id: 1, name: 'Self-Serve', position: 0 }
      const rowDeliverable: Deliverable = { ...deliverable, workstream_ids: [1], workstreams: [{ id: 1, row: 0 }] }
      const neighbor: Deliverable = {
        ...deliverable,
        id: 11,
        name: 'Neighbor',
        start_date: '2026-03-01',
        end_date: '2026-03-31',
        workstream_ids: [1],
        workstreams: [{ id: 1, row: 0 }],
      }
      const rm: RoadmapFull = { ...roadmap, workstreams: [ws1], deliverables: [rowDeliverable, neighbor] }

      render(<DeliverableEditForm deliverable={rowDeliverable} team={team} workstreams={[ws1]} roadmap={rm} onSaved={vi.fn()} />)

      const end = screen.getByLabelText('End date')
      fireEvent.change(end, { target: { value: '2026-03-15' } }) // overlaps the neighbour's 2026-03-01–03-31
      fireEvent.blur(end)

      expect(screen.getByRole('alert')).toHaveTextContent(/overlap another item/i)
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })

    await step('an edit into a free gap in the same row still saves normally', async () => {
      cleanup()
      vi.resetAllMocks()
      const ws1: Workstream = { id: 1, roadmap_id: 1, name: 'Self-Serve', position: 0 }
      const rowDeliverable: Deliverable = { ...deliverable, workstream_ids: [1], workstreams: [{ id: 1, row: 0 }] }
      const neighbor: Deliverable = {
        ...deliverable,
        id: 11,
        name: 'Neighbor',
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        workstream_ids: [1],
        workstreams: [{ id: 1, row: 0 }],
      }
      const rm: RoadmapFull = { ...roadmap, workstreams: [ws1], deliverables: [rowDeliverable, neighbor] }
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...rowDeliverable, end_date: '2026-02-15' })

      render(<DeliverableEditForm deliverable={rowDeliverable} team={team} workstreams={[ws1]} roadmap={rm} onSaved={vi.fn()} />)

      const end = screen.getByLabelText('End date')
      fireEvent.change(end, { target: { value: '2026-02-15' } }) // well clear of the neighbour in June
      fireEvent.blur(end)

      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { end_date: '2026-02-15' }))
    })
  })
  // M4 (review finding): the 3-year cap must be checked before the request is sent, with the exact
  // wording REQ_FE_062 requires, not just relayed from whatever the server's 409 happens to say.
  it('REQ_FE_062 a typed date that would push the roadmap past the 3-year cap is blocked client-side with the exact message', () => {
    render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

    const end = screen.getByLabelText('End date')
    fireEvent.change(end, { target: { value: '2030-06-01' } }) // more than 3 years past the start
    fireEvent.blur(end)

    expect(screen.getByRole('alert')).toHaveTextContent(CAP_MESSAGE)
    expect(resources.patchDeliverable).not.toHaveBeenCalled()
  })

  it('REQ_FE_062 an edit that stays inside the roadmap’s already-established range is not blocked, even if that range already exceeds 3 years (e.g. imported data)', async () => {
    const other1: Deliverable = { ...deliverable, id: 20, start_date: '2020-01-01', end_date: '2020-01-06' }
    const other2: Deliverable = { ...deliverable, id: 21, start_date: '2023-01-15', end_date: '2023-01-25' }
    const mid: Deliverable = { ...deliverable, id: 10, start_date: '2020-04-01', end_date: '2020-04-10' }
    const rm: RoadmapFull = { ...roadmap, deliverables: [other1, other2, mid] }
    vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...mid, start_date: '2020-06-01', end_date: '2020-06-10' })

    render(<DeliverableEditForm deliverable={mid} team={team} workstreams={[]} roadmap={rm} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2020-06-01' } })
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2020-06-10' } })
    fireEvent.blur(screen.getByLabelText('End date'))

    await waitFor(() =>
      expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { start_date: '2020-06-01', end_date: '2020-06-10' }),
    )
  })

  // A rejected save on status/responsible/risk/workstream_ids/icons must show its error, never look silently successful.
  it('REQ_FE_027 REQ_FE_080 a rejected status, responsible-person, risk-note, workstream-membership or icon save shows a visible inline error', async () => {
    await step('a rejected status change shows a visible inline error', async () => {
      vi.mocked(resources.patchDeliverable).mockRejectedValue({
        response: { data: { error: { message: 'Status not allowed' } } },
      })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: 'In progress' }))

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Status not allowed'))
    })

    await step('a rejected responsible-person save shows a visible inline error', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockRejectedValue({
        response: { data: { error: { message: 'Responsible person is too long' } } },
      })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)

      const responsible = screen.getByLabelText('Responsible person')
      fireEvent.change(responsible, { target: { value: 'x'.repeat(300) } })
      fireEvent.blur(responsible)

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Responsible person is too long'))
    })

    await step('a rejected risk-note save shows a visible inline error', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockRejectedValue({
        response: { data: { error: { message: 'Risk note too long' } } },
      })
      const atRisk: Deliverable = { ...deliverable, status: 'at_risk', risk_note: 'Existing risk' }
      const rm: RoadmapFull = { ...roadmap, deliverables: [atRisk] }
      render(<DeliverableEditForm deliverable={atRisk} team={team} workstreams={[]} roadmap={rm} onSaved={vi.fn()} />)

      const risk = screen.getByPlaceholderText('What is the risk? Shown on hover and in the panel.')
      fireEvent.change(risk, { target: { value: 'New risk text' } })
      fireEvent.blur(risk)

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Risk note too long'))
    })

    await step('a rejected workstream-membership change shows a visible inline error', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockRejectedValue({
        response: { data: { error: { message: 'Workstream not found' } } },
      })
      const ws1: Workstream = { id: 1, roadmap_id: 1, name: 'Self-Serve', position: 0 }
      const ws2: Workstream = { id: 2, roadmap_id: 1, name: 'Mobile', position: 1 }
      const d: Deliverable = {
        ...deliverable,
        workstream_ids: [1, 2],
        workstreams: [{ id: 1, row: 0 }, { id: 2, row: 0 }],
      }
      const rm: RoadmapFull = { ...roadmap, workstreams: [ws1, ws2], deliverables: [d] }
      render(<DeliverableEditForm deliverable={d} team={team} workstreams={[ws1, ws2]} roadmap={rm} onSaved={vi.fn()} />)

      fireEvent.click(screen.getAllByRole('checkbox')[0])

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Workstream not found'))
    })

    await step('a rejected icon save shows a visible inline error', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockRejectedValue({
        response: { data: { error: { message: 'icons must be one of the 20 fixed keys' } } },
      })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} icons={[]} onSaved={vi.fn()} />)

      fireEvent.click(screen.getByTitle('High priority'))

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('icons must be one of the 20 fixed keys'))
    })
  })

  it('REQ_FE_080 clicking an icon tile toggles it and saves the whole icons array (autosave on click); clicking an already-selected tile removes it', async () => {
    await step('clicking an icon tile toggles it and saves the whole icons array', async () => {
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, icons: ['star'] })
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} icons={[]} onSaved={vi.fn()} />)

      fireEvent.click(screen.getByTitle('High priority'))

      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { icons: ['star'] }))
    })

    await step('clicking an already-selected icon tile removes it from the array', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, icons: [] })
      const d: Deliverable = { ...deliverable, icons: ['star'] }
      render(<DeliverableEditForm deliverable={d} team={team} workstreams={[]} roadmap={{ ...roadmap, deliverables: [d] }} icons={[]} onSaved={vi.fn()} />)

      fireEvent.click(screen.getByTitle('High priority'))

      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { icons: [] }))
    })
  })

  it('REQ_FE_080 the hover label of an icon tile reflects a fetched admin override, and falls back to the hardcoded default label before GET /api/icons resolves', async () => {
    await step('the hover label of an icon tile reflects a fetched admin override, not just the hardcoded default', () => {
      render(
        <DeliverableEditForm
          deliverable={deliverable}
          team={team}
          workstreams={[]}
          roadmap={roadmap}
          icons={[{ key: 'star', label: 'Must-have' }]}
          onSaved={vi.fn()}
        />,
      )
      expect(screen.getByTitle('Must-have')).toBeInTheDocument()
      expect(screen.queryByTitle('High priority')).not.toBeInTheDocument()
    })

    await step('falls back to the hardcoded default label before GET /api/icons resolves', () => {
      cleanup()
      vi.resetAllMocks()
      render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)
      expect(screen.getByTitle('High priority')).toBeInTheDocument()
    })
  })
})

describe('REQ_DAT_028 link labels use the name trim', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_DAT_028 a link label padded with NBSP and U+200B is saved trimmed', async () => {
    vi.mocked(resources.patchDeliverable).mockResolvedValue(deliverable)
    render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add link' }))
    fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'https://example.com/spec' } })
    const label = screen.getByLabelText('Link label')
    fireEvent.change(label, { target: { value: '\u00a0\u200bSpec\u200b\u00a0' } })
    fireEvent.blur(label)
    await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { links: [{ label: 'Spec', url: 'https://example.com/spec' }] }))
  })

  it('REQ_DAT_028 a label of only U+200B counts as empty', () => {
    render(<DeliverableEditForm deliverable={deliverable} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add link' }))
    fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'https://example.com' } })
    const label = screen.getByLabelText('Link label')
    fireEvent.change(label, { target: { value: '\u200b' } })
    fireEvent.blur(label)
    expect(screen.getByRole('alert')).toHaveTextContent('Each link needs a label')
    expect(resources.patchDeliverable).not.toHaveBeenCalled()
  })
})

describe('REQ_DEP_008 edit form field order', () => {
  it('REQ_DEP_008 the "Depends on" block is last, after Title, dates, Status, Responsible, Team, Color, Icons, Workstreams, Description, Links', () => {
    const ws: Workstream = { id: 1, roadmap_id: 1, name: 'Core', position: 0 }
    const { container } = render(
      <DeliverableEditForm deliverable={deliverable} team={team} workstreams={[ws]} roadmap={roadmap} onSaved={vi.fn()} />,
    )
    const order = ['Title', 'Start', 'End', 'Status', 'Responsible person', 'Team', 'Deliverable color', 'Icon labels', 'Workstreams', 'Description', 'Links', 'Depends on']
    const at = order.map((l) => {
      const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.trim().startsWith(l))
      expect(label, l).toBeTruthy()
      return label!
    })
    for (let i = 1; i < at.length; i++) {
      expect(at[i - 1].compareDocumentPosition(at[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `${order[i - 1]} before ${order[i]}`).toBeTruthy()
    }
    const fields = container.querySelectorAll('form > .field')
    expect(fields[fields.length - 1]).toHaveTextContent('Depends on')
  })
})

describe('REQ_FE_114 shared form presentation', () => {
  beforeEach(() => vi.resetAllMocks())
  const renderForm = (extra: Partial<React.ComponentProps<typeof DeliverableEditForm>> = {}, d: Deliverable = deliverable) =>
    render(<DeliverableEditForm deliverable={d} team={team} workstreams={[]} roadmap={roadmap} onSaved={vi.fn()} {...extra} />)

  it('REQ_FE_114 the Done button calls onDone and saves nothing; without onDone (full edit window) there is no footer Done button', async () => {
    await step('Done button calls onDone and saves nothing', () => {
      const onDone = vi.fn()
      renderForm({ onDone })
      fireEvent.click(document.querySelector('.form-foot button')!)
      expect(onDone).toHaveBeenCalledTimes(1)
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
    })

    await step('without onDone (full edit window) there is no footer Done button', () => {
      cleanup()
      vi.resetAllMocks()
      renderForm()
      expect(document.querySelector('.form-foot')).toBeNull()
    })
  })
})

describe('REQ_FE_114 color, icons, workstreams, links, invalid borders', () => {
  beforeEach(() => vi.resetAllMocks())
  const ws1: Workstream = { id: 1, roadmap_id: 1, name: 'Core', position: 0 }
  const ws2: Workstream = { id: 2, roadmap_id: 1, name: 'Mobile', position: 1 }
  const renderForm = (d: Deliverable = deliverable, workstreams: Workstream[] = []) =>
    render(<DeliverableEditForm deliverable={d} team={team} workstreams={workstreams} roadmap={roadmap} onSaved={vi.fn()} />)

  it('REQ_FE_114 REQ_FE_029 the contrast hint states the auto text color and ratio and Reset to team color remains; clicking a swatch saves only the color and the selected swatch is marked', async () => {
    await step('the contrast hint states the auto text color and ratio; Reset to team color remains (REQ_FE_029)', async () => {
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, color: '#2f6bd7' })
      renderForm({ ...deliverable, color: '#f4c542' })
      expect(screen.getByTestId('contrast-hint')).toHaveTextContent(/Text auto-set to dark · \d+\.\d:1 · AA$/)
      fireEvent.click(screen.getByRole('button', { name: 'Reset to team color' }))
      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { color: '#2f6bd7' }))
    })

    await step('clicking a swatch saves only the color; the selected swatch is marked', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...deliverable, color: '#7c3aed' })
      renderForm()
      expect(screen.getByRole('button', { name: 'Color #2f6bd7' })).toHaveClass('on')
      fireEvent.click(screen.getByRole('button', { name: 'Color #7c3aed' }))
      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { color: '#7c3aed' }))
      expect((screen.getByLabelText('Deliverable color') as HTMLInputElement).value).toBe('#7c3aed')
    })
  })

  it('REQ_FE_114 status is four .segs buttons with icons and status classes (the active one marked); icon labels are .tiles with the chosen names listed below; workstreams are chips with the membership rule kept (cannot untick the last one)', async () => {
    await step('status is four .segs buttons with icons and status classes; the active one is marked', () => {
      renderForm({ ...deliverable, status: 'at_risk' })
      const buttons = [...document.querySelectorAll('.segs .st-opt')]
      expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Planned', 'In progress', 'Done', 'At risk'])
      buttons.forEach((b) => expect(b.querySelector('svg')).toBeTruthy())
      expect(document.querySelector('.st-opt.st-risk')).toHaveClass('on')
      expect(document.querySelector('.st-opt.st-planned')).not.toHaveClass('on')
      expect(screen.getByPlaceholderText('What is the risk? Shown on hover and in the panel.')).toBeInTheDocument()
    })

    await step('icon labels are .tiles and the chosen names are listed below; none shows "No labels"', () => {
      cleanup()
      vi.resetAllMocks()
      const { unmount } = renderForm()
      expect(document.querySelectorAll('.tiles .tile').length).toBeGreaterThan(0)
      expect(screen.getByTestId('icon-names')).toHaveTextContent('No labels')
      unmount()
      renderForm({ ...deliverable, icons: ['flag'] })
      expect(document.querySelectorAll('.tiles .tile.on')).toHaveLength(1)
      expect(screen.getByTestId('icon-names').textContent).not.toBe('No labels')
    })

    await step('workstreams are chips: on state shown, membership rule kept (cannot untick the last one)', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.patchDeliverable).mockResolvedValue(deliverable)
      const d: Deliverable = { ...deliverable, workstream_ids: [1], workstreams: [{ id: 1, row: 0 }] }
      renderForm(d, [ws1, ws2])
      expect(document.querySelectorAll('.wschips .wschip')).toHaveLength(2)
      expect(document.querySelectorAll('.wschip.on')).toHaveLength(1)
      fireEvent.click(screen.getAllByRole('checkbox')[0])
      expect(resources.patchDeliverable).not.toHaveBeenCalled()
      fireEvent.click(screen.getAllByRole('checkbox')[1])
      await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(10, { workstream_ids: [1, 2] }))
    })
  })
})
