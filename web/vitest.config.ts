import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// REQ_TEST_024: one timezone and one seed for the whole run. `make test` exports both; run directly,
// the seed is picked here; the zone is always Europe/Amsterdam, whatever the shell says. Both reach the workers through `test.env`.
process.env.TZ = 'Europe/Amsterdam'
process.env.TEST_SEED ||= String(Math.floor(Date.now() / 1000))

// jsdom: prefs.ts (REQ_FE_071/022) and component tests (Phase 3c) need `window`/`localStorage` and
// JSX transform — this config is separate from vite.config.mts (different extension), so the React
// plugin is registered here too.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
    globalSetup: ['./src/test-global-setup.ts'],
    env: { TZ: process.env.TZ, TEST_SEED: process.env.TEST_SEED },
  },
})
