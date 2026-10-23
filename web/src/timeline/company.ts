// Company views (Phase 7): pure functions that turn every team's roadmap into something the
// Timeline can draw. No DOM, no pixels; dates are Days from axis.ts (REQ_FE_065).
//
//  - mergeByWorkstreamName: one synthetic RoadmapFull whose workstreams are the merged rows (REQ_FE_052).
//  - deriveCompanyRange / companyGrid: the shared axis (REQ_FE_093; the 3-year cap does not apply to it).
//  - applyTrace + traceCounts (REQ_DEP_021/022), onlyMilestones (REQ_FE_136).
//
// Merged rows have synthetic workstream ids, -1, -2, ... in the full name order; they never reach the server.
// Deliverable and milestone ids are the real ones (globally unique), so the side panel edits the real entity.
// Workstream ids belong to a roadmap, so everything that maps them is keyed `${teamId}:${roadmapId}:${wsId}`.

import type { Deliverable, Milestone, RoadmapDependency, RoadmapFull, Workstream, CompanyTeam, CompanyTrace } from '../api/types'
import { dayOf, gridFor, type Day, type Grid } from './axis'
import { edgeEnds, itemKey } from './deps'
import { trimName } from '../lib/ui'

export interface CompanyRange {
  min: Day | null
  max: Day | null
}

export interface ItemOrigin {
  teamId: number
  tag: string
  roadmapId: number
  workstreamIds: number[] // the real workstreams, in the merged memberships' order
}
export interface MilestoneOrigin {
  teamId: number
  tag: string
  roadmapId: number
  workstreamId: number // the real workstream
}

export interface MergedRow {
  wsId: number // the synthetic workstream id in `roadmap`
  name: string
  teams: number // teams in the row: those that have a workstream of that name (in a trace: those with an item left)
  deliverables: number // deliverables whose main block is in the row (copies not counted), as the row label shows
  milestones: number // milestones in the row, as the row label shows (REQ_FE_095)
  members: { teamId: number; roadmapId: number; workstreamId: number }[]
}

// The items a trace keeps (REQ_DEP_021/028): deliverable ids and milestone ids are separate series. A plain Set<number>
// passed to applyTrace means deliverables only (no milestone is kept), as before Phase 9.
export interface TraceSet {
  d: Set<number>
  m: Set<number>
}
const asTraceSet = (t: Set<number> | TraceSet): TraceSet => (t instanceof Set ? { d: t, m: new Set() } : t)

interface Filter {
  ids: TraceSet | null
  milestonesOnly?: boolean // REQ_FE_136: the row labels leave out their deliverable part
}

export interface MergedView {
  kind: 'merged'
  teams: CompanyTeam[]
  order: string[]
  filter: Filter
  roadmap: RoadmapFull // synthetic: feed it to <Timeline roadmap=...>
  rows: MergedRow[] // in display order, rows with nothing left omitted once a filter is on
  tags: Map<number, string> // deliverable id -> team tag, for Timeline's `teamTags`
  origin: Map<number, ItemOrigin> // by deliverable id
  milestoneOrigin: Map<number, MilestoneOrigin> // by milestone id
}

// The ONE name normaliser (REQ_FE_052): trim, then lower-case code point by code point. This is the server's rule
// (unicode.ToLower per rune after TrimSpace); a per-code-point map also avoids JavaScript's context-sensitive
// final-sigma rule, which would turn "ΟΔΟΣ" into "οδος" and "Σ" alone into "σ" differently from Go.
export const norm = (s: string): string => Array.from(trimName(s)).map((c) => c.toLowerCase()).join('')

// ---------- the merged (workstream) view ----------

