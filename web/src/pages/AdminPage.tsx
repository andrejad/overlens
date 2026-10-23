import { TopBar } from '../components/AppChrome'
import { useAuth } from '../lib/auth'
import { BTN } from '../lib/ui'
import { AuditCard } from '../components/admin/AuditCard'
import { StorageCard } from '../components/admin/StorageCard'
import { IconLabelsCard } from '../components/admin/IconLabelsCard'
import { TeamsCard } from '../components/admin/TeamsCard'
import { UsersCard } from '../components/admin/UsersCard'

// "#/admin" — wireframes/admin.html. Guarded: nothing is fetched until someone is logged in; an
// anonymous visitor gets a read-only "Admins only" message and a way to open the login dialog.
export function AdminPage() {
  return (
    <>
      <TopBar />
      <AdminGuarded />
    </>
  )
}

function AdminGuarded() {
  const { user, loading, openLogin } = useAuth()

  if (loading) return <div className="p-6 text-text-2">Loading…</div>
  if (!user) {
    return (
      <div className="p-6 max-w-xl" data-testid="admin-guard">
        <h1 className="text-2xl font-semibold mb-2">Admin</h1>
        <p className="text-text-2 mb-3">Admins only. Log in to manage users, teams, icon labels and the audit log.</p>
        <button type="button" className={BTN} onClick={openLogin}>
          Log in
        </button>
      </div>
    )
  }
  return <AdminContent />
}

function AdminContent() {
  const sections: [string, string][] = [
    ['admin-users', 'Users'],
    ['admin-teams', 'Teams'],
    ['admin-icons', 'Icon labels'],
    ['admin-audit', 'Audit log'],
    ['admin-storage', 'Storage'],
  ]
  return (
    <div className="p-6 max-w-5xl mx-auto flex flex-col gap-4" data-testid="admin-page">
      <div>
        <a href="#/" className="text-accent underline text-sm">
          ← Back to roadmaps
        </a>
        <div className="text-xs uppercase tracking-wide text-text-3 mt-2">Administration</div>
        <h1 className="text-2xl font-semibold">Admin</h1>
      </div>
      <nav className="flex gap-2 flex-wrap" aria-label="Admin sections">
        {sections.map(([id, label]) => (
          <button key={id} type="button" className={BTN} onClick={() => document.getElementById(id)?.scrollIntoView?.()}>
            {label}
          </button>
        ))}
      </nav>
      <UsersCard />
      <TeamsCard />
      <IconLabelsCard />
      <AuditCard />
      <StorageCard />
    </div>
  )
}
