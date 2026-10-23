// REQ_FE_087: `VITE_API_URL` resolves with `??`, never `||`. An *empty string* is a deliberate,
// valid value — "call the same origin that served this page" — and `||` treats an empty string as
// falsy, silently replacing it with the fallback; `??` only falls back when the value is genuinely
// unset (`undefined`). Pulled out as a pure function so the `??` behavior itself is unit-testable
// without depending on Vite's env injection.
export function resolveApiBaseURL(envValue: string | undefined): string {
  return envValue ?? ''
}
