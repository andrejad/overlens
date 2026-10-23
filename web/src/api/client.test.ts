import { describe, expect, it } from 'vitest'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { api, setSessionEndedHandler } from './client'

// Runs a request through the real instance (interceptors included) and returns what would be sent.
async function sent(method: 'get' | 'post' | 'delete' | 'patch', data?: unknown) {
  let seen: InternalAxiosRequestConfig | undefined
  await api.request({
    url: '/x',
    method,
    data,
    adapter: async (config) => {
      seen = config
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
    },
  })
  return seen as InternalAxiosRequestConfig
}

describe('REQ_API_003 every write carries Content-Type: application/json', () => {
  it('REQ_API_003 every write carries the JSON content type: bodiless ones send {}, a body is kept, FormData and null are not replaced, a GET is left alone', async () => {
    // a bodiless DELETE and a bodiless POST still send the JSON content type
    for (const method of ['delete', 'post'] as const) {
      const c = await sent(method)
      expect(c.headers.get('Content-Type'), `bodiless ${method}: content type`).toBe('application/json')
      expect(c.data, `bodiless ${method}: body`).toBe('{}')
    }

    // a write that has a body keeps it
    const patched = await sent('patch', { name: 'x' })
    expect(patched.headers.get('Content-Type'), 'write with a body: content type').toBe('application/json')
    expect(JSON.parse(patched.data as string), 'write with a body: body kept').toEqual({ name: 'x' })

    // a FormData body and an explicit null body are not replaced with {}
    const form = new FormData()
    const posted = await sent('post', form)
    expect(posted.data, 'FormData body is not replaced').toBe(form)
    expect((await sent('post', null)).data, 'explicit null body is not replaced with {}').not.toBe('{}')

    // a GET is left alone
    const got = await sent('get')
    expect(got.data, 'GET carries no body').toBeUndefined()
  })

  it('REQ_AUTH_007 a 401 from a write calls the session-ended handler and still rejects; the auth calls are exempt', async () => {
    const seen: string[] = []
    setSessionEndedHandler((cfg) => seen.push(cfg.url ?? ''))
    const fail = (url: string, status: number) =>
      api
        .request({
          url,
          method: 'patch',
          data: { a: 1 },
          adapter: async (config) => {
            throw new AxiosError('x', 'ERR_BAD_REQUEST', config, null, { status, statusText: '', headers: {}, config, data: {} })
          },
        })
        .then(() => 'ok', () => 'rejected')
    expect(await fail('/deliverables/1', 401)).toBe('rejected')
    expect(await fail('/login', 401)).toBe('rejected')
    expect(await fail('/me', 401)).toBe('rejected')
    expect(await fail('/deliverables/2', 409)).toBe('rejected')
    expect(seen).toEqual(['/deliverables/1'])
    setSessionEndedHandler(null)
  })
})
