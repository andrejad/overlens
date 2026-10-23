import { describe, expect, it } from 'vitest'
import { addDate, localDay } from './axis'
import { capCheck, clampDrag, tighter, wallsFor } from './drag'
import { packRoadmap, slotFree } from './pack'
import { addDeliverable, addMilestone, newRoadmap, ws } from './testkit'
import { step } from '../testSteps'

const t = localDay(new Date())
const free = () => true

// Deliverable and milestone ids are separate server sequences, so the same number can name one of
// each; the helpers must never mistake the one for the other.
const buildMilestoneScene = () => {
  const r = newRoadmap(['A', 'B'])
  const a = ws(r, 'A')
  const left = addDeliverable(r, { start: t, end: t + 9, in: [[a, 0]] })
  const ms = addMilestone(r, { day: t + 15, in: a, row: 0 })
  addMilestone(r, { day: t + 22, in: a, row: 0 })
  ms.id = left.id // same number, different kind
  return { r, a, ms }
}

describe('REQ_FE_012 wall-stops', () => {
  const build = () => {
    const r = newRoadmap(['A', 'B'])
    const a = ws(r, 'A')
    const b = ws(r, 'B')
    const left = addDeliverable(r, { start: t, end: t + 9, in: [[a, 0]] })
    const me = addDeliverable(r, { start: t + 20, end: t + 29, in: [[a, 0], [b, 0]] })
    const right = addMilestone(r, { day: t + 40, in: a, row: 0 })
    const other = addDeliverable(r, { start: t + 20, end: t + 60, in: [[a, 1]] }) // another row: not a wall
    const inB = addDeliverable(r, { start: t + 33, end: t + 35, in: [[b, 0]] }) // next to the copy in B
    return { r, a, b, left, me, right, other, inB }
  }

  it('REQ_FE_012 neighbours in the same row bound the start and end, including those next to its copies, and a copy hidden by the copies toggle still walls', async () => {
    await step('neighbours in the same row bound the start and end, including those next to its copies', () => {
      const { r, me } = build()
      expect(wallsFor(packRoadmap(r, true), me.id, t + 20, t + 29)).toEqual({ lo: t + 10, hi: t + 32 })
    })

    await step('a copy hidden by the copies toggle still walls (it would reappear overlapping)', () => {
      const { r, me } = build()
      expect(wallsFor(packRoadmap(r, false), me.id, t + 20, t + 29)).toEqual({ lo: t + 10, hi: t + 32 })
    })
  })

  it('REQ_FE_012 dragging stops at the wall: resizing either edge and moving the whole bar; resizing never turns a bar inside out', async () => {
    await step('dragging stops at the wall: resizing either edge and moving the whole bar', () => {
      const w = { lo: t + 10, hi: t + 32 }
      expect(clampDrag('start', t + 20, t + 29, -50, w, free)).toMatchObject({ s: t + 10, e: t + 29 })
      expect(clampDrag('end', t + 20, t + 29, 50, w, free)).toMatchObject({ s: t + 20, e: t + 32 })
      expect(clampDrag('move', t + 20, t + 29, 50, w, free)).toMatchObject({ s: t + 23, e: t + 32 })
      expect(clampDrag('move', t + 20, t + 29, -50, w, free)).toMatchObject({ s: t + 10, e: t + 19 })
      expect(clampDrag('move', t + 20, t + 29, 2, w, free)).toMatchObject({ s: t + 22, e: t + 31 })
    })

    await step('resizing never turns a bar inside out', () => {
      const none = { lo: null, hi: null }
      expect(clampDrag('start', t, t + 5, 20, none, free)).toMatchObject({ s: t + 5, e: t + 5 })
      expect(clampDrag('end', t, t + 5, -20, none, free)).toMatchObject({ s: t, e: t })
    })
  })

  it('REQ_DEP_005 an extra date limit (the dependency hook) combines with the walls, tightest wins', () => {
    expect(tighter({ lo: t + 10, hi: t + 32 }, { lo: t + 15, hi: null })).toEqual({ lo: t + 15, hi: t + 32 })
    expect(tighter({ lo: null, hi: t + 32 }, { lo: null, hi: t + 30 })).toEqual({ lo: null, hi: t + 30 })
  })
})

