import { NextResponse } from 'next/server'

/**
 * A file blob ready to serve. `versionId` identifies the immutable
 * file_versions row the bytes came from — a version's bytes never change
 * (append-only versioning), so it is a strong ETag validator.
 */
export interface ServableBlob {
  filename: string
  contentType: string
  bytes: Buffer
  versionId: string
}

/**
 * Build a cache-friendly `inline` response for a file blob, with a conditional
 * (304) fast path so reopening a flyout — or an `<img>`/`<iframe>` re-render —
 * never re-downloads bytes the browser already holds.
 *
 * - ETag is the immutable version id.
 * - `immutable: true` (a specific version was pinned via ?versionId=) caches
 *   hard for a year — that URL can never point at different bytes.
 * - Otherwise the URL tracks the file's current version, so it is served
 *   `no-cache`: the browser revalidates and gets a tiny 304 when unchanged, but
 *   a Replace is picked up immediately (new version id → new ETag → 200).
 *
 * `X-Content-Type-Options: nosniff` prevents the browser re-interpreting the
 * bytes as a different, executable type. The filename is sanitized for header
 * safety (control chars, quotes, backslashes, non-ASCII stripped) with the
 * original UTF-8 name carried in RFC 5987 `filename*`.
 */
export function blobResponse(
  req: Request,
  blob: ServableBlob,
  opts: { immutable?: boolean; fallbackName?: string } = {},
): NextResponse {
  const etag = `"${blob.versionId}"`
  const cacheControl = opts.immutable
    ? 'private, max-age=31536000, immutable'
    : 'private, no-cache'

  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } })
  }

  const asciiName =
    blob.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() ||
    (opts.fallbackName ?? 'file')
  const utf8Name = encodeURIComponent(blob.filename)
  const body = new Uint8Array(blob.bytes)

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': blob.contentType,
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': cacheControl,
      ETag: etag,
    },
  })
}
