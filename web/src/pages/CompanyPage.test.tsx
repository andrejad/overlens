import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import { CompanyPage } from './CompanyPage'
import * as resources from '../api/resources'
import { CanEditProvider } from '../lib/canEdit'
import { companyFixture } from '../lib/companyFixtures'
import { companyGrid } from '../timeline/company'
import { localDay } from '../timeline/axis'
import type { CompanyTeam, CompanyTrace, Deliverable, Milestone } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')
vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }))

// A stub Timeline carrying the props the page passes (timeline/CONTRACT.md "Company view"): a button per roadmap item
// with the tag the page passed (REQ_FE_054), and data attributes for the grid, the merged view and the layout callbacks
// (REQ_FE_096: the page passes none). The real canvas is covered by timeline/Timeline.company.test.tsx and the
// read-only layout with the real Timeline by CompanyPage.readonly.test.tsx.
vi.mock('../timeline/Timeline', () => ({
  Timeline: (props: {
    roadmap: { id: number; deliverables: Deliverable[]; milestones: Milestone[]; workstreams: { name: string }[] }
    teamTags?: ReadonlyMap<number, string>
    sharedGrid?: { start: number; days: number }
    merged?: unknown
    canEdit: boolean
    onSelect: (id: number, type: 'deliverable' | 'milestone') => void
    onPatchDeliverable?: unknown
    onPatchMilestone?: unknown
    onCreateDependency?: unknown
    onDeleteDependency?: unknown
  }) => (
    <div
      data-testid="tl"
      data-can-edit={String(props.canEdit)}
      data-layout-callbacks={String(!!(props.onPatchDeliverable || props.onPatchMilestone || props.onCreateDependency || props.onDeleteDependency))}
      data-grid={props.sharedGrid ? `${props.sharedGrid.start}+${props.sharedGrid.days}` : ''}
      data-merged={String(!!props.merged)}
    >
      <span data-testid="tl-ws">{props.roadmap.workstreams.map((w) => w.name).join('|')}</span>
      {props.roadmap.deliverables.map((d) => (
        <button key={d.id} data-testid={`bar-${d.id}`} data-tag={props.teamTags?.get(d.id) ?? ''} onClick={() => props.onSelect(d.id, 'deliverable')}>
          {d.name}
        </button>
      ))}
      {props.roadmap.milestones.map((m) => (
        <button key={`m${m.id}`} data-testid={`ms-${m.id}`} onClick={() => props.onSelect(m.id, 'milestone')}>
          {m.name}
        </button>
      ))}
    </div>
  ),
}))

function renderPage(ui: React.ReactElement, canEdit = true) {
  return render(<CanEditProvider value={canEdit}>{ui}</CanEditProvider>)
}

// A promise settled by hand, to decide the order in which responses arrive.
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
const flush = () => act(async () => { await Promise.resolve() })
const rowNames = () => (screen.getByTestId('tl-ws').textContent ?? '').split('|').filter(Boolean)

// Edits go through the side panel (REQ_FE_096): select the item, then the panel's Edit.
function openPanelEdit(testId: string) {
  fireEvent.click(screen.getByTestId(testId))
  fireEvent.click(within(screen.getByTestId('side-panel')).getByRole('button', { name: 'Edit' }))
}
const setStatus = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }))

// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function fresh() {
  cleanup()
  vi.resetAllMocks()
  window.localStorage.clear()
  window.location.hash = '#/company/workstreams'
  vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(companyFixture())
  vi.mocked(resources.fetchIcons).mockResolvedValue([])
  vi.mocked(resources.fetchWorkstreamOrder).mockResolvedValue([])
  vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
}
beforeEach(fresh)

const d = (id: number) => ({ kind: 'deliverable' as const, id })
const traceOf3: CompanyTrace = { root: d(3), prerequisites: [d(1), d(99)], dependents: [], edges: [] }

