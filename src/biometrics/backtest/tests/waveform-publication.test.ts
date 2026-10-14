// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { publishSelectedWaveformDataset } from '../waveform-publication'
import { runRawPublicationChild } from '../raw-publication-child'
import { podRawInspectionLocation } from '../raw-inspection-child'
import { prepareSelectedWaveformDataset, selectedWaveformRetry } from '../waveform-selection'
import type * as Selection from '../waveform-selection'

vi.mock('../raw-publication-child', () => ({ runRawPublicationChild: vi.fn() }))
vi.mock('../waveform-selection', async original => ({ ...await original<typeof Selection>(), prepareSelectedWaveformDataset: vi.fn(), selectedWaveformRetry: vi.fn() }))

type Dataset = NonNullable<ReturnType<typeof selectedWaveformRetry>>
type Work = ReturnType<typeof prepareSelectedWaveformDataset>
const hash = 'a'.repeat(64), id = '11111111-1111-4111-8111-111111111111'
const request = { parentDatasetId: id, expectedContentHash: hash, cohorts: [{ cohortId: 'night', sourceIds: [hash] }], idempotencyKey: 'waveform' }
const dataset = { id, contentHash: hash, available: true } as unknown as Dataset
const work = { prepared: { contentHash: hash }, selections: [] } as unknown as Work
const childResult = { type: 'result' as const, id, contentHash: hash, available: true }
let directory: string, sqlite: Database.Database, db: ReturnType<typeof drizzle<typeof schema>>
let controller: AbortController
const publish = (options: Partial<Parameters<typeof publishSelectedWaveformDataset>[2]> = {}, raw: unknown = request) =>
  publishSelectedWaveformDataset(db, raw as typeof request, { signal: controller.signal, admit: async () => true, ...options })

beforeEach(() => {
  vi.clearAllMocks()
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'waveform-publication-')))
  sqlite = new Database(join(directory, 'biometrics.db'))
  db = drizzle(sqlite, { schema })
  controller = new AbortController()
  vi.mocked(selectedWaveformRetry).mockReturnValue(null)
  vi.mocked(prepareSelectedWaveformDataset).mockReturnValue(work)
  vi.mocked(runRawPublicationChild).mockResolvedValue(childResult)
})
afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
  rmSync(directory, { recursive: true, force: true })
})

it('rejects malformed selections before touching the database', async () => {
  await expect(publish({}, { ...request, cohorts: [] })).rejects.toThrow()
  expect(selectedWaveformRetry).not.toHaveBeenCalled()
})

it('returns an already published dataset without admission or publication', async () => {
  vi.mocked(selectedWaveformRetry).mockReturnValue(dataset)
  const admit = vi.fn(async () => true)
  expect(await publish({ admit })).toEqual({ status: 'published', dataset })
  expect(admit).not.toHaveBeenCalled()
  expect(prepareSelectedWaveformDataset).not.toHaveBeenCalled()
})

it('defers when cancelled or denied before any work is prepared', async () => {
  controller.abort()
  const admit = vi.fn(async () => true)
  expect(await publish({ admit })).toEqual({ status: 'deferred' })
  expect(admit).not.toHaveBeenCalled()
  controller = new AbortController()
  expect(await publish({ admit: async () => false })).toEqual({ status: 'deferred' })
  const unavailable = async () => {
    throw new Error('admission unavailable')
  }
  expect(await publish({ admit: unavailable })).toEqual({ status: 'deferred' })
  const abortingAdmit = async () => {
    controller.abort()
    return true
  }
  expect(await publish({ admit: abortingAdmit })).toEqual({ status: 'deferred' })
  expect(prepareSelectedWaveformDataset).not.toHaveBeenCalled()
  expect(runRawPublicationChild).not.toHaveBeenCalled()
})

it('requires a persistent database file', async () => {
  sqlite.close()
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  await expect(publish()).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' })
  expect(prepareSelectedWaveformDataset).not.toHaveBeenCalled()
})

