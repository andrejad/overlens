// REQ_FE_096 with the REAL Timeline: the company view is read-only for layout, for an admin too, while the side panel
// keeps its Edit. jsdom has no layout; a drag is driven with pointer events as in timeline/Timeline.test.tsx.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { CompanyPage } from './CompanyPage'
import * as resources from '../api/resources'
import { CanEditProvider } from '../lib/canEdit'
import { companyFixture } from '../lib/companyFixtures'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
  proto.hasPointerCapture ??= () => false
})

describe('REQ_FE_096 the company view is read-only for layout', () => {
  it('REQ_FE_096 an admin on the company view gets no drag, resize, connector dots or arrow delete, but the side panel has its Edit', async () => {
    window.localStorage.clear()
    window.localStorage.setItem('erm.dependencies', 'true') // arrows on, so dots and the arrow delete would show if offered
    vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(companyFixture())
    vi.mocked(resources.fetchIcons).mockResolvedValue([])
    vi.mocked(resources.fetchWorkstreamOrder).mockResolvedValue([])
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
    const { container } = render(<CanEditProvider value={true}><CompanyPage mode="workstreams" /></CanEditProvider>)
    const bar = await vi.waitFor(() => {
      const el = container.querySelector<HTMLElement>('.deliverable[data-deliverable="3"]')
      if (!el) throw new Error('not drawn yet')
      return el
    })

    expect(container.querySelectorAll('.deliverable .rz')).toHaveLength(0) // no resize handles
    expect(container.querySelectorAll('.cdot')).toHaveLength(0) // no connector dots
    const arrow = container.querySelector('g.dep[data-dep-from="1"][data-dep-to="3"]')!
    expect(arrow).not.toBeNull() // the arrow is drawn
    fireEvent.click(arrow.querySelector('.dep-hit')!)
    fireEvent.mouseEnter(arrow)
    expect(container.querySelector('.dep-x')).toBeNull() // but it cannot be deleted

    const fire = (type: string, x: number, y: number) =>
      act(() => {
        bar.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))
      })
    fire('pointerdown', 500, 10)
    fire('pointermove', 560, 80)
    fire('pointerup', 560, 80)
    await act(async () => {})
    expect(resources.patchDeliverable).not.toHaveBeenCalled() // no drag
    expect(container.querySelector('.deliverable.dragging')).toBeNull()

    fireEvent.click(bar)
    expect(within(screen.getByTestId('side-panel')).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })
})
