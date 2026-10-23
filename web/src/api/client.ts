import axios, { type InternalAxiosRequestConfig } from 'axios'
import { resolveApiBaseURL } from './base'

// REQ_FE_087: `??`, never `||` — see base.ts for why.
const baseURL = resolveApiBaseURL(import.meta.env.VITE_API_URL)

// The one axios instance every real API call goes through (REQ_OVR_007).
export const api = axios.create({ baseURL: `${baseURL}/api` })

// REQ_API_003: the server wants `Content-Type: application/json` on every write, even one with no body,
// but axios drops that header when there is no data (a bodiless DELETE/POST then gets 415) — so every
// write carries an empty JSON object when the caller has nothing to send.
api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toLowerCase()
  if (method !== 'get' && method !== 'head' && config.data === undefined) {
    config.data = {}
    config.headers.set('Content-Type', 'application/json')
  }
  return config
})

// REQ_AUTH_007: a 401 from anything except the auth calls themselves means the session ran out. The
// error still propagates (callers keep their form state and show their own message); the registered
// handler additionally lets the app shell show the "log in to save" banner and remember the request.
const AUTH_PATHS = ['/login', '/logout', '/me']
type SessionEndedHandler = (failed: InternalAxiosRequestConfig) => void
let sessionEnded: SessionEndedHandler | null = null

export function setSessionEndedHandler(h: SessionEndedHandler | null): void {
  sessionEnded = h
}

api.interceptors.response.use(
  (r) => r,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401 && error.config) {
      const url = error.config.url ?? ''
      if (!AUTH_PATHS.includes(url)) sessionEnded?.(error.config)
    }
    return Promise.reject(error)
  },
)
