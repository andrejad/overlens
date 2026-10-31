// Phase 7 company view in a real browser against the real server (REQ_FE_052-054, REQ_FE_091-097,
// REQ_DEP_021/022, REQ_TEST_012/021, REQ_API_036/037, REQ_AUD_022/023). Every scene is built through the API
// (builders.ts: random names, unique 2-4 letter tags, relative dates, no hardcoded ids). The test server runs without
// the shipped sample company (start-server.sh: OVERLENS_SAMPLE_DATA=false, REQ_TEST_020), but the company views still show
// every team that the OTHER specs created in the shared scratch database, so assertions are scoped to this test's own
// teams/rows or derived from GET /api/company/roadmaps, never from a fixed count.
//
// Runs in the `company-ui` project (logged in as e2e-admin).
// Anonymous checks use fresh contexts without storageState.
import { expect, test, type Browser, type Page } from '@playwright/test'
import {
  apiFetch,
  createCompany,
  createDeliverable,
  createMilestone,
  createWorkstream,
  isoDay,
  type Company,
  type DeliverableHandle,
  ANON_STATE,
} from './builders'
import { measureScript } from './visibility'

test.use({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' })

const json = { 'Content-Type': 'application/json' }
const zooms = ['year', 'half', 'quarter', 'month']
const rand = () => Math.random().toString(36).slice(2, 8)
const ANON = ANON_STATE

const bar = (page: Page, d: DeliverableHandle) => page.locator(`.deliverable:not(.dup)[data-deliverable="${d.id}"]`).first()
const anyBar = (page: Page, d: DeliverableHandle) => page.locator(`.deliverable[data-deliverable="${d.id}"]`)

interface ApiDeliverable { id: number; status: string; start_date: string; end_date: string }
interface ApiCompanyTeam { team: { id: number; name: string; tag: string }; roadmap: { deliverables: ApiDeliverable[]; milestones: { date: string; status?: string }[] } }

async function companyApi(baseURL: string): Promise<ApiCompanyTeam[]> {
  const res = await fetch(`${baseURL}/api/company/roadmaps`)
  expect(res.status).toBe(200)
  return (await res.json()).items
}
const activeDeliverables = (items: ApiCompanyTeam[]) => items.flatMap((i) => i.roadmap.deliverables)
// REQ_FE_043: the status pills count roadmap items, deliverables and milestones together
const activeStatuses = (items: ApiCompanyTeam[]) => [...activeDeliverables(items).map((d) => d.status), ...items.flatMap((i) => i.roadmap.milestones.map((m) => m.status ?? 'planned'))]
// REQ_DEP_028: the trace's "unrelated items hidden" counts deliverables AND milestones of the loaded roadmaps
const activeItems = (items: ApiCompanyTeam[]) => activeDeliverables(items).length + items.reduce((n, i) => n + i.roadmap.milestones.length, 0)
const wsOrderApi = async (baseURL: string): Promise<string[]> => (await (await fetch(`${baseURL}/api/company/workstream-order`)).json()).items
const teamOrderApi = async (baseURL: string): Promise<{ id: number; name: string; tag: string }[]> => (await (await fetch(`${baseURL}/api/company/team-order`)).json()).items

// Opens a company address and waits until the view has drawn blocks.
async function openCompany(page: Page, hash = '#/company/workstreams') {
  await page.goto(`/${hash}`)
  await expect(page.locator('[data-testid^=company-]').first()).toBeVisible()
  await expect(page.locator('.deliverable').first()).toBeVisible()
}

async function selectBar(page: Page, d: DeliverableHandle) {
  await bar(page, d).click()
  await expect(page.getByTestId('side-panel')).toContainText(d.name)
}

async function setZoom(page: Page, zoom: string) {
  await page.click(`[data-z=${zoom}]`)
  await expect(page.locator(`[data-z=${zoom}]`)).toHaveClass(/\bon\b/)
}

async function setArrows(page: Page, on: boolean) {
  const sw = page.locator('#sw-deps')
  if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', String(on))
}

async function anonymousPage(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL, storageState: ANON, viewport: { width: 1600, height: 1000 } })
  return { ctx, page: await ctx.newPage() }
}

