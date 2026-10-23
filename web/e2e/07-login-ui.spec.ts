// Phase 6 login UI in a real browser against the real server (REQ_AUTH_005/006/007).
// Every test starts logged out (empty storageState) and logs in through the dialog as a throw-away admin
// created through the authenticated admin API; e2e-admin is never logged in here, locked or disabled.
//
// Lockout budget: failed logins are counted per connection address (every request here is 127.0.0.1) and
// five lock the address for 15 minutes. This file makes exactly ONE wrong-password attempt (REQ_AUTH_005).
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { apiFetch, createDeliverable, teamRoadmap, createTeam, createWorkstream, isoDay, ANON_STATE } from './builders'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light', storageState: ANON_STATE })

const PASSWORD = 'correct-horse-battery'
const rand = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

async function throwawayUser(baseURL: string): Promise<string> {
  const username = `ui-${rand()}`
  const res = await apiFetch(baseURL, '/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  expect(res.status).toBe(201)
  return username
}

async function scene(baseURL: string) {
  const team = await createTeam(baseURL)
  const roadmap = await teamRoadmap(baseURL, team)
  const ws = await createWorkstream(baseURL, roadmap, { name: 'Alpha' })
  const deliverable = await createDeliverable(baseURL, roadmap, [ws.id], isoDay(2), isoDay(40), { name: `Work ${rand()}` })
  return { team, roadmap, deliverable }
}

async function openRoadmap(page: Page, teamId: number) {
  await page.goto(`/#/teams/${teamId}`)
  await expect(page.locator('.deliverable:not(.dup)').first()).toBeVisible()
}

async function logInThroughDialog(page: Page, username: string) {
  const dialog = page.getByRole('dialog', { name: 'Log in' })
  await dialog.getByLabel('Username').fill(username)
  await dialog.getByLabel('Password').fill(PASSWORD)
  await dialog.locator('[data-testid=login-submit]').click()
  await expect(dialog).toHaveCount(0)
}

test('REQ_AUTH_005 the Log in dialog opens over the roadmap; a wrong password shows an inline error; a correct one makes the same page editable without a reload', async ({ page, baseURL }) => {
  const username = await throwawayUser(baseURL!)
  const { team } = await scene(baseURL!)
  await openRoadmap(page, team.id)
  await expect(page.locator('button[title="New deliverable"]')).toHaveCount(0) // read-only before

  // state that a reload or a route change would lose
  await page.click('[data-z=month]')
  await expect(page.locator('[data-z=month]')).toHaveClass(/\bon\b/)
  const scrollBefore = await page.evaluate(() => {
    const el = document.querySelector('.tl-scroll') as HTMLElement
    el.scrollLeft = 240
    ;(window as unknown as { __marker: string }).__marker = 'same-document'
    return { left: el.scrollLeft, top: el.scrollTop, hash: location.hash }
  })
  expect(scrollBefore.left).toBeGreaterThan(0)

  await page.locator('[data-testid=login-button]').click()
  const dialog = page.getByRole('dialog', { name: 'Log in' })
  await expect(dialog).toBeVisible()

  // the ONE wrong-password attempt of this spec
  await dialog.getByLabel('Username').fill(username)
  await dialog.getByLabel('Password').fill('definitely-not-the-password')
  await dialog.locator('[data-testid=login-submit]').click()
  await expect(dialog.locator('[data-testid=login-error]')).toBeVisible()
  await expect(dialog).toBeVisible() // still open, no navigation
  await expect(page.locator('button[title="New deliverable"]')).toHaveCount(0)

  await dialog.getByLabel('Password').fill(PASSWORD)
  await dialog.locator('[data-testid=login-submit]').click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('button[title="New deliverable"]')).toBeVisible()

  // same document: no reload, no navigation, zoom and scroll untouched
  const after = await page.evaluate(() => ({
    marker: (window as unknown as { __marker?: string }).__marker,
    hash: location.hash,
    left: (document.querySelector('.tl-scroll') as HTMLElement).scrollLeft,
    top: (document.querySelector('.tl-scroll') as HTMLElement).scrollTop,
  }))
  expect(after.marker).toBe('same-document')
  expect(after.hash).toBe(scrollBefore.hash)
  expect(after.left).toBe(scrollBefore.left)
  expect(after.top).toBe(scrollBefore.top)
  await expect(page.locator('[data-z=month]')).toHaveClass(/\bon\b/)
  await expect(page.locator('[data-testid=account-menu]')).toContainText(username)
})

