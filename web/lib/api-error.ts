'use client'

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
 * `remedy` names the operator's next step and is appended so the toast
 * carries both the refusal and what to do about it. All four fields are
 * read defensively: a blank or non-string value falls through to the
 * fallback, so the caller can never toast `undefined` or an empty string.
 */
export async function readApiErrorMessage(res: Response, fallback: string): Promise<string> {
  return messageFromBody(await readErrorBody(res), res.status, fallback)
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
  readonly status: number
  readonly code: string | undefined
  readonly body: unknown

  constructor(message: string, status: number, body: unknown = null) {
    super(message)
    this.name = 'ApiResponseError'
    this.status = status
    this.body = body
    const code =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as { code?: unknown }).code
        : undefined
    this.code = typeof code === 'string' && code.trim() !== '' ? code : undefined
  }
}

async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function messageFromBody(body: unknown, status: number, fallback: string): string {
  const named = readNamedRefusal(body)
  if (named) return named
  const safeFallback = fallback.trim() !== '' ? fallback : 'request failed'
  return `${safeFallback} (status ${status})`
}

async function responseError(res: Response, fallback: string): Promise<ApiResponseError> {
  const body = await readErrorBody(res)
  return new ApiResponseError(messageFromBody(body, res.status, fallback), res.status, body)
}

function readNamedRefusal(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as {
    error?: unknown
    message?: unknown
    detail?: unknown
    errors?: unknown
    remedy?: unknown
  }
  const fields = [record.error, record.message, record.detail]
  const single =
    fields.find((field): field is string => typeof field === 'string' && field.trim() !== '')?.trim() ??
    null
  const listed = Array.isArray(record.errors)
    ? record.errors
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        .map((entry) => entry.trim())
    : []
  const refusal = single ?? (listed.length > 0 ? listed.join('; ') : null)
  if (!refusal) return null
  const remedy =
    typeof record.remedy === 'string' && record.remedy.trim() !== '' ? record.remedy.trim() : null
  return remedy ? `${refusal} — ${remedy}` : refusal
}

export type ApiBulkFailure = { id: string; error: string }

export type ApiBulkItemResult = { id: string; ok: boolean; error?: unknown }

/**
 * Split a bulk selection into bounded request batches. The server refuses
 * batches over its per-request ceiling by name, so the client never sends
 * more than the ceiling per request — every requested id is attempted.
 */
export function chunkArray<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error('chunk size must be a positive integer')
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push([...values.slice(index, index + size)])
  }
  return chunks
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
  const byId = new Map((results ?? []).map((result) => [result.id, result]))
  const failures: ApiBulkFailure[] = []
  for (const id of requestedIds) {
    const result = byId.get(id)
    if (!result) {
      failures.push({ id, error: notProcessedMessage })
    } else if (result.ok === false) {
      failures.push({
        id,
        error:
          typeof result.error === 'string' && result.error.trim() !== ''
            ? result.error.trim()
            : notProcessedMessage,
      })
    }
  }
  return failures
}

/**
 * Per-item reasons from a bulk `{ results: [{ id, ok, error? }] }` body (see
 * the ap-capture actions route). Collapsing a partial bulk result to counts
 * ("2 of 5 failed") drops the only thing the operator can act on — the named
 * reason per item — so bulk callers render these entries, one row each.
 * Never throws: an unparseable body is zero observable failures, not a crash.
 */
export function readApiBulkFailures(body: unknown, itemFallback = 'failed'): ApiBulkFailure[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return []
  const results = (body as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  const failures: ApiBulkFailure[] = []
  for (const entry of results) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as { id?: unknown; ok?: unknown; error?: unknown }
    if (row.ok !== false) continue
    const error =
      typeof row.error === 'string' && row.error.trim() !== '' ? row.error.trim() : itemFallback
    failures.push({ id: typeof row.id === 'string' ? row.id : '', error })
  }
  return failures
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
  if (res.ok) return
  throw await responseError(res, fallback)
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
export async function apiJson<T>(url: string, init?: RequestInit, fallbackMessage = 'request failed'): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw await responseError(res, fallbackMessage)
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiResponseError(messageFromBody(null, res.status, fallbackMessage), res.status)
  }
}
