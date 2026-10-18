import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { MAX_ANALYSIS_WINDOW_MS } from '@/src/biometrics/analysis-export'
import { downloadExport, ExportHttpError, type DownloadedExport, type ExportWindow } from './download'
import { checkSnapshotSchema, mergeSnapshot, openArchiveDatabase, type TableCounts } from './merge'
import { LocalStore, putBuffer, readText, type Store } from './store'

export const PULL_RECORD_FORMAT = 'biometrics-archive-pull-v1'
export const LOCK_FILE = '.biometrics-archive.lock'
const STAGING_DIR = '.staging'
const HOUR_MS = 60 * 60 * 1000

export interface PullOptions {
  /** host[:port]; port defaults to 3000. */
  pod: string
  dest: string
  sinceMs?: number
  untilMs?: number
  includeRaw: boolean
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
  /** 429 handling: attempts per window and exponential backoff bounds. */
  retry?: { attempts: number, baseDelayMs: number, maxDelayMs: number }
  /** 413 halves the window down to this length, then fails. */
  minWindowMs?: number
}

export interface PullRecord {
  formatVersion: typeof PULL_RECORD_FORMAT
  pulledAt: string
  podHost: string
  podDir: string
  podId: string | null
  window: ExportWindow
  /** The served (requested) window end; the next default pull starts here. */
  cursor: { endMs: number, end: string }
  raw: { new: number, skipped: number, linked: number, copied: number, renamed: Array<{ name: string, archiveName: string, sha256: string }> }
  tables: Record<string, TableCounts>
  rows: { inserted: number, reassigned: number, ignored: number, updated: number, conflicts: number }
  schema: { snapshotTag: string | null, knownToCheckout: boolean, checkoutTag: string }
  warnings: string[]
  manifest: unknown
}

export class ArchiveLockedError extends Error {}

const pullRecordCursorSchema = z.object({
  formatVersion: z.literal(PULL_RECORD_FORMAT),
  podHost: z.string(),
  cursor: z.object({ endMs: z.number().int().nonnegative() }),
  // Records written before the mode was stored always included RAW.
  window: z.object({ includeRaw: z.boolean().default(true) }).default({ includeRaw: true }),
})

export function normalizePod(pod: string) {
  return /:\d+$/.test(pod) ? pod : `${pod}:3000`
}

/** Directory name for a pod: its stable id, else its hostname made path-safe. */
export function podDirectory(pod: DownloadedExport['manifest']['pod']) {
  return pod.id ?? (pod.hostname.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'unknown-pod')
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** One pull per destination. A lock left by a dead process on this host is taken over. */
export async function acquireLock(dest: string) {
  const path = join(dest, LOCK_FILE)
  const body = JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(path, body, { flag: 'wx', mode: 0o600 })
      return async () => {
        await rm(path, { force: true })
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holder: { pid?: unknown, host?: unknown, startedAt?: unknown } = {}
      try {
        holder = JSON.parse(await readFile(path, 'utf8')) as typeof holder
      }
      catch { /* unreadable: treat as held */ }
      const stale = holder.host === hostname() && typeof holder.pid === 'number' && !isAlive(holder.pid)
      if (!stale || attempt > 0) {
        throw new ArchiveLockedError(`Another pull into ${dest} is running (pid ${String(holder.pid)} on ${String(holder.host)} since ${String(holder.startedAt)}). If none is, delete ${path}.`)
      }
      await rm(path, { force: true })
    }
  }
}

/**
 * The next default start: the largest served end among this pod's successful
 * pulls, so an explicit backfill of an older range never moves it back. Pods
 * are matched by --pod; if none match and the destination holds exactly one
 * pod with pulls, that pod's cursor is used. A pull that includes RAW only
 * counts earlier RAW pulls, so a --no-raw pull never skips archives it did not
 * fetch; a database-only pull counts every record.
 */
