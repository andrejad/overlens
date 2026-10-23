import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as prefs from './prefs'
import { step } from '../testSteps'

describe('REQ_FE_071 prefs', () => {
  beforeEach(() => window.localStorage.clear())

  it('REQ_FE_071 each preference is stored under its own key, independently of the others; the copies and dependency toggles are remembered independently of zoom/panel/theme', async () => {
    await step('each preference is stored under its own key, independently of the others', () => {
      prefs.setZoom('quarter')
      prefs.setPanelWidth(400)
      prefs.setPanelOpen(false)
      prefs.setTheme('dark')

      expect(prefs.getZoom()).toBe('quarter')
      expect(prefs.getPanelWidth()).toBe(400)
      expect(prefs.getPanelOpen()).toBe(false)
      expect(prefs.getTheme()).toBe('dark')

      // changing one doesn't touch the others
      prefs.setZoom('month')
      expect(prefs.getZoom()).toBe('month')
      expect(prefs.getPanelWidth()).toBe(400)
      expect(prefs.getPanelOpen()).toBe(false)
      expect(prefs.getTheme()).toBe('dark')
    })

    await step('copies and dependency toggles are remembered independently of zoom/panel/theme', () => {
      window.localStorage.clear()
      prefs.setCopiesVisible(false)
      prefs.setDependenciesVisible(true)
      expect(prefs.getCopiesVisible()).toBe(false)
      expect(prefs.getDependenciesVisible()).toBe(true)
      expect(prefs.getZoom()).toBeNull()
    })
  })
})

describe('REQ_FE_022 prefs survive a broken localStorage', () => {
  it('REQ_FE_022 get/set never throw when localStorage.getItem/setItem throw', () => {
    const getSpy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const setSpy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(() => prefs.setPanelWidth(500)).not.toThrow()
    expect(() => prefs.getPanelWidth()).not.toThrow()
    expect(prefs.getPanelWidth()).toBeNull()

    getSpy.mockRestore()
    setSpy.mockRestore()
  })
})