// ---------------------------------------------------------------------------------------------------------------------

test.describe('REQ_FE_091 addresses', () => {
  test('REQ_FE_091 #/company leads to #/company/workstreams; the company view and the trace open on their addresses and a reload keeps the page', async ({ page, baseURL }) => {
    const c = await createCompany(baseURL!)
    await page.goto('/#/company')
    await expect(page).toHaveURL(/#\/company\/workstreams$/)
    await expect(page.getByTestId('company-workstreams')).toBeVisible()
    const routes: [string, string][] = [
      ['#/company/workstreams', 'company-workstreams'],
      [`#/company/trace/${c.B.id}`, 'company-trace'],
    ]
    for (const [hash, root] of routes) {
      await page.goto(`/${hash}`)
      await expect(page.getByTestId(root)).toBeVisible()
      await page.reload()
      await expect(page).toHaveURL(new RegExp(`${hash.replace(/[/#]/g, (m) => `\\${m}`)}$`))
      await expect(page.getByTestId(root)).toBeVisible()
      await expect(page.locator('.deliverable').first()).toBeVisible()
    }
  })
})

// ---- REQ_FE_054 ----------------------------------------------------------------------------------------------------

// Every block carries data-tag and "<TAG> · " in its title; a bar wide enough for its tag shows the `.team-tag` as its first
// child (REQ_FE_054's rule: tagWidth = ceil(7.5 x chars) + 8, plus the bar's border); the ONE exception is a bar narrower
// than that, which has no `.team-tag` element but still carries data-tag and the team in its title.
async function expectTags(page: Page, where: string) {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.deliverable')].map((e) => ({
      id: e.dataset.deliverable,
      tag: e.dataset.tag ?? '',
      title: e.title,
      width: e.getBoundingClientRect().width,
      shown: e.querySelector(':scope > .team-tag')?.textContent ?? null,
      first: e.firstElementChild?.classList.contains('team-tag') ?? false,
    })),
  )
  expect(rows.length, `${where}: no blocks`).toBeGreaterThan(0)
  for (const r of rows) {
    const label = `${where}: block ${r.id}`
    expect(r.tag, `${label} data-tag`).toMatch(/^[A-Z]{2,4}$/)
    expect(r.title.startsWith(`${r.tag} · `), `${label} title "${r.title}"`).toBe(true)
    const need = Math.ceil(7.5 * r.tag.length) + 8
    if (r.width >= need + 3) {
      expect(r.shown, `${label} is ${r.width}px wide, enough for "${r.tag}"`).toBe(r.tag)
      expect(r.first, `${label} tag is the left-most child`).toBe(true)
    }
    if (r.shown === null) expect(r.width, `${label} hides its tag although ${r.width}px is wide enough`).toBeLessThan(need + 3)
  }
}

test.describe('REQ_FE_054 team tags', () => {
  const views = (c: Company): [string, string][] => [
    ['company view', '#/company/workstreams'],
    ['trace', `#/company/trace/${c.B.id}`],
  ]

  test('REQ_FE_054 every block on the company view and the trace carries its team tag; wide-enough bars show it at every zoom', async ({ page, baseURL }) => {
    const c = await createCompany(baseURL!)
    const tagOf = new Map<number, string>([[c.A.id, c.teamA.tag], [c.B.id, c.teamB.tag], [c.C.id, c.teamC.tag], [c.U.id, c.teamA.tag]])
    for (const [name, hash] of views(c)) {
      await openCompany(page, hash)
      for (const z of zooms) {
        await setZoom(page, z)
        await expectTags(page, `${name} @ ${z}`)
        // this scene's chain bars are 26-31 days long: at every zoom they are wide enough, so the tag text must be there
        for (const d of [c.A, c.B, c.C]) {
          const b = bar(page, d)
          await expect(b, `${name} @ ${z}: ${d.name}`).toHaveAttribute('data-tag', tagOf.get(d.id)!)
          if ((await b.boundingBox())!.width >= 60) await expect(b.locator('> .team-tag')).toHaveText(tagOf.get(d.id)!)
        }
      }
    }
  })

  test('REQ_FE_054 the tag is also on copies and on the narrowest bars (data-tag and the title keep the team when the element does not fit)', async ({ page, baseURL }) => {
    const c = await createCompany(baseURL!)
    // a 1-day deliverable: far narrower than any tag at the year zoom
    const ws = await createWorkstream(baseURL!, c.roadmapA)
    const tiny = await createDeliverable(baseURL!, c.roadmapA, [ws.id], isoDay(2), isoDay(2), { name: `Tiny ${c.suffix}` })
    await openCompany(page, '#/company/workstreams')
    await setZoom(page, 'year')
    const t = anyBar(page, tiny).first()
    await expect(t).toHaveAttribute('data-tag', c.teamA.tag)
    await expect(t).toHaveAttribute('title', new RegExp(`^${c.teamA.tag} · ${tiny.name}`))
    expect((await t.boundingBox())!.width).toBeLessThan(Math.ceil(7.5 * c.teamA.tag.length) + 8)
    await expect(t.locator('.team-tag')).toHaveCount(0) // the one documented exception
    // A's copy (it sits in two workstreams) carries the tag too
    const copy = page.locator(`.deliverable.dup[data-deliverable="${c.A.id}"]`)
    await expect(copy.first()).toHaveAttribute('data-tag', c.teamA.tag)
    await expectTags(page, 'by workstream incl. copies and tiny bar')
  })
})

