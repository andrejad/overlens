import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { StatusPills } from './StatusPills'
import type { Deliverable, Status } from '../api/types'
import { step } from '../testSteps'

function d(status: Status, id: number): Deliverable {
  return {
    id,
    roadmap_id: 1,
    team_id: 1,
    name: `d${id}`,
    start_date: '2026-01-01',
    end_date: '2026-01-02',
    color: '#000000',
    status,
    responsible_person: '',
    description_html: '',
    risk_note: '',
    icons: [],
    workstream_ids: [],
    workstreams: [],
    links: [],
    created_at: '',
    updated_at: '',
  }
}

describe('REQ_FE_043 header status pills', () => {
  it('REQ_FE_043 counts at-risk and in-progress deliverables from the given list, and updates when the list changes (e.g. after a status edit)', async () => {
    await step('counts at-risk and in-progress deliverables from the given list', () => {
      const deliverables = [d('at_risk', 1), d('at_risk', 2), d('in_progress', 3), d('done', 4), d('planned', 5)]
      render(<StatusPills deliverables={deliverables} />)
      const risk = screen.getByText('2', { selector: '.n' })
      expect(risk).toBeInTheDocument()
      const pills = screen.getByTestId('status-pills')
      expect(pills).toHaveTextContent('2')
      expect(pills).toHaveTextContent('1')
    })

    await step('updates when the deliverable list changes (e.g. after a status edit)', () => {
      cleanup()
      const { rerender } = render(<StatusPills deliverables={[d('planned', 1)]} />)
      expect(screen.getByTestId('status-pills')).toHaveTextContent('0 at risk')
      rerender(<StatusPills deliverables={[d('at_risk', 1)]} />)
      expect(screen.getByTestId('status-pills')).toHaveTextContent('1 at risk')
    })
  })
})
