// A milestone's diamond, its name under it and its date to its right, inside the free stretch of its row (geometry.ts
// milestoneGeom). The diamond shows the status itself (REQ_FE_040): there is no separate icon to make room for.

import { describe, expect, it } from 'vitest'
import { dateToX, gridFor, gridWidth, localDay, midX, nextDay, pxPerDay, ZOOMS, type View } from './axis'
import { BAR_H, barName, DIAMOND, milestoneGeom, nameUnder, ROW_PITCH, tagWidth } from './geometry'

const t = localDay(new Date())
const grid = gridFor(t - 60, t + 300, t)
const at = (zoom: (typeof ZOOMS)[number], width = 1000): View => ({ ...grid, px: pxPerDay(zoom, width) })
const bar = (start: number, end: number) => ({ kind: 'deliverable' as const, start, end })

describe('REQ_FE_140 REQ_FE_141 REQ_FE_142 how a name and icons share a bar', () => {
  const measure = (text: string, px: number) => text.length * (px === 12.5 ? 7 : 6) // px a character: 7 normal, 6 small
  const layout = (name: string, width: number, tag?: string, icons = 0) => barName(name, width, tag, icons, measure)
  const roomTag = tagWidth('PRD') + 6
  const ten = 'x'.repeat(10)

  it('REQ_FE_140 one row at the normal size needs the name, the padding (22) and the border (3)', () => {
    expect(layout(ten, 95)).toEqual({ mode: 'one', icons: 0 })
    expect(layout(ten, 94).mode).not.toBe('one')
  })

  it('REQ_FE_140 a tag and icons share the row', () => {
    expect(layout(ten, 95 + roomTag, 'PRD').mode).toBe('one')
    expect(layout(ten, 94 + roomTag, 'PRD').mode).not.toBe('one')
    expect(layout(ten, 95 + 33, undefined, 2)).toEqual({ mode: 'one', icons: 2 }) // 12 + 3 + 12 and a gap of 6
  })

  it('REQ_FE_140 a name that fits on two small rows, broken between words, goes there', () => {
    expect(layout('Usage Dashboard', 25 + 54)).toEqual({ mode: 'two', icons: 0 }) // 9 letters is the longest word: 54 px
  })

  it('REQ_FE_141 a name whose word does not fit goes under the bar, whatever the bar\'s width: the room after the tag is what counts', () => {
    expect(layout('Usage Dashboard', 25 + 53).mode).toBe('under')
    expect(layout('Usage Dashboard', 25 + 53 + roomTag, 'PRD').mode).toBe('under') // over 100 px wide, but the tag takes its share
    expect(layout('Usage Dashboard', 25 + 53).icons).toBe(0)
  })

  it('REQ_FE_141 a non-breaking space is no break between words', () => {
    expect(layout('Usage\u00a0Dashboard', 25 + 55).mode).toBe('under')
    expect(layout('Usage Dashboard', 25 + 55).mode).toBe('two')
  })

  it('REQ_FE_141 three rows\' worth of words does not fit on two', () => {
    expect(layout('aaaa bbbb cccc', 25 + 30).mode).toBe('under') // 30 px holds one word a row
    expect(layout('aaaa bbbb cccc', 25 + 54).mode).toBe('two') // "aaaa bbbb" / "cccc"
  })

  it('REQ_FE_141 with more than 60 px of room a long name stays inside, cut', () => {
    expect(layout('x'.repeat(40), 25 + 60).mode).toBe('under')
    expect(layout('x'.repeat(40), 25 + 61).mode).toBe('two')
  })

  it('REQ_FE_142 an icon that would stop the name from fitting is left out, last ones first; the rest stay whole', () => {
    const name = 'Mobile Sign-in' // two rows need 42 px
    expect(layout(name, 25 + 42 + 33, undefined, 2)).toEqual({ mode: 'two', icons: 2 })
    expect(layout(name, 25 + 42 + 18, undefined, 2)).toEqual({ mode: 'two', icons: 1 })
    expect(layout(name, 25 + 42, undefined, 2)).toEqual({ mode: 'two', icons: 0 })
  })

  it('REQ_FE_142 a long name cut inside keeps only the icons that leave it 60 px', () => {
    const long = 'x'.repeat(80)
    expect(layout(long, 25 + 200, undefined, 2)).toEqual({ mode: 'two', icons: 2 })
    expect(layout(long, 25 + 70, undefined, 2)).toEqual({ mode: 'two', icons: 0 })
  })

  it('REQ_FE_142 REQ_FE_010 the name and whole icons never need more than the bar has', () => {
    for (let width = 1; width < 300; width++) {
      for (const tag of [undefined, 'PRD']) {
        for (const name of ['Go', 'Usage Dashboard', 'Disaster Recovery Drills', 'x'.repeat(60)]) {
          const { mode, icons } = barName(name, width, tag, 3, measure)
          if (icons === 0) continue
          expect(mode).not.toBe('under')
          expect(icons * 15 + 3, `${name} on ${width}`).toBeLessThanOrEqual(width)
        }
      }
    }
  })
})

describe('REQ_FE_141 a name under its bar', () => {
  it('REQ_FE_141 the gap holds the name, 12 px, above a badge from the row below reaching up 8 px', () => {
    expect(ROW_PITCH - BAR_H).toBeGreaterThanOrEqual(12 + 8)
  })

  it('REQ_FE_141 it is centred under the bar, also when longer than the bar', () => {
    // bar from 100 to 170 (centre 135), border 1.5
    expect(nameUnder(100, 70, 0, 1000, 40)).toEqual({ left: 13.5, max: 40 })
    expect(nameUnder(100, 70, 0, 1000, 200)).toEqual({ left: -66.5, max: 200 })
  })

  it('REQ_FE_141 where one side is too short it slides toward the other, whole', () => {
    expect(nameUnder(100, 70, 90, 1000, 200)).toEqual({ left: -11.5, max: 200 })
    expect(nameUnder(100, 70, 0, 180, 200)!.max).toBe(180)
    expect(nameUnder(100, 70, 0, 190, 120)).toEqual({ left: -31.5, max: 120 })
  })

  it('REQ_FE_141 only what does not fit in the whole stretch is cut', () => {
    expect(nameUnder(100, 70, 90, 190, 200)).toEqual({ left: -11.5, max: 100 })
  })

  it('REQ_FE_141 with too little room there is no name under the bar', () => {
    expect(nameUnder(100, 70, 110, 138, 200)!.max).toBe(28)
    expect(nameUnder(100, 70, 110, 137, 200)).toBeNull()
  })

  it('REQ_FE_141 REQ_FE_010 it never leaves its stretch and always spans its bar\'s centre', () => {
    let seed = 7
    const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n
    for (let i = 0; i < 500; i++) {
      const [barLeft, barWidth] = [300 + rnd(100), 10 + rnd(120)]
      const c = barLeft + barWidth / 2
      const [lo, hi] = [c - rnd(200), c + rnd(200)]
      const u = nameUnder(barLeft, barWidth, lo, hi, 20 + rnd(300))
      if (!u) continue
      const a = barLeft + u.left + (barWidth < 30 ? Math.min(1.5, barWidth / 2) : 1.5)
      expect(a).toBeGreaterThanOrEqual(lo - 1e-6)
      expect(a + u.max).toBeLessThanOrEqual(hi + 1e-6)
      expect(a).toBeLessThanOrEqual(c + 1e-6)
      expect(a + u.max).toBeGreaterThanOrEqual(c - 1e-6)
    }
  })
})

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
