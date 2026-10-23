import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DeleteItemDialog } from './DeleteItemDialog'
import { EditModal } from './EditModal'
import { SidePanel } from './SidePanel'
import { CanEditProvider } from '../lib/canEdit'
import { deleteDeliverable, patchDeliverable } from '../api/resources'
import type { Deliverable, RoadmapFull } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

const d = (id: number, name: string, wsIds: number[]): Deliverable => ({
  id,
  roadmap_id: 1,
  team_id: 1,
  name,
  start_date: '2026-01-01',
  end_date: '2026-02-01',
  color: '#2f6bd7',
  status: 'planned',
  responsible_person: '',
  description_html: '',
  risk_note: '',
  icons: [],
  workstream_ids: wsIds,
  workstreams: wsIds.map((id) => ({ id, row: 0 })),
  links: [],
  created_at: '',
  updated_at: '',
})
const end = (id: number, kind: 'deliverable' | 'milestone' = 'deliverable') => ({ kind, id, name: `n${id}`, team_name: 'T', roadmap_id: 1, start_date: '2026-01-01', end_date: '2026-01-02' })
const roadmap = {
  id: 1,
  team_id: 1,
  title: 'Plan',
  range_start: null,
  range_end: null,
  created_at: '',
  updated_at: '',
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', created_at: '' },
  workstreams: [
    { id: 1, roadmap_id: 1, name: 'General', position: 0 },
    { id: 2, roadmap_id: 1, name: 'Mobile', position: 1 },
  ],
  deliverables: [d(10, 'Signup Flow', [1, 2]), d(11, 'Other', [1])],
  milestones: [],
  // 10 -> 11, milestone 11 -> 10, and one edge not touching 10
  dependencies: [
    { from_id: 10, to_id: 11, from: end(10), to: end(11) },
    { from_id: 11, to_id: 10, from_kind: 'milestone', from: end(11, 'milestone'), to: end(10) },
    { from_id: 11, to_id: 11, from: end(11), to: end(11) },
  ],
} as unknown as RoadmapFull

beforeEach(() => vi.clearAllMocks())

describe('REQ_FE_118 the delete confirmation', () => {
  it('REQ_FE_118 names the item (the workstream sentence only for several workstreams, the links sentence only when K > 0); Cancel is focused and sends nothing and Escape cancels; a refused delete keeps the dialog open with the server message', async () => {
    await step('names the item; the workstream sentence only for several workstreams; the links sentence only when K > 0', () => {
      const { rerender } = render(<DeleteItemDialog name="Alpha" workstreamCount={1} dependencyCount={0} onCancel={vi.fn()} onConfirm={vi.fn()} />)
      expect(screen.getByRole('heading')).toHaveTextContent('Delete "Alpha"?')
      expect(screen.queryByText(/disappears/)).toBeNull()
      expect(screen.queryByText(/dependency links/)).toBeNull()
      rerender(<DeleteItemDialog name="Alpha" workstreamCount={3} dependencyCount={4} onCancel={vi.fn()} onConfirm={vi.fn()} />)
      expect(screen.getByText('It disappears from all 3 workstreams.')).toBeTruthy()
      expect(screen.getByText('Its 4 dependency links are removed too.')).toBeTruthy()
    })

    await step('Cancel is focused and sends nothing; Escape cancels', () => {
      cleanup()
      vi.resetAllMocks()
      const onCancel = vi.fn()
      const onConfirm = vi.fn()
      render(<DeleteItemDialog name="Alpha" dependencyCount={0} onCancel={onCancel} onConfirm={onConfirm} />)
      expect(document.activeElement).toBe(screen.getByText('Cancel'))
      fireEvent.click(screen.getByText('Cancel'))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onCancel).toHaveBeenCalledTimes(2)
      expect(onConfirm).not.toHaveBeenCalled()
    })

    await step('a refused delete keeps the dialog open with the server message; Delete is disabled while it runs', async () => {
      cleanup()
      vi.resetAllMocks()
      let reject!: (e: unknown) => void
      const onConfirm = vi.fn(() => new Promise<void>((_, r) => (reject = r)))
      render(<DeleteItemDialog name="Alpha" dependencyCount={0} onCancel={vi.fn()} onConfirm={onConfirm} />)
      fireEvent.click(screen.getByText('Delete'))
      expect((screen.getByText('Delete') as HTMLButtonElement).disabled).toBe(true)
      reject({ response: { data: { error: { message: 'Nope, locked' } } } })
      expect(await screen.findByRole('alert')).toHaveTextContent('Nope, locked')
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect((screen.getByText('Delete') as HTMLButtonElement).disabled).toBe(false)
    })
  })
})

