import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** `mtimeMs` is the source file's modification time, kept where the backend can. */
export interface ObjectMeta { sha256: string, size: number, mtimeMs?: number }

/**
 * Where archived objects live. Keys are relative POSIX paths such as
 * `<pod>/raw/<sha256>.RAW.gz`. `put` replaces atomically and rejects bytes
 * that don't match `meta`; write-once is the caller's job (`exists` → skip).
 * `link` makes `to` name the same bytes as `from` and fails if `to` exists;
 * a backend without links copies.
 */
export interface Store {
  put(key: string, body: Readable, meta: ObjectMeta): Promise<void>
  get(key: string): Promise<Readable>
  exists(key: string): Promise<boolean>
  /** Every key under `prefix`, recursively, sorted. */
  list(prefix: string): Promise<string[]>
  link(from: string, to: string): Promise<'linked' | 'copied'>
}

export class StoreIntegrityError extends Error {}

const KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

export class LocalStore implements Store {
  readonly root: string
  constructor(root: string) {
    this.root = resolve(root)
  }

  private path(key: string) {
    if (!KEY.test(key) || key.split('/').some(part => part === '.' || part === '..')) throw new Error(`Invalid store key: ${key}`)
    return join(this.root, ...key.split('/'))
  }

  async put(key: string, body: Readable, meta: ObjectMeta) {
    const target = this.path(key)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const digest = createHash('sha256')
    let size = 0
    try {
      await pipeline(body, async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          digest.update(chunk)
          size += chunk.length
          yield chunk
        }
      }, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
      const sha256 = digest.digest('hex')
      if (size !== meta.size || sha256 !== meta.sha256) throw new StoreIntegrityError(`${key}: expected ${meta.size} bytes with SHA-256 ${meta.sha256}, got ${size} bytes with ${sha256}`)
      if (meta.mtimeMs !== undefined) await utimes(temporary, new Date(), new Date(meta.mtimeMs))
      await rename(temporary, target)
    }
    finally {
      await rm(temporary, { force: true })
    }
  }

  async get(key: string) {
    const path = this.path(key)
    await stat(path)
    return createReadStream(path)
  }

  async exists(key: string) {
    return stat(this.path(key)).then(info => info.isFile(), () => false)
  }

  async list(prefix: string) {
    const trimmed = prefix.replace(/\/+$/, '')
    const start = trimmed ? this.path(trimmed) : this.root
    const keys: string[] = []
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
        throw error
      })
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile() && !entry.name.includes('.tmp-')) keys.push(path.slice(this.root.length + 1).split(sep).join('/'))
      }
    }
    await walk(start)
    return keys.filter(key => key.startsWith(prefix)).sort()
  }

  async link(from: string, to: string) {
    const source = this.path(from), target = this.path(to)
    await mkdir(dirname(target), { recursive: true })
    try {
      await link(source, target)
      return 'linked' as const
    }
    catch (error) {
      // Filesystems without hard links (some NAS/SMB mounts) get a copy.
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await copyFile(source, target, constants.COPYFILE_EXCL)
      return 'copied' as const
    }
  }
}

export async function putBuffer(store: Store, key: string, bytes: Buffer) {
  await store.put(key, Readable.from([bytes]), { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
}

export async function readText(store: Store, key: string) {
  const chunks: Buffer[] = []
  for await (const chunk of await store.get(key)) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
