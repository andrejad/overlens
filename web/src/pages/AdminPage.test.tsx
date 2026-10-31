import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as resources from '../api/resources'
import { AuthProvider } from '../lib/auth'
import { SessionBanner } from '../components/AppChrome'
import { step } from '../testSteps'
import { AdminPage } from './AdminPage'
import { suggestTag } from '../components/admin/TeamsCard'
import type { User } from '../api/types'

vi.mock('../api/resources', async () => {
  const actual = await vi.importActual<typeof import('../api/resources')>('../api/resources')
  // Everything is mocked except the pure CSV-link builder, whose real output the tests assert on.
  const auto: Record<string, unknown> = {}
  for (const k of Object.keys(actual)) auto[k] = k === 'auditCsvUrl' ? actual[k as keyof typeof actual] : vi.fn()
  return auto
})

const admin = { id: 1, username: 'andreja', role: 'admin' }
const users: User[] = [
  { id: 1, username: 'andreja', role: 'admin', disabled: false, created_at: '2026-03-12T10:00:00Z' },
  { id: 2, username: 'maria', role: 'admin', disabled: false, created_at: '2026-04-02T10:00:00Z' },
]
function mockAdminData() {
  vi.mocked(resources.fetchMe).mockResolvedValue(admin)
  vi.mocked(resources.fetchUsers).mockResolvedValue(users)
  vi.mocked(resources.fetchTeams).mockResolvedValue([
    { id: 1, name: 'Onboarding', tag: 'ONB', default_color: '#2f6bd7', roadmap_id: 1, created_at: '' },
    { id: 2, name: 'Revenue Ops', tag: 'REV', default_color: '#7c3aed', roadmap_id: 2, created_at: '' },
  ])
  // Onboarding's roadmap holds a roadmap item (a milestone); Revenue Ops' roadmap is empty
  vi.mocked(resources.fetchCompanyRoadmaps).mockResolvedValue([
    { team: { id: 1 }, roadmap: { deliverables: [], milestones: [{ id: 5 }] } },
    { team: { id: 2 }, roadmap: { deliverables: [], milestones: [] } },
  ] as never)
  vi.mocked(resources.fetchIcons).mockResolvedValue([
    { key: 'star', label: 'High priority' },
    { key: 'clock', label: 'Time sensitive' },
  ])
  vi.mocked(resources.fetchStorage).mockResolvedValue({ version: '1.0.0', build_time: '2026-10-21T14:02:00Z', commit: 'abc1234', db_bytes: 5 * 1024 ** 2, log_bytes: 2048, log_files: 3, disk_free_bytes: 20 * 1024 ** 3, disk_total_bytes: 100 * 1024 ** 3 })
  vi.mocked(resources.fetchAudit).mockResolvedValue({
    items: [
      { id: 1, ts: '2026-10-01T10:00:00Z', username: 'andreja', action: 'user.create', entity_type: 'user', entity_id: 2, roadmap_id: null, details: { user: 'maria' } },
    ],
    total: 60,
    retention_days: 365,
  })
}

const renderAdmin = () =>
  render(
    <AuthProvider>
      <SessionBanner />
      <AdminPage />
    </AuthProvider>,
  )

const httpError = (status: number, code: string, fields?: Record<string, string>) => ({
  isAxiosError: true,
  response: { status, data: { error: { code, message: code, fields } } },
})

describe('REQ_AUTH_012 admin screen guard', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_AUTH_012 anonymous: an "Admins only" message, and no admin data is fetched', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
    renderAdmin()
    expect(await screen.findByText(/Admins only/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
    expect(resources.fetchUsers).not.toHaveBeenCalled()
    expect(resources.fetchAudit).not.toHaveBeenCalled()
    expect(resources.fetchTeams).not.toHaveBeenCalled()
    expect(resources.fetchIcons).not.toHaveBeenCalled()
  })

  it('REQ_AUTH_012 the guard button opens the login dialog over the page', async () => {
    vi.mocked(resources.fetchMe).mockResolvedValue(null)
    renderAdmin()
    fireEvent.click(await screen.findByRole('button', { name: 'Log in' }))
    expect(screen.getByRole('dialog', { name: 'Log in' })).toBeInTheDocument()
  })
})

