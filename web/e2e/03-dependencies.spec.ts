// Dependencies against the REAL running app (REQ_DEP_*): every scene is built through the app's own API
// (builders.ts, randomized names, no hardcoded ids, days relative to today — REQ_TEST_016/017) and every
// assertion about what was saved reads the server, not just the page.
//
// Scene used by most tests, in one workstream (quarter zoom, so a ~3-month window fits on screen):
//   P   today+0  .. today+14     the prerequisite
//   Q   today+20 .. today+34     depends on P; the earliest day it may start is today+15
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  createDeliverable,
  createDependency,
  teamRoadmap,
  createScene,
  createTeam,
  createWorkstream,
  getDeliverableDates,
  isoDay,
  listDependencies,
  type DeliverableHandle,
  type TeamHandle,
} from './builders'
import { measureScript, visibleBoxes } from './visibility'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)
const bar = (page: Page, d: DeliverableHandle) => page.locator(`.deliverable:not(.dup)[data-deliverable="${d.id}"]`)
const arrow = (page: Page, from: DeliverableHandle, to: DeliverableHandle) =>
  page.locator(`g.dep[data-dep-from="${from.id}"][data-dep-to="${to.id}"]`)

async function openRoadmap(page: Page, team: TeamHandle, zoom = 'quarter') {
  await page.goto(`/#/teams/${team.id}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()
  await page.click(`[data-z=${zoom}]`)
  await expect(page.locator(`[data-z=${zoom}]`)).toHaveClass(/\bon\b/)
}

async function arrowsOn(page: Page) {
  const sw = page.locator('#sw-deps')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
}

// Two deliverables P -> Q in one fresh roadmap, with arrows on at quarter zoom.
async function pqScene(page: Page, baseURL: string, opts: { connect?: boolean } = {}) {
  const { team, roadmap, ws } = await createScene(baseURL)
  const P = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(0), isoDay(14), { name: `Pre ${rand()}` })
  const Q = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(20), isoDay(34), { name: `Dep ${rand()}` })
  if (!opts.connect) await createDependency(baseURL, P, Q)
  await openRoadmap(page, team)
  await arrowsOn(page)
  return { team, roadmap, ws, P, Q }
}

// An arrow's line has no height when both ends share a row, so Playwright's own visibility check (which
// wants a non-empty box) calls it hidden; this checks it is really drawn: shown, and with a length.
async function expectDrawn(line: Locator) {
  await expect
    .poll(() =>
      line.evaluate((e) => {
        const cs = getComputedStyle(e)
        return cs.display !== 'none' && cs.visibility !== 'hidden' && (e as SVGGraphicsElement).getBBox().width > 0
      }),
    )
    .toBe(true)
}

// A point on an arrow's stroke in viewport coordinates, for hovering/clicking it (the hit path is a
// transparent stroke, so the centre of its bounding box may not be on it).
async function pointOnArrow(page: Page, from: DeliverableHandle, to: DeliverableHandle) {
  return arrow(page, from, to).locator('.dep-hit').evaluate((p: SVGPathElement) => {
    const pt = p.getPointAtLength(p.getTotalLength() / 2)
    const m = p.getScreenCTM()!
    return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f }
  })
}

// Drags from (x,y) by dx pixels with real pointer events, optionally holding before release.
async function dragBy(page: Page, x: number, y: number, dx: number, hold?: () => Promise<void>) {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 6 })
  await page.mouse.move(x + dx, y, { steps: 6 })
  if (hold) await hold()
  await page.mouse.up()
}

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

// Records every PATCH body sent for a deliverable, so a test can prove the server never saw a bad date.
function recordPatches(page: Page, d: DeliverableHandle) {
  const sent: { start_date?: string; end_date?: string }[] = []
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith(`/api/deliverables/${d.id}`)) sent.push(JSON.parse(r.postData() || '{}'))
  })
  return sent
}

// X sits in two workstreams (so it has a copy), Y depends on X.
async function copiesScene(baseURL: string) {
  const { team, roadmap, ws } = await createScene(baseURL, 2)
  const X = await createDeliverable(baseURL, roadmap, [ws[0].id, ws[1].id], isoDay(0), isoDay(14), { name: `Shared ${rand()}` })
  const Y = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(20), isoDay(34), { name: `After ${rand()}` })
  await createDependency(baseURL, X, Y)
  return { team, ws, X, Y }
}
const visibleDups = (page: Page) => page.evaluate(measureScript, '.deliverable.dup').then((m) => visibleBoxes(m).length)
// every step of the journey starts from a clean browser, as a user's first visit does
async function freshBrowser(page: Page) {
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('erm.tutorialSeen', 'true') }) // REQ_FE_130: keep the tour from opening by itself
  await page.goto('about:blank')
}

test.describe('arrows', () => {
  test('REQ_DEP_009 an arrow leaves the prerequisite\'s right edge, runs with right angles, and ends with an arrowhead at the dependent\'s left edge', async ({ page, baseURL }) => {
    const { P, Q } = await pqScene(page, baseURL!)
    const line = arrow(page, P, Q).locator('.dep-line')
    await expectDrawn(line)
    await expect(line).toHaveAttribute('marker-end', /^url\(#/)
    const d = await line.getAttribute('d')
    expect(d).toMatch(/^M[\d.]+,[\d.]+( [HV][\d.]+)+$/) // only horizontal and vertical segments: right-angle bends
    const ends = await line.evaluate((p: SVGPathElement) => {
      const m = p.getScreenCTM()!
      const at = (len: number) => {
        const pt = p.getPointAtLength(len)
        return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f }
      }
      return { start: at(0), end: at(p.getTotalLength()) }
    })
    const pb = await box(bar(page, P))
    const qb = await box(bar(page, Q))
    expect(ends.start.x).toBeCloseTo(pb.x + pb.width, 0) // leaves the prerequisite's right edge…
    expect(ends.start.y).toBeGreaterThanOrEqual(pb.y)
    expect(ends.start.y).toBeLessThanOrEqual(pb.y + pb.height)
    expect(ends.end.x).toBeCloseTo(qb.x, 0) // …and arrives at the dependent's left edge
    expect(ends.end.y).toBeGreaterThanOrEqual(qb.y)
    expect(ends.end.y).toBeLessThanOrEqual(qb.y + qb.height)
  })

  test('REQ_DEP_013 REQ_DEP_014 REQ_DEP_015 the toolbar toggle shows and hides the arrows and is named for what a click does; with arrows on each deliverable appears once and the copies toggle is disabled with an explanation and its normal label; turning arrows off puts the copies setting back to what it was', async ({ page, baseURL }) => {
    await test.step('REQ_DEP_013 the toggle shows and hides the arrows, and is named for what a click does', async () => {
      const { team, roadmap, ws } = await createScene(baseURL!)
      const P = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(0), isoDay(14))
      const Q = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(20), isoDay(34))
      await createDependency(baseURL!, P, Q)
      await openRoadmap(page, team)
      const sw = page.locator('#sw-deps')
      await expect(sw).toHaveText(/Show dependencies/)
      await expect(page.locator('g.dep')).toHaveCount(0)
      await sw.click()
      await expect(sw).toHaveText(/Hide dependencies/)
      await expect(arrow(page, P, Q)).toHaveCount(1)
      await expectDrawn(arrow(page, P, Q).locator('.dep-line'))
      await sw.click()
      await expect(sw).toHaveText(/Show dependencies/)
      await expect(page.locator('g.dep')).toHaveCount(0)
    })

    await freshBrowser(page)
    await test.step('REQ_DEP_014 with arrows on each deliverable appears once, and the copies toggle is disabled with an explanation and its normal label', async () => {
      const { team, X, Y } = await copiesScene(baseURL!)
      await openRoadmap(page, team)
      const copies = page.locator('#sw-copies')
      await expect(page.locator('.deliverable.dup')).toHaveCount(1) // arrows off: the copy is drawn
      await expect(copies).not.toHaveAttribute('aria-disabled', 'true')
      await expect(copies).toHaveText(/Hide copies/)
      await arrowsOn(page)
      expect(await visibleDups(page)).toBe(0)
      await expect(page.locator(`.deliverable[data-deliverable="${X.id}"]`)).toHaveCount(1)
      await expect(page.locator(`.deliverable[data-deliverable="${Y.id}"]`)).toHaveCount(1)
      await expect(copies).toHaveAttribute('aria-disabled', 'true')
      await expect(copies).toHaveAttribute('title', /locked while arrows are on/i) // says why
      await expect(copies).toHaveText(/Show copies/) // not relabelled: the normal label for "copies hidden"
      await expect(copies).not.toHaveText(/lock|disabled|unavailable/i)
      await copies.click({ force: true }) // a click on the disabled toggle does nothing
      await expect(copies).toHaveAttribute('aria-checked', 'false')
      expect(await visibleDups(page)).toBe(0)
    })

    await freshBrowser(page)
    await test.step('REQ_DEP_015 turning arrows off puts the copies setting back to "shown" when it was shown before', async () => {
      const { team } = await copiesScene(baseURL!)
      await openRoadmap(page, team)
      await expect(page.locator('.deliverable.dup')).toHaveCount(1)
      await arrowsOn(page)
      expect(await visibleDups(page)).toBe(0)
      await page.locator('#sw-deps').click()
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'false')
      const copies = page.locator('#sw-copies')
      await expect(copies).toHaveAttribute('aria-checked', 'true')
      await expect(copies).not.toHaveAttribute('aria-disabled', 'true')
      await expect(page.locator('.deliverable.dup')).toHaveCount(1)
    })

    await freshBrowser(page)
    await test.step('REQ_DEP_015 turning arrows off puts the copies setting back to "hidden" when it was hidden before', async () => {
      const { team } = await copiesScene(baseURL!)
      await openRoadmap(page, team)
      const copies = page.locator('#sw-copies')
      await copies.click()
      await expect(copies).toHaveAttribute('aria-checked', 'false')
      await expect(page.locator('.deliverable.dup')).toHaveCount(0)
      await arrowsOn(page)
      await page.locator('#sw-deps').click()
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'false')
      await expect(copies).toHaveAttribute('aria-checked', 'false') // not reset to shown
      await expect(page.locator('.deliverable.dup')).toHaveCount(0)
      await expect(copies).not.toHaveAttribute('aria-disabled', 'true')
    })
  })
})

test.describe('dragging stops at the dependency limit (the server never sees a violating date)', () => {
  test('REQ_DEP_005 dragging a dependent\'s start left stops at the day after the prerequisite ends', async ({ page, baseURL }) => {
    const { P, Q } = await pqScene(page, baseURL!)
    const sent = recordPatches(page, Q)
    const pb = await box(bar(page, P))
    const q = await box(bar(page, Q))
    const px = q.width / 15 // Q lasts 15 days
    const x = q.x + 2 // inside the ~6px resize zone at its left edge
    const y = q.y + q.height / 2
    await dragBy(page, x, y, -12 * px, async () => {
      await expect(page.locator('.dep-limit')).toBeVisible() // the dashed limit line
      const now = await box(bar(page, Q))
      expect(now.x).toBeGreaterThanOrEqual(pb.x + pb.width - 2) // the bar stopped at the limit, it did not pass the prerequisite
      expect(now.x).toBeLessThanOrEqual(pb.x + pb.width + 2)
    })
    await expect.poll(() => getDeliverableDates(baseURL!, Q).then((d) => d.start)).toBe(isoDay(15))
    expect((await getDeliverableDates(baseURL!, Q)).end).toBe(isoDay(34)) // only the start moved
    expect(sent.length).toBeGreaterThan(0)
    for (const body of sent) if (body.start_date) expect(body.start_date >= isoDay(15)).toBe(true)
    const now = await box(bar(page, Q))
    expect(now.x).toBeGreaterThanOrEqual(pb.x + pb.width - 2) // and the saved bar is drawn there
    expect(now.x).toBeLessThanOrEqual(pb.x + pb.width + 2)
  })
})

test.describe('connect mode and deleting arrows', () => {
  test('REQ_DEP_018 the right dot means "this blocks": click it, then another bar, and the dependency is created', async ({ page, baseURL }) => {
    const { P, Q } = await pqScene(page, baseURL!, { connect: true })
    await expect(page.locator('g.dep')).toHaveCount(0)
    await bar(page, P).hover()
    await bar(page, P).locator('.cdot.r').click()
    await expect(page.locator('.tl.connecting')).toHaveCount(1)
    const q = await box(bar(page, Q))
    await page.mouse.move(q.x + q.width / 2, q.y + q.height + 10) // just below Q, inside its band (the scene's only row is the top one, REQ_FE_127)
    await expect(page.locator('.dep-rubber')).toBeVisible() // the rubber band follows the pointer
    await bar(page, Q).click()
    await expect(arrow(page, P, Q)).toHaveCount(1)
    await expect(page.locator('.tl.connecting')).toHaveCount(0)
    const edges = await listDependencies(baseURL!, Q)
    expect(edges.map((e) => [e.from_id, e.to_id])).toEqual([[P.id, Q.id]])
  })

  test('REQ_DEP_019 an arrow is deleted by clicking the × at its midpoint', async ({ page, baseURL }) => {
    const { P, Q } = await pqScene(page, baseURL!)
    const at = await pointOnArrow(page, P, Q)
    await page.mouse.move(at.x, at.y)
    const x = arrow(page, P, Q).locator('.dep-x')
    await expect(x).toBeVisible()
    await x.click()
    await expect(page.locator('g.dep')).toHaveCount(0)
    expect(await listDependencies(baseURL!, Q)).toEqual([])
  })

  test('REQ_DEP_003 a refused loop shows a message naming the loop, and nothing is created', async ({ page, baseURL }) => {
    const { team, roadmap, ws } = await createScene(baseURL!)
    const name = (s: string) => `${s}${rand()}`
    const A = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(0), isoDay(9), { name: name('Alpha') })
    const B = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(12), isoDay(21), { name: name('Bravo') })
    const C = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(24), isoDay(33), { name: name('Charlie') })
    const edges = [[A, B], [B, C]]
    for (const [from, to] of edges) await createDependency(baseURL!, from, to)
    await openRoadmap(page, team)
    await arrowsOn(page)
    // C "blocks" A would close A -> B -> C -> A
    await bar(page, C).hover()
    await bar(page, C).locator('.cdot.r').click()
    await bar(page, A).click()
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText(/loop/i)
    const text = (await alert.textContent()) ?? ''
    const order = [C, A, B, C].map((d) => d.name).join('.*')
    expect(text).toMatch(new RegExp(order)) // names the path: C → A → B → C
    expect((await listDependencies(baseURL!, A)).map((e) => [e.from_id, e.to_id])).toEqual([[A.id, B.id]])
    await expect(page.locator('g.dep')).toHaveCount(edges.length)
  })
})

test.describe('the picker in the side panel', () => {
  // Two teams so the picker has something to group; one candidate ends too late to be chosen.
  async function pickerScene(baseURL: string) {
    const { team, roadmap, ws } = await createScene(baseURL)
    const self = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(20), isoDay(34), { name: `Self ${rand()}` })
    const early = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(0), isoDay(10), { name: `Early ${rand()}` })
    const late = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(40), isoDay(50), { name: `Late ${rand()}` })
    const other = await createTeam(baseURL)
    const otherRoadmap = await teamRoadmap(baseURL, other)
    const otherWs = await createWorkstream(baseURL, otherRoadmap)
    const foreign = await createDeliverable(baseURL, otherRoadmap, [otherWs.id], isoDay(0), isoDay(5), { name: `Foreign ${rand()}` })
    return { team, other, self, early, late, foreign }
  }

  async function expectPicker(page: Page, s: Awaited<ReturnType<typeof pickerScene>>) {
    const options = page.getByRole('listbox', { name: 'Prerequisite candidates' }).getByRole('option')
    await expect(page.getByLabel('Search deliverables')).toBeVisible()
    await expect(options.filter({ hasText: s.early.name })).toBeEnabled()
    await expect(options.filter({ hasText: s.foreign.name })).toBeEnabled() // another team's roadmap is offered (REQ_DEP_001)
    await expect(options.filter({ hasText: new RegExp(` - ${s.early.name}`) })).toHaveCount(1) // "<tag> - <name>", no group headings (REQ_DEP_008)
    await expect(page.getByRole('group', { name: s.other.name })).toHaveCount(0)
    const late = options.filter({ hasText: s.late.name })
    await expect(late).toBeDisabled() // greyed out with the reason (REQ_DEP_007)
    await expect(late).toContainText('ends too late')
    await expect(options.filter({ hasText: s.self.name })).toHaveCount(0) // never itself (REQ_DEP_002)
    await page.getByLabel('Search deliverables').fill(s.foreign.name)
    await expect(options).toHaveCount(1)
  }

  test('REQ_DEP_008 REQ_DEP_002 the side panel has the tag-labelled, searchable picker and never offers the deliverable itself', async ({ page, baseURL }) => {
    const s = await pickerScene(baseURL!)
    await openRoadmap(page, s.team)
    await page.locator(`.deliverable[data-deliverable="${s.self.id}"]`).click()
    await page.getByTestId('side-panel').getByRole('button', { name: 'Edit', exact: true }).click()
    await expectPicker(page, s)
  })
})

test.describe('resize zone and connector dots (real geometry)', () => {
  test('REQ_DEP_016 REQ_DEP_017 the ~6px resize zone with a two-sided cursor sits at each edge, the ~14px dot with a crosshair clear of it', async ({ page, baseURL }) => {
    const { P } = await pqScene(page, baseURL!)
    const b = bar(page, P)
    await b.hover()
    const geom = await b.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const read = (sel: string) => {
        const e = el.querySelector(sel) as HTMLElement
        const q = e.getBoundingClientRect()
        return { left: q.left - r.left, right: q.right - r.left, width: q.width, cursor: getComputedStyle(e).cursor }
      }
      const hit = (x: number) => (document.elementFromPoint(r.left + x, r.top + r.height / 2) as HTMLElement | null)?.className
      return {
        width: r.width,
        rzL: read('.rz.l'), rzR: read('.rz.r'), dotL: read('.cdot.l'), dotR: read('.cdot.r'),
        hit2: hit(2), hit14: hit(14), hitR2: hit(r.width - 2), hitR14: hit(r.width - 14),
      }
    })
    for (const rz of [geom.rzL, geom.rzR]) {
      expect(rz.width).toBeGreaterThanOrEqual(5) // about 6px wide
      expect(rz.width).toBeLessThanOrEqual(7)
      expect(rz.cursor).toBe('ew-resize') // a two-sided arrow
    }
    for (const dot of [geom.dotL, geom.dotR]) expect(dot.cursor).toBe('crosshair')
    expect((geom.dotL.left + geom.dotL.right) / 2).toBeGreaterThan(12) // centred about 14px inside the left edge
    expect((geom.dotL.left + geom.dotL.right) / 2).toBeLessThan(16)
    expect(geom.width - (geom.dotR.left + geom.dotR.right) / 2).toBeGreaterThan(12) // and the right edge
    expect(geom.width - (geom.dotR.left + geom.dotR.right) / 2).toBeLessThan(16)
    expect(geom.dotL.left).toBeGreaterThanOrEqual(geom.rzL.right) // never overlaps the resize zone
    expect(geom.dotR.right).toBeLessThanOrEqual(geom.rzR.left)
    // what the pointer actually lands on: the resize zone within ~6px of the edge, the dot at ~14px
    expect(geom.hit2).toContain('rz')
    expect(geom.hit14).toContain('cdot')
    expect(geom.hitR2).toContain('rz')
    expect(geom.hitR14).toContain('cdot')
  })
})
