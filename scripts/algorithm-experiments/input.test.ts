// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { dataHash } from '../../src/biometrics/algorithms/canonical'
import { signalFrameSchema } from '../../src/biometrics/packages/protocol'
import { freezePackageInput, packageInputHash, packageTransportCeiling, readFrozenPackageInput } from './input'

const frame = { schema: 'biometric-signal-frame-v1', sequence: 0, timestampMs: 1000,
  samples: { left: [1, 2, 3], right: null }, context: { occupied: null, pumpActive: null } }

describe('frozen experiment input', () => {
  it('binds sample bytes, context, ordering and timestamps to a streamed identity', () => {
    const original = packageInputHash([frame])
    for (const changed of [{ ...frame, timestampMs: 1001 }, { ...frame, context: { occupied: true, pumpActive: null } },
      { ...frame, samples: { left: [1, 2, 4], right: null } }]) expect(packageInputHash([changed])).not.toBe(original)
    expect(packageInputHash([frame, { ...frame, sequence: 1 }])).not.toBe(packageInputHash([{ ...frame, sequence: 1 }, frame]))
    expect(packageInputHash([{ context: frame.context, samples: frame.samples, timestampMs: 1000, sequence: 0, schema: frame.schema }])).toBe(original)
  })
  it('reads the frozen copy after source mutation and enforces storage bounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-input-test-'))
    try {
      const source = structuredClone(frame)
      const next = { ...frame, sequence: 1, timestampMs: 1006 }
      const frozen = await freezePackageInput(join(root, 'input'), [source, next], 10000)
      source.samples.left[0] = 999
      const collected = []
      for await (const value of readFrozenPackageInput(join(root, 'input'))) collected.push(value)
      expect(collected).toEqual([frame, next])
      expect(frozen).toMatchObject({ hash: packageInputHash([frame, next]), frameCount: 2 })
      await expect(freezePackageInput(join(root, 'input'), [frame], 10000)).rejects.toThrow()
      await expect(freezePackageInput(join(root, 'small'), [frame], 10)).rejects.toThrow('byte limit')
      await expect(freezePackageInput(join(root, 'empty'), [], 10000)).rejects.toThrow('at least one')
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  it('derives a transport ceiling that covers the initialize line and every frame envelope of a frozen input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'package-input-test-'))
    try {
      const frames = [frame, { ...frame, sequence: 1, timestampMs: 1006, samples: { left: [0.1, 1e21, 5e-324], right: null } }]
      const frozen = await freezePackageInput(join(root, 'input'), frames, 100000)
      const initialize = JSON.stringify({ type: 'initialize', request: {}, runHash: 'a'.repeat(64) }) + '\n'
      let transport = Buffer.byteLength(initialize)
      for await (const input of readFrozenPackageInput(join(root, 'input'))) {
        const parsed = signalFrameSchema.parse(input)
        transport += Buffer.byteLength(JSON.stringify({ type: 'frame', frame: parsed, frameHash: dataHash(parsed) }) + '\n')
      }
      const ceiling = packageTransportCeiling(frozen, Buffer.byteLength(initialize))
      expect(ceiling).toBeGreaterThanOrEqual(transport)
      expect(packageTransportCeiling(await freezePackageInput(join(root, 'integers'), [frame], 100000), Buffer.byteLength(initialize)))
        .toBe(Buffer.byteLength(initialize) + Buffer.byteLength(JSON.stringify({ type: 'frame', frame, frameHash: dataHash(frame) }) + '\n'))
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
})
