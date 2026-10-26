"use client";

import {
  ActionError,
  kindForStatus,
  transportError,
  type ActionResult,
  type FieldIssue,
} from "@braedonsaunders/appkit-errors";
import { joinRefusal } from "./refusal-sentence";

/**
 * Reading a failed API response in the browser. The status is checked FIRST:
 * a non-JSON error body (a proxy page, an empty 502) must surface the
 * fallback, never a SyntaxError from `res.json()` that hides the server's
 * status. The body is parsed only to extract a server `{ error }` message,
 * and a body that is not JSON keeps the fallback.
 *
 * Server envelopes carry the refusal in `error` (house clients), in
 * `message` (routes shared with non-browser callers), and in `detail`
 * (provider ping routes answering `{ ok: false, detail }`); an optional
 * top-level or `details.remedy` names the operator's next step and is appended so the toast
 * carries both the refusal and what to do about it. All four fields are
 * read defensively: a blank or non-string value falls through to the
 * fallback, so the caller can never toast `undefined` or an empty string.
 */
export async function readApiErrorMessage(res: Response, fallback: string): Promise<string> {
  return messageFromBody(await readErrorBody(res), res.status, fallback);
}

/**
 * A refusal the server actually answered: a non-ok status, or an ok status
 * whose body could not be read. Callers branch on this class to tell a
 * server refusal (show its message) from a network failure (fetch rejected
 * or was aborted — show the caller's own translated copy, never the
 * browser's raw "Failed to fetch"). `apiJson` and `throwApiErrorIfNotOk`
 * throw it; a rejected fetch is never wrapped in it.
 */
export class ApiResponseError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.body = body;
    const code =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { code?: unknown }).code
        : undefined;
    this.code = typeof code === "string" && code.trim() !== "" ? code : undefined;
  }
}

async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function messageFromBody(body: unknown, status: number, fallback: string): string {
  const named = readNamedRefusal(body);
  if (named) return named;
  const safeFallback = fallback.trim() !== "" ? fallback : "request failed";
  return `${safeFallback} (status ${status})`;
}

async function responseError(res: Response, fallback: string): Promise<ApiResponseError> {
  const body = await readErrorBody(res);
  return new ApiResponseError(messageFromBody(body, res.status, fallback), res.status, body);
}

function readNamedRefusal(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as {
    error?: unknown;
    message?: unknown;
    detail?: unknown;
    errors?: unknown;
    remedy?: unknown;
    details?: unknown;
    issues?: unknown;
  };
  const fields = [record.error, record.message, record.detail];
  const single =
    fields
      .find((field): field is string => typeof field === "string" && field.trim() !== "")
      ?.trim() ?? null;
  const listed = Array.isArray(record.errors)
    ? record.errors
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim())
    : [];
  const unnamed = single ?? (listed.length > 0 ? listed.join("; ") : null);
  // A schema refusal names its field so the operator knows what to correct.
  const field = issueField(record.issues);
  const refusal = unnamed && field && !unnamed.includes(field) ? `${field}: ${unnamed}` : unnamed;
  if (!refusal) return null;
  const details =
    record.details !== null && typeof record.details === "object" && !Array.isArray(record.details)
      ? (record.details as { remedy?: unknown })
      : null;
  const remedyValue =
    typeof record.remedy === "string" && record.remedy.trim() !== ""
      ? record.remedy
      : details?.remedy;
  const remedy =
    typeof remedyValue === "string" && remedyValue.trim() !== "" ? remedyValue.trim() : null;
  return joinRefusal(refusal, remedy);
}

export type ApiBulkFailure = { id: string; error: string };

export type ApiBulkItemResult = { id: string; ok: boolean; error?: unknown };

/**
 * Split a bulk selection into bounded request batches. The server refuses
 * batches over its per-request ceiling by name, so the client never sends
 * more than the ceiling per request — every requested id is attempted.
 */
export function chunkArray<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0)
    throw new Error("chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push([...values.slice(index, index + size)]);
  }
  return chunks;
}

/**
 * Reconcile requested ids against the aggregated batch results: every
 * requested id gets exactly one verdict. An id the server never answered —
 * a truncated batch, a dropped row — stays failed with the not-processed
 * message instead of vanishing from the selection as a phantom success.
 */