describe('REQ_FE_091 REQ_FE_052 the company view', () => {
  it('REQ_FE_091 REQ_FE_052 REQ_FE_095 loads GET /api/company/roadmaps once and shows ONE merged timeline; there is no view switch, no team band, and no remembered company view', async () => {
    renderPage(<CompanyPage mode="workstreams" />)
    await screen.findByTestId('tl')
    expect(resources.fetchCompanyRoadmaps).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId('tl')).toHaveLength(1)
    expect(rowNames()).toEqual(['Data', 'Self-Serve'])
    expect(screen.getByTestId('tl')).toHaveAttribute('data-merged', 'true') // Timeline draws "N teams · M deliverables" itself
    expect(screen.queryByTestId('company-switch')).toBeNull()
    expect(screen.queryByTestId('team-band')).toBeNull()
    expect(window.localStorage.getItem('erm.companyView')).toBeNull()
  })

  it('REQ_FE_093 the axis handed to the timeline, and the toolbar range, come from the loaded roadmaps', async () => {
    renderPage(<CompanyPage mode="workstreams" />)
    const g = companyGrid(companyFixture(), localDay(new Date()))
    expect(await screen.findByTestId('tl')).toHaveAttribute('data-grid', `${g.start}+${g.days}`)
    expect(screen.getByTitle('Visible range')).toHaveTextContent('5 Jan 2026')
    expect(screen.getByTitle('Visible range')).toHaveTextContent('27 Dec 2026')
  })

  it('REQ_FE_043 REQ_FE_042 the header pills count every team and the status legend is shown; on the trace the pills still count every team', async () => {
    await step('the header pills count every team and the status legend is shown', async () => {
      renderPage(<CompanyPage mode="workstreams" />)
      await screen.findByTestId('tl')
      expect(screen.getByTestId('status-pills')).toHaveTextContent('1 at risk')
      expect(screen.getByTestId('status-pills')).toHaveTextContent('1 in progress')
      expect(screen.getByTestId('status-legend')).toBeInTheDocument()
      expect(screen.getByTestId('pill-teams')).toHaveTextContent('3 teams')
      expect(screen.getByTestId('pill-deliverables')).toHaveTextContent('4 deliverables')
    })

    await step('on the trace the pills still count every team', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(traceOf3)
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-banner')
      expect(screen.getByTestId('status-pills')).toHaveTextContent('1 at risk')
      expect(screen.getByTestId('status-pills')).toHaveTextContent('1 in progress')
    })
  })

  it('REQ_FE_054 every deliverable on the company view and on the trace is given its team tag', async () => {
    await step('every deliverable on the company view is given its team tag', async () => {
      renderPage(<CompanyPage mode="workstreams" />)
      await screen.findByTestId('tl')
      const expected: Record<string, string> = { 1: 'ONB', 2: 'ONB', 3: 'PLT', 4: 'PLT' }
      for (const id of [1, 2, 3, 4]) expect(screen.getByTestId(`bar-${id}`)).toHaveAttribute('data-tag', expected[id])
    })

    await step('every deliverable on the trace is given its team tag', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(traceOf3)
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-banner')
      expect(screen.getByTestId('bar-1')).toHaveAttribute('data-tag', 'ONB')
      expect(screen.getByTestId('bar-3')).toHaveAttribute('data-tag', 'PLT')
    })
  })

  it('REQ_FE_051 REQ_FE_102 the copies and dependencies toggles are on the company view, not on the trace', async () => {
    await step('the company view has both toggles and no add buttons', async () => {
      renderPage(<CompanyPage mode="workstreams" />)
      await screen.findByTestId('tl')
      expect(screen.getByRole('switch', { name: /multi-workstream/i })).toBeInTheDocument()
      expect(screen.getByRole('switch', { name: /dependencies/i })).toBeInTheDocument()
      expect(screen.queryByTitle('New deliverable')).toBeNull()
    })

    await step('the trace has neither', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(traceOf3)
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-banner')
      expect(screen.queryByRole('switch')).toBeNull()
    })
  })
})

