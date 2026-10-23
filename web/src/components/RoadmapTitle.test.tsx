import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { RoadmapTitle } from './RoadmapTitle'
import * as resources from '../api/resources'
import type { Roadmap } from '../api/types'
import { step } from '../testSteps'

vi.mock('../api/resources')

const roadmap: Roadmap = {
  id: 1,
  team_id: 1,
  title: 'Original Title',
 
  range_start: null,
  range_end: null,
  created_at: '',
  updated_at: '',
 
}

describe('REQ_FE_001 roadmap title inline rename', () => {
  beforeEach(() => vi.resetAllMocks())

  it('REQ_FE_001 click opens an input; Enter or blur commits and saves; Esc cancels without saving', async () => {
    await step('click opens an input, Enter commits and saves', async () => {
      cleanup()
      vi.resetAllMocks()
      const onRenamed = vi.fn()
      vi.mocked(resources.renameRoadmap).mockResolvedValue({ ...roadmap, title: 'New Title' })
      render(<RoadmapTitle roadmap={roadmap} onRenamed={onRenamed} />)

      fireEvent.click(screen.getByRole('button', { name: /rename the roadmap/i }))
      const input = screen.getByLabelText('Roadmap title')
      fireEvent.change(input, { target: { value: 'New Title' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      await waitFor(() => expect(resources.renameRoadmap).toHaveBeenCalledWith(1, 'New Title'))
      expect(onRenamed).toHaveBeenCalledWith({ ...roadmap, title: 'New Title' })
    })

    await step('blur also commits', async () => {
      cleanup()
      vi.resetAllMocks()
      vi.mocked(resources.renameRoadmap).mockResolvedValue({ ...roadmap, title: 'Blurred' })
      render(<RoadmapTitle roadmap={roadmap} onRenamed={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: /rename the roadmap/i }))
      const input = screen.getByLabelText('Roadmap title')
      fireEvent.change(input, { target: { value: 'Blurred' } })
      fireEvent.blur(input)

      await waitFor(() => expect(resources.renameRoadmap).toHaveBeenCalledWith(1, 'Blurred'))
    })

    await step('Esc cancels without saving', () => {
      cleanup()
      vi.resetAllMocks()
      render(<RoadmapTitle roadmap={roadmap} onRenamed={vi.fn()} />)

      fireEvent.click(screen.getByRole('button', { name: /rename the roadmap/i }))
      const input = screen.getByLabelText('Roadmap title')
      fireEvent.change(input, { target: { value: 'Discarded' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(screen.getByText('Original Title')).toBeInTheDocument()
      expect(resources.renameRoadmap).not.toHaveBeenCalled()
    })
  })

  it('REQ_AUTH_007 a rejected rename keeps the typed title on screen, marked not saved, and clears once the saved title catches up', async () => {
    vi.mocked(resources.renameRoadmap).mockRejectedValue(new Error('401'))
    const { rerender } = render(<RoadmapTitle roadmap={roadmap} onRenamed={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /rename the roadmap/i }))
    const input = screen.getByLabelText('Roadmap title')
    fireEvent.change(input, { target: { value: 'Typed Title' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByTestId('title-unsaved')).toBeTruthy())
    expect(screen.getByRole('button', { name: /rename the roadmap/i }).textContent).toContain('Typed Title')

    rerender(<RoadmapTitle roadmap={{ ...roadmap, title: 'Typed Title' }} onRenamed={vi.fn()} />)
    await waitFor(() => expect(screen.queryByTestId('title-unsaved')).toBeNull())
  })
})
