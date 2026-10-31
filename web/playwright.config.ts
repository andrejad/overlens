import { defineConfig } from '@playwright/test'
import { ADMIN_STATE, ANON_STATE } from './e2e/builders'

const port = Number(process.env.ERM_E2E_PORT ?? 8130)
const baseURL = `http://127.0.0.1:${port}`

// REQ_TEST_003/012: the no-overlap project runs first; every other project depends on it, so a
// failure there stops the rest of the suite. `webServer` builds and runs the real Go binary
// (e2e/start-server.sh) against its own fresh scratch database, never the dev/production one
// (REQ_TEST_005/006) — see e2e/global-setup.ts for why the script mints that directory itself
// rather than reading ERM_E2E_DIR (webServer starts before globalSetup runs). 01-no-overlap.spec.ts measures only the
// real app (team roadmap, company view, trace), never the wireframes. The server runs without the sample company
// (OVERLENS_SAMPLE_DATA=false, REQ_TEST_020). Every spec file belongs to exactly one project (checked by
// src/playwright-ordering.test.ts).
// Auth (Phase 6): the real server enforces sessions, so global-setup.ts logs in as the bootstrap admin
// and writes a storageState file; the browser projects that edit (core, copies, dependencies) use it and
// start logged in. `rest` is logged in too, and
// `readonly-ui` (06-readonly-ui, REQ_FE_083 / REQ_DEP_020) deliberately has NO storageState: it
// checks what an anonymous visitor sees. Run it alone with `npx playwright test --grep REQ_FE_083 --no-deps`.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  reporter: 'list',
  workers: 1,
  webServer: {
    command: 'bash e2e/start-server.sh',
    url: `${baseURL}/health`,
    reuseExistingServer: false, // each run gets a fresh server tied to its own fresh ERM_E2E_DIR
    timeout: 120_000,
  },
  use: {
    baseURL,
    storageState: ANON_STATE, // projects that log in override this with ADMIN_STATE
    ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}),
  },
  projects: [
    { name: 'core-no-overlap', testMatch: /01-no-overlap\.spec\.ts/, use: { storageState: ADMIN_STATE } },
    { name: 'core-copies-off', testMatch: /02-copies-off\.spec\.ts/, dependencies: ['core-no-overlap'], use: { storageState: ADMIN_STATE } },
    { name: 'dependencies', testMatch: /03-dependencies\.spec\.ts/, dependencies: ['core-copies-off'], use: { storageState: ADMIN_STATE } },
    // `rest` is logged in (04-prefs-and-copies is a browser spec that edits).
    { name: 'rest', testIgnore: [/0[123]-.*\.spec\.ts/, /0[5-8]-.*\.spec\.ts/, /(09|12|13|14|15|16|17|18|19|20|21|23)-.*\.spec\.ts/], dependencies: ['core-copies-off'], use: { storageState: ADMIN_STATE } },
    { name: 'readonly-ui', testMatch: /06-readonly-ui\.spec\.ts/, dependencies: ['core-copies-off'] },
    // Real-browser Phase 6 UI. Login-ui starts anonymous (no storageState); admin-ui is logged in as e2e-admin.
    // Both depend on readonly-ui.
    { name: 'admin-ui', testMatch: /08-admin-ui\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    { name: 'login-ui', testMatch: /07-login-ui\.spec\.ts/, dependencies: ['readonly-ui'] },
    // Phase 7 company views (09): logged in as e2e-admin, depends on readonly-ui only and sits at the same dependency
    // level as admin-ui.
    { name: 'company-ui', testMatch: /09-company-views\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Phase 9 milestone dependencies (12): logged in as e2e-admin; the read-only test inside overrides it to anonymous.
    { name: 'milestone-deps-ui', testMatch: /12-milestone-dependencies\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Improvements 10a add buttons, zoom row and teams card (13): logged in as e2e-admin.
    { name: 'top-bar-ui', testMatch: /13-top-bar\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Improvements 10c Manage workstreams page (14): logged in as e2e-admin.
    { name: 'manage-workstreams-ui', testMatch: /14-manage-workstreams\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Improvements 10b move a deliverable to another team (15): logged in as e2e-admin.
    { name: 'move-deliverable-ui', testMatch: /15-move-deliverable\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Improvements 10b/10c side panel layout, drag, scrolling and themes (16): logged in as e2e-admin.
    { name: 'side-panel-ui', testMatch: /16-side-panel\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Improvements 11 move a milestone to another team (17): logged in as e2e-admin.
    { name: 'move-milestone-ui', testMatch: /17-move-milestone\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Improvements 11 delete a deliverable from the panel and the edit window (18): logged in as e2e-admin.
    { name: 'delete-deliverable-ui', testMatch: /18-delete-deliverable\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Improvements 11 milestone panel: per-field edit (19): logged in as e2e-admin.
    { name: 'milestone-panel-ui', testMatch: /19-milestone-panel\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // Milestone status icon on every screen, milestones edited on a company view (20): logged in as e2e-admin; the read-only part uses its own anonymous context.
    { name: 'milestone-status-ui', testMatch: /20-milestone-status\.spec\.ts/, dependencies: ['readonly-ui'], use: { storageState: ADMIN_STATE } },
    // The hard drag rules with real mouse drags (21): REQ_FE_012/014/015/016, logged in as e2e-admin. Depends on the core projects.
    { name: 'drag-rules-ui', testMatch: /21-drag-rules\.spec\.ts/, dependencies: ['core-copies-off'], use: { storageState: ADMIN_STATE } },
    // The guided tour (23): REQ_FE_128-134, run logged out and logged in (the test picks its own login).
    { name: 'tour-ui', testMatch: /23-tour\.spec\.ts/, dependencies: ['readonly-ui'] },
  ],
})
