/** Split from PartyDrawer.tsx; moved without behavior changes. */
import { type InvoicingPref } from '../../../components/invoicing-preference-fields'
import { formatMoney } from '@openbooks/engine/src/money/money.ts'

export type Opt = {
  id: string
  name?: string
  label?: string
  type?: string
};
interface PartyApiRecord {
  id: string; display_name: string; legal_name: string | null; short_code: string | null;
  kind: string; email: string | null; phone: string | null; website: string | null;
  subsidiary_id: string | null; is_active: boolean; updated_at: string;
  custom: Record<string, unknown> | null; invoicing_preference: InvoicingPref | null
}
interface CustomerApiRecord {
  is_active: boolean; payment_terms_id: string | null; credit_limit: string | number | null;
  currency: string | null; ar_account_id: string | null; sales_rep_id: string | null;
  tax_code_id: string | null; is_on_hold: boolean; hold_reason: string | null
}
interface VendorApiRecord {
  is_active: boolean; payment_method: string | null; eft_notification_email: string | null;
  payment_terms_id: string | null; currency: string | null; is_t4a: boolean;
  ap_account_id: string | null; default_expense_account_id: string | null;
  tax_code_id: string | null; is_on_hold: boolean; hold_reason: string | null
}
interface EmployeeApiRecord {
  is_active: boolean; employee_number: string | null; job_title: string | null;
  department_id: string | null; trade_id: string | null; worker_comp_group_id: string | null;
  hired_on: string | null
}
export interface AddressApiRecord extends Record<string, unknown> {
  id: string | null; label: string | null; line1: string | null; line2: string | null;
  city: string | null; region: string | null; postal_code: string | null; country: string | null;
  is_default_billing: boolean; is_default_shipping: boolean
}
export interface ContactApiRecord extends Record<string, unknown> {
  id: string | null; first_name: string | null; last_name: string | null; name: string | null;
  title: string | null; role: string | null; email: string | null; phone: string | null;
  mobile_phone: string | null; is_primary: boolean; is_active: boolean
}
export interface BankAccountClient extends Record<string, unknown> {
  id: string; bank_name: string; country: string | null; currency: string | null;
  routing: Record<string, string> | null; account_last_four: string; updated_at: string;
  label?: string; name?: string; type?: string; approval_status?: string;
  approved_at?: string | null; retired_at?: string | null
}
export interface PartyPayload {
  party: PartyApiRecord
  customer: CustomerApiRecord | null
  vendor: VendorApiRecord | null
  employee: EmployeeApiRecord | null
  addresses: AddressApiRecord[]
  contacts: ContactApiRecord[]
  bankAccounts: BankAccountClient[]
  transactionSummary: {
    count: number
    openCount: number
    lastDate: string | null
    currencies: Array<{ currency: string; total: string; openBalance: string }>
  }
  additionalSubsidiaryIds: string[]
}
export interface SubsidiaryOpt extends Opt {
  parentId: string | null
  depth: number
  isElimination: boolean
}
export interface AddressRow extends Record<string, unknown> {
  id: string | null
  label: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  country: string
  isDefaultBilling: string
  isDefaultShipping: string
}
export interface ContactRow extends Record<string, unknown> {
  id: string | null
  firstName: string
  lastName: string
  name: string
  title: string
  role: string
  email: string
  phone: string
  mobilePhone: string
  isPrimary: string
  isActive: string
}

// Values are the API enum; labels are message keys resolved at render time.
export const PAYMENT_METHOD_OPTIONS = [
  { value: 'eft', labelKey: 'paymentMethods.eft' },
  { value: 'cheque', labelKey: 'paymentMethods.cheque' },
  { value: 'card', labelKey: 'paymentMethods.card' },
  { value: 'cash', labelKey: 'paymentMethods.cash' },
  { value: 'other', labelKey: 'paymentMethods.other' },
] as const

export const emptyAddress = (): AddressRow => ({
  id: null,
  label: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  isDefaultBilling: 'false',
  isDefaultShipping: 'false',
})

