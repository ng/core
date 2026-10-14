// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { biometricTuning as handlers } from '../handlers/biometricTuning'
import { manifestHash, resolveConfig } from '@/src/biometrics/algorithms/registry'
import { profileOverviewSchema, revisionSchema } from '@/src/biometrics/profiles/contracts'
vi.mock('../biometrics/run', () => ({ runDemoEvaluation: vi.fn(async () => {
  throw new Error('evaluation unavailable in this test')
}) }))
function required<T>(value: T | undefined): T {
  if (!value) throw new Error('Missing demo handler')
  return value
}
it('reports an unreported activation status and missing rows before any demo activation', async () => {
  const status = await required(handlers.getActivationStatus)({ side: 'left' })
  expect(status).toMatchObject({ desiredGeneration: 0, isCurrent: false, event: null, deliveryState: null, observedState: 'unreported' })
  const unknown = '00000000-0000-4000-8000-000000000000'
  expect(() => required(handlers.getActivationStatus)({ side: 'left', id: unknown })).toThrow('NOT_FOUND: demo activation event')
  expect(() => required(handlers.getProfileRevision)({ id: unknown })).toThrow('NOT_FOUND: demo profile revision')
  await expect(required(handlers.resolveProfile)({ overrides: [], baseManifestHash: '0'.repeat(64) })).rejects.toThrow('PROFILE_INCOMPATIBLE')
  expect(() => required(handlers.reviewValidatedActivation)({ side: 'left', revisionId: unknown, evaluationId: unknown, expectedReportHash: '0'.repeat(64), expectedResolvedHash: '0'.repeat(64), expectedGeneration: 0 })).toThrow('SIMULATED DEMO')
  expect(() => required(handlers.activateValidatedProfile)({ side: 'left', revisionId: unknown, evaluationId: unknown, expectedReportHash: '0'.repeat(64), expectedResolvedHash: '0'.repeat(64), expectedGeneration: 0, boundary: 'immediate', requester: 'demo-test', idempotencyKey: 'validated' })).toThrow('SIMULATED DEMO')
})
it('uses the real manifest, resolution and canonical hashes in the browser demo', async () => {
  const manifest = await required(handlers.getManifest)({})
  expect(manifest.manifestHash).toBe(manifestHash)
  const overrides = [{ path: 'sleep_stages.ruleset.lowSignalBelow', value: 0 }]
  expect(await required(handlers.resolveProfile)({ overrides, baseManifestHash: manifestHash })).toEqual(resolveConfig(overrides))
  await expect(required(handlers.resolveProfile)({ overrides: [{ path: 'heart_rate.trackingHistoryLength', value: 2.5 }] })).rejects.toThrow('Invalid biometric parameter')
  const overview = profileOverviewSchema.parse(await required(handlers.getProfileOverview)({ side: 'left' }))
  expect(overview.stageView.provenance.source).toBe('demo')
  expect(overview.runtimeStatus).toBe('unreported')
  expect(overview.desired.hash).toBe(resolveConfig([]).hash)
})
it('saves immutable candidates idempotently, isolates sides and rejects changed retries', async () => {
  const input = { side: 'left' as const, origin: 'manual' as const, requester: 'demo-test', idempotencyKey: 'candidate-test', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }] }
  const create = required(handlers.createProfileRevision)
  const candidate = revisionSchema.parse(await create({ ...input, parentRevisionId: undefined }))
  expect(candidate.resolvedHash).toBe(resolveConfig(input.overrides).hash)
  expect(await create({ ...input, baseManifestHash: manifestHash })).toEqual(candidate)
  await expect(create({ ...input, overrides: [] })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  await expect(create({ ...input, side: 'right' })).rejects.toThrow('IDEMPOTENCY_CONFLICT')
  candidate.overrides.length = 0
  expect((await required(handlers.getProfileRevision)({ id: candidate.id })).overrides).toHaveLength(1)
  expect((await required(handlers.listProfileRevisions)({ side: 'right' })).items).toEqual([])
  const child = await create({ ...input, idempotencyKey: 'child-test', parentRevisionId: candidate.id })
  expect(child.familyId).toBe(candidate.familyId)
  expect(child.revision).toBe(2)
  await expect(create({ ...input, idempotencyKey: 'wrong-side-child', side: 'right', parentRevisionId: candidate.id })).rejects.toThrow('wrong side')
})

