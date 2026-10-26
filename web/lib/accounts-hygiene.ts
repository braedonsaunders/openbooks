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

export const ASSET_BANK_UNCORROBORATED = "asset_bank_uncorroborated" as const;

export interface AssetBankHygieneWarning {
  /** Stable code; UIs resolve it through the accounts locale catalog. */
  code: typeof ASSET_BANK_UNCORROBORATED;
  /** Account display name for the catalog `{name}` parameter. */
  name: string;
  /**
   * English fallback for consumers without a viewer locale (API clients,
   * logs, import previews). User-facing surfaces with a locale must
   * resolve `code` through the catalog instead of showing this verbatim.
   */
  message: string;
}

/**
 * A hygiene warning when an `asset_bank` typing carries no corroboration,
 * else null. Pure (no I/O) so the API routes, the master-data importer,
 * and unit tests all share it.
 */
export function assetBankHygieneWarning(
  input: AssetBankHygieneInput,
): AssetBankHygieneWarning | null {
  if (input.type !== "asset_bank") return null;
  // Summary accounts never post and the cash queries exclude them.
  if (input.isSummary) return null;
  if (input.reconcilable || input.hasStatements) return null;
  const name = input.name.trim();
  if (name && BANK_LIKE_NAME.test(name)) return null;
  const displayName = name || "(unnamed)";
  return {
    code: ASSET_BANK_UNCORROBORATED,
    name: displayName,
    message:
      `"${displayName}" is typed as a bank account but has no bank-like name ` +
      `and is not statement-reconcilable, so it will be counted as cash everywhere. ` +
      `Confirm the type (clearing, provision, and credit-facility accounts are commonly ` +
      `mistyped) or enable statement reconciliation.`,
  };
}

/**
 * Account names are not unique (account numbers are). Two active accounts that
 * share a name make the pickers ambiguous, so a create or rename that would
 * place a second active account with the same name where both are visible is
 * refused until the operator confirms it. Visibility overlaps when either
 * account is on the shared chart or both sit in the same subsidiary.
 */
export const DUPLICATE_ACCOUNT_NAME = "duplicate_account_name" as const;

/** Comparison key: case-insensitive, with runs of whitespace collapsed and trimmed. */
export function accountNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface DuplicateAccountNameHolder {
  id: string;
  number: string | null;
  name: string;
}

export interface DuplicateAccountNameWarning {
  code: typeof DUPLICATE_ACCOUNT_NAME;
  /** The name the operator asked for. */
  name: string;
  existingAccountId: string;
  existingAccountName: string;
  existingAccountNumber: string | null;
  /** English fallback for API clients; UIs resolve `code` through the accounts catalog. */
  message: string;
}

/**
 * The duplicate-name warning for the first conflicting holder, else null.
 * Pure: the caller supplies the holders its scoped lookup returned.
 */
export function duplicateAccountNameWarning(
  name: string,
  holders: readonly DuplicateAccountNameHolder[],
): DuplicateAccountNameWarning | null {
  const holder = holders[0];
  if (!holder) return null;
  const displayName = name.trim();
  const holderLabel = holder.number ? `${holder.number} ${holder.name}` : holder.name;
  return {
    code: DUPLICATE_ACCOUNT_NAME,
    name: displayName,
    existingAccountId: holder.id,
    existingAccountName: holder.name,
    existingAccountNumber: holder.number,
    message:
      `An active account named "${displayName}" already exists (${holderLabel}). ` +
      `Use that account, or confirm that a second account with this name is intended.`,
  };
}
