// REQ_TEST_018: the hard layout rules checked on randomly generated roadmaps from a seeded PRNG.
// A failure names the seed; `TEST_SEED=<n> npx vitest run src/timeline/property.test.ts` replays it.

import { describe, expect, it } from 'vitest'
import type { RoadmapFull } from '../api/types'
import { dayOf, gridFor, isoOf, localDay, pxPerDay, withinCap, ZOOMS, type View } from './axis'
import { capCheck, clampDrag, wallsFor, type DragMode } from './drag'
import { barBox, milestoneGeom } from './geometry'
import { packRoadmap, slotFree, storedRowFor, type WorkstreamLayout } from './pack'
import { addDeliverable, addMilestone, companyTeam, newRoadmap, rng, testSeed } from './testkit'
import { applyTrace, mergeByWorkstreamName } from './company'

const seed = testSeed()
const t = localDay(new Date())
const ROADMAPS = 150

function randomRoadmap(rand: () => number): RoadmapFull {
  const int = (n: number) => Math.floor(rand() * n)
  const names = ['Platform', 'Mobile', 'Data', 'Growth'].slice(0, 1 + int(4))
  const r = newRoadmap(names)
  for (let i = int(15); i > 0; i--) {
    const start = t + int(700)
    const members = [...r.workstreams].sort(() => rand() - 0.5).slice(0, 1 + int(Math.min(3, names.length)))
    addDeliverable(r, { start, end: start + int(90), in: members.map((w) => [w, int(4)]) }) // rows may clash: data changed elsewhere
  }
  for (let i = int(6); i > 0; i--) addMilestone(r, { day: t + int(760), in: r.workstreams[int(names.length)], row: int(3) })
  return r
}

// Stored rows become what the layout settled on: clash-free data, as the server keeps it (REQ_API_051, REQ_FE_011).
function settle(r: RoadmapFull): RoadmapFull {
  const layout = packRoadmap(r, true)
  const rowIn = (wsId: number, kind: string, id: number) => layout.find((w) => w.ws.id === wsId)!.items.find((i) => i.kind === kind && i.id === id)!.row
  return {
    ...r,
    deliverables: r.deliverables.map((d) => ({ ...d, workstreams: d.workstreams.map((m) => ({ ...m, row: rowIn(m.id, 'deliverable', d.id) })) })),
    milestones: r.milestones.map((m) => ({ ...m, row: rowIn(m.workstream_id, 'milestone', m.id) })),
  }
}

function overlapsOnScreen(r: RoadmapFull, dupsOn: boolean, view: View, atRisk = false): string[] {
  const out: string[] = []
  for (const w of packRoadmap(r, dupsOn)) {
    const boxes = w.shown.map((it) => {
      let left: number
      let right: number
      if (it.kind === 'deliverable') {
        const b = barBox(it.start, it.end, view)
        ;[left, right] = [b.left, b.left + b.width]
      } else {
        const g = milestoneGeom(it.start, w.shown.filter((o) => o !== it && o.displayRow === it.displayRow), view, atRisk)
        // the diamond (which shows the status itself, REQ_FE_040), its name centred under it and its date to its right
        // (the 40px the date is given room for)
        const dc = g.left + g.size / 2
        // (an at-risk diamond's outline reaches 6px outside the box, and its date starts after the room kept for it)
        left = Math.min(g.left - g.ring, g.label ? dc - g.label.max / 2 : Infinity)
        right = Math.max(g.left + g.size + g.ring, g.label ? dc + g.label.max / 2 : -Infinity, g.date ? g.left + g.size + g.ring + 6 + 40 : -Infinity)
      }
      return { it, left, right }
    })
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]]
        if (a.it.displayRow === b.it.displayRow && a.left < b.right - 1e-6 && b.left < a.right - 1e-6)
          out.push(`${w.ws.name} row ${a.it.displayRow}: ${a.it.kind} ${a.it.id} x ${b.it.kind} ${b.it.id}`)
      }
  }
  return out
}

const rowMap = (layout: WorkstreamLayout[]) => layout.flatMap((w) => w.items.map((i) => `${w.ws.id}:${i.kind}:${i.id}@${i.row}`)).sort()

