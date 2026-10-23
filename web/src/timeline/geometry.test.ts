// A milestone's diamond, its name under it and its date to its right, inside the free stretch of its row (geometry.ts
// milestoneGeom). The diamond shows the status itself (REQ_FE_040): there is no separate icon to make room for.

import { describe, expect, it } from 'vitest'
import { dateToX, gridFor, gridWidth, localDay, midX, nextDay, pxPerDay, ZOOMS, type View } from './axis'
import { DIAMOND, milestoneGeom } from './geometry'

const t = localDay(new Date())
const grid = gridFor(t - 60, t + 300, t)
const at = (zoom: (typeof ZOOMS)[number], width = 1000): View => ({ ...grid, px: pxPerDay(zoom, width) })
const bar = (start: number, end: number) => ({ kind: 'deliverable' as const, start, end })

describe('REQ_FE_040 a milestone\'s name is centred under its diamond and its date sits to the right, both inside the free stretch', () => {
  it('REQ_FE_040 REQ_FE_042 in a free row a 22px diamond is centred on its day, with the name centred under it and the date beside it, at every zoom level and width', () => {
    expect(DIAMOND).toBe(22)
    for (const zoom of ZOOMS)
      for (const width of [640, 1000, 1700]) {
        const v = at(zoom, width)
        const g = milestoneGeom(t + 20, [], v)
        const dc = g.left + g.size / 2
        expect(g.size, `${zoom}@${width}`).toBe(DIAMOND)
        expect(dc).toBeCloseTo(midX(t + 20, v))
        expect(g.label!.max, `${zoom}@${width}`).toBeCloseTo(Math.min(220, 2 * Math.min(dc, gridWidth(v) - dc) - 4)) // symmetric around the diamond
        expect(g.date).toBe(true)
      }
  })

  it('REQ_FE_040 REQ_FE_010 between bars the diamond, the centred name and the date stay inside the free stretch', () => {
    for (const zoom of ZOOMS)
      for (const [b1, day, b2] of [[t + 9, t + 20, t + 21], [t + 9, t + 10, t + 40], [t + 9, t + 15, t + 21]]) {
        const v = at(zoom)
        const lo = dateToX(nextDay(b1), v)
        const hi = dateToX(b2, v)
        const g = milestoneGeom(day, [bar(t, b1), bar(b2, t + 60)], v)
        const dc = g.left + g.size / 2
        expect(g.left, zoom).toBeGreaterThanOrEqual(lo - 1e-9)
        expect(g.left + g.size, zoom).toBeLessThanOrEqual(hi + 1e-9)
        if (g.label) {
          expect(dc - g.label.max / 2, zoom).toBeGreaterThanOrEqual(lo - 1e-9)
          expect(dc + g.label.max / 2, zoom).toBeLessThanOrEqual(hi + 1e-9)
          expect(g.label.max).toBeGreaterThanOrEqual(28)
        } else expect(2 * Math.min(dc - lo, hi - dc) - 4, zoom).toBeLessThan(28) // left out only when there is no room
        expect(g.date, zoom).toBe(hi - (g.left + g.size) - 6 >= 40) // the date needs 72px clear to the right
      }
  })

  it('REQ_FE_040 the name\'s room is the nearer side doubled, and a neighbour close on the right leaves out the date but not the name', () => {
    const v = at('month')
    const g = milestoneGeom(t + 20, [bar(t, t + 9), bar(t + 22, t + 40)], v) // one free day after, ten before
    const dc = g.left + g.size / 2
    expect(g.label!.max).toBeCloseTo(Math.min(220, 2 * (dateToX(t + 22, v) - dc) - 4))
    expect(g.date).toBe(dateToX(t + 22, v) - (g.left + g.size) - 6 >= 72)
    const far = milestoneGeom(t + 20, [bar(t, t + 9), bar(t + 30, t + 40)], v)
    expect(far.date).toBe(true)
  })

  it('REQ_FE_010 a squeezed milestone keeps a whole diamond where it fits and narrows only to its stretch, with no name or date', () => {
    const v = at('year') // ~2.7px a day
    const squeezed = (free: number) => milestoneGeom(t + 20, [bar(t, t + 19 - Math.floor(free / 2)), bar(t + 21 + Math.ceil(free / 2) - 1, t + 60)], v)
    const fits = Math.ceil(DIAMOND / v.px) + 1 // enough free days around it for a whole diamond
    expect(squeezed(fits).size).toBe(DIAMOND)
    const tight = squeezed(1) // its own day only
    expect(tight.size).toBeCloseTo(v.px) // the diamond keeps its own day
    expect(tight.label).toBeNull()
    expect(tight.date).toBe(false)
  })
})

