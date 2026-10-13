import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ReferenceLibrary } from '../ReferenceLibrary'
const mock = vi.hoisted(() => ({ remove: vi.fn(), invalidate: vi.fn(), imports: vi.fn(), records: vi.fn(), removeError: undefined as { message: string } | undefined }))
vi.mock('../CalibrationReferences', () => ({ CalibrationReferences: ({ correction }: { correction: { id: string } }) => <p>{`Correcting ${correction.id}`}</p> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: { settings: { getAll: { useQuery: () => ({ data: { device: { timezone: 'UTC' } } }) } },
  useUtils: () => ({ biometricTuning: { listImports: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    listImports: { useQuery: mock.imports }, getImportMeasurements: { useQuery: mock.records },
    deleteImport: { useMutation: () => ({ mutateAsync: mock.remove, isPending: false, error: mock.removeError }) },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
const item = { id: 'import-id', revision: 1, available: true, summary: { source: 'watch', subjectId: 'sleeper', accepted: 1, unscorable: 0 } }
beforeEach(() => {
  vi.clearAllMocks()
  mock.removeError = undefined
  mock.imports.mockReturnValue({ data: { items: [item], nextCursor: { createdAtMs: 123, id: 'cursor-id' } } })
  mock.records.mockReturnValue({ data: { items: [{ id: 7, metric: 'heart_rate', value: 60, stage: null, unit: 'bpm', startMs: 1791673200000, endMs: 1791673200000, exclusions: [] }], nextCursor: 7 } })
  mock.remove.mockResolvedValue({ id: item.id })
})
const element = () => <I18nProvider i18n={i18n}><ReferenceLibrary side="left" /></I18nProvider>
const view = () => render(element())
it('pages imports and exact normalized measurements without interpolation', () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect measurements' }))
  expect(screen.getByText('60 bpm')).toBeTruthy()
  expect(screen.getAllByText(new Date(1791673200000).toISOString())).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }))
  expect(mock.records).toHaveBeenLastCalledWith({ id: item.id, afterId: 7, limit: 100 })
  fireEvent.click(screen.getByRole('button', { name: 'Older imports' }))
  expect(mock.imports).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: 123, beforeId: 'cursor-id' })
})
it('requires explicit deletion and refreshes the retained library afterward', async () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Delete import' }))
  expect(mock.remove).not.toHaveBeenCalled()
  expect(screen.getByText(/Retained dataset copies must be released separately/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Keep import' }))
  expect(screen.queryByRole('button', { name: 'Permanently delete import' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Delete import' }))
  fireEvent.click(screen.getByRole('button', { name: 'Permanently delete import' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledOnce())
  expect(mock.remove).toHaveBeenCalledWith({ id: item.id })
})
it('keeps deleted metadata visible without offering nonexistent measurements', () => {
  mock.imports.mockReturnValue({ data: { items: [{ ...item, available: false }], nextCursor: null } })
  view()
  expect(screen.getByText('Source measurements deleted')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Inspect measurements' })).toBeNull()
})
it('shows loading, failures and empty libraries without inventing imports', () => {
  mock.imports.mockReturnValue({})
  const rendered = view()
  expect(screen.queryByRole('list')).toBeNull()
  mock.imports.mockReturnValue({ error: { message: 'Library unavailable' } })
  rendered.rerender(element())
  expect(screen.getByText('Library unavailable')).toBeTruthy()
  mock.imports.mockReturnValue({ data: { items: [], nextCursor: null } })
  mock.removeError = { message: 'Deletion refused' }
  rendered.rerender(element())
  expect(screen.getByText('No reference imports for this side.')).toBeTruthy()
  expect(screen.getByText('Deletion refused')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Older imports' })).toBeNull()
})
it('collapses measurements, toggles corrections and returns to the newest imports', () => {
  view()
  const inspect = screen.getByRole('button', { name: 'Inspect measurements' })
  fireEvent.click(inspect)
  expect(screen.getByRole('table')).toBeTruthy()
  fireEvent.click(inspect)
  expect(screen.queryByRole('table')).toBeNull()
  expect(inspect.getAttribute('aria-expanded')).toBe('false')
  const correct = screen.getByRole('button', { name: 'Correct import' })
  fireEvent.click(correct)
  expect(screen.getByText('Correcting import-id')).toBeTruthy()
  fireEvent.click(correct)
  expect(screen.queryByText('Correcting import-id')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Older imports' }))
  fireEvent.click(screen.getByRole('button', { name: 'Newest imports' }))
  expect(mock.imports).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: undefined, beforeId: undefined })
  expect(screen.queryByRole('button', { name: 'Newest imports' })).toBeNull()
})
it('closes the open measurements panel when the inspected import is deleted', async () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect measurements' }))
  expect(screen.getByRole('table')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Delete import' }))
  fireEvent.click(screen.getByRole('button', { name: 'Permanently delete import' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledOnce())
  expect(screen.queryByRole('table')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Permanently delete import' })).toBeNull()
})
it('closes the open correction panel when the corrected import is deleted', async () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Correct import' }))
  expect(screen.getByText('Correcting import-id')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Delete import' }))
  fireEvent.click(screen.getByRole('button', { name: 'Permanently delete import' }))
  await waitFor(() => expect(mock.invalidate).toHaveBeenCalledOnce())
  expect(screen.queryByText('Correcting import-id')).toBeNull()
})
it('renders stage records, missing values and exclusions, and pages back to the first records', () => {
  mock.records.mockReturnValue({ data: { items: [
    { id: 1, metric: 'sleep_stage', value: null, stage: 'deep', unit: '', startMs: 1791673200000, endMs: 1791673260000, exclusions: ['short_interval'] },
    { id: 2, metric: 'heart_rate', value: null, stage: null, unit: 'bpm', startMs: 1791673200000, endMs: 1791673200000, exclusions: [] },
  ], nextCursor: 2 } })
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect measurements' }))
  expect(screen.getByText('deep')).toBeTruthy()
  expect(screen.getByText('short_interval')).toBeTruthy()
  expect(screen.getByText('— bpm')).toBeTruthy()
  expect(screen.getByText('—')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next records' }))
  expect(mock.records).toHaveBeenLastCalledWith({ id: item.id, afterId: 2, limit: 100 })
  fireEvent.click(screen.getByRole('button', { name: 'First records' }))
  expect(mock.records).toHaveBeenLastCalledWith({ id: item.id, afterId: 0, limit: 100 })
  expect(screen.queryByRole('button', { name: 'First records' })).toBeNull()
})
it('reports measurement loading, failures and empty pages', () => {
  mock.records.mockReturnValue({})
  const rendered = view()
  fireEvent.click(screen.getByRole('button', { name: 'Inspect measurements' }))
  expect(screen.queryByRole('table')).toBeNull()
  mock.records.mockReturnValue({ error: { message: 'Records unavailable' } })
  rendered.rerender(element())
  expect(screen.getByText('Records unavailable')).toBeTruthy()
  mock.records.mockReturnValue({ data: { items: [], nextCursor: null } })
  rendered.rerender(element())
  expect(screen.getByText('No retained measurements.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Next records' })).toBeNull()
})
