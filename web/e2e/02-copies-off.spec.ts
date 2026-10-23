// CORE, runs second (REQ_TEST_012; the copies-off test itself proves REQ_FE_017, measured with REQ_TEST_013's visibility helpers). Ported from behavior.check.js 7h: turning copies off must
// genuinely un-render them (computed display none / empty box) and give their rows back — REQ_FE_017
// — not just set `hidden`.
//
// M3 (review finding): retargeted onto the real running app, not wireframes/*.html — the seam
// CONTRACT.md flagged for later, now that Toolbar.tsx's real `#sw-copies` switch exists. Data comes
// from the real API via builders.ts (REQ_TEST_016/017): a fresh team/roadmap/two workstreams and one
// deliverable spanning both, which is exactly what makes the packer render a primary block plus a
// `.dup` copy (REQ_FE_051).
import { expect, test } from '@playwright/test'
import { createDeliverable, isoDay, teamRoadmap, createTeam, createWorkstream } from './builders'
import { findOverlaps, measureScript, visibleBoxes } from './visibility'

// rowsScript sums each workstream band's data-rows — the packed row count a workstream currently
// needs. REQ_FE_017's "hidden copies give their rows back" means this total must not grow when
// copies are hidden (and must return to exactly its original value when they're shown again).
const rowsScript = () =>
  [...document.querySelectorAll<HTMLElement>('.band[data-rows]')].reduce((sum, b) => sum + Number(b.dataset.rows || 0), 0)

test('REQ_FE_017 copies off are not rendered on the real team roadmap page', async ({ page, baseURL }) => {
  const team = await createTeam(baseURL!)
  const roadmap = await teamRoadmap(baseURL!, team)
  const wsA = await createWorkstream(baseURL!, roadmap, { name: 'Alpha' })
  const wsB = await createWorkstream(baseURL!, roadmap, { name: 'Beta' })
  await createDeliverable(baseURL!, roadmap, [wsA.id, wsB.id], isoDay(5), isoDay(35), { name: 'Shared work' })

  await page.goto(`/#/teams/${team.id}`)
  await expect(page.locator('.deliverable.dup')).toHaveCount(1)

  const copies = () => page.evaluate(measureScript, '.deliverable.dup')
  const on = await copies()
  expect(visibleBoxes(on).length).toBe(on.length)

  const rowsBefore = await page.evaluate(rowsScript)

  const swCopies = page.locator('#sw-copies')
  await swCopies.click()
  // web-first: wait for the switch's own aria-checked state instead of a blind fixed sleep — the
  // click handler flips it synchronously in the same pass that hides the copies and repacks rows.
  await expect(swCopies).toHaveAttribute('aria-checked', 'false')
  expect(visibleBoxes(await copies())).toEqual([])
  // REQ_FE_017: hiding copies must not leave the row(s) they occupied still reserved.
  const rowsHidden = await page.evaluate(rowsScript)
  expect(rowsHidden, 'rows should not grow when copies are hidden').toBeLessThanOrEqual(rowsBefore)

  await swCopies.click()
  await expect(swCopies).toHaveAttribute('aria-checked', 'true')
  const back = await page.evaluate(measureScript, '.deliverable, .ms')
  expect(visibleBoxes(await copies()).length).toBe(on.length)
  expect(findOverlaps(back)).toEqual([])
  // showing them again must reclaim exactly the rows they had before
  const rowsBack = await page.evaluate(rowsScript)
  expect(rowsBack, 'rows should return to their original total once copies are shown again').toBe(rowsBefore)
})
