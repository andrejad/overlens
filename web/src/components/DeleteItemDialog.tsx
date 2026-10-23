import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { deleteDeliverable } from '../api/resources'
import { edgeEnds, itemKey } from '../timeline/deps'
import type { Deliverable, RoadmapFull } from '../api/types'
import { Dialog } from './Dialog'

// REQ_FE_118: the one confirmation for deleting a deliverable (panel and edit window) or a milestone. Nothing is sent
// before Delete; a rejected onConfirm keeps the dialog open with the server's message. Cancel has the focus on open.
export function DeleteItemDialog({
  name,
  workstreamCount,
  dependencyCount,
  onCancel,
  onConfirm,
}: {
  name: string
  workstreamCount?: number
  dependencyCount: number
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setError('')
    setBusy(true)
    try {
      await onConfirm()
    } catch (err) {
      setError((err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <Dialog label={`Delete "${name}"?`} onClose={onCancel} overlayClassName="items-center z-[60]" className="w-[420px] max-w-full p-4 flex flex-col gap-3" testId="delete-item-dialog">
      <div className="flex items-center gap-2">
        <span className="text-danger">
          <AlertTriangle size={20} aria-hidden="true" />
        </span>
        <h2 className="font-semibold text-lg flex-1">Delete "{name}"?</h2>
      </div>
      {workstreamCount !== undefined && workstreamCount > 1 && <p className="text-text-2">It disappears from all {workstreamCount} workstreams.</p>}
      {dependencyCount > 0 && <p className="text-text-2">Its {dependencyCount} dependency links are removed too.</p>}
      {error && (
        <div className="hint bad" role="alert">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button autoFocus type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn danger" data-testid="delete-item-confirm" disabled={busy} onClick={() => void confirm()}>
          Delete
        </button>
      </div>
    </Dialog>
  )
}

// Dependency links of a deliverable, both directions, milestone ends included (roadmap.dependencies holds every edge
// with an end in the roadmap).
export function countLinks(roadmap: RoadmapFull, deliverable: Deliverable): number {
  const me = itemKey('deliverable', deliverable.id)
  return roadmap.dependencies.filter((e) => {
    const k = edgeEnds(e)
    return k.from === me || k.to === me
  }).length
}

// The deliverable flavour shared by the panel's Delete and the edit window's Delete deliverable (REQ_FE_118).
export function DeleteDeliverableDialog({
  deliverable,
  roadmap,
  onCancel,
  onDeleted,
}: {
  deliverable: Deliverable
  roadmap: RoadmapFull
  onCancel: () => void
  onDeleted: () => void
}) {
  const links = countLinks(roadmap, deliverable)
  return (
    <DeleteItemDialog
      name={deliverable.name}
      workstreamCount={deliverable.workstream_ids.length}
      dependencyCount={links}
      onCancel={onCancel}
      onConfirm={async () => {
        await deleteDeliverable(deliverable.id)
        onDeleted()
      }}
    />
  )
}