describe(`REQ_TEST_018 randomized layout rules (seed ${seed})`, () => {
  it('REQ_FE_010 no two items in a row overlap on screen, at every zoom, width and copies setting', () => {
    const rand = rng(seed)
    for (let n = 0; n < ROADMAPS; n++) {
      const r = randomRoadmap(rand)
      const days = r.deliverables.flatMap((d) => [dayOf(d.start_date), dayOf(d.end_date)]).concat(r.milestones.map((m) => dayOf(m.date)))
      const grid = gridFor(days.length ? Math.min(...days) : null, days.length ? Math.max(...days) : null, t)
      for (const width of [640, 1000, 1700])
        for (const z of ZOOMS)
          for (const dupsOn of [true, false]) for (const risk of [false, true]) expect(overlapsOnScreen(r, dupsOn, { ...grid, px: pxPerDay(z, width) }, risk), `seed ${seed} roadmap ${n} ${z}@${width} copies ${dupsOn} at risk ${risk}`).toEqual([])
    }
  })

  it('REQ_FE_011 REQ_FE_017 settled rows never move on repacking, and hiding copies moves nothing else', () => {
    const rand = rng(seed)
    for (let n = 0; n < ROADMAPS; n++) {
      const r = settle(randomRoadmap(rand))
      const on = packRoadmap(r, true)
      expect(on.flatMap((w) => w.relocated), `seed ${seed} roadmap ${n}`).toEqual([])
      const off = packRoadmap(r, false)
      expect(rowMap(off), `seed ${seed} roadmap ${n}`).toEqual(rowMap(on))
      off.forEach((w, i) => expect(w.rows, `seed ${seed} roadmap ${n}`).toBeLessThanOrEqual(on[i].rows))
    }
  })

  it('REQ_FE_012 REQ_FE_013 REQ_FE_062 random drags stop at walls and the cap: nothing ever changes row as a result', () => {
    const rand = rng(seed)
    const int = (k: number) => Math.floor(rand() * k)
    for (let n = 0; n < ROADMAPS; n++) {
      let r = settle(randomRoadmap(rand))
      for (let step = 0; step < 20 && r.deliverables.length; step++) {
        const d = r.deliverables[int(r.deliverables.length)]
        const [s0, e0] = [dayOf(d.start_date), dayOf(d.end_date)]
        const mode = (['start', 'end', 'move'] as DragMode[])[int(3)]
        const dd = int(3) === 0 ? int(3000) - 1500 : int(120) - 60
        const layout = packRoadmap(r, rand() < 0.5)
        const res = clampDrag(mode, s0, e0, dd, wallsFor(layout, d.id, s0, e0), capCheck(r, d.id))
        const before = rowMap(packRoadmap(r, true))
        r = { ...r, deliverables: r.deliverables.map((x) => (x.id === d.id ? { ...x, start_date: isoOf(res.s), end_date: isoOf(res.e) } : x)) }
        const after = packRoadmap(r, true)
        const ctx = `seed ${seed} roadmap ${n} step ${step} ${mode} ${dd}`
        expect(res.s, ctx).toBeLessThanOrEqual(res.e)
        expect(after.flatMap((w) => w.relocated), ctx).toEqual([])
        expect(rowMap(after), ctx).toEqual(before)
        const all = r.deliverables.flatMap((x) => [dayOf(x.start_date), dayOf(x.end_date)]).concat(r.milestones.map((m) => dayOf(m.date)))
        expect(withinCap(Math.min(...all), Math.max(...all)), ctx).toBe(true)
      }
    }
  })

  it('REQ_FE_014 REQ_FE_016 random drops into other rows land only where they fit, and move nothing else', () => {
    const rand = rng(seed)
    const int = (k: number) => Math.floor(rand() * k)
    for (let n = 0; n < ROADMAPS; n++) {
      let r = settle(randomRoadmap(rand))
      for (let step = 0; step < 15 && r.deliverables.length; step++) {
        const d = r.deliverables[int(r.deliverables.length)]
        const [s0, e0] = [dayOf(d.start_date), dayOf(d.end_date)]
        const dupsOn = rand() < 0.5
        const layout = packRoadmap(r, dupsOn)
        const origin = d.workstreams[0].id
        const target = layout[int(layout.length)]
        const row = storedRowFor(target, int(target.usedRows.length + 1))
        const res = clampDrag('move', s0, e0, int(80) - 40, wallsFor(layout, d.id, s0, e0, [origin, target.ws.id]), capCheck(r, d.id))
        if (!slotFree(target, row, res.s, res.e, d.id)) continue // a blocked drop moves nothing (REQ_FE_015)
        const ids = [...new Set(d.workstream_ids.map((w) => (w === origin ? target.ws.id : w)))]
        const pos = (id: number) => r.workstreams.find((w) => w.id === id)!.position
        const members = ids.sort((a, b) => pos(a) - pos(b)).map((id) => ({ id, row: id === target.ws.id ? row : d.workstreams.find((m) => m.id === id)!.row }))
        const others = (l: WorkstreamLayout[]) => rowMap(l).filter((k) => !k.includes(`:deliverable:${d.id}@`))
        const before = others(packRoadmap(r, true))
        r = { ...r, deliverables: r.deliverables.map((x) => (x.id === d.id ? { ...x, start_date: isoOf(res.s), end_date: isoOf(res.e), workstream_ids: ids, workstreams: members } : x)) }
        const after = packRoadmap(r, true)
        const ctx = `seed ${seed} roadmap ${n} step ${step}`
        expect(after.flatMap((w) => w.relocated), ctx).toEqual([])
        expect(others(after), ctx).toEqual(before)
        expect(after.find((w) => w.ws.id === target.ws.id)!.items.find((i) => i.kind === 'deliverable' && i.id === d.id)!.row, ctx).toBe(row)
      }
    }
  })
})

