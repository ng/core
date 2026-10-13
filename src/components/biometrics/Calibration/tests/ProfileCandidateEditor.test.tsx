import { fireEvent, render, screen } from '@testing-library/react'
import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_STAGE_CLASSIFIER } from '@/src/lib/sleep-stage-rules'
import { ProfileCandidateEditor } from '../ProfileCandidateEditor'
const mock = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn(), invalidate: vi.fn(), manifest: vi.fn(), overview: vi.fn(), parent: vi.fn(), parentHash: 'a'.repeat(64), parentSide: 'right' }))
const manifestHash = 'a'.repeat(64)
vi.mock('@/src/utils/trpc', () => ({ trpc: {
  useUtils: () => ({ biometricTuning: { listProfileRevisions: { invalidate: mock.invalidate } } }),
  biometricTuning: {
    getManifest: { useQuery: mock.manifest },
    getProfileOverview: { useQuery: mock.overview },
    getProfileRevision: { useQuery: mock.parent },
    resolveProfile: { useMutation: () => ({ mutateAsync: mock.resolve, isPending: false }) },
    createProfileRevision: { useMutation: () => ({ mutateAsync: mock.create, isPending: false }) },
  },
} }))
const manifest = { manifestHash, manifest: { defaults: { sleep_stages: DEFAULT_STAGE_CLASSIFIER }, parameters: { properties: {
  heart_rate: { properties: { trackingToleranceBpm: { type: 'number', minimum: 5, maximum: 30, default: 15, unit: 'bpm', description: 'Width' } } },
  breathing_rate: { properties: { windowSeconds: { type: 'integer', minimum: 10, maximum: 120, default: 30, unit: 's', description: 'Window' } } },
  hrv_index: { properties: {} },
} } } }
const parentOverrides = [{ path: 'heart_rate.trackingToleranceBpm', value: 18 }, { path: 'sleep_stages.ruleset.lowSignalBelow', value: 0.2 }]
const i18n = setupI18n({ locale: 'en', messages: {} })
beforeEach(() => {
  vi.clearAllMocks()
  mock.parentHash = manifestHash
  mock.parentSide = 'right'
  mock.manifest.mockReturnValue({ data: manifest })
  mock.overview.mockReturnValue({ data: { desired: { binding: { desiredRevisionId: 'parent' }, warning: null } } })
  mock.parent.mockImplementation(() => ({ data: { side: mock.parentSide, baseManifestHash: mock.parentHash, overrides: parentOverrides } }))
  mock.resolve.mockImplementation(async input => ({ hash: 'resolved-hash', overrides: input.overrides }))
  mock.create.mockResolvedValue({ id: 'candidate-id' })
})
const element = (revisionId?: string) => <I18nProvider i18n={i18n}><ProfileCandidateEditor side="right" revisionId={revisionId} /></I18nProvider>
const view = () => render(element())
it('removes explicit overrides, preserves stage intent and saves only a reviewed candidate', async () => {
  view()
  expect(screen.getByText(/original: 18/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove override' }))
  expect(screen.getAllByText('Inherited default')).toHaveLength(2)
  expect((screen.getByLabelText('heart_rate.trackingToleranceBpm') as HTMLInputElement).value).toBe('15')
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate saved: candidate-id')
  expect(mock.create).toHaveBeenCalledWith({ side: 'right', baseManifestHash: manifestHash, parentRevisionId: 'parent', overrides: [{ path: 'sleep_stages.ruleset.lowSignalBelow', value: 0.2 }], origin: 'manual', requester: 'web-calibration', idempotencyKey: expect.any(String) })
})
it('invalidates review after an edit and blocks empty numbers', async () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  fireEvent.change(screen.getByLabelText('heart_rate.trackingToleranceBpm'), { target: { value: '20' } })
  expect(screen.queryByRole('button', { name: 'Save candidate without applying' })).toBeNull()
  fireEvent.change(screen.getByLabelText('heart_rate.trackingToleranceBpm'), { target: { value: '' } })
  expect((screen.getByRole('button', { name: 'Review candidate' }) as HTMLButtonElement).disabled).toBe(true)
})
it('keeps the exact idempotency key when a failed save is retried', async () => {
  view()
  mock.create.mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Network unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate saved: candidate-id')
  expect(mock.create.mock.calls[0][0]).toEqual(mock.create.mock.calls[1][0])
})

it('refuses to rebase an old-engine or wrong-side candidate silently', () => {
  mock.parentHash = 'old-engine'
  const result = view()
  expect(screen.getByText('The saved profile or parameter definitions are incompatible with this editor.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Review candidate' })).toBeNull()
  mock.parentHash = manifestHash
  mock.parentSide = 'left'
  result.rerender(element('other-candidate'))
  expect(screen.getByText('The saved profile or parameter definitions are incompatible with this editor.')).toBeTruthy()
})

