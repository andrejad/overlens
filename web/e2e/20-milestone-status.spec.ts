// A milestone's diamond showing its own status, with its name centred under it and its date to its right (REQ_FE_040/042) on every roadmap screen and at every zoom level, and
// milestones edited on a company view (REQ_FE_096/097), against the REAL running app. Scenes are built through the
// app's API (builders.ts: random names, days relative to today). A milestone created without a status is planned.
//
// Scene (one workstream): P today+0..14 -> M today+25 -> Q today+40..55.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { apiFetch, asItem, createDeliverable, createItemDependency, createMilestone, createScene, getMilestoneDate, isoDay, type MilestoneHandle, ANON_STATE } from './builders'
import { findOverlaps, measureScript } from './visibility'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)
const zooms = ['year', 'half', 'quarter', 'month']
const ms = (page: Page, m: MilestoneHandle) => page.locator(`.ms[data-ms="${m.id}"]`)

async function scene(baseURL: string) {
  const { team, roadmap, ws } = await createScene(baseURL)
  const P = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(0), isoDay(14), { name: `Pre ${rand()}` })
  const M = await createMilestone(baseURL, roadmap, ws[0].id, isoDay(25), { name: `Gate ${rand()}` })
  const Q = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(40), isoDay(55), { name: `Post ${rand()}` })
  await createItemDependency(baseURL, asItem.d(P), asItem.m(M))
  await createItemDependency(baseURL, asItem.m(M), asItem.d(Q))
  return { team, roadmap, ws, P, M, Q }
}

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

async function zoomTo(page: Page, z: string) {
  await page.click(`[data-z=${z}]`)
  await expect(page.locator(`[data-z=${z}]`)).toHaveClass(/\bon\b/)
}

// The diamond shows the status itself (no separate icon). Where the row has room, the name is centred directly under
// the diamond and the short date sits to its right, vertically centred on it; both stay inside the diamond's band.
async function expectDiamond(page: Page, m: MilestoneHandle, where: string, needName = false) {
  const el = ms(page, m)
  await expect(el, where).toHaveAttribute('data-status', 'planned')
  await expect(el.locator('.mk svg'), where).toBeVisible()
  await expect(el.locator('.st'), where).toHaveCount(0)
  const dia = await box(el.locator('.mk'))
  const bands = await page.locator('.band').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ y: r.y, h: r.height })))
  const band = bands.find((b) => dia.y >= b.y && dia.y < b.y + b.h)!
  if (needName) await expect(el.locator('.lbl'), `${where}: name shown`).toBeVisible()
  if (await el.locator('.lbl').count()) {
    const lbl = await box(el.locator('.lbl'))
    expect(Math.abs(lbl.x + lbl.width / 2 - (dia.x + dia.width / 2)), `${where}: name centred under the diamond`).toBeLessThan(1)
    const gap = lbl.y - (dia.y + dia.height)
    expect(gap, `${where}: name just under the diamond`).toBeGreaterThanOrEqual(0)
    expect(gap, `${where}: name just under the diamond`).toBeLessThan(5)
    expect(lbl.y + lbl.height, `${where}: name inside the band`).toBeLessThanOrEqual(band.y + band.h)
  }
  if (await el.locator('.dt').count()) {
    const dt = await box(el.locator('.dt'))
    expect(dt.x, `${where}: date right of the diamond`).toBeGreaterThanOrEqual(dia.x + dia.width)
    expect(Math.abs(dt.y + dt.height / 2 - (dia.y + dia.height / 2)), `${where}: date centred on the diamond`).toBeLessThan(1.5)
  }
}

// Every item, plus each milestone's name and date, measured for the no-overlap check (REQ_FE_010)
const ALL = '.deliverable, .ms, .ms .lbl, .ms .dt'

