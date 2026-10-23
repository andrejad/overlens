import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { TopBar } from '../components/AppChrome'
import { Toolbar } from '../components/Toolbar'
import { DeleteWorkstreamDialog, plural } from '../components/DeleteWorkstreamDialog'
import { OrderList } from '../components/OrderList'
import { useCanEdit } from '../lib/canEdit'
import { apiError, sessionRefusal } from '../lib/apiError'
import { trimName } from '../lib/ui'
import { createWorkstream, deleteWorkstream, fetchRoadmap, fetchTeam, renameWorkstream, reorderWorkstreams } from '../api/resources'
import type { RoadmapFull, Workstream } from '../api/types'

const LAST_TIP = 'Last workstream — a roadmap needs at least one'
const CHANGED_ELSEWHERE = 'Workstreams changed elsewhere — order not saved, please retry'

const byPosition = (ws: Workstream[]) => [...ws].sort((a, b) => a.position - b.position)

// REQ_FE_105-109: the Manage workstreams page, "#/teams/:id/workstreams" (the team's one roadmap, REQ_DAT_032). Adding,
// renaming, reordering (pointer drag or arrow keys on the grip) and deleting workstreams; every change saves at once.
export function ManageWorkstreamsPage({ teamId }: { teamId: number }) {
  const canEdit = useCanEdit()
  const [roadmap, setRoadmap] = useState<RoadmapFull | null>(null)
  const roadmapId = roadmap?.id ?? 0 // every action below runs only once the roadmap is shown
  const [list, setList] = useState<Workstream[]>([])
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState('') // reorder errors
  const [notice, setNotice] = useState('')
  const savingRef = useRef(false)

  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameError, setRenameError] = useState('')
  const renameBusy = useRef(false)
  const renameCancelled = useRef(false)

  const [newName, setNewName] = useState('')
  const [addError, setAddError] = useState('')
  const addBusy = useRef(false)

  const [deleting, setDeleting] = useState<Workstream | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  function show(r: RoadmapFull) {
    setRoadmap(r)
    setList(byPosition(r.workstreams))
  }

  async function reload() {
    try {
      show(await fetchRoadmap(roadmapId))
    } catch {
      // keep what is shown; the next action reports its own error
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchTeam(teamId)
      .then((t) => fetchRoadmap(t.roadmap_id))
      .then(
        (r) => !cancelled && show(r),
        () => !cancelled && setLoadError('That team was not found.'),
      )
    return () => {
      cancelled = true
    }
  }, [teamId])

  if (loadError) {
    return (
      <>
        <TopBar />
        <main className="p-6">
          <p className="mb-3 text-danger" role="alert">
            {loadError}
          </p>
          <a className="text-accent underline" href={`#/teams/${teamId}`}>
            Back to the roadmap
          </a>
        </main>
      </>
    )
  }
  if (!roadmap) {
    return (
      <>
        <TopBar variant="team" teamName="…" />
        <main className="p-6 text-text-2">Loading…</main>
      </>
    )
  }

  const counts = (ws: Workstream) => ({
    deliverables: roadmap.deliverables.filter((d) => d.workstream_ids.includes(ws.id)).length,
    milestones: roadmap.milestones.filter((m) => m.workstream_id === ws.id).length,
  })

  // ---- reorder (REQ_FE_106, REQ_FE_107) ----
  async function saveOrder(ids: number[]) {
    if (savingRef.current) {
      return
    }
    const before = list
    savingRef.current = true
    setMessage('')
    setList(ids.map((id, i) => ({ ...before.find((w) => w.id === id)!, position: i })))
    try {
      const saved = await reorderWorkstreams(roadmapId, ids)
      // rows added while the save ran stay (the answer only covers the rows it was sent)
      setList((l) => [...byPosition(saved), ...l.filter((w) => !saved.some((s) => s.id === w.id))])
    } catch (err) {
      const e = apiError(err)
      console.error('workstream.reorder_failed', { roadmap_id: roadmapId, status: e.status, code: e.code })
      if (e.status === 422) {
        await reload()
        setMessage(CHANGED_ELSEWHERE)
      } else {
        setList((l) => [...before, ...l.filter((w) => !before.some((b) => b.id === w.id))])
        setMessage(sessionRefusal(err) || e.message || 'Could not save the order')
      }
    } finally {
      savingRef.current = false
    }
  }

  function onMove(from: number, to: number) {
    const ids = list.map((w) => w.id)
    ids.splice(to, 0, ids.splice(from, 1)[0])
    void saveOrder(ids)
  }

  // ---- rename (REQ_FE_108) ----
  function startRename(ws: Workstream) {
    renameCancelled.current = false
    setRenamingId(ws.id)
    setRenameValue(ws.name)
    setRenameError('')
  }

  async function commitRename(ws: Workstream) {
    if (renameCancelled.current || renameBusy.current) return
    const name = trimName(renameValue)
    if (name === ws.name) {
      setRenamingId(null)
      return
    }
    renameBusy.current = true
    setRenameError('')
    try {
      const updated = await renameWorkstream(ws.id, name)
      setList((l) => l.map((w) => (w.id === ws.id ? { ...w, name: updated.name } : w)))
      setRenamingId(null)
    } catch (err) {
      const e = apiError(err)
      console.error('workstream.rename_failed', { id: ws.id, status: e.status, code: e.code })
      setRenameError(sessionRefusal(err) || e.message || 'Could not rename the workstream')
    } finally {
      renameBusy.current = false
    }
  }

  // ---- add (REQ_FE_108) ----
  async function add() {
    if (addBusy.current) return
    addBusy.current = true
    setAddError('')
    try {
      const created = await createWorkstream(roadmapId, trimName(newName))
      setList((l) => [...l, created])
      setNewName('')
    } catch (err) {
      const e = apiError(err)
      console.error('workstream.create_failed', { roadmap_id: roadmapId, status: e.status, code: e.code })
      setAddError(e.message || 'Could not add the workstream')
    } finally {
      addBusy.current = false
    }
  }

  // ---- delete (REQ_FE_109) ----
  async function confirmDelete(ws: Workstream, target: Workstream | null) {
    setDeleteBusy(true)
    setDeleteError('')
    const c = counts(ws)
    try {
      await deleteWorkstream(ws.id, target?.id)
      setDeleting(null)
      await reload() // the delete moved deliverables and milestones too
      setNotice(target ? `Deleted ${ws.name}; ${plural(c.deliverables + c.milestones, 'item', 'items')} moved to ${target.name}` : `Deleted ${ws.name}`)
    } catch (err) {
      const e = apiError(err)
      console.error('workstream.delete_failed', { id: ws.id, status: e.status, code: e.code })
      setDeleteError(e.message || 'Could not delete the workstream')
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <>
      {/* REQ_FE_101: a secondary page carries the team bar without the add buttons and the switches */}
      <TopBar
        variant="team"
        teamName={roadmap.team.name}
        right={<Toolbar roadmap={roadmap} switches={false} />}
      />
      <main className="p-6 flex flex-col gap-4 max-w-[1100px]" data-testid="manage-workstreams">
        <div>
          <div className="text-xs text-text-3">Team roadmap · {roadmap.team.name}</div>
          <h1 className="text-2xl font-semibold">Manage workstreams</h1>
          <a className="text-accent underline text-sm" href={`#/teams/${teamId}`} data-testid="back-to-roadmap">
            Back to the roadmap
          </a>
        </div>
        {notice && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-surface-2 text-sm" role="status" data-testid="ws-notice">
            <span className="flex-1">{notice}</span>
            <button type="button" className="btn sm ghost" onClick={() => setNotice('')}>
              Dismiss
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">
          <section className="border border-border rounded-lg bg-surface" data-testid="ws-list-card">
            <header className="px-4 pt-3 pb-2 border-b border-border">
              <h2 className="font-semibold text-lg">Workstreams</h2>
              <p className="text-sm text-text-2">Drag to reorder, click the pencil to rename. Order is top-to-bottom on the roadmap.</p>
            </header>
            <div className="p-4">
              {message && (
                <div className="hint bad mb-2" role="alert" data-testid="ws-message">
                  {message}
                </div>
              )}
              <OrderList
                items={list}
                getKey={(ws) => ws.id}
                label={(ws) => ws.name}
                canEdit={canEdit}
                onMove={onMove}
                renderMain={(ws) => {
                  const c = counts(ws)
                  return (
                    <>
                      {renamingId === ws.id ? (
                        <div className="nm">
                          <input
                            autoFocus
                            className={`inp${renameError ? ' bad' : ''}`}
                            aria-label={`Name of ${ws.name}`}
                            data-testid="ws-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => void commitRename(ws)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitRename(ws)
                              if (e.key === 'Escape') {
                                renameCancelled.current = true
                                setRenamingId(null)
                                setRenameError('')
                              }
                            }}
                          />
                          {renameError && (
                            <div className="hint bad font-normal" role="alert">
                              {renameError}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="nm" title={ws.name}>
                          {ws.name}
                        </span>
                      )}
                      <span className="ct">
                        {plural(c.deliverables, 'deliverable', 'deliverables')} · {plural(c.milestones, 'milestone', 'milestones')}
                      </span>
                    </>
                  )
                }}
                renderActions={(ws) => {
                  const last = list.length === 1
                  return (
                    canEdit && (
                      <>
                        <button type="button" className="btn icon ghost sm" aria-label={`Rename ${ws.name}`} title="Rename" data-testid="ws-rename" onClick={() => startRename(ws)}>
                          <Pencil size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="btn icon ghost sm"
                          aria-label={`Delete ${ws.name}`}
                          title={last ? LAST_TIP : 'Delete'}
                          aria-describedby={last ? `ws-last-${ws.id}` : undefined}
                          disabled={last}
                          data-testid="ws-delete"
                          onClick={() => {
                            setDeleteError('')
                            setDeleting(ws)
                          }}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                        {last && (
                          <span id={`ws-last-${ws.id}`} className="sr-only">
                            {LAST_TIP}
                          </span>
                        )}
                      </>
                    )
                  )
                }}
              />
              {canEdit && (
                <div className="mt-3">
                  <div className="flex items-center gap-2">
                    <span className="text-text-3">
                      <Plus size={18} aria-hidden="true" />
                    </span>
                    <input
                      className={`inp${addError ? ' bad' : ''}`}
                      placeholder="Add a workstream…"
                      aria-label="New workstream name"
                      data-testid="ws-add-input"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && void add()}
                    />
                    <button type="button" className="btn sm" data-testid="ws-add" onClick={() => void add()}>
                      Add
                    </button>
                  </div>
                  {addError && (
                    <div className="hint bad" role="alert" data-testid="ws-add-error">
                      {addError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
          <section className="border border-border rounded-lg bg-surface p-4" data-testid="ws-good-to-know">
            <div className="lab">Good to know</div>
            <div className="rich text-text-2" style={{ fontSize: 13 }}>
              <p>
                <b className="text-text">Primary workstream is derived.</b> A deliverable in several workstreams renders solid in the topmost one. Reordering can change which copy is solid — that is expected.
              </p>
              <p style={{ margin: 0 }}>Workstreams with the same name in other teams merge in the company view.</p>
            </div>
          </section>
        </div>
      </main>
      {deleting && (
        <DeleteWorkstreamDialog
          workstream={deleting}
          others={list.filter((w) => w.id !== deleting.id)}
          deliverables={counts(deleting).deliverables}
          milestones={counts(deleting).milestones}
          alreadyIn={(tid) => roadmap.deliverables.filter((d) => d.workstream_ids.includes(deleting.id) && d.workstream_ids.includes(tid)).length}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={(target) => void confirmDelete(deleting, target)}
        />
      )}
    </>
  )
}
