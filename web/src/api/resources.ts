// Thin wrappers around the one `api` axios instance (web/src/api/client.ts) for the endpoints
// documented in docs/API.md that 3c's UI calls. Every POST/PATCH/PUT/DELETE must send
// Content-Type: application/json, including bodiless ones, per API.md's CSRF-defence note; client.ts's
// request interceptor guarantees it, so JSON_HEADERS below is belt and braces, not load-bearing.
import { api } from './client'
import type { CompanyTeam, CompanyTrace, TeamOrderItem, AuditFilters, AuthUser, AuditPage, StorageInfo, User, Candidate, DependencyEdge, Deliverable, Icon, ItemKind, ItemRef, Milestone, MoveInput, Roadmap, RoadmapFull, Team, Workstream } from '../api/types'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

// List endpoints return one page (default 50, max 200, docs/API.md): read every page, so a company with more
// than 50 teams or roadmaps never silently loses the rest (REQ_FE_098).
async function fetchAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (;;) {
    const { data } = await api.get<{ items: T[]; total: number }>(path, { params: { limit: 200, offset: out.length } })
    out.push(...data.items)
    if (data.items.length === 0 || out.length >= data.total) return out
  }
}

export async function fetchTeams(): Promise<Team[]> {
  return fetchAll<Team>('/teams')
}

export async function fetchTeam(id: number): Promise<Team> {
  const { data } = await api.get<Team>(`/teams/${id}`)
  return data
}

export async function fetchRoadmap(id: number): Promise<RoadmapFull> {
  const { data } = await api.get<RoadmapFull>(`/roadmaps/${id}`)
  return data
}

export async function renameRoadmap(id: number, title: string): Promise<Roadmap> {
  const { data } = await api.patch<Roadmap>(`/roadmaps/${id}`, { title }, { headers: JSON_HEADERS })
  return data
}

export async function createWorkstream(roadmapId: number, name: string): Promise<Workstream> {
  const { data } = await api.post<Workstream>(
    `/roadmaps/${roadmapId}/workstreams`,
    { name },
    { headers: JSON_HEADERS },
  )
  return data
}

export async function renameWorkstream(id: number, name: string): Promise<Workstream> {
  const { data } = await api.patch<Workstream>(`/workstreams/${id}`, { name }, { headers: JSON_HEADERS })
  return data
}

export async function reorderWorkstreams(roadmapId: number, ids: number[]): Promise<Workstream[]> {
  const { data } = await api.put<{ items: Workstream[]; total: number }>(
    `/roadmaps/${roadmapId}/workstreams/order`,
    { ids },
    { headers: JSON_HEADERS },
  )
  return data.items
}

export async function deleteWorkstream(id: number, targetId?: number): Promise<void> {
  const params = targetId != null ? { target: targetId } : undefined
  await api.delete(`/workstreams/${id}`, { headers: JSON_HEADERS, params })
}

export async function createDeliverable(
  roadmapId: number,
  input: Record<string, unknown>,
): Promise<Deliverable> {
  const { data } = await api.post<Deliverable>(`/roadmaps/${roadmapId}/deliverables`, input, {
    headers: JSON_HEADERS,
  })
  return data
}

export async function patchDeliverable(
  id: number,
  patch: Record<string, unknown>,
): Promise<Deliverable> {
  const { data } = await api.patch<Deliverable>(`/deliverables/${id}`, patch, { headers: JSON_HEADERS })
  return data
}

export async function patchMilestone(
  id: number,
  patch: Record<string, unknown>,
): Promise<Milestone> {
  const { data } = await api.patch<Milestone>(`/milestones/${id}`, patch, { headers: JSON_HEADERS })
  return data
}

// Moves a deliverable or a milestone to another team's roadmap in one step, one body for both kinds (REQ_API_052);
// its id, dates, links and dependencies are kept (REQ_API_011, 013).
export async function moveItem(kind: ItemKind, id: number, input: MoveInput): Promise<Deliverable | Milestone> {
  const { data } = await api.post<Deliverable | Milestone>(`/${collection(kind)}/${id}/move`, input, { headers: JSON_HEADERS })
  return data
}

export async function createMilestone(
  roadmapId: number,
  input: Record<string, unknown>,
): Promise<Milestone> {
  const { data } = await api.post<Milestone>(`/roadmaps/${roadmapId}/milestones`, input, {
    headers: JSON_HEADERS,
  })
  return data
}

export async function deleteMilestone(id: number): Promise<void> {
  await api.delete(`/milestones/${id}`, { headers: JSON_HEADERS })
}

export async function deleteDeliverable(id: number): Promise<void> {
  await api.delete(`/deliverables/${id}`, { headers: JSON_HEADERS })
}

// Phase 5 + 9 (docs/API.md "Dependencies", "Milestone dependencies (Phase 9)"): `to` is always the dependent, `from` the
// prerequisite; either is a deliverable or a milestone. The collection path is by the dependent's kind.
const collection = (kind: ItemKind) => (kind === 'milestone' ? 'milestones' : 'deliverables')

