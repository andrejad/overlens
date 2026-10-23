// The Timeline's company-view support (Phase 7): team tags (REQ_FE_054), merged rows (REQ_FE_052/095/097), the
// company axis (REQ_FE_093), opening on today (REQ_FE_069), trace removal (REQ_DEP_021).
// jsdom has no layout; positions are read from inline styles, as in Timeline.test.tsx.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fmtDay, gridFor, isoOf, localDay, pxPerDay, todayX, ZOOMS } from './axis'
import { applyTrace, companyGrid, mergeByWorkstreamName, type MergedView } from './company'
import { tagWidth } from './geometry'
import { Timeline, type TimelineProps } from './Timeline'
import { addDeliverable, addDependency, addMilestone, companyTeam, ws } from './testkit'
import { step } from '../testSteps'

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

function mount(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
}
const base = { zoom: 'year', dupsOn: true, canEdit: true, onSelect: () => {} } as const
function render(props: Partial<TimelineProps> & Pick<TimelineProps, 'roadmap'>) {
  mount(<Timeline {...base} {...props} />)
}
function renderMerged(v: MergedView, props: Partial<TimelineProps> = {}) {
  render({ roadmap: v.roadmap, merged: v, teamTags: v.tags, ...props })
}
const bar = (id: number) => host.querySelector<HTMLElement>(`.deliverable[data-deliverable="${id}"]`)!

// ONB: Platform, Mobile.  PLT: Platform only.
function scene() {
  const onb = companyTeam('Onboarding', 'ONB', ['Platform', 'Mobile'])
  const plt = companyTeam('Platform team', 'PLT', ['platform'])
  const [ro, rp] = [onb.roadmap!, plt.roadmap!]
  const a = addDeliverable(ro, { start: t, end: t + 40, in: [[ws(ro, 'Platform'), 0]], name: 'A' })
  const b = addDeliverable(rp, { start: t + 60, end: t + 100, in: [[ws(rp, 'platform'), 0]], name: 'B' })
  const m = addMilestone(ro, { day: t + 50, in: ws(ro, 'Platform'), row: 0, name: 'Launch' })
  const teams = [onb, plt]
  return { teams, onb, plt, a, b, m, view: mergeByWorkstreamName(teams, ['Platform', 'Mobile']) }
}