// REQ_TEST_021 / REQ_TEST_012: the same hard rules on the company views — random teams, shared and odd-cased
// workstream names, stored rows that clash across teams.
describe(`REQ_TEST_021 randomized company layout (seed ${seed})`, () => {
  const POOL = ['Platform', 'Mobile', 'Data', 'Growth', 'Security']
  function randomCompany(rand: () => number) {
    const int = (n: number) => Math.floor(rand() * n)
    const teams = Array.from({ length: 1 + int(5) }, (_, i) => {
      if (int(6) === 0) return companyTeam(`T${i}`, `T${i}`, []) // an empty roadmap
      const names = POOL.filter(() => rand() < 0.6).map((n) => (int(3) === 0 ? ` ${n.toUpperCase()} ` : n))
      const c = companyTeam(`T${i}`, `T${i}`, names.length ? names : ['Platform'])
      const r = c.roadmap!
      for (let k = int(12); k > 0; k--) {
        const start = t + int(900)
        const members = [...r.workstreams].sort(() => rand() - 0.5).slice(0, 1 + int(Math.min(3, r.workstreams.length)))
        addDeliverable(r, { start, end: start + int(120), in: members.map((w) => [w, int(3)]) }) // rows clash across teams on purpose
      }
      for (let k = int(5); k > 0; k--) addMilestone(r, { day: t + int(1000), in: r.workstreams[int(r.workstreams.length)], row: int(2) })
      return c
    })
    return teams
  }
  const order = (rand: () => number) => POOL.filter(() => rand() < 0.5).sort(() => rand() - 0.5)

  it('REQ_FE_010 REQ_TEST_021 no two blocks overlap in any merged row, at every zoom and width, filtered or traced', () => {
    const rand = rng(seed)
    for (let n = 0; n < ROADMAPS; n++) {
      const teams = randomCompany(rand)
      const base = mergeByWorkstreamName(teams, order(rand))
      const all = teams.flatMap((c) => c.roadmap?.deliverables ?? [])
      const picked = new Set(all.filter(() => rand() < 0.5).map((d) => d.id))
      const views = [base, applyTrace(base, picked)]
      for (const v of views) {
        const days = v.roadmap.deliverables.flatMap((d) => [dayOf(d.start_date), dayOf(d.end_date)]).concat(v.roadmap.milestones.map((m) => dayOf(m.date)))
        const grid = gridFor(days.length ? Math.min(...days) : null, days.length ? Math.max(...days) : null, t)
        for (const width of [640, 1000, 1700])
          for (const z of ZOOMS)
            for (const dupsOn of [true, false]) for (const risk of [false, true]) expect(overlapsOnScreen(v.roadmap, dupsOn, { ...grid, px: pxPerDay(z, width) }, risk), `seed ${seed} company ${n} ${z}@${width} copies ${dupsOn} at risk ${risk}`).toEqual([])
      }
    }
  })

  it('REQ_FE_052 merging loses and invents nothing, and every deliverable keeps its own team', () => {
    const rand = rng(seed)
    for (let n = 0; n < ROADMAPS; n++) {
      const teams = randomCompany(rand)
      const v = mergeByWorkstreamName(teams, order(rand))
      const ctx = `seed ${seed} company ${n}`
      const real = teams.flatMap((c) => c.roadmap?.deliverables ?? []).map((d) => d.id).sort()
      expect(v.roadmap.deliverables.map((d) => d.id).sort(), ctx).toEqual(real)
      expect(v.roadmap.milestones.length, ctx).toBe(teams.reduce((k, c) => k + (c.roadmap?.milestones.length ?? 0), 0))
      for (const d of v.roadmap.deliverables) {
        const o = v.origin.get(d.id)!
        expect(d.team_id, ctx).toBe(o.teamId)
        // every merged row it sits in is one its own team has a workstream for
        for (const w of d.workstream_ids) expect(v.rows.find((r) => r.wsId === w)!.members.some((m) => m.teamId === o.teamId), ctx).toBe(true)
      }
    }
  })
})
