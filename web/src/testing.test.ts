import { describe, expect, it } from 'vitest'
import { visibleBoxes } from '../e2e/visibility'

// REQ_TEST_013: the measuring helper decides by computed visibility, not the `hidden` attribute.
describe('REQ_TEST_013 visibility filter', () => {
  const box = { width: 10, height: 10 }
  it('REQ_TEST_013 skips display:none and empty boxes even without a hidden attribute', () => {
    const items = [
      { label: 'shown', display: 'flex', visibility: 'visible', ...box },
      { label: 'display-none', display: 'none', visibility: 'visible', ...box },
      { label: 'empty', display: 'flex', visibility: 'visible', width: 0, height: 10 },
      { label: 'invisible', display: 'flex', visibility: 'hidden', ...box },
    ]
    expect(visibleBoxes(items).map((i) => i.label)).toEqual(['shown'])
  })
})
