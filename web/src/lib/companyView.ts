// Page-level glue for the company view (REQ_FE_052/053/093-097, REQ_DEP_021). The pure view logic (merging, trace,
// counts, axis) lives in timeline/company.ts; this file only keeps what the page needs around fetched data: flat
// lookups and in-place replacement after an edit.
import type { CompanyTeam, DepEnd, Deliverable, ISODate, ItemKind, Milestone, RoadmapDependency, RoadmapFull, Team } from '../api/types'

export function loadedRoadmaps(items: CompanyTeam[]): RoadmapFull[] {
  return items.map((i) => i.roadmap)
}

export function allDeliverables(items: CompanyTeam[]): Deliverable[] {
  return loadedRoadmaps(items).flatMap((r) => r.deliverables)
}

// The edges with the dates of one item brought up to date (each edge embeds both ends' dates, and the drag limits read
// them). An item is told apart by kind: a deliverable and a milestone may share a number.
export function withItemDates(deps: RoadmapDependency[], kind: ItemKind, id: number, start: ISODate, end: ISODate): RoadmapDependency[] {
  const fix = <E extends DepEnd>(e: E): E => ((e.kind ?? 'deliverable') === kind && e.id === id ? { ...e, start_date: start, end_date: end } : e)
  return deps.map((e) => ({ ...e, from: fix(e.from), to: fix(e.to) }))
}

// Replaces one deliverable wherever it lives, and keeps the dependency ends' dates in step in every roadmap that
// carries an edge to it (the edit forms' date limits read them).
export function replaceDeliverable(items: CompanyTeam[], d: Deliverable): CompanyTeam[] {
  return items.map((i) => {
    const r = i.roadmap
    const own = r.deliverables.some((x) => x.id === d.id)
    return {
      ...i,
      roadmap: {
        ...r,
        deliverables: own ? r.deliverables.map((x) => (x.id === d.id ? d : x)) : r.deliverables,
        dependencies: withItemDates(r.dependencies, 'deliverable', d.id, d.start_date, d.end_date),
      },
    }
  })
}

// The same for a milestone (its date is both the start and the end of the ends that name it), in every roadmap
// that carries an edge to it (the other team's roadmap has the edge too).
export function replaceMilestone(items: CompanyTeam[], m: Milestone): CompanyTeam[] {
  return items.map((i) => {
    const r = i.roadmap
    const own = r.milestones.some((x) => x.id === m.id)
    return {
      ...i,
      roadmap: {
        ...r,
        milestones: own ? r.milestones.map((x) => (x.id === m.id ? m : x)) : r.milestones,
        dependencies: withItemDates(r.dependencies, 'milestone', m.id, m.date, m.date),
      },
    }
  })
}

export function findMilestone(items: CompanyTeam[], id: number): { milestone: Milestone; roadmap: RoadmapFull; team: Team } | null {
  for (const i of items) {
    const m = i.roadmap.milestones.find((x) => x.id === id)
    if (m) return { milestone: m, roadmap: i.roadmap, team: i.team }
  }
  return null
}

export function findDeliverable(items: CompanyTeam[], id: number): { deliverable: Deliverable; roadmap: RoadmapFull; team: Team } | null {
  for (const i of items) {
    const d = i.roadmap.deliverables.find((x) => x.id === id)
    if (d) return { deliverable: d, roadmap: i.roadmap, team: i.team }
  }
  return null
}
