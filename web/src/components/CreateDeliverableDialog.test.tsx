import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { CreateDeliverableDialog } from './CreateDeliverableDialog'
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

describe('REQ_FE_028/029 create-deliverable dialog', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_FE_029 starts pre-filled with the team default color, and "Reset to team color" restores it after a change', async () => {
    await step('starts pre-filled with the team default color', () => {
      render(<CreateDeliverableDialog roadmap={roadmap} onClose={vi.fn()} onCreated={vi.fn()} />)
      expect(screen.getByLabelText('Deliverable color')).toHaveValue('#2f6bd7')
    })

    await step('"Reset to team color" restores the team default after a change', () => {
      cleanup()
      vi.resetAllMocks()
      render(<CreateDeliverableDialog roadmap={roadmap} onClose={vi.fn()} onCreated={vi.fn()} />)
      const color = screen.getByLabelText('Deliverable color')
      fireEvent.change(color, { target: { value: '#ff0000' } })
      expect(color).toHaveValue('#ff0000')
      fireEvent.click(screen.getByText('Reset to team color'))
      expect(color).toHaveValue('#2f6bd7')
    })
  })

  it('REQ_FE_028 nothing is saved until the explicit "Create deliverable" button is clicked, and the Create button saves every field at once', async () => {
    await step('nothing is saved until the explicit "Create deliverable" button is clicked', () => {
      render(<CreateDeliverableDialog roadmap={roadmap} onClose={vi.fn()} onCreated={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New thing' } })
      fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-01-01' } })
      fireEvent.blur(screen.getByLabelText('Start date'))
      expect(resources.createDeliverable).not.toHaveBeenCalled()
    })

    await step('the Create button saves every field at once', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.createDeliverable).mockResolvedValue({
        id: 99,
      } as never)
      const onCreated = vi.fn()
      render(<CreateDeliverableDialog roadmap={roadmap} onClose={vi.fn()} onCreated={onCreated} />)

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New thing' } })
      fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-01-01' } })
      fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-02-01' } })

      fireEvent.click(screen.getByText('Create deliverable'))

      await waitFor(() =>
        expect(resources.createDeliverable).toHaveBeenCalledWith(1, {
          name: 'New thing',
          start_date: '2026-01-01',
          end_date: '2026-02-01',
          color: '#2f6bd7',
          workstream_ids: [5],
        }),
      )
      expect(onCreated).toHaveBeenCalled()
    })
  })
  // The 3-year cap must be checked before the request is sent, with the exact wording REQ_FE_062
  // requires — not discovered only after a 409 comes back from the server.
  it('REQ_FE_062 dates that would push the roadmap past the 3-year cap are blocked before the request is sent', () => {
    render(<CreateDeliverableDialog roadmap={roadmap} onClose={vi.fn()} onCreated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New thing' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-01-01' } })
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2030-01-01' } })

    fireEvent.click(screen.getByText('Create deliverable'))

    expect(screen.getByRole('alert')).toHaveTextContent(CAP_MESSAGE)
    expect(resources.createDeliverable).not.toHaveBeenCalled()
  })
})