test('REQ_AUTH_006 the account menu offers Admin and Log out; Log out returns the page to read-only and a write is then 401', async ({ page, baseURL }) => {
  const username = await throwawayUser(baseURL!)
  const { team } = await scene(baseURL!)
  await openRoadmap(page, team.id)
  await page.locator('[data-testid=login-button]').click()
  await logInThroughDialog(page, username)
  await expect(page.locator('button[title="New deliverable"]')).toBeVisible()

  await page.locator('[data-testid=account-menu]').click()
  await expect(page.getByRole('menuitem', { name: 'Admin' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Log out' }).click()

  await expect(page.locator('[data-testid=login-button]')).toBeVisible()
  await expect(page.locator('[data-testid=account-menu]')).toHaveCount(0)
  await expect(page.locator('button[title="New deliverable"]')).toHaveCount(0)
  const write = await page.request.post('/api/teams', { data: { name: `Nope ${rand()}`, tag: 'NOPE' } })
  expect(write.status()).toBe(401)
})

// Logs in through the dialog, then ends the session server-side by logging out through the API with the
// browser's own cookie, so the page still believes it is logged in.
async function loginThenKillSession(page: Page, context: BrowserContext, baseURL: string) {
  const username = await throwawayUser(baseURL)
  const { team, roadmap, deliverable } = await scene(baseURL)
  await openRoadmap(page, team.id)
  await page.locator('[data-testid=login-button]').click()
  await logInThroughDialog(page, username)
  await expect(page.locator('button[title="New deliverable"]')).toBeVisible()
  const cookie = (await context.cookies()).find((c) => c.name === 'session')!
  const out = await fetch(`${baseURL}/api/logout`, { method: 'POST', headers: { Cookie: `session=${cookie.value}`, 'Content-Type': 'application/json' }, body: '{}' })
  expect(out.status).toBe(204)
  return { username, roadmap, deliverable }
}

const apiTitle = async (baseURL: string, roadmapId: number) => (await (await fetch(`${baseURL}/api/roadmaps/${roadmapId}`)).json()).title

async function renameTitleInUi(page: Page, newTitle: string) {
  await page.locator('#rm-title').click()
  const input = page.getByLabel('Roadmap title')
  await input.fill(newTitle)
  await input.press('Enter')
}

test('REQ_AUTH_007 a roadmap rename rejected because the session ended shows the banner, nothing is saved, the banner button reopens the login dialog, and after logging in again nothing was resent and the rename can be saved again', async ({ page, baseURL, context }) => {
  const { username, roadmap } = await loginThenKillSession(page, context, baseURL!)
  const newTitle = `Renamed ${rand()}`
  await renameTitleInUi(page, newTitle)
  const banner = page.locator('[data-testid=session-banner]')
  await expect(banner).toBeVisible()
  expect(await apiTitle(baseURL!, roadmap.id)).toBe(roadmap.title)
  await banner.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('dialog', { name: 'Log in' })).toBeVisible()

  // after logging in again nothing is resent; the user saves the rename again
  await expect(page.locator('#rm-title')).toContainText('Not saved — log in and save again')
  await logInThroughDialog(page, username)
  await expect(banner).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(await apiTitle(baseURL!, roadmap.id)).toBe(roadmap.title)
  await renameTitleInUi(page, newTitle)
  await expect.poll(() => apiTitle(baseURL!, roadmap.id)).toBe(newTitle)
  await expect(page.locator('#rm-title')).toHaveText(newTitle)
})

// While the full edit window is open its overlay covers the whole page, banner included: the banner's
// "Log in" button must still be reachable (a real click, not a forced one), or the user cannot recover.
test('REQ_AUTH_007 the session banner stays usable while the full edit window is open', async ({ page, baseURL, context }) => {
  await loginThenKillSession(page, context, baseURL!)
  await page.locator('.deliverable:not(.dup)').first().hover()
  await page.locator('.deliverable:not(.dup) button[title="Edit deliverable"]').first().click()
  const edit = page.getByRole('dialog', { name: 'Edit deliverable' })
  const field = edit.getByLabel('Title')
  await field.fill(`Typed ${rand()}`)
  await field.blur()
  const banner = page.locator('[data-testid=session-banner]')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Log in' }).click({ timeout: 3000 })
  await expect(page.getByRole('dialog', { name: 'Log in' })).toBeVisible()
})

test('REQ_AUTH_007 a deliverable title typed in the side panel form survives a rejected save with the message under it, and saving again after logging in again completes it', async ({ page, baseURL, context }) => {
  const { username, deliverable } = await loginThenKillSession(page, context, baseURL!)
  await page.locator('.deliverable:not(.dup)').first().click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const newName = `Typed ${rand()}`
  const field = page.getByLabel('Title')
  await field.fill(newName)
  await field.blur()

  const banner = page.locator('[data-testid=session-banner]')
  await expect(banner).toBeVisible()
  await banner.getByRole('button', { name: 'Log in' }).click()
  const dialog = page.getByRole('dialog', { name: 'Log in' })
  await expect(dialog).toBeVisible()
  await expect(field).toHaveValue(newName) // the typed value is still in the form behind the dialog
  const stored = async () => (await (await fetch(`${baseURL}/api/deliverables/${deliverable.id}`)).json()).name
  expect(await stored()).toBe(deliverable.name)

  await expect(page.getByText('Not saved — log in and save again')).toBeVisible()
  await logInThroughDialog(page, username)
  await page.waitForTimeout(300)
  expect(await stored()).toBe(deliverable.name) // nothing was resent
  await field.fill(`${newName}!`)
  await field.blur()
  await expect.poll(stored).toBe(`${newName}!`)
})
