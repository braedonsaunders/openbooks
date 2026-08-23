import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeMoney } from "@openbooks/engine/src/money.ts";
import { canonicalDecimal } from "../exact-decimal";
import { isUuid } from "../list-params";

/**
 * The one zod boundary for JSON request bodies in API routes.
 *
 *   const parsed = await parseJsonBody(req, bodySchema);
 *   if (!parsed.ok) return parsed.response;
 *   // parsed.data is fully typed + validated from here on.
 *
 * Malformed JSON, non-object payloads, and schema failures all fail closed as
 * 400 with the first issue message (plus an `issues` array for field-level
 * UI rendering) — a route never sees unvalidated input shape again.
 */

export interface BodyIssue {
  path: string;
  message: string;
}

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; response: NextResponse };

const INVALID_BODY = "invalid request body";

export async function parseJsonBody<S extends z.ZodType>(
  req: Request,
  schema: S,
  opts?: { status?: number },
): Promise<ParsedBody<z.output<S>>> {
  const raw: unknown = await req.json().catch(() => undefined);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      response: NextResponse.json({ error: INVALID_BODY }, { status: opts?.status ?? 400 }),
    };
  }
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

/**
 * Boundary atoms for financial bodies. Money crosses the wire as decimal text
 * or as a safe integer JSON number and is canonicalized through the
 * exact-decimal primitives. Fractional JSON numbers are refused because they
 * have already crossed IEEE-754 before zod can inspect them.
 */

/** Exact numeric(19,4)-scale money string ("1234.5", "-10", "0.0001"). */
export function exactMoney(message = "must be a decimal string or safe integer monetary amount") {
  return z
    .preprocess(
      // Absent/null amounts funnel through the same refusal as junk input,
      // so a required-money field always fails with the caller's message.
      (v) => (v === undefined || v === null ? "" : v),
      z.unknown()
        .refine((v) => toExactMoney(v) !== null, message)
        .transform((v) => toExactMoney(v)!),
    );
}

function toExactMoney(v: unknown): string | null {
  if (typeof v !== "string" && (typeof v !== "number" || !Number.isSafeInteger(v))) {
    return null;
  }
  const exact = canonicalDecimal(v, 4);
  if (exact === null) return null;
  try {
    return normalizeMoney(exact);
  } catch {
    return null;
  }
}

const UUID_MESSAGE = "must be a valid id";

/** A tenant-entity uuid reference. */
export const uuidId = z.string().refine(isUuid, UUID_MESSAGE);

/** Optional nullable uuid reference (null clears the reference). */
export const nullableUuidId = z
  .union([z.string(), z.null()])
  .refine((v) => v === null || isUuid(v), UUID_MESSAGE);

/** Calendar date (YYYY-MM-DD), matching every document-date column. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(message = "must be YYYY-MM-DD") {
  return z.string({ error: message }).regex(ISO_DATE_RE, message);
}
