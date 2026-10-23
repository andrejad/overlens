import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronsUpDown, HelpCircle, Layers, Moon, Sun, Users } from 'lucide-react'
import * as prefs from '../lib/prefs'
import { useAuth } from '../lib/auth'
import { navigate } from '../lib/router'
import { BTN } from '../lib/ui'
import { useTour } from '../tutorial/tourContext'

// REQ_FE_104: an icon button that flips light/dark. The choice is saved in this browser (REQ_FE_071) and put on
// <html data-theme>, which index.css styles.
export function ThemeToggle() {
  const [theme, setTheme] = useState<prefs.Theme>(() => prefs.getTheme() ?? 'light')
  useEffect(() => {
    prefs.applyTheme(theme)
  }, [theme])
  const next: prefs.Theme = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className="btn icon ghost"
      id="theme-toggle"
      data-testid="theme-toggle"
      title="Toggle light / dark"
      aria-label="Toggle light / dark"
      onClick={() => {
        prefs.setTheme(next)
        setTheme(next)
      }}
    >
      {theme === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    </button>
  )
}

// REQ_FE_129: starts the guided tour from its first step, on every page, logged in or not.
export function HelpButton() {
  const { start } = useTour()
  return (
    <button type="button" className="btn icon ghost" data-testid="help-tour" title="Take the tour" aria-label="Take the tour" onClick={start}>
      <HelpCircle size={17} aria-hidden="true" />
    </button>
  )
}

// App renders one slot above the session banners; a page's TopBar portals into it, so the bar stays first on screen
// while each page owns what is in it. Without a slot (a page rendered on its own, in tests) the bar renders in place.
export const TopBarSlot = createContext<HTMLElement | null>(null)

export type BarVariant = 'minimal' | 'team' | 'company' // REQ_FE_103 / 101 / 102

// The one top bar of every page (REQ_FE_101-103); nothing is rendered under it as a second toolbar.
//   minimal: logo, the two mode buttons, space, theme, account.
//   team:    logo, team selector, the two mode buttons, separator, `left`, space, `right`, separator, theme, account.
//   company: the same without the selector.
// `left` and `right` are the page's own controls (add buttons / the Order button; range, switches, export).
export function TopBar({ variant = 'minimal', teamName, left, right }: { variant?: BarVariant; teamName?: string; left?: ReactNode; right?: ReactNode }) {
  const minimal = variant === 'minimal'
  const slot = useContext(TopBarSlot)
  const bar = (
    <header className="topbar" data-testid="topbar" data-variant={variant}>
      {/* the icon is a picture, not a link */}
      <span className="logo" aria-hidden="true" data-testid="logo">
        <svg width="30" height="30" viewBox="0 0 32 32" fill="#fff">
          <rect x="5" y="7" width="12" height="4" rx="2" />
          <rect x="11" y="14" width="14" height="4" rx="2" opacity=".85" />
          <rect x="7" y="21" width="10" height="4" rx="2" opacity=".7" />
          <path d="M24 5.5l2.5 2.5-2.5 2.5L21.5 8z" />
        </svg>
      </span>
      {variant === 'team' && (
        <a href="#/teams" className="select no-underline" title="Switch team" data-testid="team-selector">
          <Users size={15} aria-hidden="true" />
          <span>{teamName}</span>
          <ChevronsUpDown size={14} aria-hidden="true" className="text-text-3" />
        </a>
      )}
      {/* REQ_FE_123: both mode buttons are always there; the one for the page you are on is highlighted. */}
      <a
        href="#/"
        className={`btn no-underline${variant === 'company' ? ' font-semibold bg-surface-2' : ''}`}
        data-testid="see-combined-roadmaps"
        title="See workstreams (all teams)"
        aria-label="See workstreams (all teams)"
        aria-current={variant === 'company' ? 'page' : undefined}
      >
        <Layers size={16} aria-hidden="true" />
        <span className="hidden min-[1440px]:inline">See workstreams (all teams)</span>
        <span className="min-[1440px]:hidden">All roadmaps</span>
      </a>
      <a
        href="#/teams"
        className={`btn no-underline${variant === 'team' ? ' font-semibold bg-surface-2' : ''}`}
        data-testid="see-team-roadmaps"
        title="Teams roadmaps"
        aria-label="Teams roadmaps"
        aria-current={variant === 'team' ? 'page' : undefined}
      >
        <Users size={16} aria-hidden="true" />
        <span className="hidden min-[1440px]:inline">Teams roadmaps</span>
        <span className="min-[1440px]:hidden">Team roadmaps</span>
      </a>
      {!minimal && <span className="sep" />}
      {left}
      <span className="spacer flex-1" />
      {right}
      {right && <span className="sep" />}
      <HelpButton />
      <ThemeToggle />
      <AccountControl />
    </header>
  )
  return slot ? createPortal(bar, slot) : bar
}