describe('REQ_AUTH_013-015 users card', () => {
  // a test with several steps starts each step on a fresh page with fresh mocks
  const fresh = () => {
    cleanup()
    vi.resetAllMocks()
    mockAdminData()
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mockAdminData()
  })

  it('REQ_AUTH_013 REQ_AUTH_014 creating an admin sends username and password and lists the new account; resetting a password sends it and a 422 shows inline', async () => {
    await step('create an admin', async () => {
      vi.mocked(resources.createUser).mockResolvedValue({ id: 3, username: 'newbie', role: 'admin', disabled: false, created_at: '2026-10-01T00:00:00Z' })
      renderAdmin()
      fireEvent.click(await screen.findByRole('button', { name: 'Add admin' }))
      fireEvent.change(screen.getByLabelText('New username'), { target: { value: ' newbie ' } })
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'long-enough-pw' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create admin' }))
      expect(await screen.findByTestId('user-row-newbie')).toBeInTheDocument()
      expect(resources.createUser).toHaveBeenCalledWith('newbie', 'long-enough-pw')
    })
    fresh()
    await step('reset password sends the new password, a 422 shows inline', async () => {
      renderAdmin()
      const row = within(await screen.findByTestId('user-row-maria'))
      fireEvent.click(row.getByRole('button', { name: 'Reset password' }))
      fireEvent.change(row.getByLabelText('New password for maria'), { target: { value: 'short' } })
      vi.mocked(resources.patchUser).mockRejectedValueOnce(httpError(422, 'validation_failed', { password: 'bad' }))
      fireEvent.click(row.getByRole('button', { name: 'Set password' }))
      expect(await row.findByText('The password must be 8 to 128 characters.')).toBeInTheDocument()

      vi.mocked(resources.patchUser).mockResolvedValueOnce(users[1])
      fireEvent.change(row.getByLabelText('New password for maria'), { target: { value: 'a-good-password' } })
      fireEvent.click(row.getByRole('button', { name: 'Set password' }))
      await waitFor(() => expect(resources.patchUser).toHaveBeenLastCalledWith(2, { password: 'a-good-password' }))
      expect(await screen.findByText('Password reset for maria.')).toBeInTheDocument()
    })
  })

  it('REQ_AUTH_014 REQ_AUTH_015 duplicate_name and a 422 password error show inline; disabling and enabling, with last_admin and self_disable errors inline', async () => {
    await step('duplicate_name and 422 password error', async () => {
      renderAdmin()
      fireEvent.click(await screen.findByRole('button', { name: 'Add admin' }))
      fireEvent.change(screen.getByLabelText('New username'), { target: { value: 'maria' } })
      fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'whatever-long' } })
      vi.mocked(resources.createUser).mockRejectedValueOnce(httpError(409, 'duplicate_name'))
      fireEvent.click(screen.getByRole('button', { name: 'Create admin' }))
      expect(await screen.findByText('That username is already taken.')).toBeInTheDocument()

      vi.mocked(resources.createUser).mockRejectedValueOnce(httpError(422, 'validation_failed', { password: 'too short' }))
      fireEvent.click(screen.getByRole('button', { name: 'Create admin' }))
      expect(await screen.findByText('The password must be 8 to 128 characters.')).toBeInTheDocument()
      expect(screen.queryAllByTestId('user-row-maria'), 'a refused create adds no row').toHaveLength(1)
    })
    fresh()
    await step('disable and enable, with last_admin and self_disable errors inline', async () => {
      renderAdmin()
      const row = within(await screen.findByTestId('user-row-andreja'))
      vi.mocked(resources.patchUser).mockRejectedValueOnce(httpError(409, 'self_disable'))
      fireEvent.click(row.getByRole('button', { name: 'Disable' }))
      expect(await row.findByText("You can't disable your own account.")).toBeInTheDocument()
      expect(row.getByText('active'), 'a refused self-disable changes nothing').toBeInTheDocument()

      vi.mocked(resources.patchUser).mockRejectedValueOnce(httpError(409, 'last_admin'))
      fireEvent.click(row.getByRole('button', { name: 'Disable' }))
      expect(await row.findByText("The last active admin can't be disabled.")).toBeInTheDocument()

      const maria = within(screen.getByTestId('user-row-maria'))
      vi.mocked(resources.patchUser).mockResolvedValueOnce({ ...users[1], disabled: true })
      fireEvent.click(maria.getByRole('button', { name: 'Disable' }))
      expect(await maria.findByRole('button', { name: 'Enable' })).toBeInTheDocument()
      expect(maria.getByText('disabled')).toBeInTheDocument()
      expect(resources.patchUser).toHaveBeenLastCalledWith(2, { disabled: true })
    })
  })

  it('REQ_AUTH_010 REQ_AUTH_007 REQ_AUTH_014 resetting your OWN password warns first, then ends the session: no edit rights, a clear message, the login dialog reopens, no password left in the DOM; resetting someone else\'s does not warn and does not end your session', async () => {
    await step('resetting your own password warns first and ends the session', async () => {
      renderAdmin()
      const row = within(await screen.findByTestId('user-row-andreja'))
      fireEvent.click(row.getByRole('button', { name: 'Reset password' }))
      expect(screen.getByTestId('self-reset-warning')).toHaveTextContent('ends your session')
      fireEvent.change(row.getByLabelText('New password for andreja'), { target: { value: 'a-good-password' } })
      vi.mocked(resources.patchUser).mockResolvedValueOnce(users[0])
      fireEvent.click(row.getByRole('button', { name: 'Set password' }))
      expect(await screen.findByRole('dialog', { name: 'Log in' })).toBeInTheDocument()
      expect(screen.getByTestId('auth-notice')).toHaveTextContent('Password changed — log in again')
      expect(screen.queryByTestId('user-row-andreja')).not.toBeInTheDocument() // admin content gone: not logged in
      expect(document.body.innerHTML).not.toContain('a-good-password')
    })
    fresh()
    await step("resetting someone else's password does not warn and does not end the session", async () => {
      renderAdmin()
      const row = within(await screen.findByTestId('user-row-maria'))
      fireEvent.click(row.getByRole('button', { name: 'Reset password' }))
      expect(screen.queryByTestId('self-reset-warning')).not.toBeInTheDocument()
      fireEvent.change(row.getByLabelText('New password for maria'), { target: { value: 'a-good-password' } })
      vi.mocked(resources.patchUser).mockResolvedValueOnce(users[1])
      fireEvent.click(row.getByRole('button', { name: 'Set password' }))
      expect(await screen.findByText('Password reset for maria.')).toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'Log in' })).not.toBeInTheDocument()
      expect(screen.getByTestId('user-row-maria')).toBeInTheDocument()
    })
  })
})