describe('REQ_FE_054 team tag on every block', () => {
  it('REQ_FE_054 a bar wide enough to show it carries its team tag at its left edge, before the name, at every zoom level; copies carry the tag too', async () => {
    await step('a bar wide enough to show it carries its team tag at its left edge, before the name, at every zoom level', () => {
      const { view, a, b } = scene()
      for (const zoom of ZOOMS) {
        renderMerged(view, { zoom })
        for (const [id, tag] of [[a.id, 'ONB'], [b.id, 'PLT']] as const) {
          const el = bar(id)
          expect(el.querySelector('.team-tag')!.textContent, zoom).toBe(tag)
          expect(el.firstElementChild!.classList.contains('team-tag'), zoom).toBe(true)
          expect(el.dataset.tag).toBe(tag)
          expect(el.title.startsWith(`${tag} · `)).toBe(true)
        }
        act(() => root!.unmount())
        host.remove()
      }
      root = null
    })

    await step('copies carry the tag too; without teamTags nothing changes (no tag, no data-tag, plain title)', () => {
      act(() => root?.unmount())
      root = null
      host?.remove()
      const r = companyTeam('T', 'TTT', ['Platform', 'Mobile']).roadmap!
      const d = addDeliverable(r, { start: t, end: t + 60, in: [[ws(r, 'Platform'), 0], [ws(r, 'Mobile'), 0]] })
      render({ roadmap: r, teamTags: new Map([[d.id, 'TTT']]) })
      expect([...host.querySelectorAll('.deliverable .team-tag')].map((e) => e.textContent)).toEqual(['TTT', 'TTT'])
      act(() => root!.unmount())
      host.remove()
      render({ roadmap: r })
      expect(host.querySelector('.team-tag')).toBeNull()
      expect(bar(d.id).dataset.tag).toBeUndefined()
      expect(bar(d.id).title.startsWith('TTT')).toBe(false)
    })
  })
  // The exact rule (CONTRACT.md): the tag is rendered iff the bar is at least tagWidth(tag) + 2 borders wide.
  // Below that it is left out of the bar and only the hover title / data-tag carry it. A bar showing its tag
  // loses its padding (`snug`) before its width drops under tagWidth + 3 + 22; its name just shrinks.
  it('REQ_FE_054 narrow bars: the tag shows wherever the bar is wide enough, only when it fits (tiny never), else the title and data-tag carry it; the name is shortened before the tag is hidden', async () => {
    await step('narrow bars: the tag shows wherever the bar is wide enough, only when it fits (tiny never), else the title and data-tag carry it; snug/tiny keep their meaning', () => {
      const px = pxPerDay('year', 1000)
      const r = companyTeam('T', 'ONB', ['Platform']).roadmap!
      const p = ws(r, 'Platform')
      const days = [2, 8, 14, 30]
      let at = t
      const ds = days.map((n) => {
        const d = addDeliverable(r, { start: at, end: at + n - 1, in: [[p, 0]] })
        at += n + 5
        return d
      })
      render({ roadmap: r, teamTags: new Map(ds.map((d) => [d.id, 'ONB'])) })
      const need = tagWidth('ONB') + 3
      ds.forEach((d, i) => {
        const w = parseFloat(bar(d.id).style.width)
        const hasTag = !!bar(d.id).querySelector('.team-tag')
        expect(hasTag, `${days[i]} days = ${w}px`).toBe(w >= need)
        expect(bar(d.id).title.startsWith('ONB · ')).toBe(true)
        expect(bar(d.id).classList.contains('tiny')).toBe(w < 14)
        expect(bar(d.id).classList.contains('snug')).toBe(w < (hasTag ? need + 22 : 30))
        if (w < 14) expect(hasTag).toBe(false)
      })
      expect(days.map((n) => n * px >= need)).toEqual([false, false, true, true]) // the cases above really straddle the threshold
    })

    await step('the name is shortened before the tag is hidden: the tag cannot shrink, the name can (css)', () => {
      act(() => root?.unmount())
      root = null
      host?.remove()
      const css = readFileSync('src/timeline/timeline.css', 'utf8')
      expect(css).toMatch(/\.deliverable \.team-tag\s*\{[^}]*flex:\s*none/)
      expect(css).toMatch(/\.deliverable \.name\s*\{[^}]*min-width:\s*0/)
      expect(css).toMatch(/\.deliverable \.name\s*\{[^}]*text-overflow:\s*ellipsis/)
    })
  })

  it('REQ_FE_054 REQ_FE_010 the tag never changes a bar\'s box: same left and width with and without it', () => {
    const { view } = scene()
    renderMerged(view)
    const box = (): string[] => [...host.querySelectorAll<HTMLElement>('.deliverable')].map((e) => `${e.dataset.deliverable}:${e.style.left}:${e.style.width}:${e.style.top}`)
    const withTags = box()
    act(() => root!.unmount())
    host.remove()
    renderMerged(view, { teamTags: undefined })
    expect(box()).toEqual(withTags)
  })
})