export const emptyContact = (): ContactRow => ({
  id: null,
  firstName: '', lastName: '', name: '', title: '', role: '', email: '', phone: '',
  mobilePhone: '', isPrimary: 'false', isActive: 'true',
})

export const addressFromApi = (address: AddressApiRecord): AddressRow => ({
  id: address.id ? String(address.id) : null,
  label: address.label ?? '',
  line1: address.line1 ?? '',
  line2: address.line2 ?? '',
  city: address.city ?? '',
  region: address.region ?? '',
  postalCode: address.postal_code ?? '',
  country: address.country ?? '',
  isDefaultBilling: address.is_default_billing === true ? 'true' : 'false',
  isDefaultShipping: address.is_default_shipping === true ? 'true' : 'false',
})

export const contactFromApi = (contact: ContactApiRecord): ContactRow => ({
  id: contact.id ? String(contact.id) : null,
  firstName: contact.first_name ?? '',
  lastName: contact.last_name ?? '',
  name: contact.name ?? '',
  title: contact.title ?? '',
  role: contact.role ?? '',
  email: contact.email ?? '',
  phone: contact.phone ?? '',
  mobilePhone: contact.mobile_phone ?? '',
  isPrimary: contact.is_primary === true ? 'true' : 'false',
  isActive: contact.is_active === false ? 'false' : 'true',
})

export const serializeAddresses = (rows: AddressRow[]) => rows.map((row) => {
  const address: Record<string, unknown> = { ...row };
  delete address.id;
  return {
    ...address,
    isDefaultBilling: address.isDefaultBilling === 'true',
    isDefaultShipping: address.isDefaultShipping === 'true',
  };
})

export const serializeContacts = (rows: ContactRow[]) => rows.map((row) => {
  const contact: Record<string, unknown> = { ...row };
  delete contact.id;
  return {
    ...contact,
    isPrimary: contact.isPrimary === 'true',
    isActive: contact.isActive === 'true',
  };
})


/**
 * Payroll profile editing lives here, on the native employee entity.
 *
 * `attachments` and `audit` are the shared flyout shell's own panels. They sit
 * in this union because the party flyout drives ONE rail: the shell used to
 * render Details / Attachments / Audit trail and the party body a second strip
 * underneath it, so every work area was two clicks deep behind a "Details"
 * that named nothing. Here the party owns the whole strip and hands the shell
 * a controlled tab; `overview` is the shell's `details` slot, renamed.
 */
export type PartyTab = 'overview' | 'invoicing' | 'pricing' | 'transactions' | 'activities' | 'contacts' | 'addresses' | 'accounting' | 'compliance' | 'wages' | 'payroll' | 'employment' | 'pulse' | 'relationship' | 'attachments' | 'audit'

/** The rail key the shared shell knows the leading tab by. */
const SHELL_DETAILS_TAB = 'details'
export const toShellTab = (tab: PartyTab): string => (tab === 'overview' ? SHELL_DETAILS_TAB : tab)
export const fromShellTab = (key: string): PartyTab => (key === SHELL_DETAILS_TAB ? 'overview' : key as PartyTab)

/**
 * Records a visited drawer tab for keep-alive panels (F-t08-003): the
 * employee compensation tabs hold unsaved edits in local component state,
 * so once visited they stay mounted (hidden) instead of unmounting on
 * every tab switch and silently discarding those edits. Returns the input
 * set untouched when the tab is already kept.
 */
export function rememberDrawerTab(kept: ReadonlySet<PartyTab>, key: PartyTab): ReadonlySet<PartyTab> {
  if (kept.has(key)) return kept
  return new Set(kept).add(key)
}

export const checkboxClass = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500'
export const field = 'space-y-1.5'

/**
 * Format a persisted credit limit for the two-decimal editor without first
 * coercing the PostgreSQL numeric string through JavaScript's Number type.
 * Credit limits use the ledger's exact numeric representation, so the bigint
 * money formatter preserves values beyond Number.MAX_SAFE_INTEGER and rounds
 * fractional cents deterministically.
 */
export function formatCreditLimit(value: string | number | null | undefined): string {
  return value == null ? '' : formatMoney(value, 2)
}
