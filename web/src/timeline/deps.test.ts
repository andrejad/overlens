import { describe, expect, it } from 'vitest'
import { isoOf, localDay } from './axis'
import type { RoadmapDependency } from '../api/types'
import { depLimits, limitsForMode, routeArrow } from './deps'
import { step } from '../testSteps'

const t = localDay(new Date())
const end = (id: number, s: number, e: number) => ({ id, name: `D${id}`, team_name: 'T', roadmap_id: 1, start_date: isoOf(s), end_date: isoOf(e) })
const edge = (a: ReturnType<typeof end>, b: ReturnType<typeof end>): RoadmapDependency => ({ from_kind: 'deliverable', from_id: a.id, to_kind: 'deliverable', to_id: b.id, from: a, to: b })

describe('REQ_DEP_005 dependency drag limits', () => {
  const a = end(1, t, t + 9)
  const b = end(2, t + 10, t + 20)
  const c = end(3, t + 30, t + 40)
  const deps = [edge(a, b), edge(b, c)]

  it('REQ_DEP_005 a dependent starts the day after its prerequisite ends and a prerequisite ends the day before its dependent starts; the tightest edge wins; only the side a drag can move is a limit', async () => {
    await step('a dependent starts no earlier than the day after its prerequisite ends', () => {
      expect(depLimits(deps, 2).lo).toBe(t + 10)
      expect(depLimits(deps, 3)).toEqual({ lo: t + 21, hi: null })
    })
    await step('a prerequisite ends no later than the day before its dependent starts', () => {
      expect(depLimits(deps, 1)).toEqual({ lo: null, hi: t + 9 })
      expect(depLimits(deps, 2).hi).toBe(t + 29)
    })
    await step('with several edges the tightest one wins; an unrelated deliverable is unbounded; an off-roadmap end still binds', () => {
      const other = { ...end(9, t + 50, t + 60), roadmap_id: 77 }
      const two = [edge(a, c), edge(b, c), edge(other, end(4, t + 70, t + 80)), edge(end(5, t, t + 1), other)]
      expect(depLimits(two, 3).lo).toBe(t + 21)
      expect(depLimits(two, 4).lo).toBe(t + 61)
      expect(depLimits(two, 5).hi).toBe(t + 49)
      expect(depLimits(two, 99)).toEqual({ lo: null, hi: null })
    })
    await step('only the side a drag can move is a limit line: start drags stop at lo, end drags at hi', () => {
      const both = { lo: 5, hi: 9 }
      expect(limitsForMode(both, 'start')).toEqual({ lo: 5, hi: null })
      expect(limitsForMode(both, 'end')).toEqual({ lo: null, hi: 9 })
      expect(limitsForMode(both, 'move')).toEqual(both)
    })
    await step('an edge with no kinds (a Phase 5 shape) still means two deliverables', () => {
      expect(depLimits([edge(a, b)], 2)).toEqual({ lo: t + 10, hi: null })
    })
  })
})

describe('REQ_DEP_009 arrow routing', () => {
  const box = (x: number, y: number, w = 100) => ({ x, y, w, h: 32 })
  it('REQ_DEP_009 an arrow leaves the right edge of the prerequisite, bends at right angles and ends at the dependent\'s left edge; a bar in the same row gets a straight line; an end left of the start still leaves to the right first', async () => {
    await step('leaves the right edge, bends at right angles, ends at the left edge', () => {
      const r = routeArrow(box(0, 0), box(150, 44))
      expect(r.d).toBe('M100,16 H125 V60 H150')
      expect([r.mx, r.my]).toEqual([125, 38])
    })
    await step('a bar in the same row gets a straight line', () => {
      expect(routeArrow(box(0, 0), box(150, 0)).d).toBe('M100,16 H150')
    })
    await step('an end left of the start still leaves to the right first', () => {
      expect(routeArrow(box(0, 0), { x: 50, y: 60, w: 0, h: 0 }).d).toBe('M100,16 H108 V60 H50')
    })
  })
})

// The x of every point along an M/H/V path, in order.
const xsOf = (d: string) => {
  const xs: number[] = []
  let x = 0
  for (const [, c, rest] of d.matchAll(/([MHV])([^MHV]+)/g)) {
    if (c === 'M') x = Number(rest.split(',')[0])
    else if (c === 'H') x = Number(rest)
    xs.push(x)
  }
  return xs
}
const noBackBend = (d: string) => xsOf(d).every((x, i, all) => i === 0 || x >= all[i - 1])

