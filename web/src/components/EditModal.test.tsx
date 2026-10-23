import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EditModal } from './EditModal'
import { SidePanel } from './SidePanel'
import type { RoadmapFull } from '../api/types'

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
  workstreams: [{ id: 1, roadmap_id: 1, name: 'General', position: 0 }],
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
      workstream_ids: [1],
      workstreams: [{ id: 1, row: 0 }],
      links: [],
      created_at: '',
      updated_at: '',
    },
  ],
  milestones: [],
  dependencies: [],
}

// REQ_FE_025: "Every deliverable field can be edited in the edit window, and the panel's quick-edit
// form offers the same fields. The two never drift apart." Both EditModal and SidePanel's quick-edit
// form mount the same DeliverableEditForm component (see both files' own comments) — this asserts
// that structurally, by rendering both and comparing the exact set of field labels each shows,
// rather than just trusting the shared-component claim in prose.
describe('REQ_FE_025 the panel and the full edit window offer the same fields', () => {
  it('REQ_FE_025 the modal and the panel\'s quick-edit form render an identical set of field labels', () => {
    render(<EditModal deliverable={roadmap.deliverables[0]} roadmap={roadmap} onClose={vi.fn()} onSaved={vi.fn()} />)
    const modalLabels = [...document.querySelectorAll('label')].map((l) => l.textContent).sort()
    expect(modalLabels.length).toBeGreaterThan(0)

    document.body.innerHTML = ''
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
    const panelLabels = [...document.querySelectorAll('label')].map((l) => l.textContent).sort()

    expect(panelLabels).toEqual(modalLabels)
  })
})
