import type { ReactNode } from 'react'
import { Calendar, Download, Plus } from 'lucide-react'
import * as prefs from '../lib/prefs'
import type { Zoom } from '../lib/prefs'
import { useCanEdit } from '../lib/canEdit'
import { resolveApiBaseURL } from '../api/base'
import type { RoadmapFull } from '../api/types'
import { addDate, dayOf, fmtDay, localDay, roadmapSpan, type Day } from '../timeline/axis'

const baseURL = resolveApiBaseURL(import.meta.env.VITE_API_URL) // `??`, never `||` (REQ_FE_087)

const ZOOMS: { value: Zoom; label: string }[] = [
  { value: 'year', label: 'Year' },
  { value: 'half', label: 'Half year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month' },
]

// REQ_FE_060: the visible range is the earliest to the latest date across the roadmap's
// deliverables and milestones — the same derivation docs/API.md gives for the server's
// range_start/range_end. It is computed here from the live roadmap data (not read off
// roadmap.range_start/range_end, which are only recalculated server-side and go stale on the
// client after a drag or a form edit) so the display updates the moment a date changes, and it
// goes through axis.ts's Day helpers so this stays the only place besides axis.ts that touches a
// date (REQ_FE_065).
function visibleRange(roadmap?: RoadmapFull): { start: Day; end: Day } {
  const span = roadmap ? roadmapSpan(roadmap) : null
  if (!span) {
    // REQ_FE_061: an empty roadmap shows a window from 3 months before today to 9 months after.
    const today = localDay(new Date())
    return { start: addDate(today, 0, -3), end: addDate(today, 0, 9) }
  }
  return { start: span.min, end: span.max }
}

// Wording from wireframes/team-roadmap-deps.html.
const COPIES_TIP = 'One deliverable can belong to one or more workstreams'
const COPIES_LOCKED_TIP =
  'Dependencies show one block per deliverable (its primary workstream), so this is locked while arrows are on. Your previous setting is restored when you hide dependencies.'

// REQ_FE_101: the admin-only add buttons of the team roadmap's top bar, in the order Workstream, Deliverable, Milestone;
// Workstream opens the Manage workstreams page (REQ_FE_105).
export function AddButtons({ onAddWorkstream, onAddDeliverable, onAddMilestone }: { onAddWorkstream: () => void; onAddDeliverable: () => void; onAddMilestone: () => void }) {
  const canEdit = useCanEdit()
  if (!canEdit) return null
  return (
    <>
      <button type="button" className="btn ghost" title="New workstream" data-testid="add-workstream" onClick={onAddWorkstream}>
        <Plus size={16} aria-hidden="true" />
        <span className="hidden min-[1440px]:inline">Workstream</span>
      </button>
      <button type="button" className="btn ghost" title="New deliverable" data-testid="add-deliverable" onClick={onAddDeliverable}>
        <Plus size={16} aria-hidden="true" />
        <span className="hidden min-[1440px]:inline">Deliverable</span>
      </button>
      <button type="button" className="btn ghost" title="New milestone" data-testid="add-milestone" onClick={onAddMilestone}>
        <Plus size={16} aria-hidden="true" />
        <span className="hidden min-[1440px]:inline">Milestone</span>
      </button>
    </>
  )
}

// REQ_IMP_026: downloads the roadmap as a CSV file (REQ_API_023); anyone can use it.
export function DownloadCsvButton({ roadmapId }: { roadmapId: number }) {
  return (
    <a
      className="btn icon ghost"
      href={`${baseURL}/api/roadmaps/${roadmapId}/export.csv`}
      download
      title="Download this roadmap as a CSV file"
      aria-label="Download CSV"
      data-testid="download-csv"
    >
      <Download size={17} aria-hidden="true" />
    </a>
  )
}

