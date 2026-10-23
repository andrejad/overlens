// Shared Tailwind class strings for the auth/admin UI (`btn`/`inp` also carry the base styles from index.css; `.inp` is width:100%, so add `w-auto` or a width for inline inputs).
export const BTN = 'btn border border-border rounded px-2 py-1 text-sm bg-surface text-text hover:bg-surface-2'
export const BTN_PRIMARY = 'btn primary border border-accent rounded px-3 py-1 text-sm bg-accent text-accent-text'
export const INPUT = 'inp border border-border rounded px-2 py-1 text-sm bg-surface text-text'

// REQ_DAT_028: the one trim for every NAME field (team, tag, roadmap title, workstream, deliverable, milestone,
// imported names). It removes leading and trailing Unicode White_Space plus U+FEFF and U+200B, exactly like the
// server's cleanName, and leaves characters in the middle alone. JavaScript's own trim() differs (it keeps U+0085
// and U+200B, and strips U+FEFF), so it must not be used on names. Scanned from both ends (no `$` regex), so a long
// name full of inner spaces cannot cost quadratic time.
const NAME_PAD = /^[\p{White_Space}﻿​]$/u

export function trimName(s: string): string {
  const cps = Array.from(s)
  let a = 0
  let b = cps.length
  while (a < b && NAME_PAD.test(cps[a])) a++
  while (b > a && NAME_PAD.test(cps[b - 1])) b--
  return cps.slice(a, b).join('')
}
