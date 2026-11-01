// REQ_FE_140 and REQ_FE_141 on the REAL running app, where the browser does the layout: a name that doesn't fit on one
// row goes small on at most two rows inside its bar and is cut there, or under a narrow bar; the bar keeps its size. Data
// comes from the real API via builders.ts.
import { expect, test } from '@playwright/test'
import { apiFetch, createDeliverable, createMilestone, createScene, isoDay } from './builders'

test('REQ_FE_140 a long name on a narrow bar shows small on two rows inside the bar and is cut there; on a wide bar it stays on one row', async ({ page, baseURL }) => {
  const url = baseURL!
  const { team, roadmap, ws } = await createScene(url)
  const name = 'Disaster Recovery Drills Across Every Region'
  const narrow = await createDeliverable(url, roadmap, [ws[0].id], isoDay(2), isoDay(61), { name })
  const wide = await createDeliverable(url, roadmap, [ws[0].id], isoDay(70), isoDay(250), { name })

  await page.goto(`/#/teams/${team.id}`) // Year is the default zoom
  const bar = page.locator(`.deliverable[data-deliverable="${narrow.id}"]`)
  await expect(bar).toBeVisible()
  const inBar = await bar.evaluate((b) => {
    const n = b.querySelector<HTMLElement>('.name')!
    const [br, nr] = [b.getBoundingClientRect(), n.getBoundingClientRect()]
    return {
      cls: n.className,
      text: n.textContent,
      font: getComputedStyle(n).fontSize,
      height: nr.height,
      inside: nr.top >= br.top && nr.bottom <= br.bottom && nr.right <= br.right,
      cut: n.scrollHeight > n.clientHeight,
      barHeight: br.height,
    }
  })
  expect(inBar).toMatchObject({ cls: 'name two', text: name, font: '10.5px', height: 24, inside: true, cut: true, barHeight: 32 })

  const one = page.locator(`.deliverable[data-deliverable="${wide.id}"] .name`)
  await expect(one).toHaveClass('name')
  expect(await one.evaluate((n) => getComputedStyle(n).fontSize)).toBe('12.5px')
  await expect(bar).toHaveAttribute('title', new RegExp(name))
})

test('REQ_FE_140 a name of wide capitals never stays cut on one row, and a name of narrow letters that fits stays at the normal size, whatever the bar width', async ({ page, baseURL }) => {
  const url = baseURL!
  const { team, roadmap, ws } = await createScene(url)
  let start = 2
  for (const name of ['WWWWWWWWWWWWWWWW', 'illinois lift illinois lift']) {
    for (const days of [30, 40, 50, 60, 70, 80, 90]) { // bar widths around where each name stops fitting
      await createDeliverable(url, roadmap, [ws[0].id], isoDay(start), isoDay(start + days - 1), { name })
      start += days + 1
    }
  }

  await page.goto(`/#/teams/${team.id}`)
  await expect(page.locator('.deliverable')).toHaveCount(14)
  const names = await page.locator('.deliverable .name').evaluateAll((els) => els.map((n) => {
    const probe = n.cloneNode(true) as HTMLElement // the name's width on one row at the normal size
    probe.className = 'name'
    probe.style.cssText = 'position:absolute;visibility:hidden;width:auto;overflow:visible'
    n.parentElement!.append(probe)
    const single = probe.getBoundingClientRect().width
    probe.remove()
    return { two: n.classList.contains('two'), under: n.classList.contains('under'), room: n.parentElement!.clientWidth, single, cut: n.scrollWidth > n.clientWidth + 1 }
  }))
  for (const n of names) if (!n.two && !n.under) expect(n.cut).toBe(false)
  for (const n of names) if (n.two) expect(n.single).toBeGreaterThan(n.room - 22) // it really didn't fit
  expect(names.some((n) => n.two)).toBe(true)
  expect(names.some((n) => !n.two && !n.under)).toBe(true)
})

