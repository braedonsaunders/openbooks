/**
 * The SUPERUSER / BYPASSRLS startup check runs unless the operator named a
 * local environment. Unset NODE_ENV is unknown — fail closed and check.
 * Dockerfile sets NODE_ENV=production; `next dev` sets development; the
 * test runner sets test. A hand-run script with nothing set is the hole.
 *
 * The predicates below are the single shared definition of "explicit local
 * environment" for the platform: db-environment.ts keys its repo-.env
 * fallback on the same unknown-means-remote rule, so a hand-run script can
 * never silently inherit developer-local database configuration.
 */

/** Explicitly local runtimes: development or test. Anything else — including
 * unset or empty — is an unknown environment and fails closed. */
export function isExplicitLocalEnvironment(
  nodeEnv: string | undefined,
): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}

/** The only runtime that reads developer-local service configuration from
 * the repo .env file. Test processes never read it (see db-environment.ts);
 * every other environment must supply its endpoints explicitly. */
export function readsLocalEnvFile(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}

export function runtimeDatabaseRoleCheckRequired(
  nodeEnv: string | undefined,
): boolean {
  return !isExplicitLocalEnvironment(nodeEnv);
}
