import { useEffect, useState } from 'react'
import type { ItemKind } from '../api/types'

// Minimal hash router. Routes: "#/teams" team list, "#/" and '' the company view, "#/teams/:id" a team's roadmap, "#/teams/:id/workstreams" its
// Manage workstreams page (REQ_FE_105), "#/company/workstreams" (the company view; "#/company" leads there, REQ_FE_091),
// "#/company/order", "#/company/trace/:id" (a deliverable) or "#/company/trace/:kind/:id", and "#/admin".
// "?milestones" on the company view or the trace is the Milestones only switch (REQ_FE_136/137).
export function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || '#/')
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export function navigate(hash: string): void {
  window.location.hash = hash
}

export type Route =
  | { name: 'teams' }
  | { name: 'team'; teamId: number }
  | { name: 'workstreams'; teamId: number } // REQ_FE_105
  | { name: 'company'; redirect?: true; milestones?: true } // redirect: the address is "#/company", which leads to the company view's own
  | { name: 'companyOrder' } // REQ_FE_116
  | { name: 'trace'; kind: ItemKind; id: number | null; milestones?: true } // null: the address names no usable id (shown as not found)
  | { name: 'admin' }

export function parseRoute(hash: string): Route {
  const [rawPath, query = ''] = hash.replace(/^#/, '').split('?')
  const path = rawPath.replace(/\/+$/, '')
  // REQ_FE_136/137: the Milestones only switch lives in the address; the key is only present when it is on
  const ms = new URLSearchParams(query).has('milestones') ? { milestones: true as const } : {}
  let m = path.match(/^\/teams\/(\d+)\/workstreams$/)
  if (m) return { name: 'workstreams', teamId: Number(m[1]) }
  m = path.match(/^\/teams\/(\d+)$/)
  if (m) return { name: 'team', teamId: Number(m[1]) }
  // Anything under /company/trace is the trace page: a malformed or oversized id is its not-found state, never
  // the team list and never a request to the server (REQ_DEP_021).
  // REQ_DEP_028: `/company/trace/<kind>/<id>` is typed; `/company/trace/<id>` stays valid and means a deliverable.
  m = path.match(/^\/company\/trace(?:\/(.*))?$/)
  if (m) {
    const typed = (m[1] ?? '').match(/^(deliverable|milestone)\/(\d+)$/)
    const kind: ItemKind = typed ? (typed[1] as ItemKind) : 'deliverable'
    const digits = typed ? typed[2] : m[1] ?? ''
    const id = /^\d+$/.test(digits) ? Number(digits) : NaN
    return { name: 'trace', kind, id: Number.isSafeInteger(id) && id > 0 ? id : null, ...ms }
  }
  if (path === '/company') return { name: 'company', redirect: true }
  if (path === '/company/workstreams') return { name: 'company', ...ms }
  if (path === '/company/order') return { name: 'companyOrder' }
  if (path.startsWith('/admin')) return { name: 'admin' }
  if (path === '/teams') return { name: 'teams' }
  return { name: 'company' } // REQ_FE_091: the empty address and "#/" open the company view
}
