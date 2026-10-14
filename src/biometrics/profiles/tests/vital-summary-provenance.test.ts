// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { summarizeVitalProvenance, summaryProvenanceFields } from '../vital-summary-provenance'

const counts = { configurationCount: 1, unknownConfigurationRows: 0, hrvRows: 4, hrvDefinitionCount: 1, unknownHrvRows: 0, singleHrvMetricId: 'window_ibi_variability_v1' }

describe('summarizeVitalProvenance', () => {
  it('returns nothing for adapters that do not supply the aggregate fields', () => {
    expect(summarizeVitalProvenance({})).toBeUndefined()
    for (const key of ['configurationCount', 'unknownConfigurationRows', 'hrvRows', 'hrvDefinitionCount', 'unknownHrvRows'] as const) {
      expect(summarizeVitalProvenance({ ...counts, [key]: undefined })).toBeUndefined()
    }
    expect(() => summarizeVitalProvenance({ ...counts, singleHrvMetricId: undefined })).toThrow()
  })
  it('names a single verified HRV definition only when every HRV row shares it', () => {
    expect(summarizeVitalProvenance(counts)).toEqual({ interpretation: 'original_observations', configurationCount: 1, unknownConfigurationRows: 0,
      hrvRows: 4, hrvDefinitionCount: 1, unknownHrvRows: 0, hrvMetricId: 'window_ibi_variability_v1', hrvAggregation: 'single_definition' })
    expect(summarizeVitalProvenance({ ...counts, unknownHrvRows: 1 })).toMatchObject({ hrvMetricId: null, hrvAggregation: 'incompatible_definitions' })
    expect(summarizeVitalProvenance({ ...counts, hrvDefinitionCount: 2 })).toMatchObject({ hrvMetricId: null, hrvAggregation: 'incompatible_definitions' })
    expect(summarizeVitalProvenance({ ...counts, hrvDefinitionCount: 0, unknownHrvRows: 4, singleHrvMetricId: null })).toMatchObject({ hrvMetricId: null, hrvAggregation: 'legacy_unverified' })
    expect(summarizeVitalProvenance({ ...counts, hrvRows: 0, hrvDefinitionCount: 0, singleHrvMetricId: null })).toMatchObject({ hrvMetricId: null, hrvAggregation: 'no_readings' })
  })
  it('rejects negative or fractional aggregates', () => {
    expect(() => summarizeVitalProvenance({ ...counts, hrvRows: -1 })).toThrow()
    expect(() => summarizeVitalProvenance({ ...counts, configurationCount: 1.5 })).toThrow()
  })
})

describe('summaryProvenanceFields', () => {
  let sqlite: Database.Database
  let db: ReturnType<typeof drizzle<typeof schema>>
  beforeEach(() => {
    sqlite = new Database(':memory:')
    db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  })
  afterEach(() => sqlite.close())
  const query = () => db.select(summaryProvenanceFields).from(schema.vitals)
    .leftJoin(schema.biometricProcessingRuns, eq(schema.vitals.processingRunId, schema.biometricProcessingRuns.id)).where(eq(schema.vitals.side, 'left')).get()
  it('counts only well-formed live run bundles as known configurations and HRV definitions', () => {
    const manifestHash = 'a'.repeat(64)
    db.insert(schema.biometricProcessingRuns).values([
      { id: 'live', side: 'left', kind: 'live', bundle: { manifestHash, components: { hrv_index: { metricId: 'window_ibi_variability_v1' } } }, configHash: 'b'.repeat(64), inputIdentity: {}, startedAtMs: 1 },
      { id: 'replay', side: 'left', kind: 'replay', bundle: { manifestHash, components: { hrv_index: { metricId: 'window_ibi_variability_v1' } } }, configHash: 'b'.repeat(64), inputIdentity: {}, startedAtMs: 1 },
      { id: 'malformed', side: 'left', kind: 'live', bundle: { manifestHash: 'short', components: { hrv_index: { metricId: 'Bad Metric' } } }, configHash: 'not-a-hash', inputIdentity: {}, startedAtMs: 1 },
    ]).run()
    db.insert(schema.vitals).values([
      { side: 'left', timestamp: new Date(1000), hrv: 10, processingRunId: 'live' },
      { side: 'left', timestamp: new Date(2000), hrv: 11, processingRunId: 'live' },
      { side: 'left', timestamp: new Date(3000), hrv: null, processingRunId: 'live' },
      { side: 'left', timestamp: new Date(4000), hrv: 12, processingRunId: 'replay' },
      { side: 'left', timestamp: new Date(5000), hrv: 13, processingRunId: 'malformed' },
      { side: 'left', timestamp: new Date(6000), hrv: 14, processingRunId: null },
      { side: 'right', timestamp: new Date(7000), hrv: 15, processingRunId: 'live' },
    ]).run()
    expect(query()).toEqual({ configurationCount: 1, unknownConfigurationRows: 3, hrvRows: 5, hrvDefinitionCount: 1, unknownHrvRows: 3, singleHrvMetricId: 'window_ibi_variability_v1' })
    expect(summarizeVitalProvenance(query() ?? {})).toMatchObject({ hrvAggregation: 'incompatible_definitions', hrvMetricId: null })
  })
  it('reports no readings and no configurations for an empty side', () => {
    expect(query()).toEqual({ configurationCount: 0, unknownConfigurationRows: 0, hrvRows: 0, hrvDefinitionCount: 0, unknownHrvRows: 0, singleHrvMetricId: null })
    expect(summarizeVitalProvenance(query() ?? {})).toMatchObject({ hrvAggregation: 'no_readings' })
  })
})
