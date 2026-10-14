// @vitest-environment node
import { expect, it } from 'vitest'
import { vitalProvenance, vitalProvenanceSchema } from '../vital-provenance'

const hash = 'a'.repeat(64)
const recorded = { side: 'left', processingRunId: 'run', recordedRunId: 'run', recordedSide: 'left', recordedKind: 'live', recordedConfigHash: hash, recordedHrvMetricId: 'window_ibi_variability_v1' }

it('describes rows without a run as legacy and verified live runs as recorded', () => {
  expect(vitalProvenance({ side: 'left' })).toEqual({ interpretation: 'original_observation', status: 'legacy_unknown', processingRunId: null, configurationHash: null, hrvMetricId: null })
  expect(vitalProvenance({ side: 'left', processingRunId: null })).toMatchObject({ status: 'legacy_unknown' })
  const full = vitalProvenance(recorded)
  expect(full).toEqual({ interpretation: 'original_observation', status: 'recorded', processingRunId: 'run', configurationHash: hash, hrvMetricId: 'window_ibi_variability_v1' })
  expect(vitalProvenanceSchema.parse(full)).toEqual(full)
})

it('does not trust runs that are missing, replayed, cross-side or malformed', () => {
  for (const patch of [{ recordedRunId: null }, { recordedRunId: 'other' }, { recordedSide: 'right' }, { recordedKind: 'replay' }, { recordedConfigHash: 'short' }, { recordedConfigHash: null }]) {
    expect(vitalProvenance({ ...recorded, ...patch })).toEqual({ interpretation: 'original_observation', status: 'unavailable', processingRunId: 'run', configurationHash: null, hrvMetricId: null })
  }
  expect(vitalProvenance({ ...recorded, recordedHrvMetricId: 'Not Valid' })).toMatchObject({ status: 'recorded', hrvMetricId: null })
  expect(vitalProvenance({ ...recorded, recordedHrvMetricId: 7 })).toMatchObject({ status: 'recorded', hrvMetricId: null })
  expect(vitalProvenance({ ...recorded, recordedHrvMetricId: undefined })).toMatchObject({ status: 'recorded', hrvMetricId: null })
})
