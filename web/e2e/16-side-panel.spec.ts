// Improvements 10b/10c in a real browser: what jsdom cannot prove about the side panel (layout, drag, scrolling inside
// the card, computed styles in both themes).
// Already covered elsewhere and therefore not repeated: the move dialog (15-move-deliverable), the drag-to-reorder
// and move-only delete (14-manage-workstreams), the view mode and the Manage workstreams page's read-only and last-workstream
// cases (the Vitest tests), the theme toggle itself (TopBar.test.tsx, REQ_FE_104).
// Runs in the `side-panel-ui` project (logged in as e2e-admin).
import { expect, test, type Page } from '@playwright/test'
import { apiFetch, createDeliverable, createScene, isoDay } from './builders'

test.use({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' })

// A team with two workstreams and one deliverable spanning days 2..20 (19 days), made In progress, with a colour and a label.
async function scene(baseURL: string) {
  const { team, roadmap, ws } = await createScene(baseURL, 2)
  const d = await createDeliverable(baseURL, roadmap, [ws[0].id, ws[1].id], isoDay(2), isoDay(20), { name: 'Panel subject' })
  const res = await apiFetch(baseURL, `/api/deliverables/${d.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'in_progress', color: '#1f9d6b', icons: ['rocket'] }),
  })
  if (!res.ok) throw new Error(`patch failed: ${res.status} ${await res.text()}`)
  return { team, roadmap, ws, d }
}

async function openPanel(page: Page, teamId: number, name = 'Panel subject') {
  await page.goto(`/#/teams/${teamId}`)
  await page.locator('.deliverable', { hasText: name }).first().click()
  await expect(page.getByTestId('side-panel')).toBeVisible()
  await expect(page.getByTestId('side-panel').locator('h2')).toHaveText(name)
}

const panelWidth = async (page: Page) => Math.round((await page.getByTestId('side-panel').boundingBox())!.width)

test('REQ_FE_110 REQ_FE_115 the panel is a card right of the timeline behind a 20 px divider; dragging resizes it and that survives a reload; there is no width footer; a panel taller than the window scrolls inside itself while the page does not', async ({ page, baseURL }) => {
  await test.step('the panel is a card right of the timeline behind a 20 px divider; dragging resizes it and that survives a reload; there is no width footer', async () => {
    const { team } = await scene(baseURL!)
    await page.goto(`/#/teams/${team.id}`)
    await expect(page.locator('.deliverable').first()).toBeVisible()

    // REQ_FE_115: nothing selected yet
    await expect(page.getByTestId('side-panel')).toContainText('Select a deliverable or milestone')

    const panel = page.getByTestId('side-panel')
    const handle = page.getByTestId('panel-resize-handle')
    const hb = (await handle.boundingBox())!
    const pb = (await panel.boundingBox())!
    const dbar = (await page.locator('.deliverable').first().boundingBox())!
    expect(Math.round(hb.width)).toBe(20)
    expect(hb.x + hb.width).toBeLessThanOrEqual(pb.x + 0.5) // the divider sits between the timeline and the card
    expect(dbar.x + dbar.width).toBeLessThanOrEqual(hb.x + 0.5)
    const style = await panel.evaluate((el) => {
      const s = getComputedStyle(el)
      return { radius: parseFloat(s.borderTopLeftRadius), shadow: s.boxShadow }
    })
    expect(style.radius).toBeGreaterThan(0)
    expect(style.shadow).not.toBe('none')
    expect(await panelWidth(page)).toBe(336)

    // drag the divider 100 px to the left: the card grows by 100 px
    const x = hb.x + hb.width / 2
    const y = hb.y + 120
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 50, y, { steps: 5 })
    await page.mouse.move(x - 100, y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => panelWidth(page)).toBe(436)
    await page.reload()
    await expect(page.locator('.deliverable').first()).toBeVisible()
    await expect.poll(() => panelWidth(page)).toBe(436) // remembered in this browser
    await expect(panel).not.toContainText('saved in this browser')
    await expect(panel.getByRole('button', { name: 'Reset' })).toHaveCount(0)
  })

  await test.step('a panel taller than the window scrolls inside itself while the page does not', async () => {
    const { team } = await scene(baseURL!)
    await page.setViewportSize({ width: 1600, height: 460 })
    await openPanel(page, team.id)
    const panel = page.getByTestId('side-panel')
    await panel.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(panel.getByLabel('Deliverable quick-edit form')).toBeVisible()
    const m = await panel.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
    expect(m.sh).toBeGreaterThan(m.ch)
    const box = (await panel.boundingBox())!
    const pageBefore = await page.evaluate(() => window.scrollY)
    await page.mouse.move(box.x + box.width / 2, box.y + 150)
    await page.mouse.wheel(0, 300)
    await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(pageBefore)
  })
})

test('REQ_FE_114 REQ_FE_027 Edit opens the form, an end before the start shows its message with the red-border class, and the Done button returns to view mode', async ({ page, baseURL }) => {
  const { team } = await scene(baseURL!)
  await openPanel(page, team.id)
  const panel = page.getByTestId('side-panel')
  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  const form = panel.getByLabel('Deliverable quick-edit form')
  await expect(form).toBeVisible()
  await expect(panel.getByTestId('panel-status')).toHaveCount(0)

  const end = form.getByLabel('End date')
  const start = await form.getByLabel('Start date').inputValue()
  const earlier = new Date(start + 'T12:00:00')
  earlier.setDate(earlier.getDate() - 3)
  const iso = `${earlier.getFullYear()}-${String(earlier.getMonth() + 1).padStart(2, '0')}-${String(earlier.getDate()).padStart(2, '0')}`
  await end.fill(iso)
  await end.blur()
  await expect(form.getByRole('alert').filter({ hasText: /End can.t be before the start date/ })).toBeVisible()
  await expect(end).toHaveClass(/\bbad\b/)
  await expect(end).toHaveValue(iso) // what was typed is kept

  await panel.getByRole('button', { name: 'Done editing' }).click()
  await expect(panel.getByLabel('Deliverable quick-edit form')).toHaveCount(0)
  await expect(panel.getByTestId('panel-status')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
})

test('REQ_FE_081 REQ_FE_111 in the dark theme the panel card and its controls use the theme tokens, none the browser-default background', async ({ page, baseURL }) => {
  const { team } = await scene(baseURL!)
  await openPanel(page, team.id)
  const panel = page.getByTestId('side-panel')

  // the colour a token resolves to right now, read through a probe element
  const token = (name: string) =>
    page.evaluate((n) => {
      const p = document.createElement('div')
      p.style.backgroundColor = `var(${n})`
      document.body.appendChild(p)
      const c = getComputedStyle(p).backgroundColor
      p.remove()
      return c
    }, name)
  const bg = (loc: ReturnType<Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).backgroundColor)
  // every button and input in the card: transparent, or one of the theme's own colours — never the browser's grey/white
  const stray = (allowed: string[]) =>
    panel.evaluate((root, ok) => {
      const bad: string[] = []
      root.querySelectorAll('button, input, select, textarea').forEach((el) => {
        if (/^Color #/.test(el.getAttribute('aria-label') ?? '')) return // palette swatches are the colours themselves
        const c = getComputedStyle(el).backgroundColor
        if (c !=='rgba(0, 0, 0, 0)' && !ok.includes(c)) bad.push(`${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent ?? ''} ${c}`)
      })
      return bad
    }, allowed)
  const allowedTokens = () => Promise.all(['--surface', '--surface-2', '--accent', '--accent-soft', '--danger-soft', '--bg'].map(token))

  await panel.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(panel.getByLabel('Deliverable quick-edit form')).toBeVisible()
  const lightCard = await bg(panel)
  expect(lightCard).toBe(await token('--surface'))
  expect(await stray(await allowedTokens())).toEqual([])

  await page.getByTestId('theme-toggle').click()
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
  const darkCard = await bg(panel)
  expect(darkCard).not.toBe(lightCard)
  expect(darkCard).toBe(await token('--surface'))
  const dark = await allowedTokens()
  await expect.poll(() => stray(dark)).toEqual([]) // polls: buttons ease their background over .15 s after the switch

  await page.getByTestId('theme-toggle').click() // back to light so the context ends as it began
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
})