describe('REQ_DEP_027 an arrow leaving a milestone never takes a back-bend', () => {
  const dia = { x: 100, y: 0, w: 22, h: 22 } // DIAMOND wide: tip at 122, centre at 111, middle y 11
  const bar = (x: number, y: number) => ({ x, y, w: 80, h: 32 })

  it('REQ_DEP_027 an arrow leaving a milestone never takes a back-bend: a dependent 1-10 px right of the tip, at or left of the tip, or with room past the stub', async () => {
    await step('a dependent 1-10 px right of the diamond tip, in another row or the same row: x never decreases', () => {
      for (let gap = 1; gap <= 10; gap++) {
        for (const b of [bar(122 + gap, 40), bar(122 + gap, -60), { x: 122 + gap, y: -5, w: 80, h: 32 }]) {
          const r = routeArrow(dia, b, true)
          expect(noBackBend(r.d), `${gap}px: ${r.d}`).toBe(true)
          expect(r.d.endsWith(`H${122 + gap}`)).toBe(true) // into the dependent's left edge
        }
      }
    })
    await step('a dependent at or left of the tip but right of the centre leaves from the centre, straight down/up then right', () => {
      for (const x of [122, 116, 112]) {
        const down = routeArrow(dia, bar(x, 40), true)
        expect(down.d).toBe(`M111,22 V56 H${x}`) // out of the bottom tip
        expect(noBackBend(down.d)).toBe(true)
        expect([down.mx, down.my]).toEqual([111, 39])
        const up = routeArrow(dia, bar(x, -60), true)
        expect(up.d).toBe(`M111,0 V-44 H${x}`) // out of the top tip
        expect(noBackBend(up.d)).toBe(true)
        const same = routeArrow(dia, { x, y: -5, w: 80, h: 32 }, true)
        expect(same.d).toBe(`M111,11 H${x}`)
      }
    })
    await step('a milestone with room past the stub routes as before; deliverable arrows are unchanged', () => {
      expect(routeArrow(dia, bar(165, 40), true).d).toBe(routeArrow(dia, bar(165, 40)).d)
      const box = (x: number, y: number, w = 100) => ({ x, y, w, h: 32 })
      expect(routeArrow(box(0, 0), box(150, 44)).d).toBe('M100,16 H125 V60 H150')
      expect(routeArrow(box(0, 0), box(104, 44)).d).toBe('M100,16 H102 V60 H104')
      expect(routeArrow(box(0, 0), { x: 50, y: 60, w: 0, h: 0 }).d).toBe('M100,16 H108 V60 H50')
    })
  })
})

describe('REQ_DEP_024 REQ_DEP_026 drag limits with milestones', () => {
  const ms = (id: number, day: number) => ({ kind: 'milestone' as const, id, name: `M${id}`, team_name: 'T', roadmap_id: 1, start_date: isoOf(day), end_date: isoOf(day) })
  const dl = (id: number, s: number, e: number) => ({ kind: 'deliverable' as const, ...end(id, s, e) })
  const link = (a: ReturnType<typeof ms> | ReturnType<typeof dl>, b: ReturnType<typeof ms> | ReturnType<typeof dl>): RoadmapDependency => ({
    from_kind: a.kind, to_kind: b.kind, from_id: a.id, to_id: b.id,
    from: a, to: b,
  })

  it('REQ_DEP_005 REQ_DEP_024 REQ_DEP_026 a milestone\'s date is limited by its prerequisites\' ends and its dependents\' starts, strictly; milestone to milestone, and the tightest of several wins', async () => {
    await step('a milestone\'s date is limited by its prerequisites\' ends and its dependents\' starts, strictly', () => {
      const a = dl(1, t, t + 9)
      const m = ms(1, t + 20) // same number as the deliverable: another item
      const b = dl(2, t + 30, t + 40)
      const deps = [link(a, m), link(m, b)]
      expect(depLimits(deps, 1, 'milestone')).toEqual({ lo: t + 10, hi: t + 29 })
      expect(depLimits(deps, 1, 'deliverable')).toEqual({ lo: null, hi: t + 19 }) // A -> M binds A, not M's number-sake
      expect(depLimits(deps, 2, 'deliverable')).toEqual({ lo: t + 21, hi: null }) // B starts the day after the milestone
    })
    await step('milestone to milestone, and the tightest of several wins', () => {
      const m1 = ms(1, t + 5)
      const m2 = ms(2, t + 15)
      const m3 = ms(3, t + 25)
      const deps = [link(m1, m2), link(m2, m3), link(m1, m3)]
      expect(depLimits(deps, 2, 'milestone')).toEqual({ lo: t + 6, hi: t + 24 })
      expect(depLimits(deps, 3, 'milestone')).toEqual({ lo: t + 16, hi: null })
      expect(depLimits(deps, 1, 'milestone')).toEqual({ lo: null, hi: t + 14 })
    })
  })
})
