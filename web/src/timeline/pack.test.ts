import { describe, expect, it } from 'vitest'
import { localDay } from './axis'
import { packRoadmap, packWorkstream, slotFree, storedRowFor, type PackItem } from './pack'
import { addDeliverable, addMilestone, newRoadmap, ws } from './testkit'
import { step } from '../testSteps'

const t = localDay(new Date())
const item = (id: number, start: number, end: number, storedRow: number, o: Partial<PackItem> = {}): PackItem => ({ kind: 'deliverable', id, start, end, storedRow, copy: false, ...o })
const rowsOf = (items: { id: number; row: number }[]) => Object.fromEntries(items.map((i) => [i.id, i.row]))

describe('REQ_FE_011 sticky packing', () => {
  it('REQ_FE_011 keeps every item in its stored row when it fits, even with a lower row free, and moves only an item whose stored row no longer fits, to the lowest free row', async () => {
    await step('keeps every item in its stored row when it fits, even with a lower row free', () => {
      const p = packWorkstream([item(1, t, t + 5, 2), item(2, t + 10, t + 20, 1), item(3, t + 3, t + 12, 0)], true)
      expect(rowsOf(p.items)).toEqual({ 1: 2, 2: 1, 3: 0 })
      expect(p.relocated).toEqual([])
    })

    await step('moves only an item whose stored row no longer fits, to the lowest free row', () => {
      // 1 and 2 both claim row 0 and now overlap (dates changed elsewhere); row 1 is taken where 2 is
      const p = packWorkstream([item(1, t, t + 10, 0), item(2, t + 5, t + 15, 0), item(3, t + 8, t + 9, 1), item(4, t + 30, t + 40, 0)], true)
      expect(rowsOf(p.items)).toEqual({ 1: 0, 2: 2, 3: 1, 4: 0 })
      expect(p.relocated.map((i) => i.id)).toEqual([2])
    })
  })

  it('REQ_FE_013 repacking its own output changes nothing', () => {
    const first = packWorkstream([item(1, t, t + 10, 0), item(2, t + 5, t + 15, 0), item(3, t + 1, t + 2, 0)], true)
    const again = packWorkstream(first.items.map((i) => ({ ...i, storedRow: i.row })), true)
    expect(rowsOf(again.items)).toEqual(rowsOf(first.items))
    expect(again.relocated).toEqual([])
  })
})

describe('REQ_FE_010 no overlap in a row', () => {
  it('REQ_FE_010 a milestone occupies its single day: neighbours may touch it but not cover it; inclusive days: a bar ending the day another starts overlaps it', async () => {
    await step('a milestone occupies its single day: neighbours may touch it but not cover it', () => {
      const ms = (id: number, day: number, row: number) => item(id, day, day, row, { kind: 'milestone' })
      const p = packWorkstream([item(1, t, t + 9, 0), ms(2, t + 10, 0), item(3, t + 11, t + 20, 0), ms(4, t + 15, 0)], true)
      expect(rowsOf(p.items)).toEqual({ 1: 0, 2: 0, 3: 0, 4: 1 })
      expect(p.relocated.map((i) => i.id)).toEqual([4])
    })

    await step('inclusive days: a bar ending the day another starts overlaps it', () => {
      const p = packWorkstream([item(1, t, t + 10, 0), item(2, t + 10, t + 12, 0)], true)
      expect(rowsOf(p.items)).toEqual({ 1: 0, 2: 1 })
    })
  })
})

