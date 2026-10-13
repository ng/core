// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { packagedWorkerPath } from '../location'
import { waveformEvaluatorBuildIdentity } from '../waveform-build'
import { resolveInstalledReplayBuild } from '../submission'

vi.mock('../location', () => ({ packagedWorkerPath: vi.fn(), packagedCoordinatorPath: vi.fn() }))
vi.mock('../waveform-build', () => ({ waveformEvaluatorBuildIdentity: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

it('pins the coordinator bundle that ships beside the worker, matching execution', async () => {
  vi.mocked(packagedWorkerPath).mockReturnValue('/standalone/biometrics-worker/worker.cjs')
  const build = { hash: 'a'.repeat(64), python: { hash: 'b'.repeat(64) } } as Awaited<ReturnType<typeof waveformEvaluatorBuildIdentity>>
  vi.mocked(waveformEvaluatorBuildIdentity).mockResolvedValue(build)
  await expect(resolveInstalledReplayBuild('signal_replay')).resolves.toEqual({ evaluatorBuildHash: build.hash, pythonBuildHash: build.python.hash })
  expect(vi.mocked(waveformEvaluatorBuildIdentity).mock.calls[0]?.slice(0, 2)).toEqual(['/standalone/biometrics-worker/coordinator.cjs', '/standalone/biometrics-worker/worker.cjs'])
})
