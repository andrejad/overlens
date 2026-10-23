// Company view, pure part (Phase 7): merging by workstream name, range, trace and counts.
// REQ_TEST_021 / REQ_FE_052–054, 093, REQ_DEP_021/022, REQ_FE_043.

import { describe, expect, it } from 'vitest'
import type { CompanyTeam, RoadmapFull } from '../api/types'
import { isoOf, localDay, withinCap } from './axis'
import { applyTrace, companyGrid, deriveCompanyRange, mergeByWorkstreamName, norm, traceCounts, traceIds } from './company'
import { addDependency, addDeliverable, addItemDependency, addMilestone, companyTeam, ws } from './testkit'
import { step } from '../testSteps'

const t = localDay(new Date())

// ONB: Platform, " mobile "; PLT: platform, Data; SEC: an empty roadmap; OPS: Mobile
function scene() {
  const onb = companyTeam('Onboarding', 'ONB', ['Platform', ' mobile '])
  const plt = companyTeam('Platform team', 'PLT', ['platform', 'Data'])
  const sec = companyTeam('Security', 'SEC', [])
  const ops = companyTeam('Ops', 'OPS', ['Mobile'])
  const [ro, rp, rx] = [onb.roadmap!, plt.roadmap!, ops.roadmap!]
  const a = addDeliverable(ro, { start: t, end: t + 20, in: [[ws(ro, 'Platform'), 0]], status: 'at_risk', name: 'A' })
  const b = addDeliverable(ro, { start: t + 30, end: t + 40, in: [[ws(ro, ' mobile '), 0], [ws(ro, 'Platform'), 1]], status: 'in_progress', name: 'B' })
  const c = addDeliverable(rp, { start: t + 5, end: t + 25, in: [[ws(rp, 'platform'), 0]], name: 'C' }) // same row number as A, overlapping it
  const d = addDeliverable(rp, { start: t + 50, end: t + 60, in: [[ws(rp, 'Data'), 0]], status: 'in_progress', name: 'D' })
  const e = addDeliverable(rx, { start: t + 100, end: t + 300, in: [[ws(rx, 'Mobile'), 0]], status: 'at_risk', name: 'E' })
  const m = addMilestone(rp, { day: t + 70, in: ws(rp, 'platform'), row: 0, name: 'M' })
  const teams = [onb, plt, sec, ops]
  return { teams, onb, plt, sec, ops, a, b, c, d, e, m }
}
const names = (v: ReturnType<typeof mergeByWorkstreamName>) => v.rows.map((r) => r.name)