it('defers after preparation when admission is withdrawn or the request is cancelled', async () => {
  let checks = 0
  expect(await publish({ admit: async () => ++checks === 1 })).toEqual({ status: 'deferred' })
  expect(checks).toBe(2)
  expect(prepareSelectedWaveformDataset).toHaveBeenCalledTimes(1)
  checks = 0
  const abortOnSecondCheck = async () => {
    if (++checks === 2) controller.abort()
    return true
  }
  expect(await publish({ admit: abortOnSecondCheck })).toEqual({ status: 'deferred' })
  expect(runRawPublicationChild).not.toHaveBeenCalled()
})

it('publishes through the pod location by default and verifies the committed identity', async () => {
  vi.mocked(selectedWaveformRetry).mockReturnValueOnce(null).mockReturnValueOnce(dataset)
  expect(await publish()).toEqual({ status: 'published', dataset })
  expect(runRawPublicationChild).toHaveBeenCalledWith({ ...podRawInspectionLocation, databasePath: join(directory, 'biometrics.db'),
    retainedDirectory: join(directory, 'biometric-raw') }, work, { signal: expect.any(AbortSignal) })
  const rawLocation = { pythonPath: '/custom/python', modulesPath: '/custom/modules', archiveDirectory: '/custom/archive' }
  vi.mocked(selectedWaveformRetry).mockReturnValueOnce(null).mockReturnValueOnce(dataset)
  await publish({ rawLocation })
  expect(vi.mocked(runRawPublicationChild).mock.calls[1][0]).toMatchObject(rawLocation)
})

it.each([
  ['no committed row', [null, null]],
  ['a different id', [{ ...dataset, id: '22222222-2222-4222-8222-222222222222' }, null]],
  ['a different content hash', [{ ...dataset, contentHash: 'b'.repeat(64) }, null]],
])('fails when the child response leaves %s', async (_label, retries) => {
  vi.mocked(selectedWaveformRetry).mockReturnValueOnce(null)
  for (const retry of retries) vi.mocked(selectedWaveformRetry).mockReturnValueOnce(retry as Dataset | null)
  await expect(publish()).rejects.toThrow('Published waveform identity mismatch')
})

it('returns a dataset that committed even though the child response was lost', async () => {
  vi.mocked(runRawPublicationChild).mockRejectedValue(new Error('IPC lost'))
  vi.mocked(selectedWaveformRetry).mockReturnValueOnce(null).mockReturnValueOnce(dataset)
  expect(await publish()).toEqual({ status: 'published', dataset })
})

it('rethrows child failures that left nothing committed', async () => {
  vi.mocked(runRawPublicationChild).mockRejectedValue(new Error('publication crashed'))
  await expect(publish()).rejects.toThrow('publication crashed')
})

it('cancels the child when the request is aborted mid-flight', async () => {
  vi.mocked(runRawPublicationChild).mockImplementation((_location, _work, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('Waveform publication cancelled')), { once: true })
  }))
  const pending = publish()
  await vi.waitFor(() => expect(runRawPublicationChild).toHaveBeenCalled())
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
})

it('withdraws admission while the child runs and reports deferral', async () => {
  vi.useFakeTimers()
  vi.mocked(runRawPublicationChild).mockImplementation((_location, _work, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('Waveform publication cancelled')), { once: true })
  }))
  let release!: (allowed: boolean) => void
  const admit = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValueOnce(true)
    .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const pending = publish({ admit })
  await vi.advanceTimersByTimeAsync(5000)
  expect(admit).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(5000)
  expect(admit).toHaveBeenCalledTimes(3)
  release(false)
  expect(await pending).toEqual({ status: 'deferred' })
  expect(controller.signal.aborted).toBe(false)
})

it('keeps polling admission while the child runs when it stays granted', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  vi.mocked(runRawPublicationChild).mockImplementation(() => new Promise((resolve) => {
    finish = () => resolve(childResult)
  }))
  const admit = vi.fn(async () => true)
  vi.mocked(selectedWaveformRetry).mockReturnValueOnce(null).mockReturnValueOnce(dataset)
  const pending = publish({ admit })
  await vi.advanceTimersByTimeAsync(10000)
  expect(admit).toHaveBeenCalledTimes(4)
  finish()
  expect(await pending).toEqual({ status: 'published', dataset })
})
