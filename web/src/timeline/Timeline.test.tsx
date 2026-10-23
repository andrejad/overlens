// The timeline's DOM contract (its classes and data attributes), which the e2e specs and the rest of the frontend
// rely on. Pixel-level behaviour (overlap on screen, dragging) is covered by the pure-function
// tests and, once the app routes exist, the Playwright suite.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RoadmapFull } from '../api/types'
import { CAP_MESSAGE, fmtDay, fmtWd, isoOf, localDay, pxPerDay, ZOOMS } from './axis'
import { DIAMOND, ROW_PITCH } from './geometry'
import { Timeline, type TimelineProps } from './Timeline'
import { addDependency, addDeliverable, addItemDependency, addMilestone, newRoadmap, ws } from './testkit'
import { step } from '../testSteps'
import { STATUS } from '../lib/status'

const t = localDay(new Date())
let root: Root | null = null
let host: HTMLElement

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
})

function build(): { r: RoadmapFull; ids: Record<string, number> } {
  const r = newRoadmap(['Platform', 'Mobile'])
  const [p, m] = [ws(r, 'Platform'), ws(r, 'Mobile')]
  const multi = addDeliverable(r, { start: t, end: t + 20, in: [[p, 0], [m, 1]], status: 'at_risk' })
  const solo = addDeliverable(r, { start: t + 30, end: t + 40, in: [[m, 0]], status: 'in_progress' })
  const ms = addMilestone(r, { day: t + 25, in: p, row: 0, name: 'Launch' })
  return { r, ids: { multi: multi.id, solo: solo.id, ms: ms.id } }
}

function render(props: Partial<TimelineProps> & { roadmap: RoadmapFull }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const p: TimelineProps = { zoom: 'year', dupsOn: true, canEdit: true, onSelect: () => {}, ...props }
  act(() => root!.render(<Timeline {...p} />))
}