describe('REQ_FE_053 the team-roadmap button', () => {
  const withMs = () => {
    const f = companyFixture()
    f[1].roadmap!.milestones = [{ id: 3, roadmap_id: 20, workstream_id: 200, name: 'Beta launch', date: '2026-08-01', row: 1 }]
    return f
  }

  it('REQ_FE_053 REQ_FE_066 no team-roadmap button until a deliverable is selected; it then names its team, sits first in the zoom row and opens that team\'s roadmap', async () => {
    renderPage(<CompanyPage mode="workstreams" />)
    await screen.findByTestId('tl')
    expect(screen.queryByTestId('team-roadmap')).toBeNull() // no button until something is selected

    fireEvent.click(screen.getByTestId('bar-3'))
    const btn = screen.getByTestId('team-roadmap')
    expect(btn).toBeEnabled()
    expect(btn).toHaveTextContent('Show only team "Platform" roadmap')
    expect(btn.parentElement!.firstElementChild).toBe(btn) // REQ_FE_066: at the left end of the zoom row

    fireEvent.click(btn)
    expect(window.location.hash).toBe('#/teams/2')
    expect(screen.getByTestId('bar-1')).toBeInTheDocument() // nothing was filtered in place
  })

  it('REQ_FE_053 a selected milestone gets the button too, for its own team; selecting another item follows it', async () => {
    vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(withMs())
    renderPage(<CompanyPage mode="workstreams" />)
    await screen.findByTestId('tl')
    fireEvent.click(screen.getByTestId('bar-1'))
    expect(screen.getByTestId('team-roadmap')).toHaveTextContent('Show only team "Onboarding" roadmap')
    fireEvent.click(screen.getByTestId('ms-3'))
    expect(screen.getByTestId('team-roadmap')).toHaveTextContent('Show only team "Platform" roadmap')
    fireEvent.click(screen.getByTestId('team-roadmap'))
    expect(window.location.hash).toBe('#/teams/2')
  })
})

