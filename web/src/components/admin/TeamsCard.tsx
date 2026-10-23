import { useEffect, useState } from 'react'
import { createTeam, deleteTeam, fetchCompanyRoadmaps, fetchTeams, patchTeam } from '../../api/resources'
import type { Team } from '../../api/types'
import { apiError, sessionRefusal } from '../../lib/apiError'
import { BTN, BTN_PRIMARY, INPUT, trimName } from '../../lib/ui'
import { Dialog } from '../Dialog'

// REQ_FE_004 / REQ_AUTH_012: add (which creates the team's roadmap too, REQ_DAT_032), rename, re-tag, recolor in
// place, and delete (confirmed, blocked while its roadmap holds roadmap items, REQ_API_010). Admin-only server side;
// this card is only mounted for a logged-in admin.
function teamError(err: unknown): string {
  const refused = sessionRefusal(err)
  if (refused) return refused
  const e = apiError(err)
  if (e.code === 'duplicate_name') return 'Another team already has that name.'
  if (e.code === 'duplicate_tag') return 'Another team already has that tag.'
  if (e.code === 'has_roadmap_items') return 'This team’s roadmap still holds roadmap items — move or delete them first.'
  if (e.status === 422) return e.message ?? 'That value is not valid.'
  return 'Could not save the team.'
}

// A suggested tag from a name: the initials of up to three words, or the first three letters of one word.
export function suggestTag(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length === 0) return ''
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
}

// REQ_FE_004: the reason is only the disabled Delete's tooltip and accessible description, never visible text.
const BLOCKED_REASON = 'Its roadmap has items — can’t delete'

