/** Read the named refusal out of a failed analytics fetch.
 *
 * Analytics routes emit `{error: message}` (see `web/lib/api/error-response.ts`
 * `apiErrorResponse`); surfacing only the HTTP status turns a named 422
 * ("no spot rate for EUR to USD on or before DATE") into a generic load
 * failure. Falls back to the status when the body is unreadable or carries
 * no message.
 */
export async function refusalMessage(res: Response, fallback = `HTTP ${res.status}`): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return typeof body?.error === 'string' && body.error ? body.error : fallback
  } catch {
    return fallback
  }
}
