// The timeline axis: the one place where dates become pixels and back (REQ_FE_065), plus the calendar
// arithmetic everything else builds on. Nothing outside this file converts between dates and pixels
// or does millisecond/day arithmetic — axis.test.ts enforces that with a grep over web/src.
//
// Dates are handled as `Day`s: whole calendar days counted from 1970-01-01. Dates have day precision
// (spec §6 "Timeline axis"), so a plain integer is exact and never drifts across time zones or DST.

import type { ISODate, RoadmapFull } from '../api/types'
import type { Zoom } from '../lib/prefs'

export type { Zoom }
export type Day = number

const MS_PER_DAY = 864e5
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ---------- calendar days ----------

function fromParts(y: number, m: number, d: number): Day {
  return Math.round(Date.UTC(y, m, d) / MS_PER_DAY) // Date.UTC normalizes overflow (Feb 29 + 3y -> Mar 1), like Go's AddDate
}
function parts(day: Day): [number, number, number] {
  const t = new Date(day * MS_PER_DAY)
  return [t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()]
}

export function dayOf(iso: ISODate): Day {
  const [y, m, d] = iso.split('-').map(Number)
  return fromParts(y, m - 1, d)
}
export function isoOf(day: Day): ISODate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}
// The browser's own calendar date (REQ_FE_070: today comes from the client clock, never stored).
export function localDay(now: Date): Day {
  return fromParts(now.getFullYear(), now.getMonth(), now.getDate())
}
// Calendar arithmetic with Go's time.AddDate semantics, which the server's 3-year cap uses (docs/API.md).
export function addDate(day: Day, years: number, months = 0): Day {
  const [y, m, d] = parts(day)
  return fromParts(y + years, m + months, d)
}
// The day after / before, for the inclusive-end rules (a deliverable ending on day e is followed by e + 1).
export const nextDay = (day: Day): Day => day + 1
export const prevDay = (day: Day): Day => day - 1
export function monthStart(day: Day): Day {
  const [y, m] = parts(day)
  return fromParts(y, m, 1)
}
export function monthEnd(day: Day): Day {
  const [y, m] = parts(day)
  return fromParts(y, m + 1, 0)
}
function weekday(day: Day): number {
  return (((day + 3) % 7) + 7) % 7 // 1970-01-01 was a Thursday; Monday = 0
}
export function isoWeek(day: Day): number {
  const thursday = day - weekday(day) + 3
  const jan4 = fromParts(parts(thursday)[0], 0, 4)
  return 1 + Math.round((thursday - (jan4 - weekday(jan4) + 3)) / 7)
}

// "5 Jan 2026"; without the year: "5 Jan".
export function fmtDay(day: Day, withYear = true): string {
  const [y, m, d] = parts(day)
  return `${d} ${MON[m]}${withYear ? ` ${y}` : ''}`
}
// "(Mon)": the weekday shown under a milestone's short date.
export function fmtWd(day: Day): string {
  return `(${DOW[weekday(day)]})`
}
function fmtDow(day: Day): string {
  const [, m, d] = parts(day)
  return `${DOW[weekday(day)]} ${d} ${MON[m]}`
}
function fmtMD(day: Day): string {
  const [, m, d] = parts(day)
  return `${m + 1}/${d}`
}

// ---------- the 3-year cap (REQ_FE_062, REQ_DAT_015) ----------

export const CAP_MESSAGE = 'Maximum of 3 years of planning exceeded'
export function withinCap(min: Day, max: Day): boolean {
  return max <= addDate(min, 3)
}

// The earliest and latest day over a roadmap's deliverables and milestones; null when it holds none.
export function roadmapSpan(r: Pick<RoadmapFull, 'deliverables' | 'milestones'>): { min: Day; max: Day } | null {
  const days = [...r.deliverables.flatMap((d) => [dayOf(d.start_date), dayOf(d.end_date)]), ...r.milestones.map((m) => dayOf(m.date))]
  return days.length ? { min: Math.min(...days), max: Math.max(...days) } : null
}

// Would a new roadmap item on days s..e (a milestone: s = e) pass the cap? Mirrors the server (REQ_DAT_015): the span
// may not pass 3 years, unless the item stays inside the range the roadmap already has. Every existing item counts.
export function exceedsCap(r: Pick<RoadmapFull, 'deliverables' | 'milestones'>, s: Day, e: Day): boolean {
  const cur = roadmapSpan(r)
  if (!cur) return !withinCap(s, e)
  const inside = s >= cur.min && e <= cur.max
  return !(withinCap(Math.min(cur.min, s), Math.max(cur.max, e)) || inside)
}

