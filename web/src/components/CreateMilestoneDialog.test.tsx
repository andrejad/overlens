import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { CreateMilestoneDialog } from './CreateMilestoneDialog'
import * as resources from '../api/resources'
import { CAP_MESSAGE } from '../timeline/axis'
import type { RoadmapFull } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')

const roadmap: RoadmapFull = {
  id: 1,
  team_id: 1,
  title: 'Plan',
 
  range_start: null,
  range_end: null,
  created_at: '',
  updated_at: '',
 
  team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
  workstreams: [{ id: 5, roadmap_id: 1, name: 'General', position: 0 }],
  deliverables: [],
  milestones: [],
  dependencies: [],
}

describe('REQ_FE_090 create-milestone dialog', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_FE_090 nothing is saved until the explicit "Create milestone" button is clicked; it requires a name and a date; the Create button saves name/date/workstream at once', async () => {
    await step('nothing is saved until the explicit "Create milestone" button is clicked', () => {
      render(<CreateMilestoneDialog roadmap={roadmap} onClose={vi.fn()} onCreated={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta launch' } })
      fireEvent.blur(screen.getByLabelText('Name'))
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-01-01' } })
      fireEvent.blur(screen.getByLabelText('Date'))
      expect(resources.createMilestone).not.toHaveBeenCalled()
    })

    await step('requires a name before creating', () => {
      cleanup()
      vi.resetAllMocks()
      render(<CreateMilestoneDialog roadmap={roadmap} onClose={vi.fn()} onCreated={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-01-01' } })
      fireEvent.click(screen.getByText('Create milestone'))
      expect(screen.getByRole('alert')).toHaveTextContent(/name is required/i)
      expect(resources.createMilestone).not.toHaveBeenCalled()
    })

    await step('requires a date before creating', () => {
      cleanup()
      vi.resetAllMocks()
      render(<CreateMilestoneDialog roadmap={roadmap} onClose={vi.fn()} onCreated={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta launch' } })
      fireEvent.click(screen.getByText('Create milestone'))
      expect(screen.getByRole('alert')).toHaveTextContent(/choose a date/i)
      expect(resources.createMilestone).not.toHaveBeenCalled()
    })

    await step('the Create button saves name/date/workstream at once', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.createMilestone).mockResolvedValue({
        id: 42,
        roadmap_id: 1,
        workstream_id: 5,
        name: 'Beta launch',
        date: '2026-01-01',
        row: 0,
      })
      const onCreated = vi.fn()
      render(<CreateMilestoneDialog roadmap={roadmap} onClose={vi.fn()} onCreated={onCreated} />)

      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Beta launch' } })
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-01-01' } })

      fireEvent.click(screen.getByText('Create milestone'))

      await waitFor(() =>
        expect(resources.createMilestone).toHaveBeenCalledWith(1, {
          name: 'Beta launch',
          date: '2026-01-01',
          workstream_id: 5,
        }),
      )
      expect(onCreated).toHaveBeenCalled()
    })
  })
  // Mirrors CreateDeliverableDialog's M4 fix: the 3-year cap must be checked client-side, before the
  // request is sent, with the exact REQ_FE_062 wording — here for a milestone's single day. A single
  // date has no span of its own, so the roadmap needs an existing item to measure the new date
  // against (same reason CreateDeliverableDialog.test.tsx's own cap test uses a multi-year range).
  it('REQ_FE_062 a date that would push the roadmap past the 3-year cap is blocked before the request is sent', () => {
    const withDeliverable: RoadmapFull = {
      ...roadmap,
      deliverables: [
        {
          id: 1,
          roadmap_id: 1,
          team_id: 1,
          name: 'Existing',
          start_date: '2026-01-01',
          end_date: '2026-01-02',
          color: '#000',
          status: 'planned',
          responsible_person: '',
          description_html: '',
          risk_note: '',
          icons: [],
          workstream_ids: [5],
          workstreams: [],
          links: [],
          created_at: '',
          updated_at: '',
        },
      ],
    }
    render(<CreateMilestoneDialog roadmap={withDeliverable} onClose={vi.fn()} onCreated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Far out' } })
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2030-01-01' } })

    fireEvent.click(screen.getByText('Create milestone'))

    expect(screen.getByRole('alert')).toHaveTextContent(CAP_MESSAGE)
    expect(resources.createMilestone).not.toHaveBeenCalled()
  })
})
