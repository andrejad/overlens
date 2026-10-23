import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MoveItemDialog, spanProblem } from './MoveItemDialog'
import { SidePanel } from './SidePanel'
import { CanEditProvider } from '../lib/canEdit'
import * as resources from '../api/resources'
import type { Deliverable, Milestone, RoadmapFull, Team } from '../api/types'
import { CAP_MESSAGE } from '../timeline/axis'
import { step } from '../testSteps'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

const team = (id: number, name: string, roadmap_id: number): Team => ({ id, name, tag: name.slice(0, 3).toUpperCase(), default_color: '#2f6bd7', roadmap_id, created_at: '' })
const T1 = team(1, 'Onboarding', 1)
const T2 = team(2, 'Mobile', 20)
const T3 = team(3, 'Revenue', 30)

const deliverable: Deliverable = {
  id: 10, roadmap_id: 1, team_id: 1, name: 'SSO Flow', start_date: '2026-03-01', end_date: '2026-04-01',
  color: '#2f6bd7', responsible_person: '', description_html: '', status: 'planned', risk_note: '', icons: [],
  workstream_ids: [5, 6], workstreams: [{ id: 5, row: 0 }, { id: 6, row: 0 }], links: [], created_at: '', updated_at: '',
}
const milestone: Milestone = { id: 7, roadmap_id: 1, workstream_id: 6, name: 'Go-live', date: '2026-05-01', row: 0 }

const full = (id: number, t: Team, range: [string, string] | null, workstreams: [number, string][], over: Partial<RoadmapFull> = {}): RoadmapFull => ({
  id, team_id: t.id, title: `${t.name} plan`, range_start: range?.[0] ?? null, range_end: range?.[1] ?? null, created_at: '', updated_at: '',
  team: t, workstreams: workstreams.map(([wid, name], i) => ({ id: wid, roadmap_id: id, name, position: i })),
  deliverables: [], milestones: [], dependencies: [], ...over,
})
const source = (over: Partial<RoadmapFull> = {}) =>
  full(1, T1, ['2026-01-01', '2026-12-31'], [[5, 'Growth'], [6, 'Platform']], { deliverables: [deliverable], milestones: [milestone], ...over })
// "growth" matches "Growth" (case ignored); the first of two same-named workstreams by position wins
const destFull = (range: [string, string] | null = ['2026-01-01', '2026-12-31']) =>
  full(20, T2, range, [[50, ' growth'], [52, 'GROWTH'], [51, 'Other']])

function setup(kind: 'deliverable' | 'milestone' = 'deliverable', opts: { src?: RoadmapFull; dest?: RoadmapFull } = {}) {
  vi.mocked(resources.fetchTeams).mockResolvedValue([T1, T2, T3])
  vi.mocked(resources.fetchRoadmap).mockImplementation(async (id) => (id === 20 ? opts.dest ?? destFull() : full(30, T3, null, [[60, 'General']])))
  const onClose = vi.fn()
  const onMoved = vi.fn()
  const src = opts.src ?? source()
  render(
    kind === 'deliverable' ? (
      <MoveItemDialog kind="deliverable" item={deliverable} roadmap={src} onClose={onClose} onMoved={onMoved} />
    ) : (
      <MoveItemDialog kind="milestone" item={milestone} roadmap={src} onClose={onClose} onMoved={onMoved} />
    ),
  )
  return { onClose, onMoved }
}

async function pickMobile() {
  fireEvent.click(await screen.findByRole('radio', { name: 'Mobile' }))
  await screen.findByText('Workstreams in Mobile')
}

const sel = (name: string) => screen.getByLabelText(`Destination for ${name}`) as HTMLSelectElement
const fresh = () => {
  cleanup()
  vi.resetAllMocks()
  document.body.innerHTML = ''
}