describe('REQ_FE_004 teams card', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockAdminData()
  })

  it('REQ_FE_004 add team suggests a tag from the name and sends name, tag and color', async () => {
    expect(suggestTag('Revenue Operations'), 'two words give their initials').toBe('RO')
    expect(suggestTag('Platform'), 'one word gives its first three letters').toBe('PLA')
    expect(suggestTag('Customer Success & Support'), 'an ampersand is skipped').toBe('CSS')
    vi.mocked(resources.createTeam).mockResolvedValue({ id: 9, name: 'Data Platform', tag: 'DP', default_color: '#4338ca', roadmap_id: 1, created_at: '' })
    renderAdmin()
    fireEvent.click(await screen.findByRole('button', { name: 'Add team' }))
    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Data Platform' } })
    expect(screen.getByLabelText('Tag')).toHaveValue('DP')
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))
    await waitFor(() =>
      expect(resources.createTeam).toHaveBeenCalledWith({ name: 'Data Platform', tag: 'DP', default_color: '#4338ca' }),
    )
    expect(await screen.findByLabelText('Name of Data Platform')).toBeInTheDocument()
  })

  it('REQ_FE_004 renaming saves on blur, and a duplicate name shows inline', async () => {
    renderAdmin()
    const input = await screen.findByLabelText('Name of Onboarding')
    vi.mocked(resources.patchTeam).mockRejectedValueOnce(httpError(409, 'duplicate_name'))
    fireEvent.change(input, { target: { value: 'Revenue Ops' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Another team already has that name.')).toBeInTheDocument()
    expect(resources.patchTeam).toHaveBeenCalledWith(1, { name: 'Revenue Ops' })
  })

  it('REQ_AUTH_007 admin cards keep the value on a 401 and say "Not saved — log in and save again"', async () => {
    renderAdmin()
    const input = await screen.findByLabelText('Name of Onboarding')
    vi.mocked(resources.patchTeam).mockRejectedValueOnce(httpError(401, 'unauthorized'))
    fireEvent.change(input, { target: { value: 'Onboarding 2' } })
    fireEvent.blur(input)
    expect(await screen.findByText('Not saved — log in and save again')).toBeInTheDocument()
    expect(input).toHaveValue('Onboarding 2')
  })

  it('REQ_FE_004 delete is disabled with the reason while the team\'s roadmap holds roadmap items, and confirmed in a dialog naming the team', async () => {
    renderAdmin()
    const withItems = within(await screen.findByTestId('team-row-1'))
    await waitFor(() => expect(withItems.getByRole('button', { name: 'Delete' })).toBeDisabled())
    expect(withItems.getByText('1 roadmap item')).toBeInTheDocument()
    const del = withItems.getByRole('button', { name: 'Delete' })
    expect(del).toHaveAttribute('title', 'Its roadmap has items — can’t delete')
    expect(del).toHaveAccessibleDescription('Its roadmap has items — can’t delete')
    expect(del.closest('td')?.querySelector('div')).toBeNull() // no visible text under the button
    expect(del.className).toContain('text-text-3')
    // one line: every cell vertically centered, same padding
    const row = screen.getByTestId('team-row-1')
    expect(row.className).toContain('align-middle')
    expect(row.className).not.toContain('align-top')

    const empty = within(screen.getByTestId('team-row-2'))
    expect(empty.getByText('Empty roadmap')).toBeInTheDocument()
    expect(empty.getByRole('button', { name: 'Delete' })).toBeEnabled()
    fireEvent.click(empty.getByRole('button', { name: 'Delete' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Delete team' }))
    expect(dialog.getByText(/Revenue Ops/)).toBeInTheDocument()
    expect(resources.deleteTeam).not.toHaveBeenCalled()
    vi.mocked(resources.deleteTeam).mockResolvedValue(undefined)
    fireEvent.click(dialog.getByRole('button', { name: 'Delete team' }))
    await waitFor(() => expect(resources.deleteTeam).toHaveBeenCalledWith(2))
    await waitFor(() => expect(screen.queryByTestId('team-row-2')).not.toBeInTheDocument())
  })
})

describe('REQ_FE_080 icon labels card', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockAdminData()
  })

  it('REQ_FE_080 editing a label and saving PUTs only the changed icon; a rejected (blank) label shows an error on its row and is not marked saved; "Reset all to defaults" fills the inputs with the default labels (saved only on Save)', async () => {
    await step('editing a label and saving PUTs only the changed icon', async () => {
      vi.mocked(resources.putIconLabel).mockResolvedValue({ key: 'star', label: 'Top priority' })
      renderAdmin()
      const input = await screen.findByLabelText('Label for star')
      fireEvent.change(input, { target: { value: 'Top priority' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save labels' }))
      await waitFor(() => expect(resources.putIconLabel).toHaveBeenCalledTimes(1))
      expect(resources.putIconLabel).toHaveBeenCalledWith('star', 'Top priority')
      expect(await screen.findByText('Labels saved.')).toBeInTheDocument()
    })

    await step('a rejected (blank) label shows an error on its row and is not marked saved', async () => {
      cleanup()
      vi.resetAllMocks()
      mockAdminData()
      vi.mocked(resources.putIconLabel).mockRejectedValue(httpError(422, 'validation_failed', { label: 'required' }))
      renderAdmin()
      fireEvent.change(await screen.findByLabelText('Label for clock'), { target: { value: '   ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save labels' }))
      expect(await screen.findByText(/A label is required/)).toBeInTheDocument()
      expect(screen.queryByText('Labels saved.')).not.toBeInTheDocument()
    })

    await step('"Reset all to defaults" fills the inputs with the default labels (saved only on Save)', async () => {
      cleanup()
      vi.resetAllMocks()
      mockAdminData()
      vi.mocked(resources.fetchIcons).mockResolvedValue([{ key: 'star', label: 'Custom' }])
      renderAdmin()
      expect(await screen.findByLabelText('Label for star')).toHaveValue('Custom')
      fireEvent.click(screen.getByRole('button', { name: 'Reset all to defaults' }))
      expect(screen.getByLabelText('Label for star')).toHaveValue('High priority')
      expect(resources.putIconLabel).not.toHaveBeenCalled()
    })
  })

  it('REQ_DAT_028 a label padded with NBSP and U+200B is sent trimmed, and an unchanged one sends nothing', async () => {
    vi.mocked(resources.putIconLabel).mockResolvedValue({ key: 'star', label: 'Top priority' })
    renderAdmin()
    const input = await screen.findByLabelText('Label for star')
    fireEvent.change(input, { target: { value: '\u00a0\u200bTop priority\u200b\u00a0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }))
    await waitFor(() => expect(resources.putIconLabel).toHaveBeenCalledWith('star', 'Top priority'))
    expect(resources.putIconLabel).toHaveBeenCalledTimes(1)
    vi.mocked(resources.putIconLabel).mockClear()
    fireEvent.change(input, { target: { value: '\u200bTop priority\u00a0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save labels' }))
    expect(await screen.findByText('Labels saved.')).toBeInTheDocument()
    expect(resources.putIconLabel).not.toHaveBeenCalled()
  })
})

describe('REQ_AUD_016 / REQ_AUD_008 audit log card', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockAdminData()
  })

  it('REQ_AUD_008 the retention badge shows the configured days next to the verbatim notice', async () => {
    renderAdmin()
    await waitFor(() => expect(screen.getByTestId('retention-badge')).toHaveTextContent('Retention 365 days'))
    expect(screen.getByTestId('audit-notice').textContent).toBe(
      'Set by audit_retention_days in overlens.conf (default 365), not editable here. Older rows are removed automatically; nobody can delete entries by hand.',
    )
  })

  it('REQ_AUD_016 filters are sent to the list and carried by the CSV link; paging keeps them', async () => {
    renderAdmin()
    const csv = await screen.findByTestId('audit-csv')
    expect(csv).toHaveAttribute('href', expect.stringMatching(/\/api\/admin\/audit\/export\.csv$/))
    await waitFor(() => expect(resources.fetchAudit).toHaveBeenLastCalledWith({}, 25, 0))
    expect(await screen.findByText('user.create')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'maria' } })
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'update' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'deliverable' } })
    fireEvent.change(screen.getByLabelText('Team'), { target: { value: 'Onboarding' } })
    fireEvent.change(screen.getByLabelText('Roadmap item'), { target: { value: 'SSO' } })
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))

    const filters = { user: 'maria', action: 'update', type: 'deliverable', team: 'Onboarding', deliverable: 'SSO', from: '2026-09-01', to: '2026-09-30' }
    await waitFor(() => expect(resources.fetchAudit).toHaveBeenLastCalledWith(filters, 25, 0))
    const params = new URL(screen.getByTestId('audit-csv').getAttribute('href') as string, 'http://x').searchParams
    expect(Object.fromEntries(params)).toEqual(filters) // same filters, no limit/offset

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(resources.fetchAudit).toHaveBeenLastCalledWith(filters, 25, 25))
    expect(screen.getByText(/Showing 26–50 of 60/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }))
    await waitFor(() => expect(resources.fetchAudit).toHaveBeenLastCalledWith(filters, 25, 0))
  })
})