function TeamRow({
  team,
  itemCount,
  onChanged,
  onDelete,
}: {
  team: Team
  itemCount: number | undefined // roadmap items (deliverables and milestones) on the team's roadmap
  onChanged: (t: Team) => void
  onDelete: (t: Team) => void
}) {
  const [name, setName] = useState(team.name)
  const [tag, setTag] = useState(team.tag)
  const [color, setColor] = useState(team.default_color)
  const [error, setError] = useState('')

  async function commit(field: 'name' | 'tag' | 'default_color', value: string) {
    const trimmed = trimName(value)
    if (trimmed === team[field]) return
    setError('')
    try {
      const saved = await patchTeam(team.id, { [field]: trimmed })
      onChanged(saved)
    } catch (err) {
      setError(teamError(err))
    }
  }

  const blocked = (itemCount ?? 0) > 0
  return (
    <tr className="border-t border-border align-middle" data-testid={`team-row-${team.id}`}>
      <td className="py-1.5 pr-2">
        <input
          className={`${INPUT} w-full`}
          aria-label={`Name of ${team.name}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commit('name', name)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {error && (
          <div className="text-danger text-xs mt-1" role="alert">
            {error}
          </div>
        )}
      </td>
      <td className="py-1.5 pr-2">
        <input
          className={`${INPUT} w-20`}
          aria-label={`Tag of ${team.name}`}
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onBlur={() => void commit('tag', tag)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </td>
      <td className="py-1.5 pr-2 whitespace-nowrap">
        <input
          type="color"
          aria-label={`Default color of ${team.name}`}
          value={color}
          onChange={(e) => setColor(e.target.value)}
          onBlur={() => void commit('default_color', color)}
        />{' '}
        <span className="text-xs text-text-2">{color}</span>
      </td>
      <td className="py-1.5 pr-2 text-text-2">{itemCount === undefined ? '' : itemCount === 0 ? 'Empty roadmap' : `${itemCount} roadmap item${itemCount === 1 ? '' : 's'}`}</td>
      <td className="py-1.5 text-right">
        <button
          type="button"
          className={`${BTN} ${blocked ? '!bg-surface-2 !text-text-3 opacity-60 cursor-not-allowed' : ''}`}
          disabled={blocked}
          title={blocked ? BLOCKED_REASON : undefined}
          aria-describedby={blocked ? `delete-reason-${team.id}` : undefined}
          onClick={() => onDelete(team)}
        >
          Delete
        </button>
        {blocked && (
          <span id={`delete-reason-${team.id}`} className="sr-only">
            {BLOCKED_REASON}
          </span>
        )}
      </td>
    </tr>
  )
}

export function TeamsCard() {
  const [teams, setTeams] = useState<Team[] | null>(null)
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [loadError, setLoadError] = useState('')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [tag, setTag] = useState('')
  const [tagTouched, setTagTouched] = useState(false)
  const [color, setColor] = useState('#4338ca')
  const [addError, setAddError] = useState('')
  const [confirming, setConfirming] = useState<Team | null>(null)
  const [deleteError, setDeleteError] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetchTeams()
      .then(async (list) => {
        if (cancelled) return
        setTeams(list)
        const all = await fetchCompanyRoadmaps().catch(() => [])
        if (cancelled) return
        setCounts(Object.fromEntries(all.map((c) => [c.team.id, c.roadmap.deliverables.length + c.roadmap.milestones.length])))
      })
      .catch(() => !cancelled && setLoadError('Could not load the teams.'))
    return () => {
      cancelled = true
    }
  }, [])

  async function add() {
    setAddError('')
    try {
      const t = await createTeam({ name: trimName(name), tag: trimName(tag), default_color: color })
      setTeams((l) => [...(l ?? []), t].sort((a, b) => a.name.localeCompare(b.name)))
      setCounts((c) => ({ ...c, [t.id]: 0 }))
      setName('')
      setTag('')
      setTagTouched(false)
      setAdding(false)
    } catch (err) {
      setAddError(teamError(err))
    }
  }

  async function confirmDelete(t: Team) {
    setDeleteError('')
    try {
      await deleteTeam(t.id)
      setTeams((l) => (l ?? []).filter((x) => x.id !== t.id))
      setConfirming(null)
    } catch (err) {
      setDeleteError(teamError(err))
    }
  }

  return (
    <section className="bg-surface border border-border rounded-lg p-4" id="admin-teams" aria-labelledby="admin-teams-h">
      <div className="flex items-center gap-3 mb-1">
        <h2 id="admin-teams-h" className="font-semibold text-lg flex-1">
          Teams
        </h2>
        <button type="button" className={BTN} onClick={() => setAdding((a) => !a)}>
          Add team
        </button>
      </div>
      <p className="text-sm text-text-2 mb-3">
        Each team has a short tag (shown on company-view blocks) and a default deliverable color that pre-fills new
        deliverables. Changing it never recolors existing ones.
      </p>
      {adding && (
        <div className="relative flex items-end gap-2 flex-wrap mb-3" role="group" aria-label="New team">
          <label className="text-xs text-text-2 flex flex-col gap-1">
            Team name
            <input
              className={`${INPUT} w-auto`}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!tagTouched) setTag(suggestTag(e.target.value))
              }}
            />
          </label>
          <label className="text-xs text-text-2 flex flex-col gap-1">
            Tag
            <input
              className={`${INPUT} w-20`}
              value={tag}
              onChange={(e) => {
                setTag(e.target.value)
                setTagTouched(true)
              }}
            />
          </label>
          <label className="text-xs text-text-2 flex flex-col gap-1">
            Default color
            <input type="color" className="h-[34px]" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <button type="button" className={BTN_PRIMARY} onClick={() => void add()}>
            Create team
          </button>
          {addError && (
            <span className="absolute left-0 top-full text-danger text-xs" role="alert">
              {addError}
            </span>
          )}
        </div>
      )}
      {loadError && (
        <p className="text-danger text-sm" role="alert">
          {loadError}
        </p>
      )}
      {teams === null && !loadError && <p className="text-text-2 text-sm">Loading…</p>}
      {teams && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-2 text-xs">
              <th className="py-1">Team</th>
              <th>Tag</th>
              <th>Default color</th>
              <th>Roadmap</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <TeamRow
                key={t.id}
                team={t}
                itemCount={counts[t.id]}
                onChanged={(saved) => setTeams((l) => (l ?? []).map((x) => (x.id === saved.id ? saved : x)))}
                onDelete={(x) => {
                  setDeleteError('')
                  setConfirming(x)
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-text-3 mt-2">
        Click a name, tag or color to edit it in place — it saves on Enter or blur. Creating a team creates its roadmap
        (with one workstream, “General”). A team can only be deleted when its roadmap holds no roadmap items.
      </p>
      {confirming && (
        <Dialog label="Delete team" onClose={() => setConfirming(null)} className="w-[420px] p-4">
          <h3 className="font-semibold text-lg mb-2">Delete team</h3>
          <p className="text-sm mb-3">
            Delete the team “{confirming.name}”? This can’t be undone.
          </p>
          {deleteError && (
            <p className="text-danger text-xs mb-2" role="alert">
              {deleteError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={() => void confirmDelete(confirming)}>
              Delete team
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}
