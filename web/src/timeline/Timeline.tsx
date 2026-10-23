// The timeline: axis header (months above weeks), pinned workstream names, gridlines, twin horizontal
// scrollbars, today marker and past shading, and the deliverables and milestones with drag-to-resize
// and drag-to-move (a milestone only moves: it is a single day). Positions come from axis.ts (dates <->
// pixels), pack.ts (rows) and geometry.ts; the drag arithmetic from drag.ts. Dragging is hand-written
// with pointer events (REQ_OVR_009). Saving is the caller's: a finished drag calls onPatchDeliverable or
// onPatchMilestone with the exact PATCH body.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type UIEvent } from 'react'
import { ChevronLeft, ChevronRight, Ellipsis, Flag, UserX } from 'lucide-react'
import { STATUS } from '../lib/status'
import type { DeliverablePatch, Icon, ItemRef, MilestonePatch, RoadmapFull } from '../api/types'
import { fgOf } from '../lib/contrast'
import { ICONS } from '../lib/icons'
import { refusalMessage } from '../lib/apiError'
import { CAP_MESSAGE, dateToX, dayOf, fmtDay, fmtWd, gridFor, gridWidth, isoOf, localDay, monthCells, nextDay, pxPerDay, todayX, unionGrid, weekCells, weekLabelMode, xToDate, type Day, type Grid, type View, type Zoom } from './axis'
import { capCheck, clampDrag, tighter, wallsFor, type Bounds, type DragMode } from './drag'
import { BAND_PAD, BAR_H, DIAMOND, MS_TOP, RING_LABEL, RING_MIN, ROW_PITCH, bandHeight, barBox, milestoneGeom, rowTop, snugBelow, tagFits, tagWidth } from './geometry'
import type { MergedView } from './company'
import { depLimits, edgeEnds, itemKey, limitsForMode, routeArrow, type Box } from './deps'
import { MilestoneMarker } from './MilestoneMarker'
import { packRoadmap, slotFree, storedRowFor, type PackedItem, type WorkstreamLayout } from './pack'
import './timeline.css'

export type SelectType = 'deliverable' | 'milestone'

export interface TimelineProps {
  roadmap: RoadmapFull
  zoom: Zoom
  dupsOn: boolean // show copies of multi-workstream deliverables (false also when dependencies force single-block mode)
  canEdit: boolean
  // M1 (review finding): GET /api/icons's effective labels (default, or an admin relabel, REQ_FE_080
  // "immediate for everyone") — a hover label falls back to lib/icons.ts's hardcoded default only
  // until this resolves. Optional so existing callers/tests that don't exercise icons still compile.
  icons?: Icon[]
  selected?: { id: number; type: SelectType } | null
  onSelect: (id: number, type: SelectType) => void
  onEdit?: (id: number) => void // the three-dot button on a deliverable (REQ_FE_020)
  // Saves a finished drag (dates together, plus workstream_ids/rows for a move to another row). A row the layout had
  // to change is shown, never saved (REQ_FE_011: only a user's drag or edit saves a row). The dragged bar stays where it
  // was dropped until the returned promise settles; the caller then passes the updated roadmap back in.
  onPatchDeliverable?: (id: number, patch: DeliverablePatch) => Promise<unknown> | void
  // The same for a milestone: a finished drag sends `date` if it changed and `workstream_id` + `row`
  // (the row in that workstream) if it was dropped into another row.
  onPatchMilestone?: (id: number, patch: MilestonePatch) => Promise<unknown> | void
  // Extra limits on a deliverable's dates while it is dragged — the Phase 5 dependency rule plugs in here.
  dateLimits?: (id: number) => Bounds
  // Phase 5 (REQ_DEP_009–012): draw the roadmap's dependency arrows (and chevron badges for edges whose
  // other end is on another roadmap). Off by default. The dependency date limits on drags (dashed limit
  // line, REQ_DEP_005) apply either way: they come from roadmap.dependencies, on top of dateLimits.
  showDependencies?: boolean
  // REQ_DEP_018: connect mode (hover dots, rubber band) created a dependency — `from` is the prerequisite, `to` the
  // dependent; each end is an item of either kind (REQ_DEP_027: milestone markers have dots too). Saving is the
  // caller's; a rejection's message is shown as a notice. Without it (or without canEdit or showDependencies) there
  // are no dots and no connect mode.
  onCreateDependency?: (from: ItemRef, to: ItemRef) => Promise<unknown> | void
  // REQ_DEP_019: Delete on a selected arrow, or its × button; the ends carry their kinds. Without it (or canEdit)
  // arrows can't be deleted.
  onDeleteDependency?: (from: ItemRef, to: ItemRef) => Promise<unknown> | void
  now?: Date // the clock; defaults to the browser's

  // ---- Phase 7: company views (CONTRACT.md, "Company views") ----
  // REQ_FE_054: deliverable id -> its team's tag, drawn at the left edge of every block of that deliverable (also
  // on copies). The tag is rendered whenever the bar is wide enough for it (geometry.ts tagFits); the name gives
  // way first. A bar too narrow for it carries the tag in its hover title (and `data-tag`) instead.
  teamTags?: ReadonlyMap<number, string>
  // The merged-row view (company.ts mergeByWorkstreamName); `roadmap` must be `merged.roadmap`. Rows are
  // synthetic. The row label reads "N teams · M deliverables · K milestones" (no
  // milestone part when K is 0). The company view is read-only for layout (REQ_FE_096): the page passes no patch
  // or dependency callbacks, so there is no drag, resize, connector dot or arrow delete.
  merged?: MergedView
  // The company axis (companyGrid, REQ_FE_093): draw on exactly this grid.
  sharedGrid?: Grid
  // The meeting aids of a trace (lib/chainHealth.ts): gap flags by item key (REQ_DEP_037), tight links by edge key
  // `${from}>${to}` (REQ_DEP_038), and what a health count highlights (REQ_DEP_036; null: nothing is faded).
  aids?: TraceAids
}

