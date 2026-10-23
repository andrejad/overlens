// Pure drag arithmetic for resizing and moving a deliverable (and moving a milestone): wall-stops (REQ_FE_012), the 3-year cap
// during a drag (REQ_FE_062), and a hook for date limits from elsewhere (dependencies, REQ_DEP_005,
// Phase 5). Everything is in whole days; the pointer is turned into days by axis.ts before it gets here.

import type { RoadmapFull } from '../api/types'
import { dayOf, nextDay, prevDay, withinCap, type Day } from './axis'
import type { PackItem, WorkstreamLayout } from './pack'

export type DragMode = 'start' | 'end' | 'move'

// The earliest allowed start and latest allowed end; null means unbounded.
export interface Bounds {
  lo: Day | null
  hi: Day | null
}

export function tighter(a: Bounds, b: Bounds): Bounds {
  return {
    lo: a.lo === null ? b.lo : b.lo === null ? a.lo : Math.max(a.lo, b.lo),
    hi: a.hi === null ? b.hi : b.hi === null ? a.hi : Math.min(a.hi, b.hi),
  }
}

// Walls: the neighbours of every block of this deliverable, in that block's row. A deliverable in
// several workstreams moves in all of them at once, so a neighbour of any of its blocks — shown or a
// hidden copy — stops it; otherwise a drag could push one of its copies into an overlap that the
// layout would then have to resolve by moving something to another row (REQ_FE_013).
// `skipWs` leaves out workstreams whose row the block is leaving (a drop into another row). A milestone
// (`kind`) has one block and is walled the same way; deliverable and milestone ids are separate series.
export function wallsFor(layout: WorkstreamLayout[], id: number, s0: Day, e0: Day, skipWs: number[] = [], kind: PackItem['kind'] = 'deliverable'): Bounds {
  let lo: Day | null = null
  let hi: Day | null = null
  for (const w of layout) {
    if (skipWs.includes(w.ws.id)) continue
    const self = w.items.find((it) => it.kind === kind && it.id === id)
    if (!self) continue
    for (const o of w.items) {
      if (o.row !== self.row || o === self) continue
      if (o.end < s0) lo = lo === null ? nextDay(o.end) : Math.max(lo, nextDay(o.end))
      else if (o.start > e0) hi = hi === null ? prevDay(o.start) : Math.min(hi, prevDay(o.start))
    }
  }
  return { lo, hi }
}

// The 3-year cap for one deliverable (or milestone, `kind`): may it have these dates? Mirrors the server
// (REQ_DAT_015): the span may not pass 3 years, unless the result still lies inside the range the
// roadmap already has.
export function capCheck(roadmap: RoadmapFull, id: number, kind: PackItem['kind'] = 'deliverable'): (s: Day, e: Day) => boolean {
  let oMin: Day | null = null
  let oMax: Day | null = null
  const add = (a: Day, b: Day) => {
    oMin = oMin === null ? a : Math.min(oMin, a)
    oMax = oMax === null ? b : Math.max(oMax, b)
  }
  let s0: Day | null = null
  let e0: Day | null = null
  for (const d of roadmap.deliverables) {
    if (kind === 'deliverable' && d.id === id) [s0, e0] = [dayOf(d.start_date), dayOf(d.end_date)]
    else add(dayOf(d.start_date), dayOf(d.end_date))
  }
  for (const m of roadmap.milestones) {
    if (kind === 'milestone' && m.id === id) s0 = e0 = dayOf(m.date)
    else add(dayOf(m.date), dayOf(m.date))
  }
  const curMin = Math.min(oMin ?? s0!, s0!)
  const curMax = Math.max(oMax ?? e0!, e0!)
  return (s, e) => {
    const min = Math.min(oMin ?? s, s)
    const max = Math.max(oMax ?? e, e)
    return withinCap(min, max) || (min >= curMin && max <= curMax)
  }
}

export interface Clamped {
  s: Day
  e: Day
  capped: boolean // the 3-year cap stopped it
}

// Where a drag of `dd` days leaves the deliverable, never past a bound (a wall or a date limit) and
// never past the 3-year cap. Resizing never inverts the bar (start <= end always).
export function clampDrag(mode: DragMode, s0: Day, e0: Day, dd: number, b: Bounds, capOk: (s: Day, e: Day) => boolean): Clamped {
  let s = s0
  let e = e0
  if (mode === 'start') {
    s = Math.min(s0 + dd, e0)
    if (b.lo !== null) s = Math.max(s, b.lo)
  } else if (mode === 'end') {
    e = Math.max(e0 + dd, s0)
    if (b.hi !== null) e = Math.min(e, b.hi)
  } else {
    s = s0 + dd
    e = e0 + dd
    if (b.lo !== null && s < b.lo) [s, e] = [b.lo, e + b.lo - s]
    if (b.hi !== null && e > b.hi) [s, e] = [s - (e - b.hi), b.hi]
  }
  // back off one day at a time towards where the drag began until the cap is satisfied
  let capped = false
  while (!capOk(s, e) && (s !== s0 || e !== e0)) {
    capped = true
    if (mode === 'start') s += Math.sign(s0 - s)
    else if (mode === 'end') e += Math.sign(e0 - e)
    else {
      const k = Math.sign(s0 - s)
      s += k
      e += k
    }
  }
  return { s, e, capped }
}
