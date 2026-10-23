// Move a milestone to another team (REQ_FE_122) against the REAL running app. The scene is built through the app's own
// API (builders.ts) and what was saved is read back from the server. "(move)" is located by role and name, and edit
// mode is opened first when the panel has an Edit button, so the test holds whether or not the panel has an edit mode.
import { expect, test, type Page } from '@playwright/test'
import { apiFetch, asItem, createDeliverable, createItemDependency, createMilestone, createScene, createWorkstream, getMilestoneDate, isoDay, listItemDependencies } from './builders'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)
const ms = (page: Page, id: number) => page.locator(`.ms[data-ms="${id}"]`)

async function roadmapOf(baseURL: string, milestoneId: number, roadmapId: number): Promise<boolean> {
  const body = await (await apiFetch(baseURL, `/api/roadmaps/${roadmapId}`)).json()
  return body.milestones.some((m: { id: number }) => m.id === milestoneId)
}

test('REQ_FE_122 move a milestone to another team: it leaves this roadmap and appears on the destination\'s, date and dependencies unchanged', async ({ page, baseURL }) => {
  const url = baseURL!
  const a = await createScene(url)
  const b = await createScene(url)
  const wsName = `Stream ${rand()}`
  const wsA = await createWorkstream(url, a.roadmap, { name: wsName })
  const wsB = await createWorkstream(url, b.roadmap, { name: wsName }) // same name: chosen by default
  const P = await createDeliverable(url, a.roadmap, [wsA.id], isoDay(0), isoDay(14), { name: `Before ${rand()}` })
  const M = await createMilestone(url, a.roadmap, wsA.id, isoDay(25), { name: `Beta ${rand()}` })
  const Q = await createDeliverable(url, a.roadmap, [wsA.id], isoDay(40), isoDay(55), { name: `After ${rand()}` })
  await createItemDependency(url, asItem.d(P), asItem.m(M))
  await createItemDependency(url, asItem.m(M), asItem.d(Q))
  const date = await getMilestoneDate(url, M)
  const edges = async () => (await listItemDependencies(url, asItem.m(M))).map((e) => [e.from_kind, e.from_id, e.to_kind, e.to_id]).sort()
  const edgesBefore = await edges()
  expect(edgesBefore).toHaveLength(2)

  await page.goto(`/#/teams/${a.team.id}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()
  await page.click('[data-z=quarter]')
  await ms(page, M.id).click()
  const panel = page.getByTestId('side-panel')
  const move = panel.getByRole('button', { name: '(move)' })
  if (!(await move.count())) await panel.getByRole('button', { name: 'Edit', exact: true }).click() // "(move)" sits in edit mode once the panel has one
  await move.click()

  const dialog = page.getByRole('dialog', { name: 'Move milestone' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('radio', { name: b.team.name }).check() // the same dialog as a deliverable's (REQ_FE_030)
  await expect(dialog.getByLabel(`Destination for ${wsName}`)).toHaveValue(String(wsB.id))
  await dialog.getByRole('button', { name: `Move to ${b.team.name}` }).click()
  await expect(dialog).toHaveCount(0)

  // gone from this roadmap, on the destination's, with the same date and the same two dependencies
  await expect(ms(page, M.id)).toHaveCount(0)
  expect(await roadmapOf(url, M.id, a.roadmap.id)).toBe(false)
  expect(await roadmapOf(url, M.id, b.roadmap.id)).toBe(true)
  const moved = { ...M, roadmapId: b.roadmap.id }
  expect(await getMilestoneDate(url, moved)).toBe(date)
  expect(await edges()).toEqual(edgesBefore)

  await page.goto(`/#/teams/${b.team.id}`)
  await expect(ms(page, M.id)).toBeVisible()
})
