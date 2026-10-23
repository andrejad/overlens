// Improvements 10a in a real browser: the add buttons, the zoom row, the teams card's disabled Delete, and the arrow
// out of a near milestone (REQ_FE_004, REQ_FE_066, REQ_FE_101, REQ_DEP_027). Every scene is built through the API (builders.ts,
// random names and tags, days relative to today); only this test's own teams are asserted on.
// Runs in the `top-bar-ui` project (logged in as e2e-admin).
import { expect, test, type Page } from '@playwright/test'
import {
  asItem,
  createDeliverable,
  createItemDependency,
  createMilestone,
  createScene,
  createTeamWithFreshTag,
  isoDay,
} from './builders'

test.use({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)

async function oneDeliverableScene(baseURL: string) {
  const { team, roadmap, ws } = await createScene(baseURL)
  const d = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(2), isoDay(30), { name: `Del ${rand()}` })
  return { team, roadmap, ws, d }
}

async function openTeam(page: Page, teamId: number) {
  await page.goto(`/#/teams/${teamId}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()
}

test.describe('REQ_FE_101 the team roadmap top bar', () => {
  test("REQ_FE_101 the admin's Deliverable and Milestone buttons open their dialogs", async ({ page, baseURL }) => {
    const { team } = await oneDeliverableScene(baseURL!)
    await openTeam(page, team.id)
    await page.getByTestId('add-deliverable').click()
    await expect(page.getByRole('dialog', { name: 'Create deliverable' })).toBeVisible()
    await page.reload()
    await expect(page.locator('.deliverable').first()).toBeVisible()
    await page.getByTestId('add-milestone').click()
    await expect(page.getByRole('dialog', { name: 'Create milestone' })).toBeVisible()
  })
})

test('REQ_FE_066 the zoom row sits above the timeline on the team page and on the company view, with the team-roadmap button at its left', async ({ page, baseURL }) => {
  const { team, d } = await oneDeliverableScene(baseURL!)
  const above = async () => {
    const row = await page.getByTestId('zoom-row').boundingBox()
    const tl = await page.locator('.tl-scroll').first().boundingBox()
    expect(row, 'zoom row drawn').not.toBeNull()
    expect(tl, 'timeline drawn').not.toBeNull()
    expect(row!.y + row!.height).toBeLessThanOrEqual(tl!.y + 0.5)
  }
  await openTeam(page, team.id)
  await above()
  await expect(page.getByTestId('zoom-row').getByTestId('zoomseg')).toBeVisible()

  await page.goto('/#/company/workstreams')
  await expect(page.getByTestId('company-workstreams')).toBeVisible()
  await above()
  await expect(page.getByTestId('team-roadmap')).toHaveCount(0) // REQ_FE_053: shown once a deliverable or milestone is selected
  await page.locator(`.deliverable:not(.dup)[data-deliverable="${d.id}"]`).first().click()
  await expect(page.getByTestId('side-panel')).toContainText(d.name)
  const row = (await page.getByTestId('zoom-row').boundingBox())!
  const teamBtn = (await page.getByTestId('team-roadmap').boundingBox())!
  const seg = (await page.getByTestId('zoomseg').boundingBox())!
  expect(teamBtn.x).toBeGreaterThanOrEqual(row.x - 0.5)
  expect(teamBtn.x + teamBtn.width).toBeLessThanOrEqual(seg.x + 0.5) // left of the zoom control
})

test('REQ_FE_004 a team whose roadmap holds roadmap items has a disabled Delete whose reason is only its tooltip, no text under it', async ({ page, baseURL }) => {
  const { team: withRoadmap, roadmap, ws } = await createScene(baseURL!)
  await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(0), isoDay(5))
  const empty = await createTeamWithFreshTag(baseURL!)
  await page.goto('/#/admin')
  const card = page.locator('#admin-teams')
  const row = (name: string) => card.locator('tr', { has: page.getByLabel(`Name of ${name}`) })
  await expect(card.getByLabel(`Name of ${withRoadmap.name}`)).toBeVisible()
  const del = row(withRoadmap.name).getByRole('button', { name: 'Delete' })
  await expect(del).toBeDisabled()
  await expect(del).toHaveAttribute('title', 'Its roadmap has items — can’t delete')
  await expect(del).toHaveAccessibleDescription('Its roadmap has items — can’t delete')
  // no text under the button: the description's element is screen-reader-only (a 1px box), and the cell is no taller than the button
  const reason = await row(withRoadmap.name).locator('[id^=delete-reason-]').boundingBox()
  expect(reason!.width).toBeLessThanOrEqual(1)
  expect(reason!.height).toBeLessThanOrEqual(1)
  const cell = (await del.locator('xpath=..').boundingBox())!
  const btn = (await del.boundingBox())!
  expect(cell.height).toBeLessThanOrEqual(btn.height + 16) // the cell's padding only
  await expect(row(empty.name).getByRole('button', { name: 'Delete' })).toBeEnabled()
})

test('REQ_DEP_027 an arrow out of a milestone at Month zoom to a dependent starting the next day never bends back', async ({ page, baseURL }) => {
  // the dependent is in a second workstream, so the arrow has to leave the diamond's tip and go down: the branch that could bend back
  const { team, roadmap, ws } = await createScene(baseURL!, 2)
  const m = await createMilestone(baseURL!, roadmap, ws[0].id, isoDay(10), { name: `Gate ${rand()}` })
  const d = await createDeliverable(baseURL!, roadmap, [ws[1].id], isoDay(11), isoDay(25), { name: `Next ${rand()}` })
  await createItemDependency(baseURL!, asItem.m(m), asItem.d(d))
  await openTeam(page, team.id)
  await page.click('[data-z=month]')
  await expect(page.locator('[data-z=month]')).toHaveClass(/\bon\b/)
  await page.locator('#sw-deps').click()
  await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
  const path = page.locator(`g.dep[data-dep-from-kind="milestone"][data-dep-from="${m.id}"][data-dep-to-kind="deliverable"][data-dep-to="${d.id}"] .dep-line`)
  await expect(path).toHaveCount(1)
  const dAttr = (await path.getAttribute('d'))!
  // the x after each command: M and L carry "x,y", H carries just x, V carries none (a centred diamond gives a plain "M x,y H x")
  const xs = [...dAttr.matchAll(/([MLH])\s*(-?\d+(?:\.\d+)?)/g)].map((c) => Number(c[2]))
  expect(dAttr, 'a bend: the arrow goes down before it goes right').toMatch(/V/)
  expect(xs.length).toBeGreaterThanOrEqual(2)
  for (let i = 1; i < xs.length; i++) expect(xs[i], `x never decreases in "${dAttr}"`).toBeGreaterThanOrEqual(xs[i - 1] - 0.01)
})
