import { useEffect, useState } from 'react'
import { TopBar } from '../components/AppChrome'
import { fetchTeamOrder } from '../api/resources'
import type { TeamOrderItem } from '../api/types'

// The team list (REQ_FE_098): the teams in the saved team order (REQ_FE_094), each linking to its roadmap
// ("#/teams/<id>"); "See workstreams (all teams)" in the top bar opens the company views.
export function TeamListPage() {
  return (
    <>
      <TopBar />
      <TeamList />
    </>
  )
}

function TeamList() {
  const [teams, setTeams] = useState<TeamOrderItem[] | null>(null)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    void fetchTeamOrder().then(setTeams).catch(() => setLoadError(true))
  }, [])

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Teams:</h1>
      {loadError && (
        <p className="hint bad" role="alert">
          Could not load the teams
        </p>
      )}
      {teams === null && !loadError && <p className="text-text-2">Loading…</p>}
      {teams !== null && teams.length === 0 && <p className="text-text-2">No teams yet.</p>}
      <ul className="flex flex-col gap-1">
        {teams?.map((t) => (
          <li key={t.id} className="flex items-center gap-3" data-testid="team-row">
            <a className="text-accent underline" href={`#/teams/${t.id}`}>
              {t.name} <span className="text-text-3 text-xs">({t.tag})</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  )
}