it('saves ordered stage edits in the candidate alongside numerical settings', async () => {
  view()
  fireEvent.click(screen.getByText('Candidate sleep-stage rules'))
  fireEvent.click(screen.getByLabelText('Candidate rule 2 stage'))
  fireEvent.click(screen.getByRole('button', { name: 'Move candidate rule 2 up' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate saved: candidate-id')
  const overrides = mock.create.mock.calls[0][0].overrides
  expect(overrides).toContainEqual({ path: 'heart_rate.trackingToleranceBpm', value: 18 })
  expect(overrides).toContainEqual({ path: 'sleep_stages.ruleset.lowSignalBelow', value: 0.2 })
  const original = DEFAULT_STAGE_CLASSIFIER.ruleset.rules
  expect(overrides).toContainEqual({ path: 'sleep_stages.ruleset.rules', value: [original[1], original[0], ...original.slice(2)] })
})

it('removes a stage override to restore inheritance without touching numerical intent', async () => {
  view()
  fireEvent.click(screen.getByText('Candidate sleep-stage rules'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove stage override' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  expect(mock.resolve).toHaveBeenLastCalledWith({ baseManifestHash: manifestHash, overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 18 }] })
})

it('starts from shipped defaults when no profile revision is bound', async () => {
  mock.overview.mockReturnValue({ data: { desired: { binding: { desiredRevisionId: null }, warning: null } } })
  mock.parent.mockReturnValue({})
  view()
  expect(mock.parent).toHaveBeenCalledWith({ id: '00000000-0000-0000-0000-000000000000' }, { enabled: false })
  expect(screen.getByText(/original: 15/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Remove override' })).toBeNull()
  expect((screen.getByLabelText('breathing_rate.windowSeconds') as HTMLInputElement).step).toBe('1')
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate saved: candidate-id')
  expect(mock.create.mock.calls[0][0]).not.toHaveProperty('parentRevisionId')
  expect(mock.create.mock.calls[0][0]).toMatchObject({ side: 'right', baseManifestHash: manifestHash, overrides: [] })
})

it('surfaces discovery failures and waits for pending queries', () => {
  mock.manifest.mockReturnValue({ error: { message: 'Manifest unavailable' } })
  const result = view()
  expect(screen.getByText('Manifest unavailable')).toBeTruthy()
  mock.manifest.mockReturnValue({ data: manifest })
  mock.overview.mockReturnValue({})
  result.rerender(element())
  expect(screen.queryByText('Manifest unavailable')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review candidate' })).toBeNull()
  mock.overview.mockReturnValue({ data: { desired: { binding: { desiredRevisionId: 'parent' }, warning: null } } })
  mock.parent.mockReturnValue({ error: { message: 'Revision unavailable' } })
  result.rerender(element())
  expect(screen.getByText('Revision unavailable')).toBeTruthy()
  mock.parent.mockReturnValue({})
  result.rerender(element())
  expect(screen.queryByText('Revision unavailable')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review candidate' })).toBeNull()
})

it('refuses to edit a bound profile that carries a warning', () => {
  mock.overview.mockReturnValue({ data: { desired: { binding: { desiredRevisionId: 'parent' }, warning: 'Binding is stale' } } })
  view()
  expect(screen.getByText('The saved profile or parameter definitions are incompatible with this editor.')).toBeTruthy()
})

it('uses fallback messages when failures are not errors', async () => {
  mock.resolve.mockRejectedValueOnce('nope')
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('Profile resolution failed.')
  fireEvent.click(screen.getByRole('button', { name: 'Review candidate' }))
  await screen.findByText('resolved-hash')
  mock.create.mockRejectedValueOnce({ code: 'odd' })
  fireEvent.click(screen.getByRole('button', { name: 'Save candidate without applying' }))
  await screen.findByText('Candidate save failed.')
  expect(screen.queryByText('Profile resolution failed.')).toBeNull()
})

it('applies nested stage overrides and ignores paths outside the ruleset', () => {
  mock.parent.mockReturnValue({ data: { side: 'right', baseManifestHash: manifestHash, overrides: [
    ...parentOverrides,
    { path: 'sleep_stages.ruleset.outliers.heartRate.min', value: 33 },
    { path: 'sleep_stages.ruleset.rules.0.stage', value: 'deep' },
    { path: 'sleep_stages.ruleset.missing.leaf', value: 1 },
    { path: 'sleep_stages.ruleset.unknownLeaf', value: 2 },
  ] } })
  view()
  fireEvent.click(screen.getByText('Candidate sleep-stage rules'))
  expect((screen.getByLabelText('heartRate minimum') as HTMLInputElement).value).toBe('33')
  expect((screen.getByLabelText('heartRate maximum') as HTMLInputElement).value).toBe(String(DEFAULT_STAGE_CLASSIFIER.ruleset.outliers.heartRate.max))
  expect(screen.getByText('sleep_stages.ruleset.missing.leaf')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Remove stage override' })).toHaveLength(5)
})
