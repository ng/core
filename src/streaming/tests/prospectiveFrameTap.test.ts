// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { failProspectiveFrames, publishProspectiveFrame, subscribeProspectiveFrames } from '../prospectiveFrameTap'

afterEach(() => failProspectiveFrames())
const listener = () => ({ frame: vi.fn(), failed: vi.fn() })

it('fans live piezo and health frames out with monotonic observation time and skips backlog', () => {
  const first = listener()
  const unsubscribe = subscribeProspectiveFrames(first)
  publishProspectiveFrame({ type: 'piezo-dual' }, false, 2000)
  publishProspectiveFrame({ type: 'frzHealth' }, false, 1000)
  publishProspectiveFrame({ type: 'piezo-dual' }, true, 3000)
  publishProspectiveFrame({ type: 'capSense' }, false, 3000)
  expect(first.frame.mock.calls.map(([frame, observed]) => [frame.type, observed])).toEqual([['piezo-dual', 2000], ['frzHealth', 2000]])
  unsubscribe()
  publishProspectiveFrame({ type: 'piezo-dual' }, false, 4000)
  expect(first.frame).toHaveBeenCalledTimes(2)
  expect(first.failed).not.toHaveBeenCalled()
})

it('drops a throwing consumer after telling it the stream failed and bounds subscribers', () => {
  const broken = {
    frame: vi.fn(() => {
      throw new Error('consumer bug')
    }),
    failed: vi.fn(() => {
      throw new Error('still broken')
    }),
  }
  const healthy = listener()
  subscribeProspectiveFrames(broken)
  subscribeProspectiveFrames(healthy)
  expect(() => publishProspectiveFrame({ type: 'piezo-dual' }, false, 5000)).not.toThrow()
  expect(broken.failed).toHaveBeenCalledTimes(1)
  publishProspectiveFrame({ type: 'piezo-dual' }, false, 6000)
  expect(broken.frame).toHaveBeenCalledTimes(1)
  expect(healthy.frame).toHaveBeenCalledTimes(2)
  const extra = [listener(), listener(), listener()]
  for (const row of extra) subscribeProspectiveFrames(row)
  expect(() => subscribeProspectiveFrames(listener())).toThrow('subscriber limit')
  failProspectiveFrames()
  expect(healthy.failed).toHaveBeenCalledTimes(1)
  expect(extra.every(row => row.failed.mock.calls.length === 1)).toBe(true)
  expect(() => subscribeProspectiveFrames(listener())).not.toThrow()
})
