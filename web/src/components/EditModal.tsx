import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Deliverable, Icon, RoadmapFull } from '../api/types'
import { DeliverableEditForm } from './DeliverableEditForm'
import { DeleteDeliverableDialog } from './DeleteItemDialog'
import { Dialog } from './Dialog'

// Opened by the 3-dot button on deliverable hover (REQ_FE_020). Reuses DeliverableEditForm, the
// exact same component the side panel's quick-edit form mounts, so the field set structurally
// cannot drift out of sync (REQ_FE_025). The frame is REQ_FE_119: fixed header and footer, only the fields scroll.
export function EditModal({
  deliverable,
  roadmap,
  icons = [],
  onClose,
  onSaved,
  onDependenciesChanged,
}: {
  deliverable: Deliverable
  roadmap: RoadmapFull
  // Phase 4 (REQ_FE_080): threaded the same way as SidePanel's icon prop — see that component.
  icons?: Icon[]
  onClose: () => void
  onSaved: (d: Deliverable) => void
  onDependenciesChanged?: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pendingSaves = useRef(new Set<Promise<void>>())

  // REQ_FE_119: initial focus on Title; Escape blurs the focused field (which saves it) and closes only once every
  // running save is done and no field shows a refusal — otherwise the window stays open with the message and the
  // typed value. A nested dialog (move, delete) or an open picker takes the Escape for itself (Dialog).
  function escape() {
    ;(document.activeElement as HTMLElement | null)?.blur()
    void Promise.all([...pendingSaves.current]).then(() =>
      requestAnimationFrame(() => {
        const el = bodyRef.current
        if (el?.isConnected && !el.querySelector('.hint.bad, [role="alert"]')) onClose()
      }),
    )
  }

  return (
    <Dialog label="Edit deliverable" onClose={onClose} onEscape={escape} initialFocus="#d-name" overlayClassName="items-start pt-[4vh] z-50" className="w-[760px] max-w-[calc(100vw-16px)] max-h-[92vh] flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <span className="swatch-dot inline-block shrink-0" style={{ background: deliverable.color, width: 14, height: 14 }} data-testid="edit-dot" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-lg leading-tight">Edit deliverable</h2>
          <div className="text-sm text-text-2 truncate" data-testid="edit-subtitle">{deliverable.name}</div>
        </div>
        <span className="tag hidden sm:inline-block">Every field autosaves — no Save button</span>
        <button type="button" className="btn icon ghost sm" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="overflow-auto p-4 flex-1 min-h-0" data-testid="edit-body" ref={bodyRef}>
        <DeliverableEditForm
          deliverable={deliverable}
          team={roadmap.team}
          workstreams={roadmap.workstreams}
          roadmap={roadmap}
          icons={icons}
          onSaved={onSaved}
          onDependenciesChanged={onDependenciesChanged}
          pendingSaves={pendingSaves}
        />
      </div>
      <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
        <button type="button" className="btn danger" data-testid="edit-delete" onClick={() => setConfirming(true)}>
          Delete deliverable
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="edit-window-done"
          onClick={() => {
            onClose()
          }}
        >
          Done
        </button>
      </div>
      {confirming && (
        <DeleteDeliverableDialog
          deliverable={deliverable}
          roadmap={roadmap}
          onCancel={() => setConfirming(false)}
          onDeleted={() => {
            onClose()
            onDependenciesChanged?.()
          }}
        />
      )}
    </Dialog>
  )
}