test('REQ_FE_141 REQ_FE_010 names under narrow bars sit in the gap and touch nothing, on the team roadmap and the company view, at Year zoom', async ({ page, baseURL }) => {
  const url = baseURL!
  const { team, roadmap, ws } = await createScene(url)
  const w = ws[0].id
  const row = (n: number) => ({ rows: { [w]: n } })
  // row 0: a free name, one cut by the next, and one with a milestone after it
  const free = await createDeliverable(url, roadmap, [w], isoDay(2), isoDay(15), { name: 'Disaster Recovery Drills And More', ...row(0) })
  const cut = await createDeliverable(url, roadmap, [w], isoDay(90), isoDay(103), { name: 'Regional Failover Rehearsal', ...row(0) })
  await createDeliverable(url, roadmap, [w], isoDay(116), isoDay(129), { name: 'Annual Compliance Review', ...row(0) }) // about 25 days on: room at any window width
  await createDeliverable(url, roadmap, [w], isoDay(180), isoDay(193), { name: 'Password Reset Flow', ...row(0) })
  await createMilestone(url, roadmap, w, isoDay(205), { name: 'Beta launch' })
  // alone in the row, with free gap on both sides: its name has no reason not to be exactly centred
  const lone = await createDeliverable(url, roadmap, [w], isoDay(330), isoDay(343), { name: 'Login Audit', ...row(0) })
  // row 1: a bar right under `free`, whose badge stays clear of that name
  await createDeliverable(url, roadmap, [w], isoDay(2), isoDay(60), { name: 'Under the first', ...row(1) })
  // a very short bar right before another, with a bar under it: its name must not land on the next bar's name
  await createDeliverable(url, roadmap, [w], isoDay(240), isoDay(244), { name: 'Hotfix Window Rehearsal', ...row(0) })
  await createDeliverable(url, roadmap, [w], isoDay(245), isoDay(258), { name: 'Release Freeze Rehearsal', ...row(0) })
  await createDeliverable(url, roadmap, [w], isoDay(240), isoDay(300), { name: 'Under the pair', ...row(1) })

  const check = async () => {
    await expect(page.locator(`.deliverable[data-deliverable="${free.id}"] .name.under`)).toBeVisible()
    const r = await page.evaluate(() => {
      const hit = (a: DOMRect, c: DOMRect) => a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5
      const hits: string[] = []
      const unders = [...document.querySelectorAll<HTMLElement>('.name.under')]
      const others = [...document.querySelectorAll<HTMLElement>('.st, .ms .lbl, .ms .mk, .name.under, .deliverable')]
      for (const u of unders) for (const o of others) {
        if (o !== u && o !== u.parentElement && hit(u.getBoundingClientRect(), o.getBoundingClientRect())) hits.push(`${u.textContent} x ${o.className}`)
      }
      const bars = unders.map((u) => u.parentElement!.getBoundingClientRect().height)
      return { n: unders.length, hits, bars, offsets: unders.map((u) => { const [n, b] = [u.getBoundingClientRect(), u.parentElement!.getBoundingClientRect()]; const c = b.left + b.width / 2; return { name: u.textContent, off: n.left + n.width / 2 - c, spans: n.left <= c && n.right >= c } }) }
    })
    expect(r.hits).toEqual([])
    expect(r.n).toBeGreaterThanOrEqual(3)
    expect(new Set(r.bars)).toEqual(new Set([32]))
    for (const o of r.offsets) expect(o.spans, JSON.stringify(o)).toBe(true) // a neighbour may slide it, never off its own bar
    expect(Math.abs(r.offsets.find((o) => o.name === 'Login Audit')!.off)).toBeLessThanOrEqual(1)
  }

  await page.goto(`/#/teams/${team.id}`)
  await check()
  await expect(page.locator(`.deliverable[data-deliverable="${cut.id}"] .name`)).toHaveClass('name under')
  await expect(page.locator(`.deliverable[data-deliverable="${lone.id}"] .name`)).toHaveClass('name under')
  await page.goto('/#/company/workstreams')
  await check()
})

test('REQ_FE_141 REQ_FE_142 REQ_FE_054 on the company view at every zoom no name is crammed into a bar beside its tag, and no icon is cut off', async ({ page, baseURL }) => {
  const url = baseURL!
  const { roadmap, ws } = await createScene(url)
  const w = ws[0].id
  let start = 2
  for (const [days, name] of [[14, 'Usage Dashboard'], [28, 'Mobile Sign-in'], [42, 'Pricing Page Refresh'], [56, 'Self-Serve Onboarding']] as const) {
    const d = await createDeliverable(url, roadmap, [w], isoDay(start), isoDay(start + days - 1), { name })
    const res = await apiFetch(url, `/api/deliverables/${d.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ icons: ['star', 'warning'] }) })
    expect(res.ok).toBe(true)
    start += days + 25
  }
  await page.goto('/#/company/workstreams')
  await expect(page.locator(`.deliverable[data-ws="${ws[0].name}"]`)).toHaveCount(4)
  for (const zoom of ['year', 'half', 'quarter', 'month']) {
    await page.locator(`button[data-z="${zoom}"]`).click()
    const bars = await page.locator(`.deliverable[data-ws="${ws[0].name}"]`).evaluateAll((els) => els.map((b) => {
      const n = b.querySelector<HTMLElement>('.name')!
      const ic = b.querySelector<HTMLElement>('.icons')
      const bar = b.getBoundingClientRect()
      const words = n.classList.contains('two') && n.scrollHeight > n.clientHeight + 1
      return {
        name: n.textContent,
        cropped: ic ? ic.scrollWidth > ic.clientWidth || ic.getBoundingClientRect().right > bar.right || [...ic.children].some((c) => c.getBoundingClientRect().width < 12) : false,
        cramped: words && n.clientWidth < 40,
      }
    }))
    for (const b of bars) expect({ zoom, ...b }).toEqual({ zoom, name: b.name, cropped: false, cramped: false })
  }
})
