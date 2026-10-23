import { describe, expect, it } from 'vitest'
import { parseRoute } from './router'
import { replaceDeliverable, replaceMilestone, withItemDates } from './companyView'
import type { CompanyTeam, Deliverable, RoadmapDependency } from '../api/types'
import { step } from '../testSteps'

describe('REQ_FE_091 routes', () => {
  it('REQ_FE_091 the company, trace, team and workstreams addresses parse', () => {
    expect(parseRoute('#/')).toEqual({ name: 'company' }) // the default page is the company view
    expect(parseRoute('')).toEqual({ name: 'company' })
    expect(parseRoute('#/teams')).toEqual({ name: 'teams' })
    expect(parseRoute('#/company')).toEqual({ name: 'company', redirect: true }) // App replaces it with #/company/workstreams
    expect(parseRoute('#/company/workstreams')).toEqual({ name: 'company' })
    expect(parseRoute('#/company/trace/42')).toEqual({ name: 'trace', kind: 'deliverable', id: 42 })
    expect(parseRoute('#/teams/7')).toEqual({ name: 'team', teamId: 7 })
    expect(parseRoute('#/teams/7/workstreams')).toEqual({ name: 'workstreams', teamId: 7 })
    expect(parseRoute('#/admin')).toEqual({ name: 'admin' })
  })
})

describe('REQ_DEP_028 trace addresses', () => {
  it('REQ_DEP_021 REQ_DEP_028 trace addresses: #/company/trace/<kind>/<id> names the item, #/company/trace/<id> still means a deliverable, and a bad kind or id is the trace page\'s not-found state (never another page)', async () => {
    await step('#/company/trace/<kind>/<id> names the item; #/company/trace/<id> still means a deliverable', async () => {
      expect(parseRoute('#/company/trace/milestone/7')).toEqual({ name: 'trace', kind: 'milestone', id: 7 })
      expect(parseRoute('#/company/trace/deliverable/7')).toEqual({ name: 'trace', kind: 'deliverable', id: 7 })
      expect(parseRoute('#/company/trace/7')).toEqual({ name: 'trace', kind: 'deliverable', id: 7 })
      expect(parseRoute('#/company/trace/milestone/7/')).toEqual({ name: 'trace', kind: 'milestone', id: 7 })
    })
    await step('a bad kind or id is the trace page\'s not-found state, never another page', async () => {
      for (const h of ['#/company/trace/epic/7', '#/company/trace/milestone/', '#/company/trace/milestone/abc', '#/company/trace/milestone/0', '#/company/trace/milestone/7/8', '#/company/trace/milestone/99999999999999999999'])
        expect(parseRoute(h), h).toMatchObject({ name: 'trace', id: null })
      expect(parseRoute('#/company/trace/milestone/-1')).toMatchObject({ name: 'trace', id: null })
    })
    // L12 (replaces "a trace address without a numeric id is not a trace"): these are the trace page's not-found
    // state (id null), never the team list, never a request to the server.
    await step('L12: a trace address without a usable id is the trace page with no id', async () => {
      for (const h of ['#/company/trace/', '#/company/trace', '#/company/trace/abc', '#/company/trace/1x', '#/company/trace/-3', '#/company/trace/0', '#/company/trace/1/2', '#/company/trace/9007199254740992', '#/company/trace/99999999999999999999'])
        expect(parseRoute(h), h).toEqual({ name: 'trace', kind: 'deliverable', id: null })
      expect(parseRoute('#/company/trace/9007199254740991')).toEqual({ name: 'trace', kind: 'deliverable', id: Number.MAX_SAFE_INTEGER })
      expect(parseRoute('#/company/traces')).toEqual({ name: 'company' })
    })
  })
})

describe('REQ_DEP_026 edge dates follow a moved milestone', () => {
  const end = (kind: 'deliverable' | 'milestone', id: number, d: string) => ({ kind, id, name: 'x', team_name: 'T', roadmap_id: 1, start_date: d, end_date: d })
  const dep = (): RoadmapDependency => ({
    from_kind: 'milestone', to_kind: 'deliverable', from_id: 5, to_id: 5,
    from: end('milestone', 5, '2026-03-01'), to: end('deliverable', 5, '2026-04-01'),
  })

  it('REQ_DEP_026 edge dates follow a moved milestone: only the end of the same KIND and id is brought up to date, and in the company data every roadmap\'s edge to it (or to an edited deliverable) follows', async () => {
    await step('only the end of the same KIND and id is brought up to date', async () => {
      const [e] = withItemDates([dep()], 'milestone', 5, '2026-03-09', '2026-03-09')
      expect(e.from.start_date).toBe('2026-03-09')
      expect(e.from.end_date).toBe('2026-03-09')
      expect(e.to.start_date).toBe('2026-04-01') // the deliverable that shares the number
    })
    await step('in the company data, the milestone is replaced and every roadmap\'s edge to it follows', async () => {
      const mk = (id: number, withMs: boolean): CompanyTeam => ({
        team: { id, name: 'T', tag: 'T', default_color: '#000000', roadmap_id: 1, created_at: '' },
        roadmap: {
          id: id * 10, team_id: id, title: 'r', range_start: null, range_end: null, created_at: '', updated_at: '',
          team: { id, name: 'T', tag: 'T', default_color: '#000000', roadmap_id: 1, created_at: '' }, workstreams: [], deliverables: [],
          milestones: withMs ? [{ id: 5, roadmap_id: id * 10, workstream_id: 1, name: 'M', date: '2026-03-01', row: 0 }] : [], dependencies: [dep()],
        },
      })
      const out = replaceMilestone([mk(1, true), mk(2, false)], { id: 5, roadmap_id: 10, workstream_id: 1, name: 'M', date: '2026-03-09', row: 0 })
      expect(out[0].roadmap!.milestones[0].date).toBe('2026-03-09')
      expect(out[0].roadmap!.dependencies[0].from.end_date).toBe('2026-03-09')
      expect(out[1].roadmap!.milestones).toEqual([])
      expect(out[1].roadmap!.dependencies[0].from.end_date).toBe('2026-03-09') // the other team's roadmap carries the edge too
    })
    await step('a deliverable\'s new dates reach every roadmap\'s edge to it too, so another team\'s edit form sees them', async () => {
      const mk = (id: number, own: boolean): CompanyTeam => ({
        team: { id, name: 'T', tag: 'T', default_color: '#000000', roadmap_id: 1, created_at: '' },
        roadmap: {
          id: id * 10, team_id: id, title: 'r', range_start: null, range_end: null, created_at: '', updated_at: '',
          team: { id, name: 'T', tag: 'T', default_color: '#000000', roadmap_id: 1, created_at: '' }, workstreams: [], milestones: [],
          deliverables: own ? [{ id: 5, start_date: '2026-04-01', end_date: '2026-04-01' } as Deliverable] : [], dependencies: [dep()],
        },
      })
      const out = replaceDeliverable([mk(1, true), mk(2, false)], { id: 5, start_date: '2026-04-03', end_date: '2026-04-20' } as Deliverable)
      expect(out[0].roadmap!.deliverables[0].end_date).toBe('2026-04-20')
      expect(out[1].roadmap!.deliverables).toEqual([])
      expect(out[1].roadmap!.dependencies[0].to.end_date).toBe('2026-04-20')
      expect(out[1].roadmap!.dependencies[0].from.end_date).toBe('2026-03-01') // the milestone with the same number is untouched
    })
  })
})
