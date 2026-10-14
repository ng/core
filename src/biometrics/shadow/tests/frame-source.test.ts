// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openShadowFrameSource } from '../frame-source'
import { publishProspectiveFrame, subscribeProspectiveFrames } from '../../../streaming/prospectiveFrameTap'
const start = 1700000000000
const cleanups: (() => void)[] = []
const resetArrivalClock = () => {
  (globalThis as { __sleepypodProspectiveObservedAtMs?: number }).__sleepypodProspectiveObservedAtMs = undefined
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(start)
})
afterEach(() => {
  cleanups.splice(0).forEach(close => close())
  resetArrivalClock()
  vi.useRealTimers()
})
function setup(maximumFrames = 2, maximumBytes = 100000) {
  const fail = vi.fn(), context = { activeSides: ['left'], leftOccupied: true, rightOccupied: false, pumpContextKnown: false }
  const controller = new AbortController()
  const source = openShadowFrameSource({ startMs: start, endMs: start + 1000, signal: controller.signal,
    budgets: { maximumFrames, maximumBytes, maximumEventAgeMs: 10000, maximumFutureSkewMs: 0 }, context: () => context, fail })
  cleanups.push(source.close)
  return { source, iterator: source.frames[Symbol.asyncIterator](), fail, context, controller }
}
const frame = () => ({ type: 'piezo-dual', ts: start / 1000, freq: 500, left1: [-2147483648, 0, 2147483647], right1: [1, -2, 3] })
function publish(value = frame(), backlog = false) {
  publishProspectiveFrame(value, backlog, Date.now())
}
it('snapshots signed int32 waveforms and arrival context without retaining mutable stream data', async () => {
  const { iterator, context } = setup()
  const value = frame()
  publish(value)
  value.left1[0] = 99
  context.activeSides[0] = 'right'
  const row = (await iterator.next()).value
  expect(row).toMatchObject({ type: 'frame', observedAtMs: start, record: { type: 'piezo-dual', freq: 500 }, context: { activeSides: ['left'] } })
  const bytes = Buffer.from(row.record.left1, 'base64')
  expect([0, 4, 8].map(offset => bytes.readInt32LE(offset))).toEqual([-2147483648, 0, 2147483647])
})
it('excludes backlog and unrelated sensors from prospective evidence', async () => {
  const { iterator, fail } = setup()
  publish(frame(), true)
  publishProspectiveFrame({ type: 'capSense' }, false, start)
  const next = iterator.next()
  publish()
  expect((await next).value.record.type).toBe('piezo-dual')
  expect(fail).not.toHaveBeenCalled()
})
it('preserves only the bounded pump fields used by the shared gate', async () => {
  const { iterator } = setup()
  publishProspectiveFrame({ type: 'frzHealth', ts: start / 1000, left: { pumpRpm: 0, pump: { rpm: '1200', duty: 30 }, unrelated: 'discard' }, right: { duty: 0 } }, false, start)
  expect((await iterator.next()).value.record).toEqual({ type: 'frzHealth', ts: start / 1000, left: { pumpRpm: 0, pump: { rpm: '1200', duty: 30 } }, right: { duty: 0 } })
})
it.each(['frames', 'bytes'])('fails and closes on %s queue overflow', async (kind) => {
  const { iterator, fail } = setup(1, kind === 'bytes' ? 1 : 100000)
  publish()
  if (kind === 'frames') publish()
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
  publish()
  expect(fail).toHaveBeenCalledOnce()
})
it.each([Array(5001).fill(0), [2147483648], [1.5], [NaN]])('rejects malformed or oversized channel before queueing', async (left1) => {
  const { iterator, fail } = setup()
  publish({ ...frame(), left1 })
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
})
it('ends pending reads and unsubscribes on abort', async () => {
  const { iterator, controller, fail } = setup()
  const pending = iterator.next()
  controller.abort()
  expect((await pending).done).toBe(true)
  publish()
  expect(fail).not.toHaveBeenCalled()
})
it('reports unread input at collection end instead of silently dropping it', async () => {
  const { iterator, fail } = setup()
  publish()
  await vi.advanceTimersByTimeAsync(1000)
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
})
it('ends an empty collection normally and rejects concurrent consumers', async () => {
  const { source, iterator, fail } = setup()
  expect(() => source.frames[Symbol.asyncIterator]()).toThrow(/one consumer/)
  const pending = iterator.next()
  await expect(iterator.next()).rejects.toThrow(/Concurrent/)
  await vi.advanceTimersByTimeAsync(1000)
  expect((await pending).done).toBe(true)
  expect(fail).not.toHaveBeenCalled()
})
it('isolates subscriber faults so live ingestion and other subscribers continue', () => {
  const failed = vi.fn(), healthy = vi.fn()
  cleanups.push(subscribeProspectiveFrames({ frame: () => {
    throw new Error('consumer failed')
  }, failed }))
  cleanups.push(subscribeProspectiveFrames({ frame: healthy, failed: () => {} }))
  expect(() => publish()).not.toThrow()
  publish()
  expect(failed).toHaveBeenCalledOnce()
  expect(healthy).toHaveBeenCalledTimes(2)
})
it('unwinds subscriptions and timers when subscriber admission fails', () => {
  for (let i = 0; i < 4; i++) cleanups.push(subscribeProspectiveFrames({ frame: () => {}, failed: () => {} }))
  expect(() => setup()).toThrow(/subscriber limit/)
  expect(vi.getTimerCount()).toBe(0)
})
it.each([-20, 1])('fails on stale/future event timestamps (%s seconds)', async (seconds) => {
  const { iterator, fail } = setup()
  publish({ ...frame(), ts: start / 1000 + seconds })
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
})
it('keeps null pump values, omits missing sides and skips the frequency when absent', async () => {
  const { iterator, fail } = setup(4)
  publishProspectiveFrame({ type: 'frzHealth', ts: start / 1000, left: { pumpRpm: null, rpm: 0 } }, false, start)
  publishProspectiveFrame({ type: 'frzHealth', ts: start / 1000, right: { duty: 1 } }, false, start)
  publishProspectiveFrame({ type: 'piezo-dual', ts: start / 1000, left1: [1], right1: [2] }, false, start)
  expect((await iterator.next()).value.record).toEqual({ type: 'frzHealth', ts: start / 1000, left: { pumpRpm: null, rpm: 0 } })
  expect((await iterator.next()).value.record).toEqual({ type: 'frzHealth', ts: start / 1000, right: { duty: 1 } })
  const waveform = (await iterator.next()).value.record
  expect(waveform).not.toHaveProperty('freq')
  expect(Buffer.from(waveform.left1, 'base64').readInt32LE(0)).toBe(1)
  expect(fail).not.toHaveBeenCalled()
})
it.each([
  { left: { pumpRpm: 'fast' } }, { left: { pumpRpm: true } }, { left: 'left' }, { left: [] }, { right: { pump: 'none' } }, { right: { pump: [1] } },
])('fails on malformed pump context %#', async (sides) => {
  const { iterator, fail } = setup()
  publishProspectiveFrame({ type: 'frzHealth', ts: start / 1000, ...sides }, false, start)
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
})
it('rejects windows that are malformed or too far ahead', () => {
  const budgets = { maximumFrames: 1, maximumBytes: 1000, maximumEventAgeMs: 10000, maximumFutureSkewMs: 0 }
  const open = (startMs: number, endMs: number) => openShadowFrameSource({ startMs, endMs, signal: new AbortController().signal, budgets, context: () => null, fail: () => {} })
  expect(() => open(-1, start)).toThrow('Invalid prospective source window')
  expect(() => open(start, start)).toThrow('Invalid prospective source window')
  expect(() => open(start, start + 8 * 86400000)).toThrow('Invalid prospective source window')
  expect(() => open(start + 86400000, start + 7 * 86400000 + 1000)).toThrow('Invalid prospective source window')
  expect(() => open(1.5, start)).toThrow('Invalid prospective source window')
  expect(vi.getTimerCount()).toBe(0)
})
it('starts closed when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const fail = vi.fn()
  const source = openShadowFrameSource({ startMs: start, endMs: start + 1000, signal: controller.signal,
    budgets: { maximumFrames: 1, maximumBytes: 1000, maximumEventAgeMs: 10000, maximumFutureSkewMs: 0 }, context: () => null, fail })
  expect((await source.frames[Symbol.asyncIterator]().next()).done).toBe(true)
  publish()
  expect(fail).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it('ignores arrivals outside the window and fails on future or regressing arrival clocks', async () => {
  const { iterator, fail } = setup(4)
  resetArrivalClock()
  publishProspectiveFrame(frame(), false, start - 1)
  vi.setSystemTime(start + 1000)
  publishProspectiveFrame({ ...frame(), ts: (start + 1000) / 1000 }, false, start + 1000)
  expect(fail).not.toHaveBeenCalled()
  vi.setSystemTime(start + 500)
  publishProspectiveFrame({ ...frame(), ts: (start + 500) / 1000 }, false, start + 600)
  expect(fail).toHaveBeenCalledOnce()
  expect((await iterator.next()).done).toBe(true)
  const regressing = setup(4)
  resetArrivalClock()
  publishProspectiveFrame({ ...frame(), ts: (start + 500) / 1000 }, false, start + 500)
  expect(regressing.fail).not.toHaveBeenCalled()
  resetArrivalClock()
  publishProspectiveFrame({ ...frame(), ts: (start + 100) / 1000 }, false, start + 100)
  expect(regressing.fail).toHaveBeenCalledOnce()
  expect((await regressing.iterator.next()).done).toBe(true)
})
it('returns early from iteration and reports unread frames only once the window has ended', async () => {
  const early = setup(4)
  publish()
  expect((await early.iterator.return?.())?.done).toBe(true)
  expect(early.fail).not.toHaveBeenCalled()
  expect((await early.iterator.next()).done).toBe(true)
  const late = setup(4)
  publish()
  vi.setSystemTime(start + 1000)
  expect((await late.iterator.return?.())?.done).toBe(true)
  expect(late.fail).toHaveBeenCalledOnce()
})
it('releases queue byte capacity when a frame is consumed', async () => {
  const { iterator, fail } = setup(1, 1000)
  publish()
  await iterator.next()
  publish()
  expect((await iterator.next()).done).toBe(false)
  expect(fail).not.toHaveBeenCalled()
})
it('isolates a failing consumer notification from the collection timer', async () => {
  const { iterator, fail } = setup()
  fail.mockImplementation(() => {
    throw new Error('consumer failed')
  })
  publish()
  await expect(vi.advanceTimersByTimeAsync(1000)).resolves.toBeDefined()
  expect((await iterator.next()).done).toBe(true)
})
