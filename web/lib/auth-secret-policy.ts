/**
 * Fail closed when the authentication signing key is absent or obviously weak.
 * Entropy cannot be proven from a supplied string, but production can enforce
 * a useful floor and reject the placeholders/repetition mistakes that account
 * for most accidental weak deployments.
 */
export function requireSessionSecret(
  environment: Record<string, string | undefined> = process.env,
): string {
  const secret = environment.SESSION_SECRET ?? "";
  if (!secret) throw new Error("SESSION_SECRET is required");
  if (environment.NODE_ENV !== "production") return secret;

  const byteLength = new TextEncoder().encode(secret).byteLength;
  const distinctCharacters = new Set(secret).size;
  const obviousPlaceholder = /(replace|change.?me|password|openbooks|example|insecure)/i.test(secret);
  const repeatedUnit = /^(.{1,16})\1+$/.test(secret);
  if (byteLength < 32 || distinctCharacters < 10 || obviousPlaceholder || repeatedUnit) {
    throw new Error(
      "SESSION_SECRET must contain at least 32 random bytes and must not be a placeholder or repeated pattern",
    );
  }
  return secret;
}
