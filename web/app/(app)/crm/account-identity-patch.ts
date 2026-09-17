/**
 * Identity PATCH body for the CRM account drawer (F-t12-007/F-t12-008).
 *
 * A placeholder draft (is_active=false) completes without a status change:
 * sending isActive:true against it trips the parties status-change guard
 * ("a reason between 5 and 500 characters is required"), which blocked
 * lead/prospect creation entirely. The server auto-activates a named
 * placeholder, so the create path omits isActive; later saves on an
 * active record keep echoing isActive:true (a no-op the guard ignores).
 * The revision token always rides along.
 */
export interface AccountIdentityForm {
  displayName: string
  email: string
  phone: string
  website: string
}

export function buildAccountIdentityPatch(
  party: { is_active: boolean; updated_at: string },
  form: AccountIdentityForm,
): Record<string, unknown> {
  return {
    displayName: form.displayName,
    email: form.email,
    phone: form.phone,
    website: form.website,
    ...(party.is_active ? { isActive: true } : {}),
    expectedUpdatedAt: party.updated_at,
  }
}