describe('REQ_FE_012 REQ_FE_014 milestones are walled and slot-checked like deliverables', () => {
  it('REQ_FE_012 a milestone is stopped by the deliverables and milestones next to it in its row', () => {
    const { r, ms } = buildMilestoneScene()
    const walls = wallsFor(packRoadmap(r, true), ms.id, t + 15, t + 15, [], 'milestone')
    expect(walls).toEqual({ lo: t + 10, hi: t + 21 })
    expect(clampDrag('move', t + 15, t + 15, 30, walls, free)).toMatchObject({ s: t + 21, e: t + 21 })
    expect(clampDrag('move', t + 15, t + 15, -30, walls, free)).toMatchObject({ s: t + 10, e: t + 10 })
  })

  it('REQ_FE_014 REQ_FE_015 a milestone does not fit on an occupied day, and its own day never blocks it', () => {
    const { r, a, ms } = buildMilestoneScene()
    const wsA = packRoadmap(r, true).find((w) => w.ws.id === a.id)!
    expect(slotFree(wsA, 0, t + 5, t + 5, ms.id, 'milestone')).toBe(false) // the deliverable sharing its id still counts
    expect(slotFree(wsA, 0, t + 15, t + 15, ms.id, 'milestone')).toBe(true)
    expect(slotFree(wsA, 0, t + 22, t + 22, ms.id, 'milestone')).toBe(false)
  })
})

describe('REQ_FE_062 the 3-year cap while dragging', () => {
  const build = () => {
    const r = newRoadmap(['A'])
    const a = ws(r, 'A')
    addDeliverable(r, { start: t, end: t + 5, in: [[a, 0]] })
    const last = addDeliverable(r, { start: t + 100, end: t + 110, in: [[a, 1]] })
    return { r, last }
  }

  it('REQ_FE_062 an end dragged past 3 years stops on the last allowed day, and so does a milestone or a whole bar moved past it; drags that stay within the cap are not blocked', async () => {
    await step('an end dragged past 3 years stops on the last allowed day', () => {
      const { r, last } = build()
      const res = clampDrag('end', t + 100, t + 110, 5000, { lo: null, hi: null }, capCheck(r, last.id))
      expect(res).toMatchObject({ e: addDate(t, 3), capped: true })
    })

    await step('a milestone moved past 3 years stops on the last allowed day', () => {
      const { r, ms } = buildMilestoneScene()
      const res = clampDrag('move', t + 15, t + 15, 5000, { lo: null, hi: null }, capCheck(r, ms.id, 'milestone'))
      expect(res).toMatchObject({ s: addDate(t, 3), e: addDate(t, 3), capped: true })
    })

    await step('a whole bar moved past 3 years stops too', () => {
      const { r, last } = build()
      const res = clampDrag('move', t + 100, t + 110, 5000, { lo: null, hi: null }, capCheck(r, last.id))
      expect(res.e).toBe(addDate(t, 3))
      expect(res.e - res.s).toBe(10)
      expect(res.capped).toBe(true)
    })

    await step('drags that stay within the cap are not blocked', () => {
      const { r, last } = build()
      expect(clampDrag('move', t + 100, t + 110, 200, { lo: null, hi: null }, capCheck(r, last.id))).toMatchObject({ s: t + 300, capped: false })
    })
  })

  it('REQ_FE_062 on a roadmap already over the cap, changes inside the current range still work', () => {
    const r = newRoadmap(['A'])
    const a = ws(r, 'A')
    addDeliverable(r, { start: t, end: t + 5, in: [[a, 0]] })
    addDeliverable(r, { start: addDate(t, 3) + 10, end: addDate(t, 3) + 20, in: [[a, 0]] }) // e.g. imported
    const mid = addDeliverable(r, { start: t + 100, end: t + 110, in: [[a, 0]] })
    const ok = capCheck(r, mid.id)
    expect(ok(t + 50, t + 60)).toBe(true)
    expect(ok(t - 1, t + 60)).toBe(false)
  })
})
