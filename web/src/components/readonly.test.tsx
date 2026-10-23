import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as resources from '../api/resources'
import { AuthProvider } from '../lib/auth'
import { AddButtons } from './Toolbar'
import { SidePanel } from './SidePanel'
import { RoadmapTitle } from './RoadmapTitle'
import { DependenciesField } from './DependencyPicker'
import type { RoadmapFull } from '../api/types'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null,
  created_at: '', updated_at: '',
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [{ id: 1, roadmap_id: 1, name: 'Self-Serve', position: 0 }],
  deliverables: [
    {
      id: 10, roadmap_id: 1, team_id: 1, name: 'Signup Flow', start_date: '2026-01-01', end_date: '2026-02-01',
      color: '#2f6bd7', status: 'planned', responsible_person: '', description_html: '', risk_note: '',
      icons: [], workstream_ids: [1], workstreams: [{ id: 1, row: 0 }], links: [], created_at: '', updated_at: '',
    },
  ],
  milestones: [], dependencies: [],
}

// The whole editable surface of a roadmap page, under the REAL auth provider (not a hand-set flag).
function surface() {
  return (
    <AuthProvider>
      <RoadmapTitle roadmap={roadmap} onRenamed={vi.fn()} />
      <AddButtons onAddWorkstream={vi.fn()} onAddDeliverable={vi.fn()} onAddMilestone={vi.fn()} />
      <SidePanel
        roadmap={roadmap}
        selection={{ id: 10, type: 'deliverable' }}
        onClose={vi.fn()}
        onDeliverableUpdated={vi.fn()}
        onOpenFullEdit={vi.fn()}
      />
      <DependenciesField item={{ kind: 'deliverable', id: 10 }} edges={[]} onChanged={vi.fn()} />
    </AuthProvider>
  )
}

describe('REQ_FE_083 / REQ_DEP_020 anonymous visitors see no edit controls anywhere', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.localStorage.clear()
    vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
  })

  it('REQ_FE_083 anonymous: no toolbar add buttons, no panel edit buttons, no rename, no workstream or dependency editing', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
    render(surface())
    await waitFor(() => expect(resources.fetchMe).toHaveBeenCalled())
    await screen.findByText('Signup Flow')

    expect(screen.queryByTitle('New deliverable')).not.toBeInTheDocument()
    expect(screen.queryByTitle('New milestone')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Open the full edit window')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /rename the roadmap/i })).not.toBeInTheDocument()
    expect(screen.queryByTitle('New workstream')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Search deliverables and milestones')).not.toBeInTheDocument() // REQ_DEP_020: no picker
    expect(screen.queryByText('(move)')).not.toBeInTheDocument() // REQ_FE_021
    fireEvent.click(screen.getByText('Plan')) // clicking the title text does not open the rename input either
    expect(screen.queryByLabelText('Roadmap title')).not.toBeInTheDocument()
    expect(resources.fetchDependencyCandidates).not.toHaveBeenCalled()
    // the read-only content itself is still there
    expect(screen.getByText('Signup Flow')).toBeInTheDocument()
  })

  it('REQ_FE_083 logged in: the same surface, now with its edit controls (no reload)', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue({ id: 1, username: 'andreja', role: 'admin' })
    render(surface())
    expect(await screen.findByTitle('New deliverable')).toBeInTheDocument()
    expect(screen.getByTitle('New milestone')).toBeInTheDocument()
    expect(screen.getByTitle('New workstream')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /rename the roadmap/i })).toBeInTheDocument()
    expect(await screen.findByLabelText('Search deliverables and milestones')).toBeInTheDocument()
  })
})
