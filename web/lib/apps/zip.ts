import { strFromU8, Unzip, UnzipInflate } from 'fflate'
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
export const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024 // 10 MB compressed
const MAX_COMPRESSION_RATIO = 100
const STREAM_CHUNK_BYTES = 1024

interface StreamedEntry {
  rawPath: string
  chunks: Uint8Array[]
  compressedStart: number
  compressedSize?: number
  uncompressedSize: number
}

function readableZipError(): ZipBundleError {
  return new ZipBundleError('not a readable zip archive')
}

export function parseZipBundle(bytes: Uint8Array): ParsedBundle {
  if (bytes.length > MAX_COMPRESSED_BYTES) {
    throw new ZipBundleError('zip too large (max 10 MB)')
  }

  const entries: StreamedEntry[] = []
  let entryCount = 0
  let reservedTotal = 0
  let streamedTotal = 0
  let pushedCompressedBytes = 0
  let activePushBytes = 0
  let streamError: ZipBundleError | undefined
  const failWhileStreaming = (message: string): never => {
    streamError = new ZipBundleError(message)
    throw streamError
  }
  const unzip = new Unzip((file) => {
    entryCount += 1
    if (entryCount > MAX_FILES) throw new ZipBundleError(`too many files (max ${MAX_FILES})`)

    // Do not start directories or known archive-manager junk. Leaving these
    // streams unopened makes fflate consume bytes without inflating them.
    if (file.name.endsWith('/') || JUNK.test(file.name)) return

    const originalSize = file.originalSize
    const compressedSize = file.size
    if (originalSize !== undefined) {
      if (!Number.isSafeInteger(originalSize) || originalSize < 0) throw readableZipError()
      if (originalSize > MAX_TOTAL_BYTES || reservedTotal > MAX_TOTAL_BYTES - originalSize) {
        throw new ZipBundleError('bundle exceeds 20 MB decompressed')
      }
      reservedTotal += originalSize

      if (
        compressedSize !== undefined &&
        (!Number.isSafeInteger(compressedSize) || compressedSize < 0 ||
          (originalSize > 0 && compressedSize === 0) ||
          originalSize > compressedSize * MAX_COMPRESSION_RATIO)
      ) {
        throw new ZipBundleError('bundle entry exceeds compression ratio limit')
      }
    }

    const entry: StreamedEntry = {
      rawPath: file.name,
      chunks: [],
      compressedStart: pushedCompressedBytes,
      compressedSize,
      uncompressedSize: 0,
    }
    entries.push(entry)
    file.ondata = (error, data) => {
      if (error) throw streamError ?? readableZipError()
      if (!data || data.length === 0) return
      streamedTotal += data.length
      if (streamedTotal > MAX_TOTAL_BYTES) {
        failWhileStreaming('bundle exceeds 20 MB decompressed')
      }
      entry.uncompressedSize += data.length
      if (entry.compressedSize === undefined) {
        const compressedObserved = Math.max(
          1,
          pushedCompressedBytes + activePushBytes - entry.compressedStart,
        )
        if (entry.uncompressedSize > compressedObserved * MAX_COMPRESSION_RATIO)
          failWhileStreaming('bundle entry exceeds compression ratio limit')
      }
      entry.chunks.push(data)
    }
    file.start()
  })
  unzip.register(UnzipInflate)

  try {
    for (let offset = 0; offset < bytes.length; offset += STREAM_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, bytes.length))
      activePushBytes = chunk.length
      unzip.push(chunk, offset + chunk.length === bytes.length)
      pushedCompressedBytes += chunk.length
      activePushBytes = 0
    }
  } catch (e) {
    activePushBytes = 0
    if (streamError) throw streamError
    if (e instanceof ZipBundleError) throw e
    throw readableZipError()
  }

  // Drop directories + junk, then normalize away a single shared root folder.
  const paths = entries.map((entry) => entry.rawPath)
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

  let manifest: unknown
  const files: ParsedBundle['files'] = []
  for (const entry of entries) {
    const raw = entry.rawPath
    const data = joinChunks(entry.chunks)
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

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]!
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}
