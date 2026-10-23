// Improvements 11, REQ_FE_118 / REQ_FE_119: deleting a deliverable from the side panel and from the edit window, in a real
// browser (Done, Escape and the focus return of the edit window are the Vitest tests). Runs in the `delete-deliverable-ui` project (logged in as e2e-admin).
import { expect, test, type Page } from '@playwright/test'
import { apiFetch, createDependency, createDeliverable, createScene, isoDay } from './builders'

// A deliverable in two workstreams (so it has a copy) with an arrow to a second deliverable; arrows switched on.
async function scene(page: Page, baseURL: string) {
  const { team, roadmap, ws } = await createScene(baseURL, 2)
  const tag = Math.random().toString(36).slice(2, 8)
  const doomed = await createDeliverable(baseURL, roadmap, [ws[0].id, ws[1].id], isoDay(2), isoDay(14), { name: `Doomed ${tag}` })
  const keeper = await createDeliverable(baseURL, roadmap, [ws[0].id], isoDay(20), isoDay(34), { name: `Keeper ${tag}` })
  await createDependency(baseURL, doomed, keeper)
  await page.goto(`/#/teams/${team.id}`)
  await expect(page.locator('.deliverable', { hasText: keeper.name }).first()).toBeVisible()
  const sw = page.locator('#sw-deps')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator(`g.dep[data-dep-from="${doomed.id}"][data-dep-to="${keeper.id}"]`)).toHaveCount(1)
  return { team, doomed, keeper }
}

async function expectGone(page: Page, baseURL: string, team: { id: number }, doomed: { id: number; name: string }, keeper: { name: string }) {
  await expect(page.locator('.deliverable', { hasText: doomed.name })).toHaveCount(0)
  await expect(page.locator('g.dep')).toHaveCount(0)
  await expect(page.locator('.deliverable', { hasText: keeper.name }).first()).toBeVisible()
  await page.reload()
  await expect(page.locator('.deliverable', { hasText: keeper.name }).first()).toBeVisible()
  await expect(page.locator('.deliverable', { hasText: doomed.name })).toHaveCount(0)
  expect((await apiFetch(baseURL, `/api/deliverables/${doomed.id}`)).status).toBe(404)
  void team
}

test('REQ_FE_118 deleting from the panel: the confirmation names the copies and links, Cancel sends nothing, Delete removes bar, copy and arrow, and it survives a reload', async ({ page, baseURL }) => {
  const { team, doomed, keeper } = await scene(page, baseURL!)
  await page.locator('.deliverable', { hasText: doomed.name }).first().click()
  const panel = page.getByTestId('side-panel')
  await panel.getByRole('button', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `Delete "${doomed.name}"?` })
  await expect(dialog).toContainText('It disappears from all 2 workstreams.')
  await expect(dialog).toContainText('Its 1 dependency links are removed too.')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect((await apiFetch(baseURL!, `/api/deliverables/${doomed.id}`)).status).toBe(200)
  await panel.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByTestId('delete-item-confirm').click()
  await expect(dialog).toHaveCount(0)
  await expect(panel).toContainText('Select a deliverable or milestone')
  await expectGone(page, baseURL!, team, doomed, keeper)
})

test('REQ_FE_119 deleting from the edit window: Escape leaves the delete dialog first, Delete deliverable closes the window and removes bar and arrow', async ({ page, baseURL }) => {
  const { team, doomed, keeper } = await scene(page, baseURL!)
  await page.locator('.deliverable', { hasText: doomed.name }).first().click()
  await page.getByRole('button', { name: 'Open the full edit window' }).click()
  const win = page.getByRole('dialog', { name: 'Edit deliverable' })
  await expect(win).toBeVisible()
  await expect(win.locator('#d-name')).toBeFocused()
  await expect(win.getByTestId('edit-subtitle')).toHaveText(doomed.name)
  expect(Math.round((await win.locator('> div').boundingBox())!.width)).toBeLessThanOrEqual(760)
  await win.getByRole('button', { name: 'Delete deliverable' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('delete-item-dialog')).toHaveCount(0)
  await expect(win).toBeVisible()
  await win.getByRole('button', { name: 'Delete deliverable' }).click()
  await page.getByTestId('delete-item-confirm').click()
  await expect(win).toHaveCount(0)
  await expectGone(page, baseURL!, team, doomed, keeper)
})

