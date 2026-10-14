// @vitest-environment node
import { expect, it } from 'vitest'
import { describeCoverage } from '../coverage'

const T = 1791673200000
it('reports actual timestamps, duplicates and cadence gaps without interpolating', () => {
  expect(describeCoverage([T, T, T + 60000, T + 180000, T - 1, T + 600000], T, T + 600000, 60000)).toEqual({
    count: 3, duplicateTimestamps: 1, firstMs: T, lastMs: T + 180000, expectedCadenceMs: 60000,
    gaps: [{ startMs: T + 120000, endMs: T + 180000 }, { startMs: T + 240000, endMs: T + 600000 }], gapDurationMs: 420000,
    interpretation: 'cadence_availability_not_measured_support' })
  expect(describeCoverage([], T, T + 60000, 60000)).toMatchObject({ count: 0, firstMs: null, lastMs: null, gaps: [{ startMs: T, endMs: T + 60000 }], gapDurationMs: 60000 })
})
it('rejects unbounded or non-integer inputs', () => {
  expect(() => describeCoverage([], T, T, 60000)).toThrow('Invalid bounded coverage input')
  expect(() => describeCoverage([], T, T + 1, 0)).toThrow('Invalid bounded coverage input')
  expect(() => describeCoverage([T + 0.5], T, T + 1, 1)).toThrow('Invalid bounded coverage input')
  expect(() => describeCoverage([], T + 0.5, T + 1, 1)).toThrow('Invalid bounded coverage input')
  expect(() => describeCoverage(Array.from({ length: 100001 }, () => T), T, T + 1, 1)).toThrow('Invalid bounded coverage input')
})
