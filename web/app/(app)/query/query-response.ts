type ErrorPayload = { error?: unknown }

/**
 * Decode a query-console API response without assuming Next returned JSON.
 * Development compiler failures, reverse proxies, and aborted responses can
 * otherwise surface the browser's opaque `Unexpected end of JSON input` error.
 */
export async function readQueryResponse<T extends object>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(`Query service returned an empty response (HTTP ${response.status})`)
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`Query service returned an invalid response (HTTP ${response.status})`)
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Query service returned an invalid response (HTTP ${response.status})`)
  }
  return payload as T
}

export function queryResponseError(payload: ErrorPayload, status: number): string {
  return typeof payload.error === 'string' && payload.error.trim()
    ? payload.error
    : `Query request failed (HTTP ${status})`
}
