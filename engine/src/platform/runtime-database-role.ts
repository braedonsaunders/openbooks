/**
 * The SUPERUSER / BYPASSRLS startup check runs unless the operator named a
 * local environment. Unset NODE_ENV is unknown — fail closed and check.
 * Dockerfile sets NODE_ENV=production; `next dev` sets development; the
 * test runner sets test. A hand-run script with nothing set is the hole.
 */
export function runtimeDatabaseRoleCheckRequired(
  nodeEnv: string | undefined,
): boolean {
  return nodeEnv !== "development" && nodeEnv !== "test";
}