// The right-hand part of the top bar (REQ_FE_101/102): the read-only range (REQ_FE_060), then the copies and the
// dependencies switch (REQ_FE_051, REQ_DEP_013). `switches` is false on the trace, which has neither (REQ_FE_102).
export function Toolbar({
  roadmap,
  range: rangeOverride,
  switches = true,
  dupsOn = true,
  onDupsChange = () => {},
  depsOn = false,
  onDepsChange = () => {},
}: {
  roadmap?: RoadmapFull
  // Company views (REQ_FE_093): the combined range derived from every loaded roadmap, shown instead of one roadmap's.
  range?: { start: string; end: string } | null
  switches?: boolean
  // REQ_FE_051/017/071: owned by the page, since it also drives Timeline's packing.
  dupsOn?: boolean
  onDupsChange?: (visible: boolean) => void
  // REQ_DEP_013-015: while arrows are on, the copies switch is locked.
  depsOn?: boolean
  onDepsChange?: (visible: boolean) => void
}) {
  const range = rangeOverride ? { start: dayOf(rangeOverride.start), end: dayOf(rangeOverride.end) } : visibleRange(roadmap)

  // REQ_FE_051: named after the action a click WILL perform.
  function toggleCopies() {
    const next = !dupsOn
    prefs.setCopiesVisible(next)
    onDupsChange(next)
  }

  // REQ_DEP_013: labelled with the action a click performs, like the copies switch.
  function toggleDeps() {
    const next = !depsOn
    prefs.setDependenciesVisible(next)
    onDepsChange(next)
  }

  return (
    <>
      <span className="range" title="Visible range" data-testid="range">
        <Calendar size={14} aria-hidden="true" />
        <span className="hidden min-[1700px]:inline">{fmtDay(range.start)}</span>
        <span className="inline min-[1700px]:hidden">{fmtDay(range.start, false)}</span>
        <span className="arrow">→</span>
        <span className="hidden min-[1700px]:inline">{fmtDay(range.end)}</span>
        <span className="inline min-[1700px]:hidden">{fmtDay(range.end, false)}</span>
      </span>
      {switches && (
        <>
          {/* REQ_DEP_014: with arrows on, copies are locked off; aria-disabled (not `disabled`) keeps it
              focusable so the tooltip explaining why is reachable by keyboard and hover. */}
          <button
            type="button"
            id="sw-copies"
            data-testid="sw-copies"
            role="switch"
            aria-checked={dupsOn}
            aria-disabled={depsOn || undefined}
            title={depsOn ? COPIES_LOCKED_TIP : COPIES_TIP}
            className={`switch ${dupsOn ? 'on' : ''} ${depsOn ? 'disabled' : ''}`}
            onClick={depsOn ? undefined : toggleCopies}
          >
            <span className="track" aria-hidden="true" />
            <span className="hidden min-[1700px]:inline">
              {dupsOn ? 'Hide multi-workstream' : 'Show multi-workstream'}
            </span>
            <span className="inline min-[1700px]:hidden">{dupsOn ? 'Hide copies' : 'Show copies'}</span>
          </button>
          <button type="button" id="sw-deps" data-testid="sw-deps" role="switch" aria-checked={depsOn} className={`switch ${depsOn ? 'on' : ''}`} onClick={toggleDeps}>
            <span className="track" aria-hidden="true" />
            <span className="hidden min-[1700px]:inline">{depsOn ? 'Hide dependencies' : 'Show dependencies'}</span>
            <span className="inline min-[1700px]:hidden">{depsOn ? 'Hide deps' : 'Show deps'}</span>
          </button>
        </>
      )}
    </>
  )
}

// REQ_FE_136: the company view's Milestones only switch, for the zoom row. The page keeps it in the address. Wrapped in a
// span so the row's left-hand buttons (team roadmap, trace) still push the zoom right.
export function MilestonesSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <span>
      <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} data-testid="sw-milestones" onClick={onToggle}>
        <span className="track" aria-hidden="true" />
        Milestones only
      </button>
    </span>
  )
}

// REQ_FE_066: the zoom choice in its own row directly above the timeline, aligned right; `children` (the team
// filter of the by-workstream view) sit at the row's left end.
export function ZoomRow({ zoom, onZoomChange, children }: { zoom: Zoom; onZoomChange: (z: Zoom) => void; children?: ReactNode }) {
  function setZoom(z: Zoom) {
    prefs.setZoom(z)
    onZoomChange(z)
  }
  return (
    <div className="zoombar" data-testid="zoom-row">
      {children}
      <span>Zoom</span>
      <div className="seg" id="zoomseg" data-testid="zoomseg">
        {ZOOMS.map((z) => (
          <button key={z.value} type="button" data-z={z.value} className={zoom === z.value ? 'on' : ''} aria-pressed={zoom === z.value} onClick={() => setZoom(z.value)}>
            {z.label}
          </button>
        ))}
      </div>
    </div>
  )
}
