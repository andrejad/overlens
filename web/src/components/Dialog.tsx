import { useEffect, useRef, useState, type ReactNode } from 'react'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

// The dialogs on screen, in the order they opened: only the last one (on top) reacts to keys.
const stack: HTMLElement[] = []

// The one modal shell: a dimmed overlay with the panel in it. On open, focus moves in (to `initialFocus`, an element
// already focused by autoFocus, or else the first control); Tab stays inside; Escape calls `onEscape` (default
// `onClose`) unless something inside took it first (defaultPrevented, an open picker); when it closes, focus goes
// back to whatever opened it. A dialog opened from another one is on top, so Escape closes it first.
export function Dialog({
  label,
  onClose,
  onEscape,
  initialFocus,
  overlayClassName = 'items-center z-50',
  className,
  testId,
  children,
}: {
  label: string
  onClose: () => void
  onEscape?: () => void
  initialFocus?: string // a selector inside the dialog
  overlayClassName?: string // placement and stacking of the overlay
  className: string // size and layout of the panel
  testId?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [opener] = useState(() => document.activeElement) // read before anything inside takes the focus
  const [focusFirst] = useState(() => initialFocus)
  const escape = useRef(onEscape ?? onClose)
  useEffect(() => {
    escape.current = onEscape ?? onClose
  })

  useEffect(() => {
    const el = ref.current!
    stack.push(el)
    if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>(focusFirst ?? FOCUSABLE) ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el) return
      if (e.key === 'Escape') {
        if (e.defaultPrevented || (document.activeElement as HTMLElement | null)?.getAttribute('aria-expanded') === 'true') return
        escape.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (!el.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      stack.splice(stack.indexOf(el), 1)
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus()
    }
  }, [opener, focusFirst])

  return (
    <div ref={ref} className={`fixed inset-0 bg-overlay flex justify-center ${overlayClassName}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
      <div className={`bg-surface rounded-lg shadow-lg ${className}`}>{children}</div>
    </div>
  )
}
