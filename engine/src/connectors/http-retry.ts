/**
 * Shared bounded-retry fetch for connector API clients (QBO, and any future
 * adopter — Xero, Dynamics, and NetSuite keep their own equivalent loops).
 *
 * A bare fetch has no per-attempt timeout, so a stalled socket hangs
 * forever; and a 429/5xx answered once is usually transient. Every attempt
 * races a socket deadline, 429s honor Retry-After, 5xx and network errors
 * retry with backoff, and exhaustion refuses BY NAME with the last cause.
 * Redirect refusals are deterministic — never followed, never retried —
 * so credential-bearing calls keep their exactly-once request shape.
 */

/** Per-attempt socket deadline when the caller names none (the Xero shape). */
export const CONNECTOR_DEFAULT_TIMEOUT_MS = 30_000;
/** Total attempts including the first (the Xero shape). */
export const CONNECTOR_DEFAULT_MAX_ATTEMPTS = 4;

export interface ConnectorRetryOptions {
  /** Per-attempt socket deadline in milliseconds. */
  timeoutMs?: number;
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Names the connector in the exhaustion refusal, e.g. "QBO". */
  describe: string;
  /** Test transport; production callers use the shared pinned guard. */
  transport?: typeof fetch;
}

/**
 * A redirect answered where none may be followed: deterministic, surfaced
 * at once, never retried. Carries the request URL (always an allowlisted
 * connector origin — never the redirect target) and chains the fetch
 * rejection underneath.
 */
export class ConnectorRedirectRefused extends Error {
  constructor(describe: string, url: string | URL, cause: unknown) {
    super(
      `${describe} refused a redirect for ${String(url)} — connectors never follow redirects; fix the endpoint configuration`,
      { cause },
    );
    this.name = "ConnectorRedirectRefused";
  }
}

/**
 * A rejection whose cause chain names a redirect (undici surfaces
 * redirect:"error" as `TypeError: fetch failed` caused by an
 * "unexpected redirect" error). Deterministic — retrying it would only
 * re-hit the same Location.
 */
function isRedirectRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current != null; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (/redirect/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function retryDelayMs(res: Response, attempt: number): number {
  // Header lookup is case-insensitive; a missing or non-positive
  // Retry-After falls back to linear backoff.
  const retryAfter = Number(res.headers.get("Retry-After"));
  return retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
}

export async function fetchWithConnectorRetry(
  url: string | URL,
  init: RequestInit,
  opts: ConnectorRetryOptions,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_DEFAULT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? CONNECTOR_DEFAULT_MAX_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // A caller-supplied signal stays in charge alongside the deadline.
    const onExternalAbort = () => ctrl.abort();
    if (init.signal?.aborted) ctrl.abort();
    else init.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const res = await (opts.transport ?? guardedFetch)(url, { ...init, signal: ctrl.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res, attempt)));
        continue;
      }
      return res;
    } catch (error) {
      if (isRedirectRefusal(error)) throw new ConnectorRedirectRefused(opts.describe, url, error);
      lastErr = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
  const cause = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `${opts.describe} request failed after ${maxAttempts} attempts: ${cause} — retry, and ask your administrator if it persists`,
  );
}
import { guardedFetch } from "./ssrf-guard.ts";