// ---- REQ_FE_053 ----------------------------------------------------------------------------------------------------

test.describe('REQ_FE_043 REQ_FE_042 status pills', () => {
  test('REQ_FE_043 REQ_FE_042 the header pills "N at risk" / "N in progress" count every team on the company view and the trace; the legend is shown', async ({ page, baseURL }) => {
    const c = await createCompany(baseURL!)
    const patch = async (d: DeliverableHandle, body: object) => expect((await apiFetch(baseURL!, `/api/deliverables/${d.id}`, { method: 'PATCH', headers: json, body: JSON.stringify(body) })).status).toBe(200)
    await patch(c.A, { status: 'in_progress' })
    await patch(c.B, { status: 'at_risk', risk_note: 'e2e risk' })
    await patch(c.C, { status: 'in_progress' })
    // milestones count too: one at risk and one in progress, in team A's roadmap
    const wsA = (await (await fetch(`${baseURL}/api/roadmaps/${c.roadmapA.id}`)).json()).workstreams[0].id as number
    for (const [status, body] of [['at_risk', { risk_note: 'e2e ms risk' }], ['in_progress', {}]] as const) {
      const m = await createMilestone(baseURL!, c.roadmapA, wsA, isoDay(status === 'at_risk' ? 3 : 4))
      expect((await apiFetch(baseURL!, `/api/milestones/${m.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ status, ...body }) })).status).toBe(200)
    }
    const all = activeStatuses(await companyApi(baseURL!))
    const risk = all.filter((s) => s === 'at_risk').length
    const progress = all.filter((s) => s === 'in_progress').length
    expect(risk).toBeGreaterThan(activeDeliverables(await companyApi(baseURL!)).filter((d) => d.status === 'at_risk').length) // the milestone is in the count
    expect(risk).toBeGreaterThanOrEqual(1)
    expect(progress).toBeGreaterThanOrEqual(3)
    for (const hash of ['#/company/workstreams', `#/company/trace/${c.A.id}`]) {
      await openCompany(page, hash)
      await expect(page.locator('[data-status-pill=risk] .n')).toHaveText(String(risk))
      await expect(page.locator('[data-status-pill=progress] .n')).toHaveText(String(progress))
      await expect(page.getByTestId('status-legend')).toBeVisible()
    }
  })
})

// ---- REQ_FE_017 / 051 ----------------------------------------------------------------------------------------------

test('REQ_FE_017 REQ_FE_051 the copies toggle on the company view is named after its action and really removes the copies', async ({ page, baseURL }) => {
  const c = await createCompany(baseURL!)
  await openCompany(page, '#/company/workstreams')
  const sw = page.locator('#sw-copies')
  await expect(sw).toContainText('Hide multi-workstream')
  await expect(page.locator(`.deliverable.dup[data-deliverable="${c.A.id}"]`)).toHaveCount(1)
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(sw).toContainText('Show multi-workstream')
  await expect(page.locator('.deliverable.dup')).toHaveCount(0) // gone from the DOM, not just hidden
  expect(await page.evaluate(measureScript, '.deliverable.dup')).toEqual([])
  await sw.click()
  await expect(sw).toContainText('Hide multi-workstream')
  await expect(page.locator(`.deliverable.dup[data-deliverable="${c.A.id}"]`)).toHaveCount(1)
})

// ---- REQ_FE_094 / 102 / 116 / 117 the Company order page ------------------------------------------------------------

test.describe('REQ_FE_094 REQ_FE_116 ordering on the Company order page', () => {
  async function auditFor(baseURL: string, action: string) {
    const res = await apiFetch(baseURL, `/api/admin/audit?action=${action}&limit=1`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const entry = body.items[0]
    const details = entry && (typeof entry.details === 'string' ? JSON.parse(entry.details) : entry.details)
    return { total: body.total as number, entry, details }
  }
  const swap = <T,>(a: T[], i: number, j: number) => {
    const out = a.slice()
    ;[out[i], out[j]] = [out[j], out[i]]
    return out
  }
  type Card = 'team-order-card' | 'workstream-order-card'
  const rows = (page: Page, card: Card) => page.getByTestId(card).getByTestId('ws-row')
  const cardNames = (page: Page, card: Card) => rows(page, card).locator('.nm').allTextContents()
  const grip = (page: Page, card: Card, name: string) => page.getByTestId(card).getByRole('button', { name: `Reorder ${name}`, exact: true })
  const putUrl = (card: Card) => (card === 'team-order-card' ? '/api/company/team-order' : '/api/company/workstream-order')
  const waitPut = (page: Page, card: Card) => page.waitForResponse((r) => r.url().endsWith(putUrl(card)) && r.request().method() === 'PUT')
  async function openOrder(page: Page) {
    await page.goto('/#/company/order')
    await expect(page.getByRole('heading', { name: 'Company order' })).toBeVisible()
    await expect(rows(page, 'team-order-card').first()).toBeVisible()
  }
  // The names of the workstream rows on the company view, top to bottom.
  const viewRows = (page: Page) => page.locator('.ws-label .name').allTextContents()
  // Moves a row by one place with the keyboard (REQ_FE_107), waiting for its save.
  async function keyMove(page: Page, card: Card, name: string, key: 'ArrowUp' | 'ArrowDown') {
    await grip(page, card, name).focus()
    const saved = waitPut(page, card)
    await page.keyboard.press(key)
    expect((await saved).status()).toBe(200)
  }
  // Moves a row by one place with the real mouse (REQ_FE_106): up above the previous row's middle, or down past the next.
  async function mouseMove(page: Page, card: Card, name: string, dir: 'up' | 'down') {
    const g = grip(page, card, name)
    await g.scrollIntoViewIfNeeded()
    const names = await cardNames(page, card)
    const i = names.indexOf(name)
    const other = rows(page, card).nth(dir === 'up' ? i - 1 : i + 1)
    await other.scrollIntoViewIfNeeded()
    const from = (await g.boundingBox())!
    const to = (await other.boundingBox())!
    const x = from.x + from.width / 2
    const y = dir === 'up' ? to.y + 2 : to.y + to.height - 2
    const saved = waitPut(page, card)
    await page.mouse.move(x, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, from.y + from.height / 2 + (dir === 'up' ? -12 : 12), { steps: 4 })
    await page.mouse.move(x, y, { steps: 6 })
    await expect(page.getByText('dragging…')).toBeVisible()
    await page.mouse.up()
    expect((await saved).status()).toBe(200)
  }

  // The (lower-cased) workstream names the roadmaps hold right now.
  // The workstream names the company view draws: those a roadmap item is in (REQ_FE_127; a copy counts).
  async function viewNamesFor(_page: Page, baseURL: string): Promise<string[]> {
    const res = await fetch(`${baseURL}/api/company/roadmaps`)
    type R = { workstreams: { id: number; name: string }[]; deliverables: { workstream_ids: number[] }[]; milestones: { workstream_id: number }[] }
    const items = (await res.json()).items as { roadmap: R }[]
    return items.flatMap(({ roadmap: r }) => {
      const used = new Set([...r.deliverables.flatMap((d) => d.workstream_ids), ...r.milestones.map((m) => m.workstream_id)])
      return r.workstreams.filter((w) => used.has(w.id)).map((w) => w.name.toLowerCase())
    })
  }

  test('REQ_FE_094 REQ_FE_106 REQ_FE_116 REQ_API_036 REQ_API_037 REQ_AUD_022 REQ_AUD_023 a team and a workstream name dragged with the real mouse keep their new places after a reload on the order page and the company view; an admin moves a workstream name or a team with the keyboard, the order survives a reload, shows on the views, is saved for everyone and audited once', async ({ page, baseURL, browser }) => {
    await test.step('a team and a workstream name dragged with the real mouse keep their new places after a reload, on the order page and on the company view', async () => {
      const c = await createCompany(baseURL!)
      await openOrder(page)
      const teams = await cardNames(page, 'team-order-card')
      const ti = teams.indexOf(c.teamC.name)
      const tDir = ti > 0 ? 'up' : 'down'
      const expectedTeams = swap(teams, ti, tDir === 'up' ? ti - 1 : ti + 1)
      await mouseMove(page, 'team-order-card', c.teamC.name, tDir)
      await expect.poll(() => cardNames(page, 'team-order-card')).toEqual(expectedTeams)

      const names = await cardNames(page, 'workstream-order-card')
      const wi = names.indexOf(c.soloC)
      const wDir = wi > 0 ? 'up' : 'down'
      const expectedNames = swap(names, wi, wDir === 'up' ? wi - 1 : wi + 1)
      await mouseMove(page, 'workstream-order-card', c.soloC, wDir)
      await expect.poll(() => cardNames(page, 'workstream-order-card')).toEqual(expectedNames)

      await page.reload()
      await expect(rows(page, 'team-order-card').first()).toBeVisible()
      expect(await cardNames(page, 'team-order-card')).toEqual(expectedTeams)
      expect(await cardNames(page, 'workstream-order-card')).toEqual(expectedNames)

      expect((await teamOrderApi(baseURL!)).map((t) => t.name)).toEqual(expectedTeams)
      const held = new Set(await viewNamesFor(page, baseURL!))
      await openCompany(page, '#/company/workstreams')
      expect(await viewRows(page)).toEqual(expectedNames.filter((n) => held.has(n.toLowerCase())))
    })

    await test.step('an admin moves a workstream name with the keyboard; the order survives a reload, shows on the company view, is saved for everyone and audited once', async () => {
      const c = await createCompany(baseURL!)
      await openOrder(page)
      const before = await cardNames(page, 'workstream-order-card')
      const i = before.indexOf(c.soloC)
      expect(i).toBeGreaterThanOrEqual(0)
      const dir = i > 0 ? 'ArrowUp' : 'ArrowDown'
      const expected = swap(before, i, dir === 'ArrowUp' ? i - 1 : i + 1)
      const auditBefore = await auditFor(baseURL!, 'company.workstream_order')

      await keyMove(page, 'workstream-order-card', c.soloC, dir)
      await expect.poll(() => cardNames(page, 'workstream-order-card')).toEqual(expected)
      expect(await wsOrderApi(baseURL!)).toEqual(expected)
      await expect(grip(page, 'workstream-order-card', c.soloC)).toBeFocused() // focus stays on the moved grip

      await page.reload()
      await expect(rows(page, 'workstream-order-card').first()).toBeVisible()
      expect(await cardNames(page, 'workstream-order-card')).toEqual(expected)

      const after = await auditFor(baseURL!, 'company.workstream_order')
      expect(after.total, 'exactly one company.workstream_order entry for one change').toBe(auditBefore.total + 1)
      expect(after.details.from).toEqual(before)
      expect(after.details.to).toEqual(expected)

      // the company view only shows it: its rows follow the saved order (names no roadmap holds are not drawn)
      const held = new Set(await viewNamesFor(page, baseURL!))
      await openCompany(page, '#/company/workstreams')
      expect(await viewRows(page)).toEqual(expected.filter((n) => held.has(n.toLowerCase())))

      const { ctx, page: anon } = await anonymousPage(browser, baseURL!)
      await anon.goto('/#/company/workstreams')
      await expect(anon.locator('.ws-label .name').first()).toBeVisible()
      expect(await viewRows(anon)).toEqual(expected.filter((n) => held.has(n.toLowerCase())))
      await ctx.close()
    })

    await test.step('an admin moves a team with the keyboard; the order survives a reload, is saved for everyone and audited once', async () => {
      const c = await createCompany(baseURL!)
      await openOrder(page)
      const before = await cardNames(page, 'team-order-card')
      const i = before.indexOf(c.teamB.name)
      expect(i).toBeGreaterThanOrEqual(0)
      const dir = i > 0 ? 'ArrowUp' : 'ArrowDown'
      const expected = swap(before, i, dir === 'ArrowUp' ? i - 1 : i + 1)
      const auditBefore = await auditFor(baseURL!, 'company.team_order')

      await keyMove(page, 'team-order-card', c.teamB.name, dir)
      await expect.poll(() => cardNames(page, 'team-order-card')).toEqual(expected)
      const server = await teamOrderApi(baseURL!)
      expect(server.map((t) => t.name)).toEqual(expected)

      await page.reload()
      await expect(rows(page, 'team-order-card').first()).toBeVisible()
      expect(await cardNames(page, 'team-order-card')).toEqual(expected)

      const after = await auditFor(baseURL!, 'company.team_order')
      expect(after.total, 'exactly one company.team_order entry for one change').toBe(auditBefore.total + 1)
      expect(after.details.from).toEqual(before)
      expect(after.details.to).toEqual(expected)
    })
  })
})

// ---- REQ_FE_096 / 097 ----------------------------------------------------------------------------------------------

test('REQ_FE_096 REQ_FE_097 an admin edit made through the side panel on a company view shows in place without a reload, and the counts follow it', async ({ page, baseURL }) => {
  const c = await createCompany(baseURL!)
  await openCompany(page, '#/company/workstreams')
  await selectBar(page, c.A)

  const pill = page.locator('[data-status-pill=progress] .n')
  const progressBefore = Number(await pill.textContent())
  const marker = await page.evaluate(() => ((window as unknown as { __e2e: string }).__e2e = 'same page')) // survives only without a reload

  await page.locator('aside').getByRole('button', { name: 'Edit', exact: true }).click()
  const renamed = `Renamed ${rand()}`
  const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/deliverables/${c.A.id}`))
  await page.locator('#d-name').fill(renamed)
  await page.locator('#d-name').press('Tab')
  expect((await patched).status()).toBe(200)
  await expect(bar(page, c.A)).toHaveAttribute('title', new RegExp(`· ${renamed} ·`))

  const patched2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/deliverables/${c.A.id}`))
  await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'In progress' }).click()
  expect((await patched2).status()).toBe(200)
  await expect(pill).toHaveText(String(progressBefore + 1))
  await expect(bar(page, c.A)).toHaveAttribute('data-status', 'in_progress')

  expect(await page.evaluate(() => (window as unknown as { __e2e: string }).__e2e)).toBe(marker) // never reloaded
  const server = await (await fetch(`${baseURL}/api/deliverables/${c.A.id}`)).json()
  expect(server.name).toBe(renamed)
  expect(server.status).toBe('in_progress')
})