describe('REQ_FE_052 merged rows', () => {
  it('REQ_FE_052 REQ_FE_095 one band per merged row in the given order; the label counts teams, deliverables and milestones (none: left out); the milestone part is plural from two milestones on', async () => {
    await step('one band per merged row in the given order; the label counts teams, deliverables and milestones (none: left out)', () => {
      const { view } = scene()
      renderMerged(view)
      // Mobile holds nothing, so its row is left out (REQ_FE_127)
      expect([...host.querySelectorAll<HTMLElement>('.band')].map((b) => b.dataset.ws)).toEqual(['Platform'])
      expect([...host.querySelectorAll('.ws-label .count')].map((e) => e.textContent)).toEqual(['2 teams · 2 deliverables · 1 milestone'])
      expect(host.querySelectorAll('.band[data-ws="Platform"]')).toHaveLength(1)
      expect([...host.querySelectorAll('.deliverable')].map((e) => (e as HTMLElement).dataset.ws)).toEqual(['Platform', 'Platform'])
    })

    await step('the milestone part of a row label is plural from two milestones on', () => {
      act(() => root?.unmount())
      root = null
      host?.remove()
      const { teams, onb } = scene()
      addMilestone(onb.roadmap!, { day: t + 120, in: ws(onb.roadmap!, 'Platform'), row: 0 })
      renderMerged(mergeByWorkstreamName(teams, ['Platform', 'Mobile']))
      expect(host.querySelector('.ws-label .count')!.textContent).toBe('2 teams · 2 deliverables · 2 milestones')
    })
  })

  it('REQ_FE_127 a merged row no team has anything in is left out; a copy keeps its row, with copies on or off', async () => {
    await step('a merged row no team has anything in is left out', () => {
      renderMerged(scene().view)
      expect(host.querySelector('.band[data-ws="Mobile"]')).toBeNull()
      expect(host.querySelector('.ws-label .name[title="Mobile"]')).toBeNull()
    })

    await step('a copy keeps its row, with copies on or off', () => {
      for (const dupsOn of [true, false]) {
        act(() => root?.unmount())
        root = null
        host?.remove()
        const { teams, onb } = scene()
        const r = onb.roadmap!
        addDeliverable(r, { start: t + 120, end: t + 140, in: [[ws(r, 'Platform'), 1], [ws(r, 'Mobile'), 0]] })
        renderMerged(mergeByWorkstreamName(teams, ['Platform', 'Mobile']), { dupsOn })
        expect([...host.querySelectorAll<HTMLElement>('.band')].map((b) => b.dataset.ws), `dupsOn ${dupsOn}`).toEqual(['Platform', 'Mobile'])
        expect(host.querySelectorAll('.deliverable[data-ws="Mobile"]'), `dupsOn ${dupsOn}`).toHaveLength(dupsOn ? 1 : 0)
      }
    })
  })

  it('REQ_FE_011 REQ_FE_096 rows that clash across teams are packed on screen but never saved', () => {
    const onb = companyTeam('Onboarding', 'ONB', ['Platform'])
    const plt = companyTeam('Platform team', 'PLT', ['platform'])
    addDeliverable(onb.roadmap!, { start: t, end: t + 30, in: [[ws(onb.roadmap!, 'Platform'), 0]] })
    addDeliverable(plt.roadmap!, { start: t + 10, end: t + 40, in: [[ws(plt.roadmap!, 'platform'), 0]] }) // same stored row, overlapping days
    const onPatchDeliverable = vi.fn()
    renderMerged(mergeByWorkstreamName([onb, plt], ['Platform']), { onPatchDeliverable, onPatchMilestone: vi.fn() })
    expect(host.querySelector<HTMLElement>('.band')!.dataset.rows).toBe('2')
    expect(onPatchDeliverable).not.toHaveBeenCalled()
  })

  it('REQ_FE_096 clicking a block selects the real deliverable id; the three-dot button edits it', () => {
    const { view, b } = scene()
    const onSelect = vi.fn()
    const onEdit = vi.fn()
    renderMerged(view, { onSelect, onEdit })
    act(() => bar(b.id).click())
    act(() => bar(b.id).querySelector<HTMLElement>('.more')!.click())
    expect(onSelect).toHaveBeenCalledWith(b.id, 'deliverable')
    expect(onEdit).toHaveBeenCalledWith(b.id)
  })

  it('REQ_FE_097 an edited milestone shows in place at once when the view is rebuilt from the saved data', () => {
    const { teams, onb, m } = scene()
    renderMerged(mergeByWorkstreamName(teams, ['Platform', 'Mobile']))
    expect(host.querySelector<HTMLElement>(`.ms[data-ms="${m.id}"]`)!.title).toContain(fmtDay(t + 50))
    const mobile = ws(onb.roadmap!, 'Mobile').id
    onb.roadmap!.milestones = onb.roadmap!.milestones.map((x) => (x.id === m.id ? { ...x, date: isoOf(t + 70), workstream_id: mobile, row: 0 } : x))
    const v2 = mergeByWorkstreamName(teams, ['Platform', 'Mobile'])
    act(() => root!.render(<Timeline {...base} roadmap={v2.roadmap} merged={v2} teamTags={v2.tags} />))
    const el = host.querySelector<HTMLElement>(`.ms[data-ms="${m.id}"]`)!
    expect(el.dataset.ws).toBe('Mobile')
    expect(el.title).toContain(fmtDay(t + 70))
  })

})

describe('REQ_FE_093 the company axis', () => {
  it('REQ_FE_093 REQ_FE_065 the merged view draws on the company grid, also when what it shows (a trace) is shorter', () => {
    const { teams, view, a } = scene()
    const own = gridFor(t, t + 40, t)
    const shared = companyGrid(teams, t)
    expect(shared.days).toBeGreaterThan(own.days)
    renderMerged(applyTrace(view, new Set([a.id])), { sharedGrid: shared })
    const dayPx = pxPerDay('year', 1000)
    expect(parseFloat(host.querySelector<HTMLElement>('.tl-inner')!.style.width)).toBeCloseTo(shared.days * dayPx)
    expect(host.querySelector<HTMLElement>('.tl-header')!.style.width).toBe(host.querySelector<HTMLElement>('.tl-inner')!.style.width)
  })
})

