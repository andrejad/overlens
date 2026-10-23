import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { AddButtons, DownloadCsvButton, Toolbar, ZoomRow } from './Toolbar'
import { TopBar } from './AppChrome'
import { CanEditProvider } from '../lib/canEdit'
import * as prefs from '../lib/prefs'
import { addDate, dayOf, fmtDay, localDay } from '../timeline/axis'
import type { Deliverable, Milestone, RoadmapFull } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')

function deliverable(id: number, start: string, end: string): Deliverable {
  return {
    id,
    roadmap_id: 1,
    team_id: 1,
    name: `d${id}`,
    start_date: start,
    end_date: end,
    color: '#4f6bd8',
    responsible_person: '',
    description_html: '',
    status: 'planned',
    risk_note: '',
    icons: [],
    workstream_ids: [1],
    workstreams: [{ id: 1, row: 0 }],
    links: [],
    created_at: '',
    updated_at: '',
  }
}

function milestone(id: number, date: string): Milestone {
  return { id, roadmap_id: 1, workstream_id: 1, name: `m${id}`, date, row: 0 }
}

function roadmapWith(deliverables: Deliverable[], milestones: Milestone[] = []): RoadmapFull {
  return {
    id: 1,
    team_id: 1,
    title: 'Plan',
   
    range_start: null,
    range_end: null,
    created_at: '',
    updated_at: '',
   
    team: { id: 1, name: 'Team', tag: 'TST', default_color: '#4f6bd8', roadmap_id: 1, created_at: '' },
    workstreams: [{ id: 1, roadmap_id: 1, name: 'General', position: 0 }],
    deliverables,
    milestones,
    dependencies: [],
  }
}

describe('REQ_FE_066 the zoom row', () => {
  it('REQ_FE_066 the zoom row: "Zoom" and Year / Half year / Quarter / Month, the current one marked on, clicking changes zoom; no "fit everything"; the team-roadmap button at its left end; not in the toolbar part of the top bar', async () => {
    await step('renders "Zoom" and the four zoom buttons, the current one marked on, clicking changes zoom', () => {
      cleanup()
      const onZoomChange = vi.fn()
      render(<ZoomRow zoom="year" onZoomChange={onZoomChange} />)
      expect(screen.getByTestId('zoom-row')).toHaveTextContent(/^Zoom/)
      const buttons = screen.getAllByRole('button').filter((b) => b.hasAttribute('data-z'))
      expect(buttons.map((b) => `${b.getAttribute('data-z')}:${b.textContent}`)).toEqual([
        'year:Year',
        'half:Half year',
        'quarter:Quarter',
        'month:Month',
      ])
      expect(buttons[0].className).toMatch(/\bon\b/)
      expect(buttons[1].className).not.toMatch(/\bon\b/)

      fireEvent.click(buttons[3])
      expect(onZoomChange).toHaveBeenCalledWith('month')
      expect(prefs.getZoom()).toBe('month')
    })

    await step('offers no "fit everything" option', () => {
      cleanup()
      render(<ZoomRow zoom="year" onZoomChange={vi.fn()} />)
      expect(screen.queryByText(/fit/i)).not.toBeInTheDocument()
    })

    await step('children (the team-roadmap button) sit at the left end of the row, before "Zoom"', () => {
      cleanup()
      render(
        <ZoomRow zoom="year" onZoomChange={vi.fn()}>
          <button type="button">filter</button>
        </ZoomRow>,
      )
      const row = screen.getByTestId('zoom-row')
      expect(row.firstElementChild).toHaveTextContent('filter')
    })

    await step('the zoom is not in the toolbar part of the top bar', () => {
      cleanup()
      render(<Toolbar roadmap={roadmapWith([])} />)
      expect(screen.queryByTestId('zoomseg')).not.toBeInTheDocument()
    })
  })
})