describe('REQ_FE_052 merge by workstream name', () => {
  it('REQ_FE_052 same-named workstreams (ignoring case and spaces) of all teams form one row, in the given order; names the order does not list follow alphabetically; every deliverable and milestone keeps its real id and an origin; an empty company merges to an empty roadmap', async () => {
    await step('same-named workstreams (ignoring case and spaces) of all teams form one row, in the given order', () => {
      const { teams } = scene()
      const v = mergeByWorkstreamName(teams, ['Data', 'MOBILE', 'platform'])
      expect(names(v)).toEqual(['Data', 'MOBILE', 'platform']) // the given spelling and order
      expect(v.roadmap.workstreams.map((w) => w.name)).toEqual(['Data', 'MOBILE', 'platform'])
      expect(v.roadmap.workstreams.map((w) => w.position)).toEqual([0, 1, 2])
      const row = (n: string) => v.rows.find((r) => r.name === n)!
      expect(row('platform').members.map((m) => m.teamId).sort()).toEqual([teams[0].team.id, teams[1].team.id].sort())
      expect(row('MOBILE').members).toHaveLength(2)
      expect(row('platform').teams).toBe(2)
    })

    await step('names the order does not list follow alphabetically; names nobody has are skipped', () => {
      const { teams } = scene()
      expect(names(mergeByWorkstreamName(teams, ['ghost', 'Mobile']))).toEqual(['Mobile', 'Data', 'Platform'])
      expect(names(mergeByWorkstreamName(teams, []))).toEqual(['Data', 'mobile', 'Platform'])
    })

    await step('every deliverable and milestone keeps its real id and an origin: team, tag, roadmap, real workstreams', () => {
      const { teams, onb, plt, a, b, c, m } = scene()
      const v = mergeByWorkstreamName(teams, ['Platform', 'Mobile', 'Data'])
      expect(v.roadmap.deliverables.map((d) => d.id).sort()).toEqual(teams.flatMap((x) => x.roadmap?.deliverables ?? []).map((d) => d.id).sort())
      const bm = v.roadmap.deliverables.find((d) => d.id === b.id)!
      expect(bm.workstream_ids).toEqual(v.rows.slice(0, 2).map((r) => r.wsId)) // Platform (-1) then Mobile (-2)
      expect(v.origin.get(b.id)).toEqual({ teamId: onb.team.id, tag: 'ONB', roadmapId: onb.roadmap!.id, workstreamIds: [ws(onb.roadmap!, 'Platform').id, ws(onb.roadmap!, ' mobile ').id] })
      expect(v.origin.get(c.id)!.tag).toBe('PLT')
      expect(v.origin.get(a.id)!.teamId).toBe(onb.team.id)
      expect(v.milestoneOrigin.get(m.id)).toEqual({ teamId: plt.team.id, tag: 'PLT', roadmapId: plt.roadmap!.id, workstreamId: ws(plt.roadmap!, 'platform').id })
      expect(v.roadmap.milestones.find((x) => x.id === m.id)!.workstream_id).toBe(v.rows[0].wsId)
      expect(v.tags.get(c.id)).toBe('PLT')
    })

    await step('an empty company merges to an empty roadmap', () => {
      const v = mergeByWorkstreamName([companyTeam('Solo', 'SOL', [])], [])
      expect(v.rows).toEqual([])
      expect(v.roadmap.workstreams).toEqual([])
    })
  })

  it('REQ_FE_052 workstream ids that collide across teams do not mix: rows are keyed by team and roadmap', () => {
    const { teams, onb } = scene()
    // team X: a copy of ONB's roadmap with the very same workstream ids but its own deliverables
    const x = companyTeam('X', 'XXX', [])
    const clone: RoadmapFull = JSON.parse(JSON.stringify(onb.roadmap))
    clone.id += 5000
    clone.team_id = x.team.id
    clone.team = x.team
    clone.deliverables.forEach((d, i) => Object.assign(d, { id: d.id + 7000 + i, roadmap_id: clone.id, team_id: x.team.id }))
    const all: CompanyTeam[] = [...teams, { team: x.team, roadmap: clone }]
    const v = mergeByWorkstreamName(all, ['Platform'])
    const wsA = ws(onb.roadmap!, 'Platform').id
    expect(ws(clone, 'Platform').id).toBe(wsA)
    const platform = v.rows.find((r) => r.name === 'Platform')!
    expect(platform.members.filter((m) => m.workstreamId === wsA).map((m) => m.teamId).sort()).toEqual([onb.team.id, x.team.id].sort())
    expect(v.origin.get(clone.deliverables[0].id)!.roadmapId).toBe(clone.id)
  })

  it('REQ_FE_052 a team with an empty roadmap adds nothing to the merged view', () => {
    const { teams, sec } = scene()
    const v = mergeByWorkstreamName(teams, [])
    expect([...v.origin.values()].some((o) => o.teamId === sec.team.id)).toBe(false)
    expect(v.rows.every((r) => r.members.every((m) => m.teamId !== sec.team.id))).toBe(true)
  })

  it('REQ_FE_095 a row counts its teams and its deliverables (copies once) and its milestones of every team', async () => {
    await step('a row counts its teams and its deliverables (copies once)', () => {
      const { teams } = scene()
      const v = mergeByWorkstreamName(teams, ['Platform', 'Mobile', 'Data'])
      expect(v.rows.map((r) => [r.name, r.teams, r.deliverables])).toEqual([['Platform', 2, 3], ['Mobile', 2, 1], ['Data', 1, 1]])
    })

    await step('a row counts its milestones of every team', () => {
      const { teams, onb } = scene()
      addMilestone(onb.roadmap!, { day: t + 90, in: ws(onb.roadmap!, 'Platform'), row: 0 })
      const v = mergeByWorkstreamName(teams, ['Platform', 'Mobile', 'Data'])
      expect(v.rows.map((r) => [r.name, r.milestones])).toEqual([['Platform', 2], ['Mobile', 0], ['Data', 0]]) // M (PLT) and ONB's
    })
  })
})

