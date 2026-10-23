import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { fetchTeamOrder } from '../api/resources'
import { useAuth } from '../lib/auth'
import * as prefs from '../lib/prefs'
import { runTour, type Run } from './runTour'
import { stepsFor } from './steps'
import { TourContext } from './tourContext'

// Starts the tour for the Help button (REQ_FE_129) and by itself on the first visit (REQ_FE_130).
export function TourProvider({ children }: { children: ReactNode }) {
  const { canEdit, loading } = useAuth()
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const run = useRef<Run | null>(null)
  const teamId = useRef<Promise<number | null> | null>(null)

  const start = useCallback(() => {
    if (run.current) return
    const resolveTeamId = () => (teamId.current ??= fetchTeamOrder().then((t) => t[0]?.id ?? null).catch(() => null)) // a GET
    run.current = runTour(stepsFor(canEditRef.current), resolveTeamId, () => {
      run.current = null
    })
  }, [])

  // REQ_FE_130: the first visit in this browser, once the login state is known.
  useEffect(() => {
    if (!loading && !prefs.getTutorialSeen()) start()
  }, [loading, start])

  useEffect(() => () => run.current?.abort(), [])

  return <TourContext.Provider value={{ start }}>{children}</TourContext.Provider>
}
