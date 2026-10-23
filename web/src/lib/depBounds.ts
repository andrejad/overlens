// What the edges touching one item allow for its dates (REQ_DEP_006/026): the day after the latest prerequisite end and
// the day before the earliest dependent start. Works for a deliverable and for a milestone alike (a milestone end
// carries its date as start and end). `edges` are the item's own edges (itemEdges).
import type { DependencyEdge, ItemKind, RoadmapDependency } from '../api/types'
import { dayOf, isoOf, nextDay, prevDay } from '../timeline/axis'
import { edgeEnds, itemKey } from '../timeline/deps'

export function dateBounds(edges: DependencyEdge[], kind: ItemKind, id: number): { earliest: string | null; latest: string | null } {
  const me = itemKey(kind, id)
  const prereqEnds = edges.filter((e) => e.other && edgeEnds(e).to === me).map((e) => e.other!.end_date)
  const dependentStarts = edges.filter((e) => e.other && edgeEnds(e).from === me).map((e) => e.other!.start_date)
  return {
    earliest: prereqEnds.length ? isoOf(nextDay(dayOf(prereqEnds.reduce((a, b) => (a > b ? a : b))))) : null,
    latest: dependentStarts.length ? isoOf(prevDay(dayOf(dependentStarts.reduce((a, b) => (a < b ? a : b))))) : null,
  }
}

// The item's own edges, taken from the loaded roadmap's dependencies (every edge with an end in that roadmap, both ends
// with their dates) instead of asking the server again; `other` is the end that is not the item.
export function itemEdges(deps: RoadmapDependency[], kind: ItemKind, id: number): DependencyEdge[] {
  const me = itemKey(kind, id)
  return deps.flatMap(({ from, to, ...ids }) => {
    const ends = edgeEnds(ids)
    return ends.to === me ? [{ ...ids, other: from }] : ends.from === me ? [{ ...ids, other: to }] : []
  })
}
