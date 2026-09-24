type ErrorPayload = { error?: unknown }

/**
 * Operator-locale messages for the refusals below. The console renders in
 * the operator locale (sections.tsx passes its `t('errors.*')` keys), so
 * the helper takes the wording as arguments and never hardcodes English.
 */
export interface QueryResponseMessages {
  /** Named message for an empty body, e.g. `t('errors.emptyResponse', { status })`. */
  emptyResponse: (status: number) => string
  /** Named message for a non-JSON or non-object body. */
  invalidResponse: (status: number) => string
}

/**
 * Decode a query-console API response without assuming Next returned JSON.
 * Development compiler failures, reverse proxies, and aborted responses can
 * otherwise surface the browser's opaque `Unexpected end of JSON input` error.
 */
export async function readQueryResponse<T extends object>(
  response: Response,
  messages: QueryResponseMessages,
): Promise<T> {
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(messages.emptyResponse(response.status))
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(messages.invalidResponse(response.status))
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(messages.invalidResponse(response.status))
  }
  return payload as T
}

/**
 * The server's named refusal wins; the injected fallback (a translated
 * `t('errors.requestFailed', { status })`) covers a body with no usable
 * error, so the operator never sees `undefined` or a bare status code.
 */
export function queryResponseError(payload: ErrorPayload, status: number, fallback: string): string {
  return typeof payload.error === 'string' && payload.error.trim()
    ? payload.error
    : fallback
}
