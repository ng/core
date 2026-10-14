// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { configHash, dataHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { workerBuildHash } from '../child'
import { datasetManifestSchema } from '../contracts'
import { DatasetStore } from '../datasets'
import { BacktestJobStore } from '../jobs'
import { executeNextBacktest } from '../runner'
import { prepareWaveformDataset } from '../waveform-dataset'
import { executeWaveformInputs, verifyWaveformJobBuild } from '../waveform-execution'
import { stageObjectiveTestPolicy } from './fixtures/stage-objective'

// The Python replay child is exercised by waveform-execution.test.ts; here the
// runner's signal-replay orchestration is driven through the real scoring worker.
vi.mock('../waveform-execution', () => ({ executeWaveformInputs: vi.fn(), verifyWaveformJobBuild: vi.fn() }))

type Work = Parameters<typeof executeWaveformInputs>[1]
const python = 'c'.repeat(64), digest = 'a'.repeat(64), start = 1791673200000
const resolvedHash = configHash(defaultConfig)
const protocol = { version: 'descriptive-evaluation-v1' as const, mode: 'signal_replay' as const, assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let jobs: BacktestJobStore
let directory: string
let evaluatorBuildHash: string
let datasetId: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'biometric-runner-waveform-'))
  await promisify(execFile)(process.execPath, ['scripts/build/biometrics-worker.mjs', directory])
  evaluatorBuildHash = await workerBuildHash(join(directory, 'worker.cjs'))
})
afterAll(async () => rm(directory, { recursive: true, force: true }))
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
  for (let minute = 0; minute < 10; minute++) db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(start + minute * 60000), heartRate: 60, hrv: 30, breathingRate: 14 }).run()
  const datasets = new DatasetStore(db)
  const source = datasets.read(datasets.create({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'source' }).id)
  const cohort = datasetManifestSchema.parse(source.manifest).splitProtocol.assignments[0]
  const prepared = prepareWaveformDataset({ ...source, manifest: datasetManifestSchema.parse(source.manifest) }, [{ cohortId: cohort.cohortId,
    input: { version: 'retained-waveform-input-v1', retained_start_ms: cohort.startMs, score_start_ms: cohort.startMs, score_end_ms: cohort.endMs, contexts: [],
      artifacts: [{ artifact: { sha256: digest, name: `${digest}.RAW.gz`, compressed_bytes: 1, expanded_bytes: 2 }, first_event_ms: cohort.startMs, last_event_ms: cohort.endMs - 1 }] } }], 'raw')
  db.insert(schema.biometricDatasets).values({ ...prepared, byteLength: Buffer.byteLength(JSON.stringify(prepared.manifest)) + Buffer.byteLength(JSON.stringify(prepared.snapshot)) }).run()
  datasetId = prepared.id
  jobs = new BacktestJobStore(db)
  vi.mocked(verifyWaveformJobBuild).mockResolvedValue(undefined)
  vi.mocked(executeWaveformInputs).mockImplementation(async (_db, work: Work) => {
    if (work.dataset.snapshot.version !== 'waveform-dataset-v1' || !work.job.waveform) throw new Error('Processed work reached the waveform executor')
    const assignments = datasetManifestSchema.parse(work.dataset.manifest).splitProtocol.assignments.filter(row => row.split === work.job.split)
    const configs = [...new Map(work.job.configs.map(config => [config.resolvedHash, config])).values()]
    const outputs = assignments.flatMap(cohort => configs.map((config) => {
      const input = work.dataset.snapshot.version === 'waveform-dataset-v1' ? work.dataset.snapshot.waveformInputs.find(row => row.cohortId === cohort.cohortId)?.input : undefined
      if (!input) throw new Error('Missing retained cohort')
      const readings = Array.from({ length: 10 }, (_, minute) => ({ side: 'left' as const, timestampMs: cohort.startMs + minute * 60000, heartRate: 60, hrvIndex: 30,
        hrvMetric: 'window_ibi_variability_v1' as const, breathingRate: 14, qualityScore: 1, flags: [], hrRaw: 60, sourceSide: 'left' as const, configHash: config.resolvedHash, limitations: [] }))
      return { cohortId: cohort.cohortId, configHash: config.resolvedHash, readings, run: { version: 'retained-waveform-run-v1' as const, build_hash: python,
        decoded_records: 10, raw_records: 10, counts: { records: 10, accepted_frames: 10, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: readings.length },
        limitations: ['missing_pump_context'], config_hashes: { left: config.resolvedHash, right: work.job.waveform?.otherSide.resolvedHash ?? resolvedHash }, artifact_hashes: input.artifacts.map(row => row.artifact.sha256) } }
    }))
    return { hash: dataHash(outputs), outputs }
  })
})
afterEach(async () => {
  vi.clearAllMocks()
  sqlite.close()
  await rm(join(directory, 'promotion-qualifications.json'), { force: true })
})
const options = { owner: 'waveform-test', get workerPath() {
  return join(directory, 'worker.cjs')
}, admit: async () => true }
const config = (label: 'default' | 'current' | 'candidate', revisionId: string | null = null) => ({ label, revisionId, resolved: defaultConfig, resolvedHash, manifestHash })
const enqueue = (experimentProtocol: typeof protocol & { waveformStages?: boolean, stageObjectivePolicy?: typeof stageObjectiveTestPolicy }, configs = [config('default'), config('current')]) => {
  const experiment = jobs.createExperiment(datasetId, experimentProtocol)
  return jobs.enqueue({ evaluatorBuildHash, experimentId: experiment.id, idempotencyKey: 'waveform', split: 'tuning', configs,
    waveform: { pythonBuildHash: python, otherSide: { manifestHash, resolvedHash, resolved: defaultConfig } } }).id
}