describe('REQ_FE_093 company range', () => {
  it('REQ_FE_093 earliest start and latest end over loaded roadmaps and milestones, beyond 3 years; nothing loaded gives a null range and the empty-roadmap grid', async () => {
    await step('earliest start and latest end over loaded roadmaps and milestones, beyond 3 years', () => {
      const { teams, ops } = scene()
      addDeliverable(ops.roadmap!, { start: t + 2000, end: t + 2400, in: [[ws(ops.roadmap!, 'Mobile'), 1]] })
      addMilestone(teams[0].roadmap!, { day: t - 40, in: ws(teams[0].roadmap!, 'Platform'), row: 1 })
      const r = deriveCompanyRange(teams)
      expect(r).toEqual({ min: t - 40, max: t + 2400 })
      expect(withinCap(r.min!, r.max!)).toBe(false) // the cap is per roadmap, never on the combination
      const g = companyGrid(teams, t)
      expect(g.start).toBeLessThanOrEqual(r.min!)
      expect(g.start + g.days).toBeGreaterThan(r.max!)
    })

    await step('nothing loaded: null range, the empty-roadmap grid; the placeholder team adds nothing', () => {
      expect(deriveCompanyRange([companyTeam('Solo', 'SOL', [])])).toEqual({ min: null, max: null })
      expect(isoOf(deriveCompanyRange(scene().teams).min!)).toBe(isoOf(t))
    })
  })
})

describe('REQ_DEP_021 REQ_DEP_022 trace', () => {
  function traced() {
    const s = scene()
    // A -> B -> D (prerequisite to dependent), C -> B (C is related to B but not to A's chain from A's view: it IS a prerequisite of B)
    addDependency(s.onb.roadmap!, s.a, s.b)
    addDependency(s.onb.roadmap!, s.b, s.d)
    addDependency(s.onb.roadmap!, s.c, s.b)
    return s
  }
  const d_ = (id: number) => ({ kind: 'deliverable' as const, id })
  const trace = (root: number, prerequisites: number[], dependents: number[]) => ({ root: d_(root), prerequisites: prerequisites.map(d_), dependents: dependents.map(d_) })

  it('REQ_DEP_021 REQ_DEP_028 a trace hides everything outside it, milestones included, in the merged view; milestones in the chain stay; empty workstream rows collapse; arrows survive only between two kept ends', async () => {
    await step('a trace hides everything outside it, milestones included, in the merged view', async () => {
      const { teams, a, b, d } = traced()
      const v = mergeByWorkstreamName(teams, ['Platform', 'Mobile', 'Data'])
      const tr = applyTrace(v, traceIds(trace(b.id, [a.id], [d.id])))
      expect(tr.roadmap.deliverables.map((x) => x.id).sort()).toEqual([a.id, b.id, d.id].sort())
      expect(tr.roadmap.milestones).toEqual([]) // M is not in the chain
    })
    await step('milestones in the chain stay, the others go; a row holding only a milestone stays', async () => {
      const { teams, plt, a, b, m } = traced()
      addItemDependency(plt.roadmap!, b, m) // B -> M
      const ids = traceIds({ root: d_(b.id), prerequisites: [d_(a.id)], dependents: [{ kind: 'milestone', id: m.id }] })
      expect(ids.m.has(m.id)).toBe(true)
      const merged = applyTrace(mergeByWorkstreamName(teams, []), ids)
      expect(merged.roadmap.milestones.map((x) => x.id)).toEqual([m.id])
      expect(merged.roadmap.dependencies.map((e) => `${e.from_kind}${e.from_id}>${e.to_kind}${e.to_id}`)).toContain(`deliverable${b.id}>milestone${m.id}`)
      const onlyMs = applyTrace(mergeByWorkstreamName(teams, ['Platform', 'Mobile', 'Data']), { d: new Set(), m: new Set([m.id]) })
      expect(names(onlyMs)).toEqual(['Platform']) // the row is there for the milestone alone
      // a deliverable and a milestone may share a number: only the milestone with that id is kept
      expect(applyTrace(mergeByWorkstreamName(teams, []), { d: new Set([a.id]), m: new Set() }).roadmap.milestones).toEqual([])
    })
    await step('workstream rows left empty collapse', async () => {
      const { teams, a, b } = traced()
      const tr = applyTrace(mergeByWorkstreamName(teams, ['Platform', 'Mobile', 'Data']), new Set([a.id, b.id]))
      // Data and its D are gone; Mobile holds only B's copy (B's main block is in Platform), and a trace never
      // draws copies, so that row collapses too
      expect(names(tr)).toEqual(['Platform'])
      expect(tr.roadmap.deliverables.find((x) => x.id === b.id)!.workstream_ids).toHaveLength(1)
      expect(names(applyTrace(mergeByWorkstreamName(teams, ['Platform', 'Mobile', 'Data']), new Set([a.id])))).toEqual(['Platform']) // B's row is not kept for nothing
    })
    await step('arrows survive only between two kept ends; edges to hidden deliverables go', async () => {
      const { teams, a, b, c, d } = traced()
      const full = mergeByWorkstreamName(teams, [])
      expect(full.roadmap.dependencies).toHaveLength(3)
      const tr = applyTrace(full, new Set([a.id, b.id, d.id]))
      expect(tr.roadmap.dependencies.map((e) => `${e.from_id}>${e.to_id}`).sort()).toEqual([`${a.id}>${b.id}`, `${b.id}>${d.id}`].sort())
      expect(tr.roadmap.dependencies.some((e) => e.from_id === c.id)).toBe(false)
      expect(applyTrace(full, new Set([a.id, b.id])).roadmap.dependencies).toHaveLength(1)
    })
  })

  it('REQ_DEP_022 REQ_DEP_028 trace counts: prerequisites, dependents and loaded items hidden, covering both kinds', async () => {
    await step('counts cover both kinds: items hidden include milestones', async () => {
      const { teams, a, b, m } = traced()
      const total = teams.flatMap((x) => [...x.roadmap.deliverables, ...x.roadmap.milestones]).length
      const ms = { kind: 'milestone' as const, id: m.id }
      expect(traceCounts(mergeByWorkstreamName(teams, []), { root: d_(b.id), prerequisites: [d_(a.id)], dependents: [ms] })).toEqual({ prerequisites: 1, dependents: 1, hidden: total - 3 })
    })
    await step('counts: prerequisites, dependents, loaded items hidden', async () => {
      const { teams, a, b, d } = traced()
      const v = mergeByWorkstreamName(teams, [])
      const total = v.roadmap.deliverables.length + v.roadmap.milestones.length
      expect(traceCounts(v, trace(b.id, [a.id], [d.id]))).toEqual({ prerequisites: 1, dependents: 1, hidden: total - 3 })
      expect(traceCounts(v, trace(b.id, [], [])).hidden).toBe(total - 1) // a deliverable with no dependencies: just itself
    })
  })
})

