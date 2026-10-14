// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runDemoEvaluation } from '../biometrics/run'
import { backtestFixture } from '@/src/biometrics/backtest/tests/fixtures/backtest'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { FakeWorker.instances.push(this) }
}
function current() {
  const instance = FakeWorker.instances.at(-1)
  if (!instance) throw new Error('Worker not created')
  return instance
}
beforeEach(() => vi.stubGlobal('Worker', FakeWorker))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('forwards progress and returns the worker report, terminating the completed worker', async () => {
  const input = backtestFixture(), report = evaluateBacktest(input), progress = vi.fn()
  const result = runDemoEvaluation(input, progress, new AbortController().signal)
  expect(current().postMessage).toHaveBeenCalledWith(input)
  current().onmessage?.({ data: { type: 'progress', completedNights: 1, totalNights: 1 } })
  expect(progress).toHaveBeenCalledWith(1, 1)
  current().onmessage?.({ data: { type: 'result', report } })
  expect(await result).toEqual(report)
  expect(current().terminate).toHaveBeenCalledTimes(1)
  current().onmessage?.({ data: { type: 'progress', completedNights: 2, totalNights: 2 } })
  expect(progress).toHaveBeenCalledTimes(1)
})
it('terminates cancelled work and ignores late completion', async () => {
  const controller = new AbortController()
  const result = runDemoEvaluation(backtestFixture(), vi.fn(), controller.signal)
  const rejection = expect(result).rejects.toThrow('cancelled')
  controller.abort()
  await rejection
  current().onmessage?.({ data: { type: 'result', report: {} } })
  expect(current().terminate).toHaveBeenCalledTimes(1)
})
it('rejects an already cancelled request without creating a worker', async () => {
  const controller = new AbortController()
  controller.abort()
  const before = FakeWorker.instances.length
  await expect(runDemoEvaluation(backtestFixture(), vi.fn(), controller.signal)).rejects.toThrow('cancelled')
  expect(FakeWorker.instances).toHaveLength(before)
})
it('surfaces worker errors, undecodable replies, empty results and failed input delivery once', async () => {
  const failed = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const failure = expect(failed).rejects.toThrow('scoring exploded')
  current().onmessage?.({ data: { type: 'error', message: 'scoring exploded' } })
  current().onerror?.()
  await failure
  expect(current().terminate).toHaveBeenCalledTimes(1)
  const undecodable = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const decodeFailure = expect(undecodable).rejects.toThrow('could not be decoded')
  current().onmessageerror?.()
  await decodeFailure
  const empty = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const missing = expect(empty).rejects.toThrow('Missing demo report')
  current().onmessage?.({ data: { type: 'result' } })
  await missing
  const ignored = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const silence = expect(ignored).rejects.toThrow('worker failed')
  current().onmessage?.({ data: { type: 'unknown' } })
  current().onerror?.()
  await silence
  let thrown: unknown = new Error('structured clone failed')
  class ThrowingWorker extends FakeWorker {
    postMessage = vi.fn(() => {
      throw thrown
    })
  }
  vi.stubGlobal('Worker', ThrowingWorker)
  await expect(runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)).rejects.toThrow('structured clone failed')
  thrown = 'opaque'
  await expect(runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)).rejects.toThrow('Demo worker input failed')
  expect(current().terminate).toHaveBeenCalledTimes(1)
})
it('answers worker messages with progress, the report or a bounded error', async () => {
  const posted: unknown[] = []
  const scope = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: (message: unknown) => void posted.push(message) }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  await import('../biometrics/worker')
  if (!scope.onmessage) throw new Error('Worker did not register a handler')
  const input = backtestFixture()
  scope.onmessage({ data: input })
  const { evaluateDemoBacktest } = await import('../biometrics/evaluator')
  expect(posted.at(-1)).toEqual({ type: 'result', report: evaluateDemoBacktest(input, () => {}) })
  expect(posted.some(message => (message as { type: string }).type === 'progress')).toBe(true)
  scope.onmessage({ data: { ...input, job: { ...input.job, protocol: null } } })
  expect(posted.at(-1)).toMatchObject({ type: 'error', message: expect.any(String) })
  scope.onmessage({ data: null })
  expect(posted.at(-1)).toMatchObject({ type: 'error' })
})
it('bounds execution time and terminates failed workers', async () => {
  vi.useFakeTimers()
  const result = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const rejection = expect(result).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(120000)
  await rejection
  expect(current().terminate).toHaveBeenCalledTimes(1)
  const failed = runDemoEvaluation(backtestFixture(), vi.fn(), new AbortController().signal)
  const failure = expect(failed).rejects.toThrow('worker failed')
  current().onerror?.()
  await failure
  expect(current().terminate).toHaveBeenCalledTimes(1)
})
