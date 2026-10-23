import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CompanyOrderPage } from './CompanyOrderPage'
import * as resources from '../api/resources'
import { CanEditProvider } from '../lib/canEdit'
import { companyFixture } from '../lib/companyFixtures'
import { parseRoute } from '../lib/router'
import { step } from '../testSteps'

vi.mock('../api/resources')

function renderPage(canEdit = true) {
  return render(
    <CanEditProvider value={canEdit}>
      <CompanyOrderPage />
    </CanEditProvider>,
  )
}
const names = (card: string) => within(screen.getByTestId(card)).getAllByTestId('ws-row').map((r) => r.querySelector('.nm')?.textContent)
const teamNames = () => names('team-order-card')
const wsNames = () => names('workstream-order-card')
const grip = (card: string, name: string) => within(screen.getByTestId(card)).getByRole('button', { name: `Reorder ${name}` })

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Three teams (Onboarding, Platform, Security) in the fixture; Security's roadmap is empty.
// Fresh page and mocks; also called at the start of each step of a merged test, so no step inherits another's state.
function fresh() {
  cleanup()
  vi.resetAllMocks()
  vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(companyFixture())
  vi.mocked(resources.fetchWorkstreamOrder).mockResolvedValue([])
  vi.mocked(resources.putTeamOrder).mockResolvedValue([])
  vi.mocked(resources.putWorkstreamOrder).mockResolvedValue([])
}
beforeEach(fresh)