describe('REQ_FE_118 deleting from the panel', () => {
  it('REQ_FE_118 the panel Delete counts workstreams and links in both directions, sends nothing on Cancel, DELETE on confirm, then closes and refetches; a read-only visitor sees no Delete', async () => {
    await step('the panel Delete counts workstreams and links in both directions, sends nothing on Cancel, DELETE on confirm, then closes and refetches', async () => {
      vi.mocked(deleteDeliverable).mockResolvedValue()
      const onClose = vi.fn()
      const onDeps = vi.fn()
      render(<SidePanel roadmap={roadmap} selection={{ id: 10, type: 'deliverable' }} onClose={onClose} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} onDependenciesChanged={onDeps} />)
      fireEvent.click(screen.getByTestId('panel-delete'))
      expect(screen.getByText('It disappears from all 2 workstreams.')).toBeTruthy()
      expect(screen.getByText('Its 2 dependency links are removed too.')).toBeTruthy()
      fireEvent.click(screen.getByText('Cancel'))
      expect(deleteDeliverable).not.toHaveBeenCalled()
      fireEvent.click(screen.getByTestId('panel-delete'))
      fireEvent.click(screen.getByTestId('delete-item-confirm'))
      await waitFor(() => expect(deleteDeliverable).toHaveBeenCalledWith(10))
      await waitFor(() => expect(onClose).toHaveBeenCalled())
      expect(onDeps).toHaveBeenCalled()
    })

    await step('a read-only visitor sees no Delete', () => {
      cleanup()
      vi.resetAllMocks()
      render(
        <CanEditProvider value={false}>
          <SidePanel roadmap={roadmap} selection={{ id: 10, type: 'deliverable' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />
        </CanEditProvider>,
      )
      expect(screen.queryByTestId('panel-delete')).toBeNull()
    })
  })
})

describe('REQ_FE_119 the edit window frame', () => {
  const open = (onClose = vi.fn(), onDeps = vi.fn()) =>
    render(<EditModal deliverable={roadmap.deliverables[0]} roadmap={roadmap} onClose={onClose} onSaved={vi.fn()} onDependenciesChanged={onDeps} />)

  it('REQ_FE_119 header shows the name as subtitle and the autosave tag; focus starts on Title', () => {
    open()
    expect(screen.getByText('Edit deliverable')).toBeTruthy()
    expect(screen.getByTestId('edit-subtitle')).toHaveTextContent('Signup Flow')
    expect(screen.getByText('Every field autosaves — no Save button')).toBeTruthy()
    expect(document.activeElement?.id).toBe('d-name')
  })

  it('REQ_FE_119 Done and Escape close, and Escape inside the delete dialog closes only that; Tab stays inside the window and focus returns to the opener on close', async () => {
    await step('Done and Escape close; Escape inside the delete dialog closes only that', async () => {
      const onClose = vi.fn()
      open(onClose)
      fireEvent.click(screen.getByTestId('edit-window-done'))
      expect(onClose).toHaveBeenCalledTimes(1)
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2))
      fireEvent.click(screen.getByTestId('edit-delete'))
      fireEvent.keyDown(document, { key: 'Escape' })
      await new Promise((r) => setTimeout(r, 50))
      expect(onClose).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId('delete-item-dialog')).toBeNull()
      expect(deleteDeliverable).not.toHaveBeenCalled()
    })

    await step('Tab stays inside the window and focus returns to the opener on close', () => {
      cleanup()
      vi.resetAllMocks()
      const opener = document.createElement('button')
      document.body.appendChild(opener)
      opener.focus()
      const { unmount } = open()
      screen.getByTestId('edit-window-done').focus()
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
      unmount()
      expect(document.activeElement).toBe(opener)
    })
  })

  it('REQ_FE_119 Escape waits for the focused field: a refused value keeps the window open with the message, a saved value closes the window', async () => {
    await step('Escape waits for the focused field: a refused value keeps the window open with the message', async () => {
      vi.mocked(patchDeliverable).mockRejectedValue({ response: { data: { error: { code: 'validation_failed', message: 'name is too long' } } } })
      const onClose = vi.fn()
      open(onClose)
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } })
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(patchDeliverable).toHaveBeenCalledWith(10, { name: 'Renamed' }))
      expect(await screen.findByText('name is too long')).toBeTruthy()
      await new Promise((r) => setTimeout(r, 50))
      expect(onClose).not.toHaveBeenCalled()
    })

    await step('Escape waits for the focused field: a saved value closes the window', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(patchDeliverable).mockResolvedValue({ ...roadmap.deliverables[0], name: 'Renamed' })
      const onClose = vi.fn()
      open(onClose)
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } })
      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      expect(patchDeliverable).toHaveBeenCalledWith(10, { name: 'Renamed' })
    })
  })

  it('REQ_FE_119 Delete deliverable confirms, deletes, closes the window and refetches', async () => {
    vi.mocked(deleteDeliverable).mockResolvedValue()
    const onClose = vi.fn()
    const onDeps = vi.fn()
    open(onClose, onDeps)
    fireEvent.click(screen.getByTestId('edit-delete'))
    fireEvent.click(screen.getByTestId('delete-item-confirm'))
    await waitFor(() => expect(deleteDeliverable).toHaveBeenCalledWith(10))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onDeps).toHaveBeenCalled()
  })
})