describe('Timeline DOM contract', () => {
  it('REQ_FE_040 REQ_FE_041 status badge on every main block (not on copies), hazard strip only when at risk, reason on hover but not required; an at-risk item with no reason still renders normally', async () => {
    await step('status badge on every main block (not on copies), hazard strip only when at risk, reason on hover', () => {
      const { r, ids } = build()
      r.deliverables[0].risk_note = 'Vendor late'
      render({ roadmap: r })
      const main = host.querySelector(`.deliverable:not(.dup)[data-deliverable="${ids.multi}"]`)!
      expect(main.querySelector('.st.st-at_risk')!.getAttribute('data-tip')).toBe('At risk|Vendor late')
      expect(main.querySelector('.risk-strip')).not.toBeNull()
      expect(host.querySelector('.deliverable.dup .st')).toBeNull()
      const solo = host.querySelector(`.deliverable[data-deliverable="${ids.solo}"]`)!
      expect(solo.querySelector('.st.st-in_progress')).not.toBeNull()
      expect(solo.querySelector('.risk-strip')).toBeNull()
    })

    await step('an at-risk item with no reason given still renders normally (a reason is offered, not required)', () => {
      if (root) {
        act(() => root!.unmount())
        root = null
        host.remove()
      }
      const { r, ids } = build() // r.deliverables[0] (ids.multi) is 'at_risk' with risk_note left at its default ''
      render({ roadmap: r })
      const main = host.querySelector(`.deliverable:not(.dup)[data-deliverable="${ids.multi}"]`)!
      expect(main.querySelector('.st.st-at_risk')!.getAttribute('data-tip')).toBe('At risk')
      expect(main.querySelector('.risk-strip')).not.toBeNull()
    })
  })
  // ---- a milestone's status (REQ_FE_040/041/042): the diamond shows it itself ----
  const msOf = (id: number) => host.querySelector<HTMLElement>(`.ms[data-ms="${id}"]`)!
  // the glyph that tells each status apart inside the diamond (MilestoneMarker.tsx)
  const glyph = (el: HTMLElement, s: string) => {
    const svg = el.querySelector('.mk > svg')!
    if (s === 'planned') return svg.querySelector('polygon[stroke-dasharray]') !== null && svg.querySelector('polygon')!.getAttribute('fill') === '#facc15' && svg.querySelector('polygon')!.getAttribute('stroke') === '#000'
    if (s === 'in_progress') return svg.querySelector('polygon')!.getAttribute('fill') === 'var(--accent)' && svg.querySelector('circle') !== null
    if (s === 'done') return svg.querySelector('polygon')!.getAttribute('fill') === 'var(--ok)' && svg.querySelector('path.ok-glyph') !== null
    // at risk: a plain red diamond with a white "!" (no stripes); its outline (.risk-ring) is drawn when the row has room
    return svg.querySelector('pattern') === null && svg.querySelector('polygon')!.getAttribute('fill') === 'var(--milestone)' && svg.querySelector('rect[fill="#fff"]') !== null
  }

  it('REQ_FE_040 REQ_FE_041 REQ_FE_042 every milestone\'s diamond shows its own status at every zoom level (no separate icon); no status reads as planned; hovering an at-risk milestone\'s diamond shows its risk note', async () => {
    await step('every milestone\'s diamond shows its own status at every zoom level (no separate icon); no status reads as planned', () => {
      const r = newRoadmap(['Platform'])
      const p = ws(r, 'Platform')
      const statuses = ['planned', 'in_progress', 'done', 'at_risk'] as const
      statuses.forEach((status, i) => addDeliverable(r, { start: t + i * 60, end: t + i * 60 + 20, in: [[p, 0]], status }))
      const marks = statuses.map((status, i) => addMilestone(r, { day: t + i * 60 + 40, in: p, row: 0, status }))
      const risky = addMilestone(r, { day: t + 250, in: p, row: 0, status: 'at_risk' })
      const bare = addMilestone(r, { day: t + 260, in: p, row: 0 })
      for (const zoom of ZOOMS) {
        render({ roadmap: r, zoom })
        statuses.forEach((s, i) => {
          const el = msOf(marks[i].id)
          expect(el.dataset.status, zoom).toBe(s)
          expect(el.querySelectorAll('.mk > svg'), `${s} @ ${zoom}`).toHaveLength(1) // one marker: the diamond
          expect(el.querySelector('.mk > svg')!.getAttribute('aria-label')).toBe(STATUS[s].label)
          expect(glyph(el, s), `${s} glyph @ ${zoom}`).toBe(true)
          expect(statuses.filter((o) => glyph(el, o)), `only the ${s} glyph @ ${zoom}`).toEqual([s])
          expect(el.querySelector('.st, .dia')).toBeNull() // no separate status icon any more
          expect(el.classList.contains('at-risk')).toBe(s === 'at_risk')
          expect(el.querySelector('.risk-strip')).toBeNull() // no strip on a diamond
        })
        // the at-risk diamonds in a free row have their red outline around them, the others do not
        for (const m of [marks[3], risky]) expect(msOf(m.id).querySelector('polygon.risk-ring')?.getAttribute('stroke'), zoom).toBe('var(--milestone)')
        expect(host.querySelectorAll('.ms:not(.at-risk) polygon.risk-ring').length, zoom).toBe(0)
        // the name starts 8px under an outlined diamond (2px under the others) and the date starts after the outline's room
        expect(msOf(risky.id).style.getPropertyValue('--lg'), zoom).toBe('8px')
        expect(msOf(risky.id).style.getPropertyValue('--dg'), zoom).toBe('12px')
        expect(msOf(bare.id).style.getPropertyValue('--lg'), zoom).toBe('2px')
        expect(msOf(bare.id).style.getPropertyValue('--dg'), zoom).toBe('6px')
        expect(msOf(bare.id).dataset.status).toBe('planned')
        expect(glyph(msOf(bare.id), 'planned')).toBe(true)
        act(() => root!.unmount())
        host.remove()
      }
      root = null
    })

    await step('hovering an at-risk milestone\'s diamond shows its risk note; without a note it shows just the status', () => {
      if (root) {
        act(() => root!.unmount())
        root = null
        host.remove()
      }
      const r = newRoadmap(['Platform'])
      const p = ws(r, 'Platform')
      const noted = addMilestone(r, { day: t + 10, in: p, row: 0, status: 'at_risk', risk_note: 'Vendor late' })
      const plain = addMilestone(r, { day: t + 90, in: p, row: 0, status: 'at_risk' })
      render({ roadmap: r })
      act(() => void msOf(noted.id).querySelector('.mk svg')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
      const tip = host.querySelector('.wk-tip')!
      expect(tip.firstChild!.textContent).toBe('At risk')
      expect(tip.querySelector('small')!.textContent).toBe('Vendor late')
      expect(msOf(plain.id).querySelector('.mk')!.getAttribute('data-tip')).toBe('At risk')
    })
  })

  it('REQ_FE_040 REQ_FE_042 REQ_FE_010 a milestone wedged between bars still shows its status diamond, its name only within its own day and no date; a free one has its name centred under the diamond and its date to the right', () => {
    const r = newRoadmap(['Platform'])
    const p = ws(r, 'Platform')
    const left = addDeliverable(r, { start: t, end: t + 19, in: [[p, 0]] })
    addDeliverable(r, { start: t + 21, end: t + 40, in: [[p, 0]] })
    const wedged = addMilestone(r, { day: t + 20, in: p, row: 0, name: 'Wedged' })
    const free = addMilestone(r, { day: t + 100, in: p, row: 0, name: 'Free' })
    addDeliverable(r, { start: t + 200, end: t + 210, in: [[p, 0]] }) // the grid runs well past the free milestone
    for (const zoom of ZOOMS) {
      render({ roadmap: r, zoom })
      expect(glyph(msOf(wedged.id), 'planned'), zoom).toBe(true)
      const day = (parseFloat(host.querySelector<HTMLElement>(`.deliverable[data-deliverable="${left.id}"]`)!.style.width) + 1) / 20 // one day's px
      const name = msOf(wedged.id).querySelector<HTMLElement>('.lbl')
      if (day - 4 < 28) expect(name, zoom).toBeNull() // no room for a readable name: it stays in the tooltip
      else expect(parseFloat(name!.style.maxWidth), zoom).toBeLessThanOrEqual(day - 4) // cut to its own day
      expect(msOf(wedged.id).querySelector('.dt')).toBeNull()
      const el = msOf(free.id)
      expect(el.querySelector('.lbl')!.textContent, zoom).toBe('Free')
      expect(el.querySelector('.dt')!.textContent, zoom).toBe(fmtDay(t + 100, false) + fmtWd(t + 100))
      expect(el.style.width, zoom).toBe(`${DIAMOND}px`) // the box is the diamond: name and date hang outside it
      expect(el.style.height).toBe(`${DIAMOND}px`)
      act(() => root!.unmount())
      host.remove()
    }
    root = null
    // jsdom has no layout: the placement is the stylesheet's (the real layout is checked in e2e/20-milestone-status.spec.ts)
    const css = readFileSync('src/timeline/timeline.css', 'utf8')
    expect(css).toMatch(/\.ms \.lbl\s*\{[^}]*position:\s*absolute;[^}]*top:\s*calc\(100% \+ var\(--lg, 2px\)\);[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\)[^}]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.ms \.dt\s*\{[^}]*position:\s*absolute;[^}]*left:\s*calc\(100% \+ var\(--dg, 6px\)\);[^}]*top:\s*50%;[^}]*transform:\s*translateY\(-50%\)/)
    expect(css).not.toMatch(/\.ms \.st\b/)
  })

  it('REQ_FE_020 REQ_FE_024 clicking a deliverable or a milestone selects it; the three-dot button opens the editor', () => {
    const { r, ids } = build()
    const onSelect = vi.fn()
    const onEdit = vi.fn()
    render({ roadmap: r, onSelect, onEdit })
    act(() => host.querySelector<HTMLElement>(`.deliverable.dup[data-deliverable="${ids.multi}"]`)!.click())
    act(() => host.querySelector<HTMLElement>('.ms')!.click())
    act(() => host.querySelector<HTMLElement>(`.deliverable:not(.dup)[data-deliverable="${ids.solo}"] .more`)!.click())
    expect(onSelect.mock.calls).toEqual([[ids.multi, 'deliverable'], [ids.ms, 'milestone']])
    expect(onEdit.mock.calls).toEqual([[ids.solo]])
  })

  it('REQ_FE_011 a stored row that no longer fits is replaced on screen, and the browser never saves it on its own', () => {
    const { r, ids } = build()
    const p = ws(r, 'Platform')
    const clash = addDeliverable(r, { start: t + 5, end: t + 8, in: [[p, 0]] }) // overlaps `multi` in row 0
    const ms = addMilestone(r, { day: t + 10, in: p, row: 0 }) // overlaps `multi` in row 0 too
    const onPatchDeliverable = vi.fn()
    const onPatchMilestone = vi.fn()
    render({ roadmap: r, onPatchDeliverable, onPatchMilestone })
    act(() => root!.render(<Timeline roadmap={{ ...r }} zoom="year" dupsOn canEdit onSelect={() => {}} onPatchDeliverable={onPatchDeliverable} onPatchMilestone={onPatchMilestone} />))
    expect(host.querySelector<HTMLElement>(`.deliverable[data-deliverable="${ids.multi}"]:not(.dup)`)!.dataset.row).toBe('0')
    expect(host.querySelector<HTMLElement>(`.deliverable[data-deliverable="${clash.id}"]`)!.dataset.row).not.toBe('0')
    expect(host.querySelector<HTMLElement>(`.ms[data-ms="${ms.id}"]`)!.dataset.row).not.toBe('0')
    expect(onPatchDeliverable).not.toHaveBeenCalled()
    expect(onPatchMilestone).not.toHaveBeenCalled()
  })

  it('REQ_FE_064 REQ_FE_069 REQ_FE_070 months above weeks with hover tips, two scrollbars, today marker', () => {
    const { r } = build()
    render({ roadmap: r })
    expect(host.querySelectorAll('.hm').length).toBeGreaterThan(0)
    const weeks = [...host.querySelectorAll<HTMLElement>('.hw')]
    expect(weeks.length).toBeGreaterThan(0)
    for (const w of weeks) expect(w.dataset.tip).toMatch(/^Mon .+ – Sun .+\|ISO week \d+$/)
    expect(host.querySelectorAll('.tl-topscroll')).toHaveLength(1)
    expect(host.querySelectorAll('.tl-scroll')).toHaveLength(1)
    expect(host.querySelectorAll('.today, .today-flag')).toHaveLength(2)
    expect(host.querySelector('.past')).not.toBeNull()
  })

  it('REQ_FE_067 REQ_FE_010 a long name renders as a truncatable .name span with the full name on hover and timeline.css clips it with an ellipsis; a bar too narrow for its padding is marked snug, and one too narrow for any content tiny', async () => {
    await step('a long name renders as a truncatable .name span, with the full name available on hover', () => {
      const r = newRoadmap(['Platform'])
      const p = ws(r, 'Platform')
      const long = addDeliverable(r, { start: t, end: t + 5, in: [[p, 0]], name: 'A '.repeat(40) + 'very long deliverable name' })
      render({ roadmap: r })
      const bar = host.querySelector<HTMLElement>(`.deliverable[data-deliverable="${long.id}"]`)!
      const nameEl = bar.querySelector('.name')!
      expect(nameEl.textContent).toBe(long.name) // the DOM keeps the full text; CSS (not JS) does the clipping
      expect(bar.title).toContain(long.name) // hover always has the full name, whatever CSS does
    })

    await step('a bar too narrow for its padding is marked snug, and one too narrow for any content tiny', () => {
      if (root) {
        act(() => root!.unmount())
        root = null
        host.remove()
      }
      const r = newRoadmap(['Platform'])
      const p = ws(r, 'Platform')
      const short = addDeliverable(r, { start: t, end: t + 2, in: [[p, 0]] })
      const long = addDeliverable(r, { start: t + 10, end: t + 700, in: [[p, 0]] })
      render({ roadmap: r })
      const bar = (id: number) => host.querySelector<HTMLElement>(`.deliverable[data-deliverable="${id}"]`)!
      expect(bar(short.id).classList.contains('snug')).toBe(true)
      expect(bar(short.id).classList.contains('tiny')).toBe(true)
      expect(bar(long.id).classList.contains('snug')).toBe(false)
      expect(bar(long.id).classList.contains('tiny')).toBe(false)
      const css = readFileSync('src/timeline/timeline.css', 'utf8')
      expect(css).toMatch(/\.deliverable\.snug\s*\{[^}]*padding:\s*0/)
      expect(css).toMatch(/\.deliverable\.tiny \.name[^{]*\{[^}]*display:\s*none/)
    })

    await step('timeline.css actually clips .deliverable .name with an ellipsis, no wrap/grow', () => {
      // jsdom doesn't apply stylesheets, so getComputedStyle can't see timeline.css's rules: check the rule itself exists
      if (root) {
        act(() => root!.unmount())
        root = null
        host.remove()
      }
      const css = readFileSync('src/timeline/timeline.css', 'utf8')
      expect(css).toMatch(/\.deliverable \.name\s*\{[^}]*text-overflow:\s*ellipsis/)
      expect(css).toMatch(/\.deliverable \.name\s*\{[^}]*white-space:\s*nowrap/)
    })
  })

  it('REQ_FE_080 a deliverable shows each of its icons, each labelled on hover; unknown keys are skipped', () => {
    const r = newRoadmap(['Platform', 'Mobile'])
    const [p, m] = [ws(r, 'Platform'), ws(r, 'Mobile')]
    const d = addDeliverable(r, { start: t, end: t + 30, in: [[p, 0], [m, 0]], icons: ['star', 'warning', 'not-an-icon'] })
    const plain = addDeliverable(r, { start: t + 40, end: t + 50, in: [[p, 0]] })
    render({ roadmap: r })
    const main = host.querySelector(`.deliverable:not(.dup)[data-deliverable="${d.id}"]`)!
    expect([...main.querySelectorAll<HTMLElement>('.icons .ic')].map((i) => `${i.dataset.icon}:${i.title}`)).toEqual(['star:High priority', 'warning:Warning'])
    expect(main.querySelectorAll('.icons svg')).toHaveLength(2)
    expect(host.querySelectorAll(`.deliverable.dup[data-deliverable="${d.id}"] .icons .ic`)).toHaveLength(2) // copies carry them too
    expect(host.querySelector(`.deliverable[data-deliverable="${plain.id}"] .icons`)).toBeNull()
  })
})

