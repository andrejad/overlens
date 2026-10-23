// Milestone dependencies against the REAL running app (Phase 9A, REQ_DEP_023–028): every scene is built through the
// app's own API (builders.ts, random names, days relative to today — REQ_TEST_016/017) and every assertion about what
// was saved reads the server, not just the page.
//
// Scene (one workstream, quarter zoom):
//   P  today+0  .. today+14   a deliverable
//   M  today+25               a milestone
//   Q  today+40 .. today+55   a deliverable
// "linked" means P -> M -> Q (M depends on P, Q depends on M).
import { expect, test, type Page } from '@playwright/test'
import {
  apiFetch,
  asItem,
  createDeliverable,
  createItemDependency,
  createMilestone,
  createScene,
  getMilestoneDate,
  isoDay,
  listItemDependencies,
  type DeliverableHandle,
  type MilestoneHandle,
} from './builders'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)
const bar = (page: Page, d: DeliverableHandle) => page.locator(`.deliverable:not(.dup)[data-deliverable="${d.id}"]`).first()
const ms = (page: Page, m: MilestoneHandle) => page.locator(`.ms[data-ms="${m.id}"]`)
const arrow = (page: Page, fromKind: string, fromId: number, toKind: string, toId: number) =>
  page.locator(`g.dep[data-dep-from-kind="${fromKind}"][data-dep-from="${fromId}"][data-dep-to-kind="${toKind}"][data-dep-to="${toId}"]`)

async function scene(baseURL: string, opts: { linked?: boolean } = {}) {
  const { team, roadmap, ws } = await createScene(baseURL)
  const P = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(0), isoDay(14), { name: `Pre ${rand()}` })
  const M = await createMilestone(baseURL, roadmap, ws[0].id, isoDay(25), { name: `Beta ${rand()}` })
  const Q = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(40), isoDay(55), { name: `Post ${rand()}` })
  if (opts.linked) {
    await createItemDependency(baseURL, asItem.d(P), asItem.m(M))
    await createItemDependency(baseURL, asItem.m(M), asItem.d(Q))
  }
  return { team, roadmap, ws, P, M, Q }
}

