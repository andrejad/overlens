// The meeting aids of a trace (REQ_DEP_036-039) and the milestones-only view and address (REQ_FE_136/137), pure part.

import { describe, expect, it } from 'vitest'
import { localDay } from '../timeline/axis'
import { applyTrace, mergeByWorkstreamName, onlyMilestones, traceCounts, traceIds } from '../timeline/company'
import { itemKey } from '../timeline/deps'
import { addDeliverable, addItemDependency, addMilestone, companyTeam, ws } from '../timeline/testkit'
import { chainHealth } from './chainHealth'
import { parseRoute } from './router'

const t = localDay(new Date())

// One team, PAY. The chain of M (t+19):
//   m1 (t-30, planned, no prerequisites) -> d2 (t-10..t+5, no owner) -> M      14 days: tight
//   d3 (t-20..t+4, at risk)                                    -> M      15 days: not tight
//   d4 (t-40..t-5, owner only spaces, overdue) -> d5 (t+1..t+10, done) -> M   d4->d5 6 days: tight; d5 done: never tight
//   M -> Q (t+21..t+30)                                                  2 days: tight (a dependent)
// U (t+50) is an unrelated milestone without prerequisites; Z (t+60..t+70) an unrelated deliverable.
function scene() {
  const pay = companyTeam('Payments', 'PAY', ['Platform', 'Risk'])
  const r = pay.roadmap
  const P = ws(r, 'Platform')
  const R = ws(r, 'Risk')
  const owner = <T extends { responsible_person?: string }>(x: T, o: string) => Object.assign(x, { responsible_person: o })
  const m1 = owner(addMilestone(r, { day: t - 30, in: P, row: 0, name: 'KYC sign-off' }), 'Marko Horvat')
  const d2 = addDeliverable(r, { start: t - 10, end: t + 5, in: [[P, 1]], status: 'in_progress', name: 'Card tokenisation' })
  const d3 = owner(addDeliverable(r, { start: t - 20, end: t + 4, in: [[P, 2]], status: 'at_risk', name: 'Fraud rules' }), 'Jana Novak')
  const d4 = owner(addDeliverable(r, { start: t - 40, end: t - 5, in: [[R, 0]], status: 'in_progress', name: 'Limits API' }), '  ')
  const d5 = owner(addDeliverable(r, { start: t + 1, end: t + 10, in: [[R, 0]], status: 'done', name: 'Limit checks' }), 'ana kos')
  const M = owner(addMilestone(r, { day: t + 19, in: P, row: 0, name: 'Payments go-live', status: 'in_progress' }), 'Jana Novak')
  const Q = owner(addDeliverable(r, { start: t + 21, end: t + 30, in: [[P, 1]], name: 'Merchant onboarding' }), 'Boris')
  const U = addMilestone(r, { day: t + 50, in: R, row: 1, name: 'Unrelated' })
  const Z = addDeliverable(r, { start: t + 60, end: t + 70, in: [[R, 0]], name: 'Warehouse' })
  addItemDependency(r, m1, d2)
  addItemDependency(r, d2, M)
  addItemDependency(r, d3, M)
  addItemDependency(r, d4, d5)
  addItemDependency(r, d5, M)
  addItemDependency(r, M, Q)
  const full = mergeByWorkstreamName([pay], [])
  const up = [m1, d2, d3, d4, d5]
  const ref = (x: { id: number; date?: string }) => ({ kind: ('date' in x ? 'milestone' : 'deliverable') as 'milestone' | 'deliverable', id: x.id })
  const trace = { root: ref(M), prerequisites: up.map(ref), dependents: [ref(Q)] }
  return { pay, full, trace, m1, d2, d3, d4, d5, M, Q, U, Z }
}
const view = (s: ReturnType<typeof scene>, upOnly: boolean) => applyTrace(s.full, traceIds(upOnly ? { ...s.trace, dependents: [] } : s.trace))
const key = (x: { id: number; date?: string }) => itemKey('date' in x ? 'milestone' : 'deliverable', x.id)

describe('REQ_DEP_036 the health line', () => {
  it('REQ_DEP_036 counts at risk, overdue, without owner, milestones without prerequisites and tight links over the chain, root included; done items never count; each count names the items it highlights', () => {
    const s = scene()
    const h = chainHealth(view(s, false), t)
    expect(h.items.size).toBe(7)
    expect(h.counts).toEqual({ risk: 1, overdue: 2, owner: 2, gap: 1, tight: 3 })
    expect([...h.focus.risk]).toEqual([key(s.d3)])
    expect([...h.focus.overdue].sort()).toEqual([key(s.m1), key(s.d4)].sort()) // the done d5 and the future items are not overdue
    expect([...h.focus.owner].sort()).toEqual([key(s.d2), key(s.d4)].sort()) // white space is no owner
    expect([...h.focus.gap]).toEqual([key(s.m1)]) // U has no prerequisites too, but it is not in the chain
    expect(h.focus.tight.has(key(s.M)) && h.focus.tight.has(key(s.d2))).toBe(true)
  })
})

