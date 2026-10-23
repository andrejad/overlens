import { useEffect, useState } from 'react'
import { Diamond, X } from 'lucide-react'
import { useCanEdit } from '../lib/canEdit'
import { addDependencyError } from '../lib/depErrors'
import { sessionRefusal } from '../lib/apiError'
import { addDependency, fetchDependencyCandidates, removeDependency } from '../api/resources'
import { formatDate } from '../lib/dates'
import type { Candidate, CandidateBlocked, DependencyEdge, ItemRef } from '../api/types'
import { edgeEnds, itemKey } from '../timeline/deps'

// REQ_DEP_007: why a candidate can't be chosen (the server decides; the picker never re-derives it).
const BLOCKED_TEXT: Record<CandidateBlocked, string> = {
  ends_too_late: 'ends too late',
  already_prerequisite: 'already a prerequisite',
  would_cycle: 'would create a loop',
}

// A diamond marks a milestone wherever the picker or the list names one (REQ_DEP_026).
export function Marker({ kind }: { kind?: string }) {
  return kind === 'milestone' ? <Diamond size={11} className="shrink-0 inline fill-current" aria-label="Milestone" data-testid="ms-marker" /> : null
}

// REQ_DEP_008/026: the one searchable picker, every team, deliverables and milestones together. Each entry reads
// "<team tag> - <name>"; the server orders them (tag, milestones first, name) and the picker keeps that order.
// Mounted (via DependenciesField) by DeliverableEditForm, which both the side panel and the full edit window use,
// and by the side panel's milestone view.
export function DependencyPicker({ candidates, onPick }: { candidates: Candidate[]; onPick: (c: Candidate) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = candidates.filter((c) => !q || `${c.team_tag} - ${c.name}`.toLowerCase().includes(q) || c.team_name.toLowerCase().includes(q))

  return (
    <div className="flex flex-col gap-1">
      <input
        type="search"
        className="inp w-full border border-border rounded px-2 py-1"
        placeholder="Search deliverables, milestones or teams…"
        aria-label="Search deliverables and milestones"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // REQ_FE_119: Escape with a search typed only clears it; the edit window sees defaultPrevented and stays open.
          if (e.key === 'Escape' && query) {
            e.preventDefault()
            setQuery('')
          }
        }}
      />
      <div className="max-h-48 overflow-auto border border-border rounded" role="listbox" aria-label="Prerequisite candidates">
        {shown.map((c) => (
          <button
            key={`${c.kind ?? 'deliverable'}:${c.id}`}
            data-kind={c.kind ?? 'deliverable'}
            type="button"
            role="option"
            aria-selected={false}
            aria-disabled={c.blocked !== null}
            disabled={c.blocked !== null}
            title={c.blocked ? BLOCKED_TEXT[c.blocked] : undefined}
            className={`w-full text-left px-2 py-1 text-sm flex justify-between gap-2 ${
              c.blocked ? 'opacity-50 cursor-not-allowed' : 'hover:bg-accent-soft'
            }`}
            onClick={() => onPick(c)}
          >
            <span className="truncate flex items-center gap-1">
              <Marker kind={c.kind} />
              {c.team_tag} - {c.name}
            </span>
            {c.blocked && <span className="text-xs text-text-3 shrink-0">{BLOCKED_TEXT[c.blocked]}</span>}
          </button>
        ))}
        {shown.length === 0 && <div className="px-2 py-1 text-xs text-text-3">No matching deliverables or milestones</div>}
      </div>
    </div>
  )
}

// The "Depends on" field: current prerequisites (removable) plus the picker. REQ_DEP_020: read-only
// visitors get neither the picker nor the remove buttons.
export function DependenciesField({
  item,
  edges,
  onChanged,
  itemKind = 'deliverable',
}: {
  item: ItemRef // the dependent: a deliverable or a milestone (REQ_DEP_026)
  edges: DependencyEdge[]
  onChanged: () => void
  // REQ_FE_121: the word the hint uses, "this deliverable" or "this milestone"; defaults to the deliverable form.
  itemKind?: 'deliverable' | 'milestone'
}) {
  const canEdit = useCanEdit()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [error, setError] = useState('')
  const me = itemKey(item.kind, item.id)
  const prerequisites = edges.filter((e) => edgeEnds(e).to === me)
  // A re-fetch after every add/remove keeps the server's `blocked` reasons current.
  const edgeKey = edges.map((e) => `${edgeEnds(e).from}>${edgeEnds(e).to}`).join(',')

  useEffect(() => {
    if (!canEdit) return
    let cancelled = false
    void Promise.resolve(fetchDependencyCandidates(item.id, item.kind))
      .then((c) => {
        if (!cancelled) setCandidates(c ?? [])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [item.id, item.kind, canEdit, edgeKey])

  async function pick(c: Candidate) {
    setError('')
    const from: ItemRef = { kind: c.kind ?? 'deliverable', id: c.id }
    try {
      await addDependency(item, from)
      onChanged()
    } catch (err) {
      const message = sessionRefusal(err) ?? addDependencyError(err)
      setError(message)
    }
  }

  async function remove(from: ItemRef) {
    setError('')
    try {
      await removeDependency(item, from)
      onChanged()
    } catch (err) {
      setError(sessionRefusal(err) ?? 'Could not remove the dependency')
    }
  }

  return (
    <div className="field">
      <label className="text-xs font-medium text-text-2">Depends on</label>
      {prerequisites.length === 0 && <div className="text-xs text-text-3">No prerequisites</div>}
      <ul className="flex flex-col gap-1">
        {prerequisites.map((e) => {
          const ends = edgeEnds(e)
          const from: ItemRef = { kind: ends.fromKind, id: ends.fromId }
          const name = e.other?.name ?? `#${ends.fromId}`
          return (
            <li key={ends.from} className="flex items-center gap-2 text-sm" data-kind={ends.fromKind}>
              <span className="flex-1 truncate">
                <Marker kind={ends.fromKind} /> {name}
                {e.other && <span className="text-xs text-text-3"> · {e.other.team_name}, ends {formatDate(e.other.end_date)}</span>}
              </span>
              {canEdit && (
                <button type="button" className="btn icon ghost sm" aria-label={`Remove prerequisite ${name}`} onClick={() => void remove(from)}>
                  <X size={14} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <div className="hint" data-testid="dep-hint">
        A prerequisite must end before this {itemKind} starts. Greyed options say why.
      </div>
      {canEdit && <DependencyPicker candidates={candidates} onPick={(c) => void pick(c)} />}
      {error && (
        <div className="hint bad text-danger text-xs" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
