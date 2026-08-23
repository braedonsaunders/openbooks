import "server-only";

/** Ad-hoc URL/toolbar filters shared by entity lists. */
export interface EntityAdhoc {
  q?: string
  /** Quick-filter values keyed by the customization registry filter key. */
  filters?: Record<string, string | undefined>
  showInactive?: boolean
  /** When false, customer lists must not read or filter on CRM lifecycle — stored profiles stay. */
  crmEnabled?: boolean
}
