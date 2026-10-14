import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { BacktestSubmission } from '../BacktestSubmission'
vi.mock('../BacktestJobs', () => ({ BacktestJobDetails: () => <p>Job status</p> }))
const mock = vi.hoisted(() => ({ enqueue: vi.fn(), invalidate: vi.fn(), profiles: vi.fn(), overview: vi.fn(), dataset: vi.fn(), generation: 2, available: true, data: undefined as unknown, error: null as Error | null }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listBacktests: { invalidate: mock.invalidate }, listExperiments: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    listProfileRevisions: { useQuery: mock.profiles },
    getProfileOverview: { useQuery: mock.overview },
    getDataset: { useQuery: mock.dataset },
    enqueueBacktest: { useMutation: () => ({ mutateAsync: mock.enqueue, data: mock.data, error: mock.error, isPending: false }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const view = () => <I18nProvider i18n={i18n}><BacktestSubmission side="left" experimentId="experiment-id" datasetId="dataset-id" /></I18nProvider>
const dataset = (version = 'stored-dataset-manifest-v1') => ({ data: { available: mock.available, contentHash: 'dataset-hash', manifest: { version, splitProtocol: { assignments: [{ split: 'tuning' }, { split: 'holdout' }] } } } })
beforeEach(() => {
  vi.clearAllMocks()
  mock.generation = 2
  mock.available = true
  mock.data = undefined
  mock.error = null
  mock.profiles.mockReturnValue({ data: { items: [{ id: 'candidate-id', revision: 1, resolvedHash: 'candidate-hash' }], nextCursor: null } })
  mock.overview.mockImplementation(() => ({ data: { desired: { binding: { generation: mock.generation } } } }))
  mock.dataset.mockImplementation(() => dataset())
  mock.enqueue.mockImplementation(async () => {
    mock.data = { id: 'job-id', evaluatorBuildHash: 'worker-hash' }
    return mock.data
  })
})
it('requires an explicit candidate and holdout acknowledgement and pins the submission generation', async () => {
  render(view())
  expect((screen.getByRole('button', { name: 'Queue backtest' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('radio'))
  fireEvent.change(screen.getByLabelText('Evaluation split'), { target: { value: 'holdout' } })
  expect((screen.getByRole('button', { name: 'Queue backtest' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Queue backtest' }))
  await screen.findByText('Backtest request saved: job-id')
  expect(mock.enqueue).toHaveBeenCalledWith({ experimentId: 'experiment-id', candidateRevisionId: 'candidate-id', expectedBindingGeneration: 2, split: 'holdout', idempotencyKey: expect.any(String) })
  expect(screen.getByText(/does not mean execution has started/)).toBeTruthy()
})
it('retries the original uncertain request even if the current binding changes', async () => {
  const rendered = render(view())
  mock.enqueue.mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('radio'))
  fireEvent.click(screen.getByRole('button', { name: 'Queue backtest' }))
  await waitFor(() => expect(mock.enqueue).toHaveBeenCalledOnce())
  mock.generation = 3
  rendered.rerender(view())
  fireEvent.click(screen.getByRole('button', { name: 'Queue backtest' }))
  await screen.findByText('Backtest request saved: job-id')
  expect(mock.enqueue.mock.calls[0][0]).toEqual(mock.enqueue.mock.calls[1][0])
})
it('does not offer released data or splits absent from the frozen manifest', () => {
  const rendered = render(view())
  expect((screen.getByRole('option', { name: 'Validation' }) as HTMLOptionElement).disabled).toBe(true)
  mock.available = false
  rendered.rerender(view())
  expect(screen.getByText('The retained inputs are unavailable for new evaluations.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Queue backtest' })).toBeNull()
})
it('surfaces query errors from any source and waits while they load', () => {
  mock.profiles.mockReturnValue({ error: new Error('Profiles unavailable') })
  const rendered = render(view())
  expect(screen.getByText('Profiles unavailable')).toBeTruthy()
  mock.profiles.mockReturnValue({})
  mock.overview.mockReturnValue({ error: new Error('Overview unavailable') })
  rendered.rerender(view())
  expect(screen.getByText('Overview unavailable')).toBeTruthy()
  mock.overview.mockReturnValue({})
  mock.dataset.mockReturnValue({ error: new Error('Dataset unavailable') })
  rendered.rerender(view())
  expect(screen.getByText('Dataset unavailable')).toBeTruthy()
  mock.dataset.mockReturnValue({})
  rendered.rerender(view())
  expect(screen.queryByText('Dataset unavailable')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Queue backtest' })).toBeNull()
})
it('describes waveform replay, empty candidate lists and pages through profiles', () => {
  mock.dataset.mockImplementation(() => dataset('waveform-dataset-manifest-v1'))
  mock.profiles.mockReturnValue({ data: { items: [], nextCursor: { createdAtMs: 7, id: 'older' } } })
  render(view())
  expect(screen.getByText(/Replay uses retained signals/)).toBeTruthy()
  expect(screen.getByText('No saved candidate revisions.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Older profiles' }))
  expect(mock.profiles).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: 7, beforeId: 'older' })
  fireEvent.click(screen.getByRole('button', { name: 'Newest profiles' }))
  expect(mock.profiles).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: undefined, beforeId: undefined })
})
it('shows enqueue errors, withdraws holdout acknowledgement and re-pins a changed baseline on request', async () => {
  mock.error = new Error('Queue unavailable')
  const rendered = render(view())
  expect(screen.getByText('Queue unavailable')).toBeTruthy()
  fireEvent.click(screen.getByRole('radio'))
  fireEvent.change(screen.getByLabelText('Evaluation split'), { target: { value: 'holdout' } })
  fireEvent.click(screen.getByRole('checkbox'))
  expect((screen.getByRole('button', { name: 'Queue backtest' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(screen.getByRole('checkbox'))
  expect((screen.getByRole('button', { name: 'Queue backtest' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Evaluation split'), { target: { value: 'tuning' } })
  mock.generation = 3
  rendered.rerender(view())
  expect((screen.getByRole('button', { name: 'Queue backtest' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare a new request with the current baseline' }))
  fireEvent.click(screen.getByRole('button', { name: 'Queue backtest' }))
  await screen.findByText('Backtest request saved: job-id')
  expect(mock.enqueue).toHaveBeenCalledWith(expect.objectContaining({ expectedBindingGeneration: 3, split: 'tuning' }))
})