async function openRoadmap(page: Page, teamId: number, arrowsOn = false) {
  await page.goto(`/#/teams/${teamId}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()
  await page.click('[data-z=quarter]')
  await expect(page.locator('[data-z=quarter]')).toHaveClass(/\bon\b/)
  if (arrowsOn) {
    const sw = page.locator('#sw-deps')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
  }
}

test.describe('REQ_DEP_023 REQ_DEP_026 milestone dependencies created from the UI', () => {
  test('REQ_DEP_023 REQ_DEP_026 the side panel of a milestone has the picker; a deliverable is picked and the server holds the edge', async ({ page, baseURL }) => {
    const { team, P, M } = await scene(baseURL!)
    await openRoadmap(page, team.id)
    await ms(page, M).click()
    const panel = page.getByTestId('side-panel')
    await panel.getByRole('button', { name: 'Edit', exact: true }).click() // the picker is in edit mode (REQ_FE_100)
    await expect(panel.getByText('Depends on')).toBeVisible()
    await panel.getByLabel('Search deliverables').fill(P.name)
    const option = panel.getByRole('option', { name: new RegExp(P.name) })
    await expect(option).toHaveCount(1)
    await option.click()
    await expect(panel.getByRole('listitem').filter({ hasText: P.name })).toHaveCount(1) // listed as a prerequisite now, in the "Depends on" list
    await expect.poll(async () => (await listItemDependencies(baseURL!, asItem.m(M))).map((e) => [e.from_kind, e.from_id, e.to_kind, e.to_id])).toEqual([['deliverable', P.id, 'milestone', M.id]])
  })

  test('REQ_FE_100 the panel Edit changes the name and date, the server keeps them, and a date that breaks a dependency is refused with its range', async ({ page, baseURL }) => {
    const { team, M } = await scene(baseURL!, { linked: true })
    await openRoadmap(page, team.id, true)
    await ms(page, M).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const newName = `Renamed ${rand()}`
    await page.getByLabel('Name', { exact: true }).fill(newName)
    await page.getByLabel('Date', { exact: true }).fill(isoDay(60)) // after Q starts: breaks M -> Q
    await page.getByLabel('Name', { exact: true }).focus() // leaving the date field checks it
    await expect(page.getByTestId('milestone-edit-form').getByRole('alert')).toContainText('Can’t be after')
    expect(await getMilestoneDate(baseURL!, M)).toBe(isoDay(25))
    await page.getByLabel('Date', { exact: true }).fill(isoDay(30))
    await page.getByLabel('Name', { exact: true }).focus()
    await expect.poll(() => getMilestoneDate(baseURL!, M)).toBe(isoDay(30))
    await page.getByTestId('edit-done').click()
    await expect(page.getByTestId('milestone-edit-form')).toHaveCount(0)
    await expect(ms(page, M)).toContainText(newName)
    expect(await getMilestoneDate(baseURL!, M)).toBe(isoDay(30))
  })

  test('REQ_FE_100 on the company view the panel Edit moves the milestone to another workstream and renames it at once', async ({ page, baseURL }) => {
    const { M, ws } = await scene(baseURL!)
    const otherName = `Other ${rand()}`
    const other = await (
      await apiFetch(baseURL!, `/api/roadmaps/${M.roadmapId}/workstreams`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: otherName }) })
    ).json()
    await page.goto('/#/company/workstreams')
    await expect(ms(page, M)).toBeVisible()
    await ms(page, M).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    const newName = `Moved ${rand()}`
    await page.getByLabel('Name', { exact: true }).fill(newName)
    await page.getByLabel('Workstream', { exact: true }).selectOption({ label: otherName })
    await page.getByTestId('edit-done').click()
    await expect(page.getByTestId('milestone-edit-form')).toHaveCount(0)
    await expect(ms(page, M)).toContainText(newName)
    const rm = await (await apiFetch(baseURL!, `/api/roadmaps/${M.roadmapId}`)).json()
    const saved = rm.milestones.find((x: { id: number }) => x.id === M.id)
    expect(saved.workstream_id).toBe(other.id)
    expect(saved.workstream_id).not.toBe(ws[0].id)
  })

  test('REQ_DEP_029 deleting a milestone from the panel drops its arrows and the drag limits it caused at once', async ({ page, baseURL }) => {
    const { team, P, M, Q } = await scene(baseURL!, { linked: true })
    await openRoadmap(page, team.id, true)
    await expect(arrow(page, 'deliverable', P.id, 'milestone', M.id)).toHaveCount(1)
    await ms(page, M).click()
    await page.getByTestId('panel-delete').click()
    await page.getByTestId('delete-item-confirm').click()
    await expect(ms(page, M)).toHaveCount(0)
    await expect(page.locator('g.dep')).toHaveCount(0)
    expect(await listItemDependencies(baseURL!, asItem.d(P))).toHaveLength(0)
    expect(await listItemDependencies(baseURL!, asItem.d(Q))).toHaveLength(0)
  })

  test('REQ_DEP_029 on the company view the deleted milestone leaves the page and its panel closes', async ({ page, baseURL }) => {
    const { P, M } = await scene(baseURL!, { linked: true })
    await page.goto('/#/company/workstreams')
    await expect(ms(page, M)).toBeVisible()
    await ms(page, M).click()
    await page.getByTestId('panel-delete').click()
    await page.getByTestId('delete-item-confirm').click()
    await expect(ms(page, M)).toHaveCount(0)
    await expect(page.getByTestId('panel-delete')).toHaveCount(0)
    expect(await listItemDependencies(baseURL!, asItem.d(P))).toHaveLength(0)
  })
})

test.describe('REQ_DEP_028 the trace with milestones', () => {
  async function itemCount(baseURL: string) {
    const res = await fetch(`${baseURL}/api/company/roadmaps`)
    const items = (await res.json()).items as { roadmap: { deliverables: unknown[]; milestones: unknown[] } }[]
    return items.reduce((n, i) => n + i.roadmap.deliverables.length + i.roadmap.milestones.length, 0)
  }

  test('REQ_DEP_028 "Trace dependencies" on a selected milestone opens #/company/trace/milestone/<id> with the chain, the milestone and an item count', async ({ page, baseURL }) => {
    const { P, M, Q } = await scene(baseURL!, { linked: true })
    await page.goto('/#/company/workstreams')
    await expect(page.locator('.deliverable').first()).toBeVisible()
    await expect(page.getByTestId('trace-btn')).toHaveCount(0) // shown once something is selected
    await ms(page, M).click()
    await expect(page.getByTestId('side-panel')).toContainText(M.name)
    await expect(page.getByTestId('trace-btn')).toBeVisible()
    await page.getByTestId('trace-btn').click()

    await expect(page).toHaveURL(new RegExp(`#/company/trace/milestone/${M.id}$`))
    await expect(page.getByTestId('trace-title')).toHaveText(`Tracing dependencies for: ${M.name}`)
    const hidden = (await itemCount(baseURL!)) - 3
    await expect(page.getByTestId('trace-stats')).toHaveText(`1 prerequisites · 1 dependents · ${hidden} unrelated items hidden`)
    await expect(bar(page, P)).toBeVisible()
    await expect(bar(page, Q)).toBeVisible()
    await expect(ms(page, M)).toBeVisible() // the milestone in the chain stays
    expect(await page.locator('.ms').count()).toBe(1) // and no other milestone does
    // the chain is one line across the arrows: P -> M and M -> Q
    await expect(arrow(page, 'deliverable', P.id, 'milestone', M.id)).toHaveCount(1)
    await expect(arrow(page, 'milestone', M.id, 'deliverable', Q.id)).toHaveCount(1)
    await page.getByTestId('trace-show-all').click()
    await expect(page).toHaveURL(/#\/company\/workstreams$/)
  })
})