describe('REQ_FE_096/097 editing on the company view', () => {
  it('REQ_FE_096 REQ_FE_083 the timeline gets no layout callbacks, for an admin either; clicking a deliverable opens the side panel with its Team row and, for an admin, its Edit; an anonymous visitor gets no Edit and can open a trace read-only', async () => {
    await step('an admin: no layout callbacks; the panel with its Team row and Edit', async () => {
      renderPage(<CompanyPage mode="workstreams" />)
      const tl = await screen.findByTestId('tl')
      expect(tl).toHaveAttribute('data-can-edit', 'true')
      expect(tl).toHaveAttribute('data-layout-callbacks', 'false')
      fireEvent.click(screen.getByTestId('bar-3'))
      const panel = screen.getByTestId('side-panel')
      expect(within(panel).getByText('API Gateway')).toBeInTheDocument()
      expect(within(panel).getByText('Team')).toBeInTheDocument()
      expect(within(panel).getByText('Platform')).toBeInTheDocument()
      expect(within(panel).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    })

    await step('an anonymous visitor: no layout callbacks, no Edit', async () => {
      fresh()
      renderPage(<CompanyPage mode="workstreams" />, false)
      const tl = await screen.findByTestId('tl')
      expect(tl).toHaveAttribute('data-can-edit', 'false')
      expect(tl).toHaveAttribute('data-layout-callbacks', 'false')
      fireEvent.click(screen.getByTestId('bar-3'))
      expect(within(screen.getByTestId('side-panel')).queryByRole('button', { name: 'Edit' })).toBeNull()
    })

    await step('an anonymous visitor can open a trace read-only; the trace has no layout callbacks for an admin either', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(traceOf3)
      renderPage(<CompanyPage mode="trace" traceId={3} />, false)
      await screen.findByTestId('trace-banner')
      expect(screen.getByTestId('tl')).toHaveAttribute('data-can-edit', 'false')
      cleanup()
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-banner')
      expect(screen.getByTestId('tl')).toHaveAttribute('data-layout-callbacks', 'false')
    })
  })

  it('REQ_FE_097 a side panel edit goes to the real deliverable id, shows at once without a reload, and the status counts follow', async () => {
    const d3 = companyFixture()[1].roadmap!.deliverables[0]
    vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...d3, status: 'at_risk' })
    renderPage(<CompanyPage mode="workstreams" />)
    await screen.findByTestId('tl')
    expect(screen.getByTestId('status-pills')).toHaveTextContent('1 in progress')
    openPanelEdit('bar-3')
    setStatus('At risk')
    await waitFor(() => expect(resources.patchDeliverable).toHaveBeenCalledWith(3, { status: 'at_risk' }))
    await waitFor(() => expect(screen.getByTestId('status-pills')).toHaveTextContent('2 at risk'))
    expect(screen.getByTestId('status-pills')).toHaveTextContent('0 in progress')
    expect(resources.fetchCompanyRoadmaps).toHaveBeenCalledTimes(1) // in place, not refetched
  })

  it('REQ_FE_097 a slow, older response never overwrites a newer one, for the roadmaps and for the trace', async () => {
    await step('a slow, older roadmaps response never overwrites a newer one', async () => {
      fresh()
      const slow = deferred<CompanyTeam[]>()
      const quick = deferred<CompanyTeam[]>()
      vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValueOnce(companyFixture()).mockReturnValueOnce(slow.promise).mockReturnValueOnce(quick.promise)
      vi.mocked(resources.removeDependency).mockResolvedValue(undefined as never)
      renderPage(<CompanyPage mode="workstreams" />)
      await screen.findByTestId('tl')
      openPanelEdit('bar-3')
      // a dependency change in the panel refetches the page; twice, so two requests race
      fireEvent.click(await screen.findByRole('button', { name: 'Remove prerequisite Signup Flow' }))
      await flush()
      fireEvent.click(await screen.findByRole('button', { name: 'Remove prerequisite Signup Flow' }))
      await waitFor(() => expect(resources.fetchCompanyRoadmaps).toHaveBeenCalledTimes(3))
      await act(async () => quick.resolve(companyFixture()))
      await act(async () => slow.resolve(companyFixture().slice(0, 1)))
      expect(screen.getByTestId('pill-teams')).toHaveTextContent('3 teams')
    })

    await step('a slow, older trace response never overwrites a newer one', async () => {
      fresh()
      const first: CompanyTrace = { root: d(3), prerequisites: [d(1)], dependents: [], edges: [] }
      const second: CompanyTrace = { root: d(3), prerequisites: [d(1)], dependents: [d(2)], edges: [] }
      const slow = deferred<CompanyTrace>()
      const quick = deferred<CompanyTrace>()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValueOnce(first).mockReturnValueOnce(slow.promise).mockReturnValueOnce(quick.promise)
      const d3 = companyFixture()[1].roadmap!.deliverables[0]
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...d3, status: 'at_risk' })
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-stats')
      openPanelEdit('bar-3')
      setStatus('At risk')
      await flush()
      setStatus('Done')
      await waitFor(() => expect(resources.fetchCompanyTrace).toHaveBeenCalledTimes(3))
      await act(async () => quick.resolve(second))
      await act(async () => slow.resolve(first)) // arrives last, but is older
      expect(screen.getByTestId('trace-stats')).toHaveTextContent('1 dependents')
    })
  })
})

describe('REQ_FE_094 the company view only shows the saved order', () => {
  it('REQ_FE_094 the company view has no reorder controls, whoever looks; the saved workstream order loaded from the server is what the rows follow', async () => {
    await step('no reorder controls, whoever looks', async () => {
      for (const canEdit of [true, false]) {
        fresh()
        renderPage(<CompanyPage mode="workstreams" />, canEdit)
        await screen.findByTestId('tl')
        expect(screen.queryAllByTestId('reorder-handles')).toHaveLength(0)
        expect(screen.queryByTestId('ws-order')).toBeNull()
        expect(screen.queryByRole('button', { name: /^Move .* (up|down)$/ })).toBeNull()
      }
    })

    await step('the saved workstream order loaded from the server is what the rows follow; unsaved names go after, alphabetically', async () => {
      fresh()
      vi.mocked(resources.fetchWorkstreamOrder).mockResolvedValue(['Self-Serve', 'Data'])
      renderPage(<CompanyPage mode="workstreams" />)
      await waitFor(() => expect(screen.getByTestId('tl-ws')).toHaveTextContent('Self-Serve|Data'))
    })
  })
})