describe('M5 toolbar visible range', () => {
  it('REQ_FE_060 shows the earliest-to-latest date across deliverables and milestones, ignoring stale roadmap.range_start/range_end, and refreshes immediately when a deliverable date changes', async () => {
    await step('shows the earliest-to-latest date across deliverables and milestones, ignoring stale range_start/range_end', () => {
      cleanup()
      const roadmap = roadmapWith([deliverable(1, '2026-02-01', '2026-03-01')], [milestone(1, '2026-04-15')])
      // deliberately stale/mismatched — the fix must not read these fields
      roadmap.range_start = '2025-01-01'
      roadmap.range_end = '2025-06-01'
      render(<Toolbar roadmap={roadmap} />)
      expect(screen.getByText(fmtDay(dayOf('2026-02-01')))).toBeInTheDocument()
      expect(screen.getByText(fmtDay(dayOf('2026-04-15')))).toBeInTheDocument()
      expect(screen.queryByText(fmtDay(dayOf('2025-01-01')))).not.toBeInTheDocument()
    })

    await step('refreshes immediately when a deliverable date changes (a drag or a form edit), without a roadmap re-fetch', () => {
      cleanup()
      const roadmap = roadmapWith([deliverable(1, '2026-02-01', '2026-03-01')])
      const { rerender } = render(<Toolbar roadmap={roadmap} />)
      expect(screen.getByText(fmtDay(dayOf('2026-03-01')))).toBeInTheDocument()

      // simulate the app applying a PATCH response locally, same as TeamRoadmapPage's updateDeliverable
      const updated = roadmapWith([deliverable(1, '2026-02-01', '2026-05-20')])
      rerender(<Toolbar roadmap={updated} />)
      expect(screen.getByText(fmtDay(dayOf('2026-05-20')))).toBeInTheDocument()
      expect(screen.queryByText(fmtDay(dayOf('2026-03-01')))).not.toBeInTheDocument()
    })
  })

  it('REQ_FE_061 an empty roadmap falls back to 3 months before today to 9 months after', () => {
    render(<Toolbar roadmap={roadmapWith([])} />)
    const today = localDay(new Date())
    expect(screen.getByText(fmtDay(addDate(today, 0, -3)))).toBeInTheDocument()
    expect(screen.getByText(fmtDay(addDate(today, 0, 9)))).toBeInTheDocument()
  })
})

describe('REQ_FE_084 the layout holds at 1280px; labels/date range collapse by breakpoint, nothing reflows', () => {
  it('REQ_FE_084 the Deliverable label, the date range and the copies label collapse by breakpoint via CSS classes, not JS', async () => {
    await step('the "Deliverable" button label is hidden by default and only shown from 1440px, via CSS not JS', () => {
      cleanup()
      render(<AddButtons onAddWorkstream={vi.fn()} onAddDeliverable={vi.fn()} onAddMilestone={vi.fn()} />)
      const label = screen.getByText('Deliverable')
      // "hidden" (display:none below the breakpoint) + the Tailwind breakpoint utility that reveals it
      // at 1440px; only this label's visibility changes, so nothing reflows (REQ_FE_084's own wording).
      expect(label.className).toMatch(/\bhidden\b/)
      expect(label.className).toMatch(/min-\[1440px\]:inline/)
    })

    await step('the date range shows a short form by default and the long form only from 1700px', () => {
      cleanup()
      const roadmap = roadmapWith([deliverable(1, '2026-01-05', '2026-02-01')])
      render(<Toolbar roadmap={roadmap} />)
      const long = screen.getByText(fmtDay(dayOf('2026-01-05'), true))
      const short = screen.getByText(fmtDay(dayOf('2026-01-05'), false))
      expect(long.className).toMatch(/\bhidden\b/)
      expect(long.className).toMatch(/min-\[1700px\]:inline/)
      expect(short.className).toMatch(/\binline\b/)
      expect(short.className).toMatch(/min-\[1700px\]:hidden/)
    })

    await step('the copies long label only shows from 1700px, the short one hides there', () => {
      cleanup()
      render(<Toolbar roadmap={roadmapWith([])} dupsOn={true} onDupsChange={vi.fn()} />)
      const long = screen.getByText('Hide multi-workstream')
      const short = screen.getByText('Hide copies')
      expect(long.className).toMatch(/\bhidden\b/)
      expect(long.className).toMatch(/min-\[1700px\]:inline/)
      expect(short.className).toMatch(/\binline\b/)
      expect(short.className).toMatch(/min-\[1700px\]:hidden/)
    })
  })
})

