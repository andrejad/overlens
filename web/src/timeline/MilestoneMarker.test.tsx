// The at-risk outline (REQ_FE_040) is drawn only as far as the room geometry.ts kept clear for it (REQ_FE_010).

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DIAMOND, RING, RING_MIN } from './geometry'
import { MilestoneMarker } from './MilestoneMarker'

function ringPoints(ring: number): number[][] | null {
  const html = renderToStaticMarkup(<MilestoneMarker status="at_risk" width={DIAMOND} ring={ring} />)
  const m = html.match(/<polygon class="risk-ring" points="([^"]+)"/)
  return m ? m[1].split(' ').map((p) => p.split(',').map(Number)) : null
}

describe('REQ_FE_040 REQ_FE_010 the at-risk outline stays inside the room kept for it', () => {
  it('REQ_FE_040 REQ_FE_010 the outline (its centre line plus half the 2px line) reaches no further than `ring` px, and keeps 2px or more clear of the diamond, for every room it is drawn in', () => {
    for (const ring of [RING_MIN, 4.5, 5, 5.5, RING]) {
      const pts = ringPoints(ring)!
      const right = Math.max(...pts.map((p) => p[0])) - DIAMOND // beyond the diamond's right tip
      const left = -Math.min(...pts.map((p) => p[0]))
      expect(right + 1, `ring ${ring}`).toBeLessThanOrEqual(ring + 1e-9)
      expect(left + 1, `ring ${ring}`).toBeLessThanOrEqual(ring + 1e-9)
      expect(right - 1, `ring ${ring}: the line's inner edge is clear of the tip`).toBeGreaterThanOrEqual(2 - 1e-9)
    }
  })

  it('REQ_FE_040 the full outline is 5px beyond the tips, and none is drawn under RING_MIN or for other statuses', () => {
    expect(Math.max(...ringPoints(RING)!.map((p) => p[0])) - DIAMOND).toBe(5)
    expect(ringPoints(RING_MIN - 0.1)).toBeNull()
    expect(ringPoints(0)).toBeNull()
    for (const status of ['planned', 'in_progress', 'done'] as const)
      expect(renderToStaticMarkup(<MilestoneMarker status={status} width={DIAMOND} ring={RING} />)).not.toContain('risk-ring')
  })
})