describe('REQ_FE_135 storage card', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockAdminData()
  })

  it('REQ_FE_135 shows database, logs and disk space', async () => {
    renderAdmin()
    const f = await screen.findByTestId('storage-figures')
    expect(f).toHaveTextContent('5.0 MB')
    expect(f).toHaveTextContent('2 KB in 3 files')
    expect(f).toHaveTextContent('20.0 GB free of 100.0 GB')
  })

  it('REQ_FE_139 starts with the running build, leaving out what a build did not stamp', async () => {
    renderAdmin()
    expect(await screen.findByTestId('build-line')).toHaveTextContent('Version 1.0.0 · built 2026-10-21 14:02 UTC · commit abc1234')
  })

  it('REQ_FE_139 an unstamped build reads "Version dev"', async () => {
    vi.mocked(resources.fetchStorage).mockResolvedValue({ version: 'dev', build_time: 'unknown', commit: 'unknown', db_bytes: 1, log_bytes: 1, log_files: 1, disk_free_bytes: 1, disk_total_bytes: 2 })
    renderAdmin()
    expect(await screen.findByTestId('build-line')).toHaveTextContent(/^Version dev$/)
  })

  it('REQ_FE_135 shows an error when the figures cannot be loaded', async () => {
    vi.mocked(resources.fetchStorage).mockRejectedValue(new Error('x'))
    renderAdmin()
    expect(await screen.findByText('Could not load the storage figures.')).toBeInTheDocument()
  })
})
