// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SleepEpoch, SleepStage } from '@/src/lib/sleep-stages'
import {
  compareNightsToWatch,
  compareStages,
  deviationStats,
  meanWithin,
  nearestWithin,
  pairNight,
  type DeviationNightInput,
} from '../watch-deviation'

const T = Date.UTC(2026, 9, 10, 23)
const S = 1000
const MIN = 60 * S

const epoch = (minutes: number, stage: SleepStage): SleepEpoch =>
  ({ start: T + minutes * MIN, duration: 5 * MIN, stage, heartRate: null, hrv: null, breathingRate: null, movement: null })

describe('nearestWithin', () => {
  const points = [{ t: 0, v: 60 }, { t: 40 * S, v: null }, { t: 50 * S, v: 70 }, { t: 100 * S, v: 80 }]

  it('takes the nearest non-null reading, the earlier one on a tie, and includes the window edge', () => {
    expect(nearestWithin(points, 45 * S, 60 * S)).toBe(70) // 40 s is null, so 50 s (5 s away) wins
    expect(nearestWithin(points, 75 * S, 60 * S)).toBe(70) // 50 s and 100 s are both 25 s away
    expect(nearestWithin(points, 160 * S, 60 * S)).toBe(80) // exactly 60 s away
    expect(nearestWithin(points, 161 * S, 60 * S)).toBeNull()
    expect(nearestWithin([], 0, 60 * S)).toBeNull()
  })
})

describe('meanWithin', () => {
  it('averages the non-null readings inside the window and is null without any', () => {
    const points = [{ t: 0, v: 10 }, { t: 60 * S, v: 20 }, { t: 120 * S, v: null }, { t: 400 * S, v: 30 }]
    expect(meanWithin(points, 60 * S, 300 * S)).toBe(15) // 400 s is 340 s away
    expect(meanWithin(points, 700 * S, 300 * S)).toBe(30)
    expect(meanWithin(points, 2000 * S, 300 * S)).toBeNull()
  })
})

describe('deviationStats', () => {
  it('computes MAE, bias (pod − Watch), nearest-rank p90, Pearson r and coverage', () => {
    // pod − Watch: +2, −2, +4, +6 → |err| 2, 2, 4, 6
    const out = deviationStats([[62, 60], [58, 60], [65, 61], [70, 64]], 5)
    expect(out).toMatchObject({ n: 4, watchSamples: 5, coverage: 0.8, mae: 3.5, bias: 2.5, p90: 6 })
    // pod mean 63.75, Watch mean 61.25: cov 26.25, Σdp² 76.75, Σdw² 10.75
    expect(out.r).toBeCloseTo(26.25 / Math.sqrt(76.75 * 10.75), 12)
  })

  it('returns nulls, not zeros, without pairs and coverage only when the Watch had samples', () => {
    expect(deviationStats([], 3)).toEqual({ n: 0, watchSamples: 3, coverage: 0, mae: null, bias: null, p90: null, r: null })
    expect(deviationStats([], 0)).toEqual({ n: 0, watchSamples: 0, coverage: null, mae: null, bias: null, p90: null, r: null })
  })

  it('has no correlation for a single pair or a constant series', () => {
    expect(deviationStats([[60, 58]], 1)).toMatchObject({ mae: 2, bias: 2, p90: 2, r: null })
    // n = 10: nearest rank ceil(9) is the 9th smallest error, not the maximum.
    const ten = Array.from({ length: 10 }, (_, i) => [60 + i + 1, 60] as [number, number])
    expect(deviationStats(ten, 10).p90).toBe(9)
    expect(deviationStats([[60, 58], [70, 58]], 2)).toMatchObject({ mae: 7, bias: 7, r: null })
  })
})

describe('pairNight', () => {
  it('uses ±60 s for HR, ±150 s for breathing and the ±5 min pod mean for HRV', () => {
    const pod = {
      heartRate: [{ t: T + 59 * S, v: 62 }, { t: T + 1000 * S + 61 * S, v: 99 }],
      breathingRate: [{ t: T + 150 * S, v: 15 }, { t: T + 1000 * S + 151 * S, v: 30 }],
      hrv: [{ t: T - 300 * S, v: 40 }, { t: T + 120 * S, v: 60 }, { t: T + 301 * S, v: 500 }],
    }
    const watch = {
      heartRate: [{ t: T, v: 60 }, { t: T + 1000 * S, v: 60 }],
      breathingRate: [{ t: T, v: 14 }, { t: T + 1000 * S, v: 14 }],
      hrvSdnn: [{ t: T, v: 45 }],
    }
    expect(pairNight(pod, watch)).toEqual({ heartRate: [[62, 60]], breathingRate: [[15, 14]], hrv: [[50, 45]] })
  })
})

