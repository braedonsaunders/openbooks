/** Database libraries wrap the server refusal in a query error. A negative
 * control must assert the actual refusal, not only the outer SQL message. */
export function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}
