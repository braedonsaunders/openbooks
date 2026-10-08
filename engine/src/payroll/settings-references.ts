import { declaredRemittanceVendorSettingsKeys } from "./packs.ts";

/** Tenant account references stored directly in organization payroll settings. */
export const PAYROLL_ACCOUNT_SETTING_KEYS = [
  "wageExpenseAccountId", "burdenExpenseAccountId", "netPayAccountId",
  "cppPayableAccountId", "eiPayableAccountId", "taxPayableAccountId",
  "vacationPayableAccountId",
] as const;

/** Preserve policy values while translating only declared tenant identities.
 * A configuration-only copy can omit vendors; clear those references so the
 * normal setup guard requires configuration rather than using another tenant. */
export function remapPayrollSettingsReferences(
  value: unknown,
  counterparts: { accounts: ReadonlyMap<string, string>; vendors: ReadonlyMap<string, string> },
  allowMissing: boolean,
): Record<string, unknown> | null | undefined {
  if (value == null) return value;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sandbox payroll settings must be an object; correct the source payroll configuration before copying");
  }
  const after = { ...value } as Record<string, unknown>;
  for (const [keys, ids] of [
    [PAYROLL_ACCOUNT_SETTING_KEYS, counterparts.accounts],
    [declaredRemittanceVendorSettingsKeys(), counterparts.vendors],
  ] as const) {
    for (const key of keys) {
      const reference = after[key];
      if (reference == null) continue;
      const target = typeof reference === "string" ? ids.get(reference.toLowerCase()) : undefined;
      if (!target && !allowMissing) {
        throw new Error(`sandbox payroll setting ${key} has no counterpart in the target organization; correct the source payroll account or remittance vendor selection, then refresh`);
      }
      after[key] = target ?? null;
    }
  }
  return after;
}
