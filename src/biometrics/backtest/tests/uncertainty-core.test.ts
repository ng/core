// @vitest-environment node
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createNightUncertainty } from '../uncertainty-core'

const digest = (text: string) => new Uint8Array(createHash('sha256').update(text).digest())
const policy = { version: 'paired-night-percentile-v1' as const, seed: 'fixture', resamples: 200, minimumNights: 3 }
const night = (cohortId: string, difference: number | null) => ({ cohortId, difference })

it('orders nights by cohort before resampling so input order never changes the interval', () => {
  const uncertainty = createNightUncertainty(digest)
  const nights = [night('c', 0.3), night('a', -0.1), night('b', 0.2), night('d', null)]
  const result = uncertainty(nights, policy)
  expect(result).toMatchObject({ status: 'estimated', scoredNights: 3, omittedNights: 1, statistic: 'equal_night_mean_common_agreement_difference' })
  expect(result.estimate).toBeCloseTo(0.4 / 3)
  expect(uncertainty([...nights].reverse(), policy)).toEqual(result)
  expect(uncertainty(nights)).toMatchObject({ status: 'not_requested', policy: null, interval: null })
})

it('rejects oversized, duplicated and out-of-range paired differences per statistic', () => {
  const agreement = createNightUncertainty(digest)
  expect(() => agreement(Array.from({ length: 61 }, (_, i) => night(String(i), 0)), policy)).toThrow('Invalid paired-night uncertainty input')
  expect(() => agreement([night('a', 0), night('a', 0)], policy)).toThrow('Invalid paired-night uncertainty input')
  expect(() => agreement([night('a', 1.5)], policy)).toThrow('Invalid paired-night uncertainty input')
  expect(() => agreement([night('a', Number.NaN)], policy)).toThrow('Invalid paired-night uncertainty input')
  const mae = createNightUncertainty(digest, 'equal_night_mean_common_mae_difference')
  expect(mae([night('a', 1.5), night('b', 2.5), night('c', 40)], policy)).toMatchObject({ status: 'estimated', statistic: 'equal_night_mean_common_mae_difference' })
  expect(() => mae([night('a', Number.POSITIVE_INFINITY)], policy)).toThrow('Invalid paired-night uncertainty input')
})
