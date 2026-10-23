import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { step } from '../testSteps'
import { addDependency, fetchCompanyTrace, fetchDependencyCandidates, removeDependency, deleteWorkstream } from './resources'

afterEach(() => vi.restoreAllMocks())

const d = (id: number) => ({ kind: 'deliverable' as const, id })
const m = (id: number) => ({ kind: 'milestone' as const, id })

describe('REQ_DEP_023 REQ_DEP_026 dependency calls with milestones (docs/API.md "Milestone dependencies (Phase 9)")', () => {
  it('REQ_DEP_023 REQ_DEP_019 REQ_DEP_026 REQ_DEP_028 the dependency client calls use the right route and body for each kind', async () => {
    await step('adding posts to the dependent\'s collection with the prerequisite\'s kind and id', async () => {
      const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} } as never)
      await addDependency(d(2), d(1))
      await addDependency(d(2), m(7)) // a deliverable depends on a milestone
      await addDependency(m(7), d(1)) // a milestone depends on a deliverable
      await addDependency(m(7), m(8))
      expect(post.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        ['/deliverables/2/dependencies', { from_kind: 'deliverable', from_id: 1 }],
        ['/deliverables/2/dependencies', { from_kind: 'milestone', from_id: 7 }],
        ['/milestones/7/dependencies', { from_kind: 'deliverable', from_id: 1 }],
        ['/milestones/7/dependencies', { from_kind: 'milestone', from_id: 8 }],
      ])
    })
    vi.restoreAllMocks()
    await step('removing always names the kind of the prerequisite', async () => {
      const del = vi.spyOn(api, 'delete').mockResolvedValue({ data: {} } as never)
      await removeDependency(d(2), d(1))
      await removeDependency(d(2), m(7))
      await removeDependency(m(7), d(1))
      await removeDependency(m(7), m(8))
      expect(del.mock.calls.map((c) => c[0])).toEqual([
        '/deliverables/2/dependencies/deliverable/1',
        '/deliverables/2/dependencies/milestone/7',
        '/milestones/7/dependencies/deliverable/1',
        '/milestones/7/dependencies/milestone/8',
      ])
    })
    vi.restoreAllMocks()
    await step('the candidates of a milestone come from the milestone route; a deliverable keeps its own', async () => {
      const get = vi.spyOn(api, 'get').mockResolvedValue({ data: [] } as never)
      await fetchDependencyCandidates(5)
      await fetchDependencyCandidates(5, 'milestone')
      expect(get.mock.calls.map((c) => c[0])).toEqual([
        '/deliverables/5/dependency-candidates',
        '/milestones/5/dependency-candidates',
      ])
    })
    vi.restoreAllMocks()
    await step('the trace uses the typed route', async () => {
      const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { root: d(3), prerequisites: [], dependents: [], edges: [] } } as never)
      await fetchCompanyTrace('deliverable', 3)
      await fetchCompanyTrace('milestone', 4)
      expect(get.mock.calls.map((c) => c[0])).toEqual(['/company/trace/deliverable/3', '/company/trace/milestone/4'])
    })
  })
})

describe('REQ_API_025 workstream delete call', () => {
  it('REQ_API_025 sends only target=<id> while the workstream holds anything, nothing otherwise', async () => {
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ data: {} } as never)
    await deleteWorkstream(1, 3)
    await deleteWorkstream(2)
    expect(del.mock.calls.map((c) => [c[0], (c[1] as { params?: unknown }).params])).toEqual([
      ['/workstreams/1', { target: 3 }],
      ['/workstreams/2', undefined],
    ])
  })
})
