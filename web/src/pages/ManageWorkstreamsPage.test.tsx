import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ManageWorkstreamsPage } from './ManageWorkstreamsPage'
import * as resources from '../api/resources'
import { CanEditProvider } from '../lib/canEdit'
import { parseRoute } from '../lib/router'
import type { Deliverable, Milestone, RoadmapFull, Workstream } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')

const ws = (id: number, name: string, position: number): Workstream => ({ id, roadmap_id: 1, name, position })
function del(id: number, wsIds: number[]): Deliverable {
  return {
    id, roadmap_id: 1, team_id: 1, name: `d${id}`, start_date: '2026-01-05', end_date: '2026-02-01', color: '#4f6bd8',
    responsible_person: '', description_html: '', status: 'planned', risk_note: '', icons: [], workstream_ids: wsIds,
    workstreams: wsIds.map((w) => ({ id: w, row: 0 })), links: [], created_at: '', updated_at: '',
  }
}
const ms = (id: number, w: number): Milestone => ({ id, roadmap_id: 1, workstream_id: w, name: `m${id}`, date: '2026-01-10', row: 0 })

function roadmap(over: Partial<RoadmapFull> = {}): RoadmapFull {
  return {
    id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null, created_at: '', updated_at: '',
    team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#4f6bd8', roadmap_id: 1, created_at: '' },
    workstreams: [ws(1, 'Alpha', 0), ws(2, 'Beta', 1), ws(3, 'Gamma', 2)],
    // Alpha: 3 deliverables (one also in Beta) + 1 milestone; Beta: 2 deliverables + 2 milestones; Gamma: empty
    deliverables: [del(10, [1]), del(11, [1, 2]), del(12, [1]), del(13, [2])],
    milestones: [ms(20, 1), ms(21, 2), ms(22, 2)],
    dependencies: [],
    ...over,
  }
}

function renderPage(canEdit = true) {
  return render(
    <CanEditProvider value={canEdit}>
      <ManageWorkstreamsPage teamId={1} />
    </CanEditProvider>,
  )
}

const rowNames = () => screen.getAllByTestId('ws-row').map((r) => r.querySelector('.nm')!.textContent)
const httpError = (status: number, message: string) => ({ response: { status, data: { error: { code: 'x', message } } } })

// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function fresh() {
  cleanup()
  vi.resetAllMocks()
  vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap().team)
  vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap())
}
beforeEach(fresh)

describe('REQ_FE_105 the Manage workstreams page', () => {
  it('REQ_FE_105 shows the eyebrow, title, back link, rows with counts computed from the roadmap, the add field and Good to know; the page is reached at #/teams/:id/workstreams; an unknown team shows a not-found message; rows follow the position order the server sent', async () => {
    await step('shows the eyebrow, title, back link, rows with counts computed from the roadmap, the add field and Good to know', async () => {
      renderPage()
      await screen.findByText('Manage workstreams')
      expect(screen.getByText('Team roadmap · Onboarding')).toBeInTheDocument()
      expect(screen.getByTestId('back-to-roadmap')).toHaveAttribute('href', '#/teams/1')
      expect(screen.getByText('Drag to reorder, click the pencil to rename. Order is top-to-bottom on the roadmap.')).toBeInTheDocument()
      const rows = screen.getAllByTestId('ws-row')
      expect(rows.map((r) => r.textContent)).toEqual([
        expect.stringContaining('1Alpha3 deliverables · 1 milestone'),
        expect.stringContaining('2Beta2 deliverables · 2 milestones'),
        expect.stringContaining('3Gamma0 deliverables · 0 milestones'),
      ])
      expect(within(rows[0]).getByLabelText('Reorder Alpha')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Add a workstream…')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
      expect(screen.getByTestId('ws-good-to-know')).toHaveTextContent('Good to know')
      expect(screen.getByTestId('ws-good-to-know')).toHaveTextContent('Workstreams with the same name in other teams merge in the company view.')
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
      expect(screen.getByTestId('topbar')).toHaveAttribute('data-variant', 'team')
      expect(screen.queryByTestId('add-workstream')).not.toBeInTheDocument() // the reduced bar: no add buttons
      expect(screen.queryByTestId('sw-copies')).not.toBeInTheDocument()
    })

    await step('is reached at #/teams/:id/workstreams', () => {
      fresh()
      expect(parseRoute('#/teams/1/workstreams')).toEqual({ name: 'workstreams', teamId: 1 })
      expect(parseRoute('#/teams/1/workstreams/')).toEqual({ name: 'workstreams', teamId: 1 })
      expect(parseRoute('#/teams/1')).toEqual({ name: 'team', teamId: 1 })
    })

    await step('an unknown team shows a not-found message with a way back', async () => {
      fresh()
      vi.mocked(resources.fetchTeam).mockRejectedValue(httpError(404, 'nope'))
      renderPage()
      expect(await screen.findByRole('alert')).toHaveTextContent('That team was not found.')
    })

    await step('rows follow the position order the server sent', async () => {
      fresh()
      vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap({ workstreams: [ws(3, 'Gamma', 0), ws(1, 'Alpha', 1), ws(2, 'Beta', 2)] }))
      renderPage()
      await screen.findByText('Manage workstreams')
      expect(rowNames()).toEqual(['Gamma', 'Alpha', 'Beta'])
    })
  })

  it('REQ_FE_105 an anonymous visitor sees the list read-only: no grip, pencil, trash or add field', async () => {
    renderPage(false)
    await screen.findByText('Manage workstreams')
    expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(screen.queryByTestId('ws-grip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ws-rename')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ws-delete')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ws-add-input')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
  })
})

