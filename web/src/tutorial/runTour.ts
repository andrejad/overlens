import { driver, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import './tutorial.css'
import * as prefs from '../lib/prefs'
import { navigate } from '../lib/router'
import { FIRST_BAR, type TourRoute, type TourStep } from './steps'

// REQ_FE_128-134: the guided tour engine, driven by driver.js one highlighted element at a time. The tour opens pages
// itself and selects an item so the panel shows it; it never sends a write request and never submits a dialog
// (REQ_FE_132): the only things it does to the page are a hash change and a click on a bar or on "Trace dependencies".
const WAIT_MS = 2000

// Resolves with the first element matching `selector`, as soon as it is on the page, or null after `ms`.
function waitFor(selector: string, ms = WAIT_MS): Promise<Element | null> {
  return new Promise((resolve) => {
    const found = document.querySelector(selector)
    if (found) return resolve(found)
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) done(el)
    })
    const timer = window.setTimeout(() => done(null), ms)
    function done(el: Element | null) {
      obs.disconnect()
      window.clearTimeout(timer)
      resolve(el)
    }
    obs.observe(document.documentElement, { childList: true, subtree: true })
  })
}

// A page change or a click takes a moment to reach the DOM; looking for the target straight away could find the
// element of the page being replaced.
const settle = () => new Promise<void>((resolve) => window.setTimeout(resolve, 150))

const norm = (hash: string) => hash || '#/'

export interface Run {
  abort: () => void
}

// Runs one tour over `all` (already filtered for who is logged in). `onEnd` is called once when it ends.
export function runTour(all: TourStep[], resolveTeamId: () => Promise<number | null>, onEnd: () => void = () => undefined): Run {
  const startHash = norm(window.location.hash)
  const d: Driver = driver({
    animate: false,
    allowClose: true,
    allowKeyboardControl: true,
    disableActiveInteraction: true, // the highlighted element cannot be clicked through the tour (REQ_FE_132)
    overlayOpacity: 0.65,
    stagePadding: 6,
    popoverClass: 'erm-tour',
    onDestroyStarted: () => finish(true), // Esc and a click on the dimmed page
  })
  const shown: TourStep[] = []
  let idx = -1
  let cursor = 0 // next candidate in `all`
  let skipped = 0
  let seq = 0 // bumped on every move so a slow, stale one never draws
  let cleanup: (() => void) | undefined // removes what the shown step added
  let ended = false
  let watch: number | undefined

  async function routeHash(route: TourRoute): Promise<string | null> {
    if (route === 'company') return '#/'
    if (route === 'admin') return '#/admin'
    const id = await resolveTeamId()
    return id === null ? null : `#/teams/${id}`
  }

  // Opens the page, selects what the step needs and waits for its element; el null means "not on the page" (REQ_FE_133).
  // `live()` turns false once the user moved on or the tour ended: a stale call then stops before it navigates, clicks
  // or adds anything (REQ_FE_134). `undo` removes only what this call added.
  async function prepare(s: TourStep, live: () => boolean): Promise<{ el: Element | null; undo: () => void }> {
    const none = { el: null, undo: () => undefined }
    if (s.route) {
      const want = await routeHash(s.route)
      if (want === null || !live()) return none
      if (norm(window.location.hash) !== want) {
        navigate(want)
        await settle()
        if (!live()) return none
      }
    }
    if (s.select) {
      const bar = await waitFor(FIRST_BAR)
      if (!bar || !live()) return none
      ;(bar as HTMLElement).click() // selection only: opens the side panel
      await settle()
      if (!live()) return none
    }
    const added = await s.before?.()
    const undo = () => {
      if (typeof added === 'function') added()
    }
    if (added) await settle()
    const el = await waitFor(s.target)
    if (!live()) {
      undo()
      return none
    }
    return { el, undo }
  }

  function undo() {
    window.clearInterval(watch)
    cleanup?.()
    cleanup = undefined
  }

  // dir 1: next, -1: back. Steps already shown are revisited; new ones are tried in order and dropped when absent.
  async function go(dir: 1 | -1) {
    const mine = ++seq
    undo()
    let i = idx
    for (;;) {
      i += dir
      if (i < 0) return
      if (i >= shown.length) {
        if (cursor >= all.length) return finish(true)
        shown.push(all[cursor++])
      }
      const s = shown[i]
      const r = await prepare(s, () => mine === seq && !ended)
      if (mine !== seq || ended) return
      if (r.el) {
        idx = i
        cleanup = r.undo
        return display(s, r.el)
      }
      console.info('tour.step_skipped', { id: s.id })
      r.undo()
      shown.splice(i, 1)
      skipped++
      if (dir === 1) i-- // the next step slid into this place
    }
  }

  function display(s: TourStep, el: Element) {
    // The page may draw the element again after it was found (it finishes loading, a view re-renders): follow it.
    window.clearInterval(watch)
    watch = window.setInterval(() => {
      if (el.isConnected) return
      const now = document.querySelector(s.target)
      if (now) display(s, now)
    }, 200)
    const total = all.length - skipped
    const last = idx === shown.length - 1 && cursor >= all.length
    // driver.js only clears the previous element's marks once its slide has finished; a quick Next would leave them behind
    document.querySelectorAll('.driver-active-element').forEach((e) => e.classList.remove('driver-active-element', 'driver-no-interaction'))
    d.highlight({
      element: el,
      popover: {
        title: s.title,
        description: s.body,
        side: 'bottom',
        align: 'start',
        showButtons: ['previous', 'next', 'close'],
        disableButtons: idx === 0 ? ['previous'] : [],
        showProgress: true,
        progressText: `${idx + 1} of ${total}`,
        prevBtnText: 'Back',
        nextBtnText: last ? 'Done' : 'Next',
        onNextClick: () => (last ? finish(true) : void go(1)),
        onPrevClick: () => void go(-1),
        onCloseClick: () => finish(true),
        onPopoverRender: (p) => {
          p.closeButton.textContent = 'Skip'
          p.closeButton.setAttribute('aria-label', 'Skip the tour')
        },
      },
    })
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') void go(1)
    else if (e.key === 'ArrowLeft' && idx > 0) void go(-1)
  }

  // REQ_FE_130 / REQ_FE_134: however it ends, it counts as seen and the app is back where the tour started.
  function finish(seen: boolean) {
    if (ended) return
    ended = true
    seq++
    undo()
    window.removeEventListener('keydown', onKey)
    d.destroy()
    if (seen) {
      prefs.setTutorialSeen()
      if (norm(window.location.hash) !== startHash) navigate(startHash)
    }
    console.info('tour.end', { shown: shown.length, skipped })
    onEnd()
  }

  console.info('tour.start', { steps: all.length })
  window.addEventListener('keydown', onKey)
  void go(1)
  return { abort: () => finish(false) }
}

