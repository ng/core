// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/package-experiment-schema'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  sqlite.exec(`CREATE TABLE package_studies (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE package_trials (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, request TEXT NOT NULL,
      state TEXT NOT NULL, attempt_id TEXT, lease_until INTEGER, report_hash TEXT);
    CREATE TABLE package_exposures (attempt_id TEXT NOT NULL, trial_id TEXT NOT NULL, night_id TEXT NOT NULL, subject_id TEXT NOT NULL, side TEXT NOT NULL,
      start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, split TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY (attempt_id, night_id));
    CREATE INDEX package_exposure_window ON package_exposures (subject_id, side, start_ms, end_ms);`)
})
afterEach(() => sqlite.close())

it('declares the off-pod experiment tables with their keys and exposure window index', () => {
  expect(getTableConfig(schema.packageStudies).name).toBe('package_studies')
  expect(getTableConfig(schema.packageTrials).columns.map(column => column.name)).toEqual(['id', 'idempotency_key', 'request_hash', 'request', 'state', 'attempt_id', 'lease_until', 'report_hash'])
  const exposures = getTableConfig(schema.packageExposures)
  expect(exposures.primaryKeys[0].columns.map(column => column.name)).toEqual(['attempt_id', 'night_id'])
  expect(exposures.indexes[0].config.name).toBe('package_exposure_window')
})

it('round-trips rows through the typed tables and enforces uniqueness', () => {
  db.insert(schema.packageStudies).values({ id: 'study', hash: 'h', payload: '{}' }).run()
  expect(() => db.insert(schema.packageStudies).values({ id: 'other', hash: 'h', payload: '{}' }).run()).toThrow('UNIQUE')
  db.insert(schema.packageTrials).values({ id: 'trial', idempotencyKey: 'key', requestHash: 'r', request: '{}', state: 'queued' }).run()
  expect(db.select().from(schema.packageTrials).get()).toMatchObject({ attemptId: null, leaseUntil: null, reportHash: null })
  const exposure = { attemptId: 'attempt', trialId: 'trial', nightId: 'night', subjectId: 'subject', side: 'left', startMs: 1, endMs: 2, split: 'holdout', observedAt: 3 }
  db.insert(schema.packageExposures).values(exposure).run()
  expect(() => db.insert(schema.packageExposures).values(exposure).run()).toThrow('UNIQUE')
  expect(db.select().from(schema.packageExposures).all()).toEqual([exposure])
})
