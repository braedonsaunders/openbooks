/**
 * Chart-of-accounts hygiene for bank-typed accounts.
 *
 * An account typed `asset_bank` shows as cash everywhere (banking home, cash
 * cockpit, cash position, assistant cash tools), so a mistyped clearing,
 * provision, or credit-facility account silently inflates cash — the exact
 * shape seen on real tenants. The check is a WARNING, never a refusal: it
 * fires only when the typing is wholly uncorroborated.
 *
 * Tenant-generic by construction: the name test matches a small generic
 * English banking vocabulary, never institution or tenant names. A vague but
 * genuine bank name ('Operating') still passes the moment the account is
 * statement-reconcilable or has statements behind it.
 */

const BANK_LIKE_NAME =
  /\bbanks?\b|\bbanking\b|\bchequ?ing\b|\bsavings?\b|\bmoney\s*markets?\b|\bcredit\s*unions?\b|\bcash\b|\bpetty\b|\btill\b|\bvault\b|\bundeposited\b|\bon\s*hand\b/i;

export interface AssetBankHygieneInput {
  type: string;
  name: string;
  reconcilable?: boolean;
  isSummary?: boolean;
  /**
   * A statement was already imported for the account — evidence it is a real
   * bank account even when the name says nothing.
   */
  hasStatements?: boolean;
}

/**
 * A human-readable warning when an `asset_bank` typing carries no
 * corroboration, else null. Pure (no I/O) so the API routes, the master-data
 * importer, and unit tests all share it.
 */
export function assetBankHygieneWarning(input: AssetBankHygieneInput): string | null {
  if (input.type !== "asset_bank") return null;
  // Summary accounts never post and the cash queries exclude them.
  if (input.isSummary) return null;
  if (input.reconcilable || input.hasStatements) return null;
  const name = input.name.trim();
  if (name && BANK_LIKE_NAME.test(name)) return null;
  return (
    `"${name || "(unnamed)"}" is typed as a bank account but has no bank-like name ` +
    `and is not statement-reconcilable, so it will be counted as cash everywhere. ` +
    `Confirm the type (clearing, provision, and credit-facility accounts are commonly ` +
    `mistyped) or enable statement reconciliation.`
  );
}
