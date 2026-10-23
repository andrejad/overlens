// Phase 6 admin screen (#/admin) in a real browser against the real server, logged in as the bootstrap
// admin through storageState (REQ_AUTH_013-015, REQ_FE_080, REQ_AUD_008/015/016).
//
// Throw-away users only: e2e-admin is never disabled, locked or given a new password. The one test that
// clicks "Disable" on the e2e-admin row expects the server's 409 self_disable refusal; if that ever
// succeeded the rest of the run would fail loudly, which is the point of the test.
//
// Login budget: logging in as a new user happens through the real login dialog, and only with the right
// password.
import { expect, test, type Page } from '@playwright/test'
import { apiFetch, createDeliverable, teamRoadmap, createTeam, createWorkstream, isoDay, ANON_STATE } from './builders'

test.use({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' })

const PASSWORD = 'correct-horse-battery'
const rand = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const json = { 'Content-Type': 'application/json' }

async function openAdmin(page: Page) {
  await page.goto('/#/admin')
  await expect(page.locator('[data-testid=admin-page]')).toBeVisible()
}

async function apiUsers(baseURL: string): Promise<{ id: number; username: string; role: string; disabled: boolean }[]> {
  return (await (await apiFetch(baseURL, '/api/users')).json()).items
}

test.describe('REQ_AUTH_013 REQ_AUTH_014 REQ_AUTH_015 users card', () => {
  test('REQ_AUTH_013 an admin creates an admin through the UI, resets its password, disables and re-enables it; the new admin then logs in through the dialog', async ({ page, baseURL, browser }) => {
    await openAdmin(page)
    const username = `new-${rand()}`
    const users = page.locator('#admin-users')
    await users.getByRole('button', { name: 'Add admin' }).click()
    await users.getByLabel('New username').fill(username)
    await users.getByLabel('New password').fill('first-password-1')
    await users.getByRole('button', { name: 'Create admin' }).click()

    const row = page.locator(`[data-testid="user-row-${username}"]`)
    await expect(row).toBeVisible()
    await expect(row).toContainText('admin')
    await expect(row).toContainText('active')
    expect((await apiUsers(baseURL!)).find((u) => u.username === username)).toMatchObject({ role: 'admin', disabled: false })

    // reset its password
    await row.getByRole('button', { name: 'Reset password' }).click()
    await row.getByLabel(`New password for ${username}`).fill(PASSWORD)
    await row.getByRole('button', { name: 'Set password' }).click()
    await expect(users.getByRole('status')).toContainText(`Password reset for ${username}`)

    // disable, then enable
    await row.getByRole('button', { name: 'Disable' }).click()
    await expect(row).toContainText('disabled')
    expect((await apiUsers(baseURL!)).find((u) => u.username === username)!.disabled).toBe(true)
    await row.getByRole('button', { name: 'Enable' }).click()
    await expect(row).toContainText('active')
    expect((await apiUsers(baseURL!)).find((u) => u.username === username)!.disabled).toBe(false)

    // the new admin logs in through the login dialog, in a context of its own, with the reset password
    const ctx = await browser.newContext({ baseURL: baseURL!, storageState: ANON_STATE })
    const other = await ctx.newPage()
    await other.goto('/#/')
    await other.locator('[data-testid=login-button]').click()
    const dialog = other.getByRole('dialog', { name: 'Log in' })
    await dialog.getByLabel('Username').fill(username)
    await dialog.getByLabel('Password').fill(PASSWORD)
    await dialog.locator('[data-testid=login-submit]').click()
    await expect(other.locator('[data-testid=account-menu]')).toContainText(username)
    await ctx.close()
  })
})

test('REQ_FE_080 renaming an icon label in the admin card shows the new label on the real timeline, for an anonymous visitor too, until it is reset', async ({ page, baseURL, browser }) => {
  const team = await createTeam(baseURL!)
  const roadmap = await teamRoadmap(baseURL!, team)
  const ws = await createWorkstream(baseURL!, roadmap)
  const d = await createDeliverable(baseURL!, roadmap, [ws.id], isoDay(1), isoDay(30))
  const patched = await apiFetch(baseURL!, `/api/deliverables/${d.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ icons: ['star'] }) })
  expect(patched.status).toBe(200)
  const label = `E2E label ${rand()}`
  const iconLabel = async () => (await (await fetch(`${baseURL}/api/icons`)).json()).items.find((i: { key: string }) => i.key === 'star').label as string
  const original = await iconLabel()

  try {
    await openAdmin(page)
    const card = page.locator('#admin-icons')
    await card.getByLabel('Label for star', { exact: true }).fill(label)
    await card.getByRole('button', { name: 'Save labels' }).click()
    await expect(card.getByRole('status')).toContainText('Labels saved')
    expect(await iconLabel()).toBe(label)

    // an anonymous visitor sees it at once, as the hover title and the accessible name
    const ctx = await browser.newContext({ baseURL: baseURL!, storageState: ANON_STATE, viewport: { width: 1600, height: 900 } })
    const anon = await ctx.newPage()
    await anon.goto(`/#/teams/${team.id}`)
    const ic = anon.locator('.deliverable:not(.dup) .ic[data-icon=star]')
    await expect(ic).toHaveAttribute('title', label)
    await expect(ic.locator('svg')).toHaveAttribute('aria-label', label)

    // reset through the card
    await card.getByRole('button', { name: 'Reset all to defaults' }).click()
    await card.getByRole('button', { name: 'Save labels' }).click()
    await expect.poll(iconLabel).toBe('High priority')
    await anon.reload()
    await expect(anon.locator('.deliverable:not(.dup) .ic[data-icon=star]')).toHaveAttribute('title', 'High priority')
    await ctx.close()
  } finally {
    await apiFetch(baseURL!, '/api/icons/star', { method: 'PUT', headers: json, body: JSON.stringify({ label: original }) })
  }
})
