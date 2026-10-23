// Scratch directory for the E2E run (REQ_TEST_005/007). The app server started by webServer
// (e2e/start-server.sh) gets its database inside this directory; teardown removes only this
// directory.
//
// Playwright starts webServer *before* running this globalSetup (its plugin-setup tasks, which
// include webServer, precede the user's globalSetup task — see node_modules/playwright/lib/runner),
// so this can't mint the directory itself and expect the already-started server to use it. Instead
// start-server.sh creates it and writes its path to a sentinel file; by the time globalSetup runs,
// webServer's own setup (including its health-check wait) has already resolved, so the sentinel is
// guaranteed to be there.
//
// Auth (Phase 6): globalSetup also logs in once as the bootstrap admin (e2e-admin, set in
// start-server.sh), shares the session cookie with the workers via ERM_E2E_ADMIN_COOKIE (builders.ts)
// and writes a Playwright storageState file so the real-app browser projects start out logged in.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN_PASSWORD, ADMIN_STATE, ADMIN_USER, ANON_STATE, login } from './builders'

// REQ_FE_130: the guided tour opens by itself on a first visit; every browser test starts with it already seen
// (the tour's own spec starts it with the Help button). ANON_STATE is the default for projects without a login.
const SEEN_ORIGIN = (baseURL: string) => ({ origin: new URL(baseURL).origin, localStorage: [{ name: 'erm.tutorialSeen', value: 'true' }] })

export default async function globalSetup(config: { projects: { use: { baseURL?: string } }[] }) {
  process.env.LOG_PREFIX = 'test'
  const sentinel = join(process.cwd(), '.e2e-tmp', 'dir')
  process.env.ERM_E2E_DIR = readFileSync(sentinel, 'utf8').trim()

  const baseURL = config.projects[0].use.baseURL!
  const cookie = await login(baseURL, ADMIN_USER, ADMIN_PASSWORD)
  process.env.ERM_E2E_ADMIN_COOKIE = cookie
  writeFileSync(
    ADMIN_STATE,
    JSON.stringify({
      cookies: [{ name: 'session', value: cookie.slice('session='.length), domain: new URL(baseURL).hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
      origins: [SEEN_ORIGIN(baseURL)],
    }),
  )
  writeFileSync(ANON_STATE, JSON.stringify({ cookies: [], origins: [SEEN_ORIGIN(baseURL)] }))
}
