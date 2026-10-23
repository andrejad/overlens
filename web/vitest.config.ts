import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// jsdom: prefs.ts (REQ_FE_071/022) and component tests (Phase 3c) need `window`/`localStorage` and
// JSX transform — this config is separate from vite.config.mts (different extension), so the React
// plugin is registered here too.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
})
