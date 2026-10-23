import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// vitest.config.ts doesn't enable `test.globals`, so @testing-library/react's own auto-cleanup
// (which detects a global `afterEach`) never registers — wire it explicitly so every test starts
// from an empty document.
afterEach(cleanup)
