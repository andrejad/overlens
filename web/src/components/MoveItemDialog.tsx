import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { fetchRoadmap, fetchTeams, moveItem } from '../api/resources'
import type { Deliverable, Milestone, MoveInput, RoadmapFull, Team } from '../api/types'
import { CAP_MESSAGE } from '../timeline/axis'
import { trimName } from '../lib/ui'
import { formatDate } from '../lib/dates'
import { apiError, refusalMessage } from '../lib/apiError'
import { showToast } from './Toast'
import { Dialog } from './Dialog'

// REQ_FE_030 / REQ_FE_122: the one "Move to another team" dialog, for a deliverable and a milestone alike. It offers
// the other teams (each has one roadmap, REQ_DAT_032); every workstream of the item goes to the destination's
// same-named workstream by default, or to another one, a new one, or (a deliverable only) nowhere. The server stays
// the authority (REQ_API_052); the 3-year problem is shown here first so a confirm that would fail is not offered.
const CREATE = 'create'
const DROP = 'drop'

type Choice = string // a destination workstream id, CREATE or DROP

// The server's workstream-name comparison (wsKey): trimmed, ASCII case ignored.
const wsKey = (s: string) => trimName(s).replace(/[A-Z]/g, (c) => c.toLowerCase())

// A 3-year refusal reads REQ_FE_062's message like everywhere else (refusalMessage).
function apiMessage(err: unknown, fallback: string): string {
  const { fields } = apiError(err)
  return [refusalMessage(err), fields ? Object.values(fields).join('; ') : ''].filter(Boolean).join(' - ') || fallback
}

// The destination roadmap's range after the move would pass 3 years (mirrors the server's rule, REQ_DAT_015/REQ_API_012).
export function spanProblem(dest: Pick<RoadmapFull, 'range_start' | 'range_end'>, start: string, end: string): string | null {
  const s = dest.range_start && dest.range_start < start ? dest.range_start : start
  const e = dest.range_end && dest.range_end > end ? dest.range_end : end
  const limit = new Date(`${s}T00:00:00Z`)
  limit.setUTCFullYear(limit.getUTCFullYear() + 3)
  if (new Date(`${e}T00:00:00Z`) <= limit) return null
  if (dest.range_start && dest.range_end && s >= dest.range_start && e <= dest.range_end) return null // already that wide
  return `earliest ${formatDate(s)} → latest ${formatDate(e)}`
}

type Props = {
  roadmap: RoadmapFull // the item's current roadmap
  onClose: () => void
  onMoved: (moved: Deliverable | Milestone) => void // the item left this roadmap
} & ({ kind: 'deliverable'; item: Deliverable } | { kind: 'milestone'; item: Milestone })

