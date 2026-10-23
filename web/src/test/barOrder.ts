import { screen } from '@testing-library/react'

// Test helper: every element matching the given CSS selectors in the top bar (each `.sep` counts), in document order (REQ_FE_101-103 control order).
export function barOrder(selectors: string[]): string[] {
  const bar = screen.getByTestId('topbar')
  return selectors
    .flatMap((sel) => Array.from(bar.querySelectorAll(sel)).map((el) => ({ sel, el })))
    .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((x) => x.sel)
}

export const T = (id: string) => `[data-testid="${id}"]`
export const ALL_BAR_CONTROLS = [
  T('logo'),
  T('app-name'),
  T('team-selector'),
  T('see-team-roadmaps'),
  T('see-combined-roadmaps'),
  '.sep',
  T('add-workstream'),
  T('add-deliverable'),
  T('add-milestone'),
  T('order-button'),
  '.spacer',
  T('range'),
  T('sw-copies'),
  T('sw-deps'),
  T('download-csv'),
  T('theme-toggle'),
  T('login-button'),
  T('account-menu'),
]
