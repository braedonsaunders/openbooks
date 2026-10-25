import { NextResponse } from "next/server";
import { capBodyStream } from "../bounded-body";
import { formatByteLimit, type ParsedBody } from "./json";

/**
 * The multipart twin of parseJsonBody for upload routes.
 *
 *   const parsed = await parseFormDataBody(req, { maxBodyBytes: MAX_BYTES + MULTIPART_FRAMING_BYTES });
 *   if (!parsed.ok) return parsed.response;
 *   const file = parsed.data.get("file");
 *
 * `Request.formData()` buffers the whole body before a route can inspect a
 * single file, so a per-file size check alone does not bound memory. This
 * parser counts the actual streamed bytes and refuses with 413 as soon as the
 * request crosses its ceiling, before the remainder is read. Routes keep their
 * per-file checks; this ceiling bounds the request as a whole.
 */

/**
 * Allowance for multipart boundaries, part headers and small text fields on
 * top of the file bytes a route accepts.
 */
export const MULTIPART_FRAMING_BYTES = 64 * 1024;

const EXPECTED_MULTIPART = "expected multipart/form-data";

export async function parseFormDataBody(
  req: Request,
  opts: {
    maxBodyBytes: number;
    /** Route-specific 400 body for a missing or malformed multipart payload. */
    invalid?: Record<string, string>;
    /** Route-specific 413 body; defaults to the house byte-limit message. */
    tooLarge?: Record<string, string>;
  },
): Promise<ParsedBody<FormData>> {
  const tooLarge = (): ParsedBody<FormData> => {
    const error = `request body exceeds the ${formatByteLimit(opts.maxBodyBytes)} limit`;
    return {
      ok: false,
      response: NextResponse.json(opts.tooLarge ?? { error, message: error }, { status: 413 }),
    };
  };
  const invalid = (): ParsedBody<FormData> => ({
    ok: false,
    response: NextResponse.json(opts.invalid ?? { error: EXPECTED_MULTIPART }, { status: 400 }),
  });

  const capped = capBodyStream(req, opts.maxBodyBytes);
  if (!capped.ok) return tooLarge();
  const contentType = req.headers.get("content-type") ?? "";
  if (!capped.stream || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    await capped.stream?.cancel().catch(() => undefined);
    return invalid();
  }
  try {
    const form = await new Response(capped.stream, {
      headers: { "content-type": contentType },
    }).formData();
    return { ok: true, data: form };
  } catch {
    return capped.exceeded() ? tooLarge() : invalid();
  }
}