export interface TraceAids {
  flags: ReadonlyMap<string, ('gap' | 'owner')[]>
  tight: ReadonlyMap<string, { days: number; text: string }>
  focus: { items: ReadonlySet<string>; edges: ReadonlySet<string> | null } | null // edges null: those between two highlighted items
}
const FLAG_TIP = { gap: 'No prerequisites: nothing is mapped as leading to this milestone', owner: 'No owner' }
const FLAG_W = 15 // .gap-flag in timeline.css
const FLAG_GAP = 2 // .gap-flags gap
const FLAG_RIGHT = 4 // .gap-flags right on a deliverable (0 on a milestone); measured inside the bar's border, 1.5 px a side

const TAKEN = 'That spot is taken — it would overlap another item, so nothing moved'

interface Band {
  w: WorkstreamLayout
  top: number
  h: number
}
interface Target {
  ws: number
  displayRow: number
  row: number // stored-row numbering
  top: number
}
interface Drag {
  kind: SelectType
  id: number
  mode: DragMode
  el: HTMLElement
  pointerId: number
  x0: number
  y0: number
  grabDy: number
  s0: Day
  e0: Day
  view: View
  bands: Band[]
  layout: WorkstreamLayout[]
  capOk: (s: Day, e: Day) => boolean
  limits: Bounds
  dep: Bounds // the dependency part of `limits`, for the limit lines
  grid0: Grid
  origin: Target
  target: Target
  active: boolean
  vertical: boolean
  s: Day
  e: Day
  ok: boolean
}
interface Preview {
  kind: SelectType
  id: number
  s: Day
  e: Day
  at: Target | null // set while the item hovers over another row
  slot: { top: number; ok: boolean } | null
  grid0: Grid
  pending: boolean // dropped, waiting for the save
  lim: Bounds | null // the dependency limits this drag can reach, drawn as dashed limit lines (REQ_DEP_005)
  top: number // where the dragged bar sits, for the limit lines
}
interface Connect {
  anchor: ItemRef
  side: 'left' | 'right' // right dot: anchor blocks the next click; left dot: anchor depends on it
}

