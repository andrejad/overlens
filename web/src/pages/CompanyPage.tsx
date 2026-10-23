import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpDown } from 'lucide-react'
import * as prefs from '../lib/prefs'
import type { Zoom } from '../lib/prefs'
import { useCanEdit } from '../lib/canEdit'
import { navigate } from '../lib/router'
import { apiError } from '../lib/apiError'
import { fetchCompanyRoadmaps, fetchCompanyTrace, fetchIcons, fetchWorkstreamOrder } from '../api/resources'
import type { CompanyTeam, CompanyTrace, Deliverable, Icon, ItemKind, Milestone } from '../api/types'
import { TopBar } from '../components/AppChrome'
import { MilestonesSwitch, Toolbar, ZoomRow } from '../components/Toolbar'
import { Timeline } from '../timeline/Timeline'
import { applyTrace, companyGrid, deriveCompanyRange, mergeByWorkstreamName, onlyMilestones, traceCounts, traceIds } from '../timeline/company'
import { chainHealth, type HealthKind } from '../lib/chainHealth'
import { AccountableList } from '../components/AccountableList'
import { isoOf, localDay } from '../timeline/axis'
import { edgeEnds, itemKey } from '../timeline/deps'
import { SidePanel, type Selection } from '../components/SidePanel'
import { EditModal } from '../components/EditModal'
import { StatusPills, StatusLegend } from '../components/StatusPills'
import { allDeliverables, findDeliverable, findMilestone, loadedRoadmaps, replaceDeliverable, replaceMilestone } from '../lib/companyView'

export type CompanyMode = 'workstreams' | 'trace'

// The company view (REQ_FE_052, REQ_FE_091-097) and the dependency trace (REQ_DEP_021/022). One
// GET /api/company/roadmaps feeds both; the page merges it by workstream name, and the trace cuts that down to the
// traced chain. Anonymous visitors get the same pages with canEdit false (REQ_AUTH_001). The timeline is read-only
// for layout for everyone (REQ_FE_096): no drag, resize, connector dots or arrow delete; the side panel edits.
// `milestonesOnly` is the address's "?milestones" (REQ_FE_136); on a trace it makes the chain end with its milestone
// (REQ_FE_137).
const HEALTH: { kind: HealthKind; one: string; many: string }[] = [
  { kind: 'risk', one: 'at risk', many: 'at risk' },
  { kind: 'overdue', one: 'overdue', many: 'overdue' },
  { kind: 'owner', one: 'without owner', many: 'without owner' },
  { kind: 'gap', one: 'milestone without prerequisites', many: 'milestones without prerequisites' },
  { kind: 'tight', one: 'tight link', many: 'tight links' },
]

