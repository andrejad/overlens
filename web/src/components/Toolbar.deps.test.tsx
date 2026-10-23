import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { Toolbar } from './Toolbar'
import * as prefs from '../lib/prefs'
import { step } from '../testSteps'
import type { RoadmapFull } from '../api/types'

vi.mock('../api/resources')

const roadmap: RoadmapFull = {
  id: 1, team_id: 1, title: 'Plan', range_start: null, range_end: null,
  created_at: '', updated_at: '',
  team: { id: 1, name: 'Team', tag: 'TST', default_color: '#4f6bd8', roadmap_id: 1, created_at: '' },
  workstreams: [], deliverables: [], milestones: [], dependencies: [],
}

const base = { roadmap }

describe('REQ_DEP_013 dependencies toolbar toggle', () => {
  beforeEach(() => window.localStorage.clear())

  it('REQ_DEP_013 is labelled with the action a click performs and persists the choice', () => {
    const onDepsChange = vi.fn()
    const { rerender } = render(<Toolbar {...base} depsOn={false} onDepsChange={onDepsChange} />)
    const sw = document.getElementById('sw-deps')!
    expect(sw).toHaveTextContent('Show dependencies')
    fireEvent.click(sw)
    expect(onDepsChange).toHaveBeenCalledWith(true)
    expect(prefs.getDependenciesVisible()).toBe(true)
    rerender(<Toolbar {...base} depsOn={true} onDepsChange={onDepsChange} dupsOn={false} />)
    expect(document.getElementById('sw-deps')).toHaveTextContent('Hide dependencies')
  })
})

describe('REQ_DEP_014 copies toggle while dependencies are on', () => {
  beforeEach(() => window.localStorage.clear())

  it('REQ_DEP_014 is disabled, stays "Show copies", explains why and ignores clicks while dependencies are on, and is a normal working switch while they are off', async () => {
    await step('dependencies on: disabled, normal label, tooltip, ignores clicks', () => {
      const onDupsChange = vi.fn()
      render(<Toolbar {...base} depsOn={true} dupsOn={false} onDupsChange={onDupsChange} />)
      const copies = document.getElementById('sw-copies')!
      expect(copies).toHaveAttribute('aria-disabled', 'true')
      expect(copies).toHaveAttribute('aria-checked', 'false')
      expect(copies).toHaveTextContent('Show copies')
      expect(copies.getAttribute('title')).toMatch(/locked while arrows are on/)
      fireEvent.click(copies)
      expect(onDupsChange).not.toHaveBeenCalled()
    })
    cleanup()
    await step('dependencies off: a normal working switch', () => {
      const onDupsChange = vi.fn()
      render(<Toolbar {...base} depsOn={false} dupsOn={true} onDupsChange={onDupsChange} />)
      const copies = document.getElementById('sw-copies')!
      expect(copies).not.toHaveAttribute('aria-disabled')
      fireEvent.click(copies)
      expect(onDupsChange).toHaveBeenCalledWith(false)
    })
  })
})
