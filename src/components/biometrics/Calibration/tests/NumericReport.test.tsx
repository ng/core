import { fireEvent, render, screen, within } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { NumericReport } from '../NumericReport'
import { numericReportViewSchema, type NumericReportView } from '../report-view'
import { compareNumericConfigurations } from '@/src/biometrics/backtest/numeric-comparison'
import { DEFAULT_ALIGNMENT } from '@/src/biometrics/references/alignment'
import { previewReferenceImport } from '@/src/biometrics/references/normalize'
const mock = vi.hoisted(() => ({ settings: vi.fn(() => ({ data: { device: { timezone: 'UTC' } } }) as { data?: { device: { timezone: string } } }), timeFormat: '24h' }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => mock.timeFormat }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: mock.settings } } } }))
const row = { metric: 'heart_rate' as const, status: 'compared' as const, metrics: { mae: 0, medianAbsoluteError: 0, p95AbsoluteError: 0, signedBias: -2 }, pairedCount: 1, referenceCoverage: 0.5, outputCoverage: 1, unmatchedReferences: 1, unmatchedObservations: 2, exclusions: {} }
const night = { cohortId: 'night-1', evaluations: [{ label: 'default' as const, configHash: 'exact-config', windows: [{ startMs: 1791673200000, endMs: 1791673800000, observationCount: 3, numeric: [row, { ...row, metric: 'window_ibi_variability_v1' as const, status: 'incompatible' as const, metrics: null, pairedCount: 0, referenceCoverage: null, exclusions: { incompatible_hrv_window: 3 } }] }] }] }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = (report: NumericReportView) => <I18nProvider i18n={i18n}><NumericReport report={report} /></I18nProvider>
beforeEach(() => {
  mock.settings.mockReturnValue({ data: { device: { timezone: 'UTC' } } })
  mock.timeFormat = '24h'
})
it('shows original-reading errors, missing evidence, units, exclusions and sparse coverage honestly', () => {
  render(view({ nights: [night] }))
  fireEvent.click(screen.getByText('Night night-1'))
  const rows = screen.getAllByRole('row')
  expect(within(rows[1]).getAllByText('0')).toHaveLength(3)
  expect(within(rows[1]).getByText('-2')).toBeTruthy()
  expect(within(rows[1]).getByText('50%')).toBeTruthy()
  expect(within(rows[2]).getAllByText('Not scored')).toHaveLength(5)
  expect(screen.getByText('Window IBI variability index (ms)')).toBeTruthy()
  expect(screen.getByText(/Identical numerical results across profiles do not validate/)).toBeTruthy()
  expect(screen.getByText(/not continuous time coverage/)).toBeTruthy()
  fireEvent.click(screen.getByText('Exclusions: Window IBI variability index (ms)'))
  expect(screen.getByText('incompatible_hrv_window')).toBeTruthy()
  expect(screen.getByText('exact-config')).toBeTruthy()
})
it('bounds rendered nights while allowing the entire retained report to be inspected', () => {
  render(view({ nights: Array.from({ length: 11 }, (_, index) => ({ ...night, cohortId: `night-${index + 1}` })) }))
  expect(screen.queryByText('Night night-11')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Next report nights' }))
  expect(screen.getByText('Night night-11')).toBeTruthy()
  expect(screen.queryByText('Night night-1')).toBeNull()
  expect(screen.getByRole('button', { name: 'Next report nights' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Previous report nights' }))
  expect(screen.getByText('Night night-1')).toBeTruthy()
})

it('shows dropped readings beside own and shared errors for waveform results', () => {
  const timestampMs = night.evaluations[0].windows[0].startMs
  const references = previewReferenceImport({ side: 'left', source: 'test', subjectId: 'test', rows: [
    { recordKey: 'one', metric: 'heart_rate', timestampMs, value: 60, unit: 'bpm' },
    { recordKey: 'two', metric: 'heart_rate', timestampMs: timestampMs + 60000, value: 60, unit: 'bpm' },
  ] }).measurements
  const comparisons = compareNumericConfigurations('heart_rate', null, [
    { label: 'default', configHash: 'default-hash', observations: [{ timestampMs, value: 60 }, { timestampMs: timestampMs + 60000, value: 100 }] },
    { label: 'candidate', configHash: 'candidate-hash', observations: [{ timestampMs, value: 60 }] },
  ], references, DEFAULT_ALIGNMENT)
  const report = numericReportViewSchema.parse({ nights: [{ ...night, numericComparisons: [{ startMs: timestampMs, endMs: timestampMs + 120000, metrics: comparisons }] }] })
  render(<I18nProvider i18n={i18n}><NumericReport report={report} waveform /></I18nProvider>)
  fireEvent.click(screen.getByText('Night night-1'))
  expect(screen.getByText(/Coverage reduced/)).toBeTruthy()
  expect(screen.getByText('-20')).toBeTruthy()
  expect(screen.getByText(/Dropping readings can lower own-support error/)).toBeTruthy()
  expect(screen.getByText('Recomputed observations: 3')).toBeTruthy()
  expect(screen.queryByText(/Identical numerical results across profiles/)).toBeNull()
  expect(screen.getByRole('columnheader', { name: 'Shared MAE difference' })).toBeTruthy()
})

it('shows whole-night uncertainty in metric units with missing scores preserved', () => {
  const report = numericReportViewSchema.parse({ nights: [], numericNightSummary: [{ version: 'numeric-night-summary-v1',
    metric: 'heart_rate', baseline: 'default', candidate: 'candidate', baselineHash: 'a', candidateHash: 'b',
    totalNights: 4, scoredNights: 3, unscoredNights: 1, coverageReducedNights: 1, improvedErrorNights: 2, regressedErrorNights: 1, unchangedErrorNights: 0,
    equalNightMeanMaeDifference: -2, pooledCommonSupport: { baseline: { mae: null, signedBias: null, pairedCount: 0 }, candidate: { mae: null, signedBias: null, pairedCount: 0 } },
    uncertainty: { statistic: 'equal_night_mean_common_mae_difference', status: 'estimated', interval: { lower: -4, upper: 1 }, limitations: ['Exploratory fixture'] },
  }] })
  render(<I18nProvider i18n={i18n}><NumericReport report={report} waveform /></I18nProvider>)
  expect(screen.getByText('Equal-night mean MAE difference: -2')).toBeTruthy()
  expect(screen.getByText('Exploratory 95% interval for MAE difference: -4 to 1')).toBeTruthy()
  expect(screen.getByText('Scored nights: 3; unscored: 1; coverage reduced: 1')).toBeTruthy()
  expect(screen.getByText(/baseline: Not scored; comparison: Not scored/)).toBeTruthy()
})

it('labels reference-defined subgroups, midpoint exclusions and a positive regression separately', () => {
  render(
    <I18nProvider i18n={i18n}>
      <NumericReport
        waveform
        report={{ nights: [], numericSubgroupSummary: [{ name: 'window_second_half', version: 'reference-defined-numeric-subgroups-v1',
          referenceMembershipBasis: 'native_reference_time', observationCoverageScope: 'complete_scoring_windows', excludedBoundaryReferenceCount: 2,
          summary: { metric: 'heart_rate', baseline: 'default', candidate: 'candidate', baselineHash: 'a', candidateHash: 'b',
            scoredNights: 3, unscoredNights: 1, equalNightMeanMaeDifference: 5 } }] }}
      />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByText('Reference-defined subgroup comparisons'))
  expect(screen.getByText(/Second half of each window/)).toBeTruthy()
  expect(screen.getByText('Equal-night mean MAE difference: 5')).toBeTruthy()
  expect(screen.getByText('Reference intervals excluded at window midpoints: 2')).toBeTruthy()
  expect(screen.getByText(/These are not motion or artifact subgroups/)).toBeTruthy()
})

it('falls back to UTC without device settings or with an invalid timezone', () => {
  mock.settings.mockReturnValue({})
  mock.timeFormat = '12h'
  const rendered = render(view({ nights: [night] }))
  expect(screen.getByText('Times shown in UTC')).toBeTruthy()
  fireEvent.click(screen.getByText('Night night-1'))
  expect(screen.getByText(/[AP]M – /)).toBeTruthy()
  rendered.rerender(view({ nights: [] }))
  expect(screen.getByText('No nights in this report.')).toBeTruthy()
  mock.settings.mockReturnValue({ data: { device: { timezone: 'Not/AZone' } } })
  rendered.rerender(view({ nights: [] }))
  expect(screen.getByText('Times shown in UTC')).toBeTruthy()
  mock.settings.mockReturnValue({ data: { device: { timezone: 'Europe/Paris' } } })
  rendered.rerender(view({ nights: [] }))
  expect(screen.getByText('Times shown in Europe/Paris')).toBeTruthy()
})

it('reports missing shared-timestamp comparisons and unscored summaries for waveform results', () => {
  const comparison = { version: 'paired-numeric-support-v1' as const, metric: 'breathing_rate' as const, baseline: 'current' as const, candidate: 'candidate' as const, baselineHash: 'a', candidateHash: 'b',
    commonSupportScope: 'all_configurations' as const, supportDefinition: 'identical_unambiguous_observation_timestamps' as const, commonObservationCount: 0,
    ownSupport: { baseline: { metrics: null, pairedCount: 0, referenceCoverage: null }, candidate: { metrics: null, pairedCount: 0, referenceCoverage: null } },
    commonSupport: { baseline: { metrics: null, pairedCount: 0, referenceCoverage: null }, candidate: { metrics: null, pairedCount: 0, referenceCoverage: null } },
    differences: { commonMae: null, commonMedianAbsoluteError: null, commonP95AbsoluteError: null, commonSignedBias: null, ownMae: null, referenceCoverage: null },
    lostObservationTimestamps: 0, addedObservationTimestamps: 0, ambiguousObservationTimestamps: { baseline: 0, candidate: 0 }, coverageReduced: false,
    interpretation: 'descriptive_numeric_agreement_not_validated_improvement' as const }
  const summary = { version: 'numeric-night-summary-v1' as const, metric: 'breathing_rate' as const, baseline: 'current' as const, candidate: 'candidate' as const, baselineHash: 'a', candidateHash: 'b',
    totalNights: 1, scoredNights: 0, unscoredNights: 1, coverageReducedNights: 0, improvedErrorNights: 0, regressedErrorNights: 0, unchangedErrorNights: 0, equalNightMeanMaeDifference: null,
    pooledCommonSupport: { baseline: { mae: null, signedBias: null, pairedCount: 0 }, candidate: { mae: null, signedBias: null, pairedCount: 0 } },
    uncertainty: { statistic: 'equal_night_mean_common_mae_difference' as const, status: 'not_requested' as const, interval: null, limitations: [] } }
  const nights = [night, { ...night, cohortId: 'night-2', numericComparisons: [{ startMs: 1791673200000, endMs: 1791673800000, metrics: [comparison] }] }]
  const rendered = render(<I18nProvider i18n={i18n}><NumericReport report={{ nights, numericNightSummary: [summary], numericSubgroupSummary: [] }} waveform /></I18nProvider>)
  expect(screen.getByText('Not requested')).toBeTruthy()
  expect(screen.queryByText(/Exploratory 95% interval/)).toBeNull()
  expect(screen.queryByText('Reference-defined subgroup comparisons')).toBeNull()
  expect(screen.getAllByRole('heading', { level: 5 })[0].textContent).toBe('Breathing rate (breaths/min) — Candidate / Current baseline')
  fireEvent.click(screen.getByText('Night night-1'))
  expect(screen.getByText('Shared-timestamp comparisons are unavailable in this report.')).toBeTruthy()
  fireEvent.click(screen.getByText('Night night-2'))
  expect(screen.queryByText(/Coverage reduced/)).toBeNull()
  expect(screen.getAllByText('Not scored').length).toBeGreaterThan(5)
  rendered.rerender(<I18nProvider i18n={i18n}><NumericReport report={{ nights: [] }} waveform /></I18nProvider>)
  expect(screen.getByText('No nights in this report.')).toBeTruthy()
})