describe('REQ_DEP_037 gap flags', () => {
  it('REQ_DEP_037 a milestone without prerequisites gets the gap flag, an item without owner the owner flag, and a done item none', () => {
    const s = scene()
    const h = chainHealth(view(s, false), t)
    expect(h.flags.get(key(s.m1))).toEqual(['gap'])
    expect(h.flags.get(key(s.d2))).toEqual(['owner'])
    expect(h.flags.get(key(s.d4))).toEqual(['owner'])
    s.d4.status = 'done'
    expect(chainHealth(view(s, false), t).flags.has(key(s.d4))).toBe(false)
  })
})

describe('REQ_DEP_038 tight links', () => {
  it('REQ_DEP_038 a link is tight at 14 days or fewer, not at 15, and never when its prerequisite is done', () => {
    const s = scene()
    const h = chainHealth(view(s, false), t)
    expect(h.tight.get(`${key(s.d2)}>${key(s.M)}`)).toEqual({ days: 14, text: '14 days between Card tokenisation and Payments go-live' })
    expect(h.tight.has(`${key(s.d3)}>${key(s.M)}`)).toBe(false) // 15 days
    expect(h.tight.has(`${key(s.d5)}>${key(s.M)}`)).toBe(false) // 9 days, but d5 is done
    expect(h.tight.get(`${key(s.d4)}>${key(s.d5)}`)?.days).toBe(6)
    expect(h.tight.get(`${key(s.M)}>${key(s.Q)}`)?.days).toBe(2)
  })
})

describe('REQ_DEP_039 the Accountable list', () => {
  it('REQ_DEP_039 groups the chain by responsible person, each group by end date, the groups by their earliest end date with "No owner" sorted the same way, with the tight links an item is the prerequisite of', () => {
    const s = scene()
    const h = chainHealth(view(s, false), t)
    // earliest ends: Marko t-30 (m1), No owner t-5 (d4), Jana t+4 (d3, not M's t+19), ana kos t+10, Boris t+30
    expect(h.owners.map((g) => g.owner)).toEqual(['Marko Horvat', '', 'Jana Novak', 'ana kos', 'Boris'])
    expect(h.owners.find((g) => g.owner === 'Jana Novak')!.items.map((i) => i.name)).toEqual(['Fraud rules', 'Payments go-live'])
    expect(h.owners.find((g) => g.owner === '')!.items.map((i) => i.name)).toEqual(['Limits API', 'Card tokenisation'])
    // on the same date: A–Z ignoring case, then "No owner"
    s.d3.end_date = s.d5.end_date = s.d4.end_date
    expect(chainHealth(view(s, false), t).owners.map((g) => g.owner).slice(0, 4)).toEqual(['Marko Horvat', 'ana kos', 'Jana Novak', ''])
    expect(h.items.get(key(s.d2))!.tightBefore).toEqual([{ name: 'Payments go-live', days: 14 }])
  })
})

describe('REQ_FE_137 a milestone chain ends with its milestone', () => {
  it('REQ_FE_137 without the dependents the chain keeps the milestone and its prerequisites only, and its counts follow', () => {
    const s = scene()
    const v = view(s, true)
    expect(v.roadmap.deliverables.map((d) => d.name).sort()).toEqual(['Card tokenisation', 'Fraud rules', 'Limit checks', 'Limits API'])
    expect(v.roadmap.milestones.map((m) => m.name).sort()).toEqual(['KYC sign-off', 'Payments go-live'])
    expect(traceCounts(s.full, { ...s.trace, dependents: [] })).toEqual({ prerequisites: 5, dependents: 0, hidden: 3 }) // Q, U, Z
    expect(chainHealth(v, t).counts.tight).toBe(2) // M -> Q is gone
  })
  it('REQ_FE_137 the address carries the switch on the company view and the trace', () => {
    expect(parseRoute('#/company/workstreams?milestones')).toEqual({ name: 'company', milestones: true })
    expect(parseRoute('#/company/trace/milestone/7?milestones')).toEqual({ name: 'trace', kind: 'milestone', id: 7, milestones: true })
    expect(parseRoute('#/company/trace/milestone/7')).toEqual({ name: 'trace', kind: 'milestone', id: 7 })
    expect(parseRoute('#/company/workstreams')).toEqual({ name: 'company' })
  })
})

describe('REQ_FE_136 milestones only', () => {
  it('REQ_FE_136 keeps every milestone and no deliverable, only arrows between two milestones, and leaves out rows without a milestone', () => {
    const s = scene()
    const extra = companyTeam('Data', 'DAT', ['Warehouse'])
    addDeliverable(extra.roadmap, { start: t, end: t + 5, in: [[ws(extra.roadmap, 'Warehouse'), 0]], name: 'Only a deliverable' })
    addItemDependency(s.pay.roadmap, s.m1, s.U) // a milestone-to-milestone link stays
    const v = onlyMilestones(mergeByWorkstreamName([s.pay, extra], []))
    expect(v.roadmap.deliverables).toEqual([])
    expect(v.roadmap.milestones.map((m) => m.name).sort()).toEqual(['KYC sign-off', 'Payments go-live', 'Unrelated'])
    expect(v.rows.map((r) => r.name)).toEqual(['Platform', 'Risk']) // Warehouse holds no milestone
    expect(v.rows.map((r) => r.milestones)).toEqual([2, 1])
    expect(v.roadmap.dependencies.map((e) => `${e.from.name}>${e.to.name}`)).toEqual(['KYC sign-off>Unrelated'])
    expect(v.filter.milestonesOnly).toBe(true) // the row labels leave out their deliverable part
  })
})
