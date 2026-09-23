'use client'

import { readApiErrorMessage } from './api-error'

/**
 * Shared fetch-download-announce for every report export menu (UX-16b).
 *
 * Report exports used to render as bare `<a href>` download links, so the app
 * could observe neither success nor a server refusal: a 200 downloaded
 * silently and a 4xx/5xx downloaded an error body (or navigated away). Every
 * export menu must go through {@link downloadExportFile} instead: the file is
 * fetched first, and ONLY after the bytes arrive is the download triggered
 * (object URL + download attribute with the server's filename) and the
 * filename returned so the caller can announce completion. A non-OK response
 * throws the server's named error message when the body is JSON, otherwise a
 * generic failure message. Success is never announced optimistically.
 */
export function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (disposition) {
    // The RFC 5987 starred parameter carries the real (possibly non-ASCII)
    // name; the plain parameter is its ASCII fallback. Prefer the real name.
    const extended = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1]
    if (extended) {
      try {
        return decodeURIComponent(extended)
      } catch {
        return extended
      }
    }
    const quoted = /filename="([^"]+)"/.exec(disposition)?.[1]
    if (quoted) return quoted
    const bare = /filename=([^;\s]+)/i.exec(disposition)?.[1]?.trim()
    if (bare) return bare
  }
  return fallback
}

export async function downloadExportFile(
  url: string,
  init: RequestInit | undefined,
  opts: { fallbackFilename: string; failedMessage: string },
): Promise<string> {
  // The status is checked FIRST: a refusal must surface the server's message,
  // never a download of an error body.
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(await readApiErrorMessage(res, opts.failedMessage))
  const blob = await res.blob()
  const filename = filenameFromDisposition(res.headers.get('Content-Disposition'), opts.fallbackFilename)
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
  // Completion is claimed only now: the bytes arrived and the download
  // started, with the real filename.
  return filename
}
