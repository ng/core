import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { WaveformDatasetBuilder } from '../WaveformDatasetBuilder'
interface Admission { data?: { admitted: boolean, reasons: string[] }, error?: { message: string }, refetch: () => void }
const mock = vi.hoisted(() => ({ scan: vi.fn(), publish: vi.fn(), page: vi.fn(), refetch: vi.fn(), invalidate: vi.fn(), admitted: true,
  admission: null as Admission | null, scanData: undefined as { status: string } | undefined, publishData: undefined as { status: string } | undefined, publishError: undefined as { message: string } | undefined }))
vi.mock('../ExperimentBuilder', () => ({ ExperimentBuilder: ({ datasetId }: { datasetId: string }) => <p>{`Protocol for ${datasetId}`}</p> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listRawSources: { invalidate: mock.invalidate }, listDatasets: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    getReplayAdmission: { useQuery: () => mock.admission ?? { data: { admitted: mock.admitted, reasons: mock.admitted ? [] : ['unqualified'] }, refetch: mock.refetch } },
    listRawSources: { useQuery: mock.page },
    inspectRawSource: { useMutation: () => ({ mutateAsync: mock.scan, isPending: false, data: mock.scanData }) },
    createWaveformDataset: { useMutation: () => ({ mutateAsync: mock.publish, isPending: false, data: mock.publishData, error: mock.publishError }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const cohorts = [{ cohortId: 'one', startMs: 600000, endMs: 900000, nightLabels: ['Night one'] },
  { cohortId: 'two', startMs: 1800000, endMs: 2100000, nightLabels: ['Night two'] }]
const source = (id: string, inventory: Record<string, unknown> = {}) => ({ id, inspection: { source_name: `${id}.RAW.gz`, artifact: { compressed_bytes: 100 }, inventory: { ordered_waveform_available: true, ...inventory } } })
const element = (rows = cohorts) => <I18nProvider i18n={i18n}><WaveformDatasetBuilder parentId="parent" parentHash="exact-hash" cohorts={rows} /></I18nProvider>
const view = (rows = cohorts) => render(element(rows))
beforeEach(() => {
  vi.clearAllMocks()
  mock.admitted = true
  mock.admission = null
  mock.scanData = undefined
  mock.publishData = undefined
  mock.publishError = undefined
  mock.page.mockImplementation(({ startMs, afterId }) => ({ data: { items: [source(startMs === 300000 ? afterId ? 'b' : 'a' : 'c')], nextCursor: afterId ? null : 'next' } }))
  mock.publish.mockResolvedValue({ status: 'published', dataset: { id: 'waveform-id', available: true } })
})
it('preserves selections across pages and nights and pins the parent hash on publication', async () => {
  view()
  expect(mock.page).toHaveBeenCalledWith({ startMs: 300000, endMs: 900000, afterId: undefined }, { enabled: true })
  expect((screen.getByRole('button', { name: 'Retain selected waveforms' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Next archive page' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('Frozen night'), { target: { value: 'two' } })
  expect(mock.page).toHaveBeenLastCalledWith({ startMs: 1500000, endMs: 2100000, afterId: undefined }, { enabled: true })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Retain selected waveforms' }))
  await screen.findByText('Protocol for waveform-id')
  expect(mock.publish).toHaveBeenCalledWith({ parentDatasetId: 'parent', expectedContentHash: 'exact-hash',
    cohorts: [{ cohortId: 'one', sourceIds: ['a', 'b'] }, { cohortId: 'two', sourceIds: ['c'] }], idempotencyKey: expect.any(String) })
})
it('retries an uncertain publication with the identical request and does not claim deferred or released bytes', async () => {
  view()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('Frozen night'), { target: { value: 'two' } })
  fireEvent.click(screen.getByRole('checkbox'))
  mock.publish.mockRejectedValueOnce(new Error('Lost reply')).mockResolvedValueOnce({ status: 'deferred' })
    .mockResolvedValueOnce({ status: 'published', dataset: { id: 'released', available: false } })
  const button = screen.getByRole('button', { name: 'Retain selected waveforms' })
  fireEvent.click(button)
  await waitFor(() => expect(mock.publish).toHaveBeenCalledTimes(1))
  fireEvent.click(button)
  await waitFor(() => expect(mock.publish).toHaveBeenCalledTimes(2))
  expect(screen.queryByText(/Waveform dataset retained:/)).toBeNull()
  expect(mock.publish.mock.calls[0][0]).toEqual(mock.publish.mock.calls[1][0])
  fireEvent.click(button)
  await screen.findByText(/This request refers to a released dataset/)
  expect(screen.queryByText(/Protocol for/)).toBeNull()
})
it('preserves a deferred scan cursor, advances unavailable sources, and stops at completion', async () => {
  mock.scan.mockResolvedValueOnce({ status: 'deferred', nextCursor: null })
    .mockResolvedValueOnce({ status: 'source_unavailable', nextCursor: 'a.RAW.gz' })
    .mockResolvedValueOnce({ status: 'complete', nextCursor: null })
  view()
  const button = screen.getByRole('button', { name: 'Inspect next archive' })
  fireEvent.click(button)
  await waitFor(() => expect(mock.refetch).toHaveBeenCalledTimes(1))
  fireEvent.click(button)
  await waitFor(() => expect(mock.refetch).toHaveBeenCalledTimes(2))
  expect(mock.scan.mock.calls[0][0]).toEqual(mock.scan.mock.calls[1][0])
  fireEvent.click(button)
  await screen.findByText('Archive scan complete.')
  expect(mock.scan).toHaveBeenLastCalledWith({ afterName: 'a.RAW.gz' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Restart archive scan' }))
  expect(screen.queryByText('Archive scan complete.')).toBeNull()
  expect((button as HTMLButtonElement).disabled).toBe(false)
  mock.scan.mockResolvedValueOnce({ status: 'complete', nextCursor: null })
  fireEvent.click(button)
  await screen.findByText('Archive scan complete.')
  expect(mock.scan).toHaveBeenLastCalledWith({ afterName: null })
})
it('does not allow new scans without admission', () => {
  mock.admitted = false
  view()
  expect((screen.getByRole('button', { name: 'Inspect next archive' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/New archive work is currently deferred/)).toBeTruthy()
})
it('reports admission failures and waits for admission before offering scans', () => {
  mock.admission = { error: { message: 'Admission unavailable' }, refetch: mock.refetch }
  view()
  expect(screen.getByText('Admission unavailable')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Inspect next archive' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByText(/New archive work is currently deferred/)).toBeNull()
})
it('does not query archives or allow retention without frozen nights', () => {
  view([])
  expect(mock.page).toHaveBeenCalledWith({ startMs: 0, endMs: 1, afterId: undefined }, { enabled: false })
  expect((screen.getByRole('button', { name: 'Retain selected waveforms' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('Selected archives for this night: 0 / 64')).toBeTruthy()
  expect((screen.getByLabelText('Frozen night') as HTMLSelectElement).options).toHaveLength(0)
})
it('reports the last scan and publication outcomes truthfully', () => {
  mock.scanData = { status: 'source_unavailable' }
  const rendered = view()
  expect(screen.getByText(/The last archive was unavailable/)).toBeTruthy()
  mock.scanData = { status: 'archive_unavailable' }
  rendered.rerender(element())
  expect(screen.getByText('The archive directory is unavailable.')).toBeTruthy()
  expect(screen.queryByText(/The last archive was unavailable/)).toBeNull()
  mock.scanData = { status: 'deferred' }
  rendered.rerender(element())
  expect(screen.getByText(/your selection and retry key are preserved/)).toBeTruthy()
  mock.scanData = undefined
  mock.publishData = { status: 'deferred' }
  mock.publishError = { message: 'Publication refused' }
  rendered.rerender(element())
  expect(screen.getByText(/your selection and retry key are preserved/)).toBeTruthy()
  expect(screen.getByText('Publication refused')).toBeTruthy()
})
it('shows archive listing states and exact event bounds, and limits selection to usable archives', () => {
  mock.page.mockReturnValue({})
  const rendered = view()
  expect(screen.queryByRole('checkbox')).toBeNull()
  mock.page.mockReturnValue({ error: { message: 'Listing failed' } })
  rendered.rerender(element())
  expect(screen.getByText('Listing failed')).toBeTruthy()
  mock.page.mockReturnValue({ data: { items: [], nextCursor: null } })
  rendered.rerender(element())
  expect(screen.getByText('No inspected archives overlap this night. Inspect archives first.')).toBeTruthy()
  mock.page.mockReturnValue({ data: { items: [source('a', { first_event_ms: 600000, last_event_ms: 900000 }), source('d', { ordered_waveform_available: false })], nextCursor: null } })
  rendered.rerender(element())
  expect(screen.getByText('Archive event bounds (UTC): 1970-01-01T00:10:00.000Z to 1970-01-01T00:15:00.000Z')).toBeTruthy()
  const [usable, unusable] = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(unusable.disabled).toBe(true)
  fireEvent.click(usable)
  expect(screen.getByText('Selected archives for this night: 1 / 64')).toBeTruthy()
  fireEvent.click(usable)
  expect(screen.getByText('Selected archives for this night: 0 / 64')).toBeTruthy()
  fireEvent.click(usable)
  fireEvent.click(screen.getByRole('button', { name: 'Clear this night’s selection' }))
  expect(screen.getByText('Selected archives for this night: 0 / 64')).toBeTruthy()
  expect(usable.checked).toBe(false)
})
it('returns to the first archive page and caps a night at 64 archives', () => {
  const many = Array.from({ length: 65 }, (_, index) => source(`s${index}`))
  mock.page.mockImplementation(({ afterId }) => ({ data: { items: afterId ? many : [source('a')], nextCursor: afterId ? null : 'next' } }))
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Next archive page' }))
  expect(mock.page).toHaveBeenLastCalledWith({ startMs: 300000, endMs: 900000, afterId: 'next' }, { enabled: true })
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
  for (const box of boxes.slice(0, 64)) fireEvent.click(box)
  expect(screen.getByText('Selected archives for this night: 64 / 64')).toBeTruthy()
  expect(boxes[64].disabled).toBe(true)
  expect(boxes[0].disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'First archive page' }))
  expect(mock.page).toHaveBeenLastCalledWith({ startMs: 300000, endMs: 900000, afterId: undefined }, { enabled: true })
  expect(screen.queryByRole('button', { name: 'First archive page' })).toBeNull()
})