test("REQ_FE_040 REQ_FE_042 REQ_FE_010 a milestone's diamond shows its status on every roadmap screen at every zoom level, with its name under it and its date beside it, overlapping nothing", async ({ page, browser, baseURL }) => {
  const { team, M } = await scene(baseURL!)
  const screens: [string, string, boolean][] = [
    ['team roadmap', `/#/teams/${team.id}`, false],
    ['team dependency view', `/#/teams/${team.id}`, true],
    ['company view', '/#/company/workstreams', false],
    ['trace', `/#/company/trace/milestone/${M.id}`, false],
  ]
  for (const [name, hash, arrows] of screens) {
    await page.goto(hash)
    await expect(ms(page, M)).toBeVisible()
    if (arrows) {
      await page.locator('#sw-deps').click()
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
    }
    await expect(page.getByTestId('status-legend')).toBeVisible() // the one legend covers milestones too
    for (const z of zooms) {
      await zoomTo(page, z)
      await expectDiamond(page, M, `${name} @ ${z}`, name.startsWith('team') && z === 'month')
      if (name.startsWith('team')) expect(findOverlaps(await page.evaluate(measureScript, ALL)), `${name} @ ${z}`).toEqual([])
    }
  }
  // the read-only team roadmap: an anonymous visitor
  const ctx = await browser.newContext({ baseURL, storageState: ANON_STATE, viewport: { width: 1600, height: 900 } })
  const anon = await ctx.newPage()
  await anon.goto(`/#/teams/${team.id}`)
  await expect(ms(anon, M)).toBeVisible()
  for (const z of zooms) {
    await zoomTo(anon, z)
    await expectDiamond(anon, M, `read-only @ ${z}`, z === 'month')
  }
  await ctx.close()
})

test("REQ_FE_040 REQ_FE_010 an at-risk milestone is a red diamond with a red outline clear of the bars beside it and of its own name, at every zoom level", async ({ page, baseURL }) => {
  const { team, M, P, Q } = await scene(baseURL!)
  const res = await apiFetch(baseURL!, `/api/milestones/${M.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'at_risk', risk_note: 'Vendor late' }) })
  expect(res.ok).toBe(true)
  await page.goto(`/#/teams/${team.id}`)
  await expect(ms(page, M)).toHaveAttribute('data-status', 'at_risk')
  let drawn = 0
  for (const z of zooms) {
    await zoomTo(page, z)
    const el = ms(page, M)
    await expect(el.locator('.mk svg'), z).toBeVisible()
    const dia = await box(el.locator('.mk'))
    const left = await box(page.locator('.deliverable', { hasText: P.name }).first())
    const right = await box(page.locator('.deliverable', { hasText: Q.name }).first())
    expect(dia.x, `${z}: the diamond is clear of the bar before it`).toBeGreaterThanOrEqual(left.x + left.width)
    expect(dia.x + dia.width, `${z}: the diamond is clear of the bar after it`).toBeLessThanOrEqual(right.x)
    if (await el.locator('polygon.risk-ring').count()) {
      drawn++
      const ring = await box(el.locator('polygon.risk-ring')) // the geometry; the 2px line adds 1px all round
      expect(ring.x - 1, `${z}: the outline is clear of the bar before it`).toBeGreaterThanOrEqual(left.x + left.width - 0.01)
      expect(ring.x + ring.width + 1, `${z}: the outline is clear of the bar after it`).toBeLessThanOrEqual(right.x + 0.01)
      expect(ring.width, `${z}: about 3px clear of the diamond on each side`).toBeGreaterThan(dia.width + 8)
      if (await el.locator('.lbl').count()) {
        const lbl = await box(el.locator('.lbl'))
        expect(lbl.y, `${z}: the name starts under the outline`).toBeGreaterThanOrEqual(ring.y + ring.height + 1 - 0.01)
        expect(Math.abs(lbl.x + lbl.width / 2 - (dia.x + dia.width / 2)), `${z}: name centred under the diamond`).toBeLessThan(1)
      }
      if (await el.locator('.dt').count()) {
        const dt = await box(el.locator('.dt'))
        expect(dt.x, `${z}: the date starts after the outline`).toBeGreaterThanOrEqual(ring.x + ring.width + 1 - 0.01)
      }
    }
    expect(findOverlaps(await page.evaluate(measureScript, ALL)), z).toEqual([])
  }
  expect(drawn, 'the outline is drawn where the row has room (at least the coarsest-to-finest zooms with space)').toBeGreaterThan(0)
})

test('REQ_FE_042 REQ_FE_010 a milestone wedged between bars a day away still shows its status diamond at every zoom level, and nothing of it overlaps the bars', async ({ page, baseURL }) => {
  const { team, roadmap, ws } = await createScene(baseURL!)
  await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(0), isoDay(19), { name: `Left ${rand()}` })
  const W = await createMilestone(baseURL!, roadmap, ws[0].id, isoDay(20), { name: `Wedged ${rand()}` })
  await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(21), isoDay(40), { name: `Right ${rand()}` })
  await page.goto(`/#/teams/${team.id}`)
  await expect(ms(page, W)).toBeVisible()
  for (const z of zooms) {
    await zoomTo(page, z)
    await expectDiamond(page, W, `wedged @ ${z}`)
    expect(await ms(page, W).getAttribute('data-row')).toBe('0') // still in the bars' row
    expect(findOverlaps(await page.evaluate(measureScript, ALL)), `wedged @ ${z}`).toEqual([])
  }
})