describe('REQ_FE_108 rename and add', () => {
  it('REQ_FE_108 Enter in the pencil field saves through the rename call and shows the new name; leaving the field saves too; Escape cancels without a request', async () => {
    await step('Enter in the pencil field saves through the rename call and shows the new name', async () => {
      vi.mocked(resources.renameWorkstream).mockResolvedValue(ws(2, 'Bravo', 1))
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Rename Beta'))
      const input = screen.getByTestId('ws-rename-input')
      fireEvent.change(input, { target: { value: '  Bravo ' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(rowNames()).toEqual(['Alpha', 'Bravo', 'Gamma']))
      expect(resources.renameWorkstream).toHaveBeenCalledWith(2, 'Bravo')
      expect(screen.queryByTestId('ws-rename-input')).not.toBeInTheDocument()
    })

    await step('leaving the field saves too', async () => {
      fresh()
      vi.mocked(resources.renameWorkstream).mockResolvedValue(ws(2, 'Bravo', 1))
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Rename Beta'))
      const input = screen.getByTestId('ws-rename-input')
      fireEvent.change(input, { target: { value: 'Bravo' } })
      fireEvent.blur(input)
      await waitFor(() => expect(rowNames()).toContain('Bravo'))
      expect(resources.renameWorkstream).toHaveBeenCalledTimes(1)
    })

    await step('Escape cancels without a request', async () => {
      fresh()
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Rename Beta'))
      const input = screen.getByTestId('ws-rename-input')
      fireEvent.change(input, { target: { value: 'Bravo' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(screen.queryByTestId('ws-rename-input')).not.toBeInTheDocument()
      expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
      expect(resources.renameWorkstream).not.toHaveBeenCalled()
    })
  })

  it('REQ_FE_108 a duplicate or empty name shows the server message under the field and keeps it open, when renaming and when adding', async () => {
    await step('a duplicate or empty name shows the server message under the field and keeps it open', async () => {
      vi.mocked(resources.renameWorkstream).mockRejectedValue(httpError(409, 'A workstream with that name already exists'))
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Rename Beta'))
      const input = screen.getByTestId('ws-rename-input')
      fireEvent.change(input, { target: { value: 'alpha' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(await screen.findByText('A workstream with that name already exists')).toBeInTheDocument()
      expect(screen.getByTestId('ws-rename-input')).toBeInTheDocument()
      vi.mocked(resources.renameWorkstream).mockRejectedValue(httpError(400, 'Name is required'))
      fireEvent.change(screen.getByTestId('ws-rename-input'), { target: { value: '   ' } })
      fireEvent.keyDown(screen.getByTestId('ws-rename-input'), { key: 'Enter' })
      expect(await screen.findByText('Name is required')).toBeInTheDocument()
      expect(resources.renameWorkstream).toHaveBeenLastCalledWith(2, '')
    })

    await step('an empty or duplicate name on Add shows the server message under the field', async () => {
      fresh()
      vi.mocked(resources.createWorkstream).mockRejectedValue(httpError(409, 'A workstream with that name already exists'))
      renderPage()
      await screen.findByText('Beta')
      fireEvent.change(screen.getByTestId('ws-add-input'), { target: { value: 'Alpha' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(await screen.findByTestId('ws-add-error')).toHaveTextContent('A workstream with that name already exists')
      expect(screen.getByTestId('ws-add-input')).toHaveValue('Alpha')
      expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    })
  })

  it('REQ_FE_108 Add and Enter create the workstream at the bottom and empty the field', async () => {
    vi.mocked(resources.createWorkstream).mockResolvedValueOnce(ws(4, 'Delta', 3)).mockResolvedValueOnce(ws(5, 'Epsilon', 4))
    renderPage()
    await screen.findByText('Beta')
    const field = screen.getByTestId('ws-add-input')
    fireEvent.change(field, { target: { value: ' Delta ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']))
    expect(resources.createWorkstream).toHaveBeenCalledWith(1, 'Delta')
    expect(field).toHaveValue('')
    fireEvent.change(field, { target: { value: 'Epsilon' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']))
  })
})

describe('REQ_FE_107 keyboard reorder', () => {
  it('REQ_FE_107 ArrowDown moves the row one place, saves the full id list, and focus stays on the moved grip; ArrowUp moves up and the first row on ArrowUp and the last on ArrowDown do nothing; after a keyboard move, adding a workstream or a rename keeps focus where the user put it', async () => {
    await step('ArrowDown moves the row one place, saves the full id list, and focus stays on the moved grip', async () => {
      vi.mocked(resources.reorderWorkstreams).mockResolvedValue([ws(2, 'Beta', 0), ws(1, 'Alpha', 1), ws(3, 'Gamma', 2)])
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      grip.focus()
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      expect(rowNames()).toEqual(['Beta', 'Alpha', 'Gamma']) // at once
      await waitFor(() => expect(resources.reorderWorkstreams).toHaveBeenCalledWith(1, [2, 1, 3]))
      expect(screen.getByLabelText('Reorder Alpha')).toBe(grip)
      expect(document.activeElement).toBe(grip)
    })

    await step('ArrowUp moves up; the first row on ArrowUp and the last on ArrowDown do nothing', async () => {
      fresh()
      vi.mocked(resources.reorderWorkstreams).mockResolvedValue([ws(1, 'Alpha', 0), ws(3, 'Gamma', 1), ws(2, 'Beta', 2)])
      renderPage()
      await screen.findByText('Beta')
      fireEvent.keyDown(screen.getByLabelText('Reorder Alpha'), { key: 'ArrowUp' })
      fireEvent.keyDown(screen.getByLabelText('Reorder Gamma'), { key: 'ArrowDown' })
      expect(resources.reorderWorkstreams).not.toHaveBeenCalled()
      fireEvent.keyDown(screen.getByLabelText('Reorder Gamma'), { key: 'ArrowUp' })
      await waitFor(() => expect(resources.reorderWorkstreams).toHaveBeenCalledWith(1, [1, 3, 2]))
      expect(resources.reorderWorkstreams).toHaveBeenCalledTimes(1)
    })

    await step('after a keyboard move, adding a workstream leaves focus in the add field', async () => {
      fresh()
      vi.mocked(resources.reorderWorkstreams).mockResolvedValue([ws(2, 'Beta', 0), ws(1, 'Alpha', 1), ws(3, 'Gamma', 2)])
      vi.mocked(resources.createWorkstream).mockResolvedValue(ws(4, 'Delta', 3))
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      grip.focus()
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      await waitFor(() => expect(resources.reorderWorkstreams).toHaveBeenCalled())
      const input = screen.getByTestId('ws-add-input')
      input.focus()
      fireEvent.change(input, { target: { value: 'Delta' } })
      fireEvent.click(screen.getByTestId('ws-add'))
      await waitFor(() => expect(rowNames()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']))
      expect(document.activeElement).not.toBe(screen.getByLabelText('Reorder Alpha'))
      expect(document.activeElement).toBe(input)
    })

    await step('after a keyboard move, a rename keeps focus where the user put it', async () => {
      fresh()
      vi.mocked(resources.reorderWorkstreams).mockResolvedValue([ws(2, 'Beta', 0), ws(1, 'Alpha', 1), ws(3, 'Gamma', 2)])
      vi.mocked(resources.renameWorkstream).mockResolvedValue(ws(3, 'Gamma2', 2))
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      grip.focus()
      fireEvent.keyDown(grip, { key: 'ArrowDown' })
      await waitFor(() => expect(resources.reorderWorkstreams).toHaveBeenCalled())
      const input = screen.getByTestId('ws-add-input')
      input.focus()
      fireEvent.click(screen.getByLabelText('Rename Gamma'))
      const field = await screen.findByDisplayValue('Gamma')
      field.focus()
      fireEvent.change(field, { target: { value: 'Gamma2' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      await waitFor(() => expect(resources.renameWorkstream).toHaveBeenCalled())
      await screen.findByText('Gamma2')
      expect(document.activeElement).not.toBe(screen.getByLabelText('Reorder Alpha'))
    })
  })
})

// Pointer drag through real pointer events; jsdom has no layout, so capture is stubbed and each row gets a rect from
// its place in the list (rows 50 px apart, 40 px high).
describe('REQ_FE_106 pointer-drag reorder', () => {
  const proto = Element.prototype as unknown as Record<string, unknown>
  let saved: (readonly [string, unknown])[]
  const captured = new Set<number>()

  beforeEach(() => {
    saved = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture', 'getBoundingClientRect'].map((k) => [k, proto[k]] as const)
    captured.clear()
    proto.setPointerCapture = (id: number) => captured.add(id)
    proto.releasePointerCapture = (id: number) => captured.delete(id)
    proto.hasPointerCapture = (id: number) => captured.has(id)
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const i = this.dataset.testid === 'ws-row' ? Array.from(this.parentElement!.children).indexOf(this) : 0
      return { top: i * 50, bottom: i * 50 + 40, height: 40, left: 0, right: 300, width: 300, x: 0, y: i * 50, toJSON() {} } as DOMRect
    }
  })
  afterEach(() => saved.forEach(([k, v]) => (proto[k] = v)))

  const fire = (el: Element, type: string, y: number, x = 10) =>
    act(() => {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))
    })

  it('REQ_FE_106 dragging row 1 below row 3 sends the exact id list once and shows it at once; the accent line sits above the row the pointer is over; a drop on its own place sends nothing', async () => {
    await step('dragging row 1 below row 3 sends the exact id list once and shows it at once', async () => {
      vi.mocked(resources.reorderWorkstreams).mockResolvedValue([ws(2, 'Beta', 0), ws(3, 'Gamma', 1), ws(1, 'Alpha', 2)])
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      fire(grip, 'pointerdown', 20)
      expect(captured.has(1)).toBe(true)
      fire(grip, 'pointermove', 22) // 2 px: below the threshold, nothing lifts
      expect(screen.queryByText('dragging…')).not.toBeInTheDocument()
      fire(grip, 'pointermove', 60)
      expect(screen.getByText('dragging…')).toBeInTheDocument()
      fire(grip, 'pointermove', 140) // below row 3's midpoint (120)
      const rows = screen.getAllByTestId('ws-row')
      expect(rows[0].className).toContain('drag')
      expect(rows[2].className).toContain('drop-below') // the accent line at the end
      fire(grip, 'pointerup', 140)
      expect(rowNames()).toEqual(['Beta', 'Gamma', 'Alpha'])
      await waitFor(() => expect(resources.reorderWorkstreams).toHaveBeenCalledTimes(1))
      expect(resources.reorderWorkstreams).toHaveBeenCalledWith(1, [2, 3, 1])
      expect(captured.size).toBe(0)
      expect(screen.queryByText('dragging…')).not.toBeInTheDocument()
    })

    await step('the accent line sits above the row the pointer is over', async () => {
      fresh()
      captured.clear()
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Gamma')
      fire(grip, 'pointerdown', 120)
      fire(grip, 'pointermove', 40) // between row 1 and row 2: slot 1
      expect(screen.getAllByTestId('ws-row')[1].className).toContain('drop-above')
    })

    await step('a drop on its own place sends nothing', async () => {
      fresh()
      captured.clear()
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Beta')
      fire(grip, 'pointerdown', 70)
      fire(grip, 'pointermove', 90)
      fire(grip, 'pointermove', 72)
      fire(grip, 'pointerup', 72)
      expect(resources.reorderWorkstreams).not.toHaveBeenCalled()
      expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    })
  })

  it('REQ_FE_106 a click without moving past 4 px sends nothing; Escape or a lost pointer capture puts the row back and sends nothing', async () => {
    await step('a click without moving past 4 px sends nothing', async () => {
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      fire(grip, 'pointerdown', 20)
      fire(grip, 'pointermove', 24)
      fire(grip, 'pointerup', 200)
      expect(resources.reorderWorkstreams).not.toHaveBeenCalled()
    })

    await step('Escape puts the row back and sends nothing', async () => {
      fresh()
      captured.clear()
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      fire(grip, 'pointerdown', 20)
      fire(grip, 'pointermove', 140)
      expect(screen.getByText('dragging…')).toBeInTheDocument()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.queryByText('dragging…')).not.toBeInTheDocument()
      fire(grip, 'pointerup', 140)
      expect(resources.reorderWorkstreams).not.toHaveBeenCalled()
      expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    })

    await step('a lost pointer capture puts the row back and sends nothing', async () => {
      fresh()
      captured.clear()
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      fire(grip, 'pointerdown', 20)
      fire(grip, 'pointermove', 140)
      fire(grip, 'lostpointercapture', 140)
      expect(screen.queryByText('dragging…')).not.toBeInTheDocument()
      fire(grip, 'pointerup', 140)
      expect(resources.reorderWorkstreams).not.toHaveBeenCalled()
    })
  })

  it('REQ_FE_106 a workstream added while a reorder save runs stays in the list when the save answers; a drop while a save is still running is ignored', async () => {
    await step('a workstream added while a reorder save runs stays in the list when the save answers', async () => {
      let finish: (v: Workstream[]) => void = () => {}
      vi.mocked(resources.reorderWorkstreams).mockReturnValue(new Promise((r) => (finish = r)))
      vi.mocked(resources.createWorkstream).mockResolvedValue(ws(4, 'Delta', 3))
      renderPage()
      await screen.findByText('Beta')
      fireEvent.keyDown(screen.getByLabelText('Reorder Alpha'), { key: 'ArrowDown' })
      fireEvent.change(screen.getByTestId('ws-add-input'), { target: { value: 'Delta' } })
      fireEvent.click(screen.getByTestId('ws-add'))
      await waitFor(() => expect(rowNames()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta']))
      await act(async () => finish([ws(2, 'Beta', 0), ws(1, 'Alpha', 1), ws(3, 'Gamma', 2)]))
      expect(rowNames()).toEqual(['Beta', 'Alpha', 'Gamma', 'Delta'])
    })

    await step('a drop while a save is still running is ignored', async () => {
      fresh()
      captured.clear()
      let finish: (w: Workstream[]) => void = () => {}
      vi.mocked(resources.reorderWorkstreams).mockReturnValue(new Promise((r) => (finish = r)))
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      fire(grip, 'pointerdown', 20)
      fire(grip, 'pointermove', 140)
      fire(grip, 'pointerup', 140)
      expect(rowNames()).toEqual(['Beta', 'Gamma', 'Alpha'])
      const grip2 = screen.getByLabelText('Reorder Beta')
      fire(grip2, 'pointerdown', 20)
      fire(grip2, 'pointermove', 140)
      fire(grip2, 'pointerup', 140)
      expect(resources.reorderWorkstreams).toHaveBeenCalledTimes(1)
      expect(rowNames()).toEqual(['Beta', 'Gamma', 'Alpha']) // snapped back, not moved
      await act(async () => finish([ws(2, 'Beta', 0), ws(3, 'Gamma', 1), ws(1, 'Alpha', 2)]))
    })
  })

  it('REQ_FE_106 a refused save puts the list back and shows the server message; a 422 reloads the list and says the workstreams changed elsewhere', async () => {
    await step('a refused save puts the list back and shows the server message', async () => {
      vi.mocked(resources.reorderWorkstreams).mockRejectedValue(httpError(500, 'Database is busy'))
      renderPage()
      await screen.findByText('Beta')
      const grip = screen.getByLabelText('Reorder Alpha')
      fire(grip, 'pointerdown', 20)
      fire(grip, 'pointermove', 140)
      fire(grip, 'pointerup', 140)
      expect(await screen.findByTestId('ws-message')).toHaveTextContent('Database is busy')
      expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma'])
    })

    await step('a 422 reloads the list and says the workstreams changed elsewhere', async () => {
      fresh()
      captured.clear()
      vi.mocked(resources.reorderWorkstreams).mockRejectedValue(httpError(422, 'ids must list every workstream'))
      renderPage()
      await screen.findByText('Beta')
      vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap({ workstreams: [ws(1, 'Alpha', 0), ws(2, 'Beta', 1), ws(3, 'Gamma', 2), ws(4, 'Delta', 3)] }))
      const grip = screen.getByLabelText('Reorder Alpha')
      fire(grip, 'pointerdown', 20)
      fire(grip, 'pointermove', 140)
      fire(grip, 'pointerup', 140)
      expect(await screen.findByTestId('ws-message')).toHaveTextContent('Workstreams changed elsewhere — order not saved, please retry')
      expect(rowNames()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    })
  })
})

describe('REQ_FE_109 delete', () => {
  it('REQ_FE_109 the dialog states the counts and the membership line, offers no destructive choice, and needs a target; the membership line counts only deliverables already in the chosen target; a workstream holding only milestones says so; an archived roadmap gets no active-roadmap note', async () => {
    await step('the dialog states the counts and the membership line, offers no destructive choice, and needs a target', async () => {
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Delete Alpha'))
      const dialog = screen.getByTestId('delete-workstream-dialog')
      expect(within(dialog).getByRole('heading')).toHaveTextContent('Delete "Alpha"?')
      expect(within(dialog).getByTestId('delete-ws-counts')).toHaveTextContent(
        'This workstream contains 3 deliverables and 1 milestone. Choose where they go — nothing is deleted until you confirm.',
      )
      expect(within(dialog).getByText('Move them to another workstream')).toBeInTheDocument()
      expect(within(dialog).queryByTestId('delete-ws-shared')).not.toBeInTheDocument() // no target chosen yet
      expect(within(dialog).queryByText(/and its deliverables/i)).not.toBeInTheDocument()
      const select = within(dialog).getByLabelText('Move them to another workstream') as HTMLSelectElement
      expect(select.value).toBe('') // nothing preselected
      expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a workstream…', 'Beta', 'Gamma'])
      const confirm = within(dialog).getByTestId('delete-ws-confirm')
      expect(confirm).toHaveTextContent('Move 3 deliverables & delete workstream')
      expect(confirm).toBeDisabled()
      fireEvent.change(select, { target: { value: '3' } })
      expect(confirm).toBeEnabled()
      expect(within(dialog).queryByTestId('delete-ws-shared')).not.toBeInTheDocument() // none of Alpha's deliverables is in Gamma
    })

    await step('the membership line counts only deliverables already in the chosen target and follows the choice', async () => {
      fresh()
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Delete Alpha'))
      const select = screen.getByLabelText('Move them to another workstream')
      fireEvent.change(select, { target: { value: '2' } })
      expect(screen.getByTestId('delete-ws-shared')).toHaveTextContent('1 deliverable already in Beta simply loses this membership.')
      fireEvent.change(select, { target: { value: '3' } })
      expect(screen.queryByTestId('delete-ws-shared')).not.toBeInTheDocument()
    })

    await step('a workstream holding only milestones says "Move M milestones & delete workstream"', async () => {
      fresh()
      vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap({ deliverables: [], milestones: [ms(20, 1), ms(21, 1)] }))
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Delete Alpha'))
      expect(screen.getByTestId('delete-ws-confirm')).toHaveTextContent('Move 2 milestones & delete workstream')
    })
  })

  it('REQ_FE_109 confirming sends DELETE with the target, reloads, and shows the notice; an empty workstream gets a plain confirmation and the delete carries no target; Cancel deletes nothing and a refused delete shows the message in the dialog', async () => {
    await step('confirming sends DELETE with the target, reloads, and shows the notice', async () => {
      vi.mocked(resources.deleteWorkstream).mockResolvedValue(undefined)
      renderPage()
      await screen.findByText('Beta')
      vi.mocked(resources.fetchRoadmap).mockResolvedValue(
        roadmap({ workstreams: [ws(2, 'Beta', 0), ws(3, 'Gamma', 1)], deliverables: [del(10, [3]), del(11, [2]), del(12, [3]), del(13, [2])], milestones: [ms(20, 3), ms(21, 2), ms(22, 2)] }),
      )
      fireEvent.click(screen.getByLabelText('Delete Alpha'))
      fireEvent.change(screen.getByLabelText('Move them to another workstream'), { target: { value: '3' } })
      fireEvent.click(screen.getByTestId('delete-ws-confirm'))
      await waitFor(() => expect(resources.deleteWorkstream).toHaveBeenCalledWith(1, 3))
      expect(await screen.findByTestId('ws-notice')).toHaveTextContent('Deleted Alpha; 4 items moved to Gamma')
      expect(screen.queryByTestId('delete-workstream-dialog')).not.toBeInTheDocument()
      expect(resources.fetchRoadmap).toHaveBeenCalledTimes(2)
      expect(rowNames()).toEqual(['Beta', 'Gamma'])
      expect(screen.getAllByTestId('ws-row')[1]).toHaveTextContent('2 deliverables · 1 milestone')
    })

    await step('an empty workstream gets a plain confirmation and the delete carries no target', async () => {
      fresh()
      vi.mocked(resources.deleteWorkstream).mockResolvedValue(undefined)
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Delete Gamma'))
      const dialog = screen.getByTestId('delete-workstream-dialog')
      expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
      const confirm = within(dialog).getByTestId('delete-ws-confirm')
      expect(confirm).toHaveTextContent('Delete workstream')
      expect(confirm).toBeEnabled()
      fireEvent.click(confirm)
      await waitFor(() => expect(resources.deleteWorkstream).toHaveBeenCalledWith(3, undefined))
      expect(await screen.findByTestId('ws-notice')).toHaveTextContent('Deleted Gamma')
    })

    await step('Cancel deletes nothing; a refused delete shows the message in the dialog', async () => {
      fresh()
      vi.mocked(resources.deleteWorkstream).mockRejectedValue(httpError(409, 'Has deliverables'))
      renderPage()
      await screen.findByText('Beta')
      fireEvent.click(screen.getByLabelText('Delete Gamma'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByTestId('delete-workstream-dialog')).not.toBeInTheDocument()
      expect(resources.deleteWorkstream).not.toHaveBeenCalled()
      fireEvent.click(screen.getByLabelText('Delete Gamma'))
      fireEvent.click(screen.getByTestId('delete-ws-confirm'))
      expect(await screen.findByRole('alert')).toHaveTextContent('Has deliverables')
      expect(screen.getByTestId('delete-workstream-dialog')).toBeInTheDocument()
    })
  })

  it('REQ_FE_109 the trash of the only workstream is disabled with the tooltip and accessible description', async () => {
    vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap({ workstreams: [ws(1, 'Alpha', 0)], deliverables: [], milestones: [] }))
    renderPage()
    await screen.findByText('Alpha')
    const trash = screen.getByLabelText('Delete Alpha')
    expect(trash).toBeDisabled()
    expect(trash).toHaveAttribute('title', 'Last workstream — a roadmap needs at least one')
    expect(trash).toHaveAccessibleDescription('Last workstream — a roadmap needs at least one')
  })
})