// Drag-to-move through real pointer events, mostly for milestones. jsdom has no layout, so element
// positions are read back from the inline styles the timeline sets, and pointer capture is stubbed.
describe('dragging with pointer events', () => {
  const px = pxPerDay('year', 1000) // jsdom's scroll area has no width, so the timeline assumes 1000px
  let restore: (() => void) | null = null
  beforeEach(() => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>
    const saved = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture', 'getBoundingClientRect'].map((k) => [k, proto[k]] as const)
    const captured = new Set<number>()
    proto.setPointerCapture = (id: number) => captured.add(id)
    proto.releasePointerCapture = (id: number) => captured.delete(id)
    proto.hasPointerCapture = (id: number) => captured.has(id)
    proto.getBoundingClientRect = function (this: HTMLElement) {
      const top = parseFloat(this.style.top) || 0 // .tl-inner has no top: it is the origin
      return { top, left: 0, right: 0, bottom: top, width: 0, height: 0, x: 0, y: top, toJSON() {} } as DOMRect
    }
    restore = () => saved.forEach(([k, v]) => (proto[k] = v))
  })
  afterEach(() => restore?.())

  // Platform: [A t..t+9] <M t+15> [B t+20..t+30]; Mobile: [C t+10..t+20]
  function scene() {
    const r = newRoadmap(['Platform', 'Mobile'])
    const [p, m] = [ws(r, 'Platform'), ws(r, 'Mobile')]
    addDeliverable(r, { start: t, end: t + 9, in: [[p, 0]] })
    addDeliverable(r, { start: t + 20, end: t + 30, in: [[p, 0]] })
    addDeliverable(r, { start: t + 10, end: t + 20, in: [[m, 0]] })
    const ms = addMilestone(r, { day: t + 15, in: p, row: 0, name: 'Beta' })
    return { r, p, m, ms }
  }
  const fire = (el: Element, type: string, x: number, y: number) =>
    act(() => {
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }))
    })
  // Drags the milestone by `days` horizontally and `dy` pixels vertically, then lets the save settle.
  async function dragMs(id: number, days: number, dy = 0) {
    const el = host.querySelector(`.ms[data-ms="${id}"]`)!
    const y0 = parseFloat((el as HTMLElement).style.top) + 4
    fire(el, 'pointerdown', 500, y0)
    fire(el, 'pointermove', 500 + (days * px) / 2, y0 + dy / 2)
    fire(el, 'pointermove', 500 + days * px, y0 + dy)
    fire(el, 'pointerup', 500 + days * px, y0 + dy)
    await act(async () => {})
  }

  it('REQ_FE_012 REQ_FE_068 a milestone moves along its row, snapped to the day, and stops at its neighbours', async () => {
    const { r, ms } = scene()
    const onPatchMilestone = vi.fn().mockResolvedValue(undefined)
    render({ roadmap: r, onPatchMilestone })
    await dragMs(ms.id, 2.4) // snaps to the nearest day
    await dragMs(ms.id, 40) // runs into B, which starts on t+20
    await dragMs(ms.id, -40) // runs into A, which ends on t+9
    expect(onPatchMilestone.mock.calls).toEqual([
      [ms.id, { date: isoOf(t + 17) }],
      [ms.id, { date: isoOf(t + 19) }],
      [ms.id, { date: isoOf(t + 10) }],
    ])
    expect(host.querySelectorAll('.ms .rz')).toHaveLength(0) // a single day: nothing to resize
  })

  it('REQ_FE_014 REQ_FE_015 a milestone dropped onto an occupied day of another row moves nothing and says so', async () => {
    const { r, ms } = scene()
    const onPatchMilestone = vi.fn()
    render({ roadmap: r, onPatchMilestone })
    await dragMs(ms.id, 0, ROW_PITCH + 20) // into Mobile's row 0, where C covers t+15
    expect(onPatchMilestone).not.toHaveBeenCalled()
    expect(host.querySelector('.tl-notice')!.textContent).toMatch(/taken/)
    expect(host.querySelector<HTMLElement>(`.ms[data-ms="${ms.id}"]`)!.dataset.ws).toBe('Platform')
  })

  it('REQ_API_051 REQ_FE_062 a drag the server refuses snaps back and says why: its row_overlap message, or the 3-year message for span_exceeded', async () => {
    const { r, ms } = scene()
    const refuse = (code: string, message: string) => Object.assign(new Error(code), { response: { status: 409, data: { error: { code, message } } } })
    const onPatchMilestone = vi.fn().mockRejectedValueOnce(refuse('row_overlap', 'Overlaps "C" in Mobile, row 1')).mockRejectedValueOnce(refuse('span_exceeded', 'This change would make the roadmap run from a to b'))
    render({ roadmap: r, onPatchMilestone })
    await dragMs(ms.id, 2)
    expect(host.querySelector('.tl-notice')!.textContent).toBe('Overlaps "C" in Mobile, row 1')
    expect(host.querySelector<HTMLElement>(`.ms[data-ms="${ms.id}"]`)!.classList.contains('dragging')).toBe(false)
    await dragMs(ms.id, 2)
    expect(host.querySelector('.tl-notice')!.textContent).toBe(CAP_MESSAGE)
  })

  it('REQ_FE_014 REQ_FE_016 REQ_DAT_026 REQ_API_029 a milestone dropped into another workstream saves date, workstream and row there', async () => {
    const { r, m, ms } = scene()
    const onPatchMilestone = vi.fn().mockResolvedValue(undefined)
    render({ roadmap: r, onPatchMilestone })
    await dragMs(ms.id, 10, ROW_PITCH + 20) // Mobile row 0, past C
    await dragMs(ms.id, 0, 2 * ROW_PITCH + 20) // Mobile's new row below its last
    expect(onPatchMilestone.mock.calls).toEqual([
      [ms.id, { date: isoOf(t + 25), workstream_id: m.id, row: 0 }],
      [ms.id, { workstream_id: m.id, row: 1 }],
    ])
  })

  it('REQ_FE_127 REQ_FE_014 an empty workstream has no band, label or drop slot: the drop below Platform lands in Mobile; a row appears when an item is put in its workstream and closes up when its last item leaves', async () => {
    const r = newRoadmap(['Platform', 'Empty', 'Mobile'])
    const [p, e, m] = [ws(r, 'Platform'), ws(r, 'Empty'), ws(r, 'Mobile')]
    addDeliverable(r, { start: t, end: t + 9, in: [[p, 0]] })
    addDeliverable(r, { start: t + 10, end: t + 20, in: [[m, 0]] })
    const ms = addMilestone(r, { day: t + 15, in: p, row: 0 })
    const shown = () => [...host.querySelectorAll<HTMLElement>('.band')].map((b) => b.dataset.ws)
    const labels = () => [...host.querySelectorAll('.ws-label .name')].map((n) => n.textContent)

    await step('an empty workstream has no band and no gutter label', () => {
      render({ roadmap: r })
      expect(shown()).toEqual(['Platform', 'Mobile'])
      expect(labels()).toEqual(['Platform', 'Mobile'])
      act(() => root!.unmount())
      host.remove()
    })

    await step('the drop below Platform lands in Mobile, and Mobile\'s new row below its last still works', async () => {
      const onPatchMilestone = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, onPatchMilestone })
      await dragMs(ms.id, 10, ROW_PITCH + 20) // Mobile row 0, past C
      await dragMs(ms.id, 0, 2 * ROW_PITCH + 20) // Mobile's new row below its last
      expect(onPatchMilestone.mock.calls).toEqual([
        [ms.id, { date: isoOf(t + 25), workstream_id: m.id, row: 0 }],
        [ms.id, { workstream_id: m.id, row: 1 }],
      ])
      act(() => root!.unmount())
      host.remove()
    })

    await step('a row appears when an item is put in its workstream and closes up when its last item leaves', () => {
      const withItem = { ...r, deliverables: [...r.deliverables, { ...r.deliverables[0], id: 9_999_001, workstream_ids: [e.id], workstreams: [{ id: e.id, row: 0 }] }] }
      render({ roadmap: withItem })
      expect(shown()).toEqual(['Platform', 'Empty', 'Mobile'])
      act(() => root!.render(<Timeline zoom="year" dupsOn canEdit onSelect={() => {}} roadmap={r} />))
      expect(shown()).toEqual(['Platform', 'Mobile'])
      expect(labels()).toEqual(['Platform', 'Mobile'])
    })
  })

  it('REQ_FE_011 a dragged item whose shown row differs from its stored row saves the shown row with the drag', async () => {
    const { r, p, ms } = scene()
    const d = addDeliverable(r, { start: t + 5, end: t + 8, in: [[p, 0]] }) // legacy data: row 0 is taken by A, so it is shown in row 1
    const late = addMilestone(r, { day: t + 5, in: p, row: 0, name: 'Late' }) // A and D hold its day in rows 0 and 1: shown in row 2
    const onPatchMilestone = vi.fn().mockResolvedValue(undefined)
    const onPatchDeliverable = vi.fn().mockResolvedValue(undefined)
    render({ roadmap: r, onPatchMilestone, onPatchDeliverable })
    const el = bar(d.id)
    const y0 = parseFloat(el.style.top) + 4
    fire(el, 'pointerdown', 500, y0)
    fire(el, 'pointermove', 500 + (3 * px) / 2, y0)
    fire(el, 'pointermove', 500 + 3 * px, y0)
    fire(el, 'pointerup', 500 + 3 * px, y0)
    await act(async () => {})
    expect(onPatchDeliverable.mock.calls).toEqual([[d.id, { start_date: isoOf(t + 8), end_date: isoOf(t + 11), rows: { [p.id]: 1 } }]])
    // a relocated milestone sends its shown row
    await dragMs(late.id, 2)
    expect(onPatchMilestone.mock.calls).toEqual([[late.id, { date: isoOf(t + 7), row: 2 }]])
    await dragMs(ms.id, 2) // Beta is shown where it is stored: no row is sent
    expect(onPatchMilestone.mock.calls[1]).toEqual([ms.id, { date: isoOf(t + 17) }])
  })

  it('REQ_FE_014 a milestone held over another row outlines the slot: red where it would overlap, accent in the new row below the last', () => {
    const { r, ms } = scene()
    const onPatchMilestone = vi.fn()
    render({ roadmap: r, onPatchMilestone })
    const el = host.querySelector<HTMLElement>(`.ms[data-ms="${ms.id}"]`)!
    const y0 = parseFloat(el.style.top) + 4
    fire(el, 'pointerdown', 500, y0)
    fire(el, 'pointermove', 500, y0 + ROW_PITCH + 20) // Mobile row 0, where C covers t+15
    expect(host.querySelectorAll('.drop-slot.bad')).toHaveLength(1)
    fire(el, 'pointermove', 500, y0 + 2 * ROW_PITCH + 20) // Mobile's new row below its last
    expect(host.querySelectorAll('.drop-slot')).toHaveLength(1)
    expect(host.querySelector('.drop-slot.bad')).toBeNull()
    const css = readFileSync('src/timeline/timeline.css', 'utf8')
    expect(css).toMatch(/\.drop-slot\s*\{[^}]*border:\s*2px dashed var\(--accent\)/)
    expect(css).toMatch(/\.drop-slot\.bad\s*\{[^}]*border-color:\s*var\(--danger\)/)
  })

  it('REQ_FE_063 a milestone dragged past the end of the grid grows it at once, header and body together, to the end of that month', () => {
    const r = newRoadmap(['Platform'])
    const m = addMilestone(r, { day: t + 15, in: ws(r, 'Platform'), row: 0 })
    render({ roadmap: r, onPatchMilestone: vi.fn() })
    const width = () => parseFloat(host.querySelector<HTMLElement>('.tl-header')!.style.width)
    const w0 = width()
    const el = host.querySelector<HTMLElement>(`.ms[data-ms="${m.id}"]`)!
    const left0 = parseFloat(el.style.left)
    const y0 = parseFloat(el.style.top) + 4
    fire(el, 'pointerdown', 500, y0)
    fire(el, 'pointermove', 500 + 100 * px, y0) // t+115
    const w1 = width()
    const diaMid = left0 + 100 * px + DIAMOND / 2 // the diamond's centre on t+115
    expect(w1).toBeGreaterThan(w0)
    expect(parseFloat(host.querySelector<HTMLElement>('.tl-inner')!.style.width)).toBe(w1)
    expect(w1).toBeGreaterThan(diaMid)
    expect(w1 - diaMid).toBeLessThan(31 * px) // the grid ends with that month
  })

  it('REQ_FE_012 a deliverable dragged along its row moves its copies with it live, not only after saving', () => {
    const { r } = scene()
    const [p, m] = [ws(r, 'Platform'), ws(r, 'Mobile')]
    const multi = addDeliverable(r, { start: t + 40, end: t + 45, in: [[p, 0], [m, 1]] })
    render({ roadmap: r, onPatchDeliverable: vi.fn() })
    const main = host.querySelector(`.deliverable:not(.dup)[data-deliverable="${multi.id}"]`)!
    const left0 = parseFloat(host.querySelector<HTMLElement>(`.deliverable.dup[data-deliverable="${multi.id}"]`)!.style.left)
    const y0 = parseFloat((main as HTMLElement).style.top) + 4
    fire(main, 'pointerdown', 500, y0)
    fire(main, 'pointermove', 500 + 3 * px, y0)
    const copy = host.querySelector<HTMLElement>(`.deliverable.dup[data-deliverable="${multi.id}"]`)!
    expect(parseFloat(copy.style.left)).toBeCloseTo(left0 + 3 * px)
  })

  it('REQ_FE_083 without edit rights there are no resize handles or three-dot buttons, and a milestone does not move', async () => {
    await step('without edit rights there are no resize handles or three-dot buttons', () => {
      const { r } = build()
      render({ roadmap: r, canEdit: false, onEdit: () => {} })
      expect(host.querySelectorAll('.rz, .more')).toHaveLength(0)
    })

    await step('without edit rights a milestone does not move', async () => {
      if (root) {
        act(() => root!.unmount())
        root = null
        host.remove()
      }
      const { r, ms } = scene()
      const onPatchMilestone = vi.fn()
      render({ roadmap: r, canEdit: false, onPatchMilestone })
      await dragMs(ms.id, 5)
      expect(onPatchMilestone).not.toHaveBeenCalled()
    })
  })
  // ---- Phase 5: dependencies (REQ_DEP_005, 009–012, 014, 016–020) ----
  // Platform: A t..t+19 (row 0) -> B t+24..t+44 (row 1); C t+50..t+70 (row 0). Bars are >= 40px wide at year zoom.
  function depScene() {
    const r = newRoadmap(['Platform'])
    const p = ws(r, 'Platform')
    const a = addDeliverable(r, { start: t, end: t + 19, in: [[p, 0]], name: 'A' })
    const b = addDeliverable(r, { start: t + 24, end: t + 44, in: [[p, 1]], name: 'B' })
    const c = addDeliverable(r, { start: t + 50, end: t + 70, in: [[p, 0]], name: 'C' })
    addDependency(r, a, b)
    return { r, p, a, b, c }
  }
  const bar = (id: number) => host.querySelector<HTMLElement>(`.deliverable:not(.dup)[data-deliverable="${id}"]`)!
  const arrow = (from: number, to: number) => host.querySelector(`g.dep[data-dep-from="${from}"][data-dep-to="${to}"]`)
  const pathOf = (from: number, to: number) => arrow(from, to)!.querySelector('.dep-line')!.getAttribute('d')!
  const keydown = (key: string) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
  const over = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  const click = (el: Element) => act(() => void (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))
  const dragFrom = async (el: Element, days: number, hold = false) => {
    fire(el, 'pointerdown', 500, 10)
    fire(el, 'pointermove', 500 + (days * px) / 2, 10)
    fire(el, 'pointermove', 500 + days * px, 10)
    if (!hold) {
      fire(el, 'pointerup', 500 + days * px, 10)
      await act(async () => {})
    }
  }

  it('REQ_DEP_009 an arrow leaves the prerequisite\'s right edge and ends with its head at the dependent\'s left edge; with dependencies off there are no arrows and no badges', async () => {
    await step('an arrow leaves the prerequisite\'s right edge and ends with its head at the dependent\'s left edge', async () => {
      const { r, a, b } = depScene()
      render({ roadmap: r, showDependencies: true })
      const x1 = parseFloat(bar(a.id).style.left) + parseFloat(bar(a.id).style.width)
      const x2 = parseFloat(bar(b.id).style.left)
      const d = pathOf(a.id, b.id)
      expect(d.startsWith(`M${x1},`)).toBe(true)
      expect(d.endsWith(` H${x2}`)).toBe(true)
      expect(d).toMatch(/^M[\d.]+,[\d.]+ H[\d.]+ V[\d.]+ H[\d.]+$/) // right angles only
      expect(arrow(a.id, b.id)!.querySelector('.dep-line')!.getAttribute('marker-end')).toMatch(/^url\(#dep-a/)
    })
    act(() => root!.unmount())
    await step('with dependencies off there are no arrows and no badges', async () => {
      const { r } = depScene()
      render({ roadmap: r })
      expect(host.querySelector('svg.deps')).toBeNull()
      expect(host.querySelector('.dep-badge')).toBeNull()
    })
  })

  it('REQ_DEP_010 arrows are faint by default and stand out on hover or when either end is selected', () => {
    const { r, a, b, c } = depScene()
    render({ roadmap: r, showDependencies: true })
    expect(arrow(a.id, b.id)!.classList.contains('hl')).toBe(false)
    over(arrow(a.id, b.id)!.querySelector('.dep-hit')!)
    expect(arrow(a.id, b.id)!.classList.contains('hl')).toBe(true)
    const hit = arrow(a.id, b.id)!.querySelector('.dep-hit')!
    act(() => void hit.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))) // the pointer leaves
    expect(arrow(a.id, b.id)!.classList.contains('hl')).toBe(false) // faint again
    act(() => root!.unmount())
    for (const [sel, hl] of [[a.id, true], [b.id, true], [c.id, false]] as const) {
      render({ roadmap: r, showDependencies: true, selected: { id: sel, type: 'deliverable' } })
      expect(arrow(a.id, b.id)!.classList.contains('hl')).toBe(hl)
      act(() => root!.unmount())
    }
    const css = readFileSync('src/timeline/timeline.css', 'utf8')
    expect(css).toMatch(/\.dep-line\s*\{[^}]*opacity:\s*\.4/)
    expect(css).toMatch(/\.dep\.hl \.dep-line\s*\{[^}]*opacity:\s*1/)
  })

  it('REQ_DEP_011 an arrow stays attached to a deliverable and to a milestone while it is dragged (a milestone along its row and over another row)', async () => {
    await step('an arrow stays attached to a deliverable while it is dragged', async () => {
      const { r, a, b } = depScene()
      render({ roadmap: r, showDependencies: true, onPatchDeliverable: vi.fn().mockResolvedValue(undefined) })
      await dragFrom(bar(b.id), 5, true) // B moves 5 days later, still held
      expect(pathOf(a.id, b.id).endsWith(` H${parseFloat(bar(b.id).style.left)}`)).toBe(true)
      expect(parseFloat(bar(b.id).style.left)).toBeCloseTo(parseFloat(bar(a.id).style.left) + 29 * px)
      fire(bar(b.id), 'pointerup', 500, 10)
      await act(async () => {})
      await dragFrom(bar(a.id), 3, true) // and the same from the prerequisite's end
      const x1 = parseFloat(bar(a.id).style.left) + parseFloat(bar(a.id).style.width)
      expect(pathOf(a.id, b.id).startsWith(`M${x1},`)).toBe(true)
    })
    act(() => root!.unmount())
    await step('the arrows stay attached to a milestone while it is dragged, along its row and over another row', async () => {
      const { r, a, b, m } = msDepScene()
      render({ roadmap: r, showDependencies: true, onPatchMilestone: vi.fn() })
      const path = (fk: string, from: number, tk: string, to: number) => kindArrow(fk, from, tk, to)!.querySelector('.dep-line')!.getAttribute('d')!
      const el = msEl(m.id)
      const left0 = parseFloat(el.style.left)
      const y0 = parseFloat(el.style.top) + 4
      fire(el, 'pointerdown', 500, y0)
      fire(el, 'pointermove', 500 + 1 * px, y0)
      fire(el, 'pointermove', 500 + 2 * px, y0) // held, 2 days later (B, starting on t+30, still leaves room for the exit stub)
      const size = parseFloat(el.style.width)
      expect(parseFloat(msEl(m.id).style.left)).toBeCloseTo(left0 + 2 * px)
      expect(path('deliverable', a.id, 'milestone', m.id).endsWith(` H${parseFloat(msEl(m.id).style.left)}`)).toBe(true)
      expect(path('milestone', m.id, 'deliverable', b.id).startsWith(`M${parseFloat(msEl(m.id).style.left) + size},`)).toBe(true)
      fire(el, 'pointermove', 500 + 2 * px, y0 + 4 * ROW_PITCH) // still held, over the new row below the last
      const top = parseFloat(msEl(m.id).style.top)
      expect(top).toBeGreaterThan(y0)
      const yMid = top + DIAMOND / 2
      expect(path('deliverable', a.id, 'milestone', m.id)).toMatch(new RegExp(` V${yMid} H[\\d.]+$`))
      expect(path('milestone', m.id, 'deliverable', b.id).startsWith(`M${parseFloat(msEl(m.id).style.left) + size},${yMid} `)).toBe(true)
    })
  })

  it('REQ_DEP_012 an end on another roadmap shows a chevron badge with team and deliverable, and never an arrow to nothing', () => {
    const { r, a, b } = depScene()
    const foreign = { id: 9001, name: 'Payments API', team_name: 'Payments', roadmap_id: r.id + 100, start_date: isoOf(t - 30), end_date: isoOf(t - 5) }
    const after = { id: 9002, name: 'Billing UI', team_name: 'Billing', roadmap_id: r.id + 100, start_date: isoOf(t + 90), end_date: isoOf(t + 99) }
    addDependency(r, foreign, a)
    addDependency(r, b, after)
    render({ roadmap: r, showDependencies: true })
    const before = host.querySelector<HTMLElement>(`.dep-badge.l[data-dep-from="9001"]`)!
    expect(before.dataset.tip).toBe('Payments|Payments API')
    const next = host.querySelector<HTMLElement>(`.dep-badge.r[data-dep-to="9002"]`)!
    expect(next.dataset.tip).toBe('Billing|Billing UI')
    // on the dependent's left edge — `<=`: on the 1st of a month the grid starts today, so both sit at x = 0
    expect(parseFloat(before.style.left)).toBeLessThanOrEqual(parseFloat(bar(a.id).style.left))
    expect(parseFloat(next.style.left)).toBeGreaterThan(parseFloat(bar(b.id).style.left) + parseFloat(bar(b.id).style.width) - 1) // on the prerequisite's right edge
    expect(host.querySelectorAll('g.dep')).toHaveLength(1) // only A -> B: no arrow for the two off-screen ends
  })

  // A deliverable in two workstreams (primary Platform, copy in Mobile) with an arrow to B.
  function copiesScene() {
    const r = newRoadmap(['Platform', 'Mobile'])
    const [p, m] = [ws(r, 'Platform'), ws(r, 'Mobile')]
    const a = addDeliverable(r, { start: t, end: t + 19, in: [[p, 0], [m, 0]] })
    const b = addDeliverable(r, { start: t + 24, end: t + 44, in: [[p, 1]] })
    addDependency(r, a, b)
    return { r, a, b }
  }

  it('REQ_FE_017 copies switched off are not in the DOM at all and give their row back; a multi-workstream deliverable is then one block, the primary one', async () => {
    await step('copies switched off are not in the DOM at all, and give their row back', () => {
      const { r } = build()
      render({ roadmap: r, dupsOn: false })
      expect(host.querySelectorAll('.deliverable.dup')).toHaveLength(0)
      expect(host.querySelector<HTMLElement>('.band[data-ws="Mobile"]')!.dataset.rows).toBe('1')
    })

    await step('with copies off a multi-workstream deliverable is one block, the primary one', () => {
      if (root) {
        act(() => root!.unmount())
        root = null
        host.remove()
      }
      const { r, a } = copiesScene()
      render({ roadmap: r, dupsOn: false })
      const blocks = host.querySelectorAll<HTMLElement>(`.deliverable[data-deliverable="${a.id}"]`)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].classList.contains('dup')).toBe(false)
    })
  })

  it('REQ_DEP_014 REQ_DEP_009 with arrows on (the page forces copies off) each deliverable is drawn once, in its main workstream only, and an arrow attaches to the one block of each end', async () => {
    await step('each deliverable is drawn once, in its main workstream only', async () => {
      const { r, a, b } = copiesScene()
      render({ roadmap: r, dupsOn: false, showDependencies: true })
      for (const d of [a, b]) expect(host.querySelectorAll(`.deliverable[data-deliverable="${d.id}"]`)).toHaveLength(1)
      expect(bar(a.id).dataset.ws).toBe('Platform') // its main workstream, not Mobile
      expect(host.querySelectorAll('.deliverable.dup')).toHaveLength(0)
    })
    act(() => root!.unmount())
    await step('with copies off an arrow attaches to the one block of each end', async () => {
      const { r, a, b } = copiesScene()
      render({ roadmap: r, dupsOn: false, showDependencies: true })
      const x1 = parseFloat(bar(a.id).style.left) + parseFloat(bar(a.id).style.width)
      expect(pathOf(a.id, b.id).startsWith(`M${x1},`)).toBe(true)
      expect(pathOf(a.id, b.id).endsWith(` H${parseFloat(bar(b.id).style.left)}`)).toBe(true)
    })
  })

  it('REQ_DEP_005 a dependent\'s start stops at a dashed limit line at the earliest allowed day (the day after its prerequisite ends); moving the whole dependent stops at the limit too, keeping its length', async () => {
    await step('a dependent\'s start stops at a dashed limit line at the earliest allowed day (the day after its prerequisite ends)', async () => {
      const { r, b } = depScene()
      const onPatchDeliverable = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, onPatchDeliverable })
      const left0 = parseFloat(bar(b.id).style.left)
      await dragFrom(bar(b.id).querySelector('.rz.l')!, -10, true)
      const line = host.querySelector<HTMLElement>('.dep-limit')!
      expect(parseFloat(line.style.left)).toBeCloseTo(left0 - 4 * px) // t+20, four days before B's start
      expect(parseFloat(bar(b.id).style.left)).toBeCloseTo(left0 - 4 * px) // the bar is stopped on it
      fire(bar(b.id), 'pointerup', 500 - 10 * px, 10)
      await act(async () => {})
      expect(onPatchDeliverable.mock.calls).toEqual([[b.id, { start_date: isoOf(t + 20), end_date: isoOf(t + 44) }]])
      expect(host.querySelector('.dep-limit')).toBeNull()
    })
    act(() => root!.unmount())
    await step('moving the whole dependent stops at the limit too, keeping its length', async () => {
      const { r, b } = depScene()
      const onPatchDeliverable = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, onPatchDeliverable })
      await dragFrom(bar(b.id), -10)
      expect(onPatchDeliverable.mock.calls).toEqual([[b.id, { start_date: isoOf(t + 20), end_date: isoOf(t + 40) }]])
    })
  })

  it('REQ_DEP_005 a prerequisite\'s end stops the day before its dependent starts', async () => {
    const { r, a } = depScene()
    const onPatchDeliverable = vi.fn().mockResolvedValue(undefined)
    render({ roadmap: r, onPatchDeliverable })
    await dragFrom(bar(a.id).querySelector('.rz.r')!, 10)
    expect(onPatchDeliverable.mock.calls).toEqual([[a.id, { start_date: isoOf(t), end_date: isoOf(t + 23) }]])
  })

  it('REQ_DEP_005 dateLimits from the caller still apply, tightened by the dependency limit', async () => {
    const { r, b } = depScene()
    const onPatchDeliverable = vi.fn().mockResolvedValue(undefined)
    render({ roadmap: r, onPatchDeliverable, dateLimits: () => ({ lo: t + 22, hi: null }) })
    await dragFrom(bar(b.id).querySelector('.rz.l')!, -10)
    expect(onPatchDeliverable.mock.calls).toEqual([[b.id, { start_date: isoOf(t + 22), end_date: isoOf(t + 44) }]])
  })

  // The real stylesheet, injected so jsdom's getComputedStyle cascades it. jsdom does no layout, so
  // positions are read from the computed offsets (left/right/width) relative to the bar's own edge,
  // which is exactly what the browser lays out for absolutely positioned children.
  function withStylesheet() {
    const style = document.createElement('style')
    style.textContent = readFileSync('src/timeline/timeline.css', 'utf8')
    document.head.appendChild(style)
    return () => style.remove()
  }
  const px_ = (v: string) => parseFloat(v)
  // [from, to] of a child's span measured from the bar's left edge (or, for right-side children, from its right edge inwards).
  function span(el: Element, side: 'l' | 'r') {
    const cs = getComputedStyle(el)
    const off = px_(side === 'l' ? cs.left : cs.right)
    const w = px_(cs.width)
    return { from: off, to: off + w }
  }

  it('REQ_DEP_017 REQ_DEP_027 REQ_DEP_020 connector dots appear only for editors with arrows on, two per bar or marker, with a crosshair cursor, about 14px inside the edge and clear of the resize zone', async () => {
    await step('dots appear only for editors with arrows on, two per bar, with a crosshair cursor', async () => {
      const { r, a } = depScene()
      const cleanup = withStylesheet()
      render({ roadmap: r, showDependencies: true, onCreateDependency: vi.fn(), onPatchDeliverable: vi.fn() })
      const dots = bar(a.id).querySelectorAll('.cdot')
      expect([...dots].map((d) => d.className).sort()).toEqual(['cdot l', 'cdot r'])
      for (const d of dots) expect(getComputedStyle(d).cursor).toBe('crosshair')
      act(() => root!.unmount())
      render({ roadmap: r, onCreateDependency: vi.fn() }) // arrows off: no dots
      expect(host.querySelectorAll('.cdot')).toHaveLength(0)
      cleanup()
    })
    act(() => root!.unmount())
    await step('each dot is centred about 14px inside its edge and never overlaps the resize zone', async () => {
      const { r, a } = depScene()
      const cleanup = withStylesheet()
      render({ roadmap: r, showDependencies: true, onCreateDependency: vi.fn(), onPatchDeliverable: vi.fn() })
      for (const side of ['l', 'r'] as const) {
        const dot = span(bar(a.id).querySelector(`.cdot.${side}`)!, side)
        const zone = span(bar(a.id).querySelector(`.rz.${side}`)!, side)
        expect((dot.from + dot.to) / 2).toBeCloseTo(14, 0) // centre ~14px in
        expect(dot.from, `${side}: dot starts inside the resize zone's far edge`).toBeGreaterThanOrEqual(zone.to)
      }
      cleanup()
    })
    act(() => root!.unmount())
    await step('milestone markers have two connector dots for editors with arrows on; read-only visitors and arrows-off get none', async () => {
      const { r, m } = msDepScene()
      const cleanup = withStylesheet()
      render({ roadmap: r, showDependencies: true, onCreateDependency: vi.fn(), onPatchMilestone: vi.fn() })
      const dots = msEl(m.id).querySelectorAll('.cdot')
      expect([...dots].map((d) => d.className).sort()).toEqual(['cdot l', 'cdot r'])
      for (const d of dots) expect(getComputedStyle(d).cursor).toBe('crosshair')
      act(() => root!.unmount())
      render({ roadmap: r, canEdit: false, showDependencies: true, onCreateDependency: vi.fn(), onPatchMilestone: vi.fn() })
      expect(host.querySelectorAll('.cdot')).toHaveLength(0)
      act(() => root!.unmount())
      render({ roadmap: r, onCreateDependency: vi.fn() }) // arrows off
      expect(host.querySelectorAll('.cdot')).toHaveLength(0)
      cleanup()
    })
  })

  it('REQ_DEP_016 the resize zone at each edge is about 6px wide with a two-sided arrow cursor, and only editors get it', () => {
    const { r, a } = depScene()
    const cleanup = withStylesheet()
    render({ roadmap: r, showDependencies: true, onCreateDependency: vi.fn(), onPatchDeliverable: vi.fn() })
    for (const side of ['l', 'r'] as const) {
      const zone = bar(a.id).querySelector(`.rz.${side}`)!
      const cs = getComputedStyle(zone)
      expect(px_(cs.width)).toBeGreaterThanOrEqual(5)
      expect(px_(cs.width)).toBeLessThanOrEqual(7)
      expect(cs.cursor).toBe('ew-resize')
      const { from, to } = span(zone, side)
      expect(from).toBeLessThanOrEqual(0) // the zone starts at (or just outside) the bar's edge…
      expect(to).toBeGreaterThan(4) // …and reaches about 5-6px in
      expect(to).toBeLessThanOrEqual(7)
    }
    act(() => root!.unmount())
    render({ roadmap: r, canEdit: false, showDependencies: true })
    expect(host.querySelectorAll('.rz')).toHaveLength(0)
    cleanup()
  })

  // REQ_FE_050, structural half: which block is the main one and which the copy, and that the copy says
  // so. jsdom can't resolve the stylesheet's `var()`/color-mix shorthands, so the dashed, paler look is
  // checked in the real browser (web/e2e/04-dependencies.spec.ts, "REQ_FE_050").
  it('REQ_FE_010 REQ_FE_050 renders one .deliverable per (deliverable, workstream) with data-deliverable/ws/row/status; copies carry .dup; the main block is in the deliverable\'s main workstream with no copy marker and the copy names the main workstream', async () => {
    await step('renders one .deliverable per (deliverable, workstream) with data-deliverable/ws/row/status; copies carry .dup', () => {
      const { r, ids } = build()
      render({ roadmap: r })
      const bars = [...host.querySelectorAll<HTMLElement>('.deliverable')]
      expect(bars.map((b) => `${b.dataset.deliverable}|${b.dataset.ws}|${b.dataset.row}|${b.dataset.status}|${b.classList.contains('dup')}`).sort()).toEqual(
        [`${ids.multi}|Platform|0|at_risk|false`, `${ids.multi}|Mobile|1|at_risk|true`, `${ids.solo}|Mobile|0|in_progress|false`].sort(),
      )
      const ms = host.querySelector<HTMLElement>('.ms')!
      expect([ms.dataset.ms, ms.dataset.ws, ms.dataset.row]).toEqual([String(ids.ms), 'Platform', '0'])
      expect([...host.querySelectorAll<HTMLElement>('.band')].map((b) => `${b.dataset.ws}:${b.dataset.rows}`)).toEqual(['Platform:1', 'Mobile:2'])
    })

    await step('the main block is in the deliverable\'s main workstream with no copy marker; the copy is .dup and names the main workstream', () => {
      if (root) {
        act(() => root!.unmount())
        root = null
        host.remove()
      }
      const { r, a } = copiesScene()
      render({ roadmap: r, dupsOn: true })
      const main = bar(a.id)
      const copies = host.querySelectorAll<HTMLElement>(`.deliverable.dup[data-deliverable="${a.id}"]`)
      expect(copies).toHaveLength(1)
      expect([main.dataset.ws, copies[0].dataset.ws]).toEqual(['Platform', 'Mobile'])
      expect(main.classList.contains('dup')).toBe(false)
      expect(copies[0].title).toContain('(also in Platform)')
      expect(main.title).not.toContain('also in')
    })
  })

  it('REQ_DEP_018 the right dot means "this blocks…" and the left dot "…depends on": click a dot, then another bar, and onCreateDependency fires with the dependent and the prerequisite the right way round', async () => {
    await step('the right dot means "this blocks…": click it, then another bar, and onCreateDependency(this, other) fires', async () => {
      const { r, a, c } = depScene()
      const onCreateDependency = vi.fn().mockResolvedValue(undefined)
      const onSelect = vi.fn()
      render({ roadmap: r, showDependencies: true, onCreateDependency, onPatchDeliverable: vi.fn(), onSelect })
      click(bar(a.id).querySelector('.cdot.r')!)
      expect(host.querySelector('.tl.connecting')).not.toBeNull()
      fire(host.querySelector('.tl-inner')!, 'pointermove', 400, 30)
      expect(host.querySelector('.dep-rubber')!.getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+ H[\d.]+ V30 H400$/) // a rubber band follows the pointer
      click(bar(c.id))
      await act(async () => {})
      expect(onCreateDependency.mock.calls).toEqual([[{ kind: 'deliverable', id: a.id }, { kind: 'deliverable', id: c.id }]])
      expect(onSelect).not.toHaveBeenCalled()
      expect(host.querySelector('.tl.connecting')).toBeNull()
      expect(host.querySelector('.dep-rubber')).toBeNull()
    })
    act(() => root!.unmount())
    await step('the left dot means "…depends on": the clicked bar is the dependent', async () => {
      const { r, a, c } = depScene()
      const onCreateDependency = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, showDependencies: true, onCreateDependency, onPatchDeliverable: vi.fn() })
      click(bar(c.id).querySelector('.cdot.l')!)
      click(bar(a.id))
      await act(async () => {})
      expect(onCreateDependency.mock.calls).toEqual([[{ kind: 'deliverable', id: a.id }, { kind: 'deliverable', id: c.id }]]) // A is the prerequisite of C
    })
  })

  it('REQ_DEP_018 the dots work from the keyboard: each is focusable, Enter or Space on it starts connect mode, and Enter on another bar completes it', async () => {
    const { r, a, c } = depScene()
    const onCreateDependency = vi.fn().mockResolvedValue(undefined)
    const onSelect = vi.fn()
    render({ roadmap: r, showDependencies: true, onCreateDependency, onPatchDeliverable: vi.fn(), onSelect })
    const press = (el: Element, key: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    for (const dot of host.querySelectorAll('.cdot')) expect(dot.getAttribute('tabindex')).toBe('0')
    press(bar(a.id).querySelector('.cdot.r')!, 'Enter')
    expect(host.querySelector('.tl.connecting')).not.toBeNull()
    expect(document.activeElement).toBe(bar(a.id)) // the dot hides in connect mode; focus stays on its bar
    press(bar(c.id), 'Enter')
    await act(async () => {})
    expect(onCreateDependency.mock.calls).toEqual([[{ kind: 'deliverable', id: a.id }, { kind: 'deliverable', id: c.id }]])
    expect(onSelect).not.toHaveBeenCalled()
    press(bar(c.id).querySelector('.cdot.l')!, ' ')
    expect(host.querySelector('.tl.connecting')).not.toBeNull()
  })

  it('REQ_DEP_018 Esc, a click on empty space, or a click on the same bar (or the milestone whose dot started the connection) cancels without creating anything', async () => {
    await step('Esc, a click on empty space, or a click on the same bar cancels without creating anything', async () => {
      const { r, a } = depScene()
      const onCreateDependency = vi.fn()
      render({ roadmap: r, showDependencies: true, onCreateDependency, onPatchDeliverable: vi.fn() })
      const start = () => click(bar(a.id).querySelector('.cdot.r')!)
      start()
      keydown('Escape')
      expect(host.querySelector('.tl.connecting')).toBeNull()
      start()
      click(host.querySelector('.tl-inner')!)
      expect(host.querySelector('.tl.connecting')).toBeNull()
      start()
      click(bar(a.id))
      expect(onCreateDependency).not.toHaveBeenCalled()
    })
    act(() => root!.unmount())
    await step('clicking the milestone whose dot started the connection cancels it; a deliverable with the same number is another item', async () => {
      const { r, m } = msDepScene()
      const onCreateDependency = vi.fn()
      render({ roadmap: r, showDependencies: true, onCreateDependency, onPatchMilestone: vi.fn() })
      click(msEl(m.id).querySelector('.cdot.r')!)
      click(msEl(m.id))
      expect(onCreateDependency).not.toHaveBeenCalled()
    })
  })

  it('REQ_DEP_018 a rejected create says why instead of vanishing', async () => {
    const { r, a, c } = depScene()
    const err = Object.assign(new Error('x'), { response: { data: { error: { message: 'That would create a loop' } } } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render({ roadmap: r, showDependencies: true, onCreateDependency: vi.fn().mockRejectedValue(err), onPatchDeliverable: vi.fn() })
    click(bar(a.id).querySelector('.cdot.r')!)
    click(bar(c.id))
    await act(async () => {})
    expect(host.querySelector('.tl-notice')!.textContent).toBe('That would create a loop')
    spy.mockRestore()
  })

  it('REQ_DEP_019 REQ_DEP_027 an arrow is deleted by selecting it and pressing Delete, or by the × at its midpoint; an arrow with a milestone end passes both kinds', async () => {
    await step('an arrow is deleted by selecting it and pressing Delete, or by the × at its midpoint', async () => {
      const { r, a, b } = depScene()
      const onDeleteDependency = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, showDependencies: true, onDeleteDependency })
      keydown('Delete') // nothing selected yet
      expect(onDeleteDependency).not.toHaveBeenCalled()
      click(arrow(a.id, b.id)!.querySelector('.dep-hit')!)
      expect(arrow(a.id, b.id)!.classList.contains('sel')).toBe(true)
      keydown('Delete')
      await act(async () => {})
      expect(onDeleteDependency.mock.calls).toEqual([[{ kind: 'deliverable', id: a.id }, { kind: 'deliverable', id: b.id }]])
      over(arrow(a.id, b.id)!.querySelector('.dep-hit')!)
      const x = arrow(a.id, b.id)!.querySelector('.dep-x')!
      expect(x.getAttribute('transform')).toMatch(/^translate\([\d.]+,[\d.]+\)$/)
      click(x)
      expect(onDeleteDependency.mock.calls).toEqual([[{ kind: 'deliverable', id: a.id }, { kind: 'deliverable', id: b.id }], [{ kind: 'deliverable', id: a.id }, { kind: 'deliverable', id: b.id }]])
    })
    act(() => root!.unmount())
    await step('deleting an arrow that has a milestone end passes both kinds', async () => {
      const { r, a, b, m } = msDepScene()
      const onDeleteDependency = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, showDependencies: true, onDeleteDependency })
      click(kindArrow('deliverable', a.id, 'milestone', m.id)!.querySelector('.dep-hit')!)
      keydown('Delete')
      await act(async () => {})
      click(kindArrow('milestone', m.id, 'deliverable', b.id)!.querySelector('.dep-hit')!)
      click(host.querySelector('.dep-x')!)
      await act(async () => {})
      expect(onDeleteDependency.mock.calls).toEqual([
        [{ kind: 'deliverable', id: a.id }, { kind: 'milestone', id: m.id }],
        [{ kind: 'milestone', id: m.id }, { kind: 'deliverable', id: b.id }],
      ])
    })
  })

  it('REQ_DEP_020 read-only visitors see the arrows but no dots, no connect mode and no delete', () => {
    const { r, a, b } = depScene()
    const onDeleteDependency = vi.fn()
    render({ roadmap: r, canEdit: false, showDependencies: true, onCreateDependency: vi.fn(), onDeleteDependency, onPatchDeliverable: vi.fn() })
    expect(arrow(a.id, b.id)).not.toBeNull()
    expect(host.querySelectorAll('.cdot')).toHaveLength(0)
    click(arrow(a.id, b.id)!.querySelector('.dep-hit')!)
    over(arrow(a.id, b.id)!.querySelector('.dep-hit')!)
    expect(host.querySelector('.dep-x')).toBeNull()
    keydown('Delete')
    expect(onDeleteDependency).not.toHaveBeenCalled()
  })

  // ---- Phase 9: milestones as dependency ends (REQ_DEP_023–027) ----
  // Platform: A t..t+9 (row 1) -> M (milestone t+20, row 0) -> B t+30..t+40 (row 2); C t+50..t+70 (row 3), unrelated.
  function msDepScene() {
    const r = newRoadmap(['Platform'])
    const p = ws(r, 'Platform')
    const a = addDeliverable(r, { start: t, end: t + 9, in: [[p, 1]], name: 'A' })
    const b = addDeliverable(r, { start: t + 30, end: t + 40, in: [[p, 2]], name: 'B' })
    const c = addDeliverable(r, { start: t + 50, end: t + 70, in: [[p, 3]], name: 'C' })
    const m = addMilestone(r, { day: t + 20, in: p, row: 0, name: 'Beta' })
    addItemDependency(r, a, m)
    addItemDependency(r, m, b)
    return { r, p, a, b, c, m }
  }
  const msEl = (id: number) => host.querySelector<HTMLElement>(`.ms[data-ms="${id}"]`)!
  const kindArrow = (fk: string, from: number, tk: string, to: number) =>
    host.querySelector(`g.dep[data-dep-from-kind="${fk}"][data-dep-from="${from}"][data-dep-to-kind="${tk}"][data-dep-to="${to}"]`)

  it('REQ_DEP_027 an arrow runs from a deliverable\'s right edge to a milestone marker\'s left edge, and on from its right edge to the next deliverable; selecting a milestone highlights the arrows to and from it', async () => {
    await step('an arrow runs from a deliverable\'s right edge to a milestone marker\'s left edge, and on from its right edge to the next deliverable', async () => {
      const { r, a, b, m } = msDepScene()
      render({ roadmap: r, showDependencies: true })
      const into = kindArrow('deliverable', a.id, 'milestone', m.id)!
      const out = kindArrow('milestone', m.id, 'deliverable', b.id)!
      expect(into).not.toBeNull()
      expect(out).not.toBeNull()
      const dIn = into.querySelector('.dep-line')!.getAttribute('d')!
      const dOut = out.querySelector('.dep-line')!.getAttribute('d')!
      const aRight = parseFloat(bar(a.id).style.left) + parseFloat(bar(a.id).style.width)
      const mLeft = parseFloat(msEl(m.id).style.left)
      const mSize = parseFloat(msEl(m.id).style.width)
      expect(dIn.startsWith(`M${aRight},`)).toBe(true)
      expect(dIn.endsWith(` H${mLeft}`)).toBe(true)
      expect(dOut.startsWith(`M${mLeft + mSize},`)).toBe(true)
      expect(dOut.endsWith(` H${parseFloat(bar(b.id).style.left)}`)).toBe(true)
    })
    act(() => root!.unmount())
    await step('selecting a milestone highlights the arrows to and from it', async () => {
      const { r, a, b, m } = msDepScene()
      render({ roadmap: r, showDependencies: true, selected: { id: m.id, type: 'milestone' } })
      expect(kindArrow('deliverable', a.id, 'milestone', m.id)!.classList.contains('hl')).toBe(true)
      expect(kindArrow('milestone', m.id, 'deliverable', b.id)!.classList.contains('hl')).toBe(true)
    })
  })

  it('REQ_DEP_027 REQ_DEP_018 connect mode from a milestone\'s right dot to a deliverable, and from a deliverable\'s right dot to a milestone, passes the kinds', async () => {
    const { r, c, m } = msDepScene()
    const onCreateDependency = vi.fn().mockResolvedValue(undefined)
    render({ roadmap: r, showDependencies: true, onCreateDependency, onPatchMilestone: vi.fn(), onPatchDeliverable: vi.fn() })
    click(msEl(m.id).querySelector('.cdot.r')!)
    expect(host.querySelector('.tl.connecting')).not.toBeNull()
    click(bar(c.id)) // M blocks C
    await act(async () => {})
    click(bar(c.id).querySelector('.cdot.r')!)
    click(msEl(m.id)) // C blocks M
    await act(async () => {})
    click(msEl(m.id).querySelector('.cdot.l')!)
    click(bar(c.id)) // M depends on C
    await act(async () => {})
    expect(onCreateDependency.mock.calls).toEqual([
      [{ kind: 'milestone', id: m.id }, { kind: 'deliverable', id: c.id }],
      [{ kind: 'deliverable', id: c.id }, { kind: 'milestone', id: m.id }],
      [{ kind: 'deliverable', id: c.id }, { kind: 'milestone', id: m.id }],
    ])
  })

  it('REQ_DEP_005 REQ_DEP_026 a milestone dragged earlier stops at a dashed limit line the day after its prerequisite ends, dragged later the day before its dependent starts, and with no dependency it moves freely', async () => {
    await step('a milestone dragged earlier stops at a dashed limit line the day after its prerequisite ends', async () => {
      const { r, m } = msDepScene()
      const onPatchMilestone = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, onPatchMilestone })
      const left0 = parseFloat(msEl(m.id).style.left)
      const y0 = parseFloat(msEl(m.id).style.top) + 4
      fire(msEl(m.id), 'pointerdown', 500, y0)
      fire(msEl(m.id), 'pointermove', 500 - 5 * px, y0)
      fire(msEl(m.id), 'pointermove', 500 - 30 * px, y0)
      const line = host.querySelector<HTMLElement>('.dep-limit')!
      const size = parseFloat(msEl(m.id).style.width)
      expect(parseFloat(line.style.left)).toBeCloseTo(left0 + (size - px) / 2 - 10 * px) // the left edge of day t+10, the day after A ends on t+9 (the marker is centred on its day)
      expect(parseFloat(msEl(m.id).style.left)).toBeCloseTo(left0 - 10 * px) // the marker is stopped on it
      fire(msEl(m.id), 'pointerup', 500 - 30 * px, y0)
      await act(async () => {})
      expect(onPatchMilestone.mock.calls).toEqual([[m.id, { date: isoOf(t + 10) }]])
      expect(host.querySelector('.dep-limit')).toBeNull()
    })
    act(() => root!.unmount())
    await step('a milestone dragged later stops the day before its dependent starts', async () => {
      const { r, m } = msDepScene()
      const onPatchMilestone = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, onPatchMilestone })
      await dragMs(m.id, 30)
      expect(onPatchMilestone.mock.calls).toEqual([[m.id, { date: isoOf(t + 29) }]])
    })
    act(() => root!.unmount())
    await step('a milestone with no dependency moves freely, and dependencies bind it through edges to other roadmaps too', async () => {
      const r = newRoadmap(['Platform'])
      const p = ws(r, 'Platform')
      const m = addMilestone(r, { day: t + 20, in: p, row: 0, name: 'Free' })
      const onPatchMilestone = vi.fn().mockResolvedValue(undefined)
      render({ roadmap: r, onPatchMilestone })
      await dragMs(m.id, -15)
      expect(onPatchMilestone.mock.calls).toEqual([[m.id, { date: isoOf(t + 5) }]])
      act(() => root!.unmount())
      // an end on another roadmap: a deliverable of another team ending on t+12 is this milestone's prerequisite
      const foreign = { kind: 'deliverable' as const, id: 9001, name: 'Elsewhere', team_name: 'Other', roadmap_id: r.id + 100, start_date: isoOf(t), end_date: isoOf(t + 12) }
      r.dependencies.push({ from_kind: 'deliverable', to_kind: 'milestone', from_id: 9001, to_id: m.id, from: foreign, to: { kind: 'milestone', id: m.id, name: m.name, team_name: 'T', roadmap_id: r.id, start_date: m.date, end_date: m.date } })
      onPatchMilestone.mockClear()
      render({ roadmap: r, onPatchMilestone })
      await dragMs(m.id, -15)
      expect(onPatchMilestone.mock.calls).toEqual([[m.id, { date: isoOf(t + 13) }]])
    })
  })
})
