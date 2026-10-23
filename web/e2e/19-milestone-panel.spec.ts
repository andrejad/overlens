// Improvements 11, REQ_FE_100: the milestone side panel's per-field autosave edit form
// against the REAL running app. Runs in its own project (logged in as e2e-admin).
import { expect, test, type Page } from '@playwright/test'
import { apiFetch, createMilestone, createScene, getMilestoneDate, isoDay } from './builders'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)
const ms = (page: Page, id: number) => page.locator(`.ms[data-ms="${id}"]`)

async function milestoneOnServer(baseURL: string, roadmapId: number, id: number) {
  const body = await (await apiFetch(baseURL, `/api/roadmaps/${roadmapId}`)).json()
  return body.milestones.find((m: { id: number }) => m.id === id) as { name: string; date: string; workstream_id: number; description_html: string } | undefined
}

test('REQ_FE_100 edit name, date, workstream and description field by field, press Done, reload and see them', async ({ page, baseURL }) => {
  const url = baseURL!
  const { team, roadmap, ws } = await createScene(url, 2)
  const M = await createMilestone(url, roadmap, ws[0].id, isoDay(25), { name: `Beta ${rand()}` })
  await page.goto(`/#/teams/${team.id}`)
  await expect(ms(page, M.id)).toBeVisible()
  await ms(page, M.id).click()
  const panel = page.getByTestId('side-panel')
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const form = panel.getByTestId('milestone-edit-form')
  await expect(form.getByRole('button', { name: '(move)' })).toBeVisible()

  const newName = `Renamed ${rand()}`
  await form.getByLabel('Name', { exact: true }).fill(newName)
  await form.getByLabel('Date', { exact: true }).focus() // leaving the name saves it
  await expect.poll(async () => (await milestoneOnServer(url, roadmap.id, M.id))?.name).toBe(newName)

  await form.getByLabel('Date', { exact: true }).fill(isoDay(30))
  await form.getByLabel('Name', { exact: true }).focus()
  await expect.poll(() => getMilestoneDate(url, M)).toBe(isoDay(30))

  await form.getByLabel('Workstream', { exact: true }).selectOption({ label: ws[1].name })
  await expect.poll(async () => (await milestoneOnServer(url, roadmap.id, M.id))?.workstream_id).toBe(ws[1].id)

  const note = `Ship it ${rand()}`
  await form.locator('.editor .ProseMirror').click()
  await page.keyboard.type(note)
  await form.getByLabel('Name', { exact: true }).focus() // leaving the editor saves the description
  await expect.poll(async () => (await milestoneOnServer(url, roadmap.id, M.id))?.description_html).toContain(note)

  await form.getByTestId('edit-done').click()
  await expect(form).toHaveCount(0)
  await expect(panel).toContainText(note)

  await page.reload()
  await expect(ms(page, M.id)).toContainText(newName)
  await ms(page, M.id).click()
  await expect(panel).toContainText(note)
  await expect(panel).toContainText(ws[1].name)
  await expect(panel.getByTestId('panel-depends-on')).toContainText('None')
})

test('REQ_FE_124 choosing a font and size in the description toolbar formats the remembered selection, keeps the keyboard on the select, and the server keeps the styles', async ({ page, baseURL }) => {
  const url = baseURL!
  const { team, roadmap, ws } = await createScene(url, 1)
  const M = await createMilestone(url, roadmap, ws[0].id, isoDay(25), { name: `Fonts ${rand()}` })
  await page.goto(`/#/teams/${team.id}`)
  await ms(page, M.id).click()
  const panel = page.getByTestId('side-panel')
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const form = panel.getByTestId('milestone-edit-form')
  const editor = form.locator('.editor .ProseMirror')
  await editor.click()
  await page.keyboard.type('Styled words')
  await page.keyboard.press('Control+A')
  const font = form.getByLabel('Font', { exact: true })
  await font.focus() // as a click on the select does: the editor loses focus
  await font.selectOption({ label: 'Serif' })
  await expect(font).toBeFocused() // the change does not pull the focus back into the editor
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes('/api/milestones/') && (r.request().postData() ?? '').includes('24px'),
  )
  const size = form.getByLabel('Size', { exact: true })
  await size.focus()
  await size.selectOption({ label: '24' })
  await expect(editor.locator('span')).toHaveAttribute('style', /Georgia, serif/)
  await expect(editor.locator('span')).toHaveAttribute('style', /font-size: 24px/)
  await expect(size).toBeFocused() // keyboard users can step through the options
  await expect(font).toHaveValue('Georgia, serif')
  const body = await (await saved).json() // the select's change saves at once, and the server keeps both styles (REQ_API_030)
  expect(body.description_html).toContain('Georgia, serif')
  expect(body.description_html).toContain('font-size: 24px')
})
