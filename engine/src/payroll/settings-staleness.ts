import {
  declaredRemittanceFrequencySettingsKeys,
  declaredRemittanceVendorSettingsKeys,
} from "./pack-remittance-schedules.ts";

/**
 * Which organization settings writes stale an already-calculated pay run.
 *
 * A calculation is a function of its inputs, so a setting stales the run only
 * when it can change an amount or the account a calculated amount is stamped
 * with. Account mappings that only choose where a finished calculation POSTS
 * are read live by the commit boundary, which refuses by name when one is
 * unset; editing them cannot make the calculated figures wrong, so they must
 * not stale the run.
 *
 * Every key not listed here is calculation-affecting. An unrecognised setting
 * or audit shape therefore fails closed to "stale".
 */

/** Keys under orgs.settings.payroll that choose where postings or remittances go. */
const PAYROLL_POSTING_ONLY_KEYS: ReadonlySet<string> = new Set([
  // Ledger accounts the commit posts to; readiness and commit read them live.
  "burdenExpenseAccountId",
  "netPayAccountId",
  // Settlement routing is applied after payroll recognition, never calculation.
  "netPaySettlementClearing",
  // Destination of time-driven wages at commit (the labor clearing switch).
  "wagesTo",
  // Pack statutory liability mapping, written onto the seeded components.
  "slotAccounts",
]);

/**
 * Top-level orgs.settings keys whose writes choose posting accounts only.
 * Control accounts are read by the commit and by labor costing posting, never
 * by the pay calculation.
 */
const ORG_POSTING_ONLY_KEYS: ReadonlySet<string> = new Set(["controlAccounts"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deterministic JSON with sorted object keys, so equal settings compare equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const sameValue = (before: unknown, after: unknown): boolean =>
  canonicalJson(before) === canonicalJson(after);

/** `[before, after]` pairs, as the labor-costing and company-settings writers record them. */
function beforeAfterPair(value: unknown): [unknown, unknown] | null {
  if (Array.isArray(value) && value.length === 2) return [value[0], value[1]];
  if (isRecord(value) && Object.keys(value).length === 2 && "before" in value && "after" in value) {
    return [value.before, value.after];
  }
  return null;
}

/** Whether a payroll settings key only routes postings or remittances. */
export function isPostingOnlyPayrollSetting(key: string): boolean {
  return (
    PAYROLL_POSTING_ONLY_KEYS.has(key) ||
    declaredRemittanceVendorSettingsKeys().includes(key) ||
    declaredRemittanceFrequencySettingsKeys().includes(key)
  );
}

function payrollSettingsAffectCalculation(before: unknown, after: unknown): boolean {
  if ((before != null && !isRecord(before)) || (after != null && !isRecord(after))) return true;
  const beforeSettings = isRecord(before) ? before : {};
  const afterSettings = isRecord(after) ? after : {};
  for (const key of new Set([...Object.keys(beforeSettings), ...Object.keys(afterSettings)])) {
    if (sameValue(beforeSettings[key], afterSettings[key])) continue;
    if (!isPostingOnlyPayrollSetting(key)) return true;
  }
  return false;
}

function settingsSnapshotAffectCalculation(before: unknown, after: unknown): boolean {
  if ((before != null && !isRecord(before)) || (after != null && !isRecord(after))) return true;
  const beforeSettings = isRecord(before) ? before : {};
  const afterSettings = isRecord(after) ? after : {};
  for (const key of new Set([...Object.keys(beforeSettings), ...Object.keys(afterSettings)])) {
    if (sameValue(beforeSettings[key], afterSettings[key])) continue;
    if (key === "payroll") {
      if (payrollSettingsAffectCalculation(beforeSettings.payroll, afterSettings.payroll))
        return true;
      continue;
    }
    if (ORG_POSTING_ONLY_KEYS.has(key)) continue;
    return true;
  }
  return false;
}

/**
 * Whether one `audit_log` row for the organization row (table 'orgs') changed
 * anything a pay calculation reads. Writers record either a whole before/after
 * settings snapshot, or a map of the keys they changed to `[before, after]`.
 * An unrecognised shape is treated as calculation-affecting.
 */
export function orgSettingsAuditAffectsCalculation(changes: unknown): boolean {
  if (!isRecord(changes)) return true;
  const keys = Object.keys(changes);
  if (keys.length === 0) return true;
  if (keys.length === 2 && "before" in changes && "after" in changes) {
    return settingsSnapshotAffectCalculation(changes.before, changes.after);
  }
  return keys.some((key) => {
    if (ORG_POSTING_ONLY_KEYS.has(key)) return false;
    const pair = beforeAfterPair(changes[key]);
    if (key === "payroll" && pair) return payrollSettingsAffectCalculation(pair[0], pair[1]);
    if (pair) return !sameValue(pair[0], pair[1]);
    return true;
  });
}