it('compares exact intent and simulates adoption, stale requests, rollback and reset without claiming real health', async () => {
  const create = required(handlers.createProfileRevision)
  const candidate = await create({ side: 'right', origin: 'manual', requester: 'demo-test', idempotencyKey: 'activation-candidate', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }] })
  const diff = await required(handlers.diffProfileRevision)({ side: 'right', revisionId: candidate.id, againstRevisionId: null })
  expect(diff.afterHash).toBe(candidate.resolvedHash)
  expect(diff.changes.map(row => row.path)).toEqual(['heart_rate.trackingToleranceBpm'])
  expect(diff.intentChangedPaths).toEqual(['heart_rate.trackingToleranceBpm'])
  const request = { side: 'right' as const, revisionId: candidate.id, expectedGeneration: 0, expectedResolvedHash: candidate.resolvedHash, boundary: 'next_session' as const, requester: 'demo-test', idempotencyKey: 'activation-request', allowUnvalidated: true as const }
  const event = await required(handlers.activateProfile)(request)
  expect(event.state).toBe('pending_boundary')
  expect(event.reason).toContain('SIMULATED DEMO')
  expect(await required(handlers.activateProfile)(request)).toEqual(event)
  const status = await required(handlers.getActivationStatus)({ side: 'right', id: event.id })
  expect(status.observedState).toBe('pending_boundary')
  expect(status.receiptHealth.state).toBe('unreported')
  expect(status.receipts).toEqual([])
  const clock = vi.spyOn(Date, 'now').mockReturnValue(event.createdAtMs + 4000)
  try {
    const applied = await required(handlers.getActivationStatus)({ side: 'right', id: event.id })
    expect(applied.observedState).toBe('applied')
    expect(applied.receiptHealth.state).toBe('unreported')
    const overview = await required(handlers.getProfileOverview)({ side: 'right' })
    expect(overview.stageView.provenance.bundleHash).toBe(candidate.resolvedHash)
    expect(overview.stageView.provenance.source).toBe('demo')
  }
  finally {
    clock.mockRestore()
  }
  await expect(required(handlers.activateProfile)({ ...request, idempotencyKey: 'stale-request' })).rejects.toThrow('STALE_BINDING')
  const defaults = resolveConfig([])
  const rollback = await required(handlers.rollbackProfile)({ ...request, revisionId: null, expectedGeneration: 1, expectedResolvedHash: defaults.hash, idempotencyKey: 'rollback-request' })
  expect(rollback.action).toBe('rollback')
  expect(rollback.nextRevisionId).toBeNull()
  expect((await required(handlers.getActivationStatus)({ side: 'right', id: event.id })).isCurrent).toBe(false)
  const reset = await required(handlers.resetProfile)({ side: 'right', expectedGeneration: 2, expectedResolvedHash: defaults.hash, boundary: 'immediate', requester: 'demo-test', idempotencyKey: 'reset-request', allowUnvalidated: true })
  expect(reset.action).toBe('reset')
  expect((await required(handlers.listActivationHistory)({ side: 'right' })).items.map(row => row.action)).toEqual(['reset', 'rollback', 'activate'])
})

it('serializes concurrent activation requests so only one can consume a generation', async () => {
  const candidate = await required(handlers.createProfileRevision)({ side: 'left', origin: 'manual', requester: 'demo-test', idempotencyKey: 'race-candidate', overrides: [] })
  const request = { side: 'left' as const, revisionId: candidate.id, expectedGeneration: 0, expectedResolvedHash: candidate.resolvedHash, boundary: 'immediate' as const, requester: 'demo-test', allowUnvalidated: true as const }
  const outcomes = await Promise.allSettled(['race-a', 'race-b'].map(idempotencyKey => required(handlers.activateProfile)({ ...request, idempotencyKey })))
  expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1)
  expect((await required(handlers.getProfileOverview)({ side: 'left' })).desired.binding.generation).toBe(1)
})

