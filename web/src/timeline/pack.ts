// Sticky row packing (REQ_FE_010/011/013/017). Pure: no DOM, no pixels.
//
// Rows are stored by the server, per workstream membership and per milestone (REQ_DAT_026). Packing
// keeps every item in its stored row whenever it still fits there and only moves an item whose stored
// row genuinely conflicts (data changed elsewhere) — to the lowest free row, the same rule the server
// uses to pick a row. Overlap is by whole days, inclusive, a milestone occupying its single day —
// exactly the server's rule, so the two never disagree about what fits, and packing never depends on
// the zoom level.
//
// Packing always runs over the full workstream, copies included (that is the world the server's rows
// describe). With `dupsOn` false the copies are then simply left out of what is shown and rows that
// only held copies close up — so hidden copies give their rows back (REQ_FE_017) without anything
// else changing row. Displayed row numbers are the stored rows renumbered without gaps, which is also
// how a row emptied by a move closes up (REQ_FE_016).

import type { RoadmapFull, Workstream } from '../api/types'
import { dayOf, type Day } from './axis'

export interface PackItem {
  kind: 'deliverable' | 'milestone'
  id: number
  start: Day
  end: Day // inclusive
  storedRow: number
  copy: boolean // a deliverable drawn in one of its non-primary workstreams
}

export interface PackedItem extends PackItem {
  row: number // the row it occupies, in stored-row numbering
  displayRow: number | null // its row on screen; null for a copy that isn't shown
}

export interface PackedWorkstream {
  items: PackedItem[] // everything, hidden copies included
  shown: PackedItem[] // what is drawn
  usedRows: number[] // stored rows on screen, top to bottom: display row i is usedRows[i]
  rows: number // rows on screen (at least 1)
  relocated: PackedItem[] // items whose stored row no longer fit; `row` is where they went. Read only by the tests' sticky-row checks
}

export interface WorkstreamLayout extends PackedWorkstream {
  ws: Workstream
}

export function overlaps(a: { start: Day; end: Day }, b: { start: Day; end: Day }): boolean {
  return a.start <= b.end && b.start <= a.end
}

// Who keeps a contested stored row: main blocks before copies, then earlier start, deliverables before
// milestones, lower id. Deterministic, so every viewer resolves a conflict the same way.
function priority(a: PackItem, b: PackItem): number {
  return Number(a.copy) - Number(b.copy) || a.start - b.start || (a.kind === b.kind ? 0 : a.kind === 'deliverable' ? -1 : 1) || a.id - b.id
}

export function packWorkstream(input: PackItem[], dupsOn: boolean): PackedWorkstream {
  const occupied = new Map<number, PackItem[]>()
  const fits = (it: PackItem, row: number) => !(occupied.get(row) ?? []).some((o) => overlaps(o, it))
  const take = (it: PackItem, row: number): PackedItem => {
    occupied.set(row, [...(occupied.get(row) ?? []), it])
    return { ...it, row, displayRow: null }
  }
  const ordered = [...input].sort(priority)
  const placed = new Map<PackItem, PackedItem>()
  const deferred: PackItem[] = []
  for (const it of ordered) {
    if (it.storedRow >= 0 && fits(it, it.storedRow)) placed.set(it, take(it, it.storedRow))
    else deferred.push(it)
  }
  const relocated: PackedItem[] = []
  for (const it of deferred) {
    let row = 0
    while (!fits(it, row)) row++
    const p = take(it, row)
    placed.set(it, p)
    relocated.push(p)
  }
  const items = input.map((it) => placed.get(it)!)
  const shown = items.filter((it) => dupsOn || !it.copy)
  const usedRows = [...new Set(shown.map((it) => it.row))].sort((a, b) => a - b)
  for (const it of shown) it.displayRow = usedRows.indexOf(it.row)
  return { items, shown, usedRows, rows: Math.max(1, usedRows.length), relocated }
}

// The items of one workstream of a roadmap, as packing input.
function workstreamItems(roadmap: RoadmapFull, wsId: number): PackItem[] {
  const out: PackItem[] = []
  for (const d of roadmap.deliverables) {
    const m = d.workstreams.find((w) => w.id === wsId)
    if (m) out.push({ kind: 'deliverable', id: d.id, start: dayOf(d.start_date), end: dayOf(d.end_date), storedRow: m.row, copy: d.workstreams[0].id !== wsId })
  }
  for (const ms of roadmap.milestones) {
    if (ms.workstream_id === wsId) out.push({ kind: 'milestone', id: ms.id, start: dayOf(ms.date), end: dayOf(ms.date), storedRow: ms.row, copy: false })
  }
  return out
}

// Every workstream of a roadmap that holds something, in position order, packed. REQ_FE_127: a workstream no
// roadmap item belongs to is left out. Membership is read from the data, copies included, so it does not depend
// on `dupsOn` — switching copies off never removes a workstream. This is the one place that decides which
// workstreams are drawn (team roadmap, company view and trace alike); everything else — bands, drop targets,
// the gutter — follows from this list.
export function packRoadmap(roadmap: RoadmapFull, dupsOn: boolean): WorkstreamLayout[] {
  return [...roadmap.workstreams]
    .sort((a, b) => a.position - b.position)
    .map((ws) => ({ ws, input: workstreamItems(roadmap, ws.id) }))
    .filter((w) => w.input.length > 0)
    .map(({ ws, input }) => ({ ws, ...packWorkstream(input, dupsOn) }))
}

// ---------- drop targets (REQ_FE_014/015) ----------

// The stored row behind a row on screen; the row just below the last one is a new row, numbered past
// every row in use (hidden copies' rows included, so it can never land on one).
export function storedRowFor(ws: PackedWorkstream, displayRow: number): number {
  if (displayRow < ws.usedRows.length) return ws.usedRows[displayRow]
  return ws.items.reduce((max, it) => Math.max(max, it.row), -1) + 1
}

// Would a deliverable (or milestone, `kind`) with these dates fit in that stored row? Its own blocks
// don't count. Checks the full workstream, hidden copies included, so a drop can't create an overlap
// that only shows up once copies are switched back on.
export function slotFree(ws: PackedWorkstream, row: number, start: Day, end: Day, id: number, kind: PackItem['kind'] = 'deliverable'): boolean {
  return !ws.items.some((o) => o.row === row && !(o.kind === kind && o.id === id) && overlaps(o, { start, end }))
}