// ---------- zoom ----------

// Fixed-length windows, in days; no "fit everything" (REQ_FE_066). Same values as the wireframes.
export const VIEW: Record<Zoom, number> = { year: 365, half: 183, quarter: 92, month: 31 }
export const ZOOMS: Zoom[] = ['year', 'half', 'quarter', 'month']

// Pixels per day for a zoom level in a scroll area of the given width.
export function pxPerDay(zoom: Zoom, viewportWidth: number): number {
  return Math.max(0.5, Math.floor((viewportWidth / VIEW[zoom]) * 100) / 100)
}

// ---------- the grid and the one date<->pixel pair ----------

// What is drawn: `days` whole days starting at `start` (always whole months), at `px` pixels per day.
export interface Grid {
  start: Day
  days: number
}
export interface View extends Grid {
  px: number
}

// Left edge of a day (or of an ISO date). A deliverable ending on day e ends at dateToX(e + 1).
export function dateToX(date: Day | ISODate, view: View): number {
  const day = typeof date === 'string' ? dayOf(date) : date
  return (day - view.start) * view.px
}
// The day whose left edge is nearest to x — the snap-to-nearest-day of REQ_FE_068.
export function xToDate(x: number, view: View): Day {
  return view.start + Math.round(x / view.px)
}
export function gridWidth(view: View): number {
  return dateToX(view.start + view.days, view)
}
// The middle of a day: where a milestone's diamond and the today marker sit.
export function midX(day: Day, view: View): number {
  return dateToX(day, view) + view.px / 2
}
// The today marker's x, or null when today is outside the grid.
export function todayX(view: View, today: Day): number | null {
  if (today < view.start || today >= view.start + view.days) return null
  return midX(today, view)
}

// The grid shows whole months from the earliest to the latest date (REQ_FE_060/063); an empty roadmap
// shows 3 months before today to 9 months after (REQ_FE_061).
export function gridFor(min: Day | null, max: Day | null, today: Day): Grid {
  const lo = min ?? addDate(today, 0, -3)
  const hi = max ?? addDate(today, 0, 9)
  const start = monthStart(lo)
  return { start, days: monthEnd(hi) - start + 1 }
}
export function unionGrid(a: Grid, b: Grid): Grid {
  const start = Math.min(a.start, b.start)
  return { start, days: Math.max(a.start + a.days, b.start + b.days) - start }
}

// ---------- header cells ----------

interface MonthCell {
  start: Day
  days: number
  label: string
  year: number | null // shown on the first month and on every January, so multi-year roadmaps stay readable
  quarter: number | null // 1-4 on quarter-start months
}
export function monthCells(grid: Grid): MonthCell[] {
  const out: MonthCell[] = []
  const end = grid.start + grid.days
  for (let d = grid.start; d < end; ) {
    const next = Math.min(monthEnd(d) + 1, end)
    const [y, m] = parts(d)
    out.push({ start: d, days: next - d, label: MON[m], year: d === grid.start || m === 0 ? y : null, quarter: m % 3 === 0 ? m / 3 + 1 : null })
    d = next
  }
  return out
}

export interface WeekCell {
  start: Day
  days: number // 7, except the partial first and last week of the grid
  full: string // "9/7–9/13"
  short: string // "9/7"
  tip: string // "<Mon–Sun range>|ISO week <n>" (REQ_FE_064)
}
// Weeks run Monday–Sunday (spec §6).
export function weekCells(grid: Grid): WeekCell[] {
  const out: WeekCell[] = []
  const end = grid.start + grid.days
  for (let d = grid.start; d < end; ) {
    const monday = d - weekday(d)
    const len = Math.min(monday + 7, end) - d
    out.push({
      start: d,
      days: len,
      full: `${fmtMD(d)}–${fmtMD(d + len - 1)}`,
      short: fmtMD(d),
      tip: `${fmtDow(monday)} – ${fmtDow(monday + 6)}|ISO week ${isoWeek(monday)}`,
    })
    d += len
  }
  return out
}

// Week labels thin out as the zoom widens: the range, then the start date alone, then nothing (the
// hover tip still has both). Same thresholds as the wireframes.
type WeekLabels = 'full' | 'start' | 'none'
export function weekLabelMode(view: View): WeekLabels {
  const wk = view.px * 7
  return wk >= 62 ? 'full' : wk >= 36 ? 'start' : 'none'
}
