// Improvements 10c in a real browser: the Manage workstreams page opened from the top bar's Workstream button, a
// reorder by dragging a grip with the real mouse that survives a reload of the roadmap, and the move-only delete
// (REQ_FE_105, REQ_FE_106, REQ_FE_109). Scenes are built through the API (builders.ts).
// Runs in the `manage-workstreams-ui` project (logged in as e2e-admin).
import { expect, test, type Page } from '@playwright/test'
import { apiFetch, createDeliverable, createMilestone, createScene, isoDay } from './builders'

test.use({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' })

const rowNames = (page: Page) => page.locator('[data-testid="ws-row"] .nm').allTextContents()

test('REQ_FE_106 REQ_FE_105 a workstream dragged with the mouse keeps its new place on the roadmap after a reload', async ({ page, baseURL }) => {
  const { team, roadmap, ws } = await createScene(baseURL!, 3)
  for (const w of ws) await createDeliverable(baseURL!, roadmap, [w.id], isoDay(2), isoDay(20)) // every workstream holds something, so each is drawn (REQ_FE_127)
  await page.goto(`/#/teams/${team.id}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()

  await page.getByTestId('add-workstream').click() // the top bar's Workstream button
  await expect(page).toHaveURL(new RegExp(`#/teams/${team.id}/workstreams$`))
  await expect(page.getByRole('heading', { name: 'Manage workstreams' })).toBeVisible()
  expect(await rowNames(page)).toEqual(['General', ...ws.map((w) => w.name)]) // the blank roadmap's own + the three

  const grip = page.getByLabel(`Reorder ${ws[2].name}`)
  const target = (await page.getByTestId('ws-row').first().boundingBox())!
  const from = (await grip.boundingBox())!
  const x = from.x + from.width / 2
  await page.mouse.move(x, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, from.y - 60, { steps: 6 })
  await page.mouse.move(x, target.y + 2, { steps: 6 })
  await expect(page.getByText('dragging…')).toBeVisible()
  await page.mouse.up()

  const after = [ws[2].name, 'General', ws[0].name, ws[1].name]
  await expect.poll(() => rowNames(page)).toEqual(after)

  await page.getByTestId('back-to-roadmap').click()
  await page.reload()
  await expect(page.locator('.deliverable').first()).toBeVisible()
  await expect(page.locator('.ws-label').first()).toContainText(ws[2].name)
  const labels = await page.locator('.ws-label').allTextContents()
  // the empty "General" is not drawn on the roadmap (REQ_FE_127); the others keep the new order
  expect(after.map((n) => labels.findIndex((l) => l.includes(n)))).toEqual([0, -1, 1, 2])

  await page.goto(`/#/teams/${team.id}/workstreams`) // the address survives a reload
  await page.reload()
  await expect.poll(() => rowNames(page)).toEqual(after)
})

test('REQ_FE_109 deleting a non-empty workstream moves its deliverables and milestones to the chosen target', async ({ page, baseURL }) => {
  const { team, roadmap, ws } = await createScene(baseURL!, 2)
  const d = await createDeliverable(baseURL!, roadmap, [ws[0].id], isoDay(2), isoDay(20), { name: 'Moves along' })
  const m = await createMilestone(baseURL!, roadmap, ws[0].id, isoDay(10), { name: 'Moves too' })
  await page.goto(`/#/teams/${team.id}/workstreams`)
  await expect(page.getByRole('heading', { name: 'Manage workstreams' })).toBeVisible()

  await page.getByLabel(`Delete ${ws[0].name}`).click()
  const dialog = page.getByTestId('delete-workstream-dialog')
  await expect(dialog).toContainText('This workstream contains 1 deliverable and 1 milestone.')
  const confirm = page.getByTestId('delete-ws-confirm')
  await expect(confirm).toBeDisabled() // no target chosen yet
  await page.getByLabel('Move them to another workstream').selectOption({ label: ws[1].name })
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect(page.getByTestId('ws-notice')).toHaveText(new RegExp(`Deleted ${ws[0].name}; 2 items moved to ${ws[1].name}`))
  await expect.poll(() => rowNames(page)).not.toContain(ws[0].name)
  await expect(page.locator('[data-testid="ws-row"]', { hasText: ws[1].name })).toContainText('1 deliverable · 1 milestone')

  const dRes = await (await apiFetch(baseURL!, `/api/deliverables/${d.id}`)).json()
  expect(dRes.workstream_ids).toEqual([ws[1].id])
  const rm = await (await apiFetch(baseURL!, `/api/roadmaps/${roadmap.id}`)).json()
  expect(rm.milestones.find((x: { id: number }) => x.id === m.id).workstream_id).toBe(ws[1].id)
})
