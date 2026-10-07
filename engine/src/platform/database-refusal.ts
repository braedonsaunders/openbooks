/** Return a database guard's authored first line, never the query wrapper or
 * driver DETAIL/HINT. Check violations are optional because an ordinary
 * constraint's generated message is not an operator-facing guard remedy. */
export function guardRefusalMessage(
  error: unknown,
  options: { includeRaisedCheckViolations?: boolean } = {},
): string | undefined {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const level = current as { code?: unknown; routine?: unknown; message?: unknown; cause?: unknown };
    if (level.code === "P0001" || (options.includeRaisedCheckViolations === true
      && level.code === "23514" && level.routine === "exec_stmt_raise")) {
      const firstLine = typeof level.message === "string" ? level.message.split("\n", 1)[0]?.trim() : undefined;
      if (firstLine) return firstLine;
    }
    current = level.cause;
  }
  return undefined;
}
