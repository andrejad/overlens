import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { X } from 'lucide-react'

// A small notice that outlives the component that raised it (the move dialog closes, and the panel may too).
// `showToast` mounts it in its own root on document.body; it closes by itself after `ms` (5 s by default).
export interface ToastOptions {
  message: string
  ms?: number
}

// eslint-disable-next-line react-refresh/only-export-components -- mounted by showToast in its own root, never by refreshed JSX
function Toast({ message, ms = 5000, onGone }: ToastOptions & { onGone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onGone, ms)
    return () => clearTimeout(t)
  }, [ms, onGone])

  return (
    <div
      role="status"
      className="flex items-center gap-3 bg-surface border border-border rounded-lg shadow-lg px-4 py-2 text-sm"
    >
      <span>{message}</span>
      <button type="button" className="btn icon ghost sm" aria-label="Dismiss" onClick={onGone}>
        <X size={14} />
      </button>
    </div>
  )
}
export function showToast(opts: ToastOptions): void {
  // Several toasts stack vertically in one fixed container instead of sitting on the same spot.
  let stack = document.getElementById('erm-toasts')
  if (!stack) {
    stack = document.createElement('div')
    stack.id = 'erm-toasts'
    stack.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center'
    document.body.appendChild(stack)
  }
  const host = document.createElement('div')
  stack.appendChild(host)
  const root = createRoot(host)
  let gone = false
  const onGone = () => {
    if (gone) return
    gone = true
    root.unmount()
    host.remove()
  }
  root.render(<Toast {...opts} onGone={onGone} />)
}
