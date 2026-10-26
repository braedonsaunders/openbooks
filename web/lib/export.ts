import "server-only";
import { NextResponse } from "next/server";

/**
 * Stream a generated PDF inline (browser preview) with a download filename.
 * `nosniff` holds the browser to the declared PDF type, so the bytes are
 * never re-interpreted as active content on the app origin.
 */
export function pdfResponse(pdf: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition("inline", filename, "pdf"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

/** Stream an .xlsx workbook as an attachment. */
export function xlsxResponse(xlsx: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(xlsx), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": contentDisposition("attachment", filename, "xlsx"),
      "Cache-Control": "no-store",
    },
  });
}

/** Stream a JSON document as an attachment (structured tax-return export etc.). */
export function jsonResponse(json: string, filename: string): NextResponse {
  return new NextResponse(new TextEncoder().encode(json), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": contentDisposition("attachment", filename, "json"),
      "Cache-Control": "no-store",
    },
  });
}

/** Stream CSV (UTF-8, with BOM for Excel) as an attachment. */
export function csvResponse(csv: string, filename: string): NextResponse {
  const body = new TextEncoder().encode(`\uFEFF${csv}`);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition("attachment", filename, "csv"),
      "Cache-Control": "no-store",
    },
  });
}

/** A safe, slug-ish download filename (no path separators / quotes). */
export function safeName(name: string): string {
  return name
    .replace(/[/\\]/g, "-")
    .replace(/[",]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * A report export's download name: the report slug and the date its figures
 * stand on — the as-of date of a point-in-time report (a cap table as of
 * 2025-10-01 is named for 2025-10-01, whenever it is exported), otherwise the
 * business date it was produced on.
 */
export function reportExportFilename(
  slug: string,
  dates: { asOf?: string | null; producedOn: string },
): string {
  return `${safeName(slug)}-${dates.asOf || dates.producedOn}`;
}

/** RFC 5987 filename with a header-safe ASCII fallback for Web Headers. */
export function contentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
  extension: string,
): string {
  const base = safeName(filename) || "export";
  const full = `${base}.${extension}`;
  const asciiBase =
    base
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "export";
  const encoded = encodeURIComponent(full.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
  return `${disposition}; filename="${asciiBase}.${extension}"; filename*=UTF-8''${encoded}`;
}

/**
 * The same header for a stored or generated file whose name already carries
 * its extension (bank files, filings, labels, employee documents). Stored
 * names are user- or provider-influenced, so quotes, backslashes, path
 * separators and control characters never reach the header; the full UTF-8
 * name travels in RFC 5987 `filename*`.
 */
export function fileContentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  const full =
    filename
      .replace(/[/\\]/g, "-")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "download";
  const ascii =
    full
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\]/g, "")
      .trim() || "download";
  const encoded = encodeURIComponent(full.replace(/[\uD800-\uDFFF]/g, "\uFFFD")).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
