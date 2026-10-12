/**
 * Sleep stage classification — server-side port of iOS SleepAnalyzer.
 *
 * Classifies vitals + movement data into discrete sleep stages by evaluating
 * a StageRuleset (see sleep-stage-rules.ts). The default ruleset reproduces
 * the rule-based iOS algorithm derived from ballistocardiography patterns.
 *
 * Stages: Wake, Light, Deep, REM
 * Input: 5-minute interval vitals (HR, HRV, breathing rate) + movement
 * Output: Array of SleepEpoch with stage, duration, and associated vitals
 */

import {
  DEFAULT_STAGE_RULESET,
  type StageCondition,
  type StageMetric,
  type StageRule,
  type StageRuleset,
} from './sleep-stage-rules'

export type SleepStage = 'wake' | 'light' | 'deep' | 'rem'

export interface SleepEpoch {
  start: number // unix ms
  duration: number // ms (typically 300_000 = 5 min)
  stage: SleepStage
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
  movement: number | null
}

export interface SleepStageBlock {
  start: number // unix ms
  end: number // unix ms
  stage: SleepStage
}

export interface StageDistribution {
  wake: number // percentage 0-100
  light: number
  deep: number
  rem: number
}

export interface SleepStagesResult {
  epochs: SleepEpoch[]
  blocks: SleepStageBlock[]
  distribution: StageDistribution
  qualityScore: number // 0-100
  totalSleepMs: number
  sleepRecordId: number | null
  enteredBedAt: number | null // unix ms
  leftBedAt: number | null // unix ms
}

interface VitalsRow {
  timestamp: Date
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

interface MovementRow {
  timestamp: Date
  totalMovement: number
}

/** Stage colors matching iOS: SleepStagesTimelineView.swift */
export const STAGE_COLORS: Record<SleepStage, string> = {
  wake: '#888888',
  light: '#4a90d9',
  deep: '#2563eb',
  rem: '#a080d0',
}

/** Numeric order for hypnogram Y-axis (0 = bottom, 3 = top) */
export const STAGE_ORDER: Record<SleepStage, number> = {
  deep: 0,
  light: 1,
  rem: 2,
  wake: 3,
}

/**
 * Filter outlier vitals readings before classification.
 *
 * Applies the ruleset's hard limits and a windowed median filter for HR.
 * Nulls out specific fields rather than removing rows (movement data preserved).
 */
function filterOutliers(vitals: VitalsRow[], limits: StageRuleset['outliers']): VitalsRow[] {
  const inRange = (v: number | null, r: { min: number, max: number }) => v !== null && v >= r.min && v <= r.max

  return vitals.map((v, i) => {
    let heartRate = inRange(v.heartRate, limits.heartRate) ? v.heartRate : null
    const hrv = inRange(v.hrv, limits.hrv) ? v.hrv : null
    const breathingRate = inRange(v.breathingRate, limits.breathingRate) ? v.breathingRate : null

    // Windowed median filter for HR (±2 window = 5 samples)
    if (heartRate !== null && limits.heartRateSpikeStdDevs > 0) {
      const windowStart = Math.max(0, i - 2)
      const windowEnd = Math.min(vitals.length - 1, i + 2)
      const windowHRs = vitals
        .slice(windowStart, windowEnd + 1)
        .map(w => w.heartRate)
        .filter((hr): hr is number => inRange(hr, limits.heartRate))

      if (windowHRs.length > 0) {
        const sorted = [...windowHRs].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]

        // Standard deviation of the window
        const mean = windowHRs.reduce((s, h) => s + h, 0) / windowHRs.length
        const variance = windowHRs.reduce((s, h) => s + (h - mean) ** 2, 0) / windowHRs.length
        const stdDev = Math.sqrt(variance)

        // Null out HR if it deviates too far from the window median.
        // stdDev=0 (uniform or single-sample window) would trip on any deviation — skip.
        if (stdDev > 0 && Math.abs(heartRate - median) > limits.heartRateSpikeStdDevs * stdDev) {
          heartRate = null
        }
      }
    }

    return { ...v, heartRate, hrv, breathingRate }
  })
}

/**
 * Classify sleep stages from vitals and movement data.
 *
 * Evaluates the ruleset's first-match rules per epoch (HR ratio is the
 * epoch's HR over the night's mean), then post-processes with temporal
 * smoothing and transition constraints. Below the ruleset's low-signal
 * calibration quality, its low-signal rules apply instead.
 */
