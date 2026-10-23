import { formatDate } from './dates'

// Turns the Phase 5 dependency errors (docs/API.md "Dependencies") into screen messages. The 409
// extras (`path`, `earliest_start`, `latest_end`) are read from inside `error` or from the body's top
// level, whichever the server puts them in.

// Phase 9: `path` is a list of names for a loop of deliverables only, and [{kind, name}] when a milestone is on the loop
// (REQ_DEP_025). A milestone's date_order carries earliest_date / latest_date (REQ_DEP_024).
export type CyclePath = (string | { kind: string; name: string })[]
interface Body {
  error?: { code?: string; message?: string; path?: CyclePath; earliest_start?: string; latest_end?: string; earliest_date?: string; latest_date?: string }
  path?: CyclePath
  earliest_start?: string
  latest_end?: string
}

function bodyOf(err: unknown): Body {
  return (err as { response?: { data?: Body } })?.response?.data ?? {}
}

// REQ_DEP_003/025: name the loop, e.g. "A → B → C → A"; a milestone on it is marked with a diamond, "A → ◆ Launch → A".
export function cycleMessage(path: CyclePath): string {
  const names = path.map((p) => (typeof p === 'string' ? p : p.kind === 'milestone' ? `◆ ${p.name}` : p.name))
  const loop = names.length > 0 && names[0] !== names[names.length - 1] ? [...names, names[0]] : names
  return `That would create a loop: ${loop.join(' → ')}`
}

// Message for a failed add-dependency call.
export function addDependencyError(err: unknown): string {
  const b = bodyOf(err)
  const code = b.error?.code
  if (code === 'cycle') return cycleMessage(b.error?.path ?? b.path ?? [])
  if (code === 'date_order') {
    const earliest = b.error?.earliest_start ?? b.earliest_start
    return earliest
      ? `The dependent would start too early — the earliest allowed start is ${formatDate(earliest)}`
      : 'The dependent would start on or before the prerequisite ends'
  }
  return b.error?.message ?? 'Could not add the dependency'
}

// REQ_DEP_004/006: a 409 date_order on a date save, with the bound the server reports.
export function dateOrderMessage(err: unknown): string | null {
  const b = bodyOf(err)
  if (b.error?.code !== 'date_order') return null
  const earliest = b.error.earliest_start ?? b.earliest_start
  const latest = b.error.latest_end ?? b.latest_end
  if (earliest) return `Can’t start before ${earliest} — a prerequisite ends then`
  if (latest) return `Can’t end after ${latest} — a dependent starts the day after`
  // a milestone's date (REQ_DEP_024/026)
  const earliestDate = b.error.earliest_date
  const latestDate = b.error.latest_date
  if (earliestDate && latestDate) return `The date must be between ${earliestDate} and ${latestDate} — a prerequisite and a dependent limit it`
  if (earliestDate) return `The date can’t be before ${earliestDate} — a prerequisite ends the day before`
  if (latestDate) return `The date can’t be after ${latestDate} — a dependent starts the day after`
  return b.error.message ?? 'That date breaks a dependency'
}
