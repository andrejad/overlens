import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TeamRoadmapPage } from './TeamRoadmapPage'
import * as resources from '../api/resources'
import type { Deliverable, RoadmapDependency, RoadmapFull } from '../api/types'

vi.mock('../api/resources')
vi.mock('../timeline/Timeline', () => ({
  Timeline: (props: {
    roadmap: RoadmapFull
    onPatchDeliverable?: (id: number, patch: Record<string, unknown>) => Promise<unknown>
  }) => (
    <div>
      <span data-testid="edge-from-end">{props.roadmap.dependencies?.[0]?.from.end_date}</span>
      <span data-testid="edge-to-start">{props.roadmap.dependencies?.[0]?.to.start_date}</span>
      <button onClick={() => void props.onPatchDeliverable?.(1, { end_date: '2026-03-15' })}>drag</button>
    </div>
  ),
}))

const end = (id: number, start: string, end: string) => ({ id, name: `D${id}`, team_name: 'T', roadmap_id: 1, start_date: start, end_date: end })
const edge: RoadmapDependency = {
  from_kind: 'deliverable', from_id: 1, to_kind: 'deliverable', to_id: 2,
  from: end(1, '2026-03-01', '2026-03-10'), to: end(2, '2026-03-20', '2026-03-30'),
}
const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: '2026-03-01', range_end: '2026-03-30',
  created_at: '', updated_at: '',
  team: { id: 1, name: 'T', tag: 'T', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [], deliverables: [{ id: 1, status: 'planned', start_date: '2026-03-01', end_date: '2026-03-10' } as Deliverable, { id: 2, status: 'planned', start_date: '2026-03-20', end_date: '2026-03-30' } as Deliverable], milestones: [], dependencies: [edge],
}

describe('REQ_DEP_005 drag limits follow saved dates', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.localStorage.clear()
  })

  it('REQ_DEP_005 a saved date change is reflected in the edges the timeline reads its limits from', async () => {
    vi.mocked(resources.fetchTeam).mockResolvedValue(roadmap.team)
    vi.mocked(resources.fetchRoadmap).mockResolvedValue(roadmap)
    vi.mocked(resources.patchDeliverable).mockResolvedValue({ id: 1, start_date: '2026-03-01', end_date: '2026-03-15' } as Deliverable)
    render(<TeamRoadmapPage teamId={1} />)
    expect(await screen.findByTestId('edge-from-end')).toHaveTextContent('2026-03-10')
    fireEvent.click(screen.getByText('drag'))
    await waitFor(() => expect(screen.getByTestId('edge-from-end')).toHaveTextContent('2026-03-15'))
    expect(screen.getByTestId('edge-to-start')).toHaveTextContent('2026-03-20') // the other end is untouched
  })
})
