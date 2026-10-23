// Dependency arrows, limits and routing for the timeline (Phase 5, REQ_DEP_005/009–012/016–020). Pure;
// every date step goes through axis.ts (nextDay/prevDay) and every pixel comes from dateToX via geometry.ts
// (REQ_FE_065). The edge shapes are api/types.ts's RoadmapDependency (docs/API.md "Dependencies (Phase 5)").

import type { ItemKind, RoadmapDependency } from '../api/types'
import { dayOf, nextDay, prevDay } from './axis'
import type { Bounds, DragMode } from './drag'

// Items are keyed "d:<id>" (deliverable) or "m:<id>" (milestone): the two id series are separate
export const itemKey = (kind: ItemKind, id: number) => `${kind === 'milestone' ? 'm' : 'd'}:${id}`

export interface EdgeEnds {
  from: string
  to: string
  fromId: number
  toId: number
  fromKind: ItemKind
  toKind: ItemKind
}
export function edgeEnds(e: Pick<RoadmapDependency, 'from_kind' | 'from_id' | 'to_kind' | 'to_id'>): EdgeEnds {
  const { from_id: fromId, to_id: toId, from_kind: fromKind, to_kind: toKind } = e
  return { from: itemKey(fromKind, fromId), to: itemKey(toKind, toId), fromId, toId, fromKind, toKind }
}

export const edgeKey = (from: number, to: number) => `${from}-${to}`

// REQ_DEP_005: a dependent may not start before the day after its prerequisite's end, and a prerequisite
// may not end after the day before its dependent's start (the server's date rule, REQ_DEP_004).
// Phase 9 (REQ_DEP_024/026): the same for a milestone (`kind`), whose start and end are both its date; an end that is a
// milestone carries its date as start_date and end_date, so the rule reads the same for all four combinations.
export function depLimits(deps: RoadmapDependency[], id: number, kind: ItemKind = 'deliverable'): Bounds {
  let lo: number | null = null
  let hi: number | null = null
  const me = itemKey(kind, id)
  for (const e of deps) {
    const ends = edgeEnds(e)
    if (ends.to === me) {
      const v = nextDay(dayOf(e.from.end_date))
      lo = lo === null ? v : Math.max(lo, v)
    }
    if (ends.from === me) {
      const v = prevDay(dayOf(e.to.start_date))
      hi = hi === null ? v : Math.min(hi, v)
    }
  }
  return { lo, hi }
}
// Only the side a drag mode can move is a limit worth showing: a start drag stops at `lo`, an end drag at `hi`.
export function limitsForMode(b: Bounds, mode: DragMode): Bounds {
  return { lo: mode === 'end' ? null : b.lo, hi: mode === 'start' ? null : b.hi }
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

// Out of the prerequisite's right edge, right-angle bends, into the dependent's left edge (REQ_DEP_009).
// (mx, my) is the midpoint, where the delete button sits.
// REQ_DEP_027: a milestone's diamond can be wider than a day at fine zoom, so its dependent may start closer than the
// usual exit stub to the right tip, or even left of it. When `fromMilestone` and the gap is under the stub, the arrow
// leaves from the diamond's centre x instead (straight across in the same row, else out of the top/bottom tip, down or
// up, then right into the dependent): never a back-bend. Only when the end is left of the centre (a rubber band
// dragged back) does the usual stub apply.
const EXIT_STUB = 8
export function routeArrow(a: Box, b: Box, fromMilestone = false): { d: string; mx: number; my: number } {
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  const same = Math.abs(y1 - y2) < 1
  const cx = a.x + a.w / 2
  if (fromMilestone && x2 < x1 + EXIT_STUB && x2 > cx) {
    if (same) return { d: `M${cx},${y1} H${x2}`, mx: (cx + x2) / 2, my: y1 }
    const ys = y1 + (y2 > y1 ? a.h / 2 : -a.h / 2)
    return { d: `M${cx},${ys} V${y2} H${x2}`, mx: cx, my: (ys + y2) / 2 }
  }
  if (same) return { d: `M${x1},${y1} H${x2}`, mx: (x1 + x2) / 2, my: y1 }
  const xm = x2 > x1 ? (x1 + x2) / 2 : x1 + EXIT_STUB // a dragged-back rubber band still leaves to the right
  return { d: `M${x1},${y1} H${xm} V${y2} H${x2}`, mx: xm, my: (y1 + y2) / 2 }
}
