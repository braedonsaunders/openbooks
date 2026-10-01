import { NextResponse } from "next/server";
import { z } from "zod";
import { readBoundedBodyText } from "../bounded-body";

/**
 * The one zod boundary for JSON request bodies in API routes.
 *
 *   const parsed = await parseJsonBody(req, bodySchema);
 *   if (!parsed.ok) return parsed.response;
 *   // parsed.data is fully typed + validated from here on.
 *
 * Malformed JSON and non-object payloads fail closed as 400. A well-formed
 * object that fails its route schema retains the established 400 default,
 * or a caller's explicit status, with the first issue message and an
 * `issues` array for field-level UI rendering.
 */

export interface BodyIssue {
  path: string;
  message: string;
}

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

const INVALID_BODY = "invalid request body";

/**
 * Default ceiling on a JSON request body, enforced while READING THE ACTUAL
 * STREAM (see readBoundedBodyText) — a chunked upload with no Content-Length,
 * or a lying one, is still refused at this many bytes. 1 MiB matches the
 * application-command route's own reader and the tax-provider response cap:
 * generous for forms, filters and single records. Routes that legitimately
 * carry file bytes or bulk rows (bank statements, data imports, budget
 * imports) pass an explicit maxBodyBytes instead.
 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

function formatByteLimit(maxBytes: number): string {
  if (Number.isSafeInteger(maxBytes) && maxBytes % (1024 * 1024) === 0) {
    return `${maxBytes / (1024 * 1024)} MiB`;
  }
  if (Number.isSafeInteger(maxBytes) && maxBytes % 1024 === 0) {
    return `${maxBytes / 1024} KiB`;
  }
  return `${maxBytes} bytes`;
}

export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts?: { status?: number; maxBodyBytes?: number },
): Promise<ParsedBody<z.output<S>>> {
  // The declared Content-Length is sender-controlled and absent on chunked
  // uploads, so it can only ever justify an early refusal — never acceptance
  // (see bounded-body.ts). The cap below is enforced on the streamed bytes.
  const maxBodyBytes = opts?.maxBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const bounded = await readBoundedBodyText(req, maxBodyBytes);
  if (!bounded.ok) {
    if (bounded.reason === "too_large") {
      // Both keys on purpose: house clients read `error`, while non-ok
      // responses to browser dialogs (e.g. the issue reporter) surface
      // `message` — a bare status would read as a generic failure.
      const error = `request body exceeds the ${formatByteLimit(maxBodyBytes)} limit`;
      return {
        ok: false,
        response: NextResponse.json({ error, message: error }, { status: 413 }),
      };
    }
    return {
      ok: false,
      response: NextResponse.json({ error: INVALID_BODY }, { status: 400 }),
    };
  }
  if (bounded.text === "") {
    const parsed = schema.safeParse(undefined);
    if (parsed.success) return { ok: true, data: parsed.data };
    return {
      ok: false,
      response: NextResponse.json({ error: INVALID_BODY }, { status: 400 }),
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bounded.text) as unknown;
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: INVALID_BODY }, { status: 400 }),
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      response: NextResponse.json({ error: INVALID_BODY }, { status: 400 }),
    };
  }
  return validateJsonBody(raw, schema, opts);
}

/** Validate an already-decoded JSON object using the same response contract. */
export function validateJsonBody<S extends z.ZodType>(
  raw: unknown,
  schema: S,
  opts?: { status?: number },
): ParsedBody<z.output<S>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues: BodyIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    return {
      ok: false,
      response: NextResponse.json(
        { error: issues[0]?.message ?? INVALID_BODY, issues },
        { status: opts?.status ?? 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data };
}


export * from "./json-schema";
