import { describe, expect, it } from 'vitest'
import { contrastRatio, fgOf } from './contrast'
import { step } from '../testSteps'

// REQ_FE_082: the text colour on a deliverable is computed from its (user-chosen) background and meets WCAG AA (4.5:1).
const samples = [
  '#000000', '#ffffff', '#808080', '#777777', '#767676', '#2f6bd7', '#e53935', '#43a047', '#fdd835', '#ff9800',
  '#9c27b0', '#00bcd4', '#795548', '#ffeb3b', '#1a237e', '#f5f5f5', '#0f0f0f', '#ff00ff', '#00ff00', '#ffff00',
]

describe('REQ_FE_082 text colour contrast', () => {
  it('REQ_FE_082 holds on the named sample colours and on a coarse sweep of the whole colour cube', () => {
    for (const bg of samples) expect(contrastRatio(bg, fgOf(bg)), `sample ${bg}`).toBeGreaterThanOrEqual(4.5)
    const steps = [0, 51, 102, 128, 153, 204, 255]
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    for (const r of steps) for (const g of steps) for (const b of steps) {
      const bg = `#${hex(r)}${hex(g)}${hex(b)}`
      expect(contrastRatio(bg, fgOf(bg)), bg).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('REQ_FE_082 the contrast ratio is the WCAG one (21:1 black on white, 1:1 same colour); it picks dark text on light backgrounds and light text on dark ones', async () => {
    await step('the contrast ratio is the WCAG one (21:1 black on white, 1:1 same colour)', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
      expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5)
    })

    await step('picks dark text on light backgrounds and light text on dark ones', () => {
      expect(fgOf('#ffffff')).not.toBe('#ffffff')
      expect(fgOf('#000000')).toBe('#ffffff')
    })
  })
})
