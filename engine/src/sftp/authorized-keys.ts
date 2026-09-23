import ssh2 from "ssh2";

/**
 * Validation for the `authorized_keys` text stored on an SFTP login. This is
 * the single place that text is accepted: the creation route (and any future
 * update route) parses here, so a login is never saved with key material the
 * daemon cannot use. The daemon's matcher stays a lenient reader — it still
 * skips unparseable lines — because legacy rows saved before this gate may
 * contain them.
 *
 * Rules, per physical line number:
 *   - blank lines and `#` comments are dropped (never stored, never counted);
 *   - every other line must parse with `ssh2.utils.parseKey`, or the whole
 *     save is refused naming each bad line (a pasted private-key block fails
 *     here too: no single line of its armoring parses as a public key);
 *   - surviving lines are normalized (trimmed, internal whitespace collapsed
 *     to single spaces) so what is stored is canonical OpenSSH shape.
 *
 * An input that yields zero key lines is NOT an error here — it is the
 * caller's decision whether an empty set is acceptable (the creation route
 * refuses it when key material was supplied, and stores null otherwise).
 */

/** Normalized key lines, ready to join with `\n` for storage. */
export function validateAuthorizedKeys(input: string): string[] {
  const failures: string[] = [];
  const lines: string[] = [];
  const physical = String(input ?? "").split("\n");
  physical.forEach((raw, index) => {
    const lineNumber = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const normalized = trimmed.replace(/\s+/g, " ");
    const parsed = ssh2.utils.parseKey(normalized);
    if (parsed instanceof Error) {
      failures.push(`line ${lineNumber}: ${parsed.message}`);
      return;
    }
    lines.push(normalized);
  });
  if (failures.length > 0) {
    throw new Error(
      `invalid authorized_keys (${failures.length} bad line${failures.length === 1 ? "" : "s"}): ${failures.join("; ")} — fix or remove the named lines and save again`,
    );
  }
  return lines;
}
