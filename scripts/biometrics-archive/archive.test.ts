// @vitest-environment node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runArchiveCli } from './cli'
import { ExportIntegrityError } from './download'
import { ArchiveLockedError, findCursor, LOCK_FILE, pull, type PullOptions } from './pull'
import { LocalStore } from './store'

const state = vi.hoisted(() => ({ archive: '', source: '' }))
vi.mock('@/src/lib/podStorage', () => ({
  get ARCHIVE_DIR() {
    return state.archive
  },
}))
vi.mock('@/src/db', () => ({ biometricsDb: { $client: { get name() {
  return state.source
} } } }))
vi.mock('@/src/homekit/storage', () => ({ readSeed: () => ({ source: 'mmc-cid', value: 'cid-0123' }) }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: () => null }))

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 18, 12)
const POD = 'pod.local'

let root: string
let dest: string
let pod: Database.Database
let route: { GET: (request: Request) => Promise<Response> }
const calls: string[] = []

const podFetch: typeof fetch = async (input) => {
  calls.push(String(input))
  return route.GET(new Request(String(input)))
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'biometrics-archive-test-'))
  state.archive = join(root, 'biometrics-archive')
  state.source = join(root, 'biometrics.db')
  dest = join(root, 'dest')
  mkdirSync(state.archive)
  mkdirSync(join(root, 'tmpfs'))
  vi.stubEnv('TMPDIR', join(root, 'tmpfs'))
  pod = new Database(state.source)
  pod.pragma('journal_mode = WAL')
  migrate(drizzle(pod), { migrationsFolder: 'src/db/biometrics-migrations' })
  calls.length = 0
  vi.resetModules()
  route = await import('@/app/api/biometrics/analysis-export/route')
})
afterEach(() => {
  pod.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

const seconds = (ms: number) => Math.floor(ms / 1000)
function vitals(fromMs: number, count: number, side = 'left') {
  const insert = pod.prepare('INSERT INTO vitals (side, timestamp, heart_rate) VALUES (?, ?, ?)')
  const quality = pod.prepare('INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score, created_at) VALUES (?, ?, ?, 0.9, ?)')
  for (let index = 0; index < count; index++) {
    const ts = seconds(fromMs) + index * 60
    const id = insert.run(side, ts, 55 + index).lastInsertRowid
    quality.run(id, side, ts, ts)
  }
}
function rawArchive(name: string, mtimeMs: number, body = `frame ${name} ${mtimeMs}`) {
  const path = join(state.archive, name)
  writeFileSync(path, body)
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
  return createHash('sha256').update(body).digest('hex')
}

const options = (extra: Partial<PullOptions> = {}): PullOptions => ({ pod: POD, dest, includeRaw: true, fetch: podFetch, now: () => NOW, sleep: async () => {}, ...extra })
const podDir = () => readdirSync(dest).filter(name => !name.startsWith('.'))
function archiveDb<T>(read: (db: Database.Database) => T): T {
  const db = new Database(join(dest, podDir()[0], 'biometrics.db'), { readonly: true })
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}
const count = (table: string) => archiveDb(db => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
function listing(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? listing(join(directory, entry.name)).map(name => `${entry.name}/${name}`)
    : [`${entry.name}:${createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex')}`])
}

describe('biometrics archive pull', () => {
  it('stores a first pull: content-addressed RAW, archive links, merged database and a pull record', async () => {
    vitals(NOW - 3 * DAY, 5)
    const a = rawArchive('A0000001.RAW.gz', NOW - 3 * DAY)
    const b = rawArchive('A0000002.RAW.gz', NOW - DAY)

    const [record] = await pull(options())
    expect(calls).toEqual([`http://pod.local:3000/api/biometrics/analysis-export?start=${NOW - 14 * DAY}&end=${NOW}&raw=1`])
    const [dir] = podDir()
    expect(dir).toMatch(/^[0-9a-f]{32}$/)
    expect(readdirSync(join(dest, dir, 'raw')).sort()).toEqual([`${a}.RAW.gz`, `${b}.RAW.gz`].sort())
    const linked = join(dest, dir, 'archive', 'A0000001.RAW.gz')
    expect(statSync(linked).ino).toBe(statSync(join(dest, dir, 'raw', `${a}.RAW.gz`)).ino)
    expect(statSync(linked).mtimeMs).toBe(NOW - 3 * DAY)
    expect(count('vitals')).toBe(5)
    expect(count('vitals_quality')).toBe(5)
    expect(record).toMatchObject({ podHost: 'pod.local:3000', podDir: dir, cursor: { endMs: NOW }, raw: { new: 2, skipped: 0, linked: 2, renamed: [] } })
    expect(record.tables.vitals).toMatchObject({ snapshot: 5, inserted: 5, reassigned: 0, ignored: 0, conflicts: 0 })
    const pulls = readdirSync(join(dest, dir, 'pulls'))
    expect(pulls).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dest, dir, 'pulls', pulls[0]), 'utf8')).manifest.formatVersion).toBe('analysis-export-v1')
    expect(existsSync(join(dest, LOCK_FILE))).toBe(false)
    expect(existsSync(join(dest, '.staging'))).toBe(false)
  })

  it('is idempotent: the same window again adds nothing, and the cursor makes the default pull a no-op', async () => {
    vitals(NOW - 2 * DAY, 4)
    rawArchive('A0000001.RAW.gz', NOW - 2 * DAY)
    await pull(options())
    const [again] = await pull(options({ sinceMs: NOW - 14 * DAY, untilMs: NOW }))
    expect(again.raw).toMatchObject({ new: 0, skipped: 1, linked: 0, copied: 0 })
    expect(again.rows).toEqual({ inserted: 0, reassigned: 0, ignored: again.rows.ignored, updated: 0, conflicts: 0 })
    expect(again.rows.ignored).toBeGreaterThan(0)
    expect(count('vitals')).toBe(4)

    calls.length = 0
    expect(await pull(options())).toEqual([])
    expect(calls).toEqual([])
  })

  it('merges overlapping windows without duplicating RAW or rows', async () => {
    const t0 = NOW - 10 * DAY
    vitals(t0, 3)
    rawArchive('A0000001.RAW.gz', t0 + 12 * 60 * 60 * 1000)
    rawArchive('A0000002.RAW.gz', t0 + 36 * 60 * 60 * 1000)
    await pull(options({ sinceMs: t0, untilMs: t0 + 2 * DAY }))
    vitals(t0 + 2 * DAY, 2)
    rawArchive('A0000003.RAW.gz', t0 + 60 * 60 * 60 * 1000)
    const [second] = await pull(options({ sinceMs: t0 + DAY, untilMs: t0 + 3 * DAY }))
    expect(second.raw).toMatchObject({ new: 1, skipped: 1 })
    expect(second.tables.vitals).toMatchObject({ inserted: 2, ignored: 3 })
    expect(count('vitals')).toBe(5)
    expect(readdirSync(join(dest, podDir()[0], 'archive')).sort()).toEqual(['A0000001.RAW.gz', 'A0000002.RAW.gz', 'A0000003.RAW.gz'])
  })

  it('keeps history the pod has since pruned', async () => {
    vitals(NOW - 13 * DAY, 3)
    await pull(options({ now: () => NOW - 5 * DAY }))
    pod.exec(`DELETE FROM vitals_quality; DELETE FROM vitals WHERE timestamp < ${seconds(NOW - 10 * DAY)}`)
    vitals(NOW - 2 * DAY, 2)
    const [second] = await pull(options())
    expect(second.window).toMatchObject({ startMs: NOW - 5 * DAY, endMs: NOW })
    expect(count('vitals')).toBe(5)
    expect(count('vitals_quality')).toBe(5)
  })

  it.each([
    ['a flipped RAW byte', (bytes: Buffer) => {
      const at = bytes.indexOf('frame A0000009')
      bytes[at] ^= 0xff
      return bytes
    }, 'SHA-256 mismatch: raw/A0000009.RAW.gz'],
    ['a cut-short download', (bytes: Buffer) => bytes.subarray(0, bytes.length - 2048), 'truncated'],
  ])('rejects %s without changing the store or the cursor', async (_label, corrupt, message) => {
    vitals(NOW - 3 * DAY, 2)
    await pull(options({ now: () => NOW - DAY }))
    const before = listing(dest)
    vitals(NOW - DAY / 2, 2)
    rawArchive('A0000009.RAW.gz', NOW - DAY / 2)
    const corrupting: typeof fetch = async (input) => {
      const response = await podFetch(input)
      return new Response(new Uint8Array(corrupt(Buffer.from(await response.arrayBuffer()))), { status: 200, headers: response.headers })
    }
    await expect(pull(options({ fetch: corrupting }))).rejects.toThrow(message)
    await expect(pull(options({ fetch: corrupting }))).rejects.toBeInstanceOf(ExportIntegrityError)
    expect(listing(dest)).toEqual(before)
    expect(await findCursor(new LocalStore(dest), dest, 'pod.local:3000', () => {})).toBe(NOW - DAY)
  })

  it('does not let a database-only pull advance the cursor of RAW pulls', async () => {
    vitals(NOW - 3 * DAY, 2)
    await pull(options({ now: () => NOW - 2 * DAY }))
    await pull(options({ now: () => NOW - DAY, includeRaw: false }))
    const store = new LocalStore(dest)
    expect(await findCursor(store, dest, 'pod.local:3000', () => {}, true)).toBe(NOW - 2 * DAY)
    expect(await findCursor(store, dest, 'pod.local:3000', () => {}, false)).toBe(NOW - DAY)
  })

  it('retries 429 with backoff, honouring Retry-After', async () => {
    vitals(NOW - DAY, 1)
    let busy = 2
    const delays: number[] = []
    const fetchImpl: typeof fetch = async (input) => {
      if (busy-- > 0) return Response.json({ error: 'Another analysis export is in progress, retry later' }, { status: 429, headers: busy ? { 'Retry-After': '60' } : {} })
      return podFetch(input)
    }
    const records = await pull(options({ fetch: fetchImpl, sleep: async (ms) => {
      delays.push(ms)
    }, retry: { attempts: 3, baseDelayMs: 1000, maxDelayMs: 45_000 } }))
    expect(delays).toEqual([45_000, 2000])
    expect(records).toHaveLength(1)

    busy = 5
    await expect(pull(options({ fetch: fetchImpl, sinceMs: NOW - DAY, untilMs: NOW, retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }))).rejects.toThrow('HTTP 429')
  })

  it('halves the window on 413 down to the floor, oldest half first', async () => {
    vitals(NOW - 12 * DAY, 2)
    const fetchImpl: typeof fetch = async (input) => {
      const query = new URL(String(input)).searchParams
      if (Number(query.get('end')) - Number(query.get('start')) > 4 * DAY) return Response.json({ error: 'over the limit' }, { status: 413 })
      return podFetch(input)
    }
    const records = await pull(options({ fetch: fetchImpl }))
    expect(records.map(record => [record.window.startMs, record.window.endMs])).toEqual([
      [NOW - 14 * DAY, NOW - 10.5 * DAY], [NOW - 10.5 * DAY, NOW - 7 * DAY], [NOW - 7 * DAY, NOW - 3.5 * DAY], [NOW - 3.5 * DAY, NOW],
    ])
    expect(count('vitals')).toBe(2)

    const always413: typeof fetch = async () => Response.json({ error: 'over the limit' }, { status: 413 })
    await expect(pull(options({ fetch: always413, sinceMs: NOW - DAY, untilMs: NOW, minWindowMs: 6 * 60 * 60 * 1000 })))
      .rejects.toThrow(/over the limit.*cannot be halved below 6 h; pull it with --no-raw/)
  })

  it('splits ranges longer than 14 days into chunks, oldest first', async () => {
    await pull(options({ sinceMs: NOW - 30 * DAY, includeRaw: false }))
    expect(calls.map(call => new URL(call).searchParams.toString())).toEqual([
      `start=${NOW - 30 * DAY}&end=${NOW - 16 * DAY}&raw=0`, `start=${NOW - 16 * DAY}&end=${NOW - 2 * DAY}&raw=0`, `start=${NOW - 2 * DAY}&end=${NOW}&raw=0`,
    ])
  })

  it('lets only one pull into a destination run at a time', async () => {
    mkdirSync(dest)
    writeFileSync(join(dest, LOCK_FILE), JSON.stringify({ pid: process.pid, host: (await import('node:os')).hostname(), startedAt: 'earlier' }))
    await expect(pull(options())).rejects.toBeInstanceOf(ArchiveLockedError)
    expect(calls).toEqual([])

    // A lock left by a process that no longer exists is taken over.
    writeFileSync(join(dest, LOCK_FILE), JSON.stringify({ pid: 999_999, host: (await import('node:os')).hostname(), startedAt: 'earlier' }))
    await expect(pull(options())).resolves.toHaveLength(1)

    const results = await Promise.allSettled([pull(options({ sinceMs: NOW - DAY })), pull(options({ sinceMs: NOW - DAY }))])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ArchiveLockedError)
  })

  it('never overwrites an archive name the pod reused for different bytes', async () => {
    const first = rawArchive('A0000001.RAW.gz', NOW - 5 * DAY, 'before the counter reset')
    await pull(options({ now: () => NOW - 4 * DAY }))
    rmSync(join(state.archive, 'A0000001.RAW.gz'))
    const second = rawArchive('A0000001.RAW.gz', NOW - DAY, 'after the counter reset')
    const [record] = await pull(options())
    const dir = join(dest, podDir()[0])
    const renamed = `A0000001-${second.slice(0, 12)}.RAW.gz`
    expect(record.raw.renamed).toEqual([{ name: 'A0000001.RAW.gz', archiveName: renamed, sha256: second }])
    expect(readFileSync(join(dir, 'archive', 'A0000001.RAW.gz'), 'utf8')).toBe('before the counter reset')
    expect(readFileSync(join(dir, 'archive', renamed), 'utf8')).toBe('after the counter reset')
    expect(archiveDb(db => db.prepare('SELECT sha256, name, archive_name AS archiveName FROM archive_raw_files ORDER BY mtime_ms').all())).toEqual([
      { sha256: first, name: 'A0000001.RAW.gz', archiveName: 'A0000001.RAW.gz' },
      { sha256: second, name: 'A0000001.RAW.gz', archiveName: renamed },
    ])
  })

  it('validates CLI arguments before contacting the pod', async () => {
    await expect(runArchiveCli(['pull', '--dest', dest], { fetch: podFetch })).rejects.toThrow('--pod is required')
    await expect(runArchiveCli(['pull', '--pod', 'pod local', '--dest', dest], { fetch: podFetch })).rejects.toThrow('--pod is HOST or HOST:PORT')
    await expect(runArchiveCli(['pull', '--pod', POD, '--dest', dest, '--since', 'yesterday'], { fetch: podFetch })).rejects.toThrow('--since must be an ISO 8601 timestamp')
    await expect(runArchiveCli(['pull', '--pod', POD, '--dest', dest, '--since', '2026-10-10T00:00:00Z', '--until', '2026-10-01T00:00:00Z'], { fetch: podFetch }))
      .rejects.toThrow('--since must be before --until')
    await expect(runArchiveCli(['push'])).rejects.toThrow('Usage')
    expect(calls).toEqual([])
  })
})
