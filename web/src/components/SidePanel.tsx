import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Pencil, MoreHorizontal, GripVertical, Link as LinkIcon, TriangleAlert } from 'lucide-react'
import * as prefs from '../lib/prefs'
import { useCanEdit } from '../lib/canEdit'
import { deleteMilestone } from '../api/resources'
import { MilestoneEditForm } from './MilestoneEditForm'
import { MoveItemDialog } from './MoveItemDialog'
import { DeleteItemDialog, DeleteDeliverableDialog } from './DeleteItemDialog'
import type { DepEnd, Deliverable, Icon, Milestone, RoadmapFull } from '../api/types'
import { DeliverableEditForm } from './DeliverableEditForm'
import { formatDateRange, formatDateWd } from '../lib/dates'
import { ICONS } from '../lib/icons'
import { STATUS } from '../lib/status'
import { edgeEnds, itemKey } from '../timeline/deps'
import { Marker } from './DependencyPicker'

export const PANEL_MIN = 280
export const PANEL_MAX = 720
const DEFAULT_WIDTH = 336
const clampWidth = (w: number) => Math.max(PANEL_MIN, Math.min(PANEL_MAX, w))

export type Selection = { id: number; type: 'deliverable' | 'milestone' } | null

export function SidePanel({
  roadmap,
  selection,
  onClose,
  onDeliverableUpdated,
  onOpenFullEdit,
  onMilestoneDeleted = () => {},
  onMilestoneUpdated = () => {},
  onMilestoneMoved = () => {},
  icons = [],
  onDependenciesChanged,
  empty,
  onBack,
}: {
  roadmap: RoadmapFull
  selection: Selection
  onClose: () => void
  onDeliverableUpdated: (d: Deliverable) => void
  onOpenFullEdit: (id: number) => void
  // Phase 4 (REQ_FE_090): fires after a confirmed milestone delete so the caller can drop it from
  // local state and clear the selection; optional/defaulted so existing callers/tests that never
  // exercise delete don't need updating.
  onMilestoneDeleted?: (id: number) => void
  // REQ_FE_100: fires with the saved milestone after the panel's Edit form saves its name, date or workstream.
  onMilestoneUpdated?: (m: Milestone) => void
  // fires with the milestone after the Move dialog sent it to another team's roadmap (it left this one)
  onMilestoneMoved?: (m: Milestone) => void
  // Phase 4 (REQ_FE_080): the icon picker's effective labels, fetched once by the page and threaded
  // down the same way `team`/`workstreams` already are — defaulted so a caller that hasn't fetched
  // yet (or a test) still renders, falling back to lib/icons.ts's hardcoded defaults.
  icons?: Icon[]
  // Phase 5: fires after the picker adds/removes a dependency so the page can refetch the roadmap.
  onDependenciesChanged?: () => void
  // REQ_DEP_039: what the panel shows when nothing is selected, instead of the prompt (the trace's Accountable list),
  // and, while something is selected, a way back to it.
  empty?: ReactNode
  onBack?: () => void
}) {
  const canEdit = useCanEdit()
  const [open, setOpen] = useState(() => prefs.getPanelOpen() ?? true)
  const [width, setWidth] = useState(() => clampWidth(prefs.getPanelWidth() ?? DEFAULT_WIDTH))
  const [editing, setEditing] = useState(false)
  // Done unmounts the focused button; the focus goes back to Edit instead of dropping to <body>.
  const editButtonRef = useRef<HTMLButtonElement>(null)
  const refocusEdit = useRef(false)
  useEffect(() => {
    if (!editing && refocusEdit.current) {
      refocusEdit.current = false
      editButtonRef.current?.focus()
    }
  }, [editing])
  function done() {
    refocusEdit.current = true
    setEditing(false)
  }
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    if (selection) {
      setOpen(true)
      prefs.setPanelOpen(true)
      setEditing(false)
    }
  }, [selection])

  function close() {
    setOpen(false)
    prefs.setPanelOpen(false)
    onClose()
  }

  function onPointerDown(e: React.PointerEvent) {
    dragRef.current = { startX: e.clientX, startW: width }
    setDragging(true)
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return
    const delta = dragRef.current.startX - e.clientX
    setWidth(clampWidth(dragRef.current.startW + delta))
  }
  function onPointerUp() {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    prefs.setPanelWidth(width)
  }
  // A lost capture or a cancelled pointer ends the drag too, so the divider never stays stuck in the dragging state.
  function onDragAborted() {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    prefs.setPanelWidth(width)
  }
  if (!open) return null

  const deliverable = selection?.type === 'deliverable' ? roadmap.deliverables.find((d) => d.id === selection.id) : undefined
  const milestone = selection?.type === 'milestone' ? roadmap.milestones.find((m) => m.id === selection.id) : undefined

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize info panel"
        aria-valuenow={width}
        data-testid="panel-resize-handle"
        className={`resizer${dragging ? ' drag' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onDragAborted}
        onLostPointerCapture={onDragAborted}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 48 : 16
          if (e.key === 'ArrowLeft') {
            const w = Math.min(PANEL_MAX, width + step)
            setWidth(w)
            prefs.setPanelWidth(w)
          }
          if (e.key === 'ArrowRight') {
            const w = Math.max(PANEL_MIN, width - step)
            setWidth(w)
            prefs.setPanelWidth(w)
          }
        }}
      >
        <span className="grip">
          <GripVertical size={12} aria-hidden="true" />
        </span>
      </div>
      <aside className="panel panel-card" style={{ width }} data-testid="side-panel">
      {onBack && (deliverable || milestone) && (
        <button type="button" className="btn ghost sm mb-2" data-testid="panel-back" onClick={onBack}>
          ← Accountable
        </button>
      )}
      <div className="p-head">
        <h2 className="truncate">{deliverable?.name ?? milestone?.name ?? ''}</h2>
        {(deliverable || milestone) && canEdit && !editing && (
          <button type="button" className="btn sm" ref={editButtonRef} onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit
          </button>
        )}
        {deliverable && canEdit && (
          <button
            type="button"
            className="btn icon ghost sm"
            title="Open the full edit window"
            aria-label="Open the full edit window"
            onClick={() => onOpenFullEdit(deliverable.id)}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
        <button type="button" className="btn icon ghost sm" title="Close panel" aria-label="Close panel" onClick={close}>
          <X size={16} />
        </button>
      </div>

      <div className="mt-3.5">
        {!deliverable && !milestone && (empty ?? <div className="hint" data-testid="panel-empty">Select a deliverable or milestone</div>)}
        {milestone && !editing && <MilestoneView key={milestone.id} milestone={milestone} roadmap={roadmap} onDeleted={onMilestoneDeleted} />}
        {milestone && editing && (
          <MilestoneEditForm
            key={milestone.id}
            milestone={milestone}
            roadmap={roadmap}
            onSaved={onMilestoneUpdated}
            onMoved={onMilestoneMoved}
            onDependenciesChanged={onDependenciesChanged}
            onDone={done}
          />
        )}
        {deliverable && !editing && <DeliverableView deliverable={deliverable} roadmap={roadmap} icons={icons} onMoved={onDependenciesChanged} onDeleted={() => { onClose(); onDependenciesChanged?.() }} />}
        {deliverable && editing && (
          <DeliverableEditForm
            deliverable={deliverable}
            team={roadmap.team}
            workstreams={roadmap.workstreams}
            roadmap={roadmap}
            icons={icons}
            onSaved={onDeliverableUpdated}
            onDependenciesChanged={onDependenciesChanged}
            onDone={done}
          />
        )}
      </div>
    </aside>
    </>
  )
}

// REQ_FE_024/090: the milestone's read-only view. Edit (admin) sits in the panel header and opens MilestoneEditForm
// (REQ_FE_100); Delete is behind the one confirmation of REQ_FE_118 (CLAUDE.md rule 5).
function MilestoneView({ milestone, roadmap, onDeleted }: { milestone: Milestone; roadmap: RoadmapFull; onDeleted: (id: number) => void }) {
  const canEdit = useCanEdit()
  const ws = roadmap.workstreams.find((w) => w.id === milestone.workstream_id)
  const [confirming, setConfirming] = useState(false)
  const me = itemKey('milestone', milestone.id)
  const ends = roadmap.dependencies.map((e) => ({ e, k: edgeEnds(e) }))
  const dependsOn = ends.filter(({ k }) => k.to === me).map(({ e }) => e.from)
  const blocks = ends.filter(({ k }) => k.from === me).map(({ e }) => e.to)
  const links = ends.filter(({ k }) => k.to === me || k.from === me).length
  const statusKey = milestone.status ?? 'planned'
  const status = STATUS[statusKey]
  const StatusIcon = status.Icon
  return (
    <div className="text-sm">
      <dl className="kv">
        <dt>Date</dt>
        <dd>{formatDateWd(milestone.date)}</dd>
        <dt>Workstream</dt>
        <dd>{ws && <span className="tag">{ws.name}</span>}</dd>
        <dt>Responsible</dt>
        <dd>{milestone.responsible_person || '—'}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`tag st-tag st-${statusKey}`} data-testid="panel-status">
            <StatusIcon size={12} aria-hidden="true" /> {status.label}
          </span>
        </dd>
        <dt>Team</dt>
        <dd>{roadmap.team.name}</dd>
      </dl>
      {statusKey === 'at_risk' && milestone.risk_note && <RiskBox note={milestone.risk_note} />}
      {milestone.description_html && (
        <>
          <div className="divider" />
          <div className="rich" data-testid="milestone-description" dangerouslySetInnerHTML={{ __html: milestone.description_html }} />
        </>
      )}
      <LinkList links={milestone.links ?? []} />
      <div className="divider" />
      <DepList title="Depends on" items={dependsOn} />
      <DepList title="Blocks" items={blocks} className="mt-2.5" />
      {canEdit && (
        <div className="mt-3.5">
          <button type="button" className="btn danger sm" data-testid="panel-delete" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      )}
      {confirming && (
        <DeleteItemDialog
          name={milestone.name}
          dependencyCount={links}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            await deleteMilestone(milestone.id)
            setConfirming(false)
            onDeleted(milestone.id)
          }}
        />
      )}
    </div>
  )
}

// REQ_FE_112/113: the read-only view. Depends on / Blocks come from the dependencies the page already holds
// (RoadmapFull.dependencies: every edge with an end in the roadmap, with both ends named).
function DeliverableView({ deliverable, roadmap, icons, onMoved = () => {}, onDeleted }: { deliverable: Deliverable; roadmap: RoadmapFull; icons: Icon[]; onMoved?: () => void; onDeleted: () => void }) {
  const canEdit = useCanEdit()
  const [moving, setMoving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const status = STATUS[deliverable.status]
  const StatusIcon = status.Icon
  const iconLabels = new Map(icons.map((i) => [i.key, i.label]))
  // the primary workstream is the first of workstream_ids (ordered by roadmap position, as the timeline treats it)
  const workstreams = deliverable.workstream_ids.flatMap((id) => roadmap.workstreams.find((w) => w.id === id) ?? [])
  const me = itemKey('deliverable', deliverable.id)
  const ends = roadmap.dependencies.map((e) => ({ e, k: edgeEnds(e) }))
  const dependsOn = ends.filter(({ k }) => k.to === me).map(({ e }) => e.from)
  const blocks = ends.filter(({ k }) => k.from === me).map(({ e }) => e.to)
  return (
    <div className="text-sm">
      <div className="swatch-line" style={{ background: deliverable.color }} />
      <dl className="kv">
        <dt>Dates</dt>
        <dd>{formatDateRange(deliverable.start_date, deliverable.end_date)}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`tag st-tag st-${deliverable.status}`} data-testid="panel-status">
            <StatusIcon size={12} aria-hidden="true" /> {status.label}
          </span>
        </dd>
        <dt>Color</dt>
        <dd>
          <span className="swatch-dot inline-block align-middle" style={{ background: deliverable.color, width: 12, height: 12 }} />{' '}
          <span className="font-mono text-xs">{deliverable.color.toUpperCase()}</span>
        </dd>
        <dt>Responsible</dt>
        <dd>{deliverable.responsible_person || '—'}</dd>
        <dt>Team</dt>
        <dd>
          {roadmap.team.name}
          {canEdit && (
            <>
              {' '}
              <button type="button" className="move-link text-accent underline text-xs" title="Move this deliverable to another team" onClick={() => setMoving(true)}>
                (move)
              </button>
            </>
          )}
          {moving && <MoveItemDialog kind="deliverable" item={deliverable} roadmap={roadmap} onClose={() => setMoving(false)} onMoved={() => onMoved()} />}
        </dd>
        <dt>Workstreams</dt>
        <dd className="tagrow" data-testid="panel-workstreams">
          {workstreams.map((w, i) => (
            <span key={w.id} className={`tag${i === 0 ? ' accent' : ''}`}>
              {w.name}
              {i === 0 && workstreams.length > 1 && ' · primary'}
            </span>
          ))}
        </dd>
        <dt>Labels</dt>
        <dd className="tagrow" data-testid="panel-labels">
          {deliverable.icons.length === 0 && <span className="text-text-3">None</span>}
          {deliverable.icons.map((k) => {
            const def = ICONS[k]
            if (!def) return null
            const Icon = def.Icon
            return (
              <span key={k} className="tag">
                <Icon size={12} aria-hidden="true" /> {iconLabels.get(k) ?? def.defaultLabel}
              </span>
            )
          })}
        </dd>
      </dl>
      {deliverable.status === 'at_risk' && deliverable.risk_note && <RiskBox note={deliverable.risk_note} />}
      {deliverable.description_html && (
        <>
          <div className="divider" />
          <div className="rich" dangerouslySetInnerHTML={{ __html: deliverable.description_html }} />
        </>
      )}
      <LinkList links={deliverable.links} />
      <div className="divider" />
      <DepList title="Depends on" items={dependsOn} />
      <DepList title="Blocks" items={blocks} className="mt-2.5" />
      {canEdit && (
        <div className="mt-3.5">
          <button type="button" className="btn danger sm" data-testid="panel-delete" onClick={() => setConfirming(true)}>
            Delete
          </button>
        </div>
      )}
      {confirming && <DeleteDeliverableDialog deliverable={deliverable} roadmap={roadmap} onCancel={() => setConfirming(false)} onDeleted={onDeleted} />}
    </div>
  )
}

function RiskBox({ note }: { note: string }) {
  return (
    <div className="riskbox" title={note}>
      <TriangleAlert size={14} aria-hidden="true" />
      <div>
        <b>At risk</b>
        <br />
        {note}
      </div>
    </div>
  )
}

// REQ_FE_032: a roadmap item's links under its description.
function LinkList({ links }: { links: { label: string; url: string }[] }) {
  if (links.length === 0) return null
  return (
    <>
      <div className="lab mt-3.5">Links</div>
      <div className="link-list">
        {links.map((l) => (
          <a key={l.url} className="link-item" href={l.url} target="_blank" rel="noopener noreferrer">
            <LinkIcon size={13} aria-hidden="true" />
            <span>{l.label}</span>
            <span className="host">{hostOf(l.url)}</span>
          </a>
        ))}
      </div>
    </>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function DepList({ title, items, className = '' }: { title: string; items: DepEnd[]; className?: string }) {
  return (
    <div className={className} data-testid={`panel-${title === 'Blocks' ? 'blocks' : 'depends-on'}`}>
      <div className="lab">{title}</div>
      {items.length === 0 && <div className="text-text-3">None</div>}
      {items.map((o) => (
        <div key={`${o.kind ?? 'deliverable'}:${o.id}`} className="dep-item">
          <Marker kind={o.kind} />
          <span>{o.name}</span>
          <span className="team">{o.team_name}</span>
        </div>
      ))}
    </div>
  )
}
