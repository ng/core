// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ReferenceInputError, timestampResolver } from '../time'

const T = Date.UTC(2026, 9, 10, 23, 0, 0)
type TimePolicy = Parameters<typeof timestampResolver>[0]
const policy = (changes: Partial<TimePolicy> = {}): TimePolicy => ({ disambiguation: 'reject', ...changes })
const code = (run: () => unknown) => {
  try {
    run()
  }
  catch (error) {
    return error instanceof ReferenceInputError ? error.code : 'not-a-reference-error'
  }
  return null
}

describe('reference timestamp resolution', () => {
  it('accepts numbers, explicit offsets and Z while rejecting malformed or out-of-range text', () => {
    const resolve = timestampResolver(policy({}))
    expect(resolve(T)).toBe(T)
    expect(resolve('2026-10-10T23:00:00Z')).toBe(T)
    expect(resolve('2026-10-10T23:00:00.5Z')).toBe(T + 500)
    expect(resolve('2026-10-11T01:30:00+02:30')).toBe(T)
    expect(resolve('2026-10-10T20:00:00-03:00')).toBe(T)
    expect(code(() => resolve('2026-10-10T23:00Z'))).toBe('INVALID_TIMESTAMP')
    expect(code(() => resolve('2026-13-10T23:00:00Z'))).toBe('INVALID_TIMESTAMP')
    expect(code(() => resolve('2026-02-30T23:00:00Z'))).toBe('INVALID_TIMESTAMP')
    expect(code(() => resolve('2026-10-10T23:00:00+15:00'))).toBe('INVALID_TIMESTAMP')
    expect(code(() => resolve('2026-10-10T23:00:00+14:30'))).toBe('INVALID_TIMESTAMP')
    expect(code(() => resolve('2026-10-10T23:00:00-05:60'))).toBe('INVALID_TIMESTAMP')
    expect(code(() => resolve('2026-10-10T23:00:00'))).toBe('AMBIGUOUS_TIMESTAMP')
    expect(code(() => resolve(T / 1000))).not.toBeNull()
  })
  it('applies a fixed policy offset only to local text', () => {
    const resolve = timestampResolver(policy({ utcOffsetMinutes: -120 }))
    expect(resolve('2026-10-10T21:00:00')).toBe(T)
    expect(resolve('2026-10-10T23:00:00Z')).toBe(T)
    expect(resolve(T)).toBe(T)
  })
  it('resolves local times through an IANA timezone, including GMT and DST transitions', () => {
    expect(code(() => timestampResolver(policy({ timezone: 'Not/AZone' })))).toBe('INVALID_TIMEZONE')
    expect(timestampResolver(policy({ timezone: 'Etc/UTC' }))('2026-10-10T23:00:00')).toBe(T)
    expect(timestampResolver(policy({ timezone: 'Europe/London' }))('2026-01-10T12:00:00')).toBe(Date.UTC(2026, 0, 10, 12))
    const pacific = timestampResolver(policy({ timezone: 'America/Los_Angeles' }))
    expect(pacific('2026-10-10T16:00:00')).toBe(T)
    expect(pacific('2026-10-10T16:00:00-07:00')).toBe(T)
    expect(code(() => pacific('2026-10-10T16:00:00-08:00'))).toBe('TIMEZONE_OFFSET_MISMATCH')
    // 2026-03-08 02:30 does not exist; 2026-11-01 01:30 happens twice.
    expect(code(() => pacific('2026-03-08T02:30:00'))).toBe('NONEXISTENT_LOCAL_TIME')
    expect(code(() => pacific('2026-11-01T01:30:00'))).toBe('AMBIGUOUS_LOCAL_TIME')
    expect(timestampResolver(policy({ timezone: 'America/Los_Angeles', disambiguation: 'earlier' }))('2026-11-01T01:30:00')).toBe(Date.UTC(2026, 10, 1, 8, 30))
    expect(timestampResolver(policy({ timezone: 'America/Los_Angeles', disambiguation: 'later' }))('2026-11-01T01:30:00')).toBe(Date.UTC(2026, 10, 1, 9, 30))
    expect(code(() => timestampResolver(policy({ timezone: 'America/Los_Angeles', disambiguation: 'reject' }))('2026-11-01T01:30:00'))).toBe('AMBIGUOUS_LOCAL_TIME')
    const kolkata = timestampResolver(policy({ timezone: 'Asia/Kolkata' }))
    expect(kolkata('2026-10-11T04:30:00')).toBe(T)
  })
})