describe('REQ_FE_040 REQ_FE_010 an at-risk diamond keeps room for its outline inside the free stretch', () => {
  it('REQ_FE_040 REQ_FE_010 the outline gets up to 6px clear on each side, the date starts after it, and other statuses ask for nothing', () => {
    for (const zoom of ZOOMS) {
      const v = at(zoom, 1000)
      const plain = milestoneGeom(t + 20, [bar(t + 9, t + 14), bar(t + 30, t + 40)], v)
      const risk = milestoneGeom(t + 20, [bar(t + 9, t + 14), bar(t + 30, t + 40)], v, true)
      const lo = dateToX(nextDay(t + 14), v)
      const hi = dateToX(t + 30, v)
      expect(plain.ring, zoom).toBe(0)
      expect(risk.size, zoom).toBe(plain.size)
      expect(risk.ring, zoom).toBeCloseTo(Math.min(6, Math.max(0, (hi - lo - risk.size) / 2)))
      expect(risk.left - lo, zoom).toBeGreaterThanOrEqual(risk.ring - 1e-6)
      expect(hi - (risk.left + risk.size), zoom).toBeGreaterThanOrEqual(risk.ring - 1e-6)
      expect(risk.date, zoom).toBe(hi - (risk.left + risk.size) - risk.ring - 6 >= 72)
    }
  })

  it('REQ_FE_040 REQ_FE_042 wedged between bars a day away, the diamond is still drawn full size or narrowed, with no room (ring 0) for the outline', () => {
    for (const zoom of ZOOMS) {
      const v = at(zoom, 1000)
      const g = milestoneGeom(t + 20, [bar(t + 9, t + 19), bar(t + 21, t + 40)], v, true)
      expect(g.size, zoom).toBeGreaterThan(0)
      expect(g.ring, zoom).toBeLessThanOrEqual(Math.max(0, (v.px - g.size) / 2) + 1e-6)
    }
  })

  it('REQ_FE_040 REQ_FE_010 for every width of free stretch the outline gets half of what is left after the diamond, at most 6px, and stays inside the stretch', () => {
    const day = t + 100
    for (const zoom of ZOOMS)
      for (let gap = 1; gap <= 40; gap++) {
        // a bar ends `gap` days before the milestone's day and another starts `gap` days after it
        const v = at(zoom, 1000)
        const g = milestoneGeom(day, [bar(day - 30, day - gap), bar(day + gap, day + 60)], v, true)
        const lo = dateToX(nextDay(day - gap), v)
        const hi = dateToX(day + gap, v)
        const where = `${zoom} stretch ${(hi - lo).toFixed(1)}px`
        expect(g.ring, where).toBeCloseTo(Math.min(6, Math.max(0, (hi - lo - g.size) / 2)))
        expect(g.left - lo, where).toBeGreaterThanOrEqual(g.ring - 1e-6)
        expect(hi - (g.left + g.size), where).toBeGreaterThanOrEqual(g.ring - 1e-6)
        if (hi - lo < DIAMOND) expect(g.ring, where).toBe(0) // narrower than a diamond: no outline, the diamond narrows
      }
  })
})
