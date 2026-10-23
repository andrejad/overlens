import type { DepEnd, DependencyEdge, RoadmapDependency } from '../api/types'

// Test helper: one item's edges, written as GET .../dependencies returns them (`other` = the far end), turned into the
// RoadmapFull.dependencies entries the edit forms read them from. `me` is the item's own end.
export function roadmapDeps(edges: DependencyEdge[], me: DepEnd): RoadmapDependency[] {
  return edges.map(({ other, ...ids }) => {
    const toMe = ids.to_kind === (me.kind ?? 'deliverable') && ids.to_id === me.id
    return { ...ids, from: toMe ? other! : me, to: toMe ? me : other! }
  })
}
