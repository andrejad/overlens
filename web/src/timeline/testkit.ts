// Test-only builders for the timeline's unit tests: in-memory RoadmapFull objects with valid defaults
// and named handles (REQ_TEST_016's shape, for pure functions that never touch the server). Dates are
// days relative to a clock the test passes in (REQ_TEST_017). Not imported by the app.

import type { CompanyTeam, DepEnd, Deliverable, Milestone, RoadmapDependency, RoadmapFull, Status, Workstream } from '../api/types'
import { isoOf, type Day } from './axis'

let nextId = 1

export function newRoadmap(workstreams: string[] = ['General']): RoadmapFull {
  const id = nextId++
  return {
    id, team_id: 1, title: 'Test roadmap', range_start: null, range_end: null,
    created_at: '', updated_at: '',
    team: { id: 1, name: 'Test team', tag: 'TST', default_color: '#4f6bd8', roadmap_id: id, created_at: '' },
    workstreams: workstreams.map((name, position) => ({ id: nextId++, roadmap_id: id, name, position })),
    deliverables: [],
    milestones: [],
    dependencies: [],
  }
}

// Phase 7: a team with its roadmap (`workstreams`; REQ_DAT_032: every team has one).
// Team ids and workstream ids are all distinct here; tests that need colliding ids build them by hand.
let nextTeam = 1000
export function companyTeam(name: string, tag: string, workstreams: string[]): CompanyTeam {
  const r = newRoadmap(workstreams)
  const team = { id: nextTeam++, name, tag, default_color: '#4f6bd8', roadmap_id: r.id, created_at: '' }
  r.team_id = team.id
  r.team = team
  r.title = `${name} roadmap`
  return { team, roadmap: r }
}

export function ws(r: RoadmapFull, name: string): Workstream {
  return r.workstreams.find((w) => w.name === name)!
}

// `in` is a list of [workstream, row]; the one with the lowest position is the primary.
export function addDeliverable(r: RoadmapFull, o: { start: Day; end: Day; in: [Workstream, number][]; status?: Status; name?: string; icons?: string[] }): Deliverable {
  const members = [...o.in].sort((a, b) => a[0].position - b[0].position)
  const d: Deliverable = {
    id: nextId++, roadmap_id: r.id, team_id: r.team_id, name: o.name ?? `D${nextId}`,
    start_date: isoOf(o.start), end_date: isoOf(o.end), color: '#4f6bd8', responsible_person: '', description_html: '',
    status: o.status ?? 'planned', risk_note: '', icons: o.icons ?? [], links: [], created_at: '', updated_at: '',
    workstream_ids: members.map(([w]) => w.id), workstreams: members.map(([w, row]) => ({ id: w.id, row })),
  }
  r.deliverables.push(d)
  return d
}

// `status` / `risk_note` (REQ_DAT_030) are left out unless given: a milestone without them reads as planned.
export function addMilestone(r: RoadmapFull, o: { day: Day; in: Workstream; row: number; name?: string; status?: Status; risk_note?: string }): Milestone {
  const extra = { ...(o.status && { status: o.status }), ...(o.risk_note && { risk_note: o.risk_note }) }
  const m = { id: nextId++, roadmap_id: r.id, workstream_id: o.in.id, name: o.name ?? `M${nextId}`, date: isoOf(o.day), row: o.row, ...extra } as Milestone
  r.milestones.push(m)
  return m
}

// Phase 5: an edge `from` (prerequisite) -> `to` (dependent), in the shape RoadmapFull.dependencies has
// (docs/API.md). An end that lives on another roadmap is passed as a DepEnd, not a Deliverable.
export function depEnd(d: Deliverable, team = 'Test team'): DepEnd {
  return { id: d.id, name: d.name, team_name: team, roadmap_id: d.roadmap_id, start_date: d.start_date, end_date: d.end_date }
}
export function addDependency(r: RoadmapFull, from: Deliverable | DepEnd, to: Deliverable | DepEnd): RoadmapDependency {
  const end = (x: Deliverable | DepEnd): DepEnd => ('team_name' in x ? x : depEnd(x))
  const e: RoadmapDependency = { from_kind: 'deliverable', from_id: from.id, to_kind: 'deliverable', to_id: to.id, from: end(from), to: end(to) }
  r.dependencies.push(e)
  return e
}

// Phase 9: an edge whose ends may be deliverables or milestones (REQ_DEP_023); a milestone's DepEnd carries its
// date as start and end. Deliverable ends only: use addDependency.
type Item = Deliverable | Milestone
export function addItemDependency(r: RoadmapFull, from: Item, to: Item, team = 'Test team'): RoadmapDependency {
  const kind = (x: Item) => ('date' in x ? 'milestone' : 'deliverable') as 'milestone' | 'deliverable'
  const end = (x: Item): DepEnd => ('date' in x
    ? { kind: 'milestone', id: x.id, name: x.name, team_name: team, roadmap_id: x.roadmap_id, start_date: x.date, end_date: x.date }
    : { ...depEnd(x, team), kind: 'deliverable' })
  const e: RoadmapDependency = {
    from_kind: kind(from), to_kind: kind(to), from_id: from.id, to_id: to.id,
    from: end(from), to: end(to),
  }
  r.dependencies.push(e)
  return e
}

// Seeded PRNG (mulberry32) for the randomized hard-rule tests (REQ_TEST_018): same seed, same run.
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The seed for a randomized run: TEST_SEED replays one exactly, otherwise a fresh one.
export function testSeed(): number {
  const env = typeof process !== 'undefined' ? process.env.TEST_SEED : undefined
  return env ? Number(env) : Math.floor(Math.random() * 2 ** 31)
}
