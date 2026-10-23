import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { SidePanel } from './SidePanel'
import * as resources from '../api/resources'
import type { Milestone, RoadmapFull } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')
vi.mock('./DescriptionEditor', () => ({
  DescriptionEditor: ({ html }: { html: string }) => <textarea aria-label="Description editor" defaultValue={html} />,
}))

const base: Milestone = { id: 20, roadmap_id: 1, workstream_id: 1, name: 'Launch', date: '2026-03-01', row: 0, description_html: '<p>Go live</p>' }

const roadmapWith = (m: Partial<Milestone>): RoadmapFull =>
  ({
    id: 1,
    team_id: 1,
    title: 'Plan',
    range_start: null,
    range_end: null,
    created_at: '',
    updated_at: '',
    team: { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', created_at: '' },
    workstreams: [{ id: 1, roadmap_id: 1, name: 'Core', position: 0 }],
    deliverables: [],
    milestones: [{ ...base, ...m }],
    dependencies: [],
  }) as unknown as RoadmapFull

const panel = (m: Partial<Milestone> = {}) => (
  <SidePanel roadmap={roadmapWith(m)} selection={{ id: 20, type: 'milestone' }} onClose={vi.fn()} onDeliverableUpdated={vi.fn()} onOpenFullEdit={vi.fn()} />
)
const edit = () => fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
const RISK = 'What is the risk? Shown on hover and in the panel.'

// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function setup() {
  cleanup()
  vi.resetAllMocks()
  window.localStorage.clear()
  vi.mocked(resources.fetchDependencyCandidates).mockResolvedValue([])
  vi.mocked(resources.patchMilestone).mockResolvedValue(base)
}
beforeEach(setup)

