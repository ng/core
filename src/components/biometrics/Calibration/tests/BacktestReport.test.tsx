import { stageObjectiveTestPolicy } from '@/src/biometrics/backtest/tests/fixtures/stage-objective'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BacktestReport } from '../BacktestReport'
const mock = vi.hoisted(() => ({ get: vi.fn(), release: vi.fn(), invalidate: vi.fn(), activate: vi.fn(), releaseError: null as { message: string } | null }))
vi.mock('@/src/providers/TimeFormatProvider', () => ({ useTimeFormat: () => '24h' }))
vi.mock('../NumericTrace', () => ({ NumericTrace: ({ hash }: { hash: string }) => <p>{`Numeric traces for ${hash}`}</p> }))
vi.mock('../StageTrace', () => ({ StageTrace: ({ hash }: { hash: string }) => <p>{`Stage traces for ${hash}`}</p> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } },
  useUtils: () => ({ biometricTuning: { getBacktestSummary: { invalidate: mock.invalidate }, getProfileOverview: { invalidate: mock.invalidate }, listActivationHistory: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    getProfileOverview: { useQuery: () => ({ data: { desired: { binding: { generation: 2 } } } }) },
    reviewValidatedActivation: { useQuery: () => ({ data: { eligible: true } }) },
    activateValidatedProfile: { useMutation: () => ({ mutateAsync: mock.activate }) },
    getActivationStatus: { useQuery: () => ({ data: { observedState: 'pending_boundary', isCurrent: true } }) },
    getBacktestSummary: { useQuery: mock.get }, releaseBacktestResult: { useMutation: () => ({ mutateAsync: mock.release, isPending: false, error: mock.releaseError }) } },
} }))
const report = {
  version: 'processed-backtest-report-v1', status: 'insufficient_evidence', datasetHash: 'dataset', protocolHash: 'protocol', manifestHash: 'manifest', evaluatorBuildHash: 'worker',
  split: 'holdout', evidence: 'descriptive_only', holdoutUse: 1, protocol: { mode: 'stage_replay' }, calibration: { source: 'explicit_assumption', quality: 0 }, limitations: [],
  stageNightSummary: [{ baseline: 'default', candidate: 'candidate', baselineHash: 'default-hash', candidateHash: 'candidate-hash', totalNights: 3, scoredNights: 2, unscoredNights: 1, coverageReducedNights: 1,
    improvedAgreementNights: 0, regressedAgreementNights: 1, unchangedAgreementNights: 1, equalNightMeanAgreementDifference: 0,
    pooledCommonSupport: { baseline: { agreement: 0, macroF1: null, pairedDurationMs: 1000 }, candidate: { agreement: null, macroF1: 0, pairedDurationMs: 1000 } },
    uncertainty: { status: 'insufficient_nights', interval: null, limitations: [] } }],
}
const descriptor = { report, contentHash: 'exact-report-hash', available: true, currentHoldoutUseCount: 2 }
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><BacktestReport id="job-id" /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.releaseError = null
  mock.get.mockReturnValue({ data: descriptor })
  mock.release.mockResolvedValue({})
})
it('shows query failures, loading and absent reports without inventing scores', () => {
  mock.get.mockReturnValue({ error: { message: 'Summary unavailable' } })
  const rendered = render(view())
  expect(screen.getByText('Summary unavailable')).toBeTruthy()
  mock.get.mockReturnValue({})
  rendered.rerender(view())
  expect(screen.queryByText('Summary unavailable')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  mock.get.mockReturnValue({ data: null })
  rendered.rerender(view())
  expect(screen.getByText('No committed report is available yet.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Release detailed report' })).toBeNull()
})
it('describes comparison protocols with a single policy, limitations and exploratory intervals', () => {
  const policy = { version: 'numeric-objective-v1', qualificationId: 'test-only', metric: 'heart_rate', minimumNights: 3, minimumPairedReferencesPerNight: 1,
    maximumLostObservationFraction: 0, minimumMaeImprovement: 1, maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0,
    maximumSubgroupMaeRegression: 1, requiredSubgroups: [], operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 } }
  mock.get.mockReturnValue({ data: { ...descriptor, currentHoldoutUseCount: 1, report: { ...report, split: 'validation', protocol: { mode: 'comparison', objectivePolicy: policy }, limitations: ['Only two nights were paired'],
    objectiveAssessments: [{ baseline: 'default', candidate: 'candidate', status: 'insufficient_evidence', designated: false, missingEvidence: ['missing_without_policy'], failedThresholds: [] }],
    stageNightSummary: [{ ...report.stageNightSummary[0], baseline: 'other', uncertainty: { status: 'estimated', interval: { lower: 0.1, upper: 0.25 }, limitations: ['Interval is exploratory'] } }] } } })
  render(view())
  expect(screen.getByText(/Original stored readings were compared/)).toBeTruthy()
  expect(screen.queryByText(/Repeated holdout exposure/)).toBeNull()
  expect(screen.queryByText(/Assumed stage calibration quality/)).toBeNull()
  expect(screen.getByText('Validation')).toBeTruthy()
  expect(screen.getByText('Only two nights were paired')).toBeTruthy()
  expect(screen.getByText('Missing evidence: missing_without_policy')).toBeTruthy()
  expect(screen.getByText('Exploratory 95% interval: 10% to 25%')).toBeTruthy()
  expect(screen.getByText('Exploratory interval estimated')).toBeTruthy()
  expect(screen.getByText('Interval is exploratory')).toBeTruthy()
  expect(screen.getAllByText(/other/)).toHaveLength(2)
})
it('reveals numeric and stage traces only on request', () => {
  mock.get.mockReturnValue({ data: { ...descriptor, report: { ...report, version: 'waveform-backtest-report-v1', protocol: { mode: 'signal_replay', waveformStages: true }, stageNightSummary: [], nights: [] } } })
  render(view())
  expect(screen.queryByText(/traces for/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect numeric traces' }))
  expect(screen.getByText('Numeric traces for exact-report-hash')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect stage traces' }))
  expect(screen.getByText('Stage traces for exact-report-hash')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect numeric traces' }))
  expect(screen.queryByText('Numeric traces for exact-report-hash')).toBeNull()
})
it('shows release failures beside the retained report', () => {
  mock.releaseError = { message: 'Release refused' }
  render(view())
  expect(screen.getByText('Release refused')).toBeTruthy()
  expect(screen.getByText('Insufficient evidence for validated improvement')).toBeTruthy()
})
it('keeps one stage and numeric section after report controls rerender', () => {
  const errors = vi.spyOn(console, 'error')
  mock.get.mockReturnValue({ data: { ...descriptor, report: { ...report, stageNightSummary: [], nights: [] } } })
  render(view())
  const assertSections = () => {
    expect(screen.getAllByRole('heading', { name: 'Stage coverage and confusion by night' })).toHaveLength(1)
    expect(screen.getAllByRole('region', { name: 'Numerical errors by night' })).toHaveLength(1)
  }
  assertSections()
  fireEvent.click(screen.getByRole('button', { name: 'Release detailed report' }))
  assertSections()
  fireEvent.click(screen.getByRole('button', { name: 'Keep report' }))
  assertSections()
  expect(errors.mock.calls.flat().join(' ')).not.toContain('same key')
  errors.mockRestore()
})
it('keeps zero scores distinct from missing scores and reports current holdout reuse', () => {
  render(view())
  expect(screen.getAllByText('0%')).toHaveLength(2)
  expect(screen.getAllByText('Not scored')).toHaveLength(2)
  expect(screen.getByText('Insufficient evidence for validated improvement')).toBeTruthy()
  expect(screen.getByText(/Repeated holdout exposure/)).toBeTruthy()
  expect(screen.getByText('Assumed stage calibration quality: 0')).toBeTruthy()
  expect(screen.getByText('Insufficient paired nights')).toBeTruthy()
})
it('requires a deliberate second action and releases only the displayed report hash', async () => {
  render(view())
  fireEvent.click(screen.getByRole('button', { name: 'Release detailed report' }))
  expect(mock.release).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Keep report' }))
  expect(mock.release).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Release detailed report' }))
  fireEvent.click(screen.getByRole('button', { name: 'Permanently release report' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledWith({ id: 'job-id' }))
  expect(mock.release).toHaveBeenCalledWith({ id: 'job-id', expectedContentHash: 'exact-report-hash' })
})
it('does not interpret unknown report versions or released payloads as valid scores', () => {
  mock.get.mockReturnValue({ data: { ...descriptor, report: { ...report, version: 'future' } } })
  const rendered = render(view())
  expect(screen.getByText(/version or structure is not supported/)).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
  mock.get.mockReturnValue({ data: { ...descriptor, available: false, report: {} } })
  rendered.rerender(view())
  expect(screen.getByText(/This report was released/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Release detailed report' })).toBeNull()
})
it('renders waveform reports with truthful provenance and optional stages', () => {
  const waveformReport = { ...report, version: 'waveform-backtest-report-v1', protocol: { mode: 'signal_replay', waveformStages: false }, stageNightSummary: [], nights: [] }
  mock.get.mockReturnValue({ data: { ...descriptor, report: waveformReport } })
  const rendered = render(view())
  expect(screen.getByText(/Numerical readings were recomputed from retained waveforms/)).toBeTruthy()
  expect(screen.queryByText(/Original stored readings were compared/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Inspect stage traces' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Numerical errors by night' })).toBeTruthy()
  mock.get.mockReturnValue({ data: { ...descriptor, report: { ...waveformReport, protocol: { mode: 'signal_replay', waveformStages: true } } } })
  rendered.rerender(view())
  expect(screen.getByRole('button', { name: 'Inspect stage traces' })).toBeTruthy()
  expect(screen.getByText('Assumed stage calibration quality: 0')).toBeTruthy()
})

it('shows frozen stage policy support requirements and regression reasons without clinical claims', () => {
  mock.get.mockReturnValue({ data: { jobId: 'job', contentHash: 'hash', available: true, currentHoldoutUseCount: 1,
    report: { ...report, protocol: { ...report.protocol, stageObjectivePolicy: stageObjectiveTestPolicy }, stageObjectiveAssessments: [{
      baseline: 'default', candidate: 'candidate', status: 'insufficient_evidence', designated: false,
      missingEvidence: ['stage_support:rem'], failedThresholds: ['stage_regression:deep'],
    }] } } })
  render(<I18nProvider i18n={i18n}><BacktestReport id="job" /></I18nProvider>)
  fireEvent.click(screen.getByText('Frozen stage objective thresholds'))
  expect(screen.getByText('minimumPairedDurationMsPerNight')).toBeTruthy()
  expect(screen.getByText('Missing evidence: stage_support:rem')).toBeTruthy()
  expect(screen.getByText('Threshold failed: stage_regression:deep')).toBeTruthy()
  expect(screen.getByText(/It does not establish clinical stage accuracy/)).toBeTruthy()
})

it('keeps each metric threshold and its own assessment reasons together', () => {
  const objectivePolicies = (['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const).map(metric => ({
    version: 'numeric-objective-v1', qualificationId: 'test-only', metric, minimumNights: 3, minimumPairedReferencesPerNight: 1,
    maximumLostObservationFraction: 0, minimumMaeImprovement: 1, maximumNightMaeRegression: 1, maximumRegressedNightFraction: 0,
    maximumSubgroupMaeRegression: 1, requiredSubgroups: [], operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 },
  }))
  mock.get.mockReturnValue({ data: { ...descriptor, report: { ...report, version: 'waveform-backtest-report-v1',
    protocol: { mode: 'signal_replay', objectivePolicies }, stageNightSummary: [], nights: [],
    objectiveAssessments: objectivePolicies.flatMap(policy => ['default', 'current'].map(baseline => ({
      policy, baseline, candidate: 'candidate', status: 'insufficient_evidence', designated: false,
      missingEvidence: [`missing_${policy.metric}`], failedThresholds: [],
    }))),
  } } })
  render(view())
  const sections = screen.getAllByText('Frozen objective thresholds').map(element => element.closest('details'))
  expect(sections).toHaveLength(3)
  for (let index = 0; index < objectivePolicies.length; index++) {
    for (let other = 0; other < objectivePolicies.length; other++) {
      expect(sections[index]?.textContent?.includes(`missing_${objectivePolicies[other].metric}`)).toBe(index === other)
    }
  }
})

it('preserves uncertain activation intent when the detailed report is released', async () => {
  mock.activate.mockRejectedValueOnce(new Error('Uncertain response')).mockResolvedValue({ id: 'activation-id' })
  const component = <I18nProvider i18n={i18n}><BacktestReport id="job-id" candidate={{ side: 'left', revisionId: 'candidate-id', hash: 'candidate-hash' }} /></I18nProvider>
  const rendered = render(component)
  fireEvent.click(screen.getByRole('button', { name: 'Apply evaluated revision' }))
  await waitFor(() => expect(mock.activate).toHaveBeenCalledTimes(1))
  mock.get.mockReturnValue({ data: { ...descriptor, report: null, available: false } })
  rendered.rerender(<I18nProvider i18n={i18n}><BacktestReport id="job-id" candidate={{ side: 'left', revisionId: 'candidate-id', hash: 'candidate-hash' }} /></I18nProvider>)
  await screen.findByText('This report was released. Its audit hash remains, but detailed results are unavailable.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry exact activation request' }))
  await screen.findByText('Waiting for a processing boundary')
  expect(mock.activate.mock.calls[1][0]).toEqual(mock.activate.mock.calls[0][0])
})

it.each([
  ['improved', 'Improved agreement under the qualified evaluation policy'],
  ['no_material_change', 'No material improvement under the evaluation policy'],
  ['regressed', 'Regression under the evaluation policy'],
  ['incompatible', 'Incompatible evaluation evidence'],
])('renders %s as retained evidence without claiming processor adoption', (status, label) => {
  mock.get.mockReturnValue({ data: { ...descriptor, report: { ...report, status, qualificationWarning: 'Qualification context warning' } } })
  render(view())
  expect(screen.getByText(label)).toBeTruthy()
  expect(screen.getByText('Qualification context warning')).toBeTruthy()
  expect(screen.queryByText('Applied')).toBeNull()
  if (status === 'improved') expect(screen.getByText(/not current activation approval or clinical accuracy/)).toBeTruthy()
})
