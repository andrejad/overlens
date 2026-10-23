import { useEffect, useState } from 'react'
import * as prefs from '../lib/prefs'
import type { Zoom } from '../lib/prefs'
import { useCanEdit } from '../lib/canEdit'
import { navigate } from '../lib/router'
import { addDependencyError } from '../lib/depErrors'
import { apiError } from '../lib/apiError'
import {
  addDependency,
  fetchIcons,
  fetchRoadmap,
  fetchTeam,
  patchDeliverable,
  patchMilestone,
  removeDependency,
} from '../api/resources'
import type { Deliverable, DeliverablePatch, Icon, ItemRef, Milestone, MilestonePatch, RoadmapFull } from '../api/types'
import { withItemDates } from '../lib/companyView'
import { TopBar } from '../components/AppChrome'
import { AddButtons, DownloadCsvButton, Toolbar, ZoomRow } from '../components/Toolbar'
import { Timeline } from '../timeline/Timeline'
import { SidePanel, type Selection } from '../components/SidePanel'
import { EditModal } from '../components/EditModal'
import { CreateDeliverableDialog } from '../components/CreateDeliverableDialog'
import { CreateMilestoneDialog } from '../components/CreateMilestoneDialog'
import { StatusPills, StatusLegend } from '../components/StatusPills'
import { RoadmapTitle } from '../components/RoadmapTitle'

