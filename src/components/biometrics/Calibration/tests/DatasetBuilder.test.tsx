import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DatasetBuilder } from '../DatasetBuilder'
const items = [
  { id: 'ref-1', familyId: 'family', revision: 1, available: true, summary: { source: 'watch', subjectId: 'sleeper' } },
  { id: 'ref-2', familyId: 'family', revision: 2, available: true, summary: { source: 'watch', subjectId: 'sleeper' } },
  { id: 'other', familyId: 'other-family', revision: 1, available: true, summary: { source: 'other watch', subjectId: 'another sleeper' } },
]
const mock = vi.hoisted(() => ({ create: vi.fn(), invalidate: vi.fn(), imports: vi.fn(), data: undefined as unknown, error: null as Error | null }))
vi.mock('../ReplaySessionPicker', () => ({ ReplaySessionPicker: ({ onChange }: { onChange: (ids: number[]) => void }) => <button onClick={() => onChange([9, 2])}>Select nights</button> }))
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listDatasets: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    createDataset: { useMutation: () => ({ mutateAsync: mock.create, data: mock.data, error: mock.error, isPending: false }) },
    listImports: { useQuery: mock.imports },
  },
} }))
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.data = undefined
  mock.error = null
  mock.imports.mockReturnValue({ data: { items, nextCursor: null } })
  mock.create.mockImplementation(async () => {
    mock.data = { id: 'dataset-id', contentHash: 'content-hash', manifest: { splitProtocol: { evidence: 'descriptive_only', assignments: [], limitations: [] }, limitations: [] } }
    return mock.data
  })
})
function setup() {
  render(<I18nProvider i18n={i18n}><DatasetBuilder side="left" /></I18nProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Select nights' }))
  fireEvent.change(screen.getByLabelText('Dataset sleeper identifier'), { target: { value: 'sleeper' } })
}
it('freezes exact sessions and one reference revision with no invented validation result', async () => {
  setup()
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
  expect(boxes[2].disabled).toBe(true)
  fireEvent.click(boxes[0])
  expect(boxes[1].disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Freeze selected inputs' }))
  await screen.findByText('Dataset saved: dataset-id')
  expect(mock.create).toHaveBeenCalledWith({ side: 'left', subjectId: 'sleeper', sessionIds: [2, 9], referenceImportIds: ['ref-1'], idempotencyKey: expect.any(String) })
  expect(screen.getByText(/Too few independent nights/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Freeze selected inputs' }) as HTMLButtonElement).disabled).toBe(true)
})
it('clears reference mapping when the sleeper changes', () => {
  setup()
  fireEvent.click(screen.getAllByRole('checkbox')[0])
  fireEvent.change(screen.getByLabelText('Dataset sleeper identifier'), { target: { value: 'another sleeper' } })
  expect(screen.getByText('Selected reference revisions: 0 / 20')).toBeTruthy()
  expect(screen.getByText(/No references selected/)).toBeTruthy()
})
it('reuses its exact request key after an uncertain response', async () => {
  setup()
  mock.create.mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Freeze selected inputs' }))
  await waitFor(() => expect(mock.create).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'Freeze selected inputs' }))
  await screen.findByText('Dataset saved: dataset-id')
  expect(mock.create.mock.calls[0][0]).toEqual(mock.create.mock.calls[1][0])
})
it('labels split assignments and limitations of a frozen dataset', async () => {
  mock.create.mockImplementation(async () => {
    mock.data = { id: 'dataset-id', contentHash: 'content-hash', manifest: { splitProtocol: { evidence: 'validated_split', assignments: [
      { cohortId: 'a', nightLabels: ['Mon', 'Tue'], split: 'tuning' }, { cohortId: 'b', nightLabels: ['Wed'], split: 'validation' }, { cohortId: 'c', nightLabels: ['Thu'], split: 'holdout' },
    ], limitations: ['Split limitation'] }, limitations: ['Dataset limitation'] } }
    return mock.data
  })
  setup()
  fireEvent.click(screen.getByRole('button', { name: 'Freeze selected inputs' }))
  await screen.findByText('Dataset saved: dataset-id')
  expect(screen.getByText(/Whole-night partitions assigned/)).toBeTruthy()
  expect(screen.getByText('Mon, Tue — Tuning')).toBeTruthy()
  expect(screen.getByText('Wed — Validation')).toBeTruthy()
  expect(screen.getByText('Thu — Holdout')).toBeTruthy()
  expect(screen.getByText('Split limitation')).toBeTruthy()
  expect(screen.getByText('Dataset limitation')).toBeTruthy()
})
it('shows mutation errors and lets a selected reference be removed or unchecked', () => {
  mock.error = new Error('Freeze unavailable')
  setup()
  expect(screen.getByText('Freeze unavailable')).toBeTruthy()
  const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
  fireEvent.click(boxes[0])
  expect(screen.getByText('Another revision from this reference family is selected.')).toBeTruthy()
  expect(screen.getByText('Unavailable or belongs to a different sleeper.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove reference ref-1' }))
  expect(screen.getByText('Selected reference revisions: 0 / 20')).toBeTruthy()
  fireEvent.click(boxes[1])
  expect(screen.getByText('Selected reference revisions: 1 / 20')).toBeTruthy()
  fireEvent.click(boxes[1])
  expect(screen.getByText('Selected reference revisions: 0 / 20')).toBeTruthy()
})
it('reports reference listing errors, loading and empty pages and walks cursors', () => {
  mock.imports.mockReturnValue({ error: new Error('Imports unavailable') })
  setup()
  expect(screen.getByText('Imports unavailable')).toBeTruthy()
  mock.imports.mockReturnValue({})
  fireEvent.change(screen.getByLabelText('Dataset sleeper identifier'), { target: { value: 'sleeper two' } })
  expect(screen.queryByText('Imports unavailable')).toBeNull()
  mock.imports.mockReturnValue({ data: { items: [], nextCursor: { createdAtMs: 5, id: 'older' } } })
  fireEvent.change(screen.getByLabelText('Dataset sleeper identifier'), { target: { value: 'sleeper three' } })
  expect(screen.getByText('No reference imports for this side.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Older imports' }))
  expect(mock.imports).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: 5, beforeId: 'older' })
  fireEvent.click(screen.getByRole('button', { name: 'Newest imports' }))
  expect(mock.imports).toHaveBeenLastCalledWith({ side: 'left', beforeCreatedAtMs: undefined, beforeId: undefined })
})