describe('REQ_FE_017 copies', () => {
  const build = () => {
    const r = newRoadmap(['A', 'B'])
    const a = ws(r, 'A')
    const b = ws(r, 'B')
    const multi = addDeliverable(r, { start: t, end: t + 10, in: [[a, 0], [b, 1]] })
    const onlyB = addDeliverable(r, { start: t + 20, end: t + 30, in: [[b, 2]] })
    const low = addDeliverable(r, { start: t, end: t + 5, in: [[b, 0]] })
    addMilestone(r, { day: t + 3, in: b, row: 3 })
    return { r, multi, onlyB, low }
  }

  it('REQ_FE_017 REQ_FE_016 with copies off a copy is not shown and the rows it alone used close up; the primary block is never a copy and is always shown; an emptied row closes up on screen', async () => {
    await step('with copies off a copy is not shown and the rows it alone used close up', () => {
      const { r, multi, onlyB, low } = build()
      const on = packRoadmap(r, true)[1]
      const off = packRoadmap(r, false)[1]
      expect(on.shown.map((i) => i.id)).toContain(multi.id)
      expect(on.shown.find((i) => i.id === multi.id)!.copy).toBe(true)
      expect(off.shown.map((i) => i.id)).not.toContain(multi.id)
      expect(on.rows).toBe(4)
      expect(off.rows).toBe(3)
      // nobody changed stored row; only the row numbering on screen closed the gap
      expect(rowsOf(off.items)).toEqual(rowsOf(on.items))
      const disp = (p: typeof on, id: number) => p.shown.find((i) => i.id === id)!.displayRow
      expect([disp(off, low.id), disp(off, onlyB.id)]).toEqual([0, 1])
    })

    await step('the primary block is never a copy and is always shown', () => {
      const { r, multi } = build()
      const a = packRoadmap(r, false)[0]
      expect(a.shown.find((i) => i.id === multi.id)).toMatchObject({ copy: false, displayRow: 0 })
    })

    await step('an emptied row closes up on screen', () => {
      const p = packWorkstream([item(1, t, t + 5, 0), item(2, t, t + 5, 2)], true)
      expect(p.shown.map((i) => i.displayRow)).toEqual([0, 1])
      expect(p.rows).toBe(2)
    })
  })
})

describe('REQ_FE_014/015/016 drop targets', () => {
  it('REQ_FE_014 the row below the last is a new row past every row in use, hidden copies included', () => {
    const p = packWorkstream([item(1, t, t + 5, 0), item(2, t, t + 5, 4, { copy: true })], false)
    expect(p.usedRows).toEqual([0])
    expect(storedRowFor(p, 0)).toBe(0)
    expect(storedRowFor(p, 1)).toBe(5)
    expect(storedRowFor(packWorkstream([], true), 0)).toBe(0)
  })

  it('REQ_FE_015 a slot is free only if nothing else in that row overlaps; the dragged deliverable itself does not count', () => {
    const p = packWorkstream([item(1, t, t + 5, 0), item(2, t + 10, t + 15, 0)], true)
    expect(slotFree(p, 0, t + 6, t + 9, 99)).toBe(true)
    expect(slotFree(p, 0, t + 5, t + 9, 99)).toBe(false)
    expect(slotFree(p, 0, t + 3, t + 9, 1)).toBe(true)
  })
})

describe('REQ_FE_127 workstreams with nothing in them are not shown', () => {
  it('REQ_FE_127 an empty workstream is left out; a deliverable counts in each of its workstreams, with copies on or off; a milestone alone keeps its workstream; a roadmap with nothing has no workstreams shown', async () => {
    const names = (r: ReturnType<typeof newRoadmap>, dupsOn: boolean) => packRoadmap(r, dupsOn).map((w) => w.ws.name)

    await step('an empty workstream is left out, the others keep their order', () => {
      const r = newRoadmap(['A', 'Empty', 'B'])
      addDeliverable(r, { start: t, end: t + 5, in: [[ws(r, 'A'), 0]] })
      addDeliverable(r, { start: t, end: t + 5, in: [[ws(r, 'B'), 0]] })
      expect(names(r, true)).toEqual(['A', 'B'])
    })

    await step('a multi-workstream deliverable counts in each of its workstreams, and switching copies off removes no workstream', () => {
      const r = newRoadmap(['A', 'OnlyCopy', 'Empty'])
      addDeliverable(r, { start: t, end: t + 5, in: [[ws(r, 'A'), 0], [ws(r, 'OnlyCopy'), 0]] })
      expect(names(r, true)).toEqual(['A', 'OnlyCopy'])
      expect(names(r, false)).toEqual(['A', 'OnlyCopy'])
      expect(packRoadmap(r, false)[1].shown).toEqual([]) // the copy itself is gone (REQ_FE_017); its workstream stays
    })

    await step('a milestone alone keeps its workstream', () => {
      const r = newRoadmap(['A', 'B'])
      addMilestone(r, { day: t, in: ws(r, 'B'), row: 0 })
      expect(names(r, true)).toEqual(['B'])
    })

    await step('a roadmap with nothing has no workstreams shown', () => {
      expect(packRoadmap(newRoadmap(['A', 'B']), true)).toEqual([])
    })
  })
})
