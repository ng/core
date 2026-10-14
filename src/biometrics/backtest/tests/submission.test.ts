// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as configSchema from '@/src/db/schema'
import * as bioSchema from '@/src/db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { ProfileStore } from '../../profiles/store'
import { backtestJobSnapshotSchema } from '../contracts'
import { DatasetStore } from '../datasets'
import { BacktestJobStore } from '../jobs'
import { resolveInstalledReplayBuild, resolveSubmissionBuild, retryBacktestSubmission, submitBacktest } from '../submission'
import { freezeWaveformDataset } from './fixtures/waveform'

const mocks = vi.hoisted(() => ({
  workerPath: vi.fn<() => string>(), coordinatorPath: vi.fn<() => string>(),
  workerBuildHash: vi.fn<(path: string) => Promise<string>>(), waveformBuild: vi.fn<() => Promise<{ hash: string, python: { hash: string } }>>(),
}))
vi.mock('../location', () => ({ packagedWorkerPath: mocks.workerPath, packagedCoordinatorPath: mocks.coordinatorPath }))
vi.mock('../child', () => ({ workerBuildHash: mocks.workerBuildHash }))
vi.mock('../waveform-build', () => ({ waveformEvaluatorBuildIdentity: mocks.waveformBuild }))

let configRaw: Database.Database, bioRaw: Database.Database
let config: ReturnType<typeof drizzle<typeof configSchema>>, bio: ReturnType<typeof drizzle<typeof bioSchema>>
const now = 1791673200000
const protocol = { version: 'descriptive-evaluation-v1' as const, mode: 'stage_replay' as const, assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.workerPath.mockReturnValue('/packaged/worker.cjs')
  mocks.coordinatorPath.mockReturnValue('/packaged/coordinator.cjs')
  mocks.workerBuildHash.mockResolvedValue('e'.repeat(64))
  mocks.waveformBuild.mockResolvedValue({ hash: 'd'.repeat(64), python: { hash: 'b'.repeat(64) } })
  configRaw = new Database(':memory:')
  bioRaw = new Database(':memory:')
  config = drizzle(configRaw, { schema: configSchema })
  bio = drizzle(bioRaw, { schema: bioSchema })
  migrate(config, { migrationsFolder: 'src/db/migrations' })
  migrate(bio, { migrationsFolder: 'src/db/biometrics-migrations' })
  for (let id = 1; id <= 3; id++) bio.insert(bioSchema.sleepRecords).values({ id, side: 'left', enteredBedAt: new Date(now + id * 86400000),
    leftBedAt: new Date(now + id * 86400000 + 3600000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
})
afterEach(() => {
  configRaw.close()
  bioRaw.close()
})

function fixture(mode: 'stage_replay' | 'signal_replay' = 'stage_replay') {
  const revision = new ProfileStore(config).createRevision({ side: 'left', origin: 'manual', requester: 'fixture', idempotencyKey: 'candidate',
    overrides: [{ path: 'heart_rate.trackingToleranceBpm', value: 20 }] })
  const dataset = new DatasetStore(bio).create({ side: 'left', subjectId: 'fixture', sessionIds: [1, 2, 3], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'dataset' })
  if (mode === 'signal_replay') freezeWaveformDataset(bio, dataset.id)
  const experiment = new BacktestJobStore(bio).createExperiment(dataset.id, { ...protocol, mode })
  const request = { experimentId: experiment.id, candidateRevisionId: revision.id, expectedBindingGeneration: 0, split: 'tuning' as const, idempotencyKey: 'submission' }
  return { revision, dataset, experiment, request }
}

describe('backtest submission', () => {
  it('freezes default, current and candidate snapshots and retries idempotently', () => {
    const { revision, request } = fixture()
    expect(retryBacktestSubmission(bio, request)).toBeNull()
    const job = submitBacktest(config, bio, 'f'.repeat(64), request)
    const snapshot = backtestJobSnapshotSchema.parse(job.input)
    expect(snapshot.configs.map(row => [row.label, row.revisionId, row.resolvedHash])).toEqual([
      ['default', null, configHash(defaultConfig)], ['current', null, configHash(defaultConfig)], ['candidate', revision.id, revision.resolvedHash]])
    expect(snapshot.waveform).toBeUndefined()
    expect(snapshot.submissionHash).toBe(configHash(request))
    expect(retryBacktestSubmission(bio, request)?.id).toBe(job.id)
    expect(submitBacktest(config, bio, 'f'.repeat(64), request).id).toBe(job.id)
    expect(() => submitBacktest(config, bio, 'f'.repeat(64), { ...request, split: 'validation' })).toThrow('different submission')
    expect(() => retryBacktestSubmission(bio, { ...request, split: 'validation' })).toThrow('different submission')
  })
  it('rejects unknown experiments, stale bindings and waveform submissions without a Python identity', () => {
    const { request } = fixture()
    expect(() => submitBacktest(config, bio, 'f'.repeat(64), { ...request, experimentId: '00000000-0000-4000-8000-000000000000' })).toThrow('Experiment not found')
    expect(() => submitBacktest(config, bio, 'f'.repeat(64), { ...request, expectedBindingGeneration: 1 })).toThrow('binding changed')
    expect(bio.select().from(bioSchema.biometricBacktestJobs).all()).toEqual([])
    const signal = fixture('signal_replay')
    expect(() => submitBacktest(config, bio, 'f'.repeat(64), { ...signal.request, idempotencyKey: 'signal' })).toThrow('requires the Python build identity')
  })
  it('pins both sides of a waveform submission from the acknowledged baseline', () => {
    const { request, revision } = fixture('signal_replay')
    const job = submitBacktest(config, bio, 'f'.repeat(64), request, 'b'.repeat(64))
    const snapshot = backtestJobSnapshotSchema.parse(job.input)
    expect(snapshot.waveform).toMatchObject({ pythonBuildHash: 'b'.repeat(64),
      otherSide: { manifestHash, resolvedHash: configHash(defaultConfig) },
      baselineProvenance: { current: { source: 'unacknowledged_defaults' }, otherSide: { source: 'unacknowledged_defaults' } } })
    expect(snapshot.configs[2]).toMatchObject({ label: 'candidate', revisionId: revision.id })
  })
})

describe('installed replay build resolution', () => {
  it('returns an existing submission before probing any build identity', async () => {
    const { request } = fixture()
    const job = submitBacktest(config, bio, 'f'.repeat(64), request)
    expect(await resolveSubmissionBuild(bio, request)).toEqual({ existing: job })
    expect(mocks.workerBuildHash).not.toHaveBeenCalled()
    expect(await resolveSubmissionBuild(bio, { ...request, idempotencyKey: 'fresh' })).toEqual({ evaluatorBuildHash: 'e'.repeat(64) })
    expect(mocks.workerBuildHash).toHaveBeenCalledWith('/packaged/worker.cjs')
  })
  it('coalesces concurrent waveform build probes and never caches a finished identity', async () => {
    const [first, second] = await Promise.all([resolveInstalledReplayBuild('signal_replay'), resolveInstalledReplayBuild('signal_replay')])
    expect(first).toEqual({ evaluatorBuildHash: 'd'.repeat(64), pythonBuildHash: 'b'.repeat(64) })
    expect(second).toEqual(first)
    expect(mocks.waveformBuild).toHaveBeenCalledTimes(1)
    expect(mocks.waveformBuild).toHaveBeenCalledWith('/packaged/coordinator.cjs', '/packaged/worker.cjs', expect.objectContaining({ pythonPath: expect.any(String), modulesPath: expect.any(String) }))
    await resolveInstalledReplayBuild('signal_replay')
    expect(mocks.waveformBuild).toHaveBeenCalledTimes(2)
    mocks.coordinatorPath.mockReturnValue('/elsewhere/coordinator.cjs')
    const pending = resolveInstalledReplayBuild('signal_replay')
    const other = resolveInstalledReplayBuild('signal_replay')
    await Promise.all([pending, other])
    expect(mocks.waveformBuild).toHaveBeenCalledTimes(3)
  })
  it('reports unreadable packaged builds as worker unavailability without leaking paths', async () => {
    mocks.workerPath.mockImplementation(() => {
      throw new Error('/secret/path missing')
    })
    await expect(resolveInstalledReplayBuild('comparison')).rejects.toThrow('Packaged replay build identity cannot be read')
    mocks.workerPath.mockReturnValue('/packaged/worker.cjs')
    mocks.waveformBuild.mockRejectedValue(new Error('python exploded'))
    await expect(resolveInstalledReplayBuild('signal_replay')).rejects.toThrow('Packaged replay build identity cannot be read')
    mocks.workerBuildHash.mockRejectedValue(new Error('ENOENT'))
    await expect(resolveInstalledReplayBuild('stage_replay')).rejects.toThrow('Packaged replay build identity cannot be read')
  })
})