export function reconcileBulkResults(
  requestedIds: readonly string[],
  results: readonly ApiBulkItemResult[] | undefined,
  notProcessedMessage: string,
): ApiBulkFailure[] {
  const byId = new Map((results ?? []).map((result) => [result.id, result]));
  const failures: ApiBulkFailure[] = [];
  for (const id of requestedIds) {
    const result = byId.get(id);
    if (!result) {
      failures.push({ id, error: notProcessedMessage });
    } else if (result.ok === false) {
      failures.push({
        id,
        error:
          typeof result.error === "string" && result.error.trim() !== ""
            ? result.error.trim()
            : notProcessedMessage,
      });
    }
  }
  return failures;
}

/**
 * Per-item reasons from a bulk `{ results: [{ id, ok, error? }] }` body (see
 * the ap-capture actions route). Collapsing a partial bulk result to counts
 * ("2 of 5 failed") drops the only thing the operator can act on — the named
 * reason per item — so bulk callers render these entries, one row each.
 * Never throws: an unparseable body is zero observable failures, not a crash.
 */
export function readApiBulkFailures(body: unknown, itemFallback = "failed"): ApiBulkFailure[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const failures: ApiBulkFailure[] = [];
  for (const entry of results) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as { id?: unknown; ok?: unknown; error?: unknown };
    if (row.ok !== false) continue;
    const error =
      typeof row.error === "string" && row.error.trim() !== "" ? row.error.trim() : itemFallback;
    failures.push({ id: typeof row.id === "string" ? row.id : "", error });
  }
  return failures;
}

/**
 * The ok-check-first client mutation guard. Call it immediately after fetch
 * and BEFORE `await res.json()`: on a refusal it throws `ApiResponseError` carrying the
 * server's named message (never `Error(undefined)`, never an empty string),
 * on success it returns so the caller parses the body knowing the status is
 * 2xx. Pair every call with `finally { setBusy(false) }` — a throw here must
 * release the button, never wedge it.
 */
export async function throwApiErrorIfNotOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  throw await responseError(res, fallback);
}

/**
 * The one JSON fetch helper for browser clients. It checks the status
 * FIRST (an inline `if (!res.ok)` guard so the response-parse checker can
 * see the ordering, then `readApiErrorMessage` so a proxy page or empty
 * 502 toasts the fallback, never a SyntaxError), then parses the success
 * body as `T`. A success body that is not JSON is a broken contract, so it
 * throws the fallback with the status rather than returning `undefined`
 * the caller would treat as an empty success. Both throws are
 * `ApiResponseError`; a network failure propagates as fetch raised it, so
 * callers show their translated fallback for it rather than the browser's
 * untranslated text.
 */
export async function apiJson<T>(
  url: string,
  init?: RequestInit,
  fallbackMessage = "request failed",
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw await responseError(res, fallbackMessage);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiResponseError(messageFromBody(null, res.status, fallbackMessage), res.status);
  }
}

/**
 * Caller copy for the ActionResult refusal path. The fallback is the
 * already-localized per-action string (the same value the caller passes as
 * `fallbackMessage` to `execute`); it renders only when the body names
 * nothing usable. `codeMessage` maps a stable server `code` to localized
 * copy for code-only bodies — it wins over the fallback but loses to any
 * usable server message, which always renders verbatim.
 */
export type RefusalCopy = {
  fallback: string;
  codeMessage?: (code: string) => string | undefined;
  /**
   * Copy for a server failure that named no reason: a 5xx without a usable
   * body (a gateway page, an empty 500) and a request that never got an
   * answer. Those say nothing about the operator's entries, so this copy
   * names the failure instead of a refusal. A reason the server did name
   * always wins, and omitting this keeps the status-stamped fallback.
   */
  unavailable?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstUsableString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * The enriched refusal text for an ActionError's `serverMessage`, read from
 * a decoded refusal body. It covers every envelope the API produces: the
 * `error`/`message`/`detail` keys, a nested `{ error: { message } }` body,
 * a joined `errors` array, the schema `issues` field prefix, and the
 * `remedy`, which is appended so the toast carries both the refusal and
 * what to do about it. A code-only body resolves through the caller's
 * `codeMessage` map. Null when the body names nothing usable — the caller
 * (usually `execute` with its localized fallback) owns the last word, so
 * this helper never invents locale copy itself.
 */
export function refusalMessageFromBody(body: unknown, copy: RefusalCopy): string | null {
  const record = asRecord(body);
  if (!record) return null;
  const nested = asRecord(record.error);
  const unnamed =
    firstUsableString(record.error, record.message, record.detail, nested?.message) ??
    listedErrors(record.errors);
  const field = issueField(record.issues);
  const refusal = unnamed && field && !unnamed.includes(field) ? `${field}: ${unnamed}` : unnamed;
  if (refusal) {
    const remedy =
      typeof record.remedy === "string" && record.remedy.trim() !== ""
        ? record.remedy.trim()
        : null;
    return joinRefusal(refusal, remedy);
  }
  const code = readRefusalCode(body);
  if (code) return copy.codeMessage?.(code) ?? null;
  return null;
}

function listedErrors(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const entries = errors
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
  return entries.length > 0 ? entries.join("; ") : null;
}

/** The stable machine code when the server sent one; ActionErrors carry it for copy mapping. */
export function readRefusalCode(body: unknown): string | undefined {
  const record = asRecord(body);
  const code = record?.code;
  return typeof code === "string" && code.trim() !== "" ? code.trim() : undefined;
}

/** Structured machine evidence from a refusal body (`details`), defensively decoded. */
export function readRefusalDetails(body: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(body)?.details);
}

