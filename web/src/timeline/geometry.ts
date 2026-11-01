// Where packed items are drawn. Pure; every horizontal position goes through dateToX (REQ_FE_065).
// Each item stays inside the days it occupies, so two items that packing put in different days of the
// same row can't overlap on screen at any zoom level (REQ_FE_010).

import { dateToX, gridWidth, midX, nextDay, type Day, type View } from './axis'

export const ROW_PITCH = 52 // one row, top to top: the bar, a name under it (12), and a badge from the row below reaching up 8 (REQ_FE_141)
export const BAR_H = 32
export const BAND_PAD = 10 // above the first row and below the last
export const MS_TOP = 5 // a milestone's offset inside its row: its diamond on the bars' centre line (r+5..r+27), its name under it (r+29..r+42)
export const DIAMOND = 22 // the diamond's full width and height
export const RING = 6 // how far an at-risk diamond's outline reaches outside that box, on each side (5px from the tips to the line's centre + 1px, half the line; rounded corners add nothing)
export const RING_MIN = 4 // below this much room the outline would touch the diamond, so it is not drawn (the diamond with its "!" still shows)
export const RING_LABEL = 8 // an at-risk milestone's name starts this far under the box (it is 2 otherwise), clear of the outline
const LABEL_MIN = 28 // below this there is no room for a readable name; the name stays on hover
const LABEL_MAX = 220
const DATE_GAP = 6 // between the diamond and its date
const DATE_MIN = 40 // the room the short date needs to the right of the diamond (REQ_FE_040)

export function bandHeight(rows: number): number {
  return rows * ROW_PITCH + 2 * BAND_PAD
}
export function rowTop(bandTop: number, displayRow: number): number {
  return bandTop + BAND_PAD + displayRow * ROW_PITCH
}

// A deliverable covers its days exactly, less one pixel so bars that touch stay distinguishable.
export function barBox(start: Day, end: Day, view: View): { left: number; width: number } {
  const left = dateToX(start, view)
  return { left, width: Math.max(1, dateToX(nextDay(end), view) - left - 1) }
}

export interface MilestoneGeom {
  left: number // the diamond's left edge
  size: number // the diamond's width (its height is always DIAMOND)
  ring: number // room (px, 0..RING) kept clear on each side of an at-risk diamond for its outline; 0 for other statuses
  label: { max: number } | null // room for the name, centred under the diamond
  date: boolean // whether the short date fits to the right of the diamond
}

// A milestone occupies its single day for packing, but its diamond, name and date are wider than a day at most zoom
// levels. They get the free stretch of the row around that day — up to the neighbouring bars, and halfway to a
// neighbouring milestone — and never more (REQ_FE_010): the diamond (which shows the status itself, REQ_FE_040)
// shifts to stay inside it (and only if the stretch is narrower than a diamond, narrows, keeping its height so it
// still reads as a marker). The name is centred under the diamond, so it may use the same room on both sides of the
// diamond's centre, cut with an ellipsis; the date to the diamond's right is left out under DATE_MIN. An at-risk
// diamond's outline (REQ_FE_040) reaches RING px outside the box, so it keeps up to RING px of the free stretch clear on
// each side (less where the stretch is narrower, down to none) and the date starts after it.
export function milestoneGeom(day: Day, neighbours: { kind: 'deliverable' | 'milestone'; start: Day; end: Day }[], view: View, atRisk = false): MilestoneGeom {
  const cx = midX(day, view)
  let lo = 0
  let hi = gridWidth(view)
  for (const n of neighbours) {
    if (n.kind === 'deliverable') {
      if (n.end < day) lo = Math.max(lo, dateToX(nextDay(n.end), view))
      else if (n.start > day) hi = Math.min(hi, dateToX(n.start, view))
    } else if (n.start !== day) {
      const mid = (cx + midX(n.start, view)) / 2
      if (n.start < day) lo = Math.max(lo, mid)
      else hi = Math.min(hi, mid)
    }
  }
  const size = Math.min(DIAMOND, hi - lo)
  const ring = atRisk ? Math.min(RING, Math.max(0, (hi - lo - size) / 2)) : 0 // the outline's room on each side, if the stretch has it
  const left = Math.min(Math.max(cx - size / 2, lo + ring), hi - size - ring)
  const dc = left + size / 2
  const room = 2 * Math.min(dc - lo, hi - dc) - 4 // 2px clear of each side
  const label = room >= LABEL_MIN ? { max: Math.min(LABEL_MAX, room) } : null
  return { left, size, ring, label, date: hi - (left + size) - ring - DATE_GAP >= DATE_MIN }
}

