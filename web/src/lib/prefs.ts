// Typed localStorage wrapper, one key per preference, each independently gettable/settable
// (REQ_FE_071/022/023). Every access is wrapped in try/catch: a private browsing tab or a browser
// with storage blocked must not crash the app, it just behaves as if nothing were remembered yet.

export type Zoom = 'year' | 'half' | 'quarter' | 'month'
export type Theme = 'light' | 'dark'

const KEYS = {
  zoom: 'erm.zoom',
  panelWidth: 'erm.panelWidth',
  panelOpen: 'erm.panelOpen',
  theme: 'erm.theme',
  copies: 'erm.copies',
  dependencies: 'erm.dependencies',
  tutorialSeen: 'erm.tutorialSeen',
} as const

function get(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function set(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // storage unavailable (private browsing, quota, blocked) — silently keep going unsaved
  }
}

export function getZoom(): Zoom | null {
  const v = get(KEYS.zoom)
  return v === 'year' || v === 'half' || v === 'quarter' || v === 'month' ? v : null
}
export function setZoom(v: Zoom): void {
  set(KEYS.zoom, v)
}

export function getPanelWidth(): number | null {
  const v = get(KEYS.panelWidth)
  const n = v === null ? NaN : Number(v)
  return Number.isFinite(n) ? n : null
}
export function setPanelWidth(px: number): void {
  set(KEYS.panelWidth, String(px))
}

export function getPanelOpen(): boolean | null {
  const v = get(KEYS.panelOpen)
  return v === null ? null : v === 'true'
}
export function setPanelOpen(open: boolean): void {
  set(KEYS.panelOpen, String(open))
}

export function getTheme(): Theme | null {
  const v = get(KEYS.theme)
  return v === 'light' || v === 'dark' ? v : null
}
export function setTheme(v: Theme): void {
  set(KEYS.theme, v)
}

export function getCopiesVisible(): boolean | null {
  const v = get(KEYS.copies)
  return v === null ? null : v === 'true'
}
export function setCopiesVisible(visible: boolean): void {
  set(KEYS.copies, String(visible))
}

export function getDependenciesVisible(): boolean | null {
  const v = get(KEYS.dependencies)
  return v === null ? null : v === 'true'
}
export function setDependenciesVisible(visible: boolean): void {
  set(KEYS.dependencies, String(visible))
}

// REQ_FE_130: set once the guided tour has been finished, skipped or closed with Esc in this browser.
export function getTutorialSeen(): boolean {
  return get(KEYS.tutorialSeen) === 'true'
}
export function setTutorialSeen(): void {
  set(KEYS.tutorialSeen, 'true')
}

// REQ_FE_104: the saved theme (default light) is put on <html data-theme> — index.css styles `:root[data-theme="dark"]`.
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
}
export function initTheme(): Theme {
  const stored = getTheme()
  const theme = stored ?? 'light'
  applyTheme(theme)
  return theme
}
