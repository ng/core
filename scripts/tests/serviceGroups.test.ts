// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
let groupFile: string

const installScript = readFileSync(resolve('scripts/install'), 'utf8')
const updateScript = readFileSync(resolve('scripts/bin/sp-update'), 'utf8')

function extractHelper(source: string): string {
  const match = source.match(/_group_exists\(\)\s*\{[\s\S]*?\n\}/)
  if (!match) {
    throw new Error('Could not find _group_exists in source')
  }
  return match[0]
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sleepypod-groups-'))
  groupFile = join(root, 'group')
  writeFileSync(groupFile, 'dac:x:1000:sleepypod\nsystemd-journal:x:992:\nadm:x:4:\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function runBash(script: string) {
  return spawnSync('/bin/bash', ['-eu', '-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
  })
}

describe('service groups on minimal Yocto images', () => {
  it('defines _group_exists consistently in scripts/install and scripts/bin/sp-update', () => {
    const installHelper = extractHelper(installScript)
    const updateHelper = extractHelper(updateScript)
    expect(installHelper).toBe(updateHelper)
  })

  it('finds exact local groups without getent using /etc/group fallback', () => {
    const helper = extractHelper(installScript).replace('/etc/group', groupFile)
    const result = runBash(`
      getent() { return 127; }
      ${helper}
      _group_exists dac
      ! _group_exists da
      ! _group_exists dac-extra
      _group_exists systemd-journal
      ! _group_exists journal
    `)
    expect(result.status).toBe(0)
  })

  it('retains NSS lookup and falls back when getent fails', () => {
    const helper = extractHelper(installScript).replace('/etc/group', groupFile)
    // When getent succeeds, group is found even if missing from /etc/group
    const nssSuccess = runBash(`
      getent() { return 0; }
      ${helper}
      _group_exists remote-nss-group
    `)
    expect(nssSuccess.status).toBe(0)

    // When getent fails (returns non-zero), falls back to local /etc/group
    const nssFallback = runBash(`
      getent() { return 2; }
      ${helper}
      _group_exists dac
      ! _group_exists non-existent-group
    `)
    expect(nssFallback.status).toBe(0)
  })

  it('resolves SupplementaryGroups in scripts/install without getent', () => {
    const helper = extractHelper(installScript).replace('/etc/group', groupFile)

    const runInstallSuppGroups = () => runBash(`
      getent() { return 127; }
      ${helper}
      SUPP_GROUPS=()
      if _group_exists dac; then
        SUPP_GROUPS+=(dac)
      fi
      if _group_exists systemd-journal; then
        SUPP_GROUPS+=(systemd-journal)
      elif _group_exists adm; then
        SUPP_GROUPS+=(adm)
      fi
      SUPP_GROUPS_LINE=""
      if [ \${#SUPP_GROUPS[@]} -gt 0 ]; then
        SUPP_GROUPS_LINE="SupplementaryGroups=\${SUPP_GROUPS[*]}"
      fi
      printf '%s' "$SUPP_GROUPS_LINE"
    `)

    // systemd-journal preferred when both systemd-journal and adm exist
    expect(runInstallSuppGroups().stdout).toBe('SupplementaryGroups=dac systemd-journal')

    // adm fallback when systemd-journal is absent
    writeFileSync(groupFile, 'dac:x:1000:sleepypod\nadm:x:4:\n')
    expect(runInstallSuppGroups().stdout).toBe('SupplementaryGroups=dac adm')

    // only dac when neither journal group exists
    writeFileSync(groupFile, 'dac:x:1000:sleepypod\n')
    expect(runInstallSuppGroups().stdout).toBe('SupplementaryGroups=dac')

    // empty when no groups exist
    writeFileSync(groupFile, '')
    expect(runInstallSuppGroups().stdout).toBe('')
  })

  it('resolves supp_group in scripts/bin/sp-update without getent', () => {
    const helper = extractHelper(updateScript).replace('/etc/group', groupFile)

    const runUpdateSuppGroup = () => runBash(`
      getent() { return 127; }
      ${helper}
      supp_group=""
      if _group_exists systemd-journal; then
        supp_group="systemd-journal"
      elif _group_exists adm; then
        supp_group="adm"
      fi
      printf '%s' "$supp_group"
    `)

    // systemd-journal preferred
    expect(runUpdateSuppGroup().stdout).toBe('systemd-journal')

    // adm fallback
    writeFileSync(groupFile, 'adm:x:4:\n')
    expect(runUpdateSuppGroup().stdout).toBe('adm')

    // empty when neither exists
    writeFileSync(groupFile, 'dac:x:1000:\n')
    expect(runUpdateSuppGroup().stdout).toBe('')
  })
})
