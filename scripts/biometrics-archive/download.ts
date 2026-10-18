import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { z } from 'zod'
import { ANALYSIS_EXPORT_FORMAT, ANALYSIS_EXPORT_PATH } from '@/src/biometrics/analysis-export'
import { parseTarHeader } from '@/src/biometrics/backtest/bundle-tar'

const DATABASE_ENTRY = 'biometrics.db'
const MANIFEST_ENTRY = 'manifest.json'
const RAW_ENTRY = /^raw\/([A-Za-z0-9_-]+\.RAW\.gz)$/
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const size = z.number().int().nonnegative()

/** manifest.json of analysis-export-v1 (src/biometrics/analysis-export-bundle.ts). */
export const exportManifestSchema = z.object({
  formatVersion: z.literal(ANALYSIS_EXPORT_FORMAT),
  generatedAt: z.string(),
  generatedAtMs: size,
  build: z.object({ branch: z.string(), commitHash: z.string(), commitTitle: z.string(), buildDate: z.string() }),
  pod: z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/).nullable(),
    idSource: z.string(),
    hostname: z.string().min(1),
    model: z.object({ podVersion: z.string(), name: z.string(), hardwareRevision: z.string().nullable() }).nullable(),
  }),
  schema: z.object({
    biometrics: z.object({ migrationHash: z.string(), migrationCreatedAt: z.number(), migrationTag: z.string().nullable(), appliedMigrations: size }).nullable(),
  }),
  window: z.object({
    requested: z.object({ startMs: size, endMs: size, start: z.string(), end: z.string() }),
    rawSelection: z.object({ includeRaw: z.boolean(), mtimeFromMs: z.number(), mtimeToMs: z.number() }),
    served: z.object({ archiveCount: size, rawMtimeMinMs: z.number().nullable(), rawMtimeMaxMs: z.number().nullable() }),
  }),
  files: z.array(z.discriminatedUnion('role', [
    z.object({ role: z.literal('database'), path: z.literal(DATABASE_ENTRY), bytes: size, sha256 }),
    z.object({ role: z.literal('raw'), path: z.string().regex(RAW_ENTRY), name: z.string(), mtimeMs: z.number(), bytes: size, sha256 }),
  ])),
})
export type ExportManifest = z.infer<typeof exportManifestSchema>
export type ManifestRawFile = Extract<ExportManifest['files'][number], { role: 'raw' }>

export interface ExportWindow { startMs: number, endMs: number, includeRaw: boolean }

/** A verified export in a staging directory: every file matched the manifest. */
export interface DownloadedExport {
  manifest: ExportManifest
  /** manifest.json as served, kept verbatim in the pull record. */
  manifestJson: unknown
  databasePath: string
  raw: Array<ManifestRawFile & { localPath: string }>
}

/** A response other than 200; 413 and 429 drive window halving and retry. */
export class ExportHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs: number | null) {
    super(message)
  }
}

export class ExportIntegrityError extends Error {}

export function exportUrl(pod: string, window: ExportWindow) {
  return `http://${pod}${ANALYSIS_EXPORT_PATH}?start=${window.startMs}&end=${window.endMs}&raw=${window.includeRaw ? 1 : 0}`
}

/** Byte-exact reads over a chunked stream. */
class ByteReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private ended = false
  total = 0
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(bytes: number) {
    while (this.buffered < bytes && !this.ended) {
      const next = await this.source.next()
      if (next.done) this.ended = true
      else {
        const chunk = Buffer.from(next.value)
        this.chunks.push(chunk)
        this.buffered += chunk.length
        this.total += chunk.length
      }
    }
  }

  private take(bytes: number) {
    const first = this.chunks[0]
    if (first.length <= bytes) {
      this.chunks.shift()
      this.buffered -= first.length
      return first
    }
    this.chunks[0] = first.subarray(bytes)
    this.buffered -= bytes
    return first.subarray(0, bytes)
  }

  async read(bytes: number) {
    await this.fill(bytes)
    if (this.buffered < bytes) throw new ExportIntegrityError('Export stream ended early (truncated tar)')
    const parts: Buffer[] = []
    let remaining = bytes
    while (remaining > 0) {
      const part = this.take(remaining)
      parts.push(part)
      remaining -= part.length
    }
    return Buffer.concat(parts, bytes)
  }

  async* stream(bytes: number) {
    let remaining = bytes
    while (remaining > 0) {
      if (this.buffered === 0) await this.fill(1)
      if (this.buffered === 0) throw new ExportIntegrityError('Export stream ended early (truncated tar)')
      const part = this.take(remaining)
      remaining -= part.length
      yield part
    }
  }

  async atEnd() {
    await this.fill(1)
    return this.buffered === 0
  }
}

async function errorMessage(response: Response) {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    if (typeof parsed.error === 'string') return parsed.error
  }
  catch { /* not JSON */ }
  return text.slice(0, 500) || response.statusText
}

/**
 * Download one export into `staging`, hashing every entry as it streams, then
 * check the manifest: the exact file set, sizes, SHA-256s and the requested
 * window. Throws before anything leaves `staging`.
 */