export async function addDependency(to: ItemRef, from: ItemRef): Promise<DependencyEdge> {
  const { data } = await api.post<DependencyEdge>(
    `/${collection(to.kind)}/${to.id}/dependencies`,
    { from_kind: from.kind, from_id: from.id },
    { headers: JSON_HEADERS },
  )
  return data
}

export async function removeDependency(to: ItemRef, from: ItemRef): Promise<void> {
  await api.delete(`/${collection(to.kind)}/${to.id}/dependencies/${from.kind}/${from.id}`, { headers: JSON_HEADERS })
}

export async function fetchDependencyCandidates(id: number, kind: ItemKind = 'deliverable'): Promise<Candidate[]> {
  const { data } = await api.get<Candidate[]>(`/${collection(kind)}/${id}/dependency-candidates`)
  return data
}

// Phase 4: the fixed 20-icon set's effective labels (GET /api/icons, no auth required — REQ_FE_080). Fetched on each
// page mount, never cached across pages, so a relabel reaches every viewer on their next page.
export async function fetchIcons(): Promise<Icon[]> {
  const { data } = await api.get<{ items: Icon[]; total: number }>('/icons')
  return data.items
}

// Phase 6 auth (docs/API.md "Auth, audit, logs"). The password only ever travels in the login/user bodies.
export async function login(username: string, password: string): Promise<AuthUser> {
  const { data } = await api.post<{ user: AuthUser }>('/login', { username, password })
  return data.user
}

export async function logout(): Promise<void> {
  await api.post('/logout')
}

// Always 200; `user` is null for an anonymous visitor (REQ_AUTH_016).
export async function fetchMe(): Promise<AuthUser | null> {
  const { data } = await api.get<{ user: AuthUser | null }>('/me')
  return data.user
}

export async function fetchUsers(): Promise<User[]> {
  const { data } = await api.get<{ items: User[]; total: number }>('/users')
  return data.items
}

export async function createUser(username: string, password: string): Promise<User> {
  const { data } = await api.post<User>('/users', { username, password })
  return data
}

export async function patchUser(id: number, patch: { password?: string; disabled?: boolean }): Promise<User> {
  const { data } = await api.patch<User>(`/users/${id}`, patch)
  return data
}

export async function createTeam(input: { name: string; tag: string; default_color?: string }): Promise<Team> {
  const { data } = await api.post<Team>('/teams', input)
  return data
}

export async function patchTeam(
  id: number,
  patch: Partial<Pick<Team, 'name' | 'tag' | 'default_color'>>,
): Promise<Team> {
  const { data } = await api.patch<Team>(`/teams/${id}`, patch)
  return data
}

export async function deleteTeam(id: number): Promise<void> {
  await api.delete(`/teams/${id}`)
}

export async function putIconLabel(key: string, label: string): Promise<Icon> {
  const { data } = await api.put<Icon>(`/icons/${key}`, { label })
  return data
}

function filterParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v)
  return params
}

export async function fetchAudit(
  filters: AuditFilters,
  limit: number,
  offset: number,
): Promise<AuditPage> {
  const params = filterParams(filters)
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  const { data } = await api.get<AuditPage>(`/admin/audit?${params}`)
  return data
}

export async function fetchStorage(): Promise<StorageInfo> {
  const { data } = await api.get<StorageInfo>('/admin/storage')
  return data
}

// A plain link target for the browser to download (the session cookie rides along); no paging params.
export function auditCsvUrl(filters: AuditFilters): string {
  const qs = filterParams(filters).toString()
  return `${api.defaults.baseURL ?? '/api'}/admin/audit/export.csv${qs ? `?${qs}` : ''}`
}

// Phase 7 company view (docs/API.md "Company view (Phase 7)"). Reads are anonymous; the two PUTs are admin-only.
export async function fetchCompanyRoadmaps(): Promise<CompanyTeam[]> {
  const { data } = await api.get<{ items: CompanyTeam[] }>('/company/roadmaps')
  return data.items
}

// The effective team order (REQ_FE_094): the team list (REQ_FE_098) and the Company order page read it.
export async function fetchTeamOrder(): Promise<TeamOrderItem[]> {
  const { data } = await api.get<{ items: TeamOrderItem[] }>('/company/team-order')
  return data.items
}

export async function putTeamOrder(teamIds: number[]): Promise<TeamOrderItem[]> {
  const { data } = await api.put<{ items: TeamOrderItem[] }>('/company/team-order', { team_ids: teamIds }, { headers: JSON_HEADERS })
  return data.items
}

export async function fetchWorkstreamOrder(): Promise<string[]> {
  const { data } = await api.get<{ items: string[] }>('/company/workstream-order')
  return data.items
}

export async function putWorkstreamOrder(names: string[]): Promise<string[]> {
  const { data } = await api.put<{ items: string[] }>('/company/workstream-order', { names }, { headers: JSON_HEADERS })
  return data.items
}

// REQ_DEP_028: the typed trace; `#/company/trace/<id>` (no kind) means a deliverable, so the page passes 'deliverable'.
export async function fetchCompanyTrace(kind: ItemKind, id: number): Promise<CompanyTrace> {
  const { data } = await api.get<CompanyTrace>(`/company/trace/${kind}/${id}`)
  return data
}
