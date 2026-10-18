/**
 * Pod-vs-Apple-Watch deviation per night: each Watch sample is paired with the
 * pod reading(s) near it in time, then summarized. Deviation is always
 * pod − Watch, so a positive bias means the pod reads high. Ported from the
 * offline analysis/watch-deviation scripts so the app, API and MCP report the
 * same numbers.
 */
import { z } from 'zod'
import { scoreAgainstReference, type SleepEpoch, type SleepStage, type SleepStageBlock } from '@/src/lib/sleep-stages'

/** A pod reading (null when the pod had none) or a Watch sample, at unix ms. */
export interface TimedValue { t: number, v: number | null }
export type DeviationPair = readonly [pod: number, watch: number]

/**
 * How far a pod reading may sit from a Watch sample. HR and breathing take
 * the nearest pod reading; HRV averages every pod reading in the window
 * because the Watch's SDNN summarizes a few minutes of beats.
 */
export const WATCH_PAIRING_WINDOW_MS = { heartRate: 60_000, breathingRate: 150_000, hrv: 300_000 } as const

export const HRV_NOTE = 'HRV deviation is not like-for-like yet: the pod stores an IBI-variability index (window_ibi_variability_v1), '
  + 'not SDNN, while the Watch reports SDNN over a few minutes, usually only 1-4 samples a night. Track its trend, not its zero.'

const STAGES: SleepStage[] = ['wake', 'light', 'deep', 'rem']

