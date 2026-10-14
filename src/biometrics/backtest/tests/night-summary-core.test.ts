// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { previewReferenceImport } from '../../references/normalize'
import { createNightSummary } from '../night-summary-core'
import { compareStageOutputs } from '../stage-comparison'
import { createNightUncertainty } from '../uncertainty-core'

const T = 1791673200000
const digest = (text: string) => new Uint8Array(createHash('sha256').update(text).digest())
const summarize = createNightSummary(createNightUncertainty(digest))
const references = previewReferenceImport({ side: 'left', subjectId: 'fixture', source: 'test', rows: [
  { recordKey: 'first', metric: 'sleep_stages', value: 'light', unit: 'stage', startMs: T, endMs: T + 10000 },
  { recordKey: 'second', metric: 'sleep_stages', value: 'deep', unit: 'stage', startMs: T + 10000, endMs: T + 20000 },
] }).measurements
const identity = { baseline: 'default', candidate: 'candidate', baselineHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64) }
const block = (start: number, end: number, stage: 'light' | 'deep' | 'wake') => ({ start, end, stage })
const window = (candidate: Array<ReturnType<typeof block>>, startMs = T, endMs = T + 20000, baseline = [block(T, T + 20000, 'light')]) =>
  ({ startMs, endMs, ...compareStageOutputs(baseline, candidate, references, startMs, endMs) })
const improved = () => window([block(T, T + 10000, 'light'), block(T + 10000, T + 20000, 'deep')])
const regressed = () => window([block(T, T + 20000, 'wake')])
const unchanged = () => window([block(T, T + 20000, 'light')])
const night = (cohortId: string, windows: ReturnType<typeof window>[]) => ({ cohortId, comparisons: [{ ...identity, windows }] })

describe('whole-night stage summary', () => {
  it('aggregates disconnected windows per night before counting improved, regressed and unchanged nights', () => {
    const [summary] = summarize([night('a', [improved()]), night('b', [regressed()]), night('c', [unchanged()])])
    expect(summary).toMatchObject({ ...identity, totalNights: 3, scoredNights: 3, unscoredNights: 0, improvedAgreementNights: 1, regressedAgreementNights: 1,
      unchangedAgreementNights: 1, coverageReducedNights: 0, equalNightMeanAgreementDifference: 0, observedNightRange: { minimum: -0.5, maximum: 0.5 },
      uncertainty: { status: 'not_requested', interval: null }, interpretation: 'descriptive_night_aggregation_not_confidence_interval' })
    expect(summary.nights[0]).toMatchObject({ cohortId: 'a', evaluationDurationMs: 20000, commonOutputDurationMs: 20000, commonAgreementDifference: 0.5, coverageReduced: false,
      commonSupport: { baseline: { agreement: 0.5, pairedDurationMs: 20000 }, candidate: { agreement: 1 } },
      ownSupport: { baseline: { outputMs: 20000, pairedMs: 20000, referenceMs: 20000, correctMs: 10000, agreement: 0.5, outputCoverage: 1, referenceCoverage: 1 } } })
    expect(summary.nights[0].commonSupport.candidate.perStage).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'light', precision: 1, recall: 1, f1: 1 }), expect.objectContaining({ stage: 'wake', precision: null, recall: null, f1: null })]))
    expect(summary.pooledCommonSupport.candidate.pairedDurationMs).toBe(60000)
    expect(summary.nights[1].commonMacroF1Difference).toBeLessThan(0)
  })
  it('keeps unscored nights counted without inventing agreement', () => {
    const empty = window([block(T + 10000, T + 20000, 'deep')], T, T + 20000, [block(T, T + 10000, 'light')])
    const [summary] = summarize([night('only', [empty])])
    expect(summary).toMatchObject({ totalNights: 1, scoredNights: 0, unscoredNights: 1, equalNightMeanAgreementDifference: null, observedNightRange: null, coverageReducedNights: 0 })
    expect(summary.nights[0]).toMatchObject({ commonAgreementDifference: null, commonMacroF1Difference: null, commonSupport: { baseline: { agreement: null, macroF1: null } } })
    expect(summarize([])).toEqual([])
    const [outside] = summarize([night('late', [window([], T + 30000, T + 40000, [])])])
    expect(outside.nights[0].ownSupport.candidate).toMatchObject({ agreement: null, referenceCoverage: null, outputCoverage: 0 })
  })
  it('groups each comparison identity across nights and reports a bootstrap interval when requested', () => {
    const other = { ...identity, candidate: 'current', candidateHash: 'c'.repeat(64) }
    const nights = ['a', 'b', 'c', 'd'].map((cohortId, index) => ({ cohortId, comparisons: [
      { ...identity, windows: [index % 2 ? improved() : unchanged()] }, { ...other, windows: [regressed()] }] }))
    const summaries = summarize(nights, { version: 'paired-night-percentile-v1', seed: 'fixture', resamples: 200, minimumNights: 3 })
    expect(summaries.map(row => [row.candidate, row.totalNights])).toEqual([['candidate', 4], ['current', 4]])
    expect(summaries[0].uncertainty).toMatchObject({ status: 'estimated', scoredNights: 4 })
    expect(summaries[0].uncertainty.interval?.lower).toBeLessThanOrEqual(summaries[0].uncertainty.interval?.upper ?? -1)
    expect(summaries[1].uncertainty).toMatchObject({ status: 'degenerate', interval: null })
  })
  it('rejects oversized, duplicated and malformed nightly inputs', () => {
    expect(() => summarize(Array.from({ length: 61 }, (_, index) => night(String(index), [improved()])))).toThrow('Invalid whole-night summary input')
    expect(() => summarize([night('a', [improved()]), night('a', [improved()])])).toThrow('Invalid whole-night summary input')
    expect(() => summarize([{ cohortId: 'a', comparisons: Array.from({ length: 4 }, () => ({ ...identity, windows: [improved()] })) }])).toThrow('Too many comparisons')
    expect(() => summarize([{ cohortId: 'a', comparisons: [{ ...identity, windows: [improved()] }, { ...identity, windows: [regressed()] }] }])).toThrow('Duplicate comparison')
    expect(() => summarize([night('a', [{ ...improved(), endMs: T }])])).toThrow('bounded and nonoverlapping')
    expect(() => summarize([night('a', [{ ...improved(), startMs: T + 0.5 }])])).toThrow('bounded and nonoverlapping')
    expect(() => summarize([night('a', [{ ...improved(), endMs: T + 86400001 }])])).toThrow('bounded and nonoverlapping')
    expect(() => summarize([night('a', [improved(), { ...improved(), startMs: T + 10000, endMs: T + 30000 }])])).toThrow('bounded and nonoverlapping')
    expect(() => summarize([night('a', Array.from({ length: 61 }, (_, index) => ({ ...improved(), startMs: T + index * 20000, endMs: T + index * 20000 + 10000 })))])).toThrow('bounded and nonoverlapping')
  })
})