export function CompanyPage({ mode, traceId, traceKind = 'deliverable', milestonesOnly = false }: { mode: CompanyMode; traceId?: number; traceKind?: ItemKind; milestonesOnly?: boolean }) {
  const canEdit = useCanEdit()
  const trace = mode === 'trace'
  const upOnly = trace && milestonesOnly // REQ_FE_137: only what leads to the milestone
  const msQuery = milestonesOnly ? '?milestones' : ''
  const [focus, setFocus] = useState<HealthKind | null>(null) // REQ_DEP_036: the highlighted health count
  const [items, setItems] = useState<CompanyTeam[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [wsOrder, setWsOrder] = useState<string[]>([])
  const [traceData, setTraceData] = useState<CompanyTrace | 'loading' | 'notfound' | 'error'>('loading')
  const [selection, setSelection] = useState<Selection>(null)
  const [zoom, setZoomState] = useState<Zoom>(() => prefs.getZoom() ?? 'year')
  const [editModalId, setEditModalId] = useState<number | null>(null)
  const [icons, setIcons] = useState<Icon[]>([])
  // REQ_FE_051/071 and REQ_DEP_014/015, as on a team roadmap. A trace starts with arrows on (wireframe), unsaved.
  const [copiesPref, setCopiesPref] = useState(() => prefs.getCopiesVisible() ?? true)
  const [depsOn, setDepsOn] = useState(() => (trace ? true : prefs.getDependenciesVisible() ?? false))
  const dupsOn = depsOn ? false : copiesPref

  // Only the answer to the LATEST request is applied: a slow earlier response must not overwrite a newer one.
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const fresh = await fetchCompanyRoadmaps()
      if (seq !== loadSeq.current) return
      setItems(fresh)
      setLoadError(false)
    } catch (err) {
      if (seq !== loadSeq.current) return
      console.error('company.load_failed', { error: String(err) })
      setLoadError(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Side data: nothing here may break the page, so every failure is swallowed (the mocks of other tests may also
  // return nothing at all).
  useEffect(() => {
    void Promise.resolve(fetchIcons()).then((v) => v && setIcons(v)).catch(() => undefined)
    void Promise.resolve(fetchWorkstreamOrder()).then((v) => v && setWsOrder(v)).catch(() => undefined)
  }, [])

  // The trace (REQ_DEP_021/022) is refetched after every edit that can change the chain or the stats line; the same
  // latest-response-wins rule applies. `quiet` keeps what is shown while it refetches (no flash of "Loading").
  const traceSeq = useRef(0)
  const loadTrace = useCallback(
    async (quiet: boolean) => {
      if (!trace || traceId == null) return
      const seq = ++traceSeq.current
      if (!quiet) setTraceData('loading')
      try {
        const t = await fetchCompanyTrace(traceKind, traceId)
        if (seq === traceSeq.current) setTraceData(t)
      } catch (err) {
        if (seq !== traceSeq.current) return
        const { status, message } = apiError(err)
        console.error('company.trace_failed', { id: traceId, kind: traceKind, status })
        // A server without the trace route (an old build) answers "No such endpoint": that is a load failure, not a deleted item.
        if ((status === 400 || status === 404) && message !== 'No such endpoint') setTraceData('notfound')
        else if (!quiet) setTraceData('error')
      }
    },
    [trace, traceId, traceKind],
  )
  useEffect(() => {
    const seq = traceSeq // the counter itself, not a value: bumping it on cleanup is the point
    void loadTrace(false)
    return () => {
      seq.current++ // a response to a trace we left is ignored
    }
  }, [loadTrace])
  const reload = useCallback(async () => {
    await Promise.all([load(), loadTrace(true)])
  }, [load, loadTrace])

  const all = useMemo(() => items ?? [], [items])
  const everyDeliverable = useMemo(() => allDeliverables(all), [all])
  const everyMilestone = useMemo(() => loadedRoadmaps(all).flatMap((r) => r.milestones), [all])
  // Every dependency once: an edge between two teams is listed by both their roadmaps.
  const depCount = useMemo(() => new Set(loadedRoadmaps(all).flatMap((r) => r.dependencies.map((e) => `${edgeEnds(e).from}>${edgeEnds(e).to}`))).size, [all])
  // REQ_FE_093: one axis for the merged rows, derived from every loaded roadmap.
  const grid = useMemo(() => companyGrid(all, localDay(new Date())), [all])
  const axis = useMemo(() => {
    const { min, max } = deriveCompanyRange(all)
    return min === null || max === null ? null : { start: isoOf(min), end: isoOf(max) }
  }, [all])

  const full = useMemo(() => mergeByWorkstreamName(all, wsOrder), [all, wsOrder])
  // REQ_DEP_021/022: the merged view cut down to the traced chain (rows with nothing left collapse). The stats line is
  // the SERVER's trace merged with what is loaded.
  const traceView = useMemo(() => {
    if (!trace || typeof traceData !== 'object') return null
    const { root } = traceData
    const rootName =
      (root.kind === 'milestone' ? findMilestone(all, root.id)?.milestone.name : findDeliverable(all, root.id)?.deliverable.name) ??
      traceData.edges.flatMap((e) => [e.from, e.to]).find((e) => (e.kind ?? 'deliverable') === root.kind && e.id === root.id)?.name ??
      `#${root.id}`
    const chain = upOnly ? { ...traceData, dependents: [] } : traceData
    return { view: applyTrace(full, traceIds(chain)), rootName, ...traceCounts(full, chain) }
  }, [trace, traceData, all, full, upOnly])
  const overview = useMemo(() => (milestonesOnly ? onlyMilestones(full) : full), [full, milestonesOnly])
  // REQ_DEP_036-039: the meeting aids, over what the trace shows.
  const health = useMemo(() => (traceView ? chainHealth(traceView.view, localDay(new Date())) : null), [traceView])
  const aids = useMemo(() => {
    if (!health) return undefined
    const f = focus && health.counts[focus] > 0 ? { items: health.focus[focus], edges: focus === 'tight' ? new Set(health.tight.keys()) : null } : null
    return { flags: health.flags, tight: health.tight, focus: f }
  }, [health, focus])

  // REQ_FE_053: the team of the selected deliverable or milestone (the team-roadmap button's target).
  const selectedHit = selection?.type === 'deliverable' ? findDeliverable(all, selection.id) : null
  // REQ_DEP_028: the trace can start from a selected milestone too.
  const selectedMs = selection?.type === 'milestone' ? findMilestone(all, selection.id) : null
  const selectedTeam = selectedHit?.team ?? selectedMs?.team
  const selectedItem = selectedHit ? { kind: 'deliverable' as const, id: selectedHit.deliverable.id, name: selectedHit.deliverable.name, team: selectedHit.team.name } : selectedMs ? { kind: 'milestone' as const, id: selectedMs.milestone.id, name: selectedMs.milestone.name, team: selectedMs.team.name } : null
  const merged = trace ? traceView?.view : overview

  if (loadError && !(trace && traceId == null)) {
    return (
      <>
        <TopBar variant="company" />
        <main className="p-6 text-danger" role="alert">
          Could not load the company view.
        </main>
      </>
    )
  }
  if (items === null && !(trace && traceId == null))
    return (
      <>
        <TopBar variant="company" />
        <main className="p-6 text-text-2">Loading…</main>
      </>
    )

  // L12: an address with no usable id (`#/company/trace/`, `/abc`, beyond the safe integer range) is not found too.
  if (trace && (traceId == null || traceData === 'notfound')) {
    return (
      <>
      <TopBar variant="company" />
      <main className="p-6" data-testid="trace-notfound">
        <p className="mb-3">That {traceKind} was not found — it may have been deleted.</p>
        <a className="text-accent underline" href="#/company/workstreams">
          Back to the company view
        </a>
      </main>
      </>
    )
  }
  if (trace && traceData === 'error') {
    return (
      <>
      <TopBar variant="company" />
      <main className="p-6" data-testid="trace-error">
        <p className="mb-3 text-danger" role="alert">
          Could not load the dependency trace.
        </p>
        <a className="text-accent underline" href="#/company/workstreams">
          Back to the company view
        </a>
      </main>
      </>
    )
  }
  if (trace && traceView === null)
    return (
      <>
        <TopBar variant="company" />
        <main className="p-6 text-text-2">Loading…</main>
      </>
    )

  // ---- side panel edits go to the real item, and the view updates in place (REQ_FE_096/097) ----
  function updateDeliverable(d: Deliverable) {
    setItems((cur) => (cur ? replaceDeliverable(cur, d) : cur))
    void loadTrace(true) // dates and the like can change what a trace shows (no-op outside a trace)
  }

  function updateMilestone(m: Milestone) {
    setItems((cur) => (cur ? replaceMilestone(cur, m) : cur))
    void loadTrace(true) // a moved milestone can change what a trace shows (no-op outside a trace)
  }

  const owner = selection ? (selection.type === 'deliverable' ? selectedHit?.roadmap : loadedRoadmaps(all).find((r) => r.milestones.some((m) => m.id === selection.id))) : undefined
  const panelRoadmap = owner ?? loadedRoadmaps(all)[0]
  const editHit = editModalId != null ? findDeliverable(all, editModalId) : null

  const timelineProps = {
    zoom,
    dupsOn,
    canEdit,
    icons,
    selected: selection,
    showDependencies: depsOn,
    onSelect: (id: number, type: 'deliverable' | 'milestone') => {
      // REQ_FE_137: with Milestones only, a milestone click opens its chain, the same milestone again closes it
      if (milestonesOnly && type === 'milestone') {
        const close = trace && traceKind === 'milestone' && traceId === id
        console.info('company.milestone_chain', { action: close ? 'close' : 'open', id })
        navigate(close ? '#/company/workstreams?milestones' : `#/company/trace/milestone/${id}?milestones`)
        return
      }
      setSelection({ id, type })
    },
    onEdit: canEdit ? (id: number) => setEditModalId(id) : undefined,
    sharedGrid: grid,
    aids,
  }

  const teamCount = all.length
  return (
    <div className="flex flex-col h-full" data-testid={trace ? 'company-trace' : `company-${mode}`}>
      {/* REQ_FE_102: the one top bar; the trace has no Order button and no copies / dependencies switches. */}
      <TopBar
        variant="company"
        left={
          /* REQ_FE_102: admin only, on the company view (not on the trace) */
          canEdit && !trace && (
            <button
              type="button"
              className="btn ghost"
              title="Order teams and workstreams"
              data-testid="order-button"
              onClick={() => {
                navigate('#/company/order')
              }}
            >
              <ArrowUpDown size={16} aria-hidden="true" />
              <span className="hidden min-[1440px]:inline">Order</span>
            </button>
          )
        }
        right={<Toolbar range={axis} switches={!trace} dupsOn={dupsOn} onDupsChange={setCopiesPref} depsOn={depsOn} onDepsChange={setDepsOn} />}
      />
      <div className="page-head flex items-center gap-4 p-4 flex-wrap">
        <div>
          <div className="eyebrow text-xs text-text-3">Company view</div>
          <h1 className="text-2xl font-semibold">All roadmaps</h1>
        </div>
        <span className="flex-1" />
        <div className="meta flex items-center gap-3 flex-wrap">
          <span className="pill text-xs" data-testid="pill-teams">
            {teamCount} {teamCount === 1 ? 'team' : 'teams'}
          </span>
          <span className="pill text-xs" data-testid="pill-deliverables">
            {everyDeliverable.length} {everyDeliverable.length === 1 ? 'deliverable' : 'deliverables'}
          </span>
          <span className="pill text-xs" data-testid="pill-dependencies">
            {depCount} {depCount === 1 ? 'dependency' : 'dependencies'}
          </span>
          {/* REQ_FE_043: counted over every team, on every company view, and by the live data so edits show at once. */}
          <StatusPills deliverables={everyDeliverable} milestones={everyMilestone} />
          <StatusLegend />
        </div>
      </div>

      {trace && traceView && (
        <div className="trace-banner flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-2 flex-wrap" data-testid="trace-banner">
          <span data-testid="trace-title">
            Tracing dependencies for: <b>{traceView.rootName}</b>
          </span>
          <span className="text-text-2 text-sm" data-testid="trace-stats">
            {upOnly
              ? `${traceView.prerequisites} prerequisites · ${traceView.hidden} other items hidden`
              : `${traceView.prerequisites} prerequisites · ${traceView.dependents} dependents · ${traceView.hidden} unrelated items hidden`}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="btn primary border border-accent rounded px-3 py-1 text-sm bg-accent text-accent-text"
            data-testid="trace-show-all"
            onClick={() => {
              navigate(`#/company/workstreams${msQuery}`)
            }}
          >
            Show all roadmap items
          </button>
          {health && (
            /* REQ_DEP_036: the health line; a count above zero highlights its items */
            <div className="basis-full flex flex-wrap gap-1.5" data-testid="trace-health">
              {HEALTH.map((h) => {
                const n = health.counts[h.kind]
                return (
                  <button key={h.kind} type="button" className={`health-chip${focus === h.kind && n ? ' on' : ''}`} data-testid={`health-${h.kind}`} aria-pressed={focus === h.kind && n > 0} disabled={n === 0}
                    onClick={() => setFocus((f) => (f === h.kind ? null : h.kind))}>
                    {n} {n === 1 ? h.one : h.many}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}


      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <ZoomRow zoom={zoom} onZoomChange={setZoomState}>
          {/* REQ_FE_053: no button until a deliverable or milestone is selected; it leads to that team's roadmap */}
          {mode !== 'trace' && selectedTeam && selectedItem && (
            <button
              type="button"
              className="btn sm team-roadmap"
              data-testid="team-roadmap"
              onClick={() => {
                navigate(`#/teams/${selectedTeam.id}`)
              }}
            >
              {`Show only team "${selectedTeam.name}" roadmap`}
            </button>
          )}
          {/* REQ_DEP_021/028: "Trace dependencies" for the selected roadmap item, right of the team-roadmap button */}
          {mode !== 'trace' && selectedItem && (
            <button
              type="button"
              className="btn sm trace-btn"
              data-testid="trace-btn"
              onClick={() => navigate(`#/company/trace/${selectedItem.kind}/${selectedItem.id}`)}
            >
              Trace dependencies
            </button>
          )}
          {/* REQ_FE_136: the Milestones only switch, in the address; wrapped so the buttons above keep the row's left end */}
          {!trace && (
            <MilestonesSwitch
              on={milestonesOnly}
              onToggle={() => {
                console.info('company.milestones_only', { on: !milestonesOnly })
                // a deliverable is about to disappear, and a milestone click opens its chain from now on: no selection, so no
                // team-roadmap or Trace dependencies button either (REQ_FE_137)
                if (!milestonesOnly) setSelection(null)
                navigate(milestonesOnly ? '#/company/workstreams' : '#/company/workstreams?milestones')
              }}
            />
          )}
        </ZoomRow>
        <div className="flex-1 min-w-0 overflow-auto" data-testid="company-body">
          {all.length === 0 && <p className="p-4 text-text-2">No teams yet.</p>}

          {merged && <Timeline roadmap={merged.roadmap} merged={merged} teamTags={merged.tags} {...timelineProps} />}
        </div>
        </div>
        {panelRoadmap && (
          <SidePanel
            roadmap={panelRoadmap}
            selection={selection}
            icons={icons}
            onClose={() => setSelection(null)}
            empty={health && traceView ? <AccountableList health={health} rootKey={typeof traceData === 'object' ? itemKey(traceData.root.kind, traceData.root.id) : ''} onPick={(kind, id) => setSelection({ id, type: kind })} /> : undefined}
            onBack={trace ? () => setSelection(null) : undefined}
            onDeliverableUpdated={updateDeliverable}
            onOpenFullEdit={(id) => setEditModalId(id)}
            onDependenciesChanged={() => void reload()}
            onMilestoneUpdated={updateMilestone}
            onMilestoneMoved={() => {
              // the milestone now belongs to another team's roadmap: reload so it is drawn there
              setSelection(null)
              void reload()
            }}
            onMilestoneDeleted={() => {
              // the milestone and its dependency edges are gone on the server (REQ_DEP_029)
              setSelection(null)
              void reload()
            }}
          />
        )}
      </div>

      {editHit && (
        <EditModal
          deliverable={editHit.deliverable}
          roadmap={editHit.roadmap}
          icons={icons}
          onClose={() => setEditModalId(null)}
          onSaved={updateDeliverable}
          onDependenciesChanged={() => void reload()}
        />
      )}
    </div>
  )
}
