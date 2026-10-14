// @vitest-environment node
import { expect, it } from 'vitest'
import { defaultConfig } from '../../algorithms/registry'
import { bindingSchema, biometricConfigSchema, overrideSchema, profileOverviewSchema, revisionSchema } from '../contracts'

const uuid = '11111111-1111-4111-8111-111111111111'

it('derives the typed configuration schema from the manifest and still applies relationship checks', () => {
  expect(biometricConfigSchema.parse(defaultConfig)).toEqual(defaultConfig)
  const inverted = structuredClone(defaultConfig)
  inverted.sleep_stages.ruleset.outliers.heartRate = { min: 100, max: 50 }
  const result = biometricConfigSchema.safeParse(inverted)
  expect(result.success).toBe(false)
  expect(result.error?.issues.map(issue => issue.message)).toContain('Invalid biometric parameter relationship')
  expect(biometricConfigSchema.safeParse({ ...defaultConfig, heart_rate: { ...defaultConfig.heart_rate, trackingToleranceBpm: 1000 } }).success).toBe(false)
})

it('validates revision, binding and override records', () => {
  expect(overrideSchema.parse({ path: 'heart_rate.trackingToleranceBpm', value: 20 })).toEqual({ path: 'heart_rate.trackingToleranceBpm', value: 20 })
  expect(() => overrideSchema.parse({ value: 20 })).toThrow()
  const revision = { id: uuid, familyId: uuid, revision: 1, side: 'left', baseManifestHash: 'm', baseManifest: {}, overrides: [], resolved: defaultConfig,
    resolvedHash: 'r', dependencyHashes: { manifest: 'm' }, parentRevisionId: null, origin: 'manual', requester: 'test', idempotencyKey: 'k', requestHash: 'h', createdAtMs: 1 }
  expect(revisionSchema.parse(revision)).toEqual(revision)
  expect(() => revisionSchema.parse({ ...revision, origin: 'unknown' })).toThrow()
  expect(bindingSchema.parse({ side: 'right', generation: 0, desiredRevisionId: null, previousRevisionId: uuid, updatedAtMs: 1 })).toMatchObject({ generation: 0 })
  expect(() => bindingSchema.parse({ side: 'right', generation: 0.5, desiredRevisionId: null, previousRevisionId: null, updatedAtMs: 1 })).toThrow()
  expect(Object.keys(profileOverviewSchema.shape)).toEqual(['stageView', 'desired', 'legacyStageView', 'runtimeHealth', 'runtimeStatus', 'receipts', 'sensorCalibration', 'activationAvailable', 'limitations'])
  expect(profileOverviewSchema.safeParse({}).success).toBe(false)
})