describe('REQ_FE_051/017/071 the copies toggle', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  it('REQ_FE_051 the copies switch is a role="switch" whose aria-checked and label reflect dupsOn, names the action not the state, and explains copies on hover (the locked tooltip wins with arrows on, REQ_DEP_014)', async () => {
    await step('is a role="switch" whose aria-checked and long label reflect dupsOn=true', () => {
      cleanup()
      render(<Toolbar roadmap={roadmapWith([])} dupsOn={true} onDupsChange={vi.fn()} />)
      const sw = screen.getByRole('switch', { name: /copies/i })
      expect(sw).toHaveAttribute('aria-checked', 'true')
      expect(sw).toHaveTextContent('Hide multi-workstream')
      expect(sw).toHaveTextContent('Hide copies')
    })

    await step('the label names the action, not the state: dupsOn=false shows "Show copies"', () => {
      cleanup()
      render(<Toolbar roadmap={roadmapWith([])} dupsOn={false} onDupsChange={vi.fn()} />)
      const sw = screen.getByRole('switch', { name: /copies/i })
      expect(sw).toHaveAttribute('aria-checked', 'false')
      expect(sw).toHaveTextContent('Show multi-workstream')
      expect(sw).toHaveTextContent('Show copies')
    })

    await step('hovering the copies switch explains copies; with arrows on the locked tooltip wins (REQ_DEP_014)', () => {
      cleanup()
      const { rerender } = render(<Toolbar roadmap={roadmapWith([])} dupsOn={true} onDupsChange={vi.fn()} />)
      expect(screen.getByRole('switch', { name: /copies/i })).toHaveAttribute('title', 'One deliverable can belong to one or more workstreams')
      rerender(<Toolbar roadmap={roadmapWith([])} dupsOn={false} onDupsChange={vi.fn()} depsOn={true} onDepsChange={vi.fn()} />)
      expect(screen.getByRole('switch', { name: /copies/i }).getAttribute('title')).not.toBe('One deliverable can belong to one or more workstreams')
    })
  })
})

describe('REQ_FE_101/090 the add buttons', () => {
  it('REQ_FE_090 REQ_FE_101 REQ_FE_006 the Workstream, Deliverable and Milestone buttons call their handlers and have the tooltips; an anonymous visitor gets none of the add buttons; the Download CSV button carries the tooltip and downloads the roadmap CSV', async () => {
    await step('the Workstream, Deliverable and Milestone buttons call their handlers and have the tooltips of REQ_FE_101', () => {
      cleanup()
      const onAddWorkstream = vi.fn()
      const onAddDeliverable = vi.fn()
      const onAddMilestone = vi.fn()
      render(<AddButtons onAddWorkstream={onAddWorkstream} onAddDeliverable={onAddDeliverable} onAddMilestone={onAddMilestone} />)
      fireEvent.click(screen.getByTitle('New workstream'))
      fireEvent.click(screen.getByTitle('New deliverable'))
      fireEvent.click(screen.getByTitle('New milestone'))
      expect(onAddWorkstream).toHaveBeenCalled()
      expect(onAddDeliverable).toHaveBeenCalled()
      expect(onAddMilestone).toHaveBeenCalled()
    })

    await step('an anonymous visitor gets none of the add buttons', () => {
      cleanup()
      render(
        <CanEditProvider value={false}>
          <AddButtons onAddWorkstream={vi.fn()} onAddDeliverable={vi.fn()} onAddMilestone={vi.fn()} />
        </CanEditProvider>,
      )
      expect(screen.queryByTestId('add-workstream')).not.toBeInTheDocument()
      expect(screen.queryByTestId('add-deliverable')).not.toBeInTheDocument()
      expect(screen.queryByTestId('add-milestone')).not.toBeInTheDocument()
    })

    await step('REQ_IMP_026 the Download CSV button carries the tooltip and downloads the roadmap CSV', () => {
      cleanup()
      render(<DownloadCsvButton roadmapId={7} />)
      const b = screen.getByTestId('download-csv')
      expect(b).toHaveAttribute('title', 'Download this roadmap as a CSV file')
      expect(b).toHaveAttribute('href', '/api/roadmaps/7/export.csv')
      expect(b).toHaveAttribute('download')
    })

    await step('REQ_FE_006 the Workstream button is the first add button, a plus with the tooltip "New workstream"', () => {
      cleanup()
      render(
        <TopBar
          variant="team"
          teamName="Team"
          left={<AddButtons onAddWorkstream={vi.fn()} onAddDeliverable={vi.fn()} onAddMilestone={vi.fn()} />}
        />,
      )
      const bar = screen.getByTestId('topbar')
      const ws = screen.getByTestId('add-workstream')
      expect(bar).toContainElement(ws)
      expect(ws).toHaveAttribute('title', 'New workstream')
      expect(ws.compareDocumentPosition(screen.getByTestId('add-deliverable')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })
})
