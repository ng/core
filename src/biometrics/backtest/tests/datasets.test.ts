// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { previewReferenceImport } from '../../references/normalize'
import { ReferenceStore } from '../../references/store'
import { DatasetStore } from '../datasets'
let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let datasets: DatasetStore
let references: ReferenceStore
const startMs = 1791673200000
const upload = { side: 'left' as const, subjectId: 'sleeper-A', source: 'fixture', rows: [
  { recordKey: 'hr', metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: startMs },
] }
const request = { side: 'left' as const, subjectId: 'sleeper-A', sessionIds: [1], referenceImportIds: [] as string[], timezone: 'America/Los_Angeles', idempotencyKey: 'dataset-1' }
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  datasets = new DatasetStore(db)
  references = new ReferenceStore(db)
  db.insert(schema.sleepRecords).values({ id: 1, side: 'left', enteredBedAt: new Date(startMs), leftBedAt: new Date(startMs + 3600000), sleepDurationSeconds: 3600, timesExitedBed: 0 }).run()
  db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(startMs), heartRate: 65 }).run()
})
afterEach(() => sqlite.close())

describe('retained processed datasets', () => {
  it('keeps exact input bytes after reference correction/deletion and observation retention', () => {
    const first = references.commit({ import: upload, previewHash: previewReferenceImport(upload).summary.contentHash })
    const dataset = datasets.create({ ...request, referenceImportIds: [first.id] })
    const before = datasets.read(dataset.id)
    const correction = { ...upload, rows: [{ ...upload.rows[0], value: 90 }] }
    references.commit({ import: correction, previewHash: previewReferenceImport(correction).summary.contentHash, supersedesImportId: first.id })
    references.delete(first.id)
    db.delete(schema.vitals).run()
    db.delete(schema.sleepRecords).run()
    const after = datasets.read(dataset.id)
    expect(after).toEqual(before)
    expect(after.snapshot.sessions[0].vitals[0].heartRate).toBe(65)
    expect(after.snapshot.references[0].measurements[0].value).toBe(60)
    expect(after.manifest).toMatchObject({ capabilities: { signalReplay: false, stageReplay: true }, splitProtocol: { evidence: 'descriptive_only' } })
    expect(datasets.create({ ...request, referenceImportIds: [first.id] }).id).toBe(dataset.id)
  })
  it('rejects cross-side sessions, sleeper mismatches, duplicate revisions and changed idempotency requests', () => {
    expect(() => datasets.create({ ...request, side: 'right' })).toThrow('missing or belongs')
    const first = references.commit({ import: upload, previewHash: previewReferenceImport(upload).summary.contentHash })
    expect(() => datasets.create({ ...request, subjectId: 'B', referenceImportIds: [first.id] })).toThrow('match')
    const correction = { ...upload, rows: [{ ...upload.rows[0], value: 70 }] }
    const second = references.commit({ import: correction, previewHash: previewReferenceImport(correction).summary.contentHash, supersedesImportId: first.id })
    expect(() => datasets.create({ ...request, referenceImportIds: [first.id, second.id] })).toThrow('one revision')
    datasets.create(request)
    expect(() => datasets.create({ ...request, timezone: 'UTC' })).toThrow('different selection')
  })
  it('detects corrupted retained bytes and enforces aggregate storage quota atomically', () => {
    const dataset = datasets.create(request)
    sqlite.prepare('UPDATE biometric_datasets SET snapshot = json_set(snapshot, ?, ?) WHERE id = ?')
      .run('$.sessions[0].vitals[0].heartRate', 99, dataset.id)
    expect(() => datasets.read(dataset.id)).toThrow('integrity')
    sqlite.prepare('UPDATE biometric_datasets SET byte_length = ?').run(64 * 1024 * 1024)
    expect(() => datasets.create({ ...request, idempotencyKey: 'second' })).toThrow('storage budget')
    expect(datasets.list('left')).toHaveLength(1)
    expect(datasets.list('right')).toEqual([])
  })
  it('retains and verifies realistic multi-night rows beyond the configuration hash node budget', () => {
    db.delete(schema.vitals).run()
    db.delete(schema.sleepRecords).run()
    const insert = sqlite.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)')
    sqlite.transaction(() => {
      for (let night = 1; night <= 3; night++) {
        const entered = startMs + night * 86400000
        db.insert(schema.sleepRecords).values({ id: night, side: 'left', enteredBedAt: new Date(entered), leftBedAt: new Date(entered + 43200000), sleepDurationSeconds: 43200, timesExitedBed: 0 }).run()
        for (let minute = 0; minute < 720; minute++) insert.run('left', entered / 1000 + minute * 60, 60 + (minute % 10) / 10)
      }
    })()
    const dataset = datasets.create({ ...request, sessionIds: [1, 2, 3] })
    expect(datasets.read(dataset.id).snapshot.sessions.reduce((total, session) => total + session.vitals.length, 0)).toBe(2160)
    expect(datasets.descriptor(dataset.id).contentHash).toBe(dataset.contentHash)
  })

  it('records exact processing bundles when available and keeps missing provenance explicit', () => {
    db.insert(schema.biometricProcessingRuns).values({ id: 'run-1', side: 'left', kind: 'live', bundle: { version: 'fixture' },
      configHash: 'fixture-hash', inputIdentity: { origin: 'fixture' }, startedAtMs: startMs }).run()
    sqlite.prepare('UPDATE vitals SET processing_run_id = ?').run('run-1')
    const frozen = datasets.read(datasets.create(request).id)
    expect(frozen.snapshot.processingRuns[0]).toMatchObject({ id: 'run-1', calibrationHash: null, bundle: { version: 'fixture' } })
    expect(frozen.snapshot.sessions[0].vitals[0].processingRunId).toBe('run-1')
    expect(frozen.manifest).toMatchObject({ coverage: [{ vitals: { count: 1, gapDurationMs: 3540000 } }] })
  })

  it('rejects duplicate selections and processed snapshots beyond the retained row budget', () => {
    expect(() => datasets.create({ ...request, sessionIds: [1, 1] })).toThrow('once')
    expect(() => datasets.create({ ...request, referenceImportIds: ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'] })).toThrow('once')
    sqlite.prepare('UPDATE sleep_records SET left_bed_at = ?').run(startMs / 1000 + 30000)
    const insert = sqlite.prepare('INSERT INTO movement (side, timestamp, total_movement) VALUES (?, ?, ?)')
    sqlite.transaction(() => {
      for (let second = 0; second < 20001; second++) insert.run('left', startMs / 1000 + second, 5)
    })()
    expect(() => datasets.create(request)).toThrow('row budget')
    db.delete(schema.movement).run()
    db.insert(schema.movement).values({ side: 'left', timestamp: new Date(startMs), totalMovement: 3 }).run()
    db.delete(schema.vitals).run()
    const vitals = sqlite.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)')
    sqlite.transaction(() => {
      for (let second = 0; second < 20001; second++) vitals.run('left', startMs / 1000 + second, 60)
    })()
    expect(() => datasets.create(request)).toThrow('row budget')
    db.delete(schema.vitals).run()
    expect(datasets.read(datasets.create(request).id).snapshot.sessions[0].movement).toMatchObject([{ timestampMs: startMs, totalMovement: 3 }])
  })

  it('copies every reference page and sorts processing runs deterministically', () => {
    const rows = Array.from({ length: 503 }, (_, i) => ({ recordKey: String(i), metric: 'heart_rate', unit: 'bpm', value: 60, timestampMs: startMs + i * 1000 }))
    const paged = { ...upload, rows }
    const imported = references.commit({ import: paged, previewHash: previewReferenceImport(paged).summary.contentHash })
    for (const id of ['run-b', 'run-a']) db.insert(schema.biometricProcessingRuns).values({ id, side: 'left', kind: 'live', bundle: {}, configHash: 'x', inputIdentity: {}, startedAtMs: startMs }).run()
    db.insert(schema.vitals).values({ side: 'left', timestamp: new Date(startMs + 1000), heartRate: 66, processingRunId: 'run-b' }).run()
    sqlite.prepare('UPDATE vitals SET processing_run_id = ? WHERE processing_run_id IS NULL').run('run-a')
    const frozen = datasets.read(datasets.create({ ...request, referenceImportIds: [imported.id] }).id)
    expect(frozen.snapshot.references[0].measurements).toHaveLength(503)
    expect(frozen.snapshot.processingRuns.map(run => run.id)).toEqual(['run-a', 'run-b'])
  })

  it('reports missing, released and tampered datasets distinctly and pages per side', () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    expect(() => datasets.read(missing)).toThrow('unavailable')
    expect(() => datasets.descriptor(missing)).toThrow('not found')
    expect(() => datasets.release(missing)).toThrow('not found')
    const dataset = datasets.create(request)
    sqlite.prepare('UPDATE biometric_datasets SET content_hash = ? WHERE id = ?').run('0'.repeat(64), dataset.id)
    expect(() => datasets.descriptor(dataset.id)).toThrow('integrity')
    sqlite.prepare('UPDATE biometric_datasets SET content_hash = ? WHERE id = ?').run(dataset.contentHash, dataset.id)
    const released = datasets.release(dataset.id)
    expect(released.available).toBe(false)
    expect(datasets.descriptor(dataset.id)).toEqual(released)
    expect(() => datasets.read(dataset.id)).toThrow('explicitly released')
    let clock = Date.now() + 3600000
    datasets = new DatasetStore(db, () => clock++)
    for (let index = 0; index < 51; index++) datasets.create({ ...request, idempotencyKey: `page-${index}` })
    const first = datasets.page('left')
    expect(first.items).toHaveLength(50)
    expect(first.items[0].available).toBe(true)
    expect(first.nextCursor).toEqual({ createdAtMs: first.items[49].createdAtMs, id: first.items[49].id })
    const second = datasets.page('left', first.nextCursor ?? undefined)
    expect(second.items).toHaveLength(2)
    expect(second.items.at(-1)).toMatchObject({ id: dataset.id, available: false })
    expect(second.nextCursor).toBeNull()
    expect(datasets.page('right').items).toEqual([])
  })
})
