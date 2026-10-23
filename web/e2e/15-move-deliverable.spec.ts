// Move a deliverable to another team (Improvements 10b, REQ_FE_021/030) against the REAL running app. Every scene is
// built through the app's own API (builders.ts) and what was saved is read back from the server.
import { expect, test, type Page } from '@playwright/test'
import { apiFetch, createDeliverable, createDependency, createScene, createWorkstream, isoDay, listDependencies } from './builders'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)

async function roadmapOf(baseURL: string, deliverableId: number): Promise<number> {
  const res = await apiFetch(baseURL, `/api/deliverables/${deliverableId}`)
  return (await res.json()).roadmap_id
}

async function openMoveDialog(page: Page, teamId: number, deliverableId: number) {
  await page.goto(`/#/teams/${teamId}`)
  await page.locator(`.deliverable:not(.dup)[data-deliverable="${deliverableId}"]`).first().click()
  await page.getByRole('button', { name: '(move)' }).click()
  await expect(page.getByRole('dialog', { name: 'Move deliverable' })).toBeVisible()
}

test('REQ_FE_030 move a deliverable to another team: it lands on that team\'s roadmap with its dependencies, and a plain notice (no Undo) says so', async ({ page, baseURL }) => {
  const url = baseURL!
  const a = await createScene(url)
  const b = await createScene(url)
  const wsName = `Stream ${rand()}`
  const wsA = await createWorkstream(url, a.roadmap, { name: wsName })
  const wsB = await createWorkstream(url, b.roadmap, { name: wsName }) // same name: matched by default
  const P = await createDeliverable(url, a.roadmap, [wsA.id], isoDay(0), isoDay(14), { name: `Move me ${rand()}` })
  const Q = await createDeliverable(url, a.roadmap, [wsA.id], isoDay(20), isoDay(30), { name: `Stays ${rand()}` })
  await createDependency(url, P, Q)

  await openMoveDialog(page, a.team.id, P.id)
  await page.getByRole('radio', { name: b.team.name }).check()
  await expect(page.getByLabel(`Destination for ${wsName}`)).toHaveValue(String(wsB.id))
  await expect(page.getByTestId('move-summary')).toContainText('1 dependency stays (1 becomes cross-team)')
  await page.getByRole('button', { name: `Move to ${b.team.name}` }).click()

  const toast = page.getByRole('status')
  await expect(toast).toContainText(`Moved “${P.name}” to ${b.team.name}`)
  await expect(toast.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  expect(await roadmapOf(url, P.id)).toBe(b.roadmap.id)
  const edges = await listDependencies(url, P)
  expect(edges).toHaveLength(1)

  await page.goto(`/#/teams/${b.team.id}`)
  await expect(page.locator(`.deliverable:not(.dup)[data-deliverable="${P.id}"]`).first()).toBeVisible()

})

