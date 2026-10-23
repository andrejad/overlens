import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'

const DRAG_THRESHOLD = 4 // px; a pointer move of more than this starts the drag (REQ_FE_106)

type Key = string | number

interface Drag {
  key: Key
  pointerId: number
  x: number
  y: number
  active: boolean
}

// REQ_FE_106/107, shared by the Manage workstreams page and the Company order page (REQ_FE_116): a list of rows
// (grip, position number, content) reordered by dragging the grip with the pointer or with ArrowUp/ArrowDown on it.
// The list only reports a move (`onMove`); the owner decides what is saved.
// Without `canEdit` the rows have no grip.
export function OrderList<T>({
  items,
  getKey,
  label,
  canEdit,
  renderMain,
  renderActions,
  onMove,
  testId = 'ws-list',
}: {
  items: T[]
  getKey: (item: T) => Key
  label: (item: T) => string // accessible name of the grip: "Reorder <label>"
  canEdit: boolean
  renderMain: (item: T, index: number) => ReactNode // after the position number
  renderActions?: (item: T) => ReactNode // after the "dragging…" tag
  onMove: (from: number, to: number, via: 'drag' | 'keyboard') => void
  testId?: string
}) {
  const dragRef = useRef<Drag | null>(null)
  const [dragView, setDragView] = useState<{ key: Key; slot: number } | null>(null)
  const rowEls = useRef(new Map<Key, HTMLElement>())

  // REQ_FE_107: a reorder moves the focused row's DOM node in real browsers, which drops focus; put it back on that grip.
  const refocusKey = useRef<Key | null>(null)
  useLayoutEffect(() => {
    const k = refocusKey.current
    if (k === null) return
    refocusKey.current = null // once: later list changes (add, rename, the save's answer) must not pull focus back
    const active = document.activeElement
    if (active && active !== document.body) return // focus was not lost
    rowEls.current.get(k)?.querySelector<HTMLElement>('.grip')?.focus()
  }, [items])

  // Escape puts a lifted row back and sends nothing (REQ_FE_106).
  const lifted = dragView !== null
  useEffect(() => {
    if (!lifted) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancelDrag()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lifted])

  function moveTo(key: Key, to: number, via: 'drag' | 'keyboard') {
    const from = items.findIndex((w) => getKey(w) === key)
    if (from < 0 || to < 0 || to >= items.length) return
    if (to === from) {
      return
    }
    onMove(from, to, via)
  }

  function onGripKey(e: ReactKeyboardEvent, key: Key) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const from = items.findIndex((w) => getKey(w) === key)
    const to = from + (e.key === 'ArrowUp' ? -1 : 1)
    if (to < 0 || to >= items.length) return
    refocusKey.current = key
    moveTo(key, to, 'keyboard')
  }

  // The slot (0..n) the pointer is over: how many rows' midpoints lie above it.
  function slotAt(clientY: number): number {
    let slot = 0
    for (const w of items) {
      const r = rowEls.current.get(getKey(w))?.getBoundingClientRect()
      if (r && clientY > r.top + r.height / 2) slot++
    }
    return slot
  }

  function cancelDrag() {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    setDragView(null)
  }

  function onGripDown(e: ReactPointerEvent<HTMLElement>, key: Key) {
    if (e.button !== 0 || dragRef.current) return
    dragRef.current = { key, pointerId: e.pointerId, x: e.clientX, y: e.clientY, active: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onGripMove(e: ReactPointerEvent<HTMLElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) <= DRAG_THRESHOLD) return
      d.active = true
    }
    setDragView({ key: d.key, slot: slotAt(e.clientY) })
  }

  function onGripUp(e: ReactPointerEvent<HTMLElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    dragRef.current = null // first, so the capture release below is not read as a lost capture
    setDragView(null)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d.active) return
    const from = items.findIndex((w) => getKey(w) === d.key)
    const slot = slotAt(e.clientY)
    moveTo(d.key, slot > from ? slot - 1 : slot, 'drag')
  }

  const dragFrom = dragView ? items.findIndex((w) => getKey(w) === dragView.key) : -1
  const dropSlot = dragView && dragFrom >= 0 && (dragView.slot > dragFrom ? dragView.slot - 1 : dragView.slot) !== dragFrom ? dragView.slot : -1

  return (
    <div data-testid={testId}>
      {items.map((item, i) => {
        const key = getKey(item)
        return (
          <div
            key={key}
            ref={(el) => {
              if (el) rowEls.current.set(key, el)
              else rowEls.current.delete(key)
            }}
            className={`ws-row${dragView?.key === key ? ' drag' : ''}${dropSlot === i ? ' drop-above' : ''}${dropSlot === items.length && i === items.length - 1 ? ' drop-below' : ''}`}
            data-testid="ws-row"
            data-ws-id={key}
          >
            {canEdit && (
              <button
                type="button"
                className="grip"
                aria-label={`Reorder ${label(item)}`}
                data-testid="ws-grip"
                onPointerDown={(e) => onGripDown(e, key)}
                onPointerMove={onGripMove}
                onPointerUp={onGripUp}
                onLostPointerCapture={() => cancelDrag()}
                onKeyDown={(e) => onGripKey(e, key)}
              >
                <GripVertical size={18} aria-hidden="true" />
              </button>
            )}
            <span className="pos">{i + 1}</span>
            {renderMain(item, i)}
            {dragView?.key === key && <span className="tag accent">dragging…</span>}
            {renderActions?.(item)}
          </div>
        )
      })}
    </div>
  )
}
