import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SidePanel } from './SidePanel'
import * as prefs from '../lib/prefs'
import * as resources from '../api/resources'
import type { RoadmapFull } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

const roadmap: RoadmapFull = {
  id: 1,
  team_id: 1,
  title: 'Plan',
 
  range_start: null,
  range_end: null,
  created_at: '',
  updated_at: '',
 
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [],
  deliverables: [
    {
      id: 10,
      roadmap_id: 1,
      team_id: 1,
      name: 'Signup Flow',
      start_date: '2026-01-01',
      end_date: '2026-02-01',
      color: '#2f6bd7',
      status: 'planned',
      responsible_person: '',
      description_html: '',
      risk_note: '',
      icons: [],
      workstream_ids: [],
      workstreams: [],
      links: [],
      created_at: '',
      updated_at: '',
    },
  ],
  milestones: [
    { id: 20, roadmap_id: 1, workstream_id: 1, name: 'Launch', date: '2026-03-01', row: 0 },
  ],
  dependencies: [],
}

describe('REQ_FE_022/023 side panel open/close/resize', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(resources.patchMilestone).mockReset()
  })

  it('REQ_FE_023 the X button closes the panel and remembers it in this browser; selecting a deliverable or milestone reopens the panel', async () => {
    await step('the X button closes the panel and remembers it in this browser', () => {
      const onClose = vi.fn()
      render(
        <SidePanel
          roadmap={roadmap}
          selection={{ id: 10, type: 'deliverable' }}
          onClose={onClose}
          onDeliverableUpdated={vi.fn()}
          onOpenFullEdit={vi.fn()}
        />,
      )
      expect(screen.getByTestId('side-panel')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('Close panel'))
      expect(onClose).toHaveBeenCalled()
      expect(prefs.getPanelOpen()).toBe(false)
    })

    await step('selecting a deliverable or milestone reopens the panel', () => {
      cleanup()
      window.localStorage.clear()
      prefs.setPanelOpen(false)
      const { rerender } = render(
        <SidePanel roadmap={roadmap} selection={null} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />,
      )
      expect(screen.queryByTestId('side-panel')).not.toBeInTheDocument()
      rerender(
        <SidePanel
          roadmap={roadmap}
          selection={{ id: 20, type: 'milestone' }}
          onClose={vi.fn()}
          onDeliverableUpdated={vi.fn()}
          onOpenFullEdit={vi.fn()}
        />,
      )
      expect(screen.getByTestId('side-panel')).toBeInTheDocument()
      expect(prefs.getPanelOpen()).toBe(true)
    })
  })

  it('REQ_FE_021 the Team row (with an admin-only "(move)" link) shows in both view and edit mode', () => {
    render(
      <SidePanel
        roadmap={roadmap}
        selection={{ id: 10, type: 'deliverable' }}
        onClose={vi.fn()}
        onDeliverableUpdated={vi.fn()}
        onOpenFullEdit={vi.fn()}
      />,
    )
    // View mode (canEdit defaults true, lib/canEdit.tsx).
    expect(screen.getByText('Onboarding')).toBeInTheDocument()
    expect(screen.getByText('(move)')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Edit'))

    // Edit mode: same Team row, same link, same component (DeliverableEditForm, REQ_FE_025).
    expect(screen.getByText('Onboarding')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '(move)' })).toBeInTheDocument()
  })

  it('REQ_FE_114 Done in the panel form returns to view mode', () => {
    render(
      <SidePanel
        roadmap={roadmap}
        selection={{ id: 10, type: 'deliverable' }}
        onClose={vi.fn()}
        onDeliverableUpdated={vi.fn()}
        onOpenFullEdit={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }))
    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-done')).not.toBeInTheDocument()
  })

  it('REQ_FE_032 links are shown under the description, in both view and edit mode', () => {
    const withContent: RoadmapFull = {
      ...roadmap,
      deliverables: [
        {
          ...roadmap.deliverables[0],
          description_html: '<p>Plan details</p>',
          links: [{ id: 1, label: 'Spec', url: 'https://example.com', position: 0 }],
        },
      ],
    }
    render(
      <SidePanel
        roadmap={withContent}
        selection={{ id: 10, type: 'deliverable' }}
        onClose={vi.fn()}
        onDeliverableUpdated={vi.fn()}
        onOpenFullEdit={vi.fn()}
      />,
    )
    // View mode: the description's rich-text container precedes the Links section in the DOM.
    const desc = document.querySelector('.rich')!
    const linksLabel = screen.getByText('Links')
    expect(desc.compareDocumentPosition(linksLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(screen.getByText('Edit'))

    // Edit mode: the Description field label precedes the Links field label.
    const descLabel = screen.getByText('Description')
    const linksFieldLabel = screen.getByText('Links')
    expect(descLabel.compareDocumentPosition(linksFieldLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

// REQ_FE_110/112/113/115/024: shell, empty prompt, view mode, dependency lists.
describe('REQ_FE_110-115 side panel shell and view mode', () => {
  beforeEach(() => window.localStorage.clear())
  const base = roadmap.deliverables[0]
  const wsA = { id: 1, roadmap_id: 1, name: 'Platform', position: 0 } as RoadmapFull['workstreams'][number]
  const wsB = { id: 2, roadmap_id: 1, name: 'Growth', position: 1 } as RoadmapFull['workstreams'][number]
  const rich: RoadmapFull = {
    ...roadmap,
    workstreams: [wsA, wsB],
    deliverables: [
      {
        ...base,
        start_date: '2026-01-12',
        end_date: '2026-02-27',
        status: 'at_risk',
        risk_note: 'Vendor is late',
        icons: ['star'],
        workstream_ids: [1, 2],
        links: [{ id: 1, label: 'RFC', url: 'https://wiki.example.com/rfc/1', position: 0 } as never],
      },
      { ...base, id: 11, name: 'Other' },
    ],
    dependencies: [
      {
        from_kind: 'deliverable',
        from_id: 11,
        to_kind: 'deliverable',
        to_id: 10,
        from: { id: 11, name: 'Other', team_name: 'Billing', roadmap_id: 2, start_date: '2026-01-01', end_date: '2026-01-10' },
        to: { id: 10, name: 'Signup Flow', team_name: 'Onboarding', roadmap_id: 1, start_date: '2026-01-12', end_date: '2026-02-27' },
      },
      {
        from_kind: 'deliverable',
        from_id: 10,
        to_kind: 'milestone',
        to_id: 20,
        from: { id: 10, name: 'Signup Flow', team_name: 'Onboarding', roadmap_id: 1, start_date: '2026-01-12', end_date: '2026-02-27' },
        to: { kind: 'milestone', id: 20, name: 'Launch', team_name: 'Onboarding', roadmap_id: 1, start_date: '2026-03-01', end_date: '2026-03-01' },
      },
    ],
  }
  const show = (rm: RoadmapFull, sel: { id: number; type: 'deliverable' | 'milestone' } | null, onClose = vi.fn()) =>
    render(<SidePanel roadmap={rm} selection={sel} onClose={onClose} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />)

  it('REQ_FE_110 the divider has a grip, no tooltip, no double-click reset and no Home key; a lost pointer capture or a cancelled pointer ends the divider drag', async () => {
    await step('the divider has a grip, no tooltip, no double-click reset and no Home key', () => {
      prefs.setPanelWidth(500)
      show(roadmap, { id: 10, type: 'deliverable' })
      const handle = screen.getByTestId('panel-resize-handle')
      expect(handle.className).toContain('resizer')
      expect(handle.querySelector('.grip')).not.toBeNull()
      expect(handle).not.toHaveAttribute('title')
      expect(handle).not.toHaveAttribute('aria-valuemin')
      fireEvent.doubleClick(handle)
      fireEvent.keyDown(handle, { key: 'Home' })
      expect(prefs.getPanelWidth()).toBe(500)
    })

    await step('a lost pointer capture or a cancelled pointer ends the divider drag', () => {
      cleanup()
      window.localStorage.clear()
      show(roadmap, { id: 10, type: 'deliverable' })
      const handle = screen.getByTestId('panel-resize-handle')
      ;(handle as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
      for (const end of ['lostPointerCapture', 'pointerCancel'] as const) {
        fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 })
        expect(handle.className).toContain('drag')
        fireEvent[end](handle, { pointerId: 1 })
        expect(handle.className).not.toContain('drag')
      }
    })
  })

  it('REQ_FE_022 the resize handle can widen/narrow the panel with the keyboard and persists it; a stored width outside 280-720 is clamped on load', async () => {
    await step('the resize handle can widen/narrow the panel with the keyboard and persists it', () => {
      render(
        <SidePanel
          roadmap={roadmap}
          selection={{ id: 10, type: 'deliverable' }}
          onClose={vi.fn()}
          onDeliverableUpdated={vi.fn()}
          onOpenFullEdit={vi.fn()}
        />,
      )
      const handle = screen.getByTestId('panel-resize-handle')
      fireEvent.keyDown(handle, { key: 'ArrowLeft' })
      expect(prefs.getPanelWidth()).toBe(352)
      fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
      expect(prefs.getPanelWidth()).toBe(304)
    })

    await step('a stored width outside 280-720 is clamped on load', () => {
      cleanup()
      window.localStorage.clear()
      prefs.setPanelWidth(5000)
      show(roadmap, { id: 10, type: 'deliverable' })
      expect(screen.getByTestId('side-panel')).toHaveStyle({ width: '720px' })
    })
  })

  it('REQ_FE_115 with nothing selected the panel prompts, and X still clears the selection', () => {
    const onClose = vi.fn()
    show(roadmap, null, onClose)
    expect(screen.getByText('Select a deliverable or milestone')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Close panel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('REQ_FE_112 view mode shows the labelled status, US dates with day count, color, workstreams, labels, links and risk box; "· primary" appears only when the deliverable has more than one workstream; labels read "None" without icons', async () => {
    await step('view mode shows the labelled status, US dates with day count, color, workstreams, labels, links and risk box', () => {
      show(rich, { id: 10, type: 'deliverable' })
      const p = screen.getByTestId('side-panel')
      expect(screen.getByTestId('panel-status')).toHaveTextContent('At risk')
      expect(p).not.toHaveTextContent('at_risk')
      expect(p).toHaveTextContent('Jan 12 (Mon) – Feb 27, 2026 (Fri) · 47 days')
      expect(p).toHaveTextContent('#2F6BD7')
      expect(screen.getByTestId('panel-workstreams')).toHaveTextContent('Platform · primary')
      expect(screen.getByTestId('panel-workstreams')).toHaveTextContent('Growth')
      expect(screen.getByTestId('panel-workstreams').textContent?.match(/primary/g)).toHaveLength(1)
      expect(screen.getByTestId('panel-labels')).toHaveTextContent('High priority')
      const link = screen.getByRole('link', { name: /RFC/ })
      expect(link).toHaveTextContent('wiki.example.com')
      expect(p.querySelector('.riskbox svg')).not.toBeNull()
      expect(p.querySelector('.riskbox')).toHaveTextContent('Vendor is late')
    })

    await step('"· primary" appears only when the deliverable has more than one workstream', () => {
      cleanup()
      window.localStorage.clear()
      const single: RoadmapFull = { ...rich, deliverables: [{ ...rich.deliverables[0], workstream_ids: [1] }, rich.deliverables[1]] }
      show(single, { id: 10, type: 'deliverable' })
      expect(screen.getByTestId('panel-workstreams')).toHaveTextContent('Platform')
      expect(screen.getByTestId('panel-workstreams')).not.toHaveTextContent('primary')
    })

    await step('labels read "None" without icons', () => {
      cleanup()
      window.localStorage.clear()
      show(roadmap, { id: 10, type: 'deliverable' })
      expect(screen.getByTestId('panel-labels')).toHaveTextContent('None')
    })
  })

  it('REQ_FE_113 lists what the deliverable depends on and blocks, with team and a diamond for a milestone; empty lists read "None"', async () => {
    await step('lists what the deliverable depends on and blocks, with team and a diamond for a milestone', () => {
      show(rich, { id: 10, type: 'deliverable' })
      const dep = screen.getByTestId('panel-depends-on')
      expect(dep).toHaveTextContent('Other')
      expect(dep).toHaveTextContent('Billing')
      const blocks = screen.getByTestId('panel-blocks')
      expect(blocks).toHaveTextContent('Launch')
      expect(blocks.querySelector('[data-testid="ms-marker"]')).not.toBeNull()
    })

    await step('empty lists read "None"', () => {
      cleanup()
      window.localStorage.clear()
      show(roadmap, { id: 10, type: 'deliverable' })
      expect(screen.getByTestId('panel-depends-on')).toHaveTextContent('None')
      expect(screen.getByTestId('panel-blocks')).toHaveTextContent('None')
    })
  })

  it('REQ_FE_024 a milestone selection shows name/date/workstream/team; the milestone panel shows a US date, the workstream as a tag and no developer hint', async () => {
    await step('a milestone selection shows name/date/workstream/team', () => {
      render(
        <SidePanel
          roadmap={roadmap}
          selection={{ id: 20, type: 'milestone' }}
          onClose={vi.fn()}
          onDeliverableUpdated={vi.fn()}
          onOpenFullEdit={vi.fn()}
        />,
      )
      expect(screen.getByText('Launch')).toBeInTheDocument()
      expect(screen.getByText('Mar 1, 2026 (Sun)')).toBeInTheDocument()
      expect(screen.queryByLabelText('Open the full edit window')).not.toBeInTheDocument()
    })

    await step('the milestone panel shows a US date, the workstream as a tag and no developer hint', () => {
      cleanup()
      window.localStorage.clear()
      const rm = { ...roadmap, workstreams: [{ ...wsA, id: 1 }] }
      show(rm, { id: 20, type: 'milestone' })
      expect(screen.getByText('Mar 1, 2026 (Sun)')).toBeInTheDocument()
      expect(screen.getByText('Platform')).toHaveClass('tag')
      expect(screen.queryByText(/can be created, dragged/)).not.toBeInTheDocument()
    })
  })
})