export async function downloadExport(fetchImpl: typeof fetch, pod: string, window: ExportWindow, staging: string): Promise<DownloadedExport> {
  const response = await fetchImpl(exportUrl(pod, window)).catch((error: unknown) => {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)
    throw new Error(`Could not reach ${pod}: ${cause}`)
  })
  if (response.status !== 200) {
    const retryAfter = Number(response.headers.get('Retry-After') ?? Number.NaN)
    throw new ExportHttpError(response.status, `HTTP ${response.status} from ${pod}: ${await errorMessage(response)}`,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : null)
  }
  if (!response.body) throw new ExportIntegrityError('Export response has no body')
  await mkdir(join(staging, 'raw'), { recursive: true })
  const reader = new ByteReader(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)[Symbol.asyncIterator]())
  const received = new Map<string, { bytes: number, sha256: string, localPath: string }>()
  let manifestText: string | undefined
  for (;;) {
    const header = parseTarHeader(await reader.read(512))
    if (!header) break
    if (manifestText !== undefined) throw new ExportIntegrityError(`Unexpected entry after manifest.json: ${header.name}`)
    if (received.has(header.name)) throw new ExportIntegrityError(`Duplicate export entry: ${header.name}`)
    const padding = (512 - (header.bytes % 512)) % 512
    if (header.name === MANIFEST_ENTRY) {
      if (header.bytes > MAX_MANIFEST_BYTES) throw new ExportIntegrityError('manifest.json is too large')
      manifestText = (await reader.read(header.bytes)).toString('utf8')
    }
    else {
      const raw = RAW_ENTRY.exec(header.name)
      if (header.name !== DATABASE_ENTRY && !raw) throw new ExportIntegrityError(`Unexpected export entry: ${header.name}`)
      const localPath = raw ? join(staging, 'raw', raw[1]) : join(staging, DATABASE_ENTRY)
      const digest = createHash('sha256')
      await pipeline(Readable.from((async function* () {
        for await (const chunk of reader.stream(header.bytes)) {
          digest.update(chunk)
          yield chunk
        }
      })()), createWriteStream(localPath, { flags: 'wx', mode: 0o600 }))
      received.set(header.name, { bytes: header.bytes, sha256: digest.digest('hex'), localPath })
    }
    await reader.read(padding)
  }
  while (!(await reader.atEnd())) {
    if ((await reader.read(512)).some(byte => byte !== 0)) throw new ExportIntegrityError('Export tar has data after its end marker')
  }
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > 0 && reader.total !== declared) {
    throw new ExportIntegrityError(`Export was ${reader.total} bytes, Content-Length said ${declared}`)
  }
  if (manifestText === undefined) throw new ExportIntegrityError('Export has no manifest.json (download cut short?)')

  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(manifestText)
  }
  catch {
    throw new ExportIntegrityError('manifest.json is not valid JSON')
  }
  const parsed = exportManifestSchema.safeParse(manifestJson)
  if (!parsed.success) throw new ExportIntegrityError(`manifest.json does not match ${ANALYSIS_EXPORT_FORMAT}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  const manifest = parsed.data
  const { requested, rawSelection } = manifest.window
  if (requested.startMs !== window.startMs || requested.endMs !== window.endMs || rawSelection.includeRaw !== window.includeRaw) {
    throw new ExportIntegrityError(`Pod served window ${requested.startMs}–${requested.endMs} (raw=${rawSelection.includeRaw}), not the one requested`)
  }

  const listed = new Set<string>()
  for (const file of manifest.files) {
    if (listed.has(file.path)) throw new ExportIntegrityError(`manifest.json lists ${file.path} twice`)
    listed.add(file.path)
    if (file.role === 'raw' && file.path !== `raw/${file.name}`) throw new ExportIntegrityError(`manifest.json raw entry ${file.path} names ${file.name}`)
    const got = received.get(file.path)
    if (!got) throw new ExportIntegrityError(`Export is missing ${file.path}`)
    if (got.bytes !== file.bytes) throw new ExportIntegrityError(`Size mismatch: ${file.path} is ${got.bytes} bytes, manifest says ${file.bytes}`)
    if (got.sha256 !== file.sha256) throw new ExportIntegrityError(`SHA-256 mismatch: ${file.path}`)
  }
  for (const name of received.keys()) if (!listed.has(name)) throw new ExportIntegrityError(`Export entry ${name} is not in manifest.json`)
  if (!listed.has(DATABASE_ENTRY)) throw new ExportIntegrityError('Export has no biometrics.db')

  // Every listed file was received (checked above), so the lookups below hit.
  const localPath = (path: string) => received.get(path)?.localPath ?? ''
  return {
    manifest,
    manifestJson,
    databasePath: localPath(DATABASE_ENTRY),
    raw: manifest.files.filter((file): file is ManifestRawFile => file.role === 'raw').map(file => ({ ...file, localPath: localPath(file.path) })),
  }
}