// "#/teams/<id>" shows the team's one roadmap (REQ_DAT_032), found through team.roadmap_id.
export function TeamRoadmapPage({ teamId }: { teamId: number }) {
  const canEdit = useCanEdit()
  const [activeId, setActiveId] = useState<number | undefined>()
  const [roadmap, setRoadmap] = useState<RoadmapFull | null>(null)
  const [teamError, setTeamError] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  const [zoom, setZoomState] = useState<Zoom>(() => prefs.getZoom() ?? 'year')
  const [editModalId, setEditModalId] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createMilestoneOpen, setCreateMilestoneOpen] = useState(false)
  // REQ_FE_051/071: real, user-flippable state — Toolbar's switch calls setDupsOn, Timeline reads it
  // to drive packing. Starts from the persisted preference, defaulting to shown (the wireframes'
  // default) the first time this browser ever visits.
  // REQ_DEP_014/015: the user's own copies setting is kept untouched while dependencies are on;
  // what Timeline gets is forced off then and falls back to this the moment arrows go off.
  const [copiesPref, setCopiesPref] = useState(() => prefs.getCopiesVisible() ?? true)
  const [depsOn, setDepsOn] = useState(() => prefs.getDependenciesVisible() ?? false)
  const dupsOn = depsOn ? false : copiesPref
  // REQ_DEP_003: shown when a connect-mode/picker add is refused, e.g. with the loop it would form.
  const [depMessage, setDepMessage] = useState('')
  const [icons, setIcons] = useState<Icon[]>([])

  // Phase 4 (REQ_FE_080): fetched once, independent of which roadmap is active — icon labels are
  // global, not roadmap-scoped (docs/API.md's Icons section). Defensively tolerates a mocked/absent
  // fetchIcons in tests that don't care about icons (it simply never resolves to an array, so the
  // picker keeps falling back to lib/icons.ts's hardcoded defaults).
  useEffect(() => {
    let cancelled = false
    void Promise.resolve(fetchIcons())
      .then((items) => {
        if (!cancelled && items) setIcons(items)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setTeamError('')
    void fetchTeam(teamId)
      .then((team) => {
        if (!cancelled) setActiveId(team.roadmap_id)
      })
      .catch((err) => {
        if (!cancelled) setTeamError(apiError(err).status === 404 ? 'That team was not found.' : 'Could not load the team.')
      })
    return () => {
      cancelled = true
    }
  }, [teamId])

  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    void fetchRoadmap(activeId)
      .then((r) => {
        if (!cancelled) setRoadmap(r)
      })
      .catch((err) => {
        console.error('roadmap.load_failed', { id: activeId, error: String(err) })
        if (!cancelled) setTeamError('Could not load the roadmap.')
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // A deliverable that left this roadmap (moved away) must not stay selected or keep the full edit window open.
  useEffect(() => {
    if (!roadmap) return
    const here = (id: number) => roadmap.deliverables.some((d) => d.id === id)
    if (editModalId != null && !here(editModalId)) setEditModalId(null)
    if (selection?.type === 'deliverable' && !here(selection.id)) setSelection(null)
  }, [roadmap, editModalId, selection])

  if (!roadmap) {
    return (
      <>
        <TopBar variant="team" teamName="…" />
        <main className="p-6 text-text-2">{teamError || 'Loading…'}</main>
      </>
    )
  }

  // Full re-fetch after anything that changes more than one item server-side (a workstream delete that relocates
  // items, a deliverable moved away, a dependency change), so ids, rows and arrows match what the server holds.
  async function refetchRoadmap() {
    const fresh = await fetchRoadmap(roadmap!.id)
    setRoadmap(fresh)
  }

  // Phase 5: Timeline's connect mode / delete-arrow call these; the server stays the judge, and the
  // roadmap is refetched after so arrows and dates reflect what it stored.
  async function createDependency(from: ItemRef, to: ItemRef) {
    setDepMessage('')
    try {
      await addDependency(to, from)
    } catch (err) {
      const message = addDependencyError(err)
      setDepMessage(message)
    }
    await refetchRoadmap()
  }

  async function deleteDependency(from: ItemRef, to: ItemRef) {
    setDepMessage('')
    const names = { from: from.id, from_kind: from.kind, to: to.id, to_kind: to.kind }
    try {
      await removeDependency(to, from)
    } catch (err) {
      console.error('dependency.delete_failed', { ...names, error: String(err) })
      setDepMessage('Could not remove the dependency')
    }
    await refetchRoadmap()
  }

  function updateDeliverable(d: Deliverable) {
    // Each edge embeds both ends' dates, and the timeline's drag limits read them — keep them in step.
    setRoadmap((r) =>
      r
        ? {
            ...r,
            deliverables: r.deliverables.map((x) => (x.id === d.id ? d : x)),
            dependencies: withItemDates(r.dependencies, 'deliverable', d.id, d.start_date, d.end_date),
          }
        : r,
    )
  }

  function addDeliverable(d: Deliverable) {
    setRoadmap((r) => (r ? { ...r, deliverables: [...r.deliverables, d] } : r))
  }

  function updateMilestone(m: Milestone) {
    // the edges embed the milestone's date, and the drag limits read it (REQ_DEP_026)
    setRoadmap((r) => (r ? { ...r, milestones: r.milestones.map((x) => (x.id === m.id ? m : x)), dependencies: withItemDates(r.dependencies, 'milestone', m.id, m.date, m.date) } : r))
  }

  function addMilestone(m: Milestone) {
    setRoadmap((r) => (r ? { ...r, milestones: [...r.milestones, m] } : r))
  }

  // Phase 4 (REQ_FE_090): fires after SidePanel's confirmed delete — drop it from local state and,
  // if it was the open selection, close the panel (the thing it was showing no longer exists).
  function removeMilestone(id: number) {
    setRoadmap((r) => (r ? { ...r, milestones: r.milestones.filter((m) => m.id !== id) } : r))
    setSelection((s) => (s && s.type === 'milestone' && s.id === id ? null : s))
    // the server removed the milestone's dependency edges too; refetch so the drag limits, the pill count and the arrows drop them (REQ_DEP_029)
    void refetchRoadmap()
  }

  // A finished drag (resize/move); the dragged bar stays where it was dropped until this settles, then the roadmap is
  // updated in place. A refusal (e.g. 409 row_overlap, REQ_API_051) is rethrown for the timeline to show.
  async function savePatchedDeliverable(id: number, patch: DeliverablePatch) {
    const updated = await patchDeliverable(id, patch as Record<string, unknown>)
    updateDeliverable(updated)
  }

  async function savePatchedMilestone(id: number, patch: MilestonePatch) {
    const updated = await patchMilestone(id, patch as Record<string, unknown>)
    updateMilestone(updated)
  }

  const editModalDeliverable = editModalId != null ? roadmap.deliverables.find((d) => d.id === editModalId) : undefined

  return (
    <div className="flex flex-col h-full">
      {/* REQ_FE_101: the one top bar; REQ_FE_006/101: Workstream, Deliverable, Milestone. */}
      <TopBar
        variant="team"
        teamName={roadmap.team.name}
        left={
          <>
            <AddButtons
              onAddWorkstream={() => {
                navigate(`#/teams/${teamId}/workstreams`)
              }}
              onAddDeliverable={() => setCreateOpen(true)}
              onAddMilestone={() => setCreateMilestoneOpen(true)}
            />
          </>
        }
        right={
          <>
            <Toolbar roadmap={roadmap} dupsOn={dupsOn} onDupsChange={setCopiesPref} depsOn={depsOn} onDepsChange={setDepsOn} />
            <DownloadCsvButton roadmapId={roadmap.id} />
          </>
        }
      />
      <div className="page-head flex items-center gap-4 p-4 flex-wrap">
        <RoadmapTitle roadmap={roadmap} onRenamed={(r) => setRoadmap({ ...roadmap, ...r })} />
        <span className="flex-1" />
        <div className="meta flex items-center gap-3">
          <StatusPills deliverables={roadmap.deliverables} milestones={roadmap.milestones} />
          <StatusLegend />
        </div>
      </div>


      {depMessage && (
        <div className="flex items-center gap-2 px-4 py-2 text-sm text-danger border-b border-danger bg-danger-soft" role="alert">
          <span className="flex-1">{depMessage}</span>
          <button type="button" className="btn icon ghost sm" aria-label="Dismiss" onClick={() => setDepMessage('')}>
            ×
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <ZoomRow zoom={zoom} onZoomChange={setZoomState} />
        <Timeline
          roadmap={roadmap}
          // Read-only visitors get arrows but no connect callbacks (REQ_DEP_020).
          showDependencies={depsOn}
          onCreateDependency={canEdit ? createDependency : undefined}
          onDeleteDependency={canEdit ? deleteDependency : undefined}
          zoom={zoom}
          dupsOn={dupsOn}
          canEdit={canEdit}
          icons={icons}
          selected={selection}
          onSelect={(id, type) => {
            setSelection({ id, type })
          }}
          onEdit={(id) => setEditModalId(id)}
          onPatchDeliverable={savePatchedDeliverable}
          onPatchMilestone={savePatchedMilestone}
        />
        </div>
        <SidePanel
          roadmap={roadmap}
          selection={selection}
          icons={icons}
          onClose={() => setSelection(null)}
          onDeliverableUpdated={updateDeliverable}
          onOpenFullEdit={(id) => setEditModalId(id)}
          onMilestoneDeleted={removeMilestone}
          onMilestoneUpdated={updateMilestone}
          onMilestoneMoved={(m) => removeMilestone(m.id)}
          onDependenciesChanged={() => void refetchRoadmap()}
        />
      </div>

      {editModalDeliverable && (
        <EditModal
          deliverable={editModalDeliverable}
          roadmap={roadmap}
          icons={icons}
          onClose={() => setEditModalId(null)}
          onSaved={updateDeliverable}
          onDependenciesChanged={() => void refetchRoadmap()}
        />
      )}
      {createOpen && (
        <CreateDeliverableDialog
          roadmap={roadmap}
          onClose={() => setCreateOpen(false)}
          onCreated={addDeliverable}
        />
      )}
      {createMilestoneOpen && (
        <CreateMilestoneDialog
          roadmap={roadmap}
          onClose={() => setCreateMilestoneOpen(false)}
          onCreated={addMilestone}
        />
      )}
    </div>
  )
}
