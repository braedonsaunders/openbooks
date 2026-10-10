/**
 * Picker options for one control-account role. Pure and client-safe: the
 * accepted account types arrive from the engine policy
 * (CONTROL_ACCOUNT_TYPE_POLICY) through the server loader, so the picker and
 * the save-time validation read one authoritative rule.
 */

export type ControlAccountChoice = { id: string; label: string; type: string }

export interface ControlAccountPickerOptions {
  options: { value: string; label: string }[]
  /** The stored account no longer fits the role's policy (a mapping written
   *  before the rule, or an account whose type changed). It stays selectable
   *  so the field never reads blank, and the form flags it for correction. */
  selectedIncompatible: boolean
}

export function controlAccountPickerOptions(args: {
  accounts: readonly ControlAccountChoice[]
  allowedTypes: readonly string[]
  selectedId: string | undefined
  incompatibleLabel: (accountLabel: string) => string
}): ControlAccountPickerOptions {
  const allowed = new Set(args.allowedTypes)
  const options = args.accounts
    .filter((account) => allowed.has(account.type))
    .map((account) => ({ value: account.id, label: account.label }))
  const selected = args.selectedId
    ? args.accounts.find((account) => account.id === args.selectedId)
    : undefined
  if (selected && !allowed.has(selected.type)) {
    return {
      options: [{ value: selected.id, label: args.incompatibleLabel(selected.label) }, ...options],
      selectedIncompatible: true,
    }
  }
  return { options, selectedIncompatible: false }
}

/** Chart account type key ("asset_current_other") → its message key
 *  under `accounts.types` ("assetCurrentOther"). */
export function accountTypeMessageKey(type: string): string {
  return type.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
