import { trimName } from '../lib/ui'
import { useState } from 'react'
import { X } from 'lucide-react'
import { createMilestone } from '../api/resources'
import type { Milestone, RoadmapFull } from '../api/types'
import { CAP_MESSAGE, dayOf, exceedsCap } from '../timeline/axis'
import { refusalMessage } from '../lib/apiError'
import { Dialog } from './Dialog'

// Mirrors CreateDeliverableDialog.tsx: Name/Date/Workstream, one explicit "Create milestone" button
// (not autosave — matches the approved wireframe's `milestone-new.html` "Nothing is saved until you
// create the milestone"). REQ_FE_090.

// The same 3-year-cap pre-check as a new deliverable's (M4, REQ_FE_062), for a milestone's single day.
export function CreateMilestoneDialog({
  roadmap,
  onClose,
  onCreated,
}: {
  roadmap: RoadmapFull
  onClose: () => void
  onCreated: (m: Milestone) => void
}) {
  const defaultWorkstream = roadmap.workstreams[0]?.id
  const [name, setName] = useState('')
  const [date, setDate] = useState('')
  const [workstreamId, setWorkstreamId] = useState<number | undefined>(defaultWorkstream)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleCreate() {
    if (!trimName(name)) {
      setError('A name is required')
      return
    }
    if (!date) {
      setError('Choose a date')
      return
    }
    if (!workstreamId) {
      setError('Choose a workstream')
      return
    }
    if (exceedsCap(roadmap, dayOf(date), dayOf(date))) {
      setError(CAP_MESSAGE)
      return
    }
    setSaving(true)
    setError('')
    try {
      const created = await createMilestone(roadmap.id, {
        name: trimName(name),
        date,
        workstream_id: workstreamId,
      })
      onCreated(created)
      onClose()
    } catch (err) {
      setError(refusalMessage(err) ?? 'Could not create the milestone')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog label="Create milestone" onClose={onClose} initialFocus="#nm-name" className="w-[420px] p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-lg">New milestone</h2>
        <button type="button" className="btn icon ghost sm" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-col gap-3">
        <div className="field">
          <label htmlFor="nm-name" className="text-xs font-medium text-text-2">
            Name
          </label>
          <input
            id="nm-name"
            className="inp w-full border border-border rounded px-2 py-1"
            placeholder="e.g. Beta launch"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="field flex-1">
            <label htmlFor="nm-date" className="text-xs font-medium text-text-2">
              Date
            </label>
            <input
              id="nm-date"
              type="date"
              className="inp w-full border border-border rounded px-2 py-1"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field flex-1">
            <label htmlFor="nm-ws" className="text-xs font-medium text-text-2">
              Workstream
            </label>
            <select
              id="nm-ws"
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
        </div>
        <div className="hint text-text-3 text-xs">
          A milestone is a single date, shown as a red diamond. It can be placed in any workstream
          and moved later by dragging.
        </div>
        {error && (
          <div className="hint bad text-danger text-xs" role="alert">
            {error}
          </div>
        )}
        <div className="form-foot flex justify-between items-center">
          <span className="hint text-text-3 text-xs">Nothing is saved until you create the milestone.</span>
          <button type="button" className="btn primary" disabled={saving} onClick={handleCreate}>
            Create milestone
          </button>
        </div>
      </div>
    </Dialog>
  )
}
