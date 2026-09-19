'use client'

/**
 * Reading a failed API response in the browser. The status is checked FIRST:
 * a non-JSON error body (a proxy page, an empty 502) must surface the
 * fallback, never a SyntaxError from `res.json()` that hides the server's
 * status. The body is parsed only to extract a server `{ error }` message,
 * and a body that is not JSON keeps the fallback.
 */
export async function readApiErrorMessage(res: Response, fallback: string): Promise<string> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string' && error.trim() !== '') return error
  }
  return `${fallback} (status ${res.status})`
}
