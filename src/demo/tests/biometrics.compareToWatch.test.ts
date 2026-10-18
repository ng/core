import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { biometrics } from '../handlers/biometrics'
import { demoNights } from '../history'
import { DAY } from '../util'

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

const NOW = Date.UTC(2026, 9, 10, 12)

describe('demo biometrics.compareToWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the finished nights of the last 14 days, oldest first, with a pod that reads a little high', async () => {
    const out = await required(biometrics.compareToWatch)({ side: 'left', minHours: 3 })
    const expected = demoNights('left')
      .filter(n => n.leftBedAt !== null && n.enteredBedAt.getTime() >= NOW - 14 * DAY && n.sleepDurationSeconds >= 3 * 3600)
      .map(n => n.id)
      .reverse()
    expect(out.nights.map(n => n.sleepRecordId)).toEqual(expected)
    expect(out.nights.length).toBeGreaterThan(5)
    expect(out.summary.nights).toBe(out.nights.length)
    expect(out.summary.heartRate.n).toBe(out.nights.reduce((s, n) => s + n.heartRate.n, 0))
    expect(out.summary.heartRate.bias).toBeGreaterThan(0)
    expect(out.summary.breathingRate.bias).toBeGreaterThan(0)
    expect(out.summary.hrv.watchSamples).toBe(2 * out.nights.length)
    expect(out.summary.stages?.epochs).toBeGreaterThan(0)
    expect(out.hrvNote).toContain('SDNN')
    // Deterministic across calls, like the rest of the demo history.
    expect(await required(biometrics.compareToWatch)({ side: 'left', minHours: 3 })).toEqual(out)
  })

  it('rejects a reversed window and one over 31 days', async () => {
    await expect(async () => required(biometrics.compareToWatch)({ side: 'left', startDate: new Date(NOW), endDate: new Date(NOW - 1000), minHours: 3 }))
      .rejects.toThrow(/startDate must be before or equal to endDate/)
    await expect(async () => required(biometrics.compareToWatch)({ side: 'left', startDate: new Date(NOW - 32 * DAY), endDate: new Date(NOW), minHours: 3 }))
      .rejects.toThrow(/at most 31 days/)
  })
})