/** Index of the first point at or after t; points sorted by t. */
function lowerBound(points: TimedValue[], t: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (points[mid].t < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The non-null value nearest in time to t within toleranceMs (earlier wins a tie); points sorted by t. */
export function nearestWithin(points: TimedValue[], t: number, toleranceMs: number): number | null {
  let best: number | null = null
  let bestDt = Infinity
  for (let i = lowerBound(points, t - toleranceMs); i < points.length && points[i].t <= t + toleranceMs; i++) {
    const dt = Math.abs(points[i].t - t)
    if (points[i].v !== null && dt < bestDt) {
      best = points[i].v
      bestDt = dt
    }
  }
  return best
}

/** Mean of the non-null values within toleranceMs of t; points sorted by t. */
export function meanWithin(points: TimedValue[], t: number, toleranceMs: number): number | null {
  let sum = 0
  let count = 0
  for (let i = lowerBound(points, t - toleranceMs); i < points.length && points[i].t <= t + toleranceMs; i++) {
    const v = points[i].v
    if (v !== null) {
      sum += v
      count++
    }
  }
  return count ? sum / count : null
}

/** Pair each Watch sample with the pod value `pick` finds for its time; unmatched samples are dropped. */
export function pairWatchSamples(watch: TimedValue[], pick: (t: number) => number | null): DeviationPair[] {
  const pairs: DeviationPair[] = []
  for (const w of watch) {
    if (w.v === null) continue
    const pod = pick(w.t)
    if (pod !== null) pairs.push([pod, w.v])
  }
  return pairs
}

export const watchDeviationSchema = z.object({
  /** Watch samples paired with a pod reading. */
  n: z.number().int(),
  /** Watch samples in the night (or nights), paired or not. */
  watchSamples: z.number().int(),
  /** n / watchSamples; null without Watch samples. */
  coverage: z.number().nullable(),
  /** Mean absolute error, in the metric's unit. */
  mae: z.number().nullable(),
  /** Mean of pod − Watch; positive means the pod reads high. */
  bias: z.number().nullable(),
  /** 90th-percentile absolute error (nearest rank). */
  p90: z.number().nullable(),
  /** Pearson correlation of pod and Watch values; null below 2 pairs or without variance. */
  r: z.number().nullable(),
})
export type WatchDeviation = z.infer<typeof watchDeviationSchema>

/** MAE, bias, p90 absolute error, Pearson r and coverage. Null statistics, never zeros, without pairs. */
export function deviationStats(pairs: readonly DeviationPair[], watchSamples: number): WatchDeviation {
  const n = pairs.length
  const coverage = watchSamples > 0 ? n / watchSamples : null
  if (n === 0) return { n, watchSamples, coverage, mae: null, bias: null, p90: null, r: null }
  const abs = pairs.map(([p, w]) => Math.abs(p - w)).sort((a, b) => a - b)
  const meanPod = pairs.reduce((s, [p]) => s + p, 0) / n
  const meanWatch = pairs.reduce((s, [, w]) => s + w, 0) / n
  let cov = 0
  let varPod = 0
  let varWatch = 0
  for (const [p, w] of pairs) {
    cov += (p - meanPod) * (w - meanWatch)
    varPod += (p - meanPod) ** 2
    varWatch += (w - meanWatch) ** 2
  }
  return {
    n,
    watchSamples,
    coverage,
    mae: abs.reduce((s, x) => s + x, 0) / n,
    bias: meanPod - meanWatch,
    // Nearest-rank percentile: rank ceil(0.9 n), so n = 10 picks the 9th smallest, not the largest.
    p90: abs[Math.ceil(n * 0.9) - 1],
    r: varPod > 0 && varWatch > 0 ? cov / Math.sqrt(varPod * varWatch) : null,
  }
}

/** Pod readings per metric, each sorted by time. */
export interface PodSeries { heartRate: TimedValue[], breathingRate: TimedValue[], hrv: TimedValue[] }
/** Watch samples per metric: heart rate (bpm), breathing rate (breaths/min), HRV SDNN (ms). */
export interface WatchSeries { heartRate: TimedValue[], breathingRate: TimedValue[], hrvSdnn: TimedValue[] }
export type DeviationMetric = keyof PodSeries

/** Pair one night's Watch samples with the pod readings near them, per metric. */
export function pairNight(pod: PodSeries, watch: WatchSeries): Record<DeviationMetric, DeviationPair[]> {
  const w = WATCH_PAIRING_WINDOW_MS
  return {
    heartRate: pairWatchSamples(watch.heartRate, t => nearestWithin(pod.heartRate, t, w.heartRate)),
    breathingRate: pairWatchSamples(watch.breathingRate, t => nearestWithin(pod.breathingRate, t, w.breathingRate)),
    hrv: pairWatchSamples(watch.hrvSdnn, t => meanWithin(pod.hrv, t, w.hrv)),
  }
}

const stageNumbers = z.object({ wake: z.number(), light: z.number(), deep: z.number(), rem: z.number() })

export const stageComparisonSchema = z.object({
  /** Pod epochs whose midpoint falls inside a Watch stage segment. */
  epochs: z.number().int(),
  accuracy: z.number(),
  kappa: z.number().nullable(),
  recall: z.object({ wake: z.number().nullable(), light: z.number().nullable(), deep: z.number().nullable(), rem: z.number().nullable() }),
  /** Minutes per stage over the scored epochs only, so pod and Watch cover the same time. */
  podMinutes: stageNumbers,
  watchMinutes: stageNumbers,
})
export type StageComparison = z.infer<typeof stageComparisonSchema>

/**
 * Agreement of classified epochs with Watch stages, pooled over every epoch
 * given (scoreAgainstReference), plus minutes per stage on each side over the
 * scored epochs. Null when no epoch falls inside a Watch segment.
 */
export function compareStages(epochs: SleepEpoch[], reference: SleepStageBlock[]): StageComparison | null {
  const agreement = scoreAgainstReference(epochs, reference)
  if (!agreement) return null
  const podMs: Record<SleepStage, number> = { wake: 0, light: 0, deep: 0, rem: 0 }
  const watchMs: Record<SleepStage, number> = { wake: 0, light: 0, deep: 0, rem: 0 }
  for (const e of epochs) {
    const mid = e.start + e.duration / 2
    const ref = reference.find(r => mid >= r.start && mid < r.end)
    if (!ref) continue
    podMs[e.stage] += e.duration
    watchMs[ref.stage] += e.duration
  }
  const minutes = (ms: Record<SleepStage, number>) =>
    Object.fromEntries(STAGES.map(s => [s, Math.round(ms[s] / 60_000)])) as Record<SleepStage, number>
  return {
    epochs: agreement.epochs,
    accuracy: agreement.accuracy,
    kappa: agreement.kappa,
    recall: agreement.recall,
    podMinutes: minutes(podMs),
    watchMinutes: minutes(watchMs),
  }
}

/** One night's inputs: the pod and Watch series and the classified epochs, all inside the record. */
export interface DeviationNightInput {
  sleepRecordId: number
  enteredBedAt: Date
  leftBedAt: Date
  pod: PodSeries
  watch: WatchSeries
  epochs: SleepEpoch[]
  reference: SleepStageBlock[]
}

export const deviationNightSchema = z.object({
  sleepRecordId: z.number().int(),
  enteredBedAt: z.date(),
  leftBedAt: z.date(),
  hours: z.number(),
  heartRate: watchDeviationSchema,
  breathingRate: watchDeviationSchema,
  hrv: watchDeviationSchema,
  stages: stageComparisonSchema.nullable(),
})

export const deviationSummarySchema = z.object({
  nights: z.number().int(),
  heartRate: watchDeviationSchema,
  breathingRate: watchDeviationSchema,
  hrv: watchDeviationSchema,
  stages: stageComparisonSchema.nullable(),
})

const round = (x: number | null, digits: number) => x === null ? null : Number(x.toFixed(digits))

function rounded(d: WatchDeviation): WatchDeviation {
  return { ...d, coverage: round(d.coverage, 3), mae: round(d.mae, 2), bias: round(d.bias, 2), p90: round(d.p90, 2), r: round(d.r, 3) }
}

function roundedStages(s: StageComparison | null): StageComparison | null {
  return s && {
    ...s,
    accuracy: Number(s.accuracy.toFixed(3)),
    kappa: round(s.kappa, 3),
    recall: { wake: round(s.recall.wake, 3), light: round(s.recall.light, 3), deep: round(s.recall.deep, 3), rem: round(s.recall.rem, 3) },
  }
}

/**
 * Per-night deviation plus a summary pooled over every pair and every scored
 * epoch of all nights, not a mean of the nightly figures: a night with more
 * Watch samples weighs more, and a night with one HRV sample cannot swing it.
 */
export function compareNightsToWatch(nights: DeviationNightInput[]) {
  const pooled: Record<DeviationMetric, DeviationPair[]> = { heartRate: [], breathingRate: [], hrv: [] }
  const watchTotals: Record<DeviationMetric, number> = { heartRate: 0, breathingRate: 0, hrv: 0 }
  const report = nights.map((night) => {
    const pairs = pairNight(night.pod, night.watch)
    const watchCounts: Record<DeviationMetric, number> = {
      heartRate: night.watch.heartRate.length,
      breathingRate: night.watch.breathingRate.length,
      hrv: night.watch.hrvSdnn.length,
    }
    for (const metric of ['heartRate', 'breathingRate', 'hrv'] as const) {
      pooled[metric].push(...pairs[metric])
      watchTotals[metric] += watchCounts[metric]
    }
    return {
      sleepRecordId: night.sleepRecordId,
      enteredBedAt: night.enteredBedAt,
      leftBedAt: night.leftBedAt,
      hours: Number(((night.leftBedAt.getTime() - night.enteredBedAt.getTime()) / 3_600_000).toFixed(1)),
      heartRate: rounded(deviationStats(pairs.heartRate, watchCounts.heartRate)),
      breathingRate: rounded(deviationStats(pairs.breathingRate, watchCounts.breathingRate)),
      hrv: rounded(deviationStats(pairs.hrv, watchCounts.hrv)),
      stages: roundedStages(compareStages(night.epochs, night.reference)),
    }
  })
  return {
    nights: report,
    summary: {
      nights: nights.length,
      heartRate: rounded(deviationStats(pooled.heartRate, watchTotals.heartRate)),
      breathingRate: rounded(deviationStats(pooled.breathingRate, watchTotals.breathingRate)),
      hrv: rounded(deviationStats(pooled.hrv, watchTotals.hrv)),
      stages: roundedStages(compareStages(nights.flatMap(n => n.epochs), nights.flatMap(n => n.reference))),
    },
  }
}
