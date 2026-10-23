import { useEffect, useState } from 'react'
import { useHashRoute, parseRoute } from './lib/router'
import { AuthProvider } from './lib/auth'
import { TourProvider } from './tutorial/TourProvider'
import { SessionBanner, TopBarSlot } from './components/AppChrome'
import { TeamListPage } from './pages/TeamListPage'
import { TeamRoadmapPage } from './pages/TeamRoadmapPage'
import { ManageWorkstreamsPage } from './pages/ManageWorkstreamsPage'
import { CompanyPage } from './pages/CompanyPage'
import { CompanyOrderPage } from './pages/CompanyOrderPage'
import { AdminPage } from './pages/AdminPage'

// App shell/routing (hash routes, parsed in lib/router.tsx): "#/teams" team list, "#/" the company view, "#/teams/:id" a team's roadmap,
// "#/teams/:id/workstreams" its Manage workstreams page, "#/company/workstreams" (the company view; "#/company" leads
// there), "#/company/order" and "#/company/trace/:kind/:id", "#/admin" the admin screen. AuthProvider asks GET /api/me and provides canEdit (REQ_FE_083); the login
// dialog is rendered by the provider over whatever page is showing, so logging in never changes the
// route or remounts the page (REQ_AUTH_005). Anonymous visitors reach every route read-only (REQ_AUTH_001).
export default function App() {
  const route = parseRoute(useHashRoute())
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const redirect = route.name === 'company' && route.redirect
  useEffect(() => {
    if (redirect) window.location.replace('#/company/workstreams') // REQ_FE_091: "#/company" leads to the company view
  }, [redirect])

  return (
    <AuthProvider>
      <TourProvider>
      <div className="h-screen flex flex-col bg-bg text-text">
        <div ref={setSlot} className="shrink-0" />
        <SessionBanner />
        <TopBarSlot.Provider value={slot}>
        <div className="flex-1 min-h-0 overflow-auto">
          {route.name === 'team' ? (
            <TeamRoadmapPage key={route.teamId} teamId={route.teamId} />
          ) : route.name === 'workstreams' ? (
            <ManageWorkstreamsPage key={route.teamId} teamId={route.teamId} />
          ) : route.name === 'company' ? (
            <CompanyPage mode="workstreams" milestonesOnly={route.milestones === true} />
          ) : route.name === 'companyOrder' ? (
            <CompanyOrderPage />
          ) : route.name === 'trace' ? (
            <CompanyPage key={`trace${route.kind}${route.id}${route.milestones ? 'm' : ''}`} mode="trace" traceKind={route.kind} traceId={route.id ?? undefined} milestonesOnly={route.milestones === true} />
          ) : route.name === 'admin' ? (
            <AdminPage />
          ) : (
            <TeamListPage />
          )}
        </div>
        </TopBarSlot.Provider>
      </div>
      </TourProvider>
    </AuthProvider>
  )
}
