import { createContext, useContext, type ReactNode } from 'react'

// Open question B (CONTRACT.md): a stub that is admin-true until Phase 6 wires real auth/sessions.
// Every edit affordance (rename, add-workstream, panel edit controls, 3-dot button, create button)
// reads this hook so Phase 6 only has to swap the provider's value for a real session check, not add
// new gating logic (REQ_FE_083: anonymous visitors get no edit affordances).
const CanEditContext = createContext<boolean>(true)

export function CanEditProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <CanEditContext.Provider value={value}>{children}</CanEditContext.Provider>
}

export function useCanEdit(): boolean {
  return useContext(CanEditContext)
}
