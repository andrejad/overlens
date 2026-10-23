import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import * as resources from '../api/resources'
import { TeamListPage } from './TeamListPage'

vi.mock('../api/resources')
vi.mock('../components/AppChrome', () => ({ TopBar: () => <div /> }))

describe('REQ_FE_098 the team list page', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('REQ_FE_098 a failed load shows "Could not load the teams" instead of Loading forever', async () => {
    vi.mocked(resources.fetchTeamOrder).mockRejectedValue(new Error('network'))
    render(<TeamListPage />)
    expect(await screen.findByText('Could not load the teams')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })
})
