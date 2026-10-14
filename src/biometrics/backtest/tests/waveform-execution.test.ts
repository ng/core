// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { configHash, dataHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { datasetManifestSchema } from '../contracts'
import { DatasetStore } from '../datasets'
import { podRawInspectionLocation } from '../raw-inspection-child'
import { prepareWaveformDataset } from '../waveform-dataset'
import { waveformEvaluatorBuildIdentity } from '../waveform-build'
import { runWaveformChild } from '../waveform-child'
import { executeWaveformInputs, verifyWaveformJobBuild } from '../waveform-execution'
import { backtestFixture } from './fixtures/backtest'

vi.mock('../waveform-build', () => ({ waveformEvaluatorBuildIdentity: vi.fn() }))
vi.mock('../waveform-child', () => ({ runWaveformChild: vi.fn() }))

const build = 'b'.repeat(64), python = 'c'.repeat(64), digest = 'a'.repeat(64), resolvedHash = configHash(defaultConfig)
let retained: ReturnType<typeof prepareWaveformDataset>
const start = 1791673200000
function fixture(side: 'left' | 'right' = 'left', labels: Array<'default' | 'current' | 'candidate'> = ['default', 'current']) {
  const base = backtestFixture()
  const dataset = structuredClone({ manifest: retained.manifest, snapshot: { ...retained.snapshot, side } })
  const protocol = { ...base.job.protocol, mode: 'signal_replay' as const }
  return { dataset, job: { ...base.job, evaluatorBuildHash: build, datasetHash: dataHash(dataset), protocol, protocolHash: configHash(protocol),
    configs: labels.map(label => ({ ...base.job.configs[0], label })),
    waveform: { pythonBuildHash: python, otherSide: { manifestHash, resolvedHash, resolved: defaultConfig } } } }
}
const reading = (timestampMs: number) => ({ side: 'left' as const, timestampMs, heartRate: 62, hrvIndex: null, hrvMetric: 'window_ibi_variability_v1' as const,
  breathingRate: 12, qualityScore: 1, flags: [], hrRaw: 62, sourceSide: 'left' as const, configHash: resolvedHash, limitations: [] })
const run = { version: 'retained-waveform-run-v1' as const, build_hash: python, decoded_records: 1, raw_records: 1,
  counts: { records: 1, accepted_frames: 1, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: 1 },
  limitations: [], config_hashes: { left: resolvedHash, right: resolvedHash }, artifact_hashes: [digest] }
const rawLocation = { pythonPath: '/python', modulesPath: '/modules', archiveDirectory: '/archive' }
let directory: string, sqlite: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'waveform-execution-')))
  sqlite = new Database(join(directory, 'biometrics.db'))
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  const datasets = new DatasetStore(db)
  const source = datasets.read(datasets.create({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'source' }).id)
  const cohort = datasetManifestSchema.parse(source.manifest).splitProtocol.assignments[0]
  retained = prepareWaveformDataset({ ...source, manifest: datasetManifestSchema.parse(source.manifest) }, [{ cohortId: cohort.cohortId,
    input: { version: 'retained-waveform-input-v1', retained_start_ms: cohort.startMs, score_start_ms: cohort.startMs, score_end_ms: cohort.endMs, contexts: [],
      artifacts: [{ artifact: { sha256: digest, name: `${digest}.RAW.gz`, compressed_bytes: 1, expanded_bytes: 2 }, first_event_ms: cohort.startMs, last_event_ms: cohort.endMs - 1 }] } }], 'raw')
  vi.mocked(waveformEvaluatorBuildIdentity).mockResolvedValue({ hash: build, python: { hash: python } } as Awaited<ReturnType<typeof waveformEvaluatorBuildIdentity>>)
  vi.mocked(runWaveformChild).mockResolvedValue({ readings: [reading(start)], run })
})
afterEach(async () => {
  vi.clearAllMocks()
  sqlite.close()
  await rm(directory, { recursive: true, force: true })
})
const options = () => ({ workerPath: join(directory, 'worker.cjs'), signal: new AbortController().signal })

