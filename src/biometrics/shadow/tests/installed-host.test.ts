// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectInstalledShadowHost, loadInstalledShadowHost } from '../installed-host'
import { guardShadowPythonInstallation } from '../python-installation'
vi.mock('../python-installation', () => ({ guardShadowPythonInstallation: vi.fn() }))
const directories: string[] = []
const fixture = `module.exports = { shadowHostApiVersion: 'shadow-host-api-v1', runProfiledShadowAttempt() {}, openProfiledShadowHost() {}, prepareShadowPlan() {}, ShadowStore() {},
shadowEngineBuildIdentity() {}, readInstalledShadowQualifications() {}, shadowPlanSchema: {}, shadowStoragePolicySchema: {} };`
function file(contents = fixture) {
  const directory = mkdtempSync(join(tmpdir(), 'installed-shadow-'))
  directories.push(directory)
  const path = join(directory, 'shadow-host.cjs')
  writeFileSync(path, contents)
  return path
}
afterEach(() => {
  delete (globalThis as typeof globalThis & { __sleepypodInstalledShadowHostV1?: unknown }).__sleepypodInstalledShadowHostV1
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})
it.each(['symlink', 'oversize', 'directory', 'missing'])('rejects a %s artifact before executing it', (mode) => {
  const path = file()
  if (mode === 'oversize') writeFileSync(path, 'x'.repeat(16 * 1024 * 1024 + 1))
  if (mode === 'symlink') {
    renameSync(path, path + '.target')
    symlinkSync(path + '.target', path)
  }
  if (mode === 'missing') rmSync(path)
  expect(() => loadInstalledShadowHost(mode === 'directory' ? directories[0] : path)).toThrow()
})
it('refuses preloaded Node cache entries with no verified loading history', () => {
  const path = file()
  createRequire(import.meta.url)(path)
  expect(() => loadInstalledShadowHost(path)).toThrow(/without installed identity/)
})
it('refuses incomplete or unsupported API exports', () => {
  const path = file('module.exports = { shadowHostApiVersion: \'other\' };')
  expect(() => loadInstalledShadowHost(path)).toThrow(/API/)
})
it('inspects the loaded artifact through its own build probe and guards the Python installation', async () => {
  const probe = `module.exports = { shadowHostApiVersion: 'shadow-host-api-v1', runProfiledShadowAttempt() {}, openProfiledShadowHost() {}, prepareShadowPlan() {}, ShadowStore() {},
async shadowEngineBuildIdentity(hostPath, location, signal) { return { identity: { hostHash: process.env.SHADOW_TEST_HOST_HASH, hostPath, location, cancelled: Boolean(signal?.aborted) }, python: { probed: true } } },
readInstalledShadowQualifications() {}, shadowPlanSchema: {}, shadowStoragePolicySchema: {} };`
  const path = file(probe)
  const hostHash = createHash('sha256').update(readFileSync(path)).digest('hex')
  const location = { pythonPath: '/opt/python', modulesPath: '/opt/modules' }
  const aborted = new AbortController()
  aborted.abort()
  await expect(inspectInstalledShadowHost(path, location, aborted.signal)).rejects.toThrow('cancelled')
  process.env.SHADOW_TEST_HOST_HASH = 'f'.repeat(64)
  try {
    await expect(inspectInstalledShadowHost(path, location)).rejects.toThrow('differs from inspected artifact')
    expect(guardShadowPythonInstallation).not.toHaveBeenCalled()
    process.env.SHADOW_TEST_HOST_HASH = hostHash
    const pythonCurrent = vi.fn()
    vi.mocked(guardShadowPythonInstallation).mockReturnValue(pythonCurrent)
    const inspected = await inspectInstalledShadowHost(path, location)
    expect(inspected.hostHash).toBe(hostHash)
    expect(inspected.build).toMatchObject({ identity: { hostHash, location, cancelled: false }, python: { probed: true } })
    expect(guardShadowPythonInstallation).toHaveBeenCalledWith(location, { probed: true })
    expect(pythonCurrent).toHaveBeenCalledOnce()
    inspected.assertCurrent()
    expect(pythonCurrent).toHaveBeenCalledTimes(2)
    pythonCurrent.mockImplementationOnce(() => {
      throw new Error('Python changed')
    })
    expect(() => inspected.assertCurrent()).toThrow('Python changed')
  }
  finally {
    delete process.env.SHADOW_TEST_HOST_HASH
  }
})
it('rejects replacement with identical bytes and a second installation path', () => {
  const path = file(), loaded = loadInstalledShadowHost(path)
  loaded.assertCurrent()
  expect(() => loadInstalledShadowHost(file())).toThrow(/restart/)
  renameSync(path, path + '.old')
  writeFileSync(path, fixture)
  expect(() => loaded.assertCurrent()).toThrow(/restart/)
})
