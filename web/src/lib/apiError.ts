import { CAP_MESSAGE } from '../timeline/axis'

// Reads docs/API.md's one error shape — { error: { code, message, fields? } } — off an axios error.
export interface ApiErrorInfo {
  status?: number
  code?: string
  message?: string
  fields?: Record<string, string>
}

export function apiError(err: unknown): ApiErrorInfo {
  const r = (err as { response?: { status?: number; data?: { error?: Omit<ApiErrorInfo, 'status'> } } })?.response
  const e = r?.data?.error
  return { status: r?.status, code: e?.code, message: e?.message, fields: e?.fields }
}

// The message to show for a refused write: the server's own, except that a refusal for the 3-year span
// (409 span_exceeded) always reads REQ_FE_062's message. Undefined when the error carries no message.
export function refusalMessage(err: unknown): string | undefined {
  const e = apiError(err)
  return e.code === 'span_exceeded' ? CAP_MESSAGE : e.message
}

// REQ_AUTH_007: a save refused because the session ran out (401) keeps the typed value and says so under the field.
export const NOT_SAVED_LOGIN = 'Not saved — log in and save again'

export function sessionRefusal(err: unknown): string | null {
  return apiError(err).status === 401 ? NOT_SAVED_LOGIN : null
}

// Local date-time for a server RFC 3339 timestamp, e.g. "2026-09-21 20:14"; the raw text if unparseable.
export function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