// ---- REQ_DEP_021 / 022, REQ_TEST_021 -------------------------------------------------------------------------------

test.describe('REQ_DEP_021 REQ_DEP_022 trace', () => {
  async function hiddenCount(baseURL: string) {
    // loaded roadmap items not in the chain (P, A, B, C)
    return activeItems(await companyApi(baseURL)) - 4
  }

  test('REQ_DEP_021 REQ_DEP_022 REQ_TEST_021 "Trace dependencies" from a selected deliverable opens #/company/trace/deliverable/<id> with the banner, the stats line and ONLY the chain in the DOM, on the merged rows; a reload keeps the trace and "Show all roadmap items" brings everything back', async ({ page, baseURL }) => {
    const c = await createCompany(baseURL!)
    await openCompany(page)
    await expect(page.getByTestId('trace-btn')).toHaveCount(0) // shown once something is selected
    await selectBar(page, c.B)
    await expect(page.getByTestId('trace-btn')).toHaveText('Trace dependencies')
    await page.getByTestId('trace-btn').click()

    await expect(page).toHaveURL(new RegExp(`#/company/trace/deliverable/${c.B.id}$`))
    await expect(page.getByTestId('company-trace')).toBeVisible()
    await expect(page.getByTestId('trace-title')).toHaveText(`Tracing dependencies for: ${c.B.name}`)
    // B depends on A and (through A) on P; C depends on B
    const hidden = await hiddenCount(baseURL!)
    await expect(page.getByTestId('trace-stats')).toHaveText(`2 prerequisites · 1 dependents · ${hidden} unrelated items hidden`)

    await expect(anyBar(page, c.A).first()).toBeVisible()
    const ids = await page.locator('.deliverable').evaluateAll((els) => [...new Set(els.map((e) => Number((e as HTMLElement).dataset.deliverable)))].sort((a, b) => a - b))
    expect(ids).toEqual([c.P.id, c.A.id, c.B.id, c.C.id].sort((a, b) => a - b))
    await expect(page.locator(`[data-deliverable="${c.U.id}"]`)).toHaveCount(0) // absent from the DOM, not just hidden
    await expect(page.locator('.ms')).toHaveCount(0)
    // one merged timeline; only the rows holding a chain item's main block stay (A's row, merged with B's same-named one;
    // C's row; P's row). A's second workstream holds only its copy, which a trace never draws, so it collapses (REQ_DEP_021),
    // like U's other rows and every other team's
    await expect(page.locator('.tl')).toHaveCount(1)
    const shownRows = (await page.locator('.ws-label .name').allTextContents()).map((n) => n.toLowerCase()).sort()
    expect(shownRows).toEqual([c.mergeName, c.soloC, c.legacyD].map((n) => n.toLowerCase()).sort())

    // every end of the chain is on screen: the chain's edges are arrows, never chevron badges
    for (const [from, to] of [[c.P, c.A], [c.A, c.B], [c.B, c.C]]) {
      await expect(page.locator(`g.dep[data-dep-from="${from.id}"][data-dep-to="${to.id}"]`)).toHaveCount(1)
      await expect(page.locator(`.dep-badge[data-dep-from="${from.id}"][data-dep-to="${to.id}"]`)).toHaveCount(0)
    }

    // a reload on the trace address keeps the trace
    await page.reload()
    await expect(page.getByTestId('trace-title')).toHaveText(`Tracing dependencies for: ${c.B.name}`)
    await expect(anyBar(page, c.A).first()).toBeVisible()
    await expect(page.locator(`[data-deliverable="${c.U.id}"]`)).toHaveCount(0)

    // "Show all roadmap items" returns to the company view, with everything back
    await expect(page.getByTestId('trace-show-all')).toHaveText('Show all roadmap items')
    await page.getByTestId('trace-show-all').click()
    await expect(page).toHaveURL(/#\/company\/workstreams$/)
    await expect(page.getByTestId('company-workstreams')).toBeVisible()
    await expect(anyBar(page, c.U).first()).toBeVisible()
    await expect(page.getByTestId('trace-banner')).toHaveCount(0)
  })

  test('REQ_DEP_009 on the company view (one merged timeline) a dependency between two teams\' deliverables is drawn as an arrow', async ({ page, baseURL }) => {
    const c = await createCompany(baseURL!)
    await openCompany(page, '#/company/workstreams')
    await setArrows(page, true)
    await expect(page.locator(`g.dep[data-dep-from="${c.A.id}"][data-dep-to="${c.B.id}"]`)).toHaveCount(1)
    await expect(page.locator(`g.dep[data-dep-from="${c.B.id}"][data-dep-to="${c.C.id}"]`)).toHaveCount(1)
    await expect(page.locator(`g.dep[data-dep-from="${c.P.id}"][data-dep-to="${c.A.id}"]`)).toHaveCount(1)
  })
})