// jsdom has no layout: clientWidth and scrollLeft (with a clamp) are simulated for the scroll tests below.
describe('REQ_FE_069 the company view opens on today', () => {
  // scrollLeft backed by a store and clamped to a per-element maximum, like a browser's.
  const store = new WeakMap<Element, number>()
  const maxOf = new WeakMap<Element, number>()
  let frames: (() => void)[] = []
  const realScrollLeft = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
  const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn))
    Object.defineProperty(Element.prototype, 'scrollLeft', {
      configurable: true,
      get(this: Element) {
        return store.get(this) ?? 0
      },
      set(this: Element, v: number) {
        store.set(this, Math.max(0, Math.min(v, maxOf.get(this) ?? Infinity)))
      },
    })
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
  })
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    host?.remove()
    vi.unstubAllGlobals()
    if (realScrollLeft) Object.defineProperty(Element.prototype, 'scrollLeft', realScrollLeft)
    else delete (Element.prototype as { scrollLeft?: number }).scrollLeft
    if (realClientWidth) Object.defineProperty(Element.prototype, 'clientWidth', realClientWidth)
  })

  function twoTeams() {
    const onb = companyTeam('Onboarding', 'ONB', ['Platform'])
    const plt = companyTeam('Platform team', 'PLT', ['Platform'])
    const a = addDeliverable(onb.roadmap!, { start: t - 200, end: t - 150, in: [[ws(onb.roadmap!, 'Platform'), 0]], name: 'A' })
    const b = addDeliverable(plt.roadmap!, { start: t + 150, end: t + 200, in: [[ws(plt.roadmap!, 'Platform'), 0]], name: 'B' })
    return { teams: [onb, plt], onb, plt, a, b }
  }

  const scroller = () => host.querySelector<HTMLElement>('.tl-scroll')!
  const expectedStart = (teams: ReturnType<typeof twoTeams>['teams'], zoom: TimelineProps['zoom'] = 'year') => {
    const view = { ...companyGrid(teams, t), px: pxPerDay(zoom, 1000) }
    return Math.max(0, (todayX(view, t) ?? 0) - 1000 / 3)
  }

  it('REQ_FE_069 the company view opens on today (a third in), not at the left edge, exactly as a team roadmap with that grid does; a new zoom level reopens on today', () => {
    const { teams, onb } = twoTeams()
    const view = mergeByWorkstreamName(teams, [])
    const grid = companyGrid(teams, t)
    renderMerged(view, { sharedGrid: grid })
    const want = expectedStart(teams)
    expect(want).toBeGreaterThan(0) // today is not at the very left of this grid, so 0 would be wrong
    expect(scroller().scrollLeft).toBeCloseTo(want, 3)
    act(() => root!.render(<Timeline {...base} zoom="quarter" roadmap={view.roadmap} merged={view} teamTags={view.tags} sharedGrid={grid} />))
    expect(scroller().scrollLeft).toBeCloseTo(expectedStart(teams, 'quarter'), 3)
    act(() => root!.unmount())
    host.remove()
    mount(<Timeline {...base} roadmap={onb.roadmap!} sharedGrid={grid} />)
    expect(scroller().scrollLeft).toBeCloseTo(want, 3)
  })

  it('REQ_DEP_022 an off-screen chain member is a chevron badge on the trace, never an arrow: the badge sits on the on-screen end with team and name; with arrows off there is no badge either', async () => {
    await step('the badge sits on the on-screen end with team and name, and no arrow runs to the off-screen end', () => {
      const { teams, a, b, plt } = twoTeams()
      const gone = { id: 999, name: 'Gone', team_name: 'Old team', roadmap_id: 4242, start_date: isoOf(t + 300), end_date: isoOf(t + 310) }
      addDependency(plt.roadmap!, b, gone) // B blocks Gone (off-screen end)
      addDependency(teams[0].roadmap!, a, { ...b, team_name: 'Platform team' } as never) // an on-screen edge stays an arrow
      const tv = applyTrace(mergeByWorkstreamName(teams, []), new Set([b.id, gone.id]))
      expect(tv.roadmap.dependencies.map((e) => e.to_id)).toContain(999) // the edge to the off-screen end is kept
      renderMerged(tv, { sharedGrid: companyGrid(teams, t), showDependencies: true })
      const badge = host.querySelector<HTMLElement>('.dep-badge[data-dep-from="' + b.id + '"][data-dep-to="999"]')!
      expect(badge).not.toBeNull()
      expect(badge.classList.contains('r')).toBe(true) // B blocks something that is not here
      expect(badge.dataset.tip).toBe('Old team|Gone')
      expect(badge.getAttribute('aria-label')).toBe('Blocks Gone (Old team)')
      const bar = host.querySelector<HTMLElement>(`.deliverable[data-deliverable="${b.id}"]`)!
      expect(parseFloat(badge.style.left)).toBeCloseTo(parseFloat(bar.style.left) + parseFloat(bar.style.width) + 4, 3) // right at B's end
      expect(host.querySelector('g.dep[data-dep-to="999"]')).toBeNull() // nothing is drawn as an arrow to it
      expect(host.querySelectorAll('g.dep')).toHaveLength(0)
    })

    await step('with arrows off there is no badge either', () => {
      act(() => root?.unmount())
      root = null
      host?.remove()
      const { teams, b, plt } = twoTeams()
      addDependency(plt.roadmap!, b, { id: 999, name: 'Gone', team_name: 'Old', roadmap_id: 4242, start_date: isoOf(t + 300), end_date: isoOf(t + 310) })
      renderMerged(applyTrace(mergeByWorkstreamName(teams, []), new Set([b.id, 999])), { sharedGrid: companyGrid(teams, t) })
      expect(host.querySelector('.dep-badge')).toBeNull()
    })
  })
})

