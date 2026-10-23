// Hand-written mirror of the server shapes in docs/API.md (the source of truth); the rest of the frontend imports it
// read-only.
// Ids are integers, dates are "YYYY-MM-DD", timestamps are RFC 3339 UTC, colors are "#rrggbb".

export type ISODate = string

export type Status = 'planned' | 'in_progress' | 'done' | 'at_risk'

export interface Team {
  id: number
  name: string
  tag: string
  default_color: string
  roadmap_id: number // the team's one roadmap (REQ_DAT_032)
  created_at: string
}

export interface Roadmap {
  id: number
  team_id: number
  title: string
  range_start: ISODate | null // null for an empty roadmap
  range_end: ISODate | null
  created_at: string
  updated_at: string
}

export interface Workstream {
  id: number
  roadmap_id: number
  name: string
  position: number
}

export interface LinkInput {
  label: string
  url: string
}

export interface Link extends LinkInput {
  id: number
  position: number
}

// One membership of a deliverable, with the row it occupies in that workstream (REQ_DAT_026).
export interface WorkstreamMembership {
  id: number
  row: number
}

export interface DeliverableInput {
  name: string
  start_date: ISODate
  end_date: ISODate
  color?: string
  responsible_person?: string
  description_html?: string
  status?: Status
  risk_note?: string
  icons?: string[]
  workstream_ids: number[]
  rows?: Record<number, number> // workstream id -> row; JSON object keys arrive as strings
  links?: LinkInput[]
}

// PATCH body: any subset of DeliverableInput.
export type DeliverablePatch = Partial<DeliverableInput>

export interface Deliverable {
  id: number
  roadmap_id: number
  team_id: number
  name: string
  start_date: ISODate
  end_date: ISODate
  color: string
  responsible_person: string
  description_html: string
  status: Status
  risk_note: string
  icons: string[]
  workstream_ids: number[] // ordered by workstream position: the first is the primary
  workstreams: WorkstreamMembership[] // same order, each with its stored row
  links: Link[]
  created_at: string
  updated_at: string
}

// POST /api/{deliverables,milestones}/{id}/move (REQ_API_052): `team_id` is another team; `to` is a destination
// workstream id, {create: name}, or null (drop — a deliverable only). An unmapped workstream goes to the same-named one.
export interface MoveInput {
  team_id: number
  workstream_map?: { from: number; to: number | { create: string } | null }[]
}

// Phase 4: docs/API.md's Milestones section. `row` is optional on create (server picks one) but
// always present on a read/response, so Milestone declares its own required `row` rather than
// extending MilestoneInput.
export interface MilestoneInput {
  name: string
  date: ISODate
  workstream_id: number
  row?: number
  description_html?: string
  // REQ_DAT_030 / REQ_DAT_014: the same fields and rules as a deliverable's
  responsible_person?: string
  status?: Status
  risk_note?: string
  links?: LinkInput[]
}

// PATCH body: any subset of MilestoneInput.
export type MilestonePatch = Partial<MilestoneInput>

export interface Milestone {
  id: number
  roadmap_id: number
  workstream_id: number
  name: string
  date: ISODate
  row: number
  // REQ_DAT_029: the server always returns it ("" when empty); optional here so test fixtures stay short
  description_html?: string
  // REQ_DAT_030 / REQ_DAT_014: always returned by the server ("" / "planned" / [] by default); optional here
  // for the same reason, so readers treat a missing value as the default
  responsible_person?: string
  status?: Status
  risk_note?: string
  links?: Link[]
}

// Phase 4: docs/API.md's Icons section — the 20 fixed keys, GET /api/icons's effective labels.
export interface Icon {
  key: string
  label: string
}

// Phase 6 (docs/API.md "Auth, audit, logs"): GET /api/me, POST /api/login, /api/users, admin audit.
export interface AuthUser {
  id: number
  username: string
  role: string
}

// Never carries a password or hash.
export interface User extends AuthUser {
  disabled: boolean
  created_at: string
}