// Anonymous: a ghost "Log in to edit" button that opens the dialog (REQ_AUTH_005). Logged in: a chip with the user's
// initials and name opens a menu with "Admin" and "Log out" (REQ_AUTH_006; every account is an admin, REQ_AUTH_002).
// The menu closes on Escape (focus back on the chip) and on a click anywhere outside it. Below 1440px the login
// button shows its short form, "Log in" (REQ_FE_084).
export function AccountControl() {
  const { user, loading, openLogin, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      chip.current?.focus()
    }
    const onDown = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  if (loading) return null
  if (!user) {
    return (
      <button type="button" className="btn ghost" data-testid="login-button" title="Admin login" aria-label="Admin login" onClick={openLogin}>
        Admin login
      </button>
    )
  }
  return (
    <div className="relative" ref={wrap}>
      <button
        ref={chip}
        type="button"
        className="btn ghost"
        data-testid="account-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Signed in as ${user.username} — account menu`} // WCAG 2.5.3: the name contains the visible user name
        title={`Signed in as ${user.username} (${user.role}) — account menu`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="avatar" aria-hidden="true">
          {initials(user.username)}
        </span>
        <span className="font-medium">{user.username}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-40 bg-surface border border-border rounded shadow-md z-40 flex flex-col py-1"
        >
          <button
            type="button"
            role="menuitem"
            className="text-left px-3 py-1.5 hover:bg-surface-2"
            onClick={() => {
              setOpen(false)
              navigate('#/admin')
            }}
          >
            Admin
          </button>
          <button
            type="button"
            role="menuitem"
            className="text-left px-3 py-1.5 hover:bg-surface-2"
            onClick={() => {
              setOpen(false)
              void logout()
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  )
}

// Up to two letters: the first letters of the first two words of the name ("jane.doe" and "Jane Doe" -> "JD"),
// or its first two letters when it is one word.
function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

// REQ_AUTH_007: shown after a save was refused because the session ran out. Nothing the user typed is touched
// and nothing is resent: the button reopens the login dialog and the user saves again.
export function SessionBanner() {
  const { sessionEnded, authNotice, openLogin, dismissAuthNotice } = useAuth()
  // relative + z-[60]: the banners must stay clickable above any open dialog overlay (z-50), or a user with the full
  // edit window open could not reach "Log in" (REQ_AUTH_007)
  const cls = 'relative z-[60] flex items-center gap-3 px-4 py-2 text-sm border-b border-danger bg-danger-soft text-danger'
  return (
    <>
      {authNotice && (
        <div
          className={authNotice.kind === 'error' ? cls : 'relative z-[60] flex items-center gap-3 px-4 py-2 text-sm border-b border-border bg-surface-2 text-text'}
          role="alert"
          data-testid="auth-notice"
        >
          <span className="flex-1">{authNotice.text}</span>
          <button type="button" className={BTN} onClick={dismissAuthNotice}>
            Dismiss
          </button>
        </div>
      )}
      {sessionEnded && (
        <div className={cls} role="alert" data-testid="session-banner">
          <span className="flex-1">Your session ended — log in to save</span>
          <button type="button" className={BTN} onClick={openLogin}>
            Log in
          </button>
        </div>
      )}
    </>
  )
}
