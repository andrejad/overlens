// CORE, runs first and blocks the suite (REQ_TEST_012). Measures only the real app's roadmap screens, each at every zoom
// level, on seeded random data built through the API (REQ_TEST_018, TEST_SEED=<n> replays a run): the team roadmap, the
// company view and the company trace. The frozen wireframe pages are history and are no longer loaded here.
// (The trace's own checks - what it hides, its arrows - live in 09-company-views.spec.ts, not here.)
import { expect, test, type Page } from '@playwright/test'
import { createCompany, createDeliverable, createDependency, createRandomCompany, createScene, isoDay, seededRandom, testSeed } from './builders'
import { findOverlaps, measureScript } from './visibility'

test.use({ viewport: { width: 1600, height: 1000 } })

const zooms = ['year', 'half', 'quarter', 'month']

// The real page, on a random roadmap: several workstreams, deliverables in one or more of them, dependencies
// wherever the dates allow. With arrows on the page shows one block per deliverable (REQ_DEP_014), with them
// off it shows copies too — both must be overlap-free at every zoom level. TEST_SEED=<n> replays a run.
test('REQ_TEST_012 no overlap on the real team roadmap at every zoom level, arrows off and on', async ({ page, baseURL }, testInfo) => {
  const seed = testSeed()
  const rnd = seededRandom(seed)
  const pick = (n: number) => Math.floor(rnd() * n)
  testInfo.annotations.push({ type: 'seed', description: `TEST_SEED=${seed}` })
  const { team, roadmap, ws } = await createScene(baseURL!, 3)
  const made: { d: Awaited<ReturnType<typeof createDeliverable>>; s: number; e: number }[] = []
  for (let i = 0, n = 10 + pick(8); i < n; i++) {
    const s = pick(150)
    const e = s + 3 + pick(40)
    const inWs = ws.filter(() => rnd() < 0.4)
    if (inWs.length === 0) inWs.push(ws[pick(ws.length)])
    made.push({ d: await createDeliverable(baseURL!, roadmap, inWs.map((w) => w.id), isoDay(s), isoDay(e)), s, e })
  }
  for (const a of made)
    for (const b of made) if (a !== b && a.e < b.s && rnd() < 0.3) await createDependency(baseURL!, a.d, b.d)

  await page.goto(`/#/teams/${team.id}`)
  await expect(page.locator('.deliverable').first()).toBeVisible()
  for (const arrows of [false, true]) {
    if (arrows) {
      await page.locator('#sw-deps').click()
      await expect(page.locator('#sw-deps')).toHaveAttribute('aria-checked', 'true')
    }
    for (const z of zooms) {
      await page.click(`[data-z=${z}]`)
      await expect(page.locator(`[data-z=${z}]`)).toHaveClass(/\bon\b/)
      const where = `real page, arrows ${arrows ? 'on' : 'off'} @ ${z} (TEST_SEED=${seed})`
      const items = await page.evaluate(measureScript, '.deliverable, .ms')
      expect(items.length, `${where}: nothing measured`).toBeGreaterThan(0)
      expect(findOverlaps(items), where).toEqual([])
      if (arrows) expect(await page.locator('.deliverable.dup').count(), `${where}: copies should be hidden`).toBe(0)
    }
  }
})

// The company view (workstream rows merged across teams) and the trace (REQ_FE_102: no dependencies switch, arrows always
// on) on a seeded random company, at every zoom level.
test('REQ_TEST_012 no overlap on the company view and the trace at every zoom level, arrows off and on, on a seeded random company', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(240_000)
  const seed = testSeed()
  testInfo.annotations.push({ type: 'seed', description: `TEST_SEED=${seed}` })
  await createRandomCompany(baseURL!, seededRandom(seed))
  const c = await createCompany(baseURL!) // the chain gives the trace view something to show

  const open = async (hash: string) => {
    await page.goto(`/${hash}`)
    await expect(page.locator('[data-testid^=company-]').first()).toBeVisible()
    await expect(page.locator('.deliverable').first()).toBeVisible()
  }
  for (const [view, hash] of [
    ['company view', '#/company/workstreams'],
    ['trace', `#/company/trace/${c.B.id}`],
  ]) {
    await open(hash)
    for (const arrows of view === 'trace' ? [true] : [false, true]) {
      if (view !== 'trace') await setArrows(page, arrows)
      for (const z of zooms) {
        await page.click(`[data-z=${z}]`)
        await expect(page.locator(`[data-z=${z}]`)).toHaveClass(/\bon\b/)
        const where = `${view}, arrows ${arrows ? 'on' : 'off'} @ ${z} (TEST_SEED=${seed})`
        const items = await page.evaluate(measureScript, '.deliverable, .ms')
        expect(items.length, `${where}: nothing measured`).toBeGreaterThan(0)
        expect(findOverlaps(items), where).toEqual([])
        if (arrows) expect(await page.locator('.deliverable.dup').count(), `${where}: copies should be hidden`).toBe(0)
      }
    }
  }
})

async function setArrows(page: Page, on: boolean) {
  const sw = page.locator('#sw-deps')
  if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', String(on))
}