export function Timeline({ roadmap, zoom, dupsOn, canEdit, icons = [], selected, onSelect, onEdit, onPatchDeliverable, onPatchMilestone, dateLimits, showDependencies = false, onCreateDependency, onDeleteDependency, now, teamTags, merged, sharedGrid, aids }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const justDragged = useRef(false)
  const [width, setWidth] = useState(0)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [tip, setTip] = useState<{ text: string; sub: string; x: number; y: number } | null>(null)
  const [hlWeek, setHlWeek] = useState<{ left: number; width: number } | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [selEdge, setSelEdge] = useState<{ from: ItemRef; to: ItemRef } | null>(null)
  const [connect, setConnect] = useState<Connect | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  // M1: effective labels from GET /api/icons, falling back to lib/icons.ts's default until that
  // resolves (or for a key it doesn't cover) — REQ_FE_080's relabel must show up here too.
  const iconLabels = useMemo(() => new Map(icons.map((i) => [i.key, i.label])), [icons])

  const today = localDay(now ?? new Date())
  const editable = canEdit && !!onPatchDeliverable
  const msEditable = canEdit && !!onPatchMilestone
  const dotsOn = canEdit && showDependencies && !!onCreateDependency // REQ_DEP_020: readers get no dots, no connect mode
  const canDeleteDep = canEdit && !!onDeleteDependency
  const isPreview = (kind: SelectType, id: number) => preview?.kind === kind && preview.id === id
  const layout = useMemo(() => packRoadmap(roadmap, dupsOn), [roadmap, dupsOn])
  const byId = useMemo(() => new Map(roadmap.deliverables.map((d) => [d.id, d])), [roadmap])
  const msById = useMemo(() => new Map(roadmap.milestones.map((m) => [m.id, m])), [roadmap])
  const allDeps = useMemo(() => roadmap.dependencies, [roadmap])

  // the grid follows the data, including a bar being dragged past its edge (REQ_FE_063); it only
  // grows during a drag and settles on the saved data afterwards
  let min: Day | null = null
  let max: Day | null = null
  const span = (a: Day, b: Day) => {
    min = min === null ? a : Math.min(min, a)
    max = max === null ? b : Math.max(max, b)
  }
  for (const d of roadmap.deliverables) {
    if (isPreview('deliverable', d.id)) span(preview!.s, preview!.e)
    else span(dayOf(d.start_date), dayOf(d.end_date))
  }
  for (const m of roadmap.milestones) {
    if (isPreview('milestone', m.id)) span(preview!.s, preview!.e)
    else span(dayOf(m.date), dayOf(m.date))
  }
  let grid = sharedGrid ?? gridFor(min, max, today)
  if (preview) grid = unionGrid(grid, preview.grid0)
  const view: View = { ...grid, px: pxPerDay(zoom, width || 1000) }
  const W = gridWidth(view)

  const bands: Band[] = []
  let y = 0
  for (const w of layout) {
    const h = bandHeight(w.rows)
    bands.push({ w, top: y, h })
    y += h
  }
  const H = Math.max(y, bandHeight(1))

  // ---- measuring and scrolling ----
  useLayoutEffect(() => {
    const el = scrollRef.current!
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Scrolling is one-directional per source (REQ_FE_069, M6). Whoever the user scrolled tells the others where to go;
  // an element we move ourselves is marked, and the scroll event the browser then fires for it (which may report a
  // clamped value, because that part is not as wide yet) is an echo and is ignored. A mark lives until the next
  // animation frame, by which time the browser has delivered that event (scroll events run before rAF callbacks);
  // a synchronous flag cannot do this, the events are asynchronous.
  const marks = useRef(new Map<HTMLElement, number>())
  const markSeq = useRef(0)
  const pushScroll = (x: number) => {
    for (const el of [scrollRef.current, topRef.current, headRef.current]) {
      if (!el || Math.abs(el.scrollLeft - x) <= 0.5) continue
      const token = ++markSeq.current
      marks.current.set(el, token)
      requestAnimationFrame(() => {
        if (marks.current.get(el) === token) marks.current.delete(el)
      })
      el.scrollLeft = x
    }
  }
  const placed = useRef<{ zoom: Zoom; start: Day } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !width) return
    const prev = placed.current
    if (!prev || prev.zoom !== zoom) {
      // a new zoom level (and the first opening) opens on today, a third of the way in
      const tx = todayX(view, today) ?? (today < view.start ? 0 : W)
      pushScroll(Math.max(0, tx - el.clientWidth / 3))
    } else if (prev.start !== view.start) {
      pushScroll(el.scrollLeft + dateToX(prev.start, view)) // the grid grew or shrank on the left: keep the view still
    }
    placed.current = { zoom, start: view.start }
  })
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (marks.current.has(e.currentTarget)) return // an echo of our own move
    pushScroll(e.currentTarget.scrollLeft)
  }

  // ---- notices ----
  const noticeTimer = useRef<number>(0)
  const say = (msg: string) => {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3200)
  }
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  // ---- dragging (REQ_FE_012/014/016/062/063/068) ----
  const cancelDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    justDragged.current = d.active // the click that follows a cancelled drag selects nothing
    if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId)
    setPreview(null)
  }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current?.active) cancelDrag()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // connect mode ends on Esc; Delete removes the selected arrow (REQ_DEP_018/019)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConnect(null)
        setSelEdge(null)
      } else if (e.key === 'Delete' && selEdge && canDeleteDep) {
        const el = e.target as HTMLElement | null
        if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return
        deleteDep(selEdge.from, selEdge.to)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (!dotsOn) setConnect(null) // the toggle or the rights went away mid-connect
  }, [dotsOn])
  // a failed dependency save says why, like a failed drag save
  const saveDep = (run: () => Promise<unknown> | void) =>
    Promise.resolve(run()).catch((err) => {
      console.error('Could not save the dependency change', err)
      say(refusalMessage(err) ?? 'Could not save the change')
    })
  const deleteDep = (from: ItemRef, to: ItemRef) => {
    setSelEdge(null)
    setHoverEdge(null)
    void saveDep(() => onDeleteDependency!(from, to))
  }
  const createDep = (from: ItemRef, to: ItemRef) => {
    setConnect(null)
    void saveDep(() => onCreateDependency!(from, to))
  }

  const beginDrag = (ev: PointerEvent<HTMLElement>, it: PackedItem, band: Band) => {
    justDragged.current = false
    if (!(it.kind === 'deliverable' ? editable : msEditable) || ev.button !== 0 || it.copy || preview?.pending || connect) return
    const t = ev.target as HTMLElement
    if (t.closest('.more, .cdot')) return
    // a milestone is a single day: it only ever moves, never resizes
    const mode: DragMode = it.kind === 'milestone' ? 'move' : t.closest('.rz.l') ? 'start' : t.closest('.rz.r') ? 'end' : 'move'
    const el = ev.currentTarget
    el.setPointerCapture(ev.pointerId)
    const dep = limitsForMode(depLimits(allDeps, it.id, it.kind), mode) // REQ_DEP_005/026: a milestone's date is limited too
    const origin: Target = { ws: band.w.ws.id, displayRow: it.displayRow!, row: it.row, top: rowTop(band.top, it.displayRow!) }
    drag.current = {
      kind: it.kind, id: it.id, mode, el, pointerId: ev.pointerId, x0: ev.clientX, y0: ev.clientY, grabDy: ev.clientY - el.getBoundingClientRect().top,
      s0: it.start, e0: it.end, view, bands, layout, capOk: capCheck(roadmap, it.id, it.kind),
      limits: tighter((it.kind === 'deliverable' && dateLimits?.(it.id)) || { lo: null, hi: null }, dep),
      dep,
      grid0: grid, origin, target: origin, active: false, vertical: false, s: it.start, e: it.end, ok: true,
    }
  }

  // the workstream row under the dragged bar; the row just below a workstream's last one is a new row
  const slotAt = (d: Drag, clientY: number): Target | null => {
    const barTop = clientY - d.grabDy - bodyRef.current!.getBoundingClientRect().top - (d.kind === 'milestone' ? MS_TOP : 0)
    const probe = barTop + 8 // the upper part of the bar, so the new-row slot at a band's bottom still counts as inside it
    const b = d.bands.find((b) => probe >= b.top && probe < b.top + b.h)
    if (!b) return null
    const displayRow = Math.max(0, Math.min(b.w.usedRows.length, Math.round((barTop - b.top - BAND_PAD) / ROW_PITCH)))
    const home = b.w.ws.id === d.origin.ws && displayRow === d.origin.displayRow
    return { ws: b.w.ws.id, displayRow, row: home ? d.origin.row : storedRowFor(b.w, displayRow), top: rowTop(b.top, displayRow) }
  }
  // workstream id -> displayed row, for the dragged item wherever its displayed row differs from its stored one
  const relocatedRows = (d: Drag) => {
    const out = new Map<number, number>()
    for (const w of d.layout) for (const o of w.items) if (o.id === d.id && o.kind === d.kind && o.row !== o.storedRow) out.set(w.ws.id, o.row)
    return out
  }

  const atHome = (d: Drag) => d.target.ws === d.origin.ws && d.target.displayRow === d.origin.displayRow

  const moveDrag = (ev: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || ev.pointerId !== d.pointerId) return
    const dx = ev.clientX - d.x0
    const dy = ev.clientY - d.y0
    if (!d.active && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    d.active = true
    if (d.mode === 'move' && (d.vertical || Math.abs(dy) > 8)) {
      d.vertical = true
      d.target = slotAt(d, ev.clientY) ?? d.target
    }
    const home = atHome(d)
    // walls only hold in rows the bar stays in; a row it is dropped into is checked as a whole instead
    const skip = home ? [] : [d.origin.ws, d.target.ws]
    const walls = wallsFor(d.layout, d.id, d.s0, d.e0, skip, d.kind)
    const dd = xToDate(dateToX(d.s0, d.view) + dx, d.view) - d.s0 // snap to the nearest day
    const r = clampDrag(d.mode, d.s0, d.e0, dd, tighter(walls, d.limits), d.capOk)
    d.s = r.s
    d.e = r.e
    d.ok = home || slotFree(d.layout.find((w) => w.ws.id === d.target.ws)!, d.target.row, r.s, r.e, d.id, d.kind)
    if (r.capped) say(CAP_MESSAGE)
    setPreview({ kind: d.kind, id: d.id, s: r.s, e: r.e, at: home ? null : d.target, slot: d.vertical && !home ? { top: d.target.top, ok: d.ok } : null, grid0: d.grid0, pending: false, lim: d.dep.lo !== null || d.dep.hi !== null ? d.dep : null, top: d.target.top })
  }

  const endDrag = (ev: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || ev.pointerId !== d.pointerId) return
    drag.current = null
    if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId)
    if (!d.active) return // a click; onClick selects
    justDragged.current = true
    const moved = !atHome(d)
    if (moved && !d.ok) {
      setPreview(null)
      say(TAKEN) // REQ_FE_015
      return
    }
    let patch: DeliverablePatch | MilestonePatch
    let save: () => Promise<unknown> | void
    if (d.kind === 'milestone') {
      const p: MilestonePatch = {}
      if (d.s !== d.s0) p.date = isoOf(d.s)
      if (moved) {
        p.workstream_id = d.target.ws
        p.row = d.target.row // the row in the workstream it was dropped into (REQ_DAT_026)
      } else if (Object.keys(p).length && relocatedRows(d).size) p.row = d.origin.row // legacy data: save the row shown (REQ_FE_011)
      patch = p
      save = () => onPatchMilestone!(d.id, p)
    } else {
      const p: DeliverablePatch = {}
      if (d.s !== d.s0 || d.e !== d.e0) {
        p.start_date = isoOf(d.s)
        p.end_date = isoOf(d.e)
      }
      if (moved) {
        // REQ_FE_016: out of the workstream it came from, into the new one; other memberships stay
        const ids = byId.get(d.id)!.workstream_ids.map((w) => (w === d.origin.ws ? d.target.ws : w))
        p.workstream_ids = [...new Set(ids)]
      }
      // legacy data: a stored row that no longer fit is saved as shown (REQ_FE_011); a moved item takes the dropped row
      const rows = relocatedRows(d)
      if (moved) {
        rows.delete(d.origin.ws)
        rows.set(d.target.ws, d.target.row)
      }
      if (rows.size && Object.keys(p).length) p.rows = Object.fromEntries(rows)
      patch = p
      save = () => onPatchDeliverable!(d.id, p)
    }
    if (!Object.keys(patch).length) {
      setPreview(null)
      return
    }
    setPreview((p) => p && { ...p, slot: null, lim: null, pending: true })
    const clear = () => setPreview(null)
    // M2 (review finding): a rejected save (e.g. 409 row_overlap, REQ_API_051) snaps the bar back and says why, in
    // the same notice banner "That spot is taken" already uses.
    Promise.resolve(save()).then(clear, (err) => {
      clear()
      say(refusalMessage(err) ?? 'Could not save the change')
    })
  }

  const click = (id: number, type: SelectType) => {
    if (justDragged.current) {
      justDragged.current = false
      return
    }
    if (connect) {
      // REQ_DEP_018: the next bar clicked completes the connection; a click that isn't on a bar cancels
      if (!(type === connect.anchor.kind && id === connect.anchor.id)) {
        if (connect.side === 'right') createDep(connect.anchor, { kind: type, id })
        else createDep({ kind: type, id }, connect.anchor)
      }
      return
    }
    onSelect(id, type)
  }
  const key = (id: number, type: SelectType) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (connect) click(id, type) // completes a connection started from the keyboard
      else onSelect(id, type)
    }
  }
  // REQ_DEP_018: a connector dot is focusable, and Enter or Space on it starts connect mode like a click
  const dotProps = (kind: SelectType, id: number, side: Connect['side']) => ({
    role: 'button',
    tabIndex: 0,
    onPointerDown: (e: PointerEvent<HTMLElement>) => e.stopPropagation(),
    onClick: (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation()
      startConnect(kind, id, side)
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.closest<HTMLElement>('.deliverable, .ms')?.focus() // the dots hide in connect mode; Tab goes on from the item
      startConnect(kind, id, side)
    },
  })

  // ---- hover tips on week cells and status badges (REQ_FE_064, REQ_FE_041) ----
  const onOver = (e: MouseEvent) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]')
    if (!c) return
    const [text, sub] = c.dataset.tip!.split('|')
    const r = c.getBoundingClientRect()
    setTip({ text, sub: sub ?? '', x: r.left + r.width / 2, y: r.bottom + 6 })
    if (c.classList.contains('hw')) setHlWeek({ left: c.offsetLeft, width: c.offsetWidth })
  }
  const onOut = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-tip]')) {
      setTip(null)
      setHlWeek(null)
    }
  }

  // ---- connect mode: pointer position in the grid's own coordinates, for the rubber band ----
  const trackCursor = (e: PointerEvent<HTMLElement>) => {
    if (!connect) return
    const r = bodyRef.current!.getBoundingClientRect()
    setCursor({ x: e.clientX - r.left, y: e.clientY - r.top })
  }
  const innerDown = (e: PointerEvent<HTMLElement>) => {
    if (!(e.target as HTMLElement).closest('.dep-hit, .dep-x')) setSelEdge(null)
  }
  const innerClick = (e: MouseEvent<HTMLElement>) => {
    if (connect && !(e.target as HTMLElement).closest('.deliverable, .ms')) setConnect(null) // empty space cancels (REQ_DEP_018)
  }
  const startConnect = (kind: SelectType, id: number, side: Connect['side']) => {
    setSelEdge(null)
    setCursor(null)
    setConnect({ anchor: { kind, id }, side })
  }

  // ---- drawing ----
  // REQ_DEP_036/037: what a health count highlights, and the gap flags on the top-right corner of an item
  const faded = (k: string) => !!aids?.focus && !aids.focus.items.has(k)
  // Only the flags that fit inside the item's width are drawn (REQ_FE_010): `room` is that width less the flags' right
  // offset. Every gap stays in the item's tooltip (flagTip), the health line and the Accountable list.
  const gapFlags = (k: string, room: number) => {
    const f = aids?.flags.get(k)
    if (!f) return null
    return (
      <span className="gap-flags" data-flags={f.join(' ')}>
        {f.slice(0, Math.max(0, Math.floor((room + FLAG_GAP) / (FLAG_W + FLAG_GAP)))).map((x) => {
          const G = x === 'gap' ? Flag : UserX
          return <span key={x} className="gap-flag" title={FLAG_TIP[x]}><G size={10} strokeWidth={2.5} aria-label={FLAG_TIP[x]} /></span>
        })}
      </span>
    )
  }
  const flagTip = (k: string) => (aids?.flags.get(k) ?? []).map((x) => ` · ${FLAG_TIP[x]}`).join('')
  const boxes = new Map<string, Box>() // where each item's main block is drawn now (deliverables and milestones, keyed by itemKey): the arrows read it
  const eff = (o: PackedItem) => (isPreview(o.kind, o.id) ? { ...o, start: preview!.s, end: preview!.e } : o)
  const tx = todayX(view, today)
  const pastW = Math.min(W, Math.max(0, tx ?? (today < view.start ? 0 : W)))

  const items = bands.flatMap((b) =>
    b.w.shown.map((it) => {
      const wsName = b.w.ws.name
      const rt = rowTop(b.top, it.displayRow!)
      if (it.kind === 'milestone') {
        const m = msById.get(it.id)!
        const dragging = isPreview('milestone', it.id)
        const at = dragging ? preview!.at : null // hovering over another row: its neighbours are that row's
        const row = at ? (layout.find((w) => w.ws.id === at.ws)?.shown ?? []).filter((o) => o.displayRow === at.displayRow) : b.w.shown.filter((o) => o.displayRow === it.displayRow)
        const { start } = eff(it)
        const status = m.status ?? 'planned' // at risk: the diamond keeps room for its outline (geometry.ts)
        const g = milestoneGeom(start, row.filter((o) => !(o.kind === 'milestone' && o.id === it.id)).map(eff), view, status === 'at_risk')
        boxes.set(itemKey('milestone', it.id), { x: g.left, y: (at ? at.top : rt) + MS_TOP, w: g.size, h: DIAMOND })
        const sel = selected?.type === 'milestone' && selected.id === it.id
        // REQ_FE_040/041: the diamond shows the status itself; a missing status reads as planned
        const mst = STATUS[status]
        const note = m.risk_note
        return (
          <div key={`m${it.id}`} className={`ms${status === 'at_risk' ? ' at-risk' : ''}${sel ? ' selected' : ''}${dragging ? ' dragging' : ''}${faded(itemKey('milestone', it.id)) ? ' faded' : ''}`} data-ws={wsName} data-ms={it.id} data-row={it.displayRow} data-status={status}
            style={{ left: g.left, top: (at ? at.top : rt) + MS_TOP, width: g.size, height: DIAMOND, '--lg': `${g.ring >= RING_MIN ? RING_LABEL : 2}px`, '--dg': `${6 + g.ring}px` } as CSSProperties} title={`${m.name} · ${fmtDay(start)} · ${mst.label}${flagTip(itemKey('milestone', it.id))}`} aria-label={`${m.name} · ${mst.label}`}
            role="button" tabIndex={0} onClick={() => click(it.id, 'milestone')} onKeyDown={key(it.id, 'milestone')}
            onPointerDown={(e) => beginDrag(e, it, b)} onPointerMove={moveDrag} onPointerUp={endDrag} onLostPointerCapture={() => drag.current && cancelDrag()}>
            <span className="mk" data-tip={status === 'at_risk' && note ? `${mst.label}|${note}` : mst.label}>
              <MilestoneMarker status={status} width={g.size} ring={g.ring} />
              {dotsOn && (
                <>
                  <span className="cdot l" aria-label="Connect: this depends on…" title="…depends on" style={{ '--dia': `${g.size}px` } as CSSProperties} {...dotProps('milestone', it.id, 'left')} />
                  <span className="cdot r" aria-label="Connect: this blocks…" title="This blocks…" style={{ '--dia': `${g.size}px` } as CSSProperties} {...dotProps('milestone', it.id, 'right')} />
                </>
              )}
            </span>
            {gapFlags(itemKey('milestone', it.id), g.size)}
            {g.label && <span className="lbl" style={{ maxWidth: g.label.max }}>{m.name}</span>}
            {g.date && <span className="dt">{fmtDay(start, false)}<br />{fmtWd(start)}</span>}
          </div>
        )
      }
      const d = byId.get(it.id)!
      const { start, end } = eff(it)
      const box = barBox(start, end, view)
      const lifted = !it.copy && isPreview('deliverable', it.id) && preview!.at !== null
      const sel = !it.copy && selected?.type === 'deliverable' && selected.id === it.id
      const st = STATUS[d.status]
      const primaryName = layout.find((w) => w.ws.id === d.workstream_ids[0])?.ws.name
      const tag = teamTags?.get(it.id)
      const showTag = tag !== undefined && tagFits(tag, box.width)
      const cls = ['deliverable', it.copy && 'dup', box.width < snugBelow(tag, box.width) && 'snug', box.width < 14 && 'tiny', sel && 'selected', isPreview('deliverable', it.id) && !it.copy && 'dragging', faded(itemKey('deliverable', it.id)) && 'faded'].filter(Boolean).join(' ')
      const top = lifted ? preview!.at!.top : rt
      if (!it.copy) {
        boxes.set(itemKey('deliverable', it.id), { x: box.left, y: top, w: box.width, h: BAR_H })
      }
      const style = { left: box.left, width: box.width, top, '--c': d.color, '--fg': fgOf(d.color) } as CSSProperties
      // A bar's padding and border can't shrink below their own size, so a short bar at a wide zoom would
      // be drawn wider than its days and run into its neighbour (REQ_FE_010): drop the padding when it's
      // narrow (`snug`), and its contents too when even that leaves no room (`tiny`; the hover title stays).
      if (box.width < 30) style.borderWidth = Math.min(1.5, box.width / 2)
      return (
        <div key={`d${it.id}-${b.w.ws.id}`} className={cls} data-deliverable={it.id} data-ws={wsName} data-row={it.displayRow} data-status={d.status} data-tag={tag} style={style}
          title={`${tag !== undefined ? `${tag} · ` : ''}${d.name} · ${fmtDay(start, false)} – ${fmtDay(end, false)}${it.copy ? ` (also in ${primaryName})` : flagTip(itemKey('deliverable', it.id))}`}
          role="button" tabIndex={0} onClick={() => click(it.id, 'deliverable')} onKeyDown={key(it.id, 'deliverable')}
          onPointerDown={(e) => beginDrag(e, it, b)} onPointerMove={moveDrag} onPointerUp={endDrag} onLostPointerCapture={() => drag.current && cancelDrag()}>
          {showTag && <span className="team-tag" style={{ maxWidth: tagWidth(tag!) }}>{tag}</span>}
          {!it.copy && (
            <span className={`st st-${d.status}`} data-tip={d.status === 'at_risk' && d.risk_note ? `${st.label}|${d.risk_note}` : st.label}>
              <st.Icon size={11} strokeWidth={2.5} aria-label={st.label} />
            </span>
          )}
          {!it.copy && d.status === 'at_risk' && <span className="risk-strip" />}
          {!it.copy && gapFlags(itemKey('deliverable', it.id), box.width - FLAG_RIGHT - 3)}
          {editable && !it.copy && (
            <>
              <span className="rz l" />
              <span className="rz r" />
            </>
          )}
          {dotsOn && !it.copy && box.width >= 40 && (
            // REQ_DEP_017: ~14px inside each edge, clear of the 6px resize zone; too-narrow bars get none
            <>
              <span className="cdot l" aria-label="Connect: this depends on…" title="…depends on" {...dotProps('deliverable', it.id, 'left')} />
              <span className="cdot r" aria-label="Connect: this blocks…" title="This blocks…" {...dotProps('deliverable', it.id, 'right')} />
            </>
          )}
          <span className="name">{d.name}</span>
          {d.icons.length > 0 && (
            // M1: hover label is the effective label (an admin relabel, REQ_FE_080, or the default).
            // Keys outside the fixed set (possible in pre-Phase-4 data) are skipped.
            <span className="icons">
              {d.icons.filter((k) => k in ICONS).map((k) => {
                const { Icon, defaultLabel } = ICONS[k]
                const label = iconLabels.get(k) ?? defaultLabel
                return (
                  <span key={k} className="ic" data-icon={k} title={label}>
                    <Icon size={12} strokeWidth={2.25} aria-label={label} />
                  </span>
                )
              })}
            </span>
          )}
          {canEdit && onEdit && !it.copy && (
            <button type="button" className="more" title="Edit deliverable" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onEdit(it.id) }}>
              <Ellipsis size={14} />
            </button>
          )}
        </div>
      )
    }),
  )

  // ---- dependency arrows and chevron badges (REQ_DEP_009–012, REQ_DEP_027: both ends may be a milestone) ----
  const selKey = selected ? itemKey(selected.type, selected.id) : null
  const chosenKey = selEdge ? `${itemKey(selEdge.from.kind, selEdge.from.id)}>${itemKey(selEdge.to.kind, selEdge.to.id)}` : null
  const arrows = showDependencies
    ? allDeps.flatMap((e) => {
        const ends = edgeEnds(e)
        const a = boxes.get(ends.from)
        const b = boxes.get(ends.to)
        if (!a || !b) return [] // an end that is not drawn is a badge (or nothing), never a dangling arrow
        const key = `${ends.from}>${ends.to}`
        const chosen = chosenKey === key
        const hl = chosen || hoverEdge === key || selKey === ends.from || selKey === ends.to
        const tight = aids?.tight.get(key) // REQ_DEP_038
        const f = aids?.focus
        const dim = !!f && !(f.edges ? f.edges.has(key) : f.items.has(ends.from) && f.items.has(ends.to))
        return [{ e, ends, key, chosen, hl, tight, dim, end: { x: b.x, y: b.y + b.h / 2 }, ...routeArrow(a, b, ends.fromKind === 'milestone') }]
      })
    : []
  const badgeCount = new Map<string, number>()
  const hasItem = (k: string) => (k.startsWith('m:') ? msById.has(Number(k.slice(2))) : byId.has(Number(k.slice(2))))
  const badges = showDependencies
    ? allDeps.flatMap((e) => {
        const ends = edgeEnds(e)
        const fromHere = hasItem(ends.from)
        const toHere = hasItem(ends.to)
        if (fromHere === toHere) return []
        const side = toHere ? 'l' : 'r'
        const hereKey = toHere ? ends.to : ends.from
        const here = boxes.get(hereKey)
        if (!here) return []
        const slot = `${side}${hereKey}`
        const n = badgeCount.get(slot) ?? 0
        badgeCount.set(slot, n + 1)
        const x = side === 'l' ? Math.max(0, here.x - 20 - n * 18) : here.x + here.w + 4 + n * 18
        return [{ e, ends, side, other: toHere ? e.from : e.to, x, y: here.y + (here.h - 16) / 2 }]
      })
    : []
  const rubber = (() => {
    if (!connect || !cursor) return null
    const a = boxes.get(itemKey(connect.anchor.kind, connect.anchor.id))
    if (!a) return null
    const pt: Box = { x: cursor.x, y: cursor.y, w: 0, h: 0 }
    return connect.side === 'right' ? routeArrow(a, pt, connect.anchor.kind === 'milestone') : routeArrow(pt, a)
  })()
  const limitXs = preview?.lim ? [preview.lim.lo !== null ? dateToX(preview.lim.lo, view) : null, preview.lim.hi !== null ? dateToX(nextDay(preview.lim.hi), view) : null] : []

  return (
    <div className={`tl${connect ? ' connecting' : ''}`} data-wk={weekLabelMode(view)} onMouseOver={onOver} onMouseOut={onOut}>
      <div className="tl-head">
        <div className="tl-topscroll-row">
          <div className="tl-gutter-w" />
          <div className="tl-topscroll" ref={topRef} onScroll={onScroll} tabIndex={-1} aria-hidden="true">
            <div style={{ width: W, height: 1 }} />
          </div>
        </div>
        <div className="tl-headrow">
          <div className="tl-gutter-w corner">Workstreams</div>
          <div className="tl-hscroll" ref={headRef}>
            <div className="tl-header" style={{ width: W }}>
              {monthCells(grid).map((c) => (
                <div key={c.start} className={`hm${c.quarter ? ' q' : ''}`} style={{ left: dateToX(c.start, view), width: dateToX(c.start + c.days, view) - dateToX(c.start, view) }}>
                  {c.quarter && <span className="qchip">Q{c.quarter}</span>}
                  {c.label}
                  {c.year !== null && <small>{c.year}</small>}
                </div>
              ))}
              {weekCells(grid).map((c) => (
                <div key={c.start} className={`hw${today >= c.start && today < c.start + c.days ? ' cur' : ''}`} data-tip={c.tip}
                  style={{ left: dateToX(c.start, view), width: dateToX(c.start + c.days, view) - dateToX(c.start, view) }}>
                  <span className="wf">{c.full}</span>
                  <span className="wstart">{c.short}</span>
                </div>
              ))}
              {tx !== null && <div className="today-flag" style={{ left: tx }}>Today</div>}
            </div>
          </div>
        </div>
      </div>
      <div className="tl-bodyrow">
        <div className="tl-gutter-w tl-gutter" style={{ height: H }}>
          {bands.map((b) => {
            const n = b.w.items.filter((it) => it.kind === 'deliverable' && !it.copy).length
            const row = merged?.rows.find((r) => r.wsId === b.w.ws.id)
            return (
              <div key={b.w.ws.id} className="ws-label" style={{ top: b.top, height: b.h }}>
                <div className="name" title={b.w.ws.name}>{b.w.ws.name}</div>
                <div className="count">{row ? (merged!.filter.milestonesOnly ? `${row.teams} team${row.teams === 1 ? '' : 's'} · ${row.milestones} milestone${row.milestones === 1 ? '' : 's'}` : `${row.teams} team${row.teams === 1 ? '' : 's'} · ${row.deliverables} deliverable${row.deliverables === 1 ? '' : 's'}${row.milestones ? ` · ${row.milestones} milestone${row.milestones === 1 ? '' : 's'}` : ''}`) : `${n} deliverable${n === 1 ? '' : 's'}`}</div>
              </div>
            )
          })}
        </div>
        <div className="tl-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="tl-inner" ref={bodyRef} style={{ width: W, height: H }} onPointerDown={innerDown} onPointerMove={trackCursor} onClick={innerClick}>
            {weekCells(grid).slice(1).map((c) => <div key={c.start} className="gl" style={{ left: dateToX(c.start, view) }} />)}
            {pastW > 0 && <div className="past" style={{ width: pastW }} />}
            {tx !== null && <div className="today" style={{ left: tx }} />}
            {hlWeek && <div className="wkhl" style={hlWeek} />}
            {bands.map((b) => <div key={b.w.ws.id} className="band" data-ws={b.w.ws.name} data-rows={b.w.rows} style={{ top: b.top, height: b.h, width: W }} />)}
            {items}
            {limitXs.map((x, i) => x !== null && <div key={`lim${i}`} className="dep-limit" style={{ left: x, top: preview!.top - 6, height: ROW_PITCH }} />)}
            {showDependencies && (
              <svg className="deps" width={W} height={H} aria-hidden="true">
                <defs>
                  <marker id="dep-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path className="mark" d="M0,1 L10,5 L0,9 z" /></marker>
                  <marker id="dep-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path className="mark-hl" d="M0,1 L10,5 L0,9 z" /></marker>
                  <marker id="dep-at" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path className="mark-tight" d="M0,1 L10,5 L0,9 z" /></marker>
                </defs>
                {arrows.map((a) => (
                  <g key={a.key} className={`dep${a.hl ? ' hl' : ''}${a.chosen ? ' sel' : ''}${a.tight ? ' tight' : ''}${a.dim ? ' faded' : ''}`} data-dep-from={a.ends.fromId} data-dep-to={a.ends.toId} data-dep-from-kind={a.ends.fromKind} data-dep-to-kind={a.ends.toKind}
                    onMouseEnter={() => setHoverEdge(a.key)} onMouseLeave={() => setHoverEdge((h) => (h === a.key ? null : h))}>
                    <path className="dep-line" d={a.d} markerEnd={`url(#${a.tight ? 'dep-at' : a.hl ? 'dep-ah' : 'dep-a'})`} />
                    <path className="dep-hit" d={a.d} onClick={() => setSelEdge({ from: { kind: a.ends.fromKind, id: a.ends.fromId }, to: { kind: a.ends.toKind, id: a.ends.toId } })}>
                      {a.tight && <title>{a.tight.text}</title>}
                    </path>
                    {a.tight && <text className="dep-slack" x={a.end.x - 6} y={a.end.y - 6} textAnchor="end">{a.tight.days} d</text>}
                    {canDeleteDep && (a.chosen || hoverEdge === a.key) && (
                      <g className="dep-x" role="button" aria-label="Delete dependency" transform={`translate(${a.mx},${a.my})`} onClick={() => deleteDep({ kind: a.ends.fromKind, id: a.ends.fromId }, { kind: a.ends.toKind, id: a.ends.toId })}>
                        <title>Delete dependency</title>
                        <circle r="8" />
                        <path d="M-3,-3 L3,3 M3,-3 L-3,3" />
                      </g>
                    )}
                  </g>
                ))}
                {rubber && <path className="dep-rubber" d={rubber.d} markerEnd="url(#dep-ah)" />}
              </svg>
            )}
            {badges.map((b) => {
              const Chev = b.side === 'l' ? ChevronLeft : ChevronRight
              return (
                <span key={`${b.ends.from}>${b.ends.to}`} className={`dep-badge ${b.side}`} data-dep-from={b.ends.fromId} data-dep-to={b.ends.toId} data-dep-from-kind={b.ends.fromKind} data-dep-to-kind={b.ends.toKind}
                  data-tip={`${b.other.team_name}|${b.other.name}`} aria-label={`${b.side === 'l' ? 'Depends on' : 'Blocks'} ${b.other.name} (${b.other.team_name})`} style={{ left: b.x, top: b.y }}>
                  <Chev size={12} strokeWidth={2.5} />
                </span>
              )
            })}
            {preview?.slot && <div className={`drop-slot${preview.slot.ok ? '' : ' bad'}`} style={{ top: preview.slot.top - 3 }} />}
          </div>
        </div>
      </div>
      {tip && (
        <div className="wk-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
          {tip.sub && <small>{tip.sub}</small>}
        </div>
      )}
      {notice && <div className="tl-notice" role="status">{notice}</div>}
    </div>
  )
}