test('REQ_FE_096 REQ_FE_097 REQ_DEP_011 on the company view an admin cannot drag a milestone; its date edited in the side panel shows at once, its arrow follows and the server keeps it', async ({ page, baseURL }) => {
  const { P, M } = await scene(baseURL!)
  await page.goto('/#/company/workstreams')
  await expect(ms(page, M)).toBeVisible()
  await zoomTo(page, 'quarter')
  await page.locator('#sw-deps').click()
  await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
  const into = page.locator(`g.dep[data-dep-from-kind="deliverable"][data-dep-from="${P.id}"][data-dep-to-kind="milestone"][data-dep-to="${M.id}"] .dep-line`)
  await expect(into).toHaveCount(1)
  await ms(page, M).scrollIntoViewIfNeeded() // the company view holds every team: the pointer must reach it
  const dia = await box(ms(page, M).locator('.mk'))
  const end = () => into.evaluate((p: SVGPathElement) => {
    const m = p.getScreenCTM()!
    const pt = p.getPointAtLength(p.getTotalLength())
    return pt.x * m.a + pt.y * m.c + m.e
  })

  // REQ_FE_096: a drag does nothing (no dots either)
  await expect(page.locator('.cdot')).toHaveCount(0)
  await page.mouse.move(dia.x + dia.width / 2, dia.y + dia.height / 2)
  await page.mouse.down()
  await page.mouse.move(dia.x + dia.width / 2 + 40, dia.y + dia.height / 2, { steps: 5 })
  await page.mouse.up()
  expect((await box(ms(page, M).locator('.mk'))).x).toBeCloseTo(dia.x, 0)
  expect(await getMilestoneDate(baseURL!, M)).toBe(isoDay(25))

  // REQ_FE_097: the side panel edits it, and it shows at once
  await ms(page, M).click()
  const panel = page.getByTestId('side-panel')
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const form = panel.getByTestId('milestone-edit-form')
  await form.getByLabel('Date', { exact: true }).fill(isoDay(30))
  await form.getByLabel('Name', { exact: true }).focus() // leaving the date field saves it
  await expect.poll(() => getMilestoneDate(baseURL!, M)).toBe(isoDay(30))
  await expect.poll(async () => (await box(ms(page, M).locator('.mk'))).x).toBeGreaterThan(dia.x + 5)
  const moved = await box(ms(page, M).locator('.mk'))
  expect(await end()).toBeCloseTo(moved.x, 0) // the arrow's head is on the diamond in its new place
  expect(await getMilestoneDate(baseURL!, M)).toBe(isoDay(30))
})
