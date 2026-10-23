import { rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

export default function globalTeardown() {
  const dir = process.env.ERM_E2E_DIR
  if (!dir) return
  const r = resolve(dir)
  // guard: only ever delete our own erm-test-* folder directly inside the system temp dir
  if (dirname(r) !== resolve(tmpdir()) || !basename(r).startsWith('erm-test-')) {
    throw new Error(`refusing to delete ${dir}: not an erm-test-* folder in the temp dir`)
  }
  rmSync(r, { recursive: true, force: true })
}
