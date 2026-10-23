import { describe, expect, it } from 'vitest'
import {
  addDate, dateToX, dayOf, fmtWd, gridFor, isoOf, isoWeek, localDay, monthCells, monthEnd, monthStart, pxPerDay, todayX,
  VIEW, weekCells, weekLabelMode, withinCap, xToDate, ZOOMS, type View,
} from './axis'
import { step } from '../testSteps'

const today = localDay(new Date()) // tests run against the real clock, relative to it (REQ_TEST_017)
const WIDTH = 1000

describe('REQ_FE_065 dateToX / xToDate', () => {
  for (const z of ZOOMS) {
    it(`REQ_FE_065 REQ_FE_068 round-trips every day of a 3-year grid at ${z} zoom, and xToDate snaps to the nearest day`, async () => {
      await step('round-trips every day of a 3-year grid', () => {
        const g = gridFor(today, addDate(today, 3), today)
        const view: View = { ...g, px: pxPerDay(z, WIDTH) }
        for (let d = g.start; d < g.start + g.days; d++) {
          expect(xToDate(dateToX(d, view), view)).toBe(d)
          expect(dateToX(isoOf(d), view)).toBe(dateToX(d, view))
        }
      })

      await step('xToDate snaps to the nearest day', () => {
        const view: View = { start: today, days: 60, px: pxPerDay(z, WIDTH) }
        const x = dateToX(today + 10, view)
        const oneDay = dateToX(today + 11, view) - x
        expect(xToDate(x + oneDay * 0.49, view)).toBe(today + 10)
        expect(xToDate(x + oneDay * 0.51, view)).toBe(today + 11)
        expect(xToDate(x - oneDay * 0.49, view)).toBe(today + 10)
      })
    })
  }

  it('REQ_FE_066 zoom windows are Year, Half year, Quarter, Month with Year widest and no fit-all option', () => {
    expect(ZOOMS).toEqual(['year', 'half', 'quarter', 'month'])
    expect(VIEW).toEqual({ year: 365, half: 183, quarter: 92, month: 31 })
    // a zoom window of N days fills the scroll area's width
    for (const z of ZOOMS) expect(pxPerDay(z, WIDTH) * VIEW[z]).toBeLessThanOrEqual(WIDTH)
  })
})

describe('REQ_FE_064 header cells', () => {
  const g = gridFor(today, addDate(today, 1), today)

  it('REQ_FE_064 weeks run Monday to Sunday and cover the grid without gaps; every week cell carries its ISO week number; week labels thin out as the zoom widens; month cells are whole calendar months', async () => {
    await step('weeks run Monday to Sunday, cover the grid without gaps, only the first and last partial', () => {
      const weeks = weekCells(g)
      let d = g.start
      weeks.forEach((w, i) => {
        expect(w.start).toBe(d)
        if (i > 0 && i < weeks.length - 1) expect(w.days).toBe(7)
        d += w.days
      })
      expect(d).toBe(g.start + g.days)
      for (const w of weeks.slice(1)) expect(w.tip.startsWith('Mon ')).toBe(true)
      for (const w of weeks) expect(w.tip).toMatch(/^Mon \d+ \w{3} – Sun \d+ \w{3}\|ISO week \d+$/)
    })

    await step('every week cell carries its ISO week number, matching an independent calculation', () => {
      // reference: the ISO week of a date is the week of its Thursday, counted from the year's first Thursday
      const ref = (day: number) => {
        const t = new Date(isoOf(day) + 'T00:00:00Z')
        t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7))
        const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
        return 1 + Math.floor((t.getTime() - y.getTime()) / 864e5 / 7)
      }
      for (let d = today - 800; d < today + 800; d++) expect(isoWeek(d), isoOf(d)).toBe(ref(d))
      for (const w of weekCells(g)) expect(w.tip.endsWith(`ISO week ${isoWeek(w.start)}`)).toBe(true)
    })

    await step('week labels thin out as the zoom widens: range, then start date, then none', () => {
      const rank = { full: 2, start: 1, none: 0 }
      const modes = ZOOMS.map((z) => weekLabelMode({ ...g, px: pxPerDay(z, WIDTH) }))
      for (let i = 1; i < modes.length; i++) expect(rank[modes[i]]).toBeGreaterThanOrEqual(rank[modes[i - 1]])
      expect(modes[0]).toBe('none') // year at a typical width: gridlines only, the hover tip has the rest
      expect(modes[modes.length - 1]).toBe('full')
      expect(weekLabelMode({ ...g, px: 40 / 7 })).toBe('start')
    })

    await step('month cells are whole calendar months covering the grid', () => {
      const months = monthCells(g)
      let d = g.start
      for (const m of months) {
        expect(m.start).toBe(d)
        expect(m.start).toBe(monthStart(m.start))
        expect(m.start + m.days - 1).toBe(monthEnd(m.start))
        d += m.days
      }
      expect(d).toBe(g.start + g.days)
      expect(months[0].year).not.toBeNull()
    })
  })
})