export function classifySleepStages(
  vitalsData: VitalsRow[],
  movementData: MovementRow[],
  calibrationQuality: number = 0.0,
  ruleset: StageRuleset = DEFAULT_STAGE_RULESET,
): SleepEpoch[] {
  if (vitalsData.length === 0) return []

  // Sort by timestamp ascending
  const sortedVitals = filterOutliers(
    [...vitalsData].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    ),
    ruleset.outliers,
  )

  // Build movement lookup (nearest-neighbor by timestamp)
  const movementMap = new Map<number, number>()
  for (const m of movementData) {
    // Round to nearest 5-minute bucket
    const bucket = Math.round(m.timestamp.getTime() / 300_000) * 300_000
    movementMap.set(bucket, m.totalMovement)
  }

  // Calculate average HR for ratio-based classification
  const validHRs = sortedVitals
    .map(v => v.heartRate)
    .filter((hr): hr is number => hr !== null && hr > 0)
  const avgHR = validHRs.length > 0
    ? validHRs.reduce((s, h) => s + h, 0) / validHRs.length
    : 60

  const rules = calibrationQuality < ruleset.lowSignalBelow ? ruleset.lowSignalRules : ruleset.rules

  // Phase 1: Initial classification
  const epochs: SleepEpoch[] = sortedVitals.map((v, i) => {
    const ts = v.timestamp.getTime()
    const bucket = Math.round(ts / 300_000) * 300_000
    const mov = movementMap.get(bucket) ?? null

    // Duration = gap to next sample, or 5 min for last
    const nextTs = i < sortedVitals.length - 1
      ? sortedVitals[i + 1].timestamp.getTime()
      : ts + 300_000
    const duration = Math.min(nextTs - ts, 600_000) // cap at 10 min

    const stage = classifyEpoch({
      hrRatio: v.heartRate !== null && v.heartRate > 0 ? v.heartRate / avgHR : null,
      heartRate: v.heartRate,
      hrv: v.hrv,
      breathingRate: v.breathingRate,
      movement: mov,
    }, rules, ruleset.fallback)

    return {
      start: ts,
      duration,
      stage,
      heartRate: v.heartRate,
      hrv: v.hrv,
      breathingRate: v.breathingRate,
      movement: mov,
    }
  })

  // Phase 2: Temporal smoothing — remove isolated single-epoch spikes (A-B-A → A-A-A)
  if (ruleset.smoothIsolatedEpochs) {
    for (let i = 1; i < epochs.length - 1; i++) {
      if (epochs[i - 1].stage === epochs[i + 1].stage && epochs[i].stage !== epochs[i - 1].stage) {
        epochs[i].stage = epochs[i - 1].stage
      }
    }
  }

  // Phase 3: Transition constraints — enforce physiological rules
  // (by default Wake/REM ↔ Deep must pass through Light)
  for (let i = 1; i < epochs.length; i++) {
    const prev = epochs[i - 1].stage
    const curr = epochs[i].stage
    const t = ruleset.transitions.find(t => t.from === prev && t.to === curr)
    if (t) epochs[i].stage = t.via
  }

  return epochs
}

/**
 * Calibration quality to classify a side with, from its piezo calibration
 * profile. A side that has never been calibrated has no evidence of a bad
 * signal, so it gets the full HR/HRV rules rather than movement-only mode.
 * Running and failed recalibrations keep the last completed score.
 */
export function piezoCalibrationQuality(profile?: { qualityScore: number | null } | null): number {
  return profile?.qualityScore ?? 1.0
}

type EpochMetrics = Record<StageMetric, number | null>

function conditionHolds(c: StageCondition, m: EpochMetrics): boolean {
  const v = m[c.metric]
  if (v === null) return false
  switch (c.op) {
    case '<': return v < c.value
    case '<=': return v <= c.value
    case '>': return v > c.value
    case '>=': return v >= c.value
  }
}

/** Stage of the first rule whose conditions all hold, else the fallback. */
function classifyEpoch(m: EpochMetrics, rules: StageRule[], fallback: SleepStage): SleepStage {
  for (const rule of rules) {
    if (rule.when.every(c => conditionHolds(c, m))) return rule.stage
  }
  return fallback
}