describe('REQ_DEP_021 trace removes items from the DOM', () => {
  function traced() {
    const s = scene()
    const ro = s.onb.roadmap!
    const c = addDeliverable(ro, { start: t + 110, end: t + 120, in: [[ws(ro, 'Mobile'), 0]], name: 'C' }) // unrelated
    const d = addDeliverable(ro, { start: t + 130, end: t + 140, in: [[ws(ro, 'Mobile'), 0]], name: 'D' }) // another prerequisite of B
    addDependency(ro, s.a, s.b)
    addDependency(s.plt.roadmap!, d, s.b)
    const gone = { id: 999, name: 'Gone', team_name: 'Old', roadmap_id: 4242, start_date: isoOf(t + 200), end_date: isoOf(t + 210) }
    addDependency(s.plt.roadmap!, s.b, gone)
    return { ...s, c, d, gone, view: mergeByWorkstreamName([s.onb, s.plt], ['Platform', 'Mobile']) }
  }

  it('REQ_DEP_021 REQ_FE_017 outside the trace nothing is rendered: bars, milestones and emptied rows are gone, not hidden', async () => {
    await step('outside the trace nothing is rendered: bars, milestones and emptied rows are gone, not hidden', async () => {
      const { view, a, b, c, d, m } = traced()
      const tv = applyTrace(view, new Set([a.id, b.id]))
      renderMerged(tv, { showDependencies: true })
      expect([...host.querySelectorAll<HTMLElement>('.deliverable')].map((e) => e.dataset.deliverable).sort()).toEqual([String(a.id), String(b.id)].sort())
      expect(host.querySelector(`.deliverable[data-deliverable="${c.id}"]`)).toBeNull()
      expect(host.querySelector(`.deliverable[data-deliverable="${d.id}"]`)).toBeNull()
      expect(host.querySelector(`.ms[data-ms="${m.id}"]`)).toBeNull()
      expect(host.querySelector('.ms')).toBeNull()
      expect([...host.querySelectorAll<HTMLElement>('.band')].map((e) => e.dataset.ws)).toEqual(['Platform']) // Mobile collapsed
    })
  })

  it('REQ_DEP_021 REQ_DEP_012 arrows only between rendered ends; an off-screen end is a chevron badge, an untraced one is nothing', () => {
    const { view, a, b, d, gone } = traced()
    renderMerged(applyTrace(view, new Set([a.id, b.id, gone.id])), { showDependencies: true })
    expect([...host.querySelectorAll<HTMLElement>('g.dep')].map((g) => `${g.dataset.depFrom}>${g.dataset.depTo}`)).toEqual([`${a.id}>${b.id}`])
    expect([...host.querySelectorAll<HTMLElement>('.dep-badge')].map((g) => `${g.dataset.depFrom}>${g.dataset.depTo}`)).toEqual([`${b.id}>999`])
    expect(host.querySelector(`.dep-badge[data-dep-from="${d.id}"]`)).toBeNull() // D is loaded but not in the trace: no badge, no arrow
  })
})