describe('REQ_FE_102 the Order button', () => {
  it('REQ_FE_102 REQ_FE_084 an admin sees a ghost Order button with its tooltip (label collapsing below 1440px) on the company view, which opens the Company order page; not on the trace; an anonymous visitor sees no Order button', async () => {
    await step('an admin sees a ghost Order button with its tooltip; it opens the Company order page', async () => {
      renderPage(<CompanyPage mode="workstreams" />)
      await screen.findByTestId('tl')
      const btn = screen.getByTestId('order-button')
      expect(btn).toHaveTextContent('Order')
      expect(btn).toHaveAttribute('title', 'Order teams and workstreams')
      expect(btn).toHaveClass('ghost')
      // REQ_FE_084: below 1440px the label collapses and the icon (named by the tooltip) stays, via CSS not JS
      expect(btn.querySelector('span')!.className).toMatch(/(^|\s)hidden(\s|$).*min-\[1440px\]:inline/)
      fireEvent.click(btn)
      expect(window.location.hash).toBe('#/company/order')
    })

    await step('no Order button on the trace', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(traceOf3)
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-banner')
      expect(screen.queryByTestId('order-button')).toBeNull()
    })

    await step('an anonymous visitor sees no Order button', async () => {
      fresh()
      renderPage(<CompanyPage mode="workstreams" />, false)
      await screen.findByTestId('tl')
      expect(screen.queryByTestId('order-button')).toBeNull()
    })
  })
})

