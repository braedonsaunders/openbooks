import { NextResponse } from "next/server";
import { CommerceError } from "@openbooks/engine/commerce/contracts";
import { PostingError } from "@openbooks/engine/src/journal/posting-contracts.ts";
import { InventoryError } from "@openbooks/engine/src/inventory/contracts.ts";
import { PaymentError } from "@openbooks/engine/src/payments-core/payment-errors.ts";
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import { TemporalError } from "@openbooks/engine/src/hrm/temporal.ts";
import { PostingEffectsReplayError } from "@openbooks/engine/documents/posting-effects-errors";

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

/**
 * One table for the engine refusal families that carry no HTTP status:
 * posting, closed-period, inventory, payment, payroll, and temporal
 * refusals. A family member escaping a handler answers 422 with
 * `{ error: message, code, remedy? }` — never a 500, never a stack — and
 * 409 when it names a conflict. Handlers still map authorization and
 * not-found conditions explicitly (403/404) before this backstop runs:
 * those name who may act or what exists, which a domain code must not.
 */
interface RefusalFamily {
  match: (error: object) => boolean;
  code: string;
  pinCode: boolean;
}

const REFUSAL_FAMILIES: RefusalFamily[] = [
  { match: (error) => error instanceof CommerceError, code: "commerce_refused", pinCode: false },
  { match: (error) => error instanceof PostingEffectsReplayError, code: "posting_effects_replay_refused", pinCode: true },
  { match: (error) => error instanceof PostingError, code: "posting_refused", pinCode: false },
  { match: (error) => error instanceof InventoryError, code: "inventory_refused", pinCode: false },
  { match: (error) => error instanceof PaymentError, code: "payment_refused", pinCode: false },
  { match: (error) => error instanceof PayrollError, code: "payroll_refused", pinCode: false },
  { match: (error) => error instanceof TemporalError, code: "temporal_refused", pinCode: false },
];

const CONFLICT_RE = /conflict/i;

function refusalConflicts(error: Error): boolean {
  const record = error as unknown as Record<string, unknown>;
  if (record["status"] === 409 || record["statusCode"] === 409) return true;
  if (typeof record["code"] === "string" && CONFLICT_RE.test(record["code"])) return true;
  return CONFLICT_RE.test(error.constructor.name);
}

/**
 * Map one status-less engine refusal to its 4xx, or null when the error
 * belongs to no family (the caller tries the next mapping). `code` comes
 * from the instance when it carries one, else the family default;
 * `remedy` rides along only when the instance names one, so internal
 * evidence (stacks, audit images) never leaks into the body.
 */
export function postingRefusal(error: unknown): NextResponse | null {
  if (!(error instanceof Error)) return null;
  const family = REFUSAL_FAMILIES.find((entry) => entry.match(error));
  if (!family) return null;
  const record = error as unknown as Record<string, unknown>;
  const body: ApiErrorBody = { error: error.message };
  const code = record["code"];
  if (family.pinCode || typeof code !== "string") {
    body.code = family.code;
  } else {
    body.code = code;
  }
  const remedy = record["remedy"];
  if (typeof remedy === "string") body.remedy = remedy;
  return NextResponse.json(body, { status: refusalConflicts(error) ? 409 : 422 });
}