export function MoveItemDialog({ kind, item, roadmap, onClose, onMoved }: Props) {
  const [teams, setTeams] = useState<Team[]>([])
  const [teamId, setTeamId] = useState<number | undefined>()
  const [dest, setDest] = useState<RoadmapFull | undefined>()
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const label = kind === 'milestone' ? 'milestone' : 'deliverable'

  // Keyed by the ids' text, not the item: a new item object with the same workstreams must not reset the choices.
  const wsIds = (kind === 'deliverable' ? item.workstream_ids : [item.workstream_id]).join(',')
  const sources = useMemo(
    () => wsIds.split(',').map(Number).map((id) => ({ id, name: roadmap.workstreams.find((w) => w.id === id)?.name ?? `Workstream ${id}` })),
    [wsIds, roadmap.workstreams],
  )
  const [start, end] = kind === 'deliverable' ? [item.start_date, item.end_date] : [item.date, item.date]

  useEffect(() => {
    let live = true
    fetchTeams()
      .then((all) => live && setTeams(all.filter((t) => t.id !== roadmap.team.id)))
      .catch(() => live && setError('Could not load the teams'))
    return () => {
      live = false
    }
  }, [roadmap.team.id])

  const destRoadmapId = teams.find((t) => t.id === teamId)?.roadmap_id
  useEffect(() => {
    setDest(undefined)
    if (destRoadmapId === undefined) return
    let live = true
    fetchRoadmap(destRoadmapId)
      .then((full) => {
        if (!live) return
        setDest(full)
        setChoices(
          Object.fromEntries(
            sources.map((s) => {
              const same = full.workstreams.find((w) => wsKey(w.name) === wsKey(s.name)) // the first by position
              return [s.id, same ? String(same.id) : CREATE]
            }),
          ),
        )
      })
      .catch(() => live && setError('Could not load the destination roadmap'))
    return () => {
      live = false
    }
  }, [destRoadmapId, sources])

  const matches = (name: string) => dest?.workstreams.find((w) => wsKey(w.name) === wsKey(name))
  const kept = sources.filter((s) => choices[s.id] !== DROP)
  const problem = dest ? spanProblem(dest, start, end) : null
  const destTeamName = teams.find((t) => t.id === teamId)?.name ?? ''

  // Dependencies that stay, and how many of them cross a team border because of this move.
  const edges = roadmap.dependencies.filter((e) => (e.from_kind === kind && e.from_id === item.id) || (e.to_kind === kind && e.to_id === item.id))
  const crossing = edges.filter((e) => {
    const other = e.from_kind === kind && e.from_id === item.id ? e.to : e.from
    return other.roadmap_id === roadmap.id
  }).length
  // Memberships this move loses: dropped ones, and ones that land on the same destination workstream as another.
  const dropped = sources.length - kept.length
  const merged = kept.length - new Set(kept.map((s) => (choices[s.id] === CREATE ? `c:${wsKey(s.name)}` : choices[s.id]))).size
  const lost = [dropped ? `${dropped} workstream ${dropped === 1 ? 'membership' : 'memberships'} dropped` : '', merged ? `${merged} merged into another` : '']
    .filter(Boolean)
    .join(', ')
  const summary = `${edges.length} ${edges.length === 1 ? 'dependency stays' : 'dependencies stay'}${
    crossing ? ` (${crossing} become${crossing === 1 ? 's' : ''} cross-team)` : ''
  }${kind === 'deliverable' ? ' · color kept · dates unchanged' : ' · date unchanged'}${lost ? ` · ${lost}` : ''}${dest && !problem ? ' · fits the 3-year span' : ''}`

  async function handleMove() {
    if (teamId === undefined || !dest) return
    setSaving(true)
    setError('')
    const input: MoveInput = {
      team_id: teamId,
      workstream_map: sources.map((s) => {
        const c = choices[s.id]
        return { from: s.id, to: c === DROP ? null : c === CREATE ? { create: s.name } : Number(c) }
      }),
    }
    try {
      onMoved(await moveItem(kind, item.id, input))
      onClose()
      showToast({ message: `Moved “${item.name}” to ${destTeamName}` }) // a plain success notice; there is no Undo
    } catch (err) {
      const message = apiMessage(err, `Could not move the ${label}`)
      console.error(`${kind}.move.error`, { id: item.id, message })
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog label={`Move ${label}`} onClose={onClose} className="w-[520px] max-h-[90vh] overflow-auto p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-lg">Move &ldquo;{item.name}&rdquo;</h2>
        <button type="button" className="btn icon ghost sm" aria-label="Close" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-col gap-3">
        <div className="field">
          <label>Destination team</label>
          <div className="flex flex-col gap-1">
            {teams.map((t) => (
              <label key={t.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="move-team"
                  aria-label={t.name}
                  checked={teamId === t.id}
                  onChange={() => {
                    setError('')
                    setTeamId(t.id)
                  }}
                />
                <b>{t.name}</b>
              </label>
            ))}
          </div>
        </div>

        {dest && (
          <div className="field">
            <label>Workstreams in {dest.team.name}</label>
            <div className="flex flex-col gap-2">
              {sources.map((s) => {
                const match = matches(s.name)
                return (
                  <div key={s.id} className="flex items-center gap-2">
                    <span className="nm w-36 truncate" title={s.name}>
                      {s.name}
                    </span>
                    <span aria-hidden="true">&rarr;</span>
                    <select
                      aria-label={`Destination for ${s.name}`}
                      className="inp flex-1 border border-border rounded px-2 py-1"
                      value={choices[s.id] ?? ''}
                      onChange={(e) => setChoices((c) => ({ ...c, [s.id]: e.target.value }))}
                    >
                      {dest.workstreams.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                      {!match && <option value={CREATE}>{`Create "${s.name}" in ${dest.team.name}`}</option>}
                      {kind === 'deliverable' && (
                        <option value={DROP} disabled={kept.length === 1 && choices[s.id] !== DROP}>
                          Drop from this workstream
                        </option>
                      )}
                    </select>
                    {match && choices[s.id] === String(match.id) && <span className="hint m-0">Same name</span>}
                  </div>
                )
              })}
            </div>
            <div className="hint">{kind === 'deliverable' ? 'Matched by name. At least one workstream must remain.' : 'Matched by name.'}</div>
          </div>
        )}

        {dest && (
          <div className="hint flex items-center gap-2 text-text-2" data-testid="move-summary">
            {summary}
          </div>
        )}
        {problem && (
          <div className="hint bad text-danger text-xs">
            <div role="alert">{CAP_MESSAGE}</div>
            <div>{`Moving it would make ${dest!.team.name}'s roadmap run ${problem}.`}</div>
          </div>
        )}
        {error && (
          <div className="hint bad text-danger text-xs" role="alert">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={saving || !dest || kept.length === 0 || problem !== null} onClick={handleMove}>
            {destTeamName ? `Move to ${destTeamName}` : 'Move'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