export interface AuditEntry {
  id: number
  ts: string
  username: string
  action: string
  entity_type: string
  entity_id: number | null
  roadmap_id: number | null
  details: unknown
}

// GET /api/admin/audit: one page, the match count, and audit_retention_days (REQ_AUD_008).
export interface AuditPage {
  items: AuditEntry[]
  total: number
  retention_days: number
}

// The audit viewer's filters (REQ_AUD_016); the same names are the query-string keys of the list and CSV.
export interface AuditFilters {
  user?: string
  action?: string
  type?: string
  team?: string
  deliverable?: string
  from?: string
  to?: string
}

// docs/API.md "Dependencies". An item is a deliverable or a milestone. A dependency from -> to: `from` is the
// prerequisite. Every edge carries from_kind/from_id/to_kind/to_id.
export type ItemKind = 'deliverable' | 'milestone'
export interface ItemRef {
  kind: ItemKind
  id: number
}

export interface DepEnd {
  kind?: ItemKind
  id: number
  name: string
  team_name: string
  roadmap_id: number
  start_date: ISODate // for a milestone start_date and end_date are both its date
  end_date: ISODate
}

interface EdgeIds {
  from_kind: ItemKind
  from_id: number
  to_kind: ItemKind
  to_id: number
}

// GET/POST /api/{deliverables,milestones}/{id}/dependencies: `other` is the end that is not {id}.
export interface DependencyEdge extends EdgeIds {
  other: DepEnd | null
}

// RoadmapFull.dependencies: every edge with either end in the roadmap.
export interface RoadmapDependency extends EdgeIds {
  from: DepEnd
  to: DepEnd
}

export type CandidateBlocked = 'ends_too_late' | 'already_prerequisite' | 'would_cycle'

// GET /api/{deliverables,milestones}/{id}/dependency-candidates: both kinds, ordered by team tag, milestones first, then name.
export interface Candidate {
  kind?: ItemKind
  id: number
  name: string
  team_id: number
  team_name: string
  team_tag: string
  roadmap_id: number
  start_date: ISODate
  end_date: ISODate
  blocked: CandidateBlocked | null
}

export interface RoadmapFull extends Roadmap {
  team: Team
  workstreams: Workstream[]
  deliverables: Deliverable[]
  milestones: Milestone[]
  dependencies: RoadmapDependency[] // the server always sends this, `[]` when none
}

// Phase 7 (docs/API.md "Company view"): GET /api/company/roadmaps -> {items: CompanyTeam[]}, one per team in the
// saved team order; `roadmap` is the team's one roadmap, never null (REQ_DAT_032).
export interface CompanyTeam {
  team: Team
  roadmap: RoadmapFull
}

// GET /api/company/team-order (and its PUT): the effective team order.
export interface TeamOrderItem {
  id: number
  name: string
  tag: string
}

// A DepEnd that also says which team it belongs to.
export interface CompanyEnd extends DepEnd {
  team_id: number
  team_tag: string
}

// GET /api/company/dependencies -> {items: CompanyEdge[]}: every dependency of every roadmap.
export interface CompanyEdge extends EdgeIds {
  from: CompanyEnd
  to: CompanyEnd
}

// GET /api/company/trace/{kind}/{id}: everything {id} depends on (transitively) and everything that depends on it,
// following chains through both kinds. (The old /trace/{id} also answers, with root_id and number arrays; the UI
// does not use that shape.)
export interface CompanyTrace {
  root: ItemRef
  prerequisites: ItemRef[]
  dependents: ItemRef[]
  edges: CompanyEdge[]
}

export interface List<T> {
  items: T[]
  total: number
}

export interface StorageInfo {
  version: string // REQ_DEPLOY_010: the running build ("dev", "unknown" when not stamped)
  build_time: string
  commit: string
  db_bytes: number
  log_bytes: number
  log_files: number
  disk_free_bytes: number
  disk_total_bytes: number
}
