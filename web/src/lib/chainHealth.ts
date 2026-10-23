// The meeting aids of a trace (REQ_DEP_036-039): health counts, gap flags, tight links and the Accountable list,
// worked out from what the trace shows. Pure; dates are Days (REQ_FE_065). The rules are the attention list's
// (internal/store/attention.go, REQ_API_054): done roadmap items never count; an owner of only white space is none.

import type { ItemKind, Status } from '../api/types'
import type { MergedView } from '../timeline/company'
import { dayOf, type Day } from '../timeline/axis'
import { edgeEnds, itemKey } from '../timeline/deps'
import { trimName } from './ui'

export const TIGHT_DAYS = 14 // REQ_DEP_038: 14 calendar days or fewer between the prerequisite's end and the dependent's start

export type HealthKind = 'risk' | 'overdue' | 'owner' | 'gap' | 'tight'
export type GapFlag = 'gap' | 'owner' // REQ_DEP_037

export interface ChainItem {
  key: string // itemKey(kind, id)
  kind: ItemKind
  id: number
  name: string
  tag: string
  owner: string // trimmed; '' is "No owner"
  status: Status
  start: Day
  end: Day
  overdue: boolean
  gap: boolean
  tightBefore: { name: string; days: number }[] // the tight links it is the prerequisite of
}

export interface ChainHealth {
  items: Map<string, ChainItem>
  counts: Record<HealthKind, number>
  focus: Record<HealthKind, Set<string>> // the item keys each count highlights
  flags: Map<string, GapFlag[]>
  tight: Map<string, { days: number; text: string }> // by edge key `${from}>${to}` (item keys)
  owners: { owner: string; items: ChainItem[] }[] // the Accountable list: by each owner's earliest end date ("No owner" is '')
}

// `chain` is the trace's view. Its dependencies are enough for "depends on nothing": every prerequisite of a milestone
// in a chain is in the chain too (it is a prerequisite of the root, or the milestone is a dependent through that edge).
export function chainHealth(chain: MergedView, today: Day): ChainHealth {
  const items = new Map<string, ChainItem>()
  const add = (kind: ItemKind, id: number, name: string, tag: string, owner: string | undefined, status: Status | undefined, start: Day, end: Day) => {
    const st = status ?? 'planned'
    items.set(itemKey(kind, id), { key: itemKey(kind, id), kind, id, name, tag, owner: trimName(owner ?? ''), status: st, start, end, overdue: end < today && st !== 'done', gap: false, tightBefore: [] })
  }
  for (const d of chain.roadmap.deliverables) add('deliverable', d.id, d.name, chain.tags.get(d.id) ?? '', d.responsible_person, d.status, dayOf(d.start_date), dayOf(d.end_date))
  for (const m of chain.roadmap.milestones) add('milestone', m.id, m.name, chain.milestoneOrigin.get(m.id)?.tag ?? '', m.responsible_person, m.status, dayOf(m.date), dayOf(m.date))

  const hasPrereq = new Set(chain.roadmap.dependencies.map((e) => edgeEnds(e).to))
  for (const it of items.values()) it.gap = it.kind === 'milestone' && it.status !== 'done' && !hasPrereq.has(it.key)

  // The dates come from the items themselves, not from the edge's copy of them, so an edit shows at once.
  const tight = new Map<string, { days: number; text: string }>()
  for (const e of chain.roadmap.dependencies) {
    const { from, to } = edgeEnds(e)
    const a = items.get(from)
    const b = items.get(to)
    if (!a || !b || a.status === 'done') continue
    const days = b.start - a.end
    if (days > TIGHT_DAYS) continue
    tight.set(`${from}>${to}`, { days, text: `${days} days between ${a.name} and ${b.name}` })
    a.tightBefore.push({ name: b.name, days })
  }

  const all = [...items.values()]
  const open = all.filter((i) => i.status !== 'done')
  const focus: Record<HealthKind, Set<string>> = {
    risk: new Set(all.filter((i) => i.status === 'at_risk').map((i) => i.key)),
    overdue: new Set(all.filter((i) => i.overdue).map((i) => i.key)),
    owner: new Set(open.filter((i) => i.owner === '').map((i) => i.key)),
    gap: new Set(all.filter((i) => i.gap).map((i) => i.key)),
    tight: new Set([...tight.keys()].flatMap((k) => k.split('>'))),
  }
  const counts = { risk: focus.risk.size, overdue: focus.overdue.size, owner: focus.owner.size, gap: focus.gap.size, tight: tight.size }

  const flags = new Map<string, GapFlag[]>()
  for (const it of open) {
    const f: GapFlag[] = [...(it.gap ? ['gap' as const] : []), ...(it.owner === '' ? ['owner' as const] : [])]
    if (f.length) flags.set(it.key, f)
  }

  const groups = new Map<string, ChainItem[]>()
  for (const it of all) groups.set(it.owner, [...(groups.get(it.owner) ?? []), it])
  // REQ_DEP_039: each group by end date; the groups by their earliest one (the owner's most urgent item), "No owner"
  // included; on the same date A–Z ignoring case, "No owner" after the names.
  const owners = [...groups]
    .map(([owner, list]) => ({ owner, items: list.sort((x, y) => x.end - y.end || x.name.localeCompare(y.name)) }))
    .sort((a, b) => a.items[0].end - b.items[0].end || (a.owner === '' ? 1 : b.owner === '' ? -1 : a.owner.localeCompare(b.owner, undefined, { sensitivity: 'base' })))
  return { items, counts, focus, flags, tight, owners }
}