it('rejects malformed activation intents, mismatched sides and stale hashes without changing the binding', async () => {
  const create = required(handlers.createProfileRevision)
  const defaults = resolveConfig([])
  const rightCandidate = await create({ side: 'right', origin: 'manual', requester: 'demo-test', idempotencyKey: 'guard-right', overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 18 }] })
  const leftBefore = (await required(handlers.getProfileOverview)({ side: 'left' })).desired
  const leftRevision = leftBefore.binding.desiredRevisionId
  if (!leftRevision) throw new Error('Expected the race test to leave a desired left revision')
  const request = { side: 'left' as const, revisionId: leftRevision, expectedGeneration: leftBefore.binding.generation, expectedResolvedHash: leftBefore.hash, boundary: 'immediate' as const, requester: 'demo-test', idempotencyKey: 'guard-activate', allowUnvalidated: true as const }
  await expect(required(handlers.activateProfile)({ ...request, allowUnvalidated: false as unknown as true })).rejects.toThrow('Explicit unvalidated acknowledgement required')
  await expect(required(handlers.activateProfile)({ ...request, revisionId: rightCandidate.id })).rejects.toThrow('wrong side')
  await expect(required(handlers.activateProfile)({ ...request, expectedResolvedHash: '0'.repeat(64) })).rejects.toThrow('REVISION_CONFLICT: resolved hash changed')
  await expect(required(handlers.rollbackProfile)({ ...request, revisionId: rightCandidate.id, idempotencyKey: 'guard-rollback' })).rejects.toThrow('INVALID_SELECTION')
  await expect(required(handlers.resetProfile)({ side: 'right', expectedGeneration: 0, expectedResolvedHash: defaults.hash, boundary: 'immediate', requester: 'demo-test', idempotencyKey: 'reset-request', allowUnvalidated: true })).rejects.toThrow('REVISION_CONFLICT: activation request changed')
  await expect(required(handlers.validateProfileRevision)({ side: 'left', id: rightCandidate.id })).rejects.toThrow('wrong side')
  expect(await required(handlers.validateProfileRevision)({ side: 'right', id: rightCandidate.id })).toMatchObject({ id: rightCandidate.id, resolvedHash: rightCandidate.resolvedHash, compatible: true, evidence: 'not_checked' })
  await expect(required(handlers.diffProfileRevision)({ side: 'left', revisionId: rightCandidate.id, againstRevisionId: null })).rejects.toThrow('wrong side')
  const sibling = await create({ side: 'right', origin: 'manual', requester: 'demo-test', idempotencyKey: 'guard-sibling', parentRevisionId: rightCandidate.id,
    overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 18 }, { path: 'sleep_stages.ruleset.lowSignalBelow', value: 0 }] })
  const diff = await required(handlers.diffProfileRevision)({ side: 'right', revisionId: sibling.id, againstRevisionId: rightCandidate.id })
  expect(diff.changes.map(row => row.path)).toEqual(['sleep_stages.ruleset.lowSignalBelow'])
  expect(diff.intentChangedPaths).toEqual(['sleep_stages.ruleset.lowSignalBelow'])
  const family = await required(handlers.listProfileRevisions)({ side: 'right', familyId: rightCandidate.familyId })
  expect(family.items.map(row => row.id)).toEqual([sibling.id, rightCandidate.id])
  const before = await required(handlers.listProfileRevisions)({ side: 'right', beforeCreatedAtMs: sibling.createdAtMs, beforeId: sibling.id })
  expect(before.items.map(row => row.id)).not.toContain(sibling.id)
  expect((await required(handlers.listProfileRevisions)({ side: 'right', beforeCreatedAtMs: 0 })).items).toEqual([])
  expect((await required(handlers.getProfileOverview)({ side: 'left' })).desired.binding.generation).toBe(leftBefore.binding.generation)
  const current = await required(handlers.getActivationStatus)({ side: 'right' })
  expect(current).toMatchObject({ isCurrent: true, event: { action: 'reset' }, deliveryState: 'delivered' })
  const history = await required(handlers.listActivationHistory)({ side: 'right', beforeGeneration: 2 })
  expect(history.items.map(row => row.generation)).toEqual([1])
  expect(history.nextGeneration).toBeNull()
})

it('pins the current stage view into replay configurations and rejects a stale binding generation', async () => {
  const sessions = await required(handlers.listSessions)({ side: 'left' })
  const dataset = await required(handlers.createDataset)({ side: 'left', subjectId: 'demo', sessionIds: sessions.items.slice(0, 3).map(row => row.id), referenceImportIds: [], idempotencyKey: 'binding-dataset' })
  const experiment = await required(handlers.createExperiment)({ datasetId: dataset.id, idempotencyKey: 'binding-experiment',
    protocol: { version: 'descriptive-evaluation-v1', mode: 'stage_replay', assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 } })
  const binding = (await required(handlers.getProfileOverview)({ side: 'left' })).desired.binding
  const candidate = await required(handlers.createProfileRevision)({ side: 'left', origin: 'manual', requester: 'demo-test', idempotencyKey: 'binding-candidate', overrides: [] })
  const request = { experimentId: experiment.id, candidateRevisionId: candidate.id, split: 'tuning' as const }
  await expect(required(handlers.enqueueBacktest)({ ...request, expectedBindingGeneration: binding.generation + 1, idempotencyKey: 'binding-stale' })).rejects.toThrow('REVISION_CONFLICT: profile binding changed')
  const queued = await required(handlers.enqueueBacktest)({ ...request, expectedBindingGeneration: binding.generation, idempotencyKey: 'binding-job' })
  expect(queued.configurations.map(row => row.label)).toEqual(['default', 'current', 'candidate'])
  await vi.waitFor(async () => expect((await required(handlers.getBacktest)({ id: queued.id })).state).toBe('failed'))
  expect((await required(handlers.getBacktest)({ id: queued.id })).error).toBe('evaluation unavailable in this test')
})

it('pages more than one hundred saved revisions', async () => {
  const create = required(handlers.createProfileRevision)
  const existing = (await required(handlers.listProfileRevisions)({ side: 'left' })).items.length
  for (let index = existing; index < 101; index++) await create({ side: 'left', origin: 'manual', requester: 'demo-test', idempotencyKey: `page-${index}`, overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 10 + (index % 20) }] })
  const first = await required(handlers.listProfileRevisions)({ side: 'left' })
  expect(first.items).toHaveLength(100)
  expect(first.nextCursor).not.toBeNull()
  const second = await required(handlers.listProfileRevisions)({ side: 'left', beforeCreatedAtMs: first.nextCursor?.createdAtMs, beforeId: first.nextCursor?.id })
  expect(second.items.map(row => row.id)).not.toContain(first.items[99].id)
  expect(second.nextCursor).toBeNull()
})