describe('compareStages', () => {
  it('scores epochs at their midpoint and counts minutes over the scored epochs only', () => {
    const epochs = [epoch(0, 'light'), epoch(5, 'deep'), epoch(10, 'rem'), epoch(15, 'wake')]
    const reference = [
      { start: T, end: T + 10 * MIN, stage: 'light' as const },
      { start: T + 10 * MIN, end: T + 15 * MIN, stage: 'rem' as const },
    ]
    // 3 scored epochs, 2 match. Chance: light 1/3·2/3 + rem 1/3·1/3 = 1/3, so kappa = (2/3 − 1/3) / (2/3) = 0.5.
    const out = compareStages(epochs, reference)
    expect(out).toMatchObject({ epochs: 3, recall: { wake: null, light: 0.5, deep: null, rem: 1 } })
    expect(out?.accuracy).toBeCloseTo(2 / 3, 12)
    expect(out?.kappa).toBeCloseTo(0.5, 12)
    expect(out?.podMinutes).toEqual({ wake: 0, light: 5, deep: 5, rem: 5 })
    expect(out?.watchMinutes).toEqual({ wake: 0, light: 10, deep: 0, rem: 5 })
  })

  it('is null when no epoch falls inside a Watch segment', () => {
    expect(compareStages([epoch(0, 'light')], [{ start: T + 60 * MIN, end: T + 90 * MIN, stage: 'deep' }])).toBeNull()
    expect(compareStages([], [])).toBeNull()
  })
})

describe('compareNightsToWatch', () => {
  const night = (id: number, offsetMs: number, hr: Array<[pod: number, watch: number]>): DeviationNightInput => ({
    sleepRecordId: id,
    enteredBedAt: new Date(T + offsetMs),
    leftBedAt: new Date(T + offsetMs + 4.25 * 3_600_000),
    pod: { heartRate: hr.map(([p], i) => ({ t: T + offsetMs + i * 5 * MIN, v: p })), breathingRate: [], hrv: [] },
    watch: { heartRate: hr.map(([, w], i) => ({ t: T + offsetMs + i * 5 * MIN, v: w })), breathingRate: [{ t: T + offsetMs, v: 14 }], hrvSdnn: [] },
    epochs: [],
    reference: [],
  })

  it('reports each night and pools the summary over every pair, not a mean of nightly means', () => {
    const out = compareNightsToWatch([night(1, 0, [[70, 60]]), night(2, 86_400_000, [[62, 60], [62, 60], [62, 60]])])
    expect(out.nights.map(n => [n.sleepRecordId, n.hours, n.heartRate.mae])).toEqual([[1, 4.3, 10], [2, 4.3, 2]])
    // Pooled: (10 + 2 + 2 + 2) / 4 = 4; the mean of nightly MAEs would be 6.
    expect(out.summary).toMatchObject({ nights: 2, heartRate: { n: 4, watchSamples: 4, coverage: 1, mae: 4, bias: 4 } })
    expect(out.summary.breathingRate).toEqual({ n: 0, watchSamples: 2, coverage: 0, mae: null, bias: null, p90: null, r: null })
    expect(out.summary.hrv).toMatchObject({ watchSamples: 0, coverage: null })
    expect(out.summary.stages).toBeNull()
    expect(out.nights[0].stages).toBeNull()
  })

  it('rounds the reported statistics', () => {
    const out = compareNightsToWatch([night(1, 0, [[61, 60], [63, 60], [60, 60]])])
    expect(out.nights[0].heartRate).toMatchObject({ mae: 1.33, bias: 1.33, coverage: 1 })
    expect(out.summary.nights).toBe(1)
  })

  it('returns an empty report without nights', () => {
    const out = compareNightsToWatch([])
    expect(out.nights).toEqual([])
    expect(out.summary).toMatchObject({ nights: 0, heartRate: { n: 0, watchSamples: 0, coverage: null, mae: null }, stages: null })
  })
})
