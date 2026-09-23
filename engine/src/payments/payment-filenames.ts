import { PaymentError } from "./payment-errors.ts";

/**
 * Bank-file names are attacker-influenced: a custom payment-format script
 * returns an arbitrary `filename`, and that name is later concatenated onto
 * the SFTP outbound folder in `deliverRunToSftp`. `cleanPath` normalizes dot
 * segments, so a name like `../inbound/statement.ofx` would write into the
 * same tenant's inbound bank-feed folder (overwriting a bank statement)
 * while the delivery record claims `outbound/../inbound/statement.ofx`.
 *
 * There is exactly one validator for these names, and two enforcement
 * points: artifact creation (`generatePaymentFileArtifact` refuses hostile
 * formatter output before anything is stored) and SFTP delivery
 * (`resolveOutboundPath` in the sftp module re-validates defence-in-depth,
 * because rows written before this guard — or through any future path —
 * must still fail closed at publish time). Nothing here is ever silently
 * rewritten into validity: a hostile name is refused with the remedy
 * (return a plain file name), and the validated name is returned unchanged.
 */

/** Maximum file-name length accepted (POSIX NAME_MAX, in bytes). */
export const MAX_PAYMENT_FILENAME_BYTES = 255;

/**
 * Refuse anything that is not a plain file name: empty names, overlong
 * names, path separators (`/` and `\` — the SFTP wire and Windows both
 * treat backslash as a separator), NUL and other control characters, bare
 * dot segments (`.` / `..`), and Windows-hostile trailing dots/spaces
 * (the OS strips them, so `file ` and `file` would collide). Returns the
 * name unchanged — never a laundered copy.
 */
export function assertSafePaymentFilename(filename: string): string {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new PaymentError(
      "custom formatter must return a plain file name such as 'SEPA-123.xml' — the file name is missing",
    );
  }
  if (Buffer.byteLength(filename, "utf8") > MAX_PAYMENT_FILENAME_BYTES) {
    throw new PaymentError(
      `custom formatter must return a plain file name such as 'SEPA-123.xml' — the file name is ${Buffer.byteLength(filename, "utf8")} bytes (maximum ${MAX_PAYMENT_FILENAME_BYTES})`,
    );
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new PaymentError(
      `custom formatter must return a plain file name such as 'SEPA-123.xml' — ${JSON.stringify(filename)} contains a path separator`,
    );
  }
  if (/[\0-\x1f\x7f]/.test(filename)) {
    throw new PaymentError(
      "custom formatter must return a plain file name such as 'SEPA-123.xml' — the file name contains control characters",
    );
  }
  if (filename === "." || filename === "..") {
    throw new PaymentError(
      `custom formatter must return a plain file name such as 'SEPA-123.xml' — ${JSON.stringify(filename)} is a dot segment, not a file name`,
    );
  }
  if (filename.endsWith(".") || filename.endsWith(" ")) {
    throw new PaymentError(
      `custom formatter must return a plain file name such as 'SEPA-123.xml' — ${JSON.stringify(filename)} ends with a dot or space the receiving filesystem strips`,
    );
  }
  return filename;
}
