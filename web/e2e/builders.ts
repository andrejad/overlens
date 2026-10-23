// Data builders for browser tests (REQ_TEST_016/017): go through the app's real HTTP API, valid
// defaults, named handles, no hardcoded ids.
//
// Auth: every write endpoint needs an admin session (Phase 6, `requireAdmin`). The builders log in once
// as the bootstrap admin that e2e/start-server.sh configures, and send that session cookie on every
// write. global-setup.ts performs the login before any worker starts and shares the cookie through
// ERM_E2E_ADMIN_COOKIE (so no worker ever logs in again); `adminSession()` falls back to logging in itself.

import { join } from 'node:path'

// A logged-out browser state (no cookies) with the guided tour already marked as seen (REQ_FE_130); written by
// global-setup.ts. Specs use it wherever they want an anonymous context, so the tour never opens over the page.
export const ANON_STATE = join(process.cwd(), '.e2e-tmp', 'seen-state.json')
// The bootstrap admin's logged-in browser state; written by global-setup.ts.
export const ADMIN_STATE = join(process.cwd(), '.e2e-tmp', 'admin-state.json')

export const ADMIN_USER = 'e2e-admin'
export const ADMIN_PASSWORD = 'e2e-admin-password'

// Pulls the `session=...` pair out of a login response's Set-Cookie header.
export function sessionCookieFrom(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('session='))
  if (!raw) throw new Error('login response carried no session cookie')
  return raw.split(';')[0]
}

// Logs in through POST /api/login and returns the raw cookie header value ("session=...").
export async function login(baseURL: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseURL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  if (!res.ok) throw new Error(`login as ${username} failed: ${res.status} ${await res.text()}`)
  return sessionCookieFrom(res)
}

const sessions = new Map<string, Promise<string>>()

// The bootstrap admin's session cookie, cached per worker.
export function adminSession(baseURL: string): Promise<string> {
  const shared = process.env.ERM_E2E_ADMIN_COOKIE
  if (shared) return Promise.resolve(shared)
  let p = sessions.get(baseURL)
  if (!p) {
    p = login(baseURL, ADMIN_USER, ADMIN_PASSWORD)
    sessions.set(baseURL, p)
  }
  return p
}

// fetch with the admin session attached; `anonymous: true` sends none (for tests that need a 401).
export async function apiFetch(baseURL: string, path: string, init: RequestInit & { anonymous?: boolean } = {}): Promise<Response> {
  const { anonymous, ...rest } = init
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> | undefined) }
  if (!anonymous) headers.Cookie = await adminSession(baseURL)
  return fetch(`${baseURL}${path}`, { ...rest, headers })
}

const jsonHeaders = { 'Content-Type': 'application/json' }

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export interface TeamHandle {
  id: number
  name: string
  tag: string
}

export interface RoadmapHandle {
  id: number
  teamId: number
  title: string
}