describe('REQ_FE_116 the Company order page', () => {
  it('REQ_FE_116 the route #/company/order is its own address', () => {
    expect(parseRoute('#/company/order')).toEqual({ name: 'companyOrder' })
    expect(parseRoute('#/company/order/')).toEqual({ name: 'companyOrder' })
  })

  it('REQ_FE_116 shows the title, a way back, and both cards in a fixed order, the same list as Manage workstreams; both cards are shown even when a list is empty', async () => {
    await step('shows the title, a way back, and both cards in a fixed order, the same list as Manage workstreams', async () => {
      renderPage()
      await screen.findByTestId('team-order-card')
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Company order')
      expect(screen.getByTestId('back-to-company')).toHaveAttribute('href', '#/company/workstreams')
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Team order', 'Workstream order'])
      const rows = within(screen.getByTestId('team-order-card')).getAllByTestId('ws-row')
      expect(within(rows[0]).getByText('1')).toBeInTheDocument()
      expect(within(rows[0]).getByTestId('ws-grip')).toBeInTheDocument()
      expect(screen.getByTestId('topbar')).toHaveAttribute('data-variant', 'company')
      expect(screen.queryByTestId('company-switch')).toBeNull() // REQ_FE_102: no switch, no Order button, no range, no switches
      expect(screen.queryByTestId('order-button')).toBeNull()
      expect(screen.queryByRole('switch')).toBeNull()
    })

    await step('both cards are shown even when a list is empty', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue([])
      renderPage()
      await screen.findByTestId('team-order-card')
      expect(screen.getByTestId('workstream-order-card')).toBeInTheDocument()
    })
  })

  it('REQ_FE_116 REQ_FE_117 a keyboard move in the Team order card saves the full list of team ids at once; in the Workstream order card it saves the full list of names as shown, and the edge does nothing', async () => {
    await step('a keyboard move in the Team order card saves the full list of team ids at once', async () => {
      renderPage()
      await screen.findByTestId('team-order-card')
      expect(teamNames()).toEqual(['Onboarding', 'Platform', 'Security'])
      fireEvent.keyDown(grip('team-order-card', 'Platform'), { key: 'ArrowUp' })
      expect(teamNames()).toEqual(['Platform', 'Onboarding', 'Security'])
      await waitFor(() => expect(resources.putTeamOrder).toHaveBeenCalledWith([2, 1, 3]))
    })

    await step('a keyboard move in the Workstream order card saves the full list of names; the edge does nothing', async () => {
      fresh()
      renderPage()
      await screen.findByTestId('workstream-order-card')
      expect(wsNames()).toEqual(['Data', 'Self-Serve'])
      fireEvent.keyDown(grip('workstream-order-card', 'Data'), { key: 'ArrowUp' })
      expect(resources.putWorkstreamOrder).not.toHaveBeenCalled()
      fireEvent.keyDown(grip('workstream-order-card', 'Self-Serve'), { key: 'ArrowUp' })
      expect(wsNames()).toEqual(['Self-Serve', 'Data'])
      await waitFor(() => expect(resources.putWorkstreamOrder).toHaveBeenCalledWith(['Self-Serve', 'Data']))
    })

    await step('a save sends the same full list as shown', async () => {
      fresh()
      vi.mocked(resources.fetchWorkstreamOrder).mockResolvedValue(['Self-Serve'])
      renderPage()
      await screen.findByTestId('workstream-order-card')
      expect(wsNames()).toEqual(['Self-Serve', 'Data'])
      fireEvent.keyDown(grip('workstream-order-card', 'Data'), { key: 'ArrowUp' })
      await waitFor(() => expect(resources.putWorkstreamOrder).toHaveBeenCalledWith(['Data', 'Self-Serve']))
    })
  })

  it('REQ_FE_116 a refused save puts the list back and shows the server message; one save at a time: a move while a save runs is ignored and a failed first save restores the original order; a failed load says so', async () => {
    await step('a refused save puts the list back and shows the server message', async () => {
      vi.mocked(resources.putTeamOrder).mockRejectedValue({ response: { status: 403, data: { error: { code: 'forbidden', message: 'Admin only' } } } })
      renderPage()
      await screen.findByTestId('team-order-card')
      fireEvent.keyDown(grip('team-order-card', 'Platform'), { key: 'ArrowUp' })
      expect(await within(screen.getByTestId('team-order-card')).findByTestId('order-message')).toHaveTextContent('Admin only')
      expect(teamNames()).toEqual(['Onboarding', 'Platform', 'Security'])
    })

    await step('one save at a time: a move while a save runs is ignored; a failed first save restores the original order', async () => {
      fresh()
      const first = deferred<never>()
      vi.mocked(resources.putTeamOrder).mockReturnValueOnce(first.promise)
      renderPage()
      await screen.findByTestId('team-order-card')
      fireEvent.keyDown(grip('team-order-card', 'Platform'), { key: 'ArrowUp' })
      fireEvent.keyDown(grip('team-order-card', 'Security'), { key: 'ArrowUp' })
      expect(teamNames()).toEqual(['Platform', 'Onboarding', 'Security'])
      expect(resources.putTeamOrder).toHaveBeenCalledTimes(1)
      await act(async () => first.reject({ response: { status: 500, data: { error: { code: 'internal', message: 'busy' } } } }))
      expect(teamNames()).toEqual(['Onboarding', 'Platform', 'Security'])
      fireEvent.keyDown(grip('team-order-card', 'Security'), { key: 'ArrowUp' })
      await waitFor(() => expect(resources.putTeamOrder).toHaveBeenLastCalledWith([1, 3, 2]))
    })

    await step('a failed load says so', async () => {
      fresh()
      vi.mocked(resources.fetchCompanyRoadmaps).mockRejectedValue(new Error('down'))
      renderPage()
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the company order')
    })
  })

  it('REQ_FE_116 anonymous visitors see both lists read-only, without grips', async () => {
    renderPage(false)
    await screen.findByTestId('team-order-card')
    expect(teamNames()).toEqual(['Onboarding', 'Platform', 'Security'])
    expect(wsNames()).toEqual(['Data', 'Self-Serve'])
    expect(screen.queryAllByTestId('ws-grip')).toHaveLength(0)
  })
})

describe('REQ_FE_117 what the cards list', () => {
  it('REQ_FE_117 the Team order card lists every team with its tag, without markers; the Workstream order card lists the saved order, then unsaved names alphabetically, without markers', async () => {
    await step('the Team order card lists every team with its tag, without markers', async () => {
      const f = companyFixture()
      vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue(f)
      renderPage()
      await screen.findByTestId('team-order-card')
      const rows = within(screen.getByTestId('team-order-card')).getAllByTestId('ws-row')
      expect(rows.map((r) => r.querySelector('.ct')?.textContent)).toEqual(f.map((c) => c.team.tag))
      expect(within(screen.getByTestId('team-order-card')).queryByTestId('order-note')).toBeNull()
    })

    await step('the Workstream order card lists the saved order, then unsaved names alphabetically, without markers', async () => {
      fresh()
      vi.mocked(resources.fetchWorkstreamOrder).mockResolvedValue(['Self-Serve'])
      renderPage()
      await screen.findByTestId('workstream-order-card')
      expect(wsNames()).toEqual(['Self-Serve', 'Data'])
      expect(within(screen.getByTestId('workstream-order-card')).queryByTestId('order-note')).toBeNull()
    })
  })
})