it('replays retained waveforms through Python, re-verifies the pinned build and publishes a descriptive waveform report', async () => {
  const jobId = enqueue(protocol)
  expect(await executeNextBacktest(db, options)).toEqual({ state: 'succeeded', jobId })
  expect(executeWaveformInputs).toHaveBeenCalledTimes(1)
  expect(executeWaveformInputs).toHaveBeenCalledWith(db, expect.objectContaining({ job: expect.objectContaining({ datasetId }) }), expect.objectContaining({ owner: 'waveform-test', signal: expect.any(AbortSignal) }))
  expect(verifyWaveformJobBuild).toHaveBeenCalledTimes(1)
  expect(jobs.result(jobId)?.report).toMatchObject({ version: 'waveform-backtest-report-v1', status: 'insufficient_evidence', qualificationWarning: null,
    waveform: { pythonBuildHash: python, otherSideConfigHash: resolvedHash }, nights: [{ uniqueObservationCount: 10 }] })
})

it('fails the job instead of publishing when the waveform build drifts after scoring', async () => {
  const jobId = enqueue(protocol)
  vi.mocked(verifyWaveformJobBuild).mockRejectedValueOnce(new Error('Waveform worker build changed since enqueue'))
  expect(await executeNextBacktest(db, options)).toEqual({ state: 'stopped', jobId })
  expect(jobs.get(jobId)).toMatchObject({ state: 'failed' })
  expect(jobs.result(jobId)).toBeNull()
})

it.each([
  [['missing_pump_context'], null],
  [[], 'Replay context is outside the installed qualification; this report is descriptive.'],
] as const)('keeps an installed waveform qualification only when every replay limitation %j was qualified', async (allowedLimitations, qualificationWarning) => {
  const qualified = { ...protocol, waveformStages: true, stageObjectivePolicy: stageObjectiveTestPolicy }
  const jobId = enqueue(qualified, [config('default'), config('current'), config('candidate', '33333333-3333-4333-8333-333333333333')])
  await writeFile(join(directory, 'promotion-qualifications.json'), JSON.stringify({ version: 'biometric-promotion-qualifications-v1', entries: [{
    qualificationId: stageObjectiveTestPolicy.qualificationId, manifestHash, evaluatorBuildHash, pythonBuildHash: python, protocol: qualified,
    fixtureEvidenceHash: 'a'.repeat(64), podEvidenceHash: 'b'.repeat(64), waveformContext: { allowedLimitations: [...allowedLimitations] },
  }] }))
  expect(await executeNextBacktest(db, options)).toEqual({ state: 'succeeded', jobId })
  expect(jobs.result(jobId)?.report).toMatchObject({ version: 'waveform-backtest-report-v1', status: 'no_material_change', qualificationWarning })
})
