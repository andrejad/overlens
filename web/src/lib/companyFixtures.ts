// Test fixtures for the company views (not shipped: only the *.test.tsx files import it).
import type { CompanyTeam } from '../api/types'
import { isoOf, localDay } from '../timeline/axis'
import type { Deliverable, RoadmapFull, Status, Team } from '../api/types'

// REQ_TEST_017: dates are relative to today (frozen in tests, REQ_TEST_024), not literal.
export const fixtureDay = (offset: number) => isoOf(localDay(new Date()) + offset)

export function team(id: number, name: string, tag: string): Team {
  return { id, name, tag, default_color: '#2f6bd7', roadmap_id: id * 10, created_at: '' }
}

export function deliverable(id: number, teamId: number, roadmapId: number, wsId: number, name: string, start: string, end: string, status: Status = 'planned'): Deliverable {
  return {
    id, roadmap_id: roadmapId, team_id: teamId, name, start_date: start, end_date: end, color: '#2f6bd7', responsible_person: '',
    description_html: '', status, risk_note: '', icons: [], workstream_ids: [wsId], workstreams: [{ id: wsId, row: 0 }], links: [], created_at: '', updated_at: '',
  }
}

export function roadmap(id: number, t: Team, title: string, workstreams: [number, string][], deliverables: Deliverable[]): RoadmapFull {
  return {
    id, team_id: t.id, title, range_start: null, range_end: null, created_at: '', updated_at: '',
    team: t,
    workstreams: workstreams.map(([wid, name], i) => ({ id: wid, roadmap_id: id, name, position: i })),
    deliverables, milestones: [], dependencies: [],
  }
}

// Onboarding (ONB): "Self-Serve" + "Data"; Platform (PLT): "self-serve" (other case) + "Data"; Security (SEC): an empty roadmap.
export function companyFixture(): CompanyTeam[] {
  const onb = team(1, 'Onboarding', 'ONB')
  const plt = team(2, 'Platform', 'PLT')
  const sec = team(3, 'Security', 'SEC')
  const d1 = deliverable(1, 1, 10, 100, 'Signup Flow', fixtureDay(0), fixtureDay(55), 'at_risk')
  const d2 = deliverable(2, 1, 10, 101, 'Activation Dashboard', fixtureDay(27), fixtureDay(147))
  const d3 = deliverable(3, 2, 20, 200, 'API Gateway', fixtureDay(64), fixtureDay(177), 'in_progress')
  const d4 = deliverable(4, 2, 20, 201, 'Warehouse', fixtureDay(86), fixtureDay(356))
  const r1 = roadmap(10, onb, '2026 Plan', [[100, 'Self-Serve'], [101, 'Data']], [d1, d2])
  const r2 = roadmap(20, plt, 'Platform 2026', [[200, 'self-serve'], [201, 'Data']], [d3, d4])
  const edge = {
    from_kind: 'deliverable' as const, from_id: 1, to_kind: 'deliverable' as const, to_id: 3,
    from: { id: 1, name: 'Signup Flow', team_name: 'Onboarding', roadmap_id: 10, start_date: fixtureDay(0), end_date: fixtureDay(55) },
    to: { id: 3, name: 'API Gateway', team_name: 'Platform', roadmap_id: 20, start_date: fixtureDay(64), end_date: fixtureDay(177) },
  }
  r1.dependencies = [edge]
  r2.dependencies = [edge]
  return [
    { team: onb, roadmap: r1 },
    { team: plt, roadmap: r2 },
    { team: sec, roadmap: roadmap(30, sec, 'Security', [], []) },
  ]
}
