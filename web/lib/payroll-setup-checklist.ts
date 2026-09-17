/**
 * Pack-driven payroll setup checklist (F-t08-016).
 *
 * The /payroll overview used to demand hardcoded legacy control accounts
 * (CPP/EI payable) on every tenant, so a US-only org was told to configure
 * Canadian programs with no slot anywhere in its setup — unresolvable by
 * definition, and the linked page showed nothing to fix. The checklist now
 * derives from the installed packs' declared liability slots (the same
 * packSlotState walk the run pre-flight performs) plus the two country-free
 * accounts, and every item labels itself with the key the linked setup page
 * renders, so a demanded account is always fillable where the banner sends
 * the operator. Pure: the caller supplies settings and slot states, so this
 * module stays importable from unit tests without a database.
 */
export interface MissingPayrollControlAccount {
  /**
   * Label key suffix under payroll.settingsPage, e.g.
   * 'fields.wageExpenseAccountId' or 'packAccounts.US.slots.fit'.
   */
  labelKey: string
}

export function missingPayrollControlAccounts(input: {
  wageExpenseAccountId: string | null
  netPayAccountId: string | null
  slots: readonly { country: string; key: string; accountId: string | null }[]
}): MissingPayrollControlAccount[] {
  const missing: MissingPayrollControlAccount[] = []
  if (!input.wageExpenseAccountId) missing.push({ labelKey: 'fields.wageExpenseAccountId' })
  if (!input.netPayAccountId) missing.push({ labelKey: 'fields.netPayAccountId' })
  for (const slot of input.slots) {
    if (!slot.accountId) missing.push({ labelKey: `packAccounts.${slot.country}.slots.${slot.key}` })
  }
  return missing
}
