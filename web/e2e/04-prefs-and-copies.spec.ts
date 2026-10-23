// Browser-remembered preferences (REQ_FE_071) and how copies look (REQ_FE_050), on the real app.
// Data is built through the API (builders.ts); each test runs in a fresh browser context, so its
// localStorage starts empty.
import { expect, test, type Page } from '@playwright/test'
import { createDeliverable, createScene, isoDay, type TeamHandle } from './builders'

test.use({ viewport: { width: 1600, height: 900 }, colorScheme: 'light' })

const rand = () => Math.random().toString(36).slice(2, 8)

async function twoWorkstreamScene(baseURL: string) {
  const { team, roadmap, ws } = await createScene(baseURL, 2)
  const shared = await createDeliverable(baseURL, roadmap, [ws[0].id, ws[1].id], isoDay(0), isoDay(40), { name: `Shared ${rand()}` })
  return { team, shared, ws }
}

async function open(page: Page, team: TeamHandle) {
  await page.goto(`/#/teams/${team.id}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()
}

// Forget everything the previous step stored and reload, so a step cannot pass on what an earlier one left behind.
async function resetPrefs(page: Page) {
  await page.evaluate(() => { window.localStorage.clear(); window.localStorage.setItem('erm.tutorialSeen', 'true') }) // REQ_FE_130: keep the tour from opening by itself
  await page.reload()
  await expect(page.locator('.deliverable').first()).toBeVisible()
  await expect(page.locator('#sw-copies')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'false')
}

const zoomOn = (page: Page, z: string) => expect(page.locator(`[data-z=${z}]`)).toHaveClass(/\bon\b/)
const stored = (page: Page, key: string) => page.evaluate((k) => window.localStorage.getItem(k), key)

test.describe('REQ_FE_071 zoom, copies and dependencies are remembered in this browser, independently', () => {
  test('REQ_FE_071 a fresh browser starts at the defaults: copies shown, dependencies hidden; zoom, the copies choice and the dependencies choice each survive a page reload; changing one preference leaves the others, and the panel width, alone', async ({ page, baseURL }) => {
    await test.step('a fresh browser starts at the defaults: copies shown, dependencies hidden', async () => {
      const { team } = await twoWorkstreamScene(baseURL!)
      await open(page, team)
      await expect(page.locator('#sw-copies')).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'false')
    })

    await test.step('zoom, the copies choice and the dependencies choice each survive a page reload', async () => {
      await resetPrefs(page) // every step starts from a browser that remembers nothing
      const { team } = await twoWorkstreamScene(baseURL!)
      await open(page, team)
      await page.click('[data-z=month]')
      await zoomOn(page, 'month')
      await page.locator('#sw-copies').click() // copies off
      await expect(page.locator('#sw-copies')).toHaveAttribute('aria-checked', 'false')
      await page.reload()
      await expect(page.locator('.deliverable').first()).toBeVisible()
      await zoomOn(page, 'month')
      await expect(page.locator('#sw-copies')).toHaveAttribute('aria-checked', 'false')
      await expect(page.locator('.deliverable.dup')).toHaveCount(0)
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'false')

      await page.locator('#sw-deps').click() // dependencies on
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
      await page.reload()
      await expect(page.locator('.deliverable').first()).toBeVisible()
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
      await expect(page.locator('#sw-deps')).toHaveText(/Hide dependencies/)
      await zoomOn(page, 'month')
    })

    await test.step('changing one preference leaves the others, and the panel width, alone', async () => {
      await resetPrefs(page) // every step starts from a browser that remembers nothing
      const { team, shared } = await twoWorkstreamScene(baseURL!)
      await open(page, team)
      await page.click('[data-z=quarter]')
      await zoomOn(page, 'quarter')
      await page.locator('#sw-copies').click() // copies off
      await page.locator(`.deliverable[data-deliverable="${shared.id}"]`).click() // opens the side panel
      const handle = page.getByTestId('panel-resize-handle')
      await handle.focus()
      await page.keyboard.press('ArrowLeft') // widen the panel
      const width = await stored(page, 'erm.panelWidth')
      expect(width).not.toBeNull()

      const before = { zoom: await stored(page, 'erm.zoom'), copies: await stored(page, 'erm.copies') }
      await page.locator('#sw-deps').click() // only dependencies change
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
      expect(await stored(page, 'erm.zoom')).toBe(before.zoom)
      expect(await stored(page, 'erm.copies')).toBe(before.copies) // locked, but the stored choice is untouched
      expect(await stored(page, 'erm.panelWidth')).toBe(width)

      await page.click('[data-z=half]') // only zoom changes
      await zoomOn(page, 'half')
      expect(await stored(page, 'erm.copies')).toBe(before.copies)
      expect(await stored(page, 'erm.dependencies')).toBe('true')
      expect(await stored(page, 'erm.panelWidth')).toBe(width)

      await page.reload() // and everything comes back as it was left
      await expect(page.locator('.deliverable').first()).toBeVisible()
      await zoomOn(page, 'half')
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
      await page.locator('#sw-deps').click() // off again: the copies choice the user made (off) is what comes back
      await expect(page.locator('#sw-copies')).toHaveAttribute('aria-checked', 'false')
      expect(await stored(page, 'erm.panelWidth')).toBe(width)
    })
  })
})

test.describe('REQ_FE_050 main blocks are solid, copies are dashed and paler', () => {
  test('REQ_FE_050 in its main workstream a deliverable is drawn solid; in its other workstream it is dashed and paler', async ({ page, baseURL }) => {
    const { team, shared, ws } = await twoWorkstreamScene(baseURL!)
    await open(page, team)
    const main = page.locator(`.deliverable:not(.dup)[data-deliverable="${shared.id}"]`)
    const copy = page.locator(`.deliverable.dup[data-deliverable="${shared.id}"]`)
    await expect(main).toHaveCount(1)
    await expect(copy).toHaveCount(1)
    await expect(main).toHaveAttribute('data-ws', ws[0].name) // the first workstream is its main one
    await expect(copy).toHaveAttribute('data-ws', ws[1].name)
    const look = (l: typeof main) =>
      l.evaluate((el) => {
        const cs = getComputedStyle(el)
        // resolve any CSS colour (rgb, color(srgb …) from color-mix) to 0-255 channels via a canvas
        const c = document.createElement('canvas')
        c.width = c.height = 1
        const g = c.getContext('2d')!
        g.fillStyle = cs.backgroundColor
        g.fillRect(0, 0, 1, 1)
        const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data
        return { borderStyle: cs.borderTopStyle, borderWidth: parseFloat(cs.borderTopWidth), lightness: (r + gr + b) / 3, alpha: a }
      })
    const m = await look(main)
    const c = await look(copy)
    expect(m.borderStyle).not.toBe('dashed') // solid, as the main block
    expect(c.borderStyle).toBe('dashed')
    expect(c.lightness).toBeGreaterThan(m.lightness + 30) // paler: clearly closer to the white surface than the full colour
  })
})
