/**
 * Structured load-models failures. The provider SDKs throw errors whose
 * messages embed the raw upstream body (`401 Unauthorized — {"type":"error",
 * …}`) — rendering that verbatim leaks JSON blobs into the settings UI
 * (F-t11-004). The route classifies with this helper and returns a code; the
 * form renders the localized message. Deliberately free of `server-only` so
 * the contract is unit-testable.
 */

export function classifyModelsError(error: unknown): { code: 'unauthorized' | 'failed'; status: number | null } {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = /^\s*(\d{3})\b/.exec(message)?.[1];
  const statusCode = status ? Number(status) : null;
  if (statusCode === 401 || statusCode === 403) return { code: 'unauthorized', status: statusCode };
  return { code: 'failed', status: null };
}
