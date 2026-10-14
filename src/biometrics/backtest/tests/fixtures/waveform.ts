import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/biometrics-schema'
import { configHash, dataHash } from '../../../algorithms/canonical'
import { defaultConfig, manifestHash } from '../../../algorithms/registry'
import { datasetManifestSchema, datasetSnapshotSchema } from '../../contracts'
import type { ObjectivePolicy } from '../../objective-policy'
import { backtestFixture } from './backtest'

export const artifactHash = 'a'.repeat(64)
export const pythonBuildHash = 'b'.repeat(64)

/** Rewrite a frozen processed dataset row in place as a retained waveform dataset. */
export function freezeWaveformDataset(db: BetterSQLite3Database<typeof schema>, datasetId: string) {
  const row = db.select().from(schema.biometricDatasets).where(eq(schema.biometricDatasets.id, datasetId)).get()
  if (!row) throw new Error('Missing dataset fixture')
  const processed = datasetSnapshotSchema.parse(row.snapshot)
  const manifest = { ...datasetManifestSchema.parse(row.manifest), version: 'waveform-dataset-manifest-v1' as const }
  const snapshot = { ...processed, version: 'waveform-dataset-v1' as const, waveformInputs: manifest.splitProtocol.assignments.map((assignment, index) => {
    const sha256 = index.toString(16).padStart(64, '0')
    return { cohortId: assignment.cohortId, input: { version: 'retained-waveform-input-v1' as const, retained_start_ms: assignment.startMs, score_start_ms: assignment.startMs, score_end_ms: assignment.endMs,
      artifacts: [{ artifact: { name: `${sha256}.RAW.gz`, sha256, compressed_bytes: 1, expanded_bytes: 1 }, first_event_ms: assignment.startMs, last_event_ms: assignment.endMs }], contexts: [] } }
  }) }
  const contentHash = dataHash({ manifest, snapshot })
  db.update(schema.biometricDatasets).set({ manifest, snapshot, contentHash }).where(eq(schema.biometricDatasets.id, datasetId)).run()
  return { manifest, snapshot, contentHash }
}
export const candidateConfig = () => {
  const candidate = structuredClone(defaultConfig)
  candidate.heart_rate.trackingToleranceBpm = 20
  return candidate
}
export const numericObjectiveTestPolicy: ObjectivePolicy = { version: 'numeric-objective-v1', qualificationId: 'test-only', metric: 'heart_rate', minimumNights: 3,
  minimumPairedReferencesPerNight: 1, maximumLostObservationFraction: 0.1, minimumMaeImprovement: 1, maximumNightMaeRegression: 1,
  maximumRegressedNightFraction: 0.34, maximumSubgroupMaeRegression: 1, requiredSubgroups: ['reference_points'],
  operational: { maximumWallMs: 1000, maximumPeakRssBytes: 1000, maximumIngestionAgeMs: 1000 } }

export function waveformReadings(configHashValue: string, startMs: number, count = 10, heartRate = 60) {
  return Array.from({ length: count }, (_, index) => ({ side: 'left' as const, timestampMs: startMs + index * 60000, heartRate, hrvIndex: 30,
    hrvMetric: 'window_ibi_variability_v1' as const, breathingRate: 14, qualityScore: 1, flags: null, hrRaw: heartRate, sourceSide: 'left' as const,
    configHash: configHashValue, limitations: [] }))
}

/** Signal-replay variant of the processed fixture: one retained night, waveform outputs for every configuration. */
export function waveformBacktestFixture(options: { candidate?: boolean, stages?: boolean, objective?: boolean } = {}) {
  const source = backtestFixture()
  const start = source.dataset.snapshot.sessions[0].startMs
  const end = source.dataset.manifest.splitProtocol.assignments[0].endMs
  const otherSide = { manifestHash, resolvedHash: configHash(defaultConfig), resolved: defaultConfig }
  const input = { version: 'retained-waveform-input-v1' as const, retained_start_ms: start, score_start_ms: start, score_end_ms: end,
    artifacts: [{ artifact: { name: `${artifactHash}.RAW.gz`, sha256: artifactHash, compressed_bytes: 1, expanded_bytes: 1 }, first_event_ms: start, last_event_ms: end }],
    contexts: [] }
  const snapshot = { ...source.dataset.snapshot, version: 'waveform-dataset-v1' as const, waveformInputs: [{ cohortId: 'night', input }] }
  const dataset = { ...source.dataset, snapshot }
  const candidate = candidateConfig()
  const configs = options.candidate
    ? [...source.job.configs, { label: 'candidate' as const, revisionId: null, resolved: candidate, resolvedHash: configHash(candidate), manifestHash }]
    : source.job.configs
  const protocol = { ...source.job.protocol, mode: 'signal_replay' as const, ...(options.stages ? { waveformStages: true } : {}),
    ...(options.objective ? { objectivePolicies: [numericObjectiveTestPolicy] } : {}) }
  const outputs = [...new Set(configs.map(config => config.resolvedHash))].map((hash, index) => {
    const readings = waveformReadings(hash, start, 10, 60 + index)
    return { cohortId: 'night', configHash: hash, readings, run: { version: 'retained-waveform-run-v1' as const, build_hash: pythonBuildHash,
      decoded_records: 10, raw_records: 10, counts: { records: 10, accepted_frames: 10, empty_channel_frames: 0, pump_gated_frames: 0, preroll_outputs: 0, scored_outputs: readings.length },
      limitations: [], config_hashes: { left: hash, right: otherSide.resolvedHash }, artifact_hashes: [artifactHash] } }
  })
  const job = { ...source.job, configs, protocol, protocolHash: configHash(protocol), datasetHash: dataHash(dataset), waveform: { pythonBuildHash, otherSide } }
  return { dataset, job, waveform: { hash: dataHash(outputs), outputs } }
}
