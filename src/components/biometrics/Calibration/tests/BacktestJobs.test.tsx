import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BacktestJobs, BacktestJobDetails } from '../BacktestJobs'
const mock = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), cancel: vi.fn(), setData: vi.fn(), invalidate: vi.fn(), cancelError: undefined as { message: string } | undefined }))
vi.mock('../BacktestReport', () => ({ BacktestReport: ({ id, candidate }: { id: string, candidate?: { side: string, revisionId: string, hash: string } }) =>
  <p>{`Report ${id} for ${candidate ? `${candidate.side}:${candidate.revisionId}:${candidate.hash}` : 'no candidate'}`}</p> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { getBacktest: { setData: mock.setData }, listBacktests: { invalidate: mock.invalidate } } }),
  biometricTuning: { getBacktest: { useQuery: mock.get }, listBacktests: { useQuery: mock.list }, cancelBacktest: { useMutation: () => ({ mutateAsync: mock.cancel, isPending: false, error: mock.cancelError }) } },
} }))
const job = { id: 'job-id', state: 'queued', attempt: 0, split: 'tuning', evaluationScope: 'stage_rules_on_original_readings', progress: { phase: 'queued', completedNights: 0, totalNights: 0 }, error: null, datasetId: 'dataset-id', datasetHash: 'dataset-hash', evaluatorBuildHash: 'worker-hash', configurations: [{ label: 'candidate', revisionId: 'candidate-id', hash: 'candidate-hash' }] }
const i18n = setupI18n({ locale: 'en', messages: {} })
const details = (side?: 'left' | 'right') => <I18nProvider i18n={i18n}><BacktestJobDetails id={job.id} side={side} /></I18nProvider>
const list = () => <I18nProvider i18n={i18n}><BacktestJobs side="left" /></I18nProvider>
beforeEach(() => {
  vi.clearAllMocks()
  mock.cancelError = undefined
  mock.get.mockReturnValue({ data: job })
  mock.list.mockReturnValue({ data: { items: [job], nextCursor: { createdAtMs: 100, id: job.id } } })
  mock.cancel.mockResolvedValue({ ...job, state: 'cancel_requested' })
})
it('shows queued work without invented progress and pages job history', () => {
  render(list())
  expect(mock.get).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect job' }))
  expect(screen.getByText(/Waiting for a worker and resource admission/)).toBeTruthy()
  expect(screen.getByText('Night progress is not available yet.')).toBeTruthy()
  expect(screen.queryByRole('progressbar')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Older jobs' }))
  expect(mock.list).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: 100, beforeId: job.id }, { refetchInterval: 5000 })
})
it('uses the authoritative cancellation response without prematurely claiming cancelled', async () => {
  const rendered = render(details())
  fireEvent.click(screen.getByRole('button', { name: 'Cancel backtest' }))
  await waitFor(() => expect(mock.setData).toHaveBeenCalledWith({ id: job.id }, { ...job, state: 'cancel_requested' }))
  expect(mock.cancel).toHaveBeenCalledWith({ id: job.id })
  mock.get.mockReturnValue({ data: { ...job, state: 'cancel_requested' } })
  rendered.rerender(details())
  expect(screen.getByText('Cancellation requested')).toBeTruthy()
  expect(screen.queryByText('Cancelled')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel backtest' })).toBeNull()
})
it('stops detail polling after terminal execution and keeps success separate from improvement', () => {
  mock.get.mockReturnValue({ data: { ...job, state: 'succeeded', progress: { phase: 'complete', completedNights: 3, totalNights: 3 } } })
  render(details())
  expect(screen.getByText(/Review the report before drawing conclusions/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Cancel backtest' })).toBeNull()
  const options = mock.get.mock.calls[0][1]
  expect(options.refetchInterval({ state: { data: { state: 'succeeded' } } })).toBe(false)
  expect(options.refetchInterval({ state: { data: { state: 'interrupted' } } })).toBe(5000)
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('3')
})
it('shows list loading, failures and empty histories', () => {
  mock.list.mockReturnValue({})
  const rendered = render(list())
  expect(screen.queryByRole('button', { name: 'Inspect job' })).toBeNull()
  mock.list.mockReturnValue({ error: { message: 'History unavailable' } })
  rendered.rerender(list())
  expect(screen.getByText('History unavailable')).toBeTruthy()
  mock.list.mockReturnValue({ data: { items: [], nextCursor: null } })
  rendered.rerender(list())
  expect(screen.getByText('No backtest jobs for this side.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Older jobs' })).toBeNull()
})
it('collapses inspected jobs and returns to the newest history page', () => {
  render(list())
  const inspect = screen.getByRole('button', { name: 'Inspect job' })
  fireEvent.click(inspect)
  expect(screen.getByRole('region', { name: 'Job details' })).toBeTruthy()
  fireEvent.click(inspect)
  expect(screen.queryByRole('region', { name: 'Job details' })).toBeNull()
  expect(inspect.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Older jobs' }))
  fireEvent.click(screen.getByRole('button', { name: 'Newest jobs' }))
  expect(mock.list).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: undefined, beforeId: undefined }, { refetchInterval: 5000 })
  expect(screen.queryByRole('button', { name: 'Newest jobs' })).toBeNull()
})
it('shows detail loading, failures, worker errors and exact pinned inputs', () => {
  mock.get.mockReturnValue({})
  const rendered = render(details())
  expect(screen.queryByRole('status')).toBeNull()
  mock.get.mockReturnValue({ error: { message: 'Job unavailable' } })
  rendered.rerender(details())
  expect(screen.getByText('Job unavailable')).toBeTruthy()
  mock.cancelError = { message: 'Cancellation refused' }
  mock.get.mockReturnValue({ data: { ...job, state: 'failed', error: 'Worker crashed', evaluationScope: 'retained_waveform_replay',
    configurations: [{ label: 'experimental', revisionId: null, hash: 'other-hash' }] } })
  rendered.rerender(details())
  expect(screen.getByText('Failed')).toBeTruthy()
  expect(screen.getByText('Worker crashed')).toBeTruthy()
  expect(screen.getByText('Cancellation refused')).toBeTruthy()
  expect(screen.getByText(/Retained waveform replay/)).toBeTruthy()
  expect(screen.getByText('experimental: other-hash — —')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Cancel backtest' })).toBeNull()
  mock.get.mockReturnValue({ data: { ...job, evaluationScope: 'comparison' } })
  rendered.rerender(details())
  expect(screen.getByText(/Original stored-reading comparison/)).toBeTruthy()
})
it('opens the report with the evaluated candidate only for completed holdout jobs on a known side', () => {
  mock.get.mockReturnValue({ data: { ...job, state: 'succeeded', split: 'holdout', progress: { phase: 'complete', completedNights: 3, totalNights: 3 } } })
  const rendered = render(details('left'))
  expect(screen.queryByText(/^Report/)).toBeNull()
  const review = screen.getByRole('button', { name: 'Review report' })
  fireEvent.click(review)
  expect(screen.getByText('Report job-id for left:candidate-id:candidate-hash')).toBeTruthy()
  expect(review.getAttribute('aria-expanded')).toBe('true')
  rendered.rerender(details())
  expect(screen.getByText('Report job-id for no candidate')).toBeTruthy()
  mock.get.mockReturnValue({ data: { ...job, state: 'succeeded', split: 'validation', progress: { phase: 'complete', completedNights: 3, totalNights: 3 } } })
  rendered.rerender(details('left'))
  expect(screen.getByText('Report job-id for no candidate')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Review report' }))
  expect(screen.queryByText(/^Report/)).toBeNull()
})
