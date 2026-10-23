// The hard drag rules in a real browser, with real mouse drags on a team roadmap built through the API
// (REQ_FE_012, 014, 015, 016). Drag behaviour that needs real layout cannot be proved in jsdom (REQ_TEST_004).
// Measured with the visibility helpers (REQ_TEST_013), so a hidden or collapsed block never counts. Dates are
// relative days (REQ_TEST_017); expected values are derived from what each test created.
// Runs in the `drag-rules-ui` project (logged in as e2e-admin), after the core projects.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { apiFetch, createDeliverable, createScene, getDeliverableDates, isoDay, type DeliverableHandle } from './builders'
import { findOverlaps, measureScript, visibleBoxes } from './visibility'

test.use({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' })

const ROW_PITCH = 44 // timeline/geometry.ts: one row, top to top
const BAND_PAD = 10 // above the first row

const main = (page: Page, d: DeliverableHandle) => page.locator(`.deliverable:not(.dup)[data-deliverable="${d.id}"]`)
const band = (page: Page, wsName: string) => page.locator(`.band[data-ws="${wsName}"]`)

async function open(page: Page, teamId: number) {
  await page.goto(`/#/teams/${teamId}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()
}

async function box(l: Locator) {
  await expect(l).toBeVisible()
  return (await l.boundingBox())!
}

// Presses at (x0, y0), moves to (x1, y1) in small steps and returns while the button is still held.
async function dragStart(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 8 })
  await page.mouse.move(x1, y1, { steps: 8 })
}

// Drags a bar's body by (dx, dy) and releases.
async function dragBody(page: Page, bar: Locator, dx: number, dy: number) {
  const b = await box(bar)
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await dragStart(page, x, y, x + dx, y + dy)
  await page.mouse.up()
}

// The vertical move that puts a bar's top on display row `row` of a workstream's band.
async function dyToRow(page: Page, bar: Locator, wsName: string, row: number) {
  return (await box(band(page, wsName))).y + BAND_PAD + row * ROW_PITCH - (await box(bar)).y
}

const colorOf = (page: Page, cssColor: string) =>
  page.evaluate((c) => {
    const probe = document.createElement('i')
    probe.style.color = c
    document.body.appendChild(probe)
    const out = getComputedStyle(probe).color
    probe.remove()
    return out
  }, cssColor)
const outline = (page: Page) => page.locator('.drop-slot').evaluate((e) => getComputedStyle(e).borderTopColor)

const noOverlap = async (page: Page, where: string) => {
  const items = await page.evaluate(measureScript, '.deliverable, .ms')
  expect(visibleBoxes(items).length, `${where}: nothing visible`).toBeGreaterThan(0)
  expect(findOverlaps(items), where).toEqual([])
}

const rowOf = async (page: Page, d: DeliverableHandle) => Number(await main(page, d).getAttribute('data-row'))

const wsIdsOf = async (baseURL: string, d: DeliverableHandle): Promise<number[]> => {
  const res = await apiFetch(baseURL, `/api/deliverables/${d.id}`)
  expect(res.ok).toBe(true)
  return (await res.json()).workstream_ids
}

// A: days 0-8, B: days 20-30, side by side in the one row of a workstream.
async function neighbours(baseURL: string) {
  const { team, roadmap, ws } = await createScene(baseURL, 1)
  const [aS, aE, bS, bE] = [0, 8, 20, 30]
  const A = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(aS), isoDay(aE), { name: 'Left neighbour' })
  const B = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(bS), isoDay(bE), { name: 'Right neighbour' })
  return { team, ws, A, B, aS, aE, bS, bE }
}

test('REQ_FE_012 dragging an edge stops at the neighbour in the same row, like a wall', async ({ page, baseURL }) => {
  const { team, A, B, aS, aE, bS, bE } = await neighbours(baseURL!)
  await open(page, team.id)
  expect(await rowOf(page, A)).toBe(await rowOf(page, B))

  // A's right edge dragged far past B: it ends the day before B starts
  const a = await box(main(page, A))
  const b = await box(main(page, B))
  await dragStart(page, a.x + a.width - 2, a.y + a.height / 2, b.x + b.width + 60, a.y + a.height / 2)
  await page.mouse.up()
  await expect.poll(() => getDeliverableDates(baseURL!, A)).toEqual({ start: isoDay(aS), end: isoDay(bS - 1) })
  await noOverlap(page, 'after the right edge hit the wall')

  // B's left edge dragged far left, past A: A now touches B, so B cannot start any earlier
  const a2 = await box(main(page, A))
  const b2 = await box(main(page, B))
  await dragStart(page, b2.x + 2, b2.y + b2.height / 2, a2.x - 60, b2.y + b2.height / 2)
  await page.mouse.up()
  await expect.poll(() => getDeliverableDates(baseURL!, B)).toEqual({ start: isoDay(bS), end: isoDay(bE) })
  expect(await getDeliverableDates(baseURL!, A)).toEqual({ start: isoDay(aS), end: isoDay(bS - 1) })
  expect(aE).toBeLessThan(bS) // the builders left a gap, so the first drag really moved something
  await noOverlap(page, 'after the left edge hit the wall')
})

test('REQ_FE_012 dragging a whole bar stops at the neighbour in the same row and keeps its length', async ({ page, baseURL }) => {
  const { team, A, B, aS, aE, bS } = await neighbours(baseURL!)
  await open(page, team.id)
  const a = await box(main(page, A))
  const b = await box(main(page, B))
  await dragBody(page, main(page, A), b.x + b.width + 200 - a.x, 0)
  const len = aE - aS
  await expect.poll(() => getDeliverableDates(baseURL!, A)).toEqual({ start: isoDay(bS - 1 - len), end: isoDay(bS - 1) })
  expect(await rowOf(page, A)).toBe(await rowOf(page, B)) // stopped, not bumped to another row
  await noOverlap(page, 'after the bar hit the wall')
})

test('REQ_FE_014 a bar can be dropped into a new row below the last, outlined in the accent colour while it is allowed', async ({ page, baseURL }) => {
  const { team, roadmap, ws } = await createScene(baseURL!, 1)
  const X = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(0), isoDay(10), { name: 'Mover' })
  const P = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(40), isoDay(50), { name: 'Stays' })
  await open(page, team.id)
  expect(await rowOf(page, X)).toBe(await rowOf(page, P))
  const before = await rowOf(page, X)

  const bar = main(page, X)
  const b = await box(bar)
  const dy = await dyToRow(page, bar, ws[0].name, before + 1) // one row below the last: a new row
  await dragStart(page, b.x + b.width / 2, b.y + b.height / 2, b.x + b.width / 2, b.y + b.height / 2 + dy)
  await expect(page.locator('.drop-slot')).toBeVisible()
  await expect(page.locator('.drop-slot.bad')).toHaveCount(0)
  expect(await outline(page)).toBe(await colorOf(page, 'var(--accent)'))
  await page.mouse.up()

  await expect(page.locator('.drop-slot')).toHaveCount(0)
  await expect(band(page, ws[0].name)).toHaveAttribute('data-rows', '2')
  expect(await rowOf(page, X)).toBeGreaterThan(await rowOf(page, P))
  await noOverlap(page, 'after the drop into a new row')
})

test('REQ_FE_014 a bar can be dropped into another workstream; its slot is red where the drop is not allowed', async ({ page, baseURL }) => {
  const { team, roadmap, ws } = await createScene(baseURL!, 2)
  const X = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(0), isoDay(10), { name: 'Traveller' })
  const W = await createDeliverable(baseURL!, roadmap, [ws[1].id], isoDay(5), isoDay(15), { name: 'In the way' })
  await open(page, team.id)

  const bar = main(page, X)
  const b = await box(bar)
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const rowW = await rowOf(page, W)
  const dyOnto = await dyToRow(page, bar, ws[1].name, rowW) // measured now: the bar lifts as soon as it is dragged
  const dyBelow = await dyToRow(page, bar, ws[1].name, rowW + 1)
  // over W's own slot: red
  await dragStart(page, cx, cy, cx, cy + dyOnto)
  await expect(page.locator('.drop-slot.bad')).toBeVisible()
  expect(await outline(page)).toBe(await colorOf(page, 'var(--danger)'))
  // on to the new row below W: allowed, accent
  await page.mouse.move(cx, cy + dyBelow, { steps: 8 })
  await expect(page.locator('.drop-slot:not(.bad)')).toBeVisible()
  await page.mouse.up()

  await expect.poll(() => wsIdsOf(baseURL!, X)).toEqual([ws[1].id])
  await expect.poll(() => rowOf(page, X)).toBeGreaterThan(await rowOf(page, W))
})

test('REQ_FE_015 dropping onto an occupied slot moves nothing and says so', async ({ page, baseURL }) => {
  const { team, roadmap, ws } = await createScene(baseURL!, 1)
  const X = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(0), isoDay(10), { name: 'Dropped' })
  // overlaps X in time, so it sits in the row below
  const Q = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(5), isoDay(15), { name: 'Occupant', rows: { [ws[0].id]: 1 } })
  await open(page, team.id)
  const rowX = await rowOf(page, X)
  const rowQ = await rowOf(page, Q)
  expect(rowQ).not.toBe(rowX)
  const datesBefore = await getDeliverableDates(baseURL!, X)

  const bar = main(page, X)
  await dragBody(page, bar, 0, await dyToRow(page, bar, ws[0].name, rowQ))

  await expect(page.getByRole('status')).toContainText('That spot is taken')
  await expect(page.getByRole('status')).toContainText('nothing moved')
  expect(await rowOf(page, X)).toBe(rowX)
  expect(await rowOf(page, Q)).toBe(rowQ)
  expect(await getDeliverableDates(baseURL!, X)).toEqual(datesBefore)
  expect(await wsIdsOf(baseURL!, X)).toEqual([ws[0].id])
  await noOverlap(page, 'after the refused drop')
})

test('REQ_FE_016 dropping into another workstream leaves the workstream it came from, keeps the others, and an emptied row closes up', async ({ page, baseURL }) => {
  const { team, roadmap, ws } = await createScene(baseURL!, 4)
  // D is in ws0 (main), ws1 and ws2; E shares ws0 but sits in its second row, so D's row empties when D leaves
  const D = await createDeliverable(baseURL!, roadmap, [ws[0].id, ws[1].id, ws[2].id], isoDay(0), isoDay(12), { name: 'Shared' })
  const E = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(4), isoDay(20), { name: 'Row two', rows: { [ws[0].id]: 1 } })
  await createDeliverable(baseURL!, roadmap, [ws[3].id], isoDay(40), isoDay(50), { name: 'Later' }) // ws3 holds something, so it is drawn (REQ_FE_127)
  await open(page, team.id)
  await expect(band(page, ws[0].name)).toHaveAttribute('data-rows', '2')
  expect(await rowOf(page, E)).toBe(1)

  const bar = main(page, D)
  await dragBody(page, bar, 0, await dyToRow(page, bar, ws[3].name, 0))

  const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)
  await expect.poll(async () => sorted(await wsIdsOf(baseURL!, D))).toEqual(sorted([ws[1].id, ws[2].id, ws[3].id]))
  for (const w of [ws[1], ws[2], ws[3]]) // the new workstream and the two it kept
    await expect(page.locator(`.deliverable[data-deliverable="${D.id}"][data-ws="${w.name}"]`)).toBeVisible()
  await expect(page.locator(`.deliverable[data-deliverable="${D.id}"][data-ws="${ws[0].name}"]`)).toHaveCount(0) // gone from the source
  // the emptied row closed up: E moved up into the first row and the band shrank
  await expect(band(page, ws[0].name)).toHaveAttribute('data-rows', '1')
  expect(await rowOf(page, E)).toBe(0)
  await noOverlap(page, 'after the move to another workstream')
})