export async function findCursor(store: Store, dest: string, podHost: string, log: (line: string) => void, includeRaw = true) {
  const directories = (await readdir(dest, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
  const perPod = new Map<string, { matched: number | null, any: number | null }>()
  for (const directory of directories) {
    const cursors = { matched: null as number | null, any: null as number | null }
    for (const key of await store.list(`${directory}/pulls/`)) {
      if (!key.endsWith('.json')) continue
      const parsed = pullRecordCursorSchema.safeParse(await readText(store, key).then(text => JSON.parse(text) as unknown).catch(() => null))
      if (!parsed.success || (includeRaw && !parsed.data.window.includeRaw)) continue
      const end = parsed.data.cursor.endMs
      cursors.any = Math.max(cursors.any ?? end, end)
      if (parsed.data.podHost === podHost) cursors.matched = Math.max(cursors.matched ?? end, end)
    }
    if (cursors.any !== null) perPod.set(directory, cursors)
  }
  const matched = [...perPod.values()].map(cursor => cursor.matched).filter(end => end !== null)
  if (matched.length) return Math.max(...matched)
  if (perPod.size === 1) {
    const [[directory, cursor]] = [...perPod]
    log(`No earlier pull from ${podHost}; continuing from the only pod in ${dest} (${directory})`)
    return cursor.any
  }
  return null
}

export function planWindows(sinceMs: number, untilMs: number) {
  const windows: Array<{ startMs: number, endMs: number }> = []
  for (let start = sinceMs; start < untilMs; start += MAX_ANALYSIS_WINDOW_MS) windows.push({ startMs: start, endMs: Math.min(start + MAX_ANALYSIS_WINDOW_MS, untilMs) })
  return windows
}

const sum = (counts: Record<string, TableCounts>, field: keyof TableCounts) => Object.values(counts).reduce((total, row) => total + row[field], 0)

/** Store one verified export: RAW blobs, the merged database, archive/ links, then the pull record (the cursor). */
async function commit(store: Store, dest: string, podHost: string, download: DownloadedExport, window: ExportWindow, nowMs: number, log: (line: string) => void): Promise<PullRecord> {
  const { manifest } = download
  const warnings: string[] = []
  const podDir = podDirectory(manifest.pod)
  if (!manifest.pod.id) {
    warnings.push(`Pod id is null (no hardware seed); storing under hostname ${podDir}`)
    log(`warning: ${warnings[0]}`)
  }
  const schema = checkSnapshotSchema(manifest.schema.biometrics)
  if (!schema.known) warnings.push(`Snapshot migration ${manifest.schema.biometrics?.migrationTag ?? manifest.schema.biometrics?.migrationCreatedAt} is not in this checkout's journal; merged on common columns`)

  const stamp = new Date(nowMs).toISOString().replace(/:/g, '-')
  let pullKey = `${podDir}/pulls/${stamp}.json`
  for (let suffix = 1; await store.exists(pullKey); suffix++) pullKey = `${podDir}/pulls/${stamp}-${suffix}.json`

  const raw: PullRecord['raw'] = { new: 0, skipped: 0, linked: 0, copied: 0, renamed: [] }
  for (const file of download.raw) {
    const key = `${podDir}/raw/${file.sha256}.RAW.gz`
    if (await store.exists(key)) raw.skipped++
    else {
      await store.put(key, createReadStream(file.localPath), { sha256: file.sha256, size: file.bytes, mtimeMs: file.mtimeMs })
      raw.new++
    }
  }

  await mkdir(join(dest, podDir), { recursive: true })
  const occupied = new Set<string>()
  for (const file of download.raw) if (await store.exists(`${podDir}/archive/${file.name}`)) occupied.add(file.name)
  const db = openArchiveDatabase(join(dest, podDir, 'biometrics.db'))
  let merged
  try {
    merged = mergeSnapshot(db, download.databasePath, manifest, { pullKey, nowMs, occupiedArchiveNames: occupied })
  }
  finally {
    db.close()
  }
  warnings.push(...merged.warnings)

  for (const name of merged.archiveNames) {
    const archiveKey = `${podDir}/archive/${name.archiveName}`
    if (name.renamed) raw.renamed.push({ name: name.name, archiveName: name.archiveName, sha256: name.sha256 })
    if (await store.exists(archiveKey)) continue
    raw[await store.link(`${podDir}/raw/${name.sha256}.RAW.gz`, archiveKey) === 'linked' ? 'linked' : 'copied']++
  }

  const record: PullRecord = {
    formatVersion: PULL_RECORD_FORMAT,
    pulledAt: new Date(nowMs).toISOString(),
    podHost,
    podDir,
    podId: manifest.pod.id,
    window,
    cursor: { endMs: manifest.window.requested.endMs, end: manifest.window.requested.end },
    raw,
    tables: merged.tables,
    rows: { inserted: sum(merged.tables, 'inserted'), reassigned: sum(merged.tables, 'reassigned'), ignored: sum(merged.tables, 'ignored'),
      updated: sum(merged.tables, 'updated'), conflicts: sum(merged.tables, 'conflicts') },
    schema: { snapshotTag: manifest.schema.biometrics?.migrationTag ?? null, knownToCheckout: schema.known, checkoutTag: schema.checkoutTag },
    warnings,
    manifest: download.manifestJson,
  }
  await putBuffer(store, pullKey, Buffer.from(`${JSON.stringify(record, null, 2)}\n`))
  return record
}

/**
 * Pull [since, until] from the pod in ≤14-day windows, oldest first. Each
 * window is downloaded and verified in staging before anything is stored; a
 * failed window leaves the store and the cursor as they were.
 */
export async function pull(options: PullOptions): Promise<PullRecord[]> {
  const fetchImpl = options.fetch ?? fetch
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const retry = options.retry ?? { attempts: 6, baseDelayMs: 30_000, maxDelayMs: 5 * 60_000 }
  const minWindowMs = options.minWindowMs ?? HOUR_MS
  const podHost = normalizePod(options.pod)

  await mkdir(options.dest, { recursive: true })
  const release = await acquireLock(options.dest)
  const records: PullRecord[] = []
  try {
    await rm(join(options.dest, STAGING_DIR), { recursive: true, force: true })
    const store = new LocalStore(options.dest)
    const untilMs = options.untilMs ?? now()
    const sinceMs = options.sinceMs ?? (await findCursor(store, options.dest, podHost, log, options.includeRaw)) ?? untilMs - MAX_ANALYSIS_WINDOW_MS
    if (sinceMs >= untilMs) {
      log(`Nothing to pull: ${new Date(sinceMs).toISOString()} is not before ${new Date(untilMs).toISOString()}`)
      return records
    }
    const pending = planWindows(sinceMs, untilMs).reverse()
    for (let span = pending.pop(); span; span = pending.pop()) {
      const window: ExportWindow = { ...span, includeRaw: options.includeRaw }
      const label = `${new Date(span.startMs).toISOString()} → ${new Date(span.endMs).toISOString()}`
      const staging = join(options.dest, STAGING_DIR, `${process.pid}-${randomBytes(4).toString('hex')}`)
      try {
        let download: DownloadedExport | undefined
        for (let attempt = 1; !download; attempt++) {
          try {
            download = await downloadExport(fetchImpl, podHost, window, staging)
          }
          catch (error) {
            if (!(error instanceof ExportHttpError) || error.status !== 429 || attempt >= retry.attempts) throw error
            const delay = Math.min(retry.maxDelayMs, error.retryAfterMs ?? retry.baseDelayMs * 2 ** (attempt - 1))
            log(`${label}: pod busy with another export (429), retrying in ${Math.round(delay / 1000)} s`)
            await rm(staging, { recursive: true, force: true })
            await sleep(delay)
          }
        }
        const record = await commit(store, options.dest, podHost, download, window, now(), log)
        records.push(record)
        log(`${label}: ${record.raw.new} new RAW (${record.raw.skipped} already stored), ${record.rows.inserted + record.rows.reassigned} rows added, `
          + `${record.rows.updated} updated, ${record.rows.conflicts} conflicts → ${record.podDir}/pulls/`)
      }
      catch (error) {
        if (!(error instanceof ExportHttpError) || error.status !== 413) throw error
        const half = Math.floor((span.endMs - span.startMs) / 2)
        if (half < minWindowMs) {
          throw new Error(`${error.message}. The window ${label} cannot be halved below ${minWindowMs / HOUR_MS} h; pull it with --no-raw, or fetch its RAW archives another way.`)
        }
        log(`${label}: RAW over the export limit (413), halving the window`)
        pending.push({ startMs: span.startMs + half, endMs: span.endMs }, { startMs: span.startMs, endMs: span.startMs + half })
      }
      finally {
        await rm(staging, { recursive: true, force: true })
      }
    }
    return records
  }
  finally {
    await rm(join(options.dest, STAGING_DIR), { recursive: true, force: true })
    await release()
  }
}