it('pins the coordinator beside the worker and rejects any build drift since enqueue', async () => {
  const work = fixture()
  await verifyWaveformJobBuild(work, options())
  expect(waveformEvaluatorBuildIdentity).toHaveBeenLastCalledWith(join(directory, 'coordinator.cjs'), join(directory, 'worker.cjs'), podRawInspectionLocation, expect.any(AbortSignal))
  await verifyWaveformJobBuild(work, { ...options(), rawLocation })
  expect(waveformEvaluatorBuildIdentity).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), rawLocation, expect.any(AbortSignal))
  vi.mocked(waveformEvaluatorBuildIdentity).mockResolvedValueOnce({ hash: '0'.repeat(64), python: { hash: python } } as Awaited<ReturnType<typeof waveformEvaluatorBuildIdentity>>)
  await expect(verifyWaveformJobBuild(work, options())).rejects.toThrow('build changed')
  vi.mocked(waveformEvaluatorBuildIdentity).mockResolvedValueOnce({ hash: build, python: { hash: '0'.repeat(64) } } as Awaited<ReturnType<typeof waveformEvaluatorBuildIdentity>>)
  await expect(verifyWaveformJobBuild(work, options())).rejects.toThrow('build changed')
})

it('runs each cohort and distinct configuration through Python beside the persistent database', async () => {
  const work = fixture('left', ['default', 'current', 'candidate'])
  const result = await executeWaveformInputs(db, work, { ...options(), rawLocation, timeoutMs: 5000 })
  expect(runWaveformChild).toHaveBeenCalledTimes(1)
  expect(runWaveformChild).toHaveBeenCalledWith({ ...rawLocation, retainedDirectory: join(directory, 'biometric-raw') },
    { version: 'retained-waveform-work-v1', input: expect.objectContaining({ version: 'retained-waveform-input-v1', score_start_ms: start }), configs: { left: defaultConfig, right: defaultConfig } },
    { signal: expect.any(AbortSignal), timeoutMs: 5000, cpuSeconds: undefined, expectedBuildHash: python })
  expect(result.outputs).toEqual([{ cohortId: retained.manifest.splitProtocol.assignments[0].cohortId, configHash: resolvedHash, readings: [reading(start)], run }])
  expect(result.hash).toBe(dataHash(result.outputs))
  expect(waveformEvaluatorBuildIdentity).toHaveBeenCalledTimes(2)
})

it('routes the retained side to the candidate configuration and the replay budget to the child', async () => {
  const work = fixture('right')
  const replayBudget = { jobWallMs: 60000, waveformWallMs: 30000, waveformCpuSeconds: 20 }
  vi.mocked(runWaveformChild).mockResolvedValueOnce({ readings: [{ ...reading(start), side: 'right', sourceSide: 'right' }], run })
  await executeWaveformInputs(db, work, { ...options(), replayBudget })
  expect(runWaveformChild).toHaveBeenCalledWith({ ...podRawInspectionLocation, retainedDirectory: join(directory, 'biometric-raw') },
    expect.objectContaining({ configs: { left: defaultConfig, right: defaultConfig } }),
    expect.objectContaining({ timeoutMs: 30000, cpuSeconds: 20 }))
})

it('rejects processed jobs, in-memory databases, missing cohorts, cancellation and reading budget overruns', async () => {
  const processed = backtestFixture()
  await expect(executeWaveformInputs(db, processed, options())).rejects.toThrow('Missing retained waveform job inputs')
  await expect(executeWaveformInputs(db, { ...fixture(), job: { ...fixture().job, waveform: undefined } }, options())).rejects.toThrow('Missing retained waveform job inputs')
  await expect(executeWaveformInputs(db, { ...fixture(), dataset: processed.dataset }, options())).rejects.toThrow('Missing retained waveform job inputs')
  const memory = drizzle(new Database(':memory:'), { schema })
  await expect(executeWaveformInputs(memory, fixture(), options())).rejects.toThrow('persistent database')
  const orphan = fixture()
  if (orphan.dataset.snapshot.version === 'waveform-dataset-v1') orphan.dataset.snapshot.waveformInputs[0].cohortId = 'other'
  await expect(executeWaveformInputs(db, orphan, options())).rejects.toThrow('Missing retained waveform cohort')
  const controller = new AbortController()
  controller.abort()
  await expect(executeWaveformInputs(db, fixture(), { ...options(), signal: controller.signal })).rejects.toThrow('cancelled')
  expect(runWaveformChild).not.toHaveBeenCalled()
  vi.mocked(runWaveformChild).mockResolvedValueOnce({ readings: Array.from({ length: 20001 }, (_, index) => reading(start + index)), run })
  await expect(executeWaveformInputs(db, fixture(), options())).rejects.toThrow('reading budget exceeded')
})
