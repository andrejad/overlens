import { trimName } from '../lib/ui'
import { useState } from 'react'
import { X } from 'lucide-react'
import { fgOf } from '../lib/contrast'
import { createDeliverable } from '../api/resources'
import type { Deliverable, RoadmapFull } from '../api/types'
import { CAP_MESSAGE, dayOf, exceedsCap } from '../timeline/axis'
import { refusalMessage } from '../lib/apiError'
import { Dialog } from './Dialog'

// REQ_FE_028: creating a deliverable is explicit — one "Create deliverable" button that saves
// everything at once, never autosave. REQ_FE_029: starts with the team's default color, with a
// "Reset to team color" action.

// M4 (review finding): the 3-year cap is checked here before a new deliverable's dates are sent, not just relayed
// from the server's 409 (axis.ts exceedsCap).
export function CreateDeliverableDialog({
  roadmap,
  onClose,
  onCreated,
}: {
  roadmap: RoadmapFull
  onClose: () => void
  onCreated: (d: Deliverable) => void
}) {
  const defaultWorkstream = roadmap.workstreams[0]?.id
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [color, setColor] = useState(roadmap.team.default_color)
  const [workstreamId, setWorkstreamId] = useState<number | undefined>(defaultWorkstream)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleCreate() {
    if (!trimName(name)) {
      setError('A title is required')
      return
    }
    if (!start || !end || end < start) {
      setError('Enter a valid start and end date')
      return
    }
    if (!workstreamId) {
      setError('Choose a workstream')
      return
    }
    if (exceedsCap(roadmap, dayOf(start), dayOf(end))) {
      setError(CAP_MESSAGE)
      return
    }
    setSaving(true)
    setError('')
    try {
      const created = await createDeliverable(roadmap.id, {
        name: trimName(name),
        start_date: start,
        end_date: end,
        color,
        workstream_ids: [workstreamId],
      })
      onCreated(created)
      onClose()
    } catch (err) {
      setError(refusalMessage(err) ?? 'Could not create the deliverable')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog label="Create deliverable" onClose={onClose} initialFocus="#nd-name" className="w-[480px] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-lg">New deliverable</h2>
        <button type="button" className="btn icon ghost sm" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-col gap-3">
        <div className="field">
          <label htmlFor="nd-name" className="text-xs font-medium text-text-2">
            Title
          </label>
          <input id="nd-name" className="inp w-full border border-border rounded px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex gap-3">
          <div className="field flex-1">
            <label htmlFor="nd-start" className="text-xs font-medium text-text-2">
              Start date
            </label>
            <input id="nd-start" type="date" className="inp w-full border border-border rounded px-2 py-1" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="field flex-1">
            <label htmlFor="nd-end" className="text-xs font-medium text-text-2">
              End date
            </label>
            <input id="nd-end" type="date" className="inp w-full border border-border rounded px-2 py-1" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="nd-ws" className="text-xs font-medium text-text-2">
            Workstream
          </label>
          <select
            id="nd-ws"
            className="inp w-full border border-border rounded px-2 py-1"
            value={workstreamId}
            onChange={(e) => setWorkstreamId(Number(e.target.value))}
          >
            {roadmap.workstreams.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nd-color" className="text-xs font-medium text-text-2">
            Deliverable color
          </label>
          <div className="flex items-center gap-2">
            <input id="nd-color" className="inp mono border border-border rounded px-2 py-1 w-28" value={color} onChange={(e) => setColor(e.target.value)} />
            <span className="px-2 py-1 rounded text-xs" style={{ background: color, color: fgOf(color) }}>
              {name || 'Deliverable'}
            </span>
            <button type="button" className="btn ghost text-xs underline" onClick={() => setColor(roadmap.team.default_color)}>
              Reset to team color
            </button>
          </div>
        </div>
        {error && (
          <div className="hint bad text-danger text-xs" role="alert">
            {error}
          </div>
        )}
        <div className="form-foot flex justify-end">
          <button type="button" className="btn primary" disabled={saving} onClick={handleCreate}>
            Create deliverable
          </button>
        </div>
      </div>
    </Dialog>
  )
}