describe('REQ_DEP_021/022 the trace', () => {
  // d3 depends on d1 and on 99 (an id the loaded snapshot does not have); nothing depends on d3.
  it('REQ_DEP_021 REQ_FE_101 "Trace dependencies" sits in the zoom row (no second toolbar) once a deliverable is selected, after the team-roadmap button, and opens #/company/trace/deliverable/<id> (REQ_DEP_028)', async () => {
    renderPage(<CompanyPage mode="workstreams" />)
    await screen.findByTestId('tl')
    expect(screen.queryByTestId('trace-btn')).toBeNull()
    expect(screen.queryByTestId('ctx-bar')).toBeNull()
    fireEvent.click(screen.getByTestId('bar-1'))
    const row = screen.getByTestId('zoom-row')
    expect([...row.children].slice(0, 2).map((e) => e.getAttribute('data-testid'))).toEqual(['team-roadmap', 'trace-btn'])
    fireEvent.click(screen.getByTestId('trace-btn'))
    expect(window.location.hash).toBe('#/company/trace/deliverable/1')
  })

  it('REQ_DEP_021 REQ_DEP_022 the trace is drawn on the merged layout: banner and stats line, the rest hidden, empty rows collapsed', async () => {
    await step('banner and stats line, the rest hidden, empty rows collapsed', async () => {
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(traceOf3)
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      expect(await screen.findByTestId('trace-title')).toHaveTextContent('Tracing dependencies for: API Gateway')
      expect(screen.getByTestId('trace-stats')).toHaveTextContent(/^2 prerequisites · 0 dependents · 2 unrelated items hidden$/)
      expect(resources.fetchCompanyTrace).toHaveBeenCalledWith('deliverable', 3)
      expect(screen.queryByTestId('bar-2')).toBeNull()
      expect(screen.queryByTestId('bar-4')).toBeNull()
      expect(screen.getByTestId('bar-1')).toBeInTheDocument()
      expect(screen.getByTestId('bar-3')).toBeInTheDocument()
      expect(screen.getAllByTestId('tl')).toHaveLength(1)
      expect(screen.getByTestId('tl')).toHaveAttribute('data-merged', 'true')
      expect(rowNames()).toEqual(['Self-Serve']) // both teams' Self-Serve merged; Data collapsed
    })
  })

  it('REQ_DEP_022 "Show all roadmap items" returns to the company view', async () => {
    vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(traceOf3)
    renderPage(<CompanyPage mode="trace" traceId={3} />)
    const btn = await screen.findByTestId('trace-show-all')
    expect(btn).toHaveTextContent('Show all roadmap items')
    fireEvent.click(btn)
    expect(window.location.hash).toBe('#/company/workstreams')
  })

  // An edit or a dependency change in the side panel refetches the trace (quietly), so the stats line and the visible set follow.
  it('REQ_DEP_022 a dependency change or an edit in the side panel on the trace refetches the trace, so the stats line and visible set follow and the page never flashes "Loading"', async () => {
    const first: CompanyTrace = { root: d(3), prerequisites: [d(1)], dependents: [], edges: [] }
    const second: CompanyTrace = { root: d(3), prerequisites: [d(1)], dependents: [d(2)], edges: [] }

    await step('a dependency change refetches the trace, so the stats line and visible set follow', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValueOnce(first).mockResolvedValue(second)
      vi.mocked(resources.removeDependency).mockResolvedValue(undefined as never)
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      expect(await screen.findByTestId('trace-stats')).toHaveTextContent('1 prerequisites · 0 dependents · 2 unrelated')
      expect(screen.queryByTestId('bar-2')).toBeNull()
      openPanelEdit('bar-3')
      fireEvent.click(await screen.findByRole('button', { name: 'Remove prerequisite Signup Flow' }))
      await waitFor(() => expect(screen.getByTestId('trace-stats')).toHaveTextContent('1 prerequisites · 1 dependents · 1 unrelated'))
      expect(screen.getByTestId('bar-2')).toBeInTheDocument()
      expect(resources.fetchCompanyTrace).toHaveBeenCalledTimes(2)
    })

    await step('an edit refetches the trace; the page never flashes "Loading"', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue(first)
      const d3 = companyFixture()[1].roadmap!.deliverables[0]
      vi.mocked(resources.patchDeliverable).mockResolvedValue({ ...d3, status: 'at_risk' })
      renderPage(<CompanyPage mode="trace" traceId={3} />)
      await screen.findByTestId('trace-stats')
      openPanelEdit('bar-3')
      setStatus('At risk')
      await waitFor(() => expect(resources.fetchCompanyTrace).toHaveBeenCalledTimes(2))
      expect(screen.queryByText('Loading…')).toBeNull()
    })
  })

  it('REQ_DEP_021 a trace address with no usable id shows the not-found message with a link back and sends no request; a 400 or 404 answer is the not-found message too', async () => {
    await step('no usable id shows the not-found message with a link back and sends no request', async () => {
      fresh()
      renderPage(<CompanyPage mode="trace" />)
      const nf = await screen.findByTestId('trace-notfound')
      expect(within(nf).getByRole('link', { name: 'Back to the company view' })).toHaveAttribute('href', '#/company/workstreams')
      expect(resources.fetchCompanyTrace).not.toHaveBeenCalled()
    })

    for (const status of [400, 404]) {
      await step(`a ${status} answer is the not-found message`, async () => {
        fresh()
        vi.mocked(resources.fetchCompanyTrace).mockRejectedValue({ response: { status, data: { error: { code: 'x', message: 'x' } } } })
        renderPage(<CompanyPage mode="trace" traceId={5} />)
        expect(await screen.findByTestId('trace-notfound')).toBeInTheDocument()
      })
    }
  })

  it('REQ_DEP_021 REQ_DEP_028 an unknown deliverable id or an unknown milestone id shows a clear not-found message (and a way back)', async () => {
    await step('an unknown deliverable id shows a clear not-found message and a way back', async () => {
      vi.mocked(resources.fetchCompanyTrace).mockRejectedValue({ response: { status: 404, data: { error: { code: 'not_found', message: 'nope' } } } })
      renderPage(<CompanyPage mode="trace" traceId={999} />)
      const nf = await screen.findByTestId('trace-notfound')
      expect(nf).toHaveTextContent('not found')
      expect(within(nf).getByRole('link', { name: 'Back to the company view' })).toHaveAttribute('href', '#/company/workstreams')
    })
    cleanup()
    await step('an unknown milestone id gives the not-found state', async () => {
      vi.mocked(resources.fetchCompanyTrace).mockRejectedValue({ response: { status: 404, data: { error: { code: 'not_found', message: 'nope' } } } })
      renderPage(<CompanyPage mode="trace" traceKind="milestone" traceId={999} />)
      expect(await screen.findByTestId('trace-notfound')).toHaveTextContent('That milestone was not found')
    })
  })
})