function buildMerged(teams: CompanyTeam[], order: string[], filter: Filter): MergedView {
  // The full name order, independent of any filter, so a row keeps its synthetic id while filters come and go:
  // the given order first (names nobody has are skipped), then the names it didn't list, alphabetically.
  const present = new Map<string, string>() // normalised -> first spelling met
  for (const c of teams) for (const w of c.roadmap.workstreams) if (!present.has(norm(w.name))) present.set(norm(w.name), trimName(w.name))
  const names: { key: string; name: string }[] = []
  const seen = new Set<string>()
  for (const n of order) {
    const k = norm(n)
    if (present.has(k) && !seen.has(k)) {
      seen.add(k)
      names.push({ key: k, name: trimName(n) })
    }
  }
  for (const [k, n] of [...present].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) if (!seen.has(k)) names.push({ key: k, name: n })
  const wsIdOf = new Map(names.map((n, i) => [n.key, -(i + 1)]))

  const keep = (id: number) => filter.ids === null || filter.ids.d.has(id)
  const keepMs = (id: number) => filter.ids === null || filter.ids.m.has(id)
  const origin = new Map<number, ItemOrigin>()
  const milestoneOrigin = new Map<number, MilestoneOrigin>()
  const deliverables: Deliverable[] = []
  const milestones: Milestone[] = []
  const memberOf = new Map<number, Map<string, { teamId: number; roadmapId: number; workstreamId: number }>>() // merged ws -> `${team}:${roadmap}:${ws}`
  const edges = new Map<string, RoadmapDependency>()

  for (const c of teams) {
    const r = c.roadmap
    for (const e of r.dependencies) edges.set(`${edgeEnds(e).from}>${edgeEnds(e).to}`, e)
    const merged = new Map<number, number>() // this roadmap's real ws id -> merged ws id
    // Two workstreams of ONE roadmap can differ only by case and so share a merged row. Everything that must pick
    // "the" real workstream of a row then takes the FIRST one by workstream position (ties: lowest id): members
    // are registered in that order and a deliverable in both keeps the first one's membership.
    const byPosition = [...r.workstreams].sort((a, b) => a.position - b.position || a.id - b.id)
    const rank = new Map(byPosition.map((w, i) => [w.id, i]))
    for (const w of byPosition) {
      const m = wsIdOf.get(norm(w.name))!
      merged.set(w.id, m)
      const key = `${c.team.id}:${r.id}:${w.id}`
      if (!memberOf.has(m)) memberOf.set(m, new Map())
      memberOf.get(m)!.set(key, { teamId: c.team.id, roadmapId: r.id, workstreamId: w.id })
    }
    for (const d of r.deliverables) {
      if (!keep(d.id)) continue
      const seenMerged = new Set<number>()
      const ms: { id: number; row: number; real: number }[] = []
      for (const m of [...d.workstreams].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))) {
        const id = merged.get(m.id)
        if (id === undefined || seenMerged.has(id)) continue
        seenMerged.add(id)
        ms.push({ id, row: m.row, real: m.id })
      }
      ms.sort((a, b) => b.id - a.id) // merged order: -1 (first row) before -2
      // REQ_DEP_021: a trace never draws copies (arrows are on), so only the main block counts — a row that
      // would hold nothing but a copy collapses like any other empty row.
      if (filter.ids !== null) ms.length = Math.min(ms.length, 1)
      if (!ms.length) continue
      deliverables.push({ ...d, workstream_ids: ms.map((m) => m.id), workstreams: ms.map((m) => ({ id: m.id, row: m.row })) })
      origin.set(d.id, { teamId: c.team.id, tag: c.team.tag, roadmapId: r.id, workstreamIds: ms.map((m) => m.real) })
    }
    for (const m of r.milestones) {
      if (!keepMs(m.id)) continue // a trace keeps the milestones in its chain (REQ_DEP_028)
      const id = merged.get(m.workstream_id)
      if (id === undefined) continue
      milestones.push({ ...m, workstream_id: id })
      milestoneOrigin.set(m.id, { teamId: c.team.id, tag: c.team.tag, roadmapId: r.id, workstreamId: m.workstream_id })
    }
  }

  const filtered = filter.ids !== null
  const rows: MergedRow[] = []
  for (const n of names) {
    const wsId = wsIdOf.get(n.key)!
    const mine = deliverables.filter((d) => d.workstream_ids.includes(wsId))
    const msIn = milestones.filter((m) => m.workstream_id === wsId)
    if (filtered && !mine.length && !msIn.length) continue // empty rows collapse
    const members = [...(memberOf.get(wsId)?.values() ?? [])]
    const teamIds = new Set<number>(filtered ? [...mine.map((d) => origin.get(d.id)!.teamId), ...msIn.map((m) => milestoneOrigin.get(m.id)!.teamId)] : members.map((m) => m.teamId))
    rows.push({ wsId, name: n.name, teams: teamIds.size, deliverables: mine.filter((d) => d.workstream_ids[0] === wsId).length, milestones: msIn.length, members })
  }
  const workstreams: Workstream[] = rows.map((r, position) => ({ id: r.wsId, roadmap_id: 0, name: r.name, position }))
  const roadmap: RoadmapFull = {
    id: 0, team_id: 0, title: 'Company', range_start: null, range_end: null, created_at: '', updated_at: '',
    team: { id: 0, name: 'Company', tag: '', default_color: '#4f6bd8', roadmap_id: 0, created_at: '' },
    workstreams, deliverables, milestones,
    dependencies: filter.ids === null ? [...edges.values()] : [...edges.values()].filter((e) => inTrace(filter.ids!, e)),
  }
  const tags = new Map<number, string>([...origin].map(([id, o]) => [id, o.tag]))
  return { kind: 'merged', teams, order, filter, roadmap, rows, tags, origin, milestoneOrigin }
}