// REQ_FE_136/137, REQ_DEP_036-039: Milestones only on the company view, a milestone click opening the chain that ends
// with it, and the meeting aids. Scene: M0 (today-6) -> P -> M -> Q; M0 -> P (6 days) and P -> M (11 days) are tight.
test.describe('REQ_FE_136 REQ_FE_137 milestones only and the chain of a milestone', () => {
  async function chainScene(baseURL: string) {
    const s = await scene(baseURL, { linked: true })
    const M0 = await createMilestone(baseURL, s.roadmap, s.ws[0].id, isoDay(-6), { name: `Kickoff ${rand()}` })
    await createItemDependency(baseURL, asItem.m(M0), asItem.d(s.P))
    return { ...s, M0 }
  }
  async function itemCount(baseURL: string) {
    const items = (await (await fetch(`${baseURL}/api/company/roadmaps`)).json()).items as { roadmap: { deliverables: unknown[]; milestones: unknown[] } }[]
    return items.reduce((n, i) => n + i.roadmap.deliverables.length + i.roadmap.milestones.length, 0)
  }

  test('REQ_FE_136 REQ_FE_137 the switch is in the address, survives a reload and leaves only milestones and their arrows; the header counts and the selection buttons follow', async ({ page, baseURL }) => {
    const { M } = await chainScene(baseURL!)
    await page.goto('/#/company/workstreams')
    await expect(page.locator('.deliverable').first()).toBeVisible()
    const pills = await page.getByTestId('status-pills').innerText()
    await ms(page, M).click() // selected with the switch off: the selection buttons show
    await expect(page.getByTestId('trace-btn')).toBeVisible()
    const sw = page.getByTestId('sw-milestones')
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect(page).toHaveURL(/#\/company\/workstreams\?milestones$/)
    await expect(page.getByTestId('trace-btn')).toHaveCount(0) // REQ_FE_137: a click opens the chain, so no button
    await expect(page.getByTestId('team-roadmap')).toHaveCount(0)
    await expect(page.getByTestId('status-pills')).toHaveText(pills) // REQ_FE_043: every roadmap item still counts
    await expect(page.locator('.ms').first()).toBeVisible()
    await expect(page.locator('.deliverable')).toHaveCount(0) // really gone, copies included
    await page.reload()
    await expect(page.getByTestId('sw-milestones')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.ms').first()).toBeVisible()
    await expect(page.locator('.deliverable')).toHaveCount(0)
    await expect(page.locator('.ws-label .count').first()).not.toContainText('deliverable')
    await page.getByTestId('sw-milestones').click()
    await expect(page).toHaveURL(/#\/company\/workstreams$/)
    await expect(page.locator('.deliverable').first()).toBeVisible()
  })

  test('REQ_FE_137 REQ_DEP_036 REQ_DEP_038 a milestone click opens the chain that ends with it; another milestone switches; the same one again closes', async ({ page, baseURL }) => {
    const { P, M, Q, M0 } = await chainScene(baseURL!)
    await page.goto('/#/company/workstreams?milestones')
    await ms(page, M).click()
    await expect(page).toHaveURL(new RegExp(`#/company/trace/milestone/${M.id}\\?milestones$`))
    await expect(page.getByTestId('trace-stats')).toHaveText(`2 prerequisites · ${(await itemCount(baseURL!)) - 3} other items hidden`)
    await expect(bar(page, P)).toBeVisible()
    await expect(ms(page, M0)).toBeVisible()
    await expect(bar(page, Q)).toHaveCount(0) // what depends on M is not part of its chain
    // REQ_DEP_036/038: P ends 11 days before M, and starts 6 days after M0
    await expect(page.getByTestId('health-tight')).toHaveText('2 tight links')
    const tight = arrow(page, 'deliverable', P.id, 'milestone', M.id)
    await expect(tight).toHaveClass(/\btight\b/)
    await expect(tight.locator('.dep-slack')).toHaveText('11 d')
    await expect(page.getByTestId('health-gap')).toHaveText('1 milestone without prerequisites') // M0
    await page.getByTestId('health-gap').click() // highlights M0 alone and fades the rest
    await expect(bar(page, P)).toHaveClass(/\bfaded\b/)
    await expect(ms(page, M0)).not.toHaveClass(/\bfaded\b/)
    await page.getByTestId('health-gap').click() // a second click clears it
    await expect(bar(page, P)).not.toHaveClass(/\bfaded\b/)

    await ms(page, M0).click() // another milestone of the chain: its own chain
    await expect(page).toHaveURL(new RegExp(`#/company/trace/milestone/${M0.id}\\?milestones$`))
    await expect(page.getByTestId('trace-stats')).toContainText('0 prerequisites')
    // REQ_DEP_037 / REQ_FE_010: both gaps are named, but the 22 px diamond holds one flag, inside its own width
    const flags = ms(page, M0).locator('.gap-flags')
    await expect(flags).toHaveAttribute('data-flags', 'gap owner')
    await expect(flags.locator('.gap-flag')).toHaveCount(1)
    const [dia, chip] = [await ms(page, M0).boundingBox(), await flags.locator('.gap-flag').boundingBox()]
    expect(chip!.x).toBeGreaterThanOrEqual(dia!.x - 0.5)
    expect(chip!.x + chip!.width).toBeLessThanOrEqual(dia!.x + dia!.width + 0.5)
    await expect(ms(page, M0)).toHaveAttribute('title', /No prerequisites.* · No owner$/)
    await ms(page, M0).click() // the same milestone again closes the chain
    await expect(page).toHaveURL(/#\/company\/workstreams\?milestones$/)
    await expect(page.locator('.deliverable')).toHaveCount(0)
  })

  test('REQ_DEP_039 the Accountable list shows the chain by owner; an entry selects its item and the back button returns to the list', async ({ page, baseURL }) => {
    const { P, M } = await chainScene(baseURL!)
    await page.goto(`/#/company/trace/milestone/${M.id}?milestones`)
    const list = page.getByTestId('accountable')
    await expect(list).toBeVisible()
    await expect(list.getByTestId('accountable-owner')).toHaveText(['No owner']) // nobody owns anything in this scene
    await expect(list.getByTestId('accountable-item')).toHaveCount(3)
    await expect(list.locator(`[data-key="d:${P.id}"]`)).toContainText(`11 days before ${M.name}`)
    await expect(list.locator(`[data-key="m:${M.id}"]`)).toHaveClass(/\bring-2\b/) // the root is marked
    await list.locator(`[data-key="d:${P.id}"]`).click()
    await expect(page.getByTestId('side-panel').locator('h2')).toHaveText(P.name)
    await page.getByTestId('panel-back').click()
    await expect(page.getByTestId('accountable')).toBeVisible()
    await page.getByTestId('trace-show-all').click()
    await expect(page).toHaveURL(/#\/company\/workstreams\?milestones$/)
  })
})
