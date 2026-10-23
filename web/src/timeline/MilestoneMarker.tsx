// A milestone's diamond, which shows its status itself (REQ_FE_040/042): planned yellow with a black dashed outline,
// in progress the accent colour with a dot, done green with a check, at risk a plain red diamond with a white "!"
// and a red outline around it. It fills the `width` × DIAMOND box geometry.ts gives it (narrower only where the row
// has no room). The at-risk outline is drawn outside that box (the svg overflows it), so packing, the connector dots
// and the arrows keep one size; `ring` is the room geometry.ts kept clear for it. The outline reaches `ring` px at
// most (its line's centre is 5px beyond the tips, minus what the room lacks; rounded corners add only the half line),
// and is left out under RING_MIN. It is only drawn at full size (ring > 0 means the stretch holds the whole diamond).

import type { Status } from '../api/types'
import { STATUS } from '../lib/status'
import { DIAMOND, RING_MIN } from './geometry'

const pts = (s: number, i: number) => `${s / 2},${i} ${s - i},${s / 2} ${s / 2},${s - i} ${i},${s / 2}`

export function MilestoneMarker({ status, width, ring = 0 }: { status: Status; width: number; ring?: number }) {
  const s = DIAMOND, h = s / 2
  const ex = Math.min(5, ring - 1) // the outline's line is 5px beyond the diamond's tips, less where there is less room (1px is the half line)
  return (
    <svg width={width} height={s} viewBox={`0 0 ${s} ${s}`} preserveAspectRatio="none" role="img" aria-label={STATUS[status].label}>
      {status === 'planned' && <polygon points={pts(s, 1.2)} fill="#facc15" stroke="#000" strokeWidth="1.6" strokeDasharray="3 2.2" />}
      {status === 'in_progress' && (
        <>
          <polygon points={pts(s, 0.5)} fill="var(--accent)" />
          <circle cx={h} cy={h} r="3.2" fill="var(--accent-text)" />
        </>
      )}
      {status === 'done' && (
        <>
          <polygon points={pts(s, 0.5)} fill="var(--ok)" />
          <path className="ok-glyph" d={`M${h - 4.2} ${h + 0.2} l2.8 2.8 l5.6 -5.6`} fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === 'at_risk' && (
        <>
          <polygon points={pts(s, 0)} fill="var(--milestone)" />
          <rect x={h - 1.1} y={h - 5.5} width="2.2" height="7" rx="1.1" fill="#fff" />
          <circle cx={h} cy={h + 4.3} r="1.25" fill="#fff" />
          {ring >= RING_MIN && (
            <polygon className="risk-ring" points={`${h},${h - 16} ${h + 11 + ex},${h} ${h},${h + 16} ${h - 11 - ex},${h}`} fill="none" stroke="var(--milestone)" strokeWidth="2" strokeLinejoin="round" />
          )}
        </>
      )}
    </svg>
  )
}