describe('REQ_FE_060/061/063 the grid', () => {
  it('REQ_FE_060 runs from the earliest to the latest date, rounded out to whole months', () => {
    const g = gridFor(today + 20, today + 200, today)
    expect(g.start).toBe(monthStart(today + 20))
    expect(g.start + g.days - 1).toBe(monthEnd(today + 200))
  })

  it('REQ_FE_061 an empty roadmap shows 3 months before today to 9 months after', () => {
    const g = gridFor(null, null, today)
    expect(g.start).toBe(monthStart(addDate(today, 0, -3)))
    expect(g.start + g.days - 1).toBe(monthEnd(addDate(today, 0, 9)))
  })

  it('REQ_FE_063 a date past the end grows the grid to the end of that month', () => {
    const g = gridFor(today, today + 30, today)
    const past = g.start + g.days + 40
    const grown = gridFor(today, past, today)
    expect(grown.start + grown.days - 1).toBe(monthEnd(past))
  })

  it('REQ_FE_070 today marker sits inside today, and is absent when today is outside the grid', () => {
    const view: View = { ...gridFor(today, today + 10, today), px: 10 }
    const x = todayX(view, today)!
    expect(x).toBeGreaterThan(dateToX(today, view))
    expect(x).toBeLessThan(dateToX(today + 1, view))
    expect(todayX({ ...view, start: today + 400 }, today)).toBeNull()
  })
})

describe('REQ_FE_062 the 3-year cap', () => {
  it('REQ_FE_062 allows exactly 3 calendar years, not a day more (AddDate semantics, leap day included)', () => {
    for (let s = today; s < today + 3 * 366; s += 17) {
      expect(withinCap(s, addDate(s, 3))).toBe(true)
      expect(withinCap(s, addDate(s, 3) + 1)).toBe(false)
    }
    // from a Feb 29, three years on is Mar 1 (the target year has no Feb 29), as docs/API.md spells out
    let leap = today
    while (!isoOf(leap).endsWith('-02-29')) leap++
    expect(isoOf(addDate(leap, 3)).slice(5)).toBe('03-01')
    expect(dayOf(isoOf(leap))).toBe(leap)
  })
})

describe('REQ_DAT_016 exact days, weeks Monday to Sunday', () => {
  it('REQ_DAT_016 every calendar day maps to itself and back (no rounding to a week or month), one day is exactly one pixel step, and every week runs Monday to Sunday', () => {
    const start = dayOf('2024-01-01')
    const view = (px: number): View => ({ start, days: 1500, px })
    for (let d = start; d < start + 1500; d++) {
      expect(dayOf(isoOf(d)), isoOf(d)).toBe(d)
      // the pointer position of a day's left edge turns back into that very day, at any zoom
      for (const px of [0.5, 2, 9]) expect(xToDate(dateToX(d, view(px)), view(px))).toBe(d)
    }
    expect(dateToX(start + 1, view(4)) - dateToX(start, view(4))).toBeCloseTo(4, 9) // a day is a day wide, never a week or month
    // independent weekday check (Date's own calendar): each week cell after the first starts on a Monday, 7 days long, and ends on a Sunday
    const dow = (day: number) => new Date(isoOf(day) + 'T00:00:00Z').getUTCDay() // 0 = Sunday
    const weeks = weekCells(gridFor(start, start + 800, start))
    expect(weeks.length).toBeGreaterThan(100)
    for (const w of weeks.slice(1, -1)) {
      expect(dow(w.start), isoOf(w.start)).toBe(1)
      expect(w.days).toBe(7)
      expect(dow(w.start + 6), isoOf(w.start + 6)).toBe(0)
    }
  })
})

describe('REQ_FE_040 milestone date carries the weekday', () => {
  it('REQ_FE_040 fmtWd gives the three-letter weekday in parentheses', () => {
    expect(fmtWd(dayOf('2026-10-16'))).toBe('(Fri)')
  })
})
