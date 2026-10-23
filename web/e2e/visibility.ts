// REQ_TEST_013: elements are skipped by what is really on screen (computed style + box), never by
// the `hidden` attribute alone (a `.deliverable { display:flex }` rule beats `hidden`).
export interface Measured {
  label: string
  display: string
  visibility: string
  width: number
  height: number
  left?: number
  right?: number
  top?: number
  bottom?: number
}

export const visibleBoxes = <T extends Measured>(items: T[]): T[] =>
  items.filter((i) => i.display !== 'none' && i.visibility !== 'hidden' && i.width > 0 && i.height > 0)

// Runs in the browser: measure every element matching selector, with computed visibility.
export const measureScript = (selector: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].map((e) => {
    const r = e.getBoundingClientRect()
    const cs = getComputedStyle(e)
    const label = (e.dataset.deliverable || e.textContent || '?').trim().slice(0, 20) + (e.classList.contains('dup') ? '(copy)' : '')
    return { label, display: cs.display, visibility: cs.visibility, width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  })

// Pairs sharing a row (vertical bands overlap by more than a hairline) that also overlap in time.
export function findOverlaps(items: Measured[]): string[] {
  const v = visibleBoxes(items) as Required<Measured>[]
  const out: string[] = []
  for (let i = 0; i < v.length; i++)
    for (let j = i + 1; j < v.length; j++) {
      const a = v[i], b = v[j]
      const sameRow = a.top < b.bottom - 4 && b.top < a.bottom - 4
      if (sameRow && a.left < b.right - 1 && b.left < a.right - 1) out.push(`${a.label} x ${b.label}`)
    }
  return out
}
