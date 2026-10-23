import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { StatusPills } from './StatusPills'
import type { Deliverable, Milestone, Status } from '../api/types'
import { step } from '../testSteps'

const d = (status: Status, id: number) => ({ id, status }) as Deliverable
const ms = (status: Status, id: number): Milestone => ({ id, roadmap_id: 1, workstream_id: 1, name: `M${id}`, date: '2026-03-01', row: 0, status })

describe('REQ_FE_043 the pills count milestones with deliverables', () => {
  it('REQ_FE_043 counts at risk and in progress over deliverables and milestones together, follows a change, and a milestone with no status counts as planned', async () => {
    await step('counts at risk and in progress over deliverables and milestones together, and follows a change', () => {
      const { rerender } = render(<StatusPills deliverables={[d('at_risk', 1)]} milestones={[ms('at_risk', 5), ms('in_progress', 6), ms('planned', 7)]} />)
      expect(screen.getByTestId('status-pills')).toHaveTextContent('2 at risk')
      expect(screen.getByTestId('status-pills')).toHaveTextContent('1 in progress')
      rerender(<StatusPills deliverables={[d('at_risk', 1)]} milestones={[ms('planned', 5), ms('in_progress', 6), ms('planned', 7)]} />)
      expect(screen.getByTestId('status-pills')).toHaveTextContent('1 at risk')
    })

    await step('a milestone with no status counts as planned', () => {
      cleanup()
      const bare: Milestone = { id: 9, roadmap_id: 1, workstream_id: 1, name: 'Bare', date: '2026-03-01', row: 0 }
      render(<StatusPills deliverables={[]} milestones={[bare]} />)
      expect(screen.getByTestId('status-pills')).toHaveTextContent('0 at risk')
      expect(screen.getByTestId('status-pills')).toHaveTextContent('0 in progress')
    })
  })
})
