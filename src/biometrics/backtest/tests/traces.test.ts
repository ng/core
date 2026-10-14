// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../algorithms/registry'
import { datasetManifestSchema } from '../contracts'
import { DatasetStore } from '../datasets'
import { BacktestJobStore } from '../jobs'
import { pageStageTraces, readNumericTraces, readReferenceTraces, readStageTraces } from '../traces'
const request = { id: '11111111-1111-4111-8111-111111111111', expectedContentHash: 'a'.repeat(64), configuration: 'candidate' as const, limit: 2 }
const report = { version: 'processed-backtest-report-v1', protocol: { mode: 'stage_replay', clockOffsetMs: 60000 }, nights: ['one', 'two'].map((cohortId, index) => ({
  cohortId, evaluations: [{ label: 'candidate', configHash: 'b'.repeat(64), revisionId: null, windows: [{ startMs: index * 300, endMs: index * 300 + 300,
    blocks: [0, 1, 2].map(i => ({ start: index * 300 + i * 100, end: index * 300 + (i + 1) * 100, stage: 'light' })) }] }],
})) }
it('pages every retained interval exactly once with a stable hash cursor and no timestamp offset', () => {
  const before = JSON.stringify(report)
  const first = pageStageTraces(report, request)
  const second = pageStageTraces(report, { ...request, offset: first.nextCursor?.offset })
  const third = pageStageTraces(report, { ...request, offset: second.nextCursor?.offset })
  expect(first).toMatchObject({ totalItems: 6, downsampled: false, clockOffsetMs: 60000, nextCursor: { offset: 2, contentHash: request.expectedContentHash } })
  expect([...first.items, ...second.items, ...third.items].map(row => row.startMs)).toEqual([0, 100, 200, 300, 400, 500])
  expect(third.nextCursor).toBeNull()
  expect(pageStageTraces(report, { ...request, offset: 6 }).items).toEqual([])
  expect(JSON.stringify(report)).toBe(before)
})
it('filters the cohort before counting and rejects out-of-range or missing selections', () => {
  expect(pageStageTraces(report, { ...request, cohortId: 'two' })).toMatchObject({ totalItems: 3, items: [{ cohortId: 'two' }, { cohortId: 'two' }] })
  expect(() => pageStageTraces(report, { ...request, cohortId: 'missing' })).toThrow('not evaluated')
  expect(() => pageStageTraces(report, { ...request, configuration: 'default' })).toThrow('not evaluated')
  expect(() => pageStageTraces(report, { ...request, offset: 7 })).toThrow('cursor')
  expect(() => pageStageTraces(report, { ...request, limit: 501 })).toThrow()
  expect(() => pageStageTraces({ ...report, protocol: { ...report.protocol, mode: 'comparison' } }, request)).toThrow('did not produce')
})
it('serves waveform stage traces only when the protocol replayed stages and rejects unreadable reports', () => {
  expect(pageStageTraces({ ...report, version: 'waveform-backtest-report-v1', protocol: { ...report.protocol, mode: 'signal_replay', waveformStages: true } }, request)).toMatchObject({ totalItems: 6 })
  expect(() => pageStageTraces({ ...report, protocol: { ...report.protocol, mode: 'signal_replay', waveformStages: false } }, request)).toThrow('did not produce')
  expect(() => pageStageTraces({ ...report, protocol: { ...report.protocol, mode: 'signal_replay' } }, request)).toThrow('did not produce')
  expect(() => pageStageTraces({ ...report, nights: null }, request)).toThrow('format is unavailable')
})