describe('REQ_FE_052 one normaliser, per code point', () => {
  it('REQ_FE_052 norm trims and lower-cases every code point on its own (no final-sigma context rule), so names differing only by Greek capital sigma case merge into one row across teams', async () => {
    await step('norm trims and lower-cases every code point on its own (no final-sigma context rule)', () => {
      expect(norm('  Platform ')).toBe('platform')
      expect(norm('ΟΔΟΣ')).toBe('οδοσ') // "ΟΔΟΣ".toLowerCase() alone would end in a final sigma, ς
      expect(norm('ΟΔΟΣ')).toBe(norm('οδοσ'))
      expect(norm('Ärger')).toBe(norm('ärger'))
      expect(norm('İ')).toBe(Array.from('İ').map((c) => c.toLowerCase()).join(''))
    })

    await step('names differing only by Greek capital sigma case merge into one row across teams', () => {
      const a = companyTeam('A', 'AAA', ['ΟΔΟΣ'])
      const b = companyTeam('B', 'BBB', ['οδοσ'])
      expect(mergeByWorkstreamName([a, b], []).rows).toHaveLength(1)
    })
  })
})

describe('REQ_FE_052 two workstreams of ONE roadmap that differ only by case', () => {
  it('REQ_FE_052 they form one row and a deliverable in both is drawn once there', () => {
    const team = companyTeam('T', 'TTT', ['Ärger', 'ärger', 'Other'])
    const r = team.roadmap!
    const only = addDeliverable(r, { start: t, end: t + 5, in: [[ws(r, 'ärger'), 0]], name: 'only-in-second' })
    const both = addDeliverable(r, { start: t + 10, end: t + 15, in: [[ws(r, 'Ärger'), 0], [ws(r, 'ärger'), 1]], name: 'in-both' })
    const view = mergeByWorkstreamName([team], ['Ärger', 'Other'])
    expect(view.rows.map((x) => x.name)).toEqual(['Ärger', 'Other'])
    expect(view.rows[0].members).toHaveLength(2)
    expect(view.roadmap.deliverables.find((d) => d.id === both.id)!.workstream_ids).toEqual([view.rows[0].wsId])
    expect(view.roadmap.deliverables.find((d) => d.id === only.id)!.workstream_ids).toEqual([view.rows[0].wsId])
  })
})
