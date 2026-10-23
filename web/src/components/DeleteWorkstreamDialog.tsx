import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import type { Workstream } from '../api/types'
import { Dialog } from './Dialog'

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// REQ_FE_109: the delete dialog of the Manage workstreams page. Delete only ever moves the content (REQ_API_025), so a
// non-empty workstream needs a target the user picks (none preselected); an empty one gets a plain confirmation.
export function DeleteWorkstreamDialog({
  workstream,
  others,
  deliverables,
  milestones,
  alreadyIn,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  workstream: Workstream
  others: Workstream[]
  deliverables: number
  milestones: number
  alreadyIn: (targetId: number) => number // deliverables of this workstream that are already in the given workstream
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: (target: Workstream | null) => void
}) {
  const [targetId, setTargetId] = useState('')
  const holds = deliverables + milestones > 0
  const target = others.find((w) => String(w.id) === targetId) ?? null
  const lost = target ? alreadyIn(target.id) : 0 // REQ_FE_109: the server drops only the memberships that duplicate the target's

  // "Move N deliverables" per REQ_FE_109; a workstream holding only milestones names them instead of "0 deliverables".
  const moved = deliverables > 0 ? plural(deliverables, 'deliverable', 'deliverables') : plural(milestones, 'milestone', 'milestones')
  return (
    <Dialog label={`Delete "${workstream.name}"?`} onClose={onCancel} className="w-[460px] max-w-full p-4 flex flex-col gap-3" testId="delete-workstream-dialog">
      <div className="flex items-center gap-2">
        <span className="text-danger">
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <h2 className="font-semibold text-lg flex-1">Delete "{workstream.name}"?</h2>
        <button type="button" className="btn icon ghost sm" aria-label="Close" onClick={onCancel}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {holds ? (
        <>
          <p className="text-text-2" data-testid="delete-ws-counts">
            This workstream contains <b className="text-text">{plural(deliverables, 'deliverable', 'deliverables')}</b> and{' '}
            <b className="text-text">{plural(milestones, 'milestone', 'milestones')}</b>. Choose where they go — nothing is deleted until you confirm.
          </p>
          <div className="field">
            <label htmlFor="del-ws-target" className="font-semibold text-text normal-case tracking-normal text-sm">
              Move them to another workstream
            </label>
            <select id="del-ws-target" className="inp" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">Choose a workstream…</option>
              {others.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {target && lost > 0 && (
              <p className="hint" data-testid="delete-ws-shared">
                {plural(lost, 'deliverable', 'deliverables')} already in {target.name} simply {lost === 1 ? 'loses' : 'lose'} this membership.
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="text-text-2">This workstream is empty, so nothing needs to move.</p>
      )}
      {error && (
        <div className="hint bad" role="alert">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="delete-ws-confirm"
          disabled={busy || (holds && !target)}
          onClick={() => onConfirm(holds ? target : null)}
        >
          {holds ? `Move ${moved} & delete workstream` : 'Delete workstream'}
        </button>
      </div>
    </Dialog>
  )
}