describe('REQ_DEP_028 the trace from a milestone', () => {
  const ms = (id: number) => ({ kind: 'milestone' as const, id })
  // PLT's milestone 3 (same number as the deliverable API Gateway) depends on Signup Flow (d1), and Warehouse (d4) depends on it.
  function withMilestone() {
    const f = companyFixture()
    f[1].roadmap!.milestones = [{ id: 3, roadmap_id: 20, workstream_id: 200, name: 'Beta launch', date: '2026-08-01', row: 1 }]
    return f
  }

  it('REQ_DEP_028 "Trace dependencies" is available on a selected milestone and opens #/company/trace/milestone/<id>; the trace of a milestone uses the typed endpoint, keeps the milestone in the chain and counts items', async () => {
    await step('"Trace dependencies" is available on a selected milestone and opens #/company/trace/milestone/<id>', async () => {
      vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(withMilestone())
      renderPage(<CompanyPage mode="workstreams" />)
      await screen.findByTestId('tl')
      fireEvent.click(screen.getByTestId('ms-3'))
      expect(screen.getByTestId('trace-btn')).toBeEnabled()
      fireEvent.click(screen.getByTestId('trace-btn'))
      expect(window.location.hash).toBe('#/company/trace/milestone/3')
    })
    cleanup()
    await step('the trace of a milestone uses the typed endpoint, keeps the milestone in the chain and counts items', async () => {
      vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(withMilestone())
      vi.mocked(resources.fetchCompanyTrace).mockResolvedValue({ root: ms(3), prerequisites: [d(1)], dependents: [d(4), ms(77)], edges: [] })
      renderPage(<CompanyPage mode="trace" traceKind="milestone" traceId={3} />)
      expect(await screen.findByTestId('trace-title')).toHaveTextContent('Tracing dependencies for: Beta launch')
      expect(resources.fetchCompanyTrace).toHaveBeenCalledWith('milestone', 3)
      // loaded items: 4 deliverables + 1 milestone = 5; in the chain on screen: root, d1, d4 = 3
      expect(screen.getByTestId('trace-stats')).toHaveTextContent(/^1 prerequisites · 2 dependents · 2 unrelated items hidden$/)
      expect(screen.getByTestId('ms-3')).toBeInTheDocument() // the root milestone is drawn
      expect(screen.getByTestId('bar-1')).toBeInTheDocument()
      expect(screen.getByTestId('bar-4')).toBeInTheDocument()
      expect(screen.queryByTestId('bar-3')).toBeNull() // the deliverable that shares the milestone's number is not in the chain
    })
  })

  it('REQ_DEP_021 a server without the trace route ("No such endpoint") shows the load error, not "not found"', async () => {
    vi.mocked(resources.fetchCompanyTrace).mockRejectedValue({ response: { status: 404, data: { error: { code: 'not_found', message: 'No such endpoint' } } } })
    renderPage(<CompanyPage mode="trace" traceKind="deliverable" traceId={4} />)
    expect(await screen.findByTestId('trace-error')).toHaveTextContent('Could not load the dependency trace.')
    expect(screen.queryByTestId('trace-notfound')).toBeNull()
  })
})

describe('REQ_AUTH_001 reading needs no account', () => {
  it('REQ_AUTH_001 a load failure is shown, not a blank page', async () => {
    vi.mocked(resources.fetchCompanyRoadmaps).mockRejectedValue(new Error('boom'))
    renderPage(<CompanyPage mode="workstreams" />, false)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the company view')
  })
})
