// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { backtestFixture } from './fixtures/backtest'

type Listener = (chunk: Buffer) => void

/** Drive the stdin protocol in-process so the entry module's own lines are instrumented. */
async function runWorker(chunks: Buffer[]) {
  vi.resetModules()
  const listeners = new Map<string, Listener>()
  const stdout: string[] = []
  const stderr: string[] = []
  const stdin = vi.spyOn(process.stdin, 'on').mockImplementation(((event: string, listener: Listener) => {
    listeners.set(event, listener)
    return process.stdin
  }) as typeof process.stdin.on)
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as typeof process.exit)
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await import('../worker-entry')
    const data = listeners.get('data'), end = listeners.get('end')
    if (!data || !end) throw new Error('Worker did not subscribe to stdin')
    let failure: unknown
    try {
      for (const chunk of chunks) data(chunk)
      end(Buffer.alloc(0))
    }
    catch (error) { failure = error }
    return { stdout, stderr, failure, exitCode: process.exitCode }
  }
  finally {
    process.exitCode = previousExitCode
    stdin.mockRestore()
    out.mockRestore()
    err.mockRestore()
    exit.mockRestore()
  }
}
afterEach(() => vi.restoreAllMocks())

it('streams progress then a single result line with operational measurements', async () => {
  const serialized = JSON.stringify(backtestFixture())
  const half = Math.floor(serialized.length / 2)
  const run = await runWorker([Buffer.from(serialized.slice(0, half)), Buffer.from(serialized.slice(half))])
  expect(run.failure).toBeUndefined()
  expect(run.stderr).toEqual([])
  expect(run.exitCode).toBeUndefined()
  const events = run.stdout.map(line => JSON.parse(line) as { type: string, report?: { version: string, operational: { runtimeMs: number, peakRssKiB: number, heapLimitMiB: number } } })
  expect(events.map(event => event.type)).toEqual(['progress', 'result'])
  expect(events[0]).toEqual({ type: 'progress', completedNights: 1, totalNights: 1 })
  expect(events[1].report).toMatchObject({ version: 'processed-backtest-report-v1', operational: { heapLimitMiB: 128 } })
  expect(events[1].report?.operational.runtimeMs).toBeGreaterThanOrEqual(0)
  expect(events[1].report?.operational.peakRssKiB).toBeGreaterThan(0)
})

it('reports invalid input without echoing it and exits nonzero', async () => {
  const invalid = await runWorker([Buffer.from('{"job":')])
  expect(invalid.stdout).toEqual([])
  expect(invalid.stderr).toEqual(['Replay failed input validation or evaluation\n'])
  expect(invalid.exitCode).toBe(1)
  const rejected = await runWorker([Buffer.from(JSON.stringify({ job: {}, dataset: {} }))])
  expect(rejected.stderr).toEqual(['Replay failed input validation or evaluation\n'])
  expect(rejected.exitCode).toBe(1)
})

it('aborts once input exceeds the worker byte limit before parsing', async () => {
  const run = await runWorker([Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024)])
  expect(run.failure).toEqual(new Error('exit 2'))
  expect(run.stderr).toEqual(['Replay input exceeds the worker byte limit\n'])
  expect(run.stdout).toEqual([])
})