// REQ_FE_052: same-named workstreams (case-insensitive, trimmed) of every team's roadmap form one row,
// in `order` (the saved workstream order); names it doesn't list follow alphabetically. Rows keep their
// stored per-team rows as hints; where two teams' items clash in a merged row the packer settles it
// deterministically in memory — merged rows are never written back (the company view is read-only for layout).
export function mergeByWorkstreamName(teams: CompanyTeam[], order: string[]): MergedView {
  return buildMerged(teams, order, { ids: null })
}

// Both ends of an edge are in the trace set.
function inTrace(t: TraceSet, e: RoadmapDependency): boolean {
  const ends = edgeEnds(e)
  const has = (kind: string, id: number) => (kind === 'milestone' ? t.m : t.d).has(id)
  return has(ends.fromKind, ends.fromId) && has(ends.toKind, ends.toId)
}

// REQ_DEP_021/028: only what is in `ids` (the root, its prerequisites and dependents; milestones of the chain stay)
// is kept; rows with nothing left collapse. Arrows (dependencies) stay only between two kept ends.
export function applyTrace(view: MergedView, ids: Set<number> | TraceSet): MergedView {
  return buildMerged(view.teams, view.order, { ...view.filter, ids: asTraceSet(ids) })
}
// REQ_FE_136: every milestone and no deliverable, through the trace filter, so copies, arrows to deliverables and
// rows without a milestone go the same way they go in a trace.
export function onlyMilestones(view: MergedView): MergedView {
  const m = new Set(view.teams.flatMap((c) => c.roadmap.milestones.map((x) => x.id)))
  return buildMerged(view.teams, view.order, { ids: { d: new Set(), m }, milestonesOnly: true })
}
// The trace endpoint's answer as the sets `applyTrace` wants: the root and everything on either side.
export function traceIds(t: Pick<CompanyTrace, 'root' | 'prerequisites' | 'dependents'>): TraceSet {
  const out: TraceSet = { d: new Set(), m: new Set() }
  for (const r of [t.root, ...t.prerequisites, ...t.dependents]) (r.kind === 'milestone' ? out.m : out.d).add(r.id)
  return out
}

// REQ_DEP_022/028's stats line. `view` is the view BEFORE (or after: only its teams are read) the trace is applied.
// hidden: loaded items (deliverables and milestones) that are not part of the trace.
export function traceCounts(view: MergedView, t: Pick<CompanyTrace, 'root' | 'prerequisites' | 'dependents'>): { prerequisites: number; dependents: number; hidden: number } {
  const loaded = new Set<string>()
  for (const c of view.teams) {
    for (const d of c.roadmap.deliverables) loaded.add(itemKey('deliverable', d.id))
    for (const m of c.roadmap.milestones) loaded.add(itemKey('milestone', m.id))
  }
  let inChain = 0
  for (const r of new Set([t.root, ...t.prerequisites, ...t.dependents].map((x) => itemKey(x.kind, x.id)))) if (loaded.has(r)) inChain++
  return { prerequisites: t.prerequisites.length, dependents: t.dependents.length, hidden: loaded.size - inChain }
}

// ---------- axis and counts ----------

// REQ_FE_093: earliest start and latest end over the deliverables and milestones of every loaded
// roadmap. No 3-year cap on the combination (it applies to each roadmap alone). Both null when nothing is loaded.
export function deriveCompanyRange(teams: CompanyTeam[]): CompanyRange {
  let min: Day | null = null
  let max: Day | null = null
  const span = (a: Day, b: Day) => {
    min = min === null ? a : Math.min(min, a)
    max = max === null ? b : Math.max(max, b)
  }
  for (const c of teams) {
    for (const d of c.roadmap.deliverables) span(dayOf(d.start_date), dayOf(d.end_date))
    for (const m of c.roadmap.milestones) span(dayOf(m.date), dayOf(m.date))
  }
  return { min, max }
}
// The company axis: pass it to the Timeline as `sharedGrid`.
export function companyGrid(teams: CompanyTeam[], today: Day): Grid {
  const { min, max } = deriveCompanyRange(teams)
  return gridFor(min, max, today)
}
