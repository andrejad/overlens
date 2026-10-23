// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// REQ_OVR_009: no drag-and-drop library; all dragging is written with the browser's own pointer events.
describe('REQ_OVR_009 no drag-and-drop library', () => {
  it('REQ_OVR_009 web/package.json depends on none of the well-known drag-and-drop libraries', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })
    expect(deps.length).toBeGreaterThan(0) // the file was read
    const denied = [/^react-dnd(-.*)?$/, /^@dnd-kit\//, /^react-beautiful-dnd$/, /^@hello-pangea\/dnd$/, /^sortablejs$/, /^react-sortablejs$/, /^interactjs$/, /^@interactjs\//]
    expect(deps.filter((d) => denied.some((re) => re.test(d)))).toEqual([])
  })
})