// The team tag at a bar's left edge (REQ_FE_054): its width is an upper estimate of the rendered text (10px
// bold capitals) plus its own padding, so it can be decided without measuring whether it fits in a bar.
export const TAG_CHAR = 7.5
export const TAG_PAD = 8
export function tagWidth(tag: string): number {
  return Math.ceil(tag.length * TAG_CHAR) + TAG_PAD
}
// A bar's own horizontal chrome: its border (which shrinks on bars under 30px) and its padding (10 + 12, none
// once `snug`). Mirrors timeline.css and Timeline.tsx.
export const BAR_PAD = 22
export function barBorder(width: number): number {
  return width < 30 ? Math.min(1.5, width / 2) : 1.5
}
// Whether a bar of this width has room for its team tag at all, and the width below which its padding goes.
export function tagFits(tag: string, width: number): boolean {
  return width >= tagWidth(tag) + 2 * barBorder(width)
}
export function snugBelow(tag: string | undefined, width: number): number {
  return tag !== undefined && tagFits(tag, width) ? Math.max(30, tagWidth(tag) + 3 + BAR_PAD) : 30
}

// How a deliverable's name and icons share its bar (REQ_FE_140/141/142). `measure` gives a text's width at a size. What
// shares the row with the name mirrors timeline.css: the tag if it fits, the icons (12px, 3px apart) and the 6px gaps. Tried
// in turn: one row at the normal size with all icons; two rows of small letters, broken only between words, with as many
// icons as allow it; under the bar when it leaves the name at most UNDER_ROOM; else two rows, cut. Icons are whole or gone.
export const NAME_PX = 12.5
export const SMALL_PX = 10.5
const UNDER_ROOM = 60
function fitsTwoRows(name: string, room: number, width: (s: string) => number): boolean {
  let rows = 1
  let row = ''
  for (const word of name.trim().split(/ +/)) {
    if (width(word) > room) return false
    const next = row ? `${row} ${word}` : word
    if (width(next) <= room) {
      row = next
    } else {
      rows++
      row = word
    }
  }
  return rows <= 2
}
export function barName(name: string, width: number, tag: string | undefined, icons: number, measure: (s: string, px: number) => number): { mode: 'one' | 'two' | 'under'; icons: number } {
  const pad = width < snugBelow(tag, width) ? 0 : BAR_PAD
  const tagRoom = tag !== undefined && tagFits(tag, width) ? tagWidth(tag) + 6 : 0
  const room = width - 2 * barBorder(width) - pad - tagRoom
  const iconRoom = (n: number) => (n > 0 ? n * 15 + 3 : 0) // n * 12, (n - 1) * 3, and the gap of 6
  if (measure(name, NAME_PX) <= room - iconRoom(icons)) return { mode: 'one', icons }
  for (let k = icons; k >= 0; k--) {
    if (fitsTwoRows(name, room - iconRoom(k), (s) => measure(s, SMALL_PX))) return { mode: 'two', icons: k }
  }
  if (room <= UNDER_ROOM) return { mode: 'under', icons: 0 }
  let k = icons
  while (k > 0 && room - iconRoom(k) < UNDER_ROOM) k--
  return { mode: 'two', icons: k }
}

// A name that goes under its bar sits in the gap between rows, centred under the bar (REQ_FE_141), in the free stretch
// lo..hi of that gap around the bar's centre. Where one side of the stretch is too short it slides toward the other, and
// only what doesn't fit in the whole stretch is cut. `left` is from the bar's padding box. No room for a readable name: null.
export function nameUnder(barLeft: number, barWidth: number, lo: number, hi: number, nameWidth: number): { left: number; max: number } | null {
  const max = Math.min(nameWidth, hi - lo)
  if (max < LABEL_MIN) return null
  const x = Math.min(Math.max(barLeft + barWidth / 2 - max / 2, lo), hi - max)
  return { left: x - barLeft - barBorder(barWidth), max }
}
