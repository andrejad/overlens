// US-style date text for the side panel (REQ_FE_112, REQ_FE_024). Pure string work on "YYYY-MM-DD", no time zones.
import { dayOf, fmtWd } from '../timeline/axis'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "2026-03-12" -> "Mar 12, 2026"
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}, ${y}`
}

// "Mar 12, 2026 (Thu)": the panel's date with its weekday.
export function formatDateWd(iso: string): string {
  return `${formatDate(iso)} ${fmtWd(dayOf(iso))}`
}

// "Jan 12 (Mon) – Feb 27, 2026 (Fri) · 47 days": the count includes both ends; the start carries its year only when the years differ.
export function formatDateRange(start: string, end: string): string {
  const days = dayOf(end) - dayOf(start) + 1
  const from = start.slice(0, 4) === end.slice(0, 4) ? formatDate(start).replace(/, \d+$/, '') : formatDate(start)
  const span = start === end ? formatDateWd(end) : `${from} ${fmtWd(dayOf(start))} – ${formatDateWd(end)}`
  return `${span} · ${days} ${days === 1 ? 'day' : 'days'}`
}
