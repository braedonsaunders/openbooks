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
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const named = readNamedRefusal(body)
  if (named) return named
  const safeFallback = fallback.trim() !== '' ? fallback : 'request failed'
  return `${safeFallback} (status ${res.status})`
}

function readNamedRefusal(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const record = body as { error?: unknown; message?: unknown; detail?: unknown; remedy?: unknown }
  const fields = [record.error, record.message, record.detail]
  const refusal =
    fields.find((field): field is string => typeof field === 'string' && field.trim() !== '')?.trim() ??
    null
  if (!refusal) return null
  const remedy =
    typeof record.remedy === 'string' && record.remedy.trim() !== '' ? record.remedy.trim() : null
  return remedy ? `${refusal} — ${remedy}` : refusal
}

export type ApiBulkFailure = { id: string; error: string }

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
 * and BEFORE `await res.json()`: on a refusal it throws `Error` carrying the
 * server's named message (never `Error(undefined)`, never an empty string),
 * on success it returns so the caller parses the body knowing the status is
 * 2xx. Pair every call with `finally { setBusy(false) }` — a throw here must
 * release the button, never wedge it.
 */
export async function throwApiErrorIfNotOk(res: Response, fallback: string): Promise<void> {
  if (res.ok) return
  throw new Error(await readApiErrorMessage(res, fallback))
}