describe('REQ_FE_024 milestone owner, status, risk note and links in view mode', () => {
  it('REQ_FE_024 REQ_FE_041 REQ_FE_032 view mode shows the responsible person and the labelled status badge (never the raw value), reads as planned without the new fields, shows the risk note only when at risk, and shows links under the description', async () => {
    await step('shows the responsible person and the labelled status badge, never the raw value', () => {
      render(panel({ responsible_person: 'Maria', status: 'in_progress' }))
      expect(screen.getByText('Maria')).toBeInTheDocument()
      expect(screen.getByTestId('panel-status')).toHaveTextContent('In progress')
      expect(screen.queryByText('in_progress')).not.toBeInTheDocument()
    })

    await step('a milestone without the new fields reads as planned, no owner, no risk note, no links', () => {
      setup()
      render(panel())
      expect(screen.getByTestId('panel-status')).toHaveTextContent('Planned')
      expect(screen.getByText('—')).toBeInTheDocument()
      expect(screen.queryByText('Links')).not.toBeInTheDocument()
    })

    await step('the risk note shows only when the milestone is at risk', () => {
      setup()
      const { unmount } = render(panel({ status: 'at_risk', risk_note: 'Vendor late' }))
      expect(screen.getByText('Vendor late')).toBeInTheDocument()
      unmount()
      render(panel({ status: 'done', risk_note: 'Vendor late' }))
      expect(screen.queryByText('Vendor late')).not.toBeInTheDocument()
    })

    await step('links show under the description in view mode', () => {
      setup()
      render(panel({ links: [{ id: 1, position: 0, label: 'Jira epic', url: 'https://jira.example.com/E-1' }] }))
      const link = screen.getByRole('link', { name: /Jira epic/ })
      expect(link).toHaveAttribute('href', 'https://jira.example.com/E-1')
      expect(screen.getByTestId('milestone-description').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
  })
})

describe('REQ_FE_100 milestone edit mode owner, status, risk note and links', () => {
  it('REQ_FE_100 REQ_FE_041 the responsible person saves by itself on blur with only that field; a status saves on click; the red risk note box shows only for At risk and saves on blur; a refused status stays with the server message', async () => {
    await step('a status saves on click; the red risk note box shows only for At risk and saves on blur', async () => {
      render(panel({ status: 'at_risk', risk_note: '' }))
      edit()
      const box = screen.getByPlaceholderText(RISK)
      expect(box).toHaveClass('risk-note')
      fireEvent.focus(box)
      fireEvent.change(box, { target: { value: 'Vendor late' } })
      fireEvent.blur(box)
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { risk_note: 'Vendor late' }))
      fireEvent.click(screen.getByRole('button', { name: /In progress/ }))
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { status: 'in_progress' }))
    })

    await step('the responsible person saves by itself on blur with only that field', async () => {
      setup()
      render(panel())
      edit()
      const el = screen.getByLabelText('Responsible person')
      fireEvent.focus(el)
      fireEvent.change(el, { target: { value: 'Maria' } })
      fireEvent.blur(el)
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { responsible_person: 'Maria' }))
    })

    await step('no risk note box unless the milestone is at risk', () => {
      setup()
      render(panel())
      edit()
      expect(screen.queryByPlaceholderText(RISK)).not.toBeInTheDocument()
    })

    await step('a refused status stays with the server message', async () => {
      setup()
      vi.mocked(resources.patchMilestone).mockRejectedValue({ response: { data: { error: { message: 'status is not valid' } } } })
      render(panel())
      edit()
      fireEvent.click(screen.getByRole('button', { name: /Done$/ }))
      expect(await screen.findByText('status is not valid')).toBeInTheDocument()
    })
  })

  it('REQ_FE_121 link rows: label 1/3, URL 2/3, placeholder, 40 characters, Add link focuses the new label, a save replaces the whole set; a half-filled link row is refused before anything is sent', async () => {
    await step('link rows: label 1/3, URL 2/3, placeholder, 40 characters, Add link focuses the new label, a save replaces the whole set', async () => {
      render(panel({ links: [{ id: 1, position: 0, label: 'RFC', url: 'https://rfc.example.com' }] }))
      edit()
      fireEvent.click(screen.getByRole('button', { name: '+ Add link' }))
      const labels = screen.getAllByLabelText('Link label')
      expect(labels).toHaveLength(2)
      expect(labels[1]).toHaveFocus()
      expect(labels[1]).toHaveAttribute('placeholder', 'Label, e.g. Jira epic')
      expect(labels[1]).toHaveAttribute('maxlength', '40')
      expect(labels[1]).toHaveClass('basis-1/3')
      expect(screen.getAllByLabelText('Link URL')[1]).toHaveClass('basis-2/3')
      fireEvent.change(labels[1], { target: { value: 'Jira epic' } })
      fireEvent.change(screen.getAllByLabelText('Link URL')[1], { target: { value: 'https://jira.example.com/E-1' } })
      fireEvent.blur(screen.getAllByLabelText('Link URL')[1])
      await waitFor(() =>
        expect(resources.patchMilestone).toHaveBeenCalledWith(20, {
          links: [
            { label: 'RFC', url: 'https://rfc.example.com' },
            { label: 'Jira epic', url: 'https://jira.example.com/E-1' },
          ],
        }),
      )
    })

    await step('a half-filled link row is refused before anything is sent', () => {
      setup()
      render(panel())
      edit()
      fireEvent.click(screen.getByRole('button', { name: '+ Add link' }))
      fireEvent.change(screen.getByLabelText('Link label'), { target: { value: 'No url' } })
      fireEvent.blur(screen.getByLabelText('Link label'))
      expect(screen.getByText('Each link needs a label and an http(s) URL')).toBeInTheDocument()
      expect(resources.patchMilestone).not.toHaveBeenCalled()
    })

    await step('removing a link row saves the set without it', async () => {
      setup()
      render(panel({ links: [{ id: 1, position: 0, label: 'RFC', url: 'https://rfc.example.com' }, { id: 2, position: 1, label: 'Jira', url: 'https://jira.example.com' }] }))
      edit()
      fireEvent.click(screen.getByRole('button', { name: 'Remove link RFC' }))
      await waitFor(() => expect(resources.patchMilestone).toHaveBeenCalledWith(20, { links: [{ label: 'Jira', url: 'https://jira.example.com' }] }))
    })

    await step('the Depends on hint says "this milestone"', () => {
      setup()
      render(panel())
      edit()
      expect(screen.getByTestId('dep-hint')).toHaveTextContent('A prerequisite must end before this milestone starts. Greyed options say why.')
    })
  })
})
