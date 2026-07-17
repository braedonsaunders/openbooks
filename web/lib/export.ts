import 'server-only'
import { NextResponse } from 'next/server'

/** Stream a generated PDF inline (browser preview) with a download filename. */
export function pdfResponse(pdf: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition('inline', filename, 'pdf'),
      'Cache-Control': 'no-store',
    },
  })
}

/** Stream an .xlsx workbook as an attachment. */
export function xlsxResponse(xlsx: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(xlsx), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition('attachment', filename, 'xlsx'),
      'Cache-Control': 'no-store',
    },
  })
}

/** Stream CSV (UTF-8, with BOM for Excel) as an attachment. */
export function csvResponse(csv: string, filename: string): NextResponse {
  const body = new TextEncoder().encode(`\uFEFF${csv}`)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition('attachment', filename, 'csv'),
      'Cache-Control': 'no-store',
    },
  })
}

/** A safe, slug-ish download filename (no path separators / quotes). */
export function safeName(name: string): string {
  return name
    .replace(/[/\\]/g, '-')
    .replace(/[",]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** RFC 5987 filename with a header-safe ASCII fallback for Web Headers. */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  filename: string,
  extension: string,
): string {
  const base = safeName(filename) || 'export'
  const full = `${base}.${extension}`
  const asciiBase = base
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'export'
  const encoded = encodeURIComponent(full.replace(/[\uD800-\uDFFF]/g, '\uFFFD'))
  return `${disposition}; filename="${asciiBase}.${extension}"; filename*=UTF-8''${encoded}`
}