// Creates a team with valid, unique-enough defaults (REQ_TEST_016/017): name and tag both carry a
// random suffix so parallel/repeated runs never collide, and no test has to invent ids or names.
export async function createTeam(baseURL: string, overrides: { name?: string; tag?: string; default_color?: string } = {}): Promise<TeamHandle> {
  const suffix = uniqueSuffix()
  const body = {
    name: overrides.name ?? `Team ${suffix}`,
    // Random letters, not a slice of `suffix`: its leading characters are the same for every team made
    // within the same ~hour, so several teams in one run (REQ_DEP_001 needs two) collided on the tag.
    tag: overrides.tag ?? Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(''),
    default_color: overrides.default_color,
  }
  let res = await apiFetch(baseURL, `/api/teams`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
  // A random tag can meet one another test already took (409 duplicate_tag): draw another, a few times.
  for (let attempt = 0; res.status === 409 && overrides.tag === undefined && attempt < 5; attempt++) {
    body.tag = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')
    res = await apiFetch(baseURL, `/api/teams`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
  }
  if (!res.ok) throw new Error(`createTeam failed: ${res.status} ${await res.text()}`)
  const team = await res.json()
  return { id: team.id, name: team.name, tag: team.tag }
}

// The team's one roadmap (REQ_DAT_032: created with the team, title = the team's name), renamed when a
// title is given.
export async function teamRoadmap(baseURL: string, team: TeamHandle, overrides: { title?: string } = {}): Promise<RoadmapHandle> {
  const t = await (await apiFetch(baseURL, `/api/teams/${team.id}`)).json()
  if (overrides.title === undefined) return { id: t.roadmap_id, teamId: team.id, title: team.name }
  const res = await apiFetch(baseURL, `/api/roadmaps/${t.roadmap_id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ title: overrides.title }) })
  if (!res.ok) throw new Error(`teamRoadmap rename failed: ${res.status} ${await res.text()}`)
  const roadmap = await res.json()
  return { id: roadmap.id, teamId: team.id, title: roadmap.title }
}

export interface WorkstreamHandle {
  id: number
  roadmapId: number
  name: string
}

// Creates a workstream (appended last, per docs/API.md) with a unique-enough default name.
export async function createWorkstream(baseURL: string, roadmap: RoadmapHandle, overrides: { name?: string } = {}): Promise<WorkstreamHandle> {
  const body = { name: overrides.name ?? `Workstream ${uniqueSuffix()}` }
  const res = await apiFetch(baseURL, `/api/roadmaps/${roadmap.id}/workstreams`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`createWorkstream failed: ${res.status} ${await res.text()}`)
  const ws = await res.json()
  return { id: ws.id, roadmapId: roadmap.id, name: ws.name }
}

export interface DeliverableHandle {
  id: number
  roadmapId: number
  name: string
}

// Creates a deliverable spanning [startDate, endDate] in one or more workstreams — passing more
// than one workstream id is what makes the packer render it as a primary block plus `.dup` copies
// (REQ_FE_017/051), which is what 02-copies-off.spec.ts needs to exercise the toggle.
export async function createDeliverable(
  baseURL: string,
  roadmap: RoadmapHandle,
  workstreamIds: number[],
  startDate: string,
  endDate: string,
  overrides: { name?: string; rows?: Record<number, number> } = {},
): Promise<DeliverableHandle> {
  const body = {
    name: overrides.name ?? `Deliverable ${uniqueSuffix()}`,
    start_date: startDate,
    end_date: endDate,
    workstream_ids: workstreamIds,
    ...(overrides.rows ? { rows: overrides.rows } : {}), // an explicit row per workstream id (REQ_DAT_026)
  }
  const res = await apiFetch(baseURL, `/api/roadmaps/${roadmap.id}/deliverables`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`createDeliverable failed: ${res.status} ${await res.text()}`)
  const d = await res.json()
  return { id: d.id, roadmapId: roadmap.id, name: d.name }
}

// ---- dependencies (Phase 5) ----

// ISO date `offset` days from today (REQ_TEST_017: tests speak in relative days, never literal dates).
export function isoDay(offset: number): string {
  const d = new Date()
  d.setHours(12, 0, 0, 0) // noon: DST shifts can't move the calendar day
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Makes `to` depend on `from` (`from` is the prerequisite) through the real API. Throws with the
// server's own body when it is refused, so a test that expects success learns why it did not get it.
export async function createDependency(baseURL: string, from: DeliverableHandle, to: DeliverableHandle): Promise<void> {
  const res = await apiFetch(baseURL, `/api/deliverables/${to.id}/dependencies`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ from_kind: 'deliverable', from_id: from.id }),
  })
  if (!res.ok) throw new Error(`createDependency failed: ${res.status} ${await res.text()}`)
}

// ---- milestone dependencies (Phase 9) ----

export interface MilestoneHandle {
  id: number
  roadmapId: number
  name: string
}

// Creates a milestone on `date` (ISO) in a workstream, through the real API.
export async function createMilestone(baseURL: string, roadmap: RoadmapHandle, workstreamId: number, date: string, overrides: { name?: string } = {}): Promise<MilestoneHandle> {
  const body = { name: overrides.name ?? `Milestone ${uniqueSuffix()}`, date, workstream_id: workstreamId }
  const res = await apiFetch(baseURL, `/api/roadmaps/${roadmap.id}/milestones`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`createMilestone failed: ${res.status} ${await res.text()}`)
  const m = await res.json()
  return { id: m.id, roadmapId: roadmap.id, name: m.name }
}

export type Item = ({ kind: 'deliverable' } & DeliverableHandle) | ({ kind: 'milestone' } & MilestoneHandle)
export const asItem = {
  d: (d: DeliverableHandle): Item => ({ kind: 'deliverable', ...d }),
  m: (m: MilestoneHandle): Item => ({ kind: 'milestone', ...m }),
}

// Makes `to` depend on `from` where either is a deliverable or a milestone.
export async function createItemDependency(baseURL: string, from: Item, to: Item): Promise<void> {
  const res = await apiFetch(baseURL, `/api/${to.kind}s/${to.id}/dependencies`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ from_kind: from.kind, from_id: from.id }),
  })
  if (!res.ok) throw new Error(`createItemDependency failed: ${res.status} ${await res.text()}`)
}

export interface ItemEdgeRow {
  from_kind: string
  to_kind: string
  from_id: number
  to_id: number
}

// Every edge touching a milestone or deliverable, read from the server.
export async function listItemDependencies(baseURL: string, it: Item): Promise<ItemEdgeRow[]> {
  const res = await fetch(`${baseURL}/api/${it.kind}s/${it.id}/dependencies`)
  if (!res.ok) throw new Error(`listItemDependencies failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function getMilestoneDate(baseURL: string, m: MilestoneHandle): Promise<string> {
  const res = await fetch(`${baseURL}/api/roadmaps/${m.roadmapId}`)
  if (!res.ok) throw new Error(`getRoadmap failed: ${res.status}`)
  const body = await res.json()
  return body.milestones.find((x: { id: number }) => x.id === m.id).date
}

export interface EdgeRow {
  from_id: number
  to_id: number
}

// Every edge touching a deliverable, read from the server (what a test asserts against, not the page).
export async function listDependencies(baseURL: string, d: DeliverableHandle): Promise<EdgeRow[]> {
  const res = await fetch(`${baseURL}/api/deliverables/${d.id}/dependencies`)
  if (!res.ok) throw new Error(`listDependencies failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// The stored dates of a deliverable, read from the server.
export async function getDeliverableDates(baseURL: string, d: DeliverableHandle): Promise<{ start: string; end: string }> {
  const res = await fetch(`${baseURL}/api/deliverables/${d.id}`)
  if (!res.ok) throw new Error(`getDeliverable failed: ${res.status} ${await res.text()}`)
  const body = await res.json()
  return { start: body.start_date, end: body.end_date }
}

// A fresh team + roadmap + workstreams: what nearly every dependency test starts from.
export async function createScene(baseURL: string, workstreams = 1) {
  const team = await createTeam(baseURL)
  const roadmap = await teamRoadmap(baseURL, team)
  const ws: WorkstreamHandle[] = []
  for (let i = 0; i < workstreams; i++) ws.push(await createWorkstream(baseURL, roadmap))
  return { team, roadmap, ws }
}

// A deterministic generator for random roadmaps (REQ_TEST_018): TEST_SEED=<n> replays a run exactly.
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function testSeed(): number {
  const fromEnv = Number(process.env.TEST_SEED)
  return process.env.TEST_SEED && Number.isFinite(fromEnv) ? fromEnv : Math.floor(Math.random() * 2 ** 31)
}

// ---- Phase 7: company views ----

const usedTags = new Set<string>()

// A random 2-4 letter uppercase tag, never handed out twice by this process.
function randomTag(): string {
  for (;;) {
    const len = 2 + Math.floor(Math.random() * 3)
    const tag = Array.from({ length: len }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('')
    if (!usedTags.has(tag)) {
      usedTags.add(tag)
      return tag
    }
  }
}

// createTeam with a fresh 2-4 letter tag; retries with another tag if the server says an earlier team already owns it.
export async function createTeamWithFreshTag(baseURL: string, name?: string): Promise<TeamHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await createTeam(baseURL, { name, tag: randomTag() })
    } catch (err) {
      if (attempt >= 5) throw err
    }
  }
}

export interface Company {
  suffix: string
  teamA: TeamHandle // workstreams `mergeName` (first spelling) and `soloA`
  teamB: TeamHandle // workstream `mergeNameUpper` (same name as mergeName, different case)
  teamC: TeamHandle // workstream `soloC`
  teamD: TeamHandle // workstream `legacyD`
  roadmapA: RoadmapHandle
  roadmapB: RoadmapHandle
  roadmapC: RoadmapHandle
  roadmapD: RoadmapHandle
  mergeName: string
  mergeNameUpper: string
  soloA: string
  soloC: string
  legacyD: string
  // chain P -> A -> B -> C (B depends on A, ...); U is unrelated
  P: DeliverableHandle // in legacyD, team D
  A: DeliverableHandle // in mergeName (primary) AND soloA, so it has a copy
  B: DeliverableHandle // in mergeNameUpper
  C: DeliverableHandle // in soloC, team C
  U: DeliverableHandle // unrelated, in soloA
}

// Phase 7 company scene (REQ_TEST_016/017: random names, unique tags, relative dates, no ids hardcoded):
// 4 teams with 2-4 letter tags, two same-named workstreams that differ in case (teams A and B), the chain
// P -> A -> B -> C across four teams' roadmaps, and one unrelated deliverable U.
export async function createCompany(baseURL: string): Promise<Company> {
  const suffix = uniqueSuffix()
  const teamA = await createTeamWithFreshTag(baseURL, `Alpha ${suffix}`)
  const teamB = await createTeamWithFreshTag(baseURL, `Bravo ${suffix}`)
  const teamC = await createTeamWithFreshTag(baseURL, `Charlie ${suffix}`)
  const teamD = await createTeamWithFreshTag(baseURL, `Delta ${suffix}`)
  const mergeName = `Merge ${suffix}`
  const mergeNameUpper = mergeName.toUpperCase()
  const soloA = `SoloA ${suffix}`
  const soloC = `SoloC ${suffix}`
  const legacyD = `Legacy ${suffix}`

  // roadmap id order = creation order, so the first spelling met is team A's
  const roadmapA = await teamRoadmap(baseURL, teamA, { title: `Plan A ${suffix}` })
  const roadmapB = await teamRoadmap(baseURL, teamB, { title: `Plan B ${suffix}` })
  const roadmapC = await teamRoadmap(baseURL, teamC, { title: `Plan C ${suffix}` })
  const roadmapD = await teamRoadmap(baseURL, teamD, { title: `Plan D ${suffix}` })
  const wsMerge = await createWorkstream(baseURL, roadmapA, { name: mergeName })
  const wsSoloA = await createWorkstream(baseURL, roadmapA, { name: soloA })
  const wsMergeUpper = await createWorkstream(baseURL, roadmapB, { name: mergeNameUpper })
  const wsSoloC = await createWorkstream(baseURL, roadmapC, { name: soloC })
  const wsD = await createWorkstream(baseURL, roadmapD, { name: legacyD })

  const P = await createDeliverable(baseURL, roadmapD, [wsD.id], isoDay(-40), isoDay(-20), { name: `Prereq ${suffix}` })
  const A = await createDeliverable(baseURL, roadmapA, [wsMerge.id, wsSoloA.id], isoDay(0), isoDay(25), { name: `Aaa ${suffix}` })
  const B = await createDeliverable(baseURL, roadmapB, [wsMergeUpper.id], isoDay(30), isoDay(60), { name: `Bbb ${suffix}` })
  const C = await createDeliverable(baseURL, roadmapC, [wsSoloC.id], isoDay(65), isoDay(95), { name: `Ccc ${suffix}` })
  const U = await createDeliverable(baseURL, roadmapA, [wsSoloA.id], isoDay(5), isoDay(70), { name: `Unrelated ${suffix}` })
  await createDependency(baseURL, P, A)
  await createDependency(baseURL, A, B)
  await createDependency(baseURL, B, C)
  return { suffix, teamA, teamB, teamC, teamD, roadmapA, roadmapB, roadmapC, roadmapD, mergeName, mergeNameUpper, soloA, soloC, legacyD, P, A, B, C, U }
}

// A seeded random company for the no-overlap test (REQ_TEST_012/018): several teams, workstream names drawn from
// a small shared pool (so rows merge), random deliverables in one or more workstreams, forward dependencies.
export async function createRandomCompany(baseURL: string, rnd: () => number): Promise<void> {
  const pick = (n: number) => Math.floor(rnd() * n)
  const suffix = uniqueSuffix()
  const pool = Array.from({ length: 4 }, (_, i) => `Pool${i} ${suffix}`)
  const made: { d: DeliverableHandle; s: number; e: number }[] = []
  for (let t = 0, nt = 3 + pick(2); t < nt; t++) {
    const team = await createTeamWithFreshTag(baseURL)
    const roadmap = await teamRoadmap(baseURL, team)
    const ws: WorkstreamHandle[] = []
    for (const name of pool) if (rnd() < 0.6 || ws.length === 0) ws.push(await createWorkstream(baseURL, roadmap, { name: rnd() < 0.3 ? name.toUpperCase() : name }))
    for (let i = 0, n = 5 + pick(6); i < n; i++) {
      const s = pick(200) - 20
      const e = s + 2 + pick(50)
      const inWs = ws.filter(() => rnd() < 0.35)
      if (inWs.length === 0) inWs.push(ws[pick(ws.length)])
      made.push({ d: await createDeliverable(baseURL, roadmap, inWs.map((w) => w.id), isoDay(s), isoDay(e)), s, e })
    }
  }
  for (const a of made) for (const b of made) if (a !== b && a.e < b.s && rnd() < 0.15) await createDependency(baseURL, a.d, b.d)
}
