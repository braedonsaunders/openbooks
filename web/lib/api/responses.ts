import { NextResponse } from "next/server";

/**
 * The one response vocabulary for factory routes (`defineRoute` in
 * `./route.ts`). Every refusal shares the body shape
 * `{ error, code?, field?, fieldErrors?, remedy? }` so clients read one
 * contract: `error` always names the condition, and a refusal that can be
 * acted on also names its `remedy`.
 *
 * 404s never name what was probed: an absent record, another org's row, and
 * an out-of-scope row all answer `{ error: "not_found" }`, so callers cannot
 * oracle hidden rows through existence.
 */

export interface ApiErrorBody {
  error: string;
  code?: string;
  field?: string;
  fieldErrors?: Record<string, string[]>;
  remedy?: string;
}

/**
 * Uniform 404. `kind` (for example "account") and `id` exist so call sites
 * read precisely; neither reaches the body, which stays `{ error:
 * "not_found" }` in every case so a probe learns nothing.
 */
export function notFound(kind: string, id?: string): NextResponse {
  void kind;
  void id;
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export interface UnprocessableOptions {
  field?: string;
  fieldErrors?: Record<string, string[]>;
  /**
   * Unprocessable defaults to 422 (the request was well-formed but the
   * domain refuses it). The one exception is a malformed idempotency key:
   * the key travels in a header, outside any body the 422 could point at,
   * so those refusals pass `{ status: 400 }` with code
   * `invalid_idempotency_key` instead.
   */
  status?: 400 | 422;
}

/**
 * Domain refusal for a well-formed request the business rules reject
 * (`invalid_type`, `name_required`, `invalid_idempotency_key` at 400).
 * `field` pins the offending input; `fieldErrors` carries per-field detail
 * for form rendering.
 */
export function unprocessable(error: string, opts?: UnprocessableOptions): NextResponse {
  const body: ApiErrorBody = { error };
  if (opts?.field !== undefined) body.field = opts.field;
  if (opts?.fieldErrors !== undefined) body.fieldErrors = opts.fieldErrors;
  return NextResponse.json(body, { status: opts?.status ?? 422 });
}

export interface ConflictOptions {
  field?: string;
  /**
   * What the caller does next. Every create drawer mints a fresh
   * idempotency key per mount, so a conflicted retry names reopening the
   * drawer — and that remedy exists in code.
   */
  remedy?: string;
}

/**
 * State conflict: a retried write whose key cannot replay
 * (`idempotency_key_conflict`), a stale revision, a duplicate number. The
 * code travels in `error` itself, so a 409 body deep-equals
 * `{ error: <code> }` exactly like the hand-rolled refusals it replaces.
 */
export function conflict(code: string, opts?: ConflictOptions): NextResponse {
  const body: ApiErrorBody = { error: code };
  if (opts?.field !== undefined) body.field = opts.field;
  if (opts?.remedy !== undefined) body.remedy = opts.remedy;
  return NextResponse.json(body, { status: 409 });
}

/** Idempotent-create success: 201 with the created payload. */
export function created(body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status: 201 });
}
