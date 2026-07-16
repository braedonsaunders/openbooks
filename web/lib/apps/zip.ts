import { unzipSync, strFromU8 } from 'fflate'
import { contentTypeFor } from './manifest'

/**
 * Zip → bundle parsing for App uploads. Pure module (no server-only, no DB) so
 * it unit-tests directly. Accepts the archive layout people actually produce:
 * manifest.json either at the root or inside a single top-level folder (the
 * "right-click → compress" shape); junk entries (__MACOSX, .DS_Store,
 * directories) are skipped. Text files are stored as UTF-8, binaries as base64
 * with isBinary=true — the same wire shape the JSON install path uses.
 */

export interface ParsedBundle {
  manifest: unknown
  files: { path: string; content: string; isBinary: boolean }[]
}

export class ZipBundleError extends Error {
  readonly name = 'ZipBundleError'
}

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/
const MAX_FILES = 500
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 // 20 MB decompressed

export function parseZipBundle(bytes: Uint8Array): ParsedBundle {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (e) {
    throw new ZipBundleError(`not a readable zip archive: ${(e as Error).message}`)
  }

  // Drop directories + junk, then normalize away a single shared root folder.
  let paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !JUNK.test(p))
  if (paths.length === 0) throw new ZipBundleError('zip archive is empty')
  if (paths.length > MAX_FILES) throw new ZipBundleError(`too many files (max ${MAX_FILES})`)

  let prefix = ''
  if (!paths.includes('manifest.json')) {
    const nested = paths.find((p) => /(^|\/)manifest\.json$/.test(p))
    if (!nested) throw new ZipBundleError('manifest.json not found in the archive')
    prefix = nested.slice(0, nested.length - 'manifest.json'.length)
    if (prefix && !paths.every((p) => p.startsWith(prefix))) {
      throw new ZipBundleError('manifest.json must be at the archive root')
    }
  }

  let total = 0
  let manifest: unknown
  const files: ParsedBundle['files'] = []
  for (const raw of paths) {
    const data = entries[raw]!
    total += data.length
    if (total > MAX_TOTAL_BYTES) throw new ZipBundleError('bundle exceeds 20 MB decompressed')
    const path = raw.slice(prefix.length)
    if (!path) continue
    if (path === 'manifest.json') {
      try {
        manifest = JSON.parse(strFromU8(data))
      } catch {
        throw new ZipBundleError('manifest.json is not valid JSON')
      }
      continue
    }
    const { binary } = contentTypeFor(path)
    files.push({
      path,
      content: binary ? Buffer.from(data).toString('base64') : strFromU8(data),
      isBinary: binary,
    })
  }
  if (manifest === undefined) throw new ZipBundleError('manifest.json not found in the archive')
  return { manifest, files }
}