/** Field-level failures from a 400 body, defensively decoded: malformed entries are dropped. */
export function readRefusalIssues(body: unknown): FieldIssue[] {
  const raw = asRecord(body)?.issues;
  if (!Array.isArray(raw)) return [];
  const issues: FieldIssue[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    if (item && typeof item.path === "string" && typeof item.message === "string") {
      issues.push({ path: item.path, message: item.message });
    }
  }
  return issues;
}

/**
 * The ActionResult read for browser clients that pin refusals through
 * `useAppAction().execute`. Like the package's `readActionResult` it cannot
 * throw and trusts the status, not the body — but the refusal keeps the
 * full server vocabulary (remedy, nested error, detail, error list, code)
 * instead of only `error`/`message`, so a refusal the server explained can
 * never pin as a bare fallback. A body that names nothing usable falls back
 * to the caller's localized copy with the HTTP status (and code when the
 * server sent one), so the pin can never render blank. Pass the same
 * localized string here as `fallbackMessage` to `execute`.
 */
export async function readAppActionResult<T = unknown>(
  res: Response,
  copy: RefusalCopy,
): Promise<ActionResult<T>> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const code = readRefusalCode(body);
  const safeFallback = copy.fallback.trim() !== "" ? copy.fallback : "request failed";
  const error: DetailedActionError = new ActionError({
    kind: kindForStatus(res.status),
    status: res.status,
    code,
    issues: readRefusalIssues(body),
    serverMessage:
      refusalMessageFromBody(body, copy) ??
      (res.status >= 500 && copy.unavailable
        ? copy.unavailable
        : code
          ? `${safeFallback} (HTTP ${res.status}, ${code})`
          : `${safeFallback} (HTTP ${res.status})`),
  });
  // Structured machine evidence rides beside the refusal (never rendered by
  // the alert itself): renderers that know a details kind — a closed
  // period's scope with its reopen route — read it from here instead of
  // parsing message text.
  const details = readRefusalDetails(body);
  if (details) error.details = details;
  return { ok: false, error };
}

/**
 * An ActionError carrying the refusal body's structured evidence. Built
 * only by the app's own result readers; consumers keep treating it as an
 * ActionError and branch on `details` solely through the helpers that know
 * a details kind.
 */
export interface DetailedActionError extends ActionError {
  details?: Record<string, unknown> | null;
}

/**
 * `fetch` plus the enriched read, as one step that cannot throw. A rejected
 * fetch becomes a `transport` refusal instead of an unhandled rejection past
 * the busy reset; a resolved fetch goes through {@link readAppActionResult}.
 * Drop-in for the package's `fetchAction` wherever the refusal must carry
 * the server's remedy and code vocabulary.
 */
export async function fetchAppAction<T = unknown>(
  url: string,
  init: RequestInit | undefined,
  copy: RefusalCopy,
): Promise<ActionResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (thrown) {
    const detail = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
    const aborted = thrown instanceof DOMException && thrown.name === "AbortError";
    const error = transportError(detail, aborted);
    if (!copy.unavailable) return { ok: false, error };
    // Same classification as a transport refusal, with the connection copy
    // as its message; the transport detail stays on the error for the log.
    return {
      ok: false,
      error: new ActionError({
        kind: error.kind,
        aborted,
        detail,
        serverMessage: copy.unavailable,
      }),
    };
  }
  return readAppActionResult<T>(res, copy);
}

function issueField(issues: unknown): string | null {
  if (!Array.isArray(issues)) return null;
  const path = (issues[0] as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || path.trim() === "") return null;
  const leaf =
    path
      .split(".")
      .filter((segment) => !/^\d+$/.test(segment))
      .pop() ?? path;
  const words = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? null : words.charAt(0).toUpperCase() + words.slice(1);
}
