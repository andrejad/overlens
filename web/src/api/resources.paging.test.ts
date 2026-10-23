import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { fetchTeams } from './resources'
import { step } from '../testSteps'

afterEach(() => vi.restoreAllMocks())

function pages(total: number) {
  const calls: { limit: number; offset: number }[] = []
  vi.spyOn(api, 'get').mockImplementation(async (_url, config) => {
    const { limit, offset } = config!.params as { limit: number; offset: number }
    calls.push({ limit, offset })
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ id: offset + i + 1 }))
    return { data: { items, total } } as never
  })
  return calls
}

describe('REQ_FE_004 every team is read, page by page', () => {
  it('REQ_FE_004 fetchTeams pages through 141 teams with limit 200 and returns them all; more than 200 teams take several requests, in order, without duplicates', async () => {
    await step('fetchTeams pages through 141 teams with limit 200 and returns them all', async () => {
      const calls = pages(141)
      expect(await fetchTeams()).toHaveLength(141)
      expect(calls).toEqual([{ limit: 200, offset: 0 }])
    })

    await step('more than 200 teams take several requests, in order, without duplicates', async () => {
      vi.restoreAllMocks()
      const calls = pages(450)
      const all = await fetchTeams()
      expect(all).toHaveLength(450)
      expect(new Set(all.map((t) => t.id)).size).toBe(450)
      expect(calls.map((c) => c.offset)).toEqual([0, 200, 400])
    })
  })
})
