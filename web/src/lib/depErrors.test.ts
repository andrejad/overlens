import { describe, expect, it } from 'vitest'
import { addDependencyError, cycleMessage, dateOrderMessage } from './depErrors'
import { step } from '../testSteps'

const err = (error: Record<string, unknown>) => ({ response: { data: { error } } })

describe('REQ_DEP_003 REQ_DEP_025 loops', () => {
  it('REQ_DEP_003 REQ_DEP_025 a loop reads A → B → A; through a milestone each item is named and milestones carry a diamond', async () => {
    await step('a loop of deliverables (names only) reads A → B → A', () => {
      expect(cycleMessage(['A', 'B'])).toBe('That would create a loop: A → B → A')
      expect(addDependencyError(err({ code: 'cycle', message: 'x', path: ['A', 'B', 'A'] }))).toBe('That would create a loop: A → B → A')
    })
    await step('a loop through a milestone names each item and marks the milestones with a diamond', () => {
      const path = [{ kind: 'deliverable', name: 'Design' }, { kind: 'milestone', name: 'Beta launch' }, { kind: 'deliverable', name: 'Build' }]
      expect(cycleMessage(path)).toBe('That would create a loop: Design → ◆ Beta launch → Build → Design')
      expect(addDependencyError(err({ code: 'cycle', message: 'x', path }))).toContain('◆ Beta launch')
      // the server closes the loop on its first item: it is not repeated
      expect(cycleMessage([...path, path[0]])).toBe('That would create a loop: Design → ◆ Beta launch → Build → Design')
    })
  })
})

describe('REQ_DEP_004 REQ_DEP_024 REQ_DEP_026 date_order', () => {
  it('REQ_DEP_004 REQ_DEP_024 REQ_DEP_026 the message names the earliest and latest allowed date, for a milestone and for the deliverable bounds', async () => {
    await step('earliest_date and latest_date of a milestone are named in the message', () => {
      expect(dateOrderMessage(err({ code: 'date_order', message: 'm', earliest_date: '2026-03-06' }))).toContain('2026-03-06')
      expect(dateOrderMessage(err({ code: 'date_order', message: 'm', latest_date: '2026-04-30' }))).toContain('2026-04-30')
      const both = dateOrderMessage(err({ code: 'date_order', message: 'm', earliest_date: '2026-03-06', latest_date: '2026-04-30' }))!
      expect(both).toContain('2026-03-06')
      expect(both).toContain('2026-04-30')
    })
    await step('the deliverable bounds still read earliest_start / latest_end; other errors are not date_order', () => {
      expect(dateOrderMessage(err({ code: 'date_order', message: 'm', earliest_start: '2026-03-06' }))).toContain('2026-03-06')
      expect(dateOrderMessage(err({ code: 'cycle', message: 'm' }))).toBeNull()
    })
    await step('a refused add-dependency names the earliest allowed start in US format', () => {
      expect(addDependencyError(err({ code: 'date_order', message: 'x', earliest_start: '2026-03-06' }))).toBe(
        'The dependent would start too early — the earliest allowed start is Mar 6, 2026',
      )
    })
  })
})