describe('REQ_FE_030 one move dialog for both kinds', () => {
  beforeEach(fresh)

  it('REQ_FE_030 offers the other teams only, matches workstreams by name (trimmed, case ignored, the first by position) and sends {team_id, workstream_map}; per-workstream choices (pick another, create, drop); at least one membership must remain; the summary line shows the dependencies that stay and the ones that become cross-team', async () => {
    await step('offers the other teams only, matches by name and sends the default map', async () => {
      setup()
      vi.mocked(resources.moveItem).mockResolvedValue({ ...deliverable, roadmap_id: 20, team_id: 2 })
      expect(await screen.findByRole('radio', { name: 'Mobile' })).toBeEnabled()
      expect(screen.getByRole('radio', { name: 'Revenue' })).toBeEnabled()
      expect(screen.queryByRole('radio', { name: 'Onboarding' })).not.toBeInTheDocument()
      await pickMobile()
      expect(sel('Growth').value).toBe('50')
      expect(sel('Platform').value).toBe('create') // no match: create is the default
      fireEvent.click(screen.getByText('Move to Mobile'))
      await waitFor(() =>
        expect(resources.moveItem).toHaveBeenCalledWith('deliverable', 10, {
          team_id: 2,
          workstream_map: [{ from: 5, to: 50 }, { from: 6, to: { create: 'Platform' } }],
        }),
      )
    })

    await step('per-workstream choices: pick another workstream, create, drop', async () => {
      fresh()
      const { onMoved, onClose } = setup()
      vi.mocked(resources.moveItem).mockResolvedValue({ ...deliverable, roadmap_id: 20, team_id: 2 })
      await pickMobile()
      fireEvent.change(sel('Growth'), { target: { value: '51' } })
      fireEvent.change(sel('Platform'), { target: { value: 'drop' } })
      fireEvent.click(screen.getByText('Move to Mobile'))
      await waitFor(() =>
        expect(resources.moveItem).toHaveBeenCalledWith('deliverable', 10, { team_id: 2, workstream_map: [{ from: 5, to: 51 }, { from: 6, to: null }] }),
      )
      await waitFor(() => expect(onMoved).toHaveBeenCalled())
      expect(onClose).toHaveBeenCalled()
    })

    await step('at least one membership must remain: the last kept workstream cannot be dropped', async () => {
      fresh()
      setup()
      await pickMobile()
      fireEvent.change(sel('Platform'), { target: { value: 'drop' } })
      expect(Array.from(sel('Growth').options).find((o) => o.value === 'drop')!.disabled).toBe(true)
    })

    await step('shows the summary line with the dependencies that stay and the ones that become cross-team', async () => {
      fresh()
      const dep = (fromId: number, toId: number, otherRoadmap: number) => ({
        from_kind: 'deliverable' as const, from_id: fromId, to_kind: 'deliverable' as const, to_id: toId,
        from: { id: fromId, name: 'a', team_name: '', roadmap_id: fromId === 10 ? 1 : otherRoadmap, start_date: '', end_date: '' },
        to: { id: toId, name: 'b', team_name: '', roadmap_id: toId === 10 ? 1 : otherRoadmap, start_date: '', end_date: '' },
      })
      setup('deliverable', { src: source({ dependencies: [dep(10, 11, 1), dep(12, 10, 1), dep(13, 10, 99)] }) })
      await pickMobile()
      expect(screen.getByTestId('move-summary')).toHaveTextContent('3 dependencies stay (2 become cross-team) · color kept · dates unchanged · fits the 3-year span')
    })
  })

  it('REQ_FE_030 shows the 3-year problem with REQ_FE_062\'s message before confirming and keeps the confirm button off; spanProblem: inside 3 years is fine, an already-wide range is not made a problem; a server refusal is shown (a 3-year one with REQ_FE_062\'s message) and the dialog stays open', async () => {
    await step('shows the 3-year problem before confirming and keeps the confirm button off', async () => {
      setup('deliverable', { dest: destFull(['2023-01-01', '2026-02-01']) })
      await pickMobile()
      expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(`^${CAP_MESSAGE}$`))
      expect(screen.getByText(/earliest Jan 1, 2023 → latest Apr 1, 2026/)).toBeInTheDocument()
      expect(screen.getByText('Move to Mobile')).toBeDisabled()
      expect(resources.moveItem).not.toHaveBeenCalled()
    })

    await step('spanProblem: inside 3 years is fine, an already-wide range is not made a problem, an empty roadmap is fine', () => {
      const r = (a: string, b: string) => ({ range_start: a, range_end: b })
      expect(spanProblem(r('2026-01-01', '2028-12-31'), '2026-03-01', '2026-04-01')).toBeNull()
      expect(spanProblem(r('2020-01-01', '2026-12-31'), '2026-03-01', '2026-04-01')).toBeNull() // already wider
      expect(spanProblem(r('2024-01-01', '2026-12-31'), '2026-03-01', '2027-06-01')).toContain('earliest')
      expect(spanProblem({ range_start: null, range_end: null }, '2026-03-01', '2026-04-01')).toBeNull()
    })

    await step('a 3-year refusal from the server reads REQ_FE_062\'s message, any other refusal the server\'s own, and the dialog stays open', async () => {
      fresh()
      const { onClose } = setup()
      vi.mocked(resources.moveItem).mockRejectedValue({
        response: { data: { error: { code: 'span_exceeded', message: 'This change would make the roadmap run too long' } } },
      })
      await pickMobile()
      fireEvent.click(screen.getByText('Move to Mobile'))
      expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(`^${CAP_MESSAGE}$`))
      vi.mocked(resources.moveItem).mockRejectedValue({ response: { data: { error: { code: 'row_overlap', message: 'Overlaps "Billing" in Mobile, row 1' } } } })
      fireEvent.click(screen.getByText('Move to Mobile'))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Overlaps "Billing" in Mobile, row 1'))
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  it('REQ_FE_030 a successful move shows a plain notice "Moved <name> to <team>" with no Undo, and the page refetches', async () => {
    const { onMoved } = setup()
    vi.mocked(resources.moveItem).mockResolvedValue({ ...deliverable, roadmap_id: 20, team_id: 2 })
    await pickMobile()
    fireEvent.click(screen.getByText('Move to Mobile'))
    expect(await screen.findByRole('status')).toHaveTextContent('Moved “SSO Flow” to Mobile')
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(onMoved).toHaveBeenCalledTimes(1)
  })

  it('REQ_FE_030 focus starts on the first control, Escape closes, Tab wraps inside the dialog; closing the dialog returns focus to the element that opened it', async () => {
    await step('focus starts on the first control, Escape closes, Tab wraps inside the dialog', async () => {
      const { onClose } = setup()
      const close = screen.getByRole('button', { name: 'Close' })
      expect(close).toHaveFocus()
      const cancel = screen.getByRole('button', { name: 'Cancel' })
      await screen.findByRole('radio', { name: 'Revenue' })
      cancel.focus()
      fireEvent.keyDown(document, { key: 'Tab' }) // Cancel is the last enabled control (Move is disabled)
      expect(close).toHaveFocus()
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
      expect(cancel).toHaveFocus()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
    })

    await step('closing the dialog returns focus to the element that opened it, if it still exists', async () => {
      fresh()
      vi.mocked(resources.fetchTeams).mockResolvedValue([T1, T2])
      function Host() {
        const [open, setOpen] = useState(false)
        return (
          <>
            <button onClick={() => setOpen(true)}>(move)</button>
            {open && <MoveItemDialog kind="milestone" item={milestone} roadmap={source()} onClose={() => setOpen(false)} onMoved={vi.fn()} />}
          </>
        )
      }
      render(<Host />)
      const opener = screen.getByText('(move)')
      opener.focus()
      fireEvent.click(opener)
      expect(await screen.findByRole('dialog', { name: 'Move milestone' })).toBeInTheDocument()
      expect(opener).not.toHaveFocus()
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(opener).toHaveFocus()
    })
  })
})

describe('REQ_FE_122 a milestone moves in the same dialog', () => {
  beforeEach(fresh)

  it('REQ_FE_122 the milestone\'s workstream goes to the same-named one (or a new or another one, never dropped) and the same body is sent; a refusal shows the server\'s message', async () => {
    await step('same-named by default, create offered when there is none, no drop; the same body as a deliverable', async () => {
      const { onMoved } = setup('milestone')
      vi.mocked(resources.moveItem).mockResolvedValue({ ...milestone, roadmap_id: 20 })
      await pickMobile()
      expect(sel('Platform').value).toBe('create')
      expect(Array.from(sel('Platform').options).map((o) => o.value)).toEqual(['50', '52', '51', 'create'])
      fireEvent.change(sel('Platform'), { target: { value: '51' } })
      expect(screen.getByTestId('move-summary')).toHaveTextContent('0 dependencies stay · date unchanged · fits the 3-year span')
      fireEvent.click(screen.getByText('Move to Mobile'))
      await waitFor(() => expect(resources.moveItem).toHaveBeenCalledWith('milestone', 7, { team_id: 2, workstream_map: [{ from: 6, to: 51 }] }))
      await waitFor(() => expect(onMoved).toHaveBeenCalledWith({ ...milestone, roadmap_id: 20 }))
    })

    await step('a refused move shows the server\'s message and stays open', async () => {
      fresh()
      const { onClose } = setup('milestone')
      vi.mocked(resources.moveItem).mockRejectedValue({ response: { data: { error: { code: 'validation_failed', message: 'Nope' } } } })
      await pickMobile()
      fireEvent.click(screen.getByText('Move to Mobile'))
      expect(await screen.findByRole('alert')).toHaveTextContent('Nope')
      expect(onClose).not.toHaveBeenCalled()
    })
  })
})

describe('REQ_FE_021 the "(move)" link', () => {
  beforeEach(fresh)
  const panel = (canEdit: boolean) => (
    <CanEditProvider value={canEdit}>
      <SidePanel roadmap={source()} selection={{ id: 10, type: 'deliverable' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />
    </CanEditProvider>
  )

  it('REQ_FE_021 an admin sees the "(move)" link, which opens the move dialog; read-only visitors see no "(move)" link', async () => {
    await step('an admin sees the "(move)" link, which opens the move dialog', async () => {
      vi.mocked(resources.fetchTeams).mockResolvedValue([T1, T2])
      render(panel(true))
      fireEvent.click(screen.getByText('(move)'))
      expect(await screen.findByRole('dialog', { name: 'Move deliverable' })).toBeInTheDocument()
    })

    await step('read-only visitors see no "(move)" link', () => {
      fresh()
      render(panel(false))
      expect(screen.queryByText('(move)')).not.toBeInTheDocument()
    })
  })
})
