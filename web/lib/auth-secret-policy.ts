/**
 * Fail closed when the authentication signing key is absent or obviously weak.
 * Entropy cannot be proven from a supplied string, but production-like
 * deployments can enforce a useful floor and reject the placeholders/repetition
 * mistakes that account for most accidental weak deployments.
 *
 * NODE_ENV is production-like unless the operator named a non-production
 * environment explicitly. Unset, empty, and misspellings fail closed — they
 * are the usual state of a hand-run maintenance script, not a local workspace.
 */

/** True only when the operator set NODE_ENV to development or test. */
export function isNamedNonProductionEnvironment(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.NODE_ENV === "development" || environment.NODE_ENV === "test";
}

export function requireSessionSecret(
  environment: Record<string, string | undefined> = process.env,
): string {
  const secret = environment.SESSION_SECRET ?? "";
  if (!secret) throw new Error("SESSION_SECRET is required");
  if (isNamedNonProductionEnvironment(environment)) return secret;

  const byteLength = new TextEncoder().encode(secret).byteLength;
  const distinctCharacters = new Set(secret).size;
  const obviousPlaceholder = /(replace|change.?me|password|openbooks|example|insecure)/i.test(secret);
  const repeatedUnit = /^(.{1,16})\1+$/.test(secret);
  if (byteLength < 32 || distinctCharacters < 10 || obviousPlaceholder || repeatedUnit) {
    throw new Error(
      "SESSION_SECRET must contain at least 32 random bytes and must not be a placeholder or repeated pattern. " +
        "A weak key is accepted only when NODE_ENV is explicitly development or test.",
    );
  }
  return secret;
}
