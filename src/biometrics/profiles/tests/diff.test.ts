// @vitest-environment node
import { expect, it } from 'vitest'
import { configHash } from '../../algorithms/canonical'
import { defaultConfig } from '../../algorithms/registry'
import { diffProfiles } from '../diff'
import type { ProfileStore } from '../store'

function storeWith(resolved: unknown) {
  return { validateRevision: () => ({ resolved, hash: configHash(resolved), revision: { overrides: [] } }) } as unknown as ProfileStore
}

it('records keys present on only one side of the resolved configuration', () => {
  const added = { ...defaultConfig, extra: { nested: 1 }, heart_rate: { ...defaultConfig.heart_rate, introduced: true } }
  const toAdded = diffProfiles(storeWith(added), 'left', 'revision', null)
  expect(toAdded.changes).toEqual(expect.arrayContaining([
    { path: 'extra', before: undefined, after: { nested: 1 } },
    { path: 'heart_rate.introduced', before: undefined, after: true },
  ]))
  expect(toAdded.changes).toHaveLength(2)
  const fromAdded = diffProfiles(storeWith(added), 'left', null, 'revision')
  expect(fromAdded.changes).toEqual(expect.arrayContaining([
    { path: 'extra', before: { nested: 1 }, after: undefined },
    { path: 'heart_rate.introduced', before: true, after: undefined },
  ]))
  expect(fromAdded.changes).toHaveLength(2)
  expect(diffProfiles(storeWith(defaultConfig), 'left', 'revision', null).changes).toEqual([])
})