const start = 1791673200000
const numericReport = () => {
  const hash = 'b'.repeat(64)
  const reading = { side: 'left', sourceSide: 'left', configHash: hash, timestampMs: 1000, heartRate: 60, breathingRate: null, hrvIndex: null,
    hrvMetric: 'window_ibi_variability_v1', qualityScore: 0, flags: null, limitations: [], hrRaw: 65 }
  return { version: 'waveform-backtest-report-v1', side: 'left', protocol: { mode: 'signal_replay', clockOffsetMs: 0 },
    nights: [{ cohortId: 'one', evaluations: [{ label: 'candidate', configHash: hash, revisionId: null, windows: [{ startMs: 1000, endMs: 5000 }] }] }],
    waveform: { outputs: [{ cohortId: 'one', configHash: hash, readings: [reading] }] } }
}
describe('durable trace reads', () => {
  let sqlite: Database.Database
  let db: ReturnType<typeof drizzle<typeof schema>>
  let jobs: BacktestJobStore
  let dataset: ReturnType<DatasetStore['read']>
  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
    db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(start), leftBedAt: new Date(start + 600000), sleepDurationSeconds: 600, timesExitedBed: 0 }).run()
    const datasets = new DatasetStore(db)
    dataset = datasets.read(datasets.create({ side: 'left', subjectId: 'A', sessionIds: [1], referenceImportIds: [], timezone: 'UTC', idempotencyKey: 'traces' }).id)
    jobs = new BacktestJobStore(db)
  })
  afterEach(() => sqlite.close())
  const config = { label: 'default' as const, revisionId: null, resolved: defaultConfig, resolvedHash: configHash(defaultConfig), manifestHash }
  const enqueue = (idempotencyKey: string, experimentId = jobs.createExperiment(dataset.id, { version: 'descriptive-evaluation-v1', mode: 'stage_replay', assumedStageCalibrationQuality: 0, pointToleranceMs: 30000, clockOffsetMs: 0 }, idempotencyKey).id) =>
    jobs.enqueue({ experimentId, evaluatorBuildHash: 'f'.repeat(64), idempotencyKey, split: 'tuning', configs: [config] })
  const publish = (idempotencyKey: string, mode: 'stage_replay' | 'signal_replay', published: object) => {
    const job = enqueue(idempotencyKey)
    const claimed = jobs.claim('reader')
    if (!claimed) throw new Error('Missing claim')
    const result = jobs.complete({ id: job.id, owner: 'reader', token: claimed.fencingToken }, { ...published, protocol: { mode, clockOffsetMs: 0, pointToleranceMs: 30000 } })
    return { id: job.id, expectedContentHash: result.contentHash }
  }
  it('reads retained stage traces only from a verified, unreleased successful result', () => {
    const published = publish('stage', 'stage_replay', report)
    expect(readStageTraces(db, { ...published, configuration: 'candidate', limit: 2 })).toMatchObject({ totalItems: 6, clockOffsetMs: 0, items: [{ cohortId: 'one' }, { cohortId: 'one' }] })
    expect(() => readStageTraces(db, { ...published, expectedContentHash: '0'.repeat(64), configuration: 'candidate' })).toThrow('hash changed')
    const queued = enqueue('queued', jobs.get(published.id).experimentId)
    expect(() => readStageTraces(db, { ...published, id: queued.id, configuration: 'candidate' })).toThrow('successful replay')
    jobs.releaseResult(published.id, published.expectedContentHash)
    expect(() => readStageTraces(db, { ...published, configuration: 'candidate' })).toThrow('released')
  })
  it('reads retained numeric traces with the same lifecycle checks', () => {
    const published = publish('numeric', 'signal_replay', numericReport())
    expect(readNumericTraces(db, { ...published, configuration: 'candidate' })).toMatchObject({ totalItems: 1, side: 'left', items: [{ timestampMs: 1000 }] })
    expect(() => readNumericTraces(db, { ...published, expectedContentHash: '0'.repeat(64), configuration: 'candidate' })).toThrow('hash changed')
    const queued = enqueue('queued', jobs.get(published.id).experimentId)
    expect(() => readNumericTraces(db, { ...published, id: queued.id, configuration: 'candidate' })).toThrow('successful replay')
    jobs.releaseResult(published.id, published.expectedContentHash)
    expect(() => readNumericTraces(db, { ...published, configuration: 'candidate' })).toThrow('released')
  })
  it('reads frozen reference traces for the retained dataset the report identifies', () => {
    const cohortId = datasetManifestSchema.parse(dataset.manifest).splitProtocol.assignments[0].cohortId
    const identity = { version: 'processed-backtest-report-v1', datasetId: dataset.id, datasetHash: dataset.contentHash,
      nights: [{ cohortId, evaluations: [{ label: 'default', configHash: 'b'.repeat(64), revisionId: null, windows: [{ startMs: start, endMs: start + 600000, blocks: [] }] }] }] }
    const published = publish('reference', 'stage_replay', identity)
    expect(readReferenceTraces(db, { ...published, cohortId, metric: 'heart_rate' })).toMatchObject({ totalItems: 0, side: 'left', datasetHash: dataset.contentHash, provenance: 'frozen_dataset_reference' })
    expect(() => readReferenceTraces(db, { ...published, expectedContentHash: '0'.repeat(64), cohortId, metric: 'heart_rate' })).toThrow('hash changed')
    const queued = enqueue('queued', jobs.get(published.id).experimentId)
    expect(() => readReferenceTraces(db, { ...published, id: queued.id, cohortId, metric: 'heart_rate' })).toThrow('successful replay')
    jobs.releaseResult(published.id, published.expectedContentHash)
    expect(() => readReferenceTraces(db, { ...published, cohortId, metric: 'heart_rate' })).toThrow('released')
  })
})