/** Merge consecutive epochs of the same stage into blocks for visualization. */
export function mergeIntoBlocks(epochs: SleepEpoch[]): SleepStageBlock[] {
  if (epochs.length === 0) return []

  const blocks: SleepStageBlock[] = []
  let currentBlock: SleepStageBlock = {
    start: epochs[0].start,
    end: epochs[0].start + epochs[0].duration,
    stage: epochs[0].stage,
  }

  for (let i = 1; i < epochs.length; i++) {
    if (epochs[i].stage === currentBlock.stage) {
      currentBlock.end = epochs[i].start + epochs[i].duration
    }
    else {
      blocks.push(currentBlock)
      currentBlock = {
        start: epochs[i].start,
        end: epochs[i].start + epochs[i].duration,
        stage: epochs[i].stage,
      }
    }
  }
  blocks.push(currentBlock)

  return blocks
}

export interface StageAgreement {
  /** Epochs whose midpoint falls inside a reference segment. */
  epochs: number
  /** Fraction of those epochs whose stage matches the reference (0–1). */
  accuracy: number
  /** Cohen's kappa: agreement beyond chance; null when chance agreement is total. */
  kappa: number | null
}

/**
 * Score classified epochs against reference stages (e.g. Apple Watch) by
 * the reference stage at each epoch's midpoint. Null when no epoch is
 * covered by a reference segment.
 */
export function scoreAgainstReference(epochs: SleepEpoch[], reference: SleepStageBlock[]): StageAgreement | null {
  const stages: SleepStage[] = ['wake', 'light', 'deep', 'rem']
  const predicted: Record<SleepStage, number> = { wake: 0, light: 0, deep: 0, rem: 0 }
  const actual: Record<SleepStage, number> = { wake: 0, light: 0, deep: 0, rem: 0 }
  let covered = 0
  let matches = 0

  for (const e of epochs) {
    const mid = e.start + e.duration / 2
    const ref = reference.find(r => mid >= r.start && mid < r.end)
    if (!ref) continue
    covered++
    predicted[e.stage]++
    actual[ref.stage]++
    if (ref.stage === e.stage) matches++
  }

  if (covered === 0) return null
  const accuracy = matches / covered
  const chance = stages.reduce((sum, s) => sum + (predicted[s] / covered) * (actual[s] / covered), 0)
  return {
    epochs: covered,
    accuracy,
    kappa: chance === 1 ? null : (accuracy - chance) / (1 - chance),
  }
}

/** Calculate percentage distribution of stages. */
export function calculateDistribution(epochs: SleepEpoch[]): StageDistribution {
  if (epochs.length === 0) {
    return { wake: 0, light: 0, deep: 0, rem: 0 }
  }

  const totals = { wake: 0, light: 0, deep: 0, rem: 0 }
  let totalDuration = 0

  for (const e of epochs) {
    totals[e.stage] += e.duration
    totalDuration += e.duration
  }

  if (totalDuration === 0) {
    return { wake: 0, light: 0, deep: 0, rem: 0 }
  }

  return {
    wake: Math.round((totals.wake / totalDuration) * 100),
    light: Math.round((totals.light / totalDuration) * 100),
    deep: Math.round((totals.deep / totalDuration) * 100),
    rem: Math.round((totals.rem / totalDuration) * 100),
  }
}

/**
 * Calculate sleep quality score (0-100).
 * Based on "Why We Sleep" (Walker, 2017) stage distribution targets.
 */
export function calculateQualityScore(
  distribution: StageDistribution,
  calibrationQuality: number = 1.0,
): number {
  let score = 100

  // Deep sleep: target 15-25%
  if (distribution.deep < 15) {
    score -= (15 - distribution.deep) * 2
  }
  else if (distribution.deep > 30) {
    score -= (distribution.deep - 30) * 1.5
  }

  // REM: target 20-30%
  if (distribution.rem < 20) {
    score -= (20 - distribution.rem) * 1.5
  }
  else if (distribution.rem > 35) {
    score -= (distribution.rem - 35) * 1
  }

  // Wake: target <5%
  if (distribution.wake > 5) {
    score -= (distribution.wake - 5) * 2
  }

  score = Math.max(0, Math.min(100, Math.round(score)))

  // Cap at 50 if calibration quality is low
  if (calibrationQuality < 0.3) {
    score = Math.min(score, 50)
  }

  return score
}

/** Format milliseconds to "Xh Ym" */
export function formatDurationHM(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}
