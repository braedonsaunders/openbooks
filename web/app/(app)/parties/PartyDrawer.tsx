'use client'

import { useMoney } from '@/components/money-provider'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Building2, CalendarDays, CircleDollarSign, FileText, Landmark, Plus, Search, Users } from 'lucide-react'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import {
  customFieldDefKey,
  defaultFormLayout,
  isCustomFieldKey,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
} from '@openbooks/customization'
import {
  Badge,
  Button,
  Drawer,
  Input,
  Label,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TabContent,
} from '@openbooks/ui'
import { currencyDisplayName, currencyOptions } from '../../../lib/iso-currencies'
import { InvoicingPreferenceFields, type InvoicingPref } from '../../../components/invoicing-preference-fields'
import { CustomFieldInputs, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { CustomFieldInput } from '../../../components/custom-field-input'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import type { LineGridColumn } from '../../../components/line-grid'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { SendButton } from '../../../components/send-button'
import { EmployeeWageRates } from './EmployeeWageRates'
import { EmployeeEntitlementBalances } from './EmployeeEntitlementBalances'
import { PayrollProfileTab } from '../payroll/_ui/PayrollProfileTab'
import { RateBookAssignmentSection } from './RateBookAssignmentSection'
import { VendorCompliancePanel, type ComplianceClassOption } from './VendorCompliancePanel'
import { ApprovalActions } from '../../../components/approval-actions'
import { ApprovalHistory } from '../../../components/approval-history'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { countryOptions } from '../../../lib/countries'
import { ReadOnlyValue } from '../../../components/read-only-value'
import { promptDialog } from '../../../lib/prompt'
import { formatMoney } from '@openbooks/engine/src/money.ts'
type Opt = {
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
interface AddressApiRecord extends Record<string, unknown> {
  id: string | null; label: string | null; line1: string | null; line2: string | null;
  city: string | null; region: string | null; postal_code: string | null; country: string | null;
  is_default_billing: boolean; is_default_shipping: boolean
}
interface ContactApiRecord extends Record<string, unknown> {
  id: string | null; first_name: string | null; last_name: string | null; name: string | null;
  title: string | null; role: string | null; email: string | null; phone: string | null;
  mobile_phone: string | null; is_primary: boolean; is_active: boolean
}
interface BankAccountClient extends Record<string, unknown> {
  id: string; bank_name: string; country: string | null; currency: string | null;
  routing: Record<string, string> | null; account_last_four: string; updated_at: string;
  label?: string; name?: string; type?: string; approval_status?: string;
  approved_at?: string | null; retired_at?: string | null
}
interface PartyPayload {
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
interface SubsidiaryOpt extends Opt {
  parentId: string | null
  depth: number
  isElimination: boolean
}
interface AddressRow extends Record<string, unknown> {
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
interface ContactRow extends Record<string, unknown> {
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
const PAYMENT_METHOD_OPTIONS = [
  { value: 'eft', labelKey: 'paymentMethods.eft' },
  { value: 'cheque', labelKey: 'paymentMethods.cheque' },
  { value: 'card', labelKey: 'paymentMethods.card' },
  { value: 'cash', labelKey: 'paymentMethods.cash' },
  { value: 'other', labelKey: 'paymentMethods.other' },
] as const

const emptyAddress = (): AddressRow => ({
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

const emptyContact = (): ContactRow => ({
  id: null,
  firstName: '', lastName: '', name: '', title: '', role: '', email: '', phone: '',
  mobilePhone: '', isPrimary: 'false', isActive: 'true',
})

const addressFromApi = (address: AddressApiRecord): AddressRow => ({
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

const contactFromApi = (contact: ContactApiRecord): ContactRow => ({
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

const serializeAddresses = (rows: AddressRow[]) => rows.map((row) => {
  const address: Record<string, unknown> = { ...row };
  delete address.id;
  return {
    ...address,
    isDefaultBilling: address.isDefaultBilling === 'true',
    isDefaultShipping: address.isDefaultShipping === 'true',
  };
})

const serializeContacts = (rows: ContactRow[]) => rows.map((row) => {
  const contact: Record<string, unknown> = { ...row };
  delete contact.id;
  return {
    ...contact,
    isPrimary: contact.isPrimary === 'true',
    isActive: contact.isActive === 'true',
  };
})

import { PartyPulseSection } from './PartyPulseSection'
import { PartyRelationshipSection } from './PartyRelationshipSection'

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
export type PartyTab = 'overview' | 'invoicing' | 'pricing' | 'transactions' | 'activities' | 'contacts' | 'addresses' | 'accounting' | 'compliance' | 'wages' | 'payroll' | 'pulse' | 'relationship' | 'attachments' | 'audit'

/** The rail key the shared shell knows the leading tab by. */
const SHELL_DETAILS_TAB = 'details'
const toShellTab = (tab: PartyTab): string => (tab === 'overview' ? SHELL_DETAILS_TAB : tab)
const fromShellTab = (key: string): PartyTab => (key === SHELL_DETAILS_TAB ? 'overview' : key as PartyTab)

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

const checkboxClass = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500'
const field = 'space-y-1.5'

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

export function PartyDrawer({
  payload,
  paymentTerms,
  departments,
  trades,
  workerCompGroups = [],
  accounts = [],
  taxCodes = [],
  salesReps = [],
  fieldDefs,
  subsidiaries,
  canManage,
  canReadActivities = false,
  canManageActivities = false,
  canReadCrmAccounts = false,
  canManageCrmAccounts = false,
  lifecycleStage = null,
  canManageWages = false,
  canManagePayroll = false,
  payrollEnabled = false,
  multiCurrency = false,
  complianceEnabled = false,
  canManageCompliance = false,
  compliance = null,
  role,
  initialTab = 'overview',
  initialMode = 'view',
  basePath = '/parties',
  layout,
  forms = [],
  currentFormId = null,
  recordType,
  canCustomize = false,
}: {
  payload: PartyPayload
  paymentTerms: Opt[]
  departments: Opt[]
  trades: Opt[]
  workerCompGroups?: Opt[]
  accounts?: Opt[]
  taxCodes?: Opt[]
  salesReps?: Opt[]
  fieldDefs: CustomFieldDefClient[]
  subsidiaries: SubsidiaryOpt[]
  canManage: boolean
  canReadActivities?: boolean
  /** crm.activities.manage — enables the Activities tab's Add button. */
  canManageActivities?: boolean
  /** crm.accounts.read + the CRM feature enabled — shows the Relationship
   *  tab, the lifecycle stage / owner / territory / qualification profile a
   *  lead or prospect carries instead of a customer role. */
  canReadCrmAccounts?: boolean
  /** crm.accounts.manage — the Relationship tab is read-only without it
   *  (the PATCH route re-checks). */
  canManageCrmAccounts?: boolean
  /**
   * The account's stored `crm_account_profiles.lifecycle_stage`, or null when
   * it has no relationship profile. Decides whether saving from the account
   * list may force the AR customer role on — see `forcesCustomerRole`.
   */
  lifecycleStage?: 'lead' | 'prospect' | 'customer' | null
  /** admin.setup.manage — wage data is confidential; gates the Wages tab. */
  canManageWages?: boolean
  /** payroll.manage + the payroll feature enabled — shows the Payroll tab. */
  canManagePayroll?: boolean
  /** Company Settings → Features. Worker-comp group is Payroll
   *  configuration; hide and omit it when that switch is off. */
  payrollEnabled?: boolean
  /** Company Settings → Features. Customer/vendor currency is
   *  Multi-currency configuration; hide and omit it when that switch is off. */
  multiCurrency?: boolean
  /** Company Settings → Features. The Subcontractor-compliance switch gates
   *  the vendor Compliance tab (F-t04-003). */
  complianceEnabled?: boolean
  /** compliance.manage — assigning the class releases vendor money, so the
   *  tab is read-only without it (the PATCH route re-checks). */
  canManageCompliance?: boolean
  /** The vendor's assigned class + the active classes, for the Compliance tab. */
  compliance?: { classId: string | null; classes: ComplianceClassOption[] } | null
  /** When set, the drawer was opened from a role-scoped list (Customers /
   *  Vendors / Employees): only that role's fields render — the underlying
   *  multi-role party model stays hidden from end users — and saving always
   *  keeps that role enabled. Omitted on the unified /parties directory. */
  role?: 'customer' | 'vendor' | 'employee'
  initialTab?: PartyTab
  initialMode?: DrawerMode
  basePath?: string
  layout?: FormLayoutConfig
  forms?: { id: string; name: string }[]
  currentFormId?: string | null
  recordType?: 'customer' | 'vendor' | 'employee'
  canCustomize?: boolean
}) {
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const tInv = useTranslations('projects.invoicingPref')
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // The Compliance tab needs a vendor in a compliance-enabled org — the same
  // predicate gates the tab button and the deep-link, so a stale
  // ?partyTab=compliance can never strand the drawer on a missing panel.
  const showComplianceTab = complianceEnabled && (role === 'vendor' || (!role && payload.vendor != null))
  // The relationship (CRM) profile is an account-side concern: it rides the
  // customer role, and it is what a lead or prospect has INSTEAD of one.
  const showRelationshipTab = canReadCrmAccounts && (role === 'customer' || (!role && payload.customer != null))
  /**
   * `role` says which role's FIELDS to show, and opening a record from the
   * account list used to mean "force the customer role on". It cannot any
   * more: that list now spans the lifecycle, so merely naming a lead would
   * have handed it an AR customer role and made it invoiceable. The customer
   * role is written by PROMOTION (promoteCrmAccount), so a pre-customer
   * account keeps whatever role state it already had.
   */
  const preCustomerStage = lifecycleStage === 'lead' || lifecycleStage === 'prospect'
  const forcesCustomerRole = role === 'customer' && !preCustomerStage
  const allowedInitialTab =
    (initialTab === 'wages' && (role !== 'employee' || !canManageWages)) ||
    (initialTab === 'payroll' && (role !== 'employee' || !canManagePayroll)) ||
    (initialTab === 'activities' && !canReadActivities) ||
    (initialTab === 'relationship' && !showRelationshipTab) ||
    (initialTab === 'pulse' && (role !== 'customer' || payload.party.display_name === 'New party' || payload.party.display_name === 'New lead')) ||
    (initialTab === 'compliance' && !showComplianceTab)
      ? 'overview'
      : initialTab
  const [tab, setTab] = useState<PartyTab>(allowedInitialTab)
  // Tabs visited this drawer session. The employee compensation panels stay
  // mounted once visited (see the keep-alive blocks below) so tab switches
  // never discard their local edits. The drawer remounts per party
  // (key={party.id}), so nothing leaks across parties.
  const [keptTabs, setKeptTabs] = useState<ReadonlySet<PartyTab>>(() => new Set<PartyTab>([allowedInitialTab]))
  const showTab = (key: PartyTab) => {
    setTab(key)
    setKeptTabs((prev) => rememberDrawerTab(prev, key))
  }
  // Adopt a new initial tab during render (same committed values, no extra
  // render). `rememberDrawerTab` returns the previous set when the tab is
  // already kept, so this settles after one pass.
  const [prevAllowedInitialTab, setPrevAllowedInitialTab] = useState(allowedInitialTab)
  if (prevAllowedInitialTab !== allowedInitialTab) {
    setPrevAllowedInitialTab(allowedInitialTab)
    setTab(allowedInitialTab)
    setKeptTabs((prev) => rememberDrawerTab(prev, allowedInitialTab))
  }
  const p = payload.party
  const effectiveLayout = layout ?? (recordType ? defaultFormLayout(recordType) : null)
  const [invoicingPref, setInvoicingPref] = useState<InvoicingPref>((payload.party.invoicing_preference as InvoicingPref) ?? {})
  // The server-side draft sentinels stored in the DB — compare and persist
  // them verbatim; only the *displayed* fallback is translated. The parties
  // draft writes 'New party'; the relationship draft (a lead or prospect
  // started from the account list) writes 'New lead'. Both land in this one
  // flyout, so both must blank the name field.
  const placeholderName = p.display_name === 'New party' || p.display_name === 'New lead'
    ? p.display_name
    : null
  const isPlaceholderName = placeholderName != null

  // -- identity --------------------------------------------------------------
  const [kind, setKind] = useState<string>(p.kind ?? 'company')
  // The stored kind can be any of the five party kinds (role lists are that
  // kind by construction) — the label must render what is stored, never fall
  // through to Company for a customer/vendor/employee row (F-t05-002).
  const kindLabel = kind === 'person'
    ? t('kindPerson')
    : kind === 'customer'
      ? t('kindCustomer')
      : kind === 'vendor'
        ? t('kindVendor')
        : kind === 'employee'
          ? t('kindEmployee')
          : t('kindCompany')
  const [displayName, setDisplayName] = useState<string>(isPlaceholderName ? '' : (p.display_name ?? ''))
  const [legalName, setLegalName] = useState<string>(p.legal_name ?? '')
  const [shortCode, setShortCode] = useState<string>(p.short_code ?? '')
  const [email, setEmail] = useState<string>(p.email ?? '')
  const [phone, setPhone] = useState<string>(p.phone ?? '')
  const [website, setWebsite] = useState<string>(p.website ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(p.custom ?? {})
  const [isActive, setIsActive] = useState<boolean>(p.is_active === true)
  // The server sends [] when the feature is disabled and the full picker when
  // enabled, even before a second subsidiary has been added.
  const multiSubsidiary = subsidiaries.some((s) => !s.isElimination)
  const rootSubsidiaryId = subsidiaries.find((s) => s.parentId === null)?.id ?? ''
  const [subsidiaryId, setSubsidiaryId] = useState<string>(p.subsidiary_id ?? rootSubsidiaryId)
  const [additionalSubsidiaryIds, setAdditionalSubsidiaryIds] = useState<Set<string>>(
    new Set(payload.additionalSubsidiaryIds ?? []),
  )

  // -- roles -------------------------------------------------------------
  const [customer, setCustomer] = useState({
    enabled: !!payload.customer && payload.customer.is_active !== false,
    paymentTermsId: payload.customer?.payment_terms_id ?? '',
    creditLimit: formatCreditLimit(payload.customer?.credit_limit),
    currency: payload.customer?.currency ?? '',
    arAccountId: payload.customer?.ar_account_id ?? '',
    salesRepId: payload.customer?.sales_rep_id ?? '',
    taxCodeId: payload.customer?.tax_code_id ?? '',
    isOnHold: payload.customer?.is_on_hold === true,
    holdReason: payload.customer?.hold_reason ?? '',
  })
  const [vendor, setVendor] = useState({
    enabled: !!payload.vendor && payload.vendor.is_active !== false,
    paymentMethod: payload.vendor?.payment_method ?? '',
    eftNotificationEmail: payload.vendor?.eft_notification_email ?? '',
    paymentTermsId: payload.vendor?.payment_terms_id ?? '',
    currency: payload.vendor?.currency ?? '',
    is1099OrT4a: payload.vendor?.is_t4a === true,
    apAccountId: payload.vendor?.ap_account_id ?? '',
    defaultExpenseAccountId: payload.vendor?.default_expense_account_id ?? '',
    taxCodeId: payload.vendor?.tax_code_id ?? '',
    isOnHold: payload.vendor?.is_on_hold === true,
    holdReason: payload.vendor?.hold_reason ?? '',
  })
  const [employee, setEmployee] = useState({
    enabled: !!payload.employee && payload.employee.is_active !== false,
    employeeNumber: payload.employee?.employee_number ?? '',
    jobTitle: payload.employee?.job_title ?? '',
    departmentId: payload.employee?.department_id ?? '',
    tradeId: payload.employee?.trade_id ?? '',
    workerCompGroupId: payload.employee?.worker_comp_group_id ?? '',
    hiredOn: payload.employee?.hired_on ?? '',
  })

  // -- addresses ---------------------------------------------------------
  const [addresses, setAddresses] = useState<AddressRow[]>(
    payload.addresses.map(addressFromApi),
  )
  const [contacts, setContacts] = useState<ContactRow[]>(
    payload.contacts.map(contactFromApi),
  )
  const [addressDraft, setAddressDraft] = useState<{ index: number | null; row: AddressRow } | null>(null)
  const [contactDraft, setContactDraft] = useState<{ index: number | null; row: ContactRow } | null>(null)
  // Address/contact rows save on their own lifecycle beside the main form —
  // one pin per surface, so a refused row save pins in its own editor.
  const relatedAction = useAppAction()
  const relatedBusy = relatedAction.busy

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [nameError, setNameError] = useState(false)
  // A refused save or activate/deactivate pins its reason on the record until
  // the next action or cancel — a toast alone let F-t05-002 read as a
  // successful save while the data was silently lost.
  const { busy, refusal, execute, clearRefusal, refuse } = useAppAction()

  // Existing parties default to read-only; creation flows can explicitly
  // request edit mode. Permission checks remain authoritative.
  const [mode, setMode] = useState<DrawerMode>(
    initialDrawerMode(initialMode, canManage),
  )
  const editable = mode === 'edit' && canManage

  const nameValid = displayName.trim().length > 0
    && displayName.trim() !== 'New party' && displayName.trim() !== 'New lead'

  // -- explicit save (no autosave) -------------------------------------------
  const savePayload = useMemo(
    () => ({
      kind,
      // An unnamed draft keeps the sentinel it was born with, so the server
      // recognises it as the same draft-completion flow it minted.
      displayName: displayName.trim() || (isActive ? displayName : (placeholderName ?? 'New party')),
      legalName,
      shortCode,
      email,
      phone,
      website,
      custom: customValues,
      invoicingPreference: invoicingPref,
      subsidiaryId: multiSubsidiary ? subsidiaryId || null : undefined,
      additionalSubsidiaryIds: multiSubsidiary
        ? [...additionalSubsidiaryIds].filter((id) => id !== subsidiaryId)
        : undefined,
      roles: {
        customer: {
          enabled: forcesCustomerRole ? true : customer.enabled,
          paymentTermsId: customer.paymentTermsId || null,
          creditLimit: customer.creditLimit || null,
          ...(multiCurrency ? { currency: customer.currency || null } : {}),
          arAccountId: customer.arAccountId || null,
          salesRepId: customer.salesRepId || null,
          taxCodeId: customer.taxCodeId || null,
          isOnHold: customer.isOnHold,
          holdReason: customer.isOnHold ? customer.holdReason : null,
        },
        vendor: {
          enabled: role === 'vendor' ? true : vendor.enabled,
          paymentMethod: vendor.paymentMethod || null,
          eftNotificationEmail: vendor.eftNotificationEmail || null,
          paymentTermsId: vendor.paymentTermsId || null,
          ...(multiCurrency ? { currency: vendor.currency || null } : {}),
          is1099OrT4a: vendor.is1099OrT4a,
          apAccountId: vendor.apAccountId || null,
          defaultExpenseAccountId: vendor.defaultExpenseAccountId || null,
          taxCodeId: vendor.taxCodeId || null,
          isOnHold: vendor.isOnHold,
          holdReason: vendor.isOnHold ? vendor.holdReason : null,
        },
        employee: {
          enabled: role === 'employee' ? true : employee.enabled,
          employeeNumber: employee.employeeNumber || null,
          jobTitle: employee.jobTitle || null,
          departmentId: employee.departmentId || null,
          tradeId: employee.tradeId || null,
          ...(payrollEnabled ? { workerCompGroupId: employee.workerCompGroupId || null } : {}),
          hiredOn: employee.hiredOn || null,
        },
      },
      expectedUpdatedAt: p.updated_at,
      addresses: serializeAddresses(addresses),
      contacts: serializeContacts(contacts),
    }),
    [kind, displayName, legalName, shortCode, email, phone, website, customValues, invoicingPref, subsidiaryId, additionalSubsidiaryIds, multiSubsidiary, customer, vendor, employee, addresses, contacts, isActive, role, payrollEnabled, multiCurrency, p.updated_at, placeholderName, forcesCustomerRole],
  )
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render). `skipDirty` is a
  // one-shot latch consumed here: the autosave writes server-canonical rows
  // back into the form without marking it dirty. `editable` is read but
  // deliberately NOT subscribed: the gate fires only when `savePayload`
  // changes identity, so merely entering edit mode with untouched fields never
  // marks the form dirty (same guarantee as the ref-mirrored gate this
  // replaces, without the effect-body setState).
  const [dirty, setDirty] = useState(false)
  const [prevSavePayload, setPrevSavePayload] = useState(savePayload)
  const [skipDirty, setSkipDirty] = useState(false)
  if (prevSavePayload !== savePayload) {
    setPrevSavePayload(savePayload)
    if (skipDirty) setSkipDirty(false)
    else if (editable) setDirty(true)
  }

  /** Reset every field back to the loaded party (used by Cancel). */
  function resetForm() {
    setKind(p.kind ?? 'company')
    setDisplayName(isPlaceholderName ? '' : (p.display_name ?? ''))
    setLegalName(p.legal_name ?? '')
    setShortCode(p.short_code ?? '')
    setEmail(p.email ?? '')
    setPhone(p.phone ?? '')
    setWebsite(p.website ?? '')
    setCustomValues(p.custom ?? {})
    setInvoicingPref((p.invoicing_preference as InvoicingPref) ?? {})
    setSubsidiaryId(p.subsidiary_id ?? rootSubsidiaryId)
    setAdditionalSubsidiaryIds(new Set(payload.additionalSubsidiaryIds ?? []))
    setCustomer({
      enabled: !!payload.customer && payload.customer.is_active !== false,
      paymentTermsId: payload.customer?.payment_terms_id ?? '',
      creditLimit: formatCreditLimit(payload.customer?.credit_limit),
      currency: payload.customer?.currency ?? '',
      arAccountId: payload.customer?.ar_account_id ?? '',
      salesRepId: payload.customer?.sales_rep_id ?? '',
      taxCodeId: payload.customer?.tax_code_id ?? '',
      isOnHold: payload.customer?.is_on_hold === true,
      holdReason: payload.customer?.hold_reason ?? '',
    })
    setVendor({
      enabled: !!payload.vendor && payload.vendor.is_active !== false,
      paymentMethod: payload.vendor?.payment_method ?? '',
      eftNotificationEmail: payload.vendor?.eft_notification_email ?? '',
      paymentTermsId: payload.vendor?.payment_terms_id ?? '',
      currency: payload.vendor?.currency ?? '',
      is1099OrT4a: payload.vendor?.is_t4a === true,
      apAccountId: payload.vendor?.ap_account_id ?? '',
      defaultExpenseAccountId: payload.vendor?.default_expense_account_id ?? '',
      taxCodeId: payload.vendor?.tax_code_id ?? '',
      isOnHold: payload.vendor?.is_on_hold === true,
      holdReason: payload.vendor?.hold_reason ?? '',
    })
    setEmployee({
      enabled: !!payload.employee && payload.employee.is_active !== false,
      employeeNumber: payload.employee?.employee_number ?? '',
      jobTitle: payload.employee?.job_title ?? '',
      departmentId: payload.employee?.department_id ?? '',
      tradeId: payload.employee?.trade_id ?? '',
      workerCompGroupId: payload.employee?.worker_comp_group_id ?? '',
      hiredOn: payload.employee?.hired_on ?? '',
    })
    setAddresses(payload.addresses.map(addressFromApi))
    setContacts(payload.contacts.map(contactFromApi))
  }

  async function saveRelatedRows(kind: 'addresses' | 'contacts') {
    const draft = kind === 'addresses' ? addressDraft : contactDraft
    if (!draft) return
    const currentRows = kind === 'addresses' ? addresses : contacts
    let nextRows = draft.index === null
      ? [...currentRows, draft.row]
      : currentRows.map((row, index) => index === draft.index ? draft.row : row)
    // Selecting a new default is an explicit reassignment, not a request that
    // can silently lose to whichever row happened to be serialized first.
    if (kind === 'addresses') {
      const nextAddress = draft.row as AddressRow
      nextRows = (nextRows as AddressRow[]).map((row, index) => ({
        ...row,
        isDefaultBilling: nextAddress.isDefaultBilling === 'true' && index !== (draft.index ?? nextRows.length - 1) ? 'false' : row.isDefaultBilling,
        isDefaultShipping: nextAddress.isDefaultShipping === 'true' && index !== (draft.index ?? nextRows.length - 1) ? 'false' : row.isDefaultShipping,
      }))
    } else if ((draft.row as ContactRow).isPrimary === 'true') {
      nextRows = (nextRows as ContactRow[]).map((row, index) => ({
        ...row,
        isPrimary: index === (draft.index ?? nextRows.length - 1) ? 'true' : 'false',
      }))
    }
    const ok = await relatedAction.execute(
      () =>
        fetchAction(`/api/parties/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedUpdatedAt: p.updated_at,
            [kind]: kind === 'addresses'
              ? serializeAddresses(nextRows as AddressRow[])
              : serializeContacts(nextRows as ContactRow[]),
          }),
        }),
      {
        fallbackMessage: t('autosaveFailed'),
        successMessage: tc('feedback.saved'),
        onOk: (result) => {
          setSkipDirty(true)
          const rows = (result as { addresses?: unknown; contacts?: unknown } | null)
          if (kind === 'addresses') {
            setAddresses(((rows?.addresses ?? []) as AddressApiRecord[]).map(addressFromApi))
            setAddressDraft(null)
          } else {
            setContacts(((rows?.contacts ?? []) as ContactApiRecord[]).map(contactFromApi))
            setContactDraft(null)
          }
        },
      },
    )
    if (ok) {
      router.refresh()
    }
  }

  async function save() {
    // A blank display name must never persist a nameless record: the API
    // accepts the 'New party' placeholder on inactive drafts, so the drawer
    // fails fast with an inline error instead of saving silently.
    if (!nameValid) {
      setNameError(true)
      setSaveState('error')
      refuse(t('nameRequired'), t('autosaveFailed'))
      return
    }
    const materialControlChange =
      customer.isOnHold !== (payload.customer?.is_on_hold === true) ||
      vendor.isOnHold !== (payload.vendor?.is_on_hold === true) ||
      (customer.isOnHold && customer.holdReason.trim() !== String(payload.customer?.hold_reason ?? '').trim()) ||
      (vendor.isOnHold && vendor.holdReason.trim() !== String(payload.vendor?.hold_reason ?? '').trim())
    let changeReason: string | undefined
    if (materialControlChange) {
      const reason = await promptDialog({
        title: tc('amendment.title'),
        label: tc('amendment.reason'),
        placeholder: tc('amendment.placeholder'),
        confirmLabel: tc('actions.save'),
      })
      if (!reason) return
      changeReason = reason
    }
    setSaveState('saving')
    const ok = await execute(
      () =>
        fetchAction(`/api/parties/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...savePayload, changeReason }),
        }),
      {
        fallbackMessage: t('autosaveFailed'),
        onOk: (data) => {
          const party = (data as { party?: { is_active?: unknown } } | null)?.party
          setIsActive(party?.is_active === true)
          setSaveState('saved')
          setDirty(false)
          setMode('view')
        },
        onRefused: () => {
          // Stay in edit mode with the typed values intact: the form is
          // still dirty, nothing was persisted, the pin carries the reason.
          setSaveState('error')
        },
      },
    )
    if (ok) router.refresh()
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    clearRefusal()
    setMode('view')
  }

  async function setActiveState(next: boolean) {
    const reason = await promptDialog({
      title: next ? t('activate') : t('deactivate'),
      label: tc('amendment.reason'),
      placeholder: tc('amendment.placeholder'),
      confirmLabel: next ? t('activate') : t('deactivate'),
    })
    if (!reason) return
    await execute(
      () =>
        fetchAction(`/api/parties/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isActive: next,
            expectedUpdatedAt: p.updated_at,
            changeReason: reason,
          }),
        }),
      {
        fallbackMessage: t('updateFailed'),
        successMessage: next ? t('activated') : t('deactivated'),
        onOk: () => {
          setIsActive(next)
        },
      },
    )
    router.refresh()
  }

  const ro = !editable
  const yesNo = useMemo(() => [
    { value: 'false', label: tc('labels.no') },
    { value: 'true', label: tc('labels.yes') },
  ], [tc])
  const countries = useMemo(() => countryOptions(locale), [locale])
  const currencies = useMemo(() => currencyOptions(locale), [locale])
  const addressColumns = useMemo<LineGridColumn<AddressRow>[]>(() => [
    { key: 'label', label: t('addressLabel'), type: 'text', width: '140px', placeholder: t('addressLabelPlaceholder') },
    { key: 'line1', label: t('line1'), type: 'text', width: 'minmax(190px, 2fr)' },
    { key: 'line2', label: t('line2'), type: 'text', width: 'minmax(150px, 1.4fr)' },
    { key: 'city', label: t('city'), type: 'text', width: '130px' },
    { key: 'region', label: t('region'), type: 'text', width: '120px' },
    { key: 'postalCode', label: t('postalCode'), type: 'text', width: '110px' },
    { key: 'country', label: t('country'), type: 'search-select', width: '170px', options: countries },
    { key: 'isDefaultBilling', label: t('defaultBilling'), type: 'select', width: '115px', options: yesNo },
    { key: 'isDefaultShipping', label: t('defaultShipping'), type: 'select', width: '125px', options: yesNo },
  ], [countries, t, yesNo])
  const contactColumns = useMemo<LineGridColumn<ContactRow>[]>(() => [
    { key: 'name', label: t('contactName'), type: 'text', width: 'minmax(170px, 1.4fr)', required: true },
    { key: 'title', label: t('contactTitle'), type: 'text', width: '140px' },
    { key: 'role', label: t('contactRole'), type: 'text', width: '130px' },
    { key: 'email', label: tc('labels.email'), type: 'text', width: 'minmax(190px, 1.5fr)' },
    { key: 'phone', label: t('phone'), type: 'text', width: '135px' },
    { key: 'mobilePhone', label: t('mobilePhone'), type: 'text', width: '135px' },
    { key: 'isPrimary', label: t('primaryContact'), type: 'select', width: '110px', options: yesNo },
    { key: 'isActive', label: tc('labels.active'), type: 'select', width: '95px', options: yesNo },
  ], [t, tc, yesNo])
  const customDefByKey = useMemo(() => new Map(fieldDefs.map((definition) => [definition.key, definition])), [fieldDefs])
  const label = (placement: HeaderFieldPlacement, fallback: string) => placement.labelOverride?.trim() || fallback
  const optionName = (options: Opt[], id: string) => {
    const option = options.find((item) => item.id === id)
    return option?.label ?? option?.name ?? ''
  }
  const partyValue = (value: ReactNode, className?: string) => <ReadOnlyValue value={value} className={className} />
  const renderPartyField = (placement: HeaderFieldPlacement) => {
    if (isCustomFieldKey(placement.key)) {
      const definition = customDefByKey.get(customFieldDefKey(placement.key))
      return definition ? <CustomFieldInput def={definition} value={customValues[definition.key]} onChange={(value) => setCustomValues((current) => ({ ...current, [definition.key]: value }))} readOnly={ro} /> : null
    }
    switch (placement.key) {
      case 'kind': return <><Label>{label(placement, t('kind'))}</Label>{editable ? <Select value={kind} onChange={(event) => setKind(event.target.value)}><option value="company">{t('kindCompany')}</option><option value="person">{t('kindPerson')}</option><option value="customer">{t('kindCustomer')}</option><option value="vendor">{t('kindVendor')}</option><option value="employee">{t('kindEmployee')}</option></Select> : partyValue(kindLabel)}</>
      case 'display_name': return <><Label>{label(placement, t('displayName'))}{editable ? <span className="text-red-500"> *</span> : null}</Label>{editable ? <><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={kind === 'person' ? t('personNamePlaceholder') : t('companyNamePlaceholder')} aria-invalid={nameError && !nameValid} />{nameError && !nameValid ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('nameRequired')}</p> : null}</> : partyValue(displayName)}</>
      case 'short_code': return <><Label>{label(placement, t('shortCode'))}</Label>{editable ? <Input value={shortCode} onChange={(event) => setShortCode(event.target.value)} className="font-mono" placeholder={t('shortCodePlaceholder')} /> : partyValue(shortCode, 'font-mono')}</>
      case 'legal_name': return <><Label>{label(placement, t('legalName'))}</Label>{editable ? <Input value={legalName} onChange={(event) => setLegalName(event.target.value)} /> : partyValue(legalName)}</>
      case 'email': return <><Label>{label(placement, tc('labels.email'))}</Label>{editable ? <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /> : partyValue(email)}</>
      case 'phone': return <><Label>{label(placement, t('phone'))}</Label>{editable ? <Input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /> : partyValue(phone)}</>
      case 'website': return <><Label>{label(placement, t('website'))}</Label>{editable ? <Input value={website} onChange={(event) => setWebsite(event.target.value)} placeholder={t('websitePlaceholder')} /> : partyValue(website)}</>
      case 'subsidiary_id':
        if (!multiSubsidiary) return null
        return <><Label>{label(placement, t('primarySubsidiary'))}</Label>{editable ? <Select value={subsidiaryId} onChange={(event) => setSubsidiaryId(event.target.value)}>{subsidiaries.filter((item) => !item.isElimination).map((item) => <option key={item.id} value={item.id}>{`${'— '.repeat(item.depth)}${item.name ?? ''}`}</option>)}</Select> : partyValue(optionName(subsidiaries, subsidiaryId))}<p className="text-xs text-slate-500 dark:text-slate-400">{t('primarySubsidiaryHint')}</p></>
      case 'additional_subsidiaries':
        if (!multiSubsidiary) return null
        return <><Label>{label(placement, t('additionalSubsidiaries'))}</Label>{editable ? <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">{subsidiaries.filter((item) => !item.isElimination && item.id !== subsidiaryId).map((item) => <label key={item.id} className="flex cursor-pointer items-center gap-2.5 py-1.5"><input type="checkbox" checked={additionalSubsidiaryIds.has(item.id)} onChange={(event) => setAdditionalSubsidiaryIds((previous) => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next })} className={checkboxClass} /><span className="text-sm text-slate-800 dark:text-slate-200" style={{ paddingLeft: `${item.depth * 12}px` }}>{item.name}</span></label>)}</div> : partyValue(subsidiaries.filter((item) => additionalSubsidiaryIds.has(item.id)).map((item) => item.name).filter(Boolean).join(', '))}<p className="text-xs text-slate-500 dark:text-slate-400">{t('additionalSubsidiariesHint')}</p></>
      case 'payment_terms_id': {
        const value = recordType === 'vendor' ? vendor.paymentTermsId : customer.paymentTermsId
        return <><Label>{label(placement, t('paymentTerms'))}</Label>{editable ? <Select value={value} onChange={(event) => recordType === 'vendor' ? setVendor({ ...vendor, paymentTermsId: event.target.value }) : setCustomer({ ...customer, paymentTermsId: event.target.value })}><option value="">—</option>{paymentTerms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}</Select> : partyValue(optionName(paymentTerms, value))}</>
      }
      case 'credit_limit': return <><Label>{label(placement, t('creditLimit'))}</Label>{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={customer.creditLimit} onChange={(event) => setCustomer({ ...customer, creditLimit: event.target.value })} /> : partyValue(customer.creditLimit, 'text-right tabular-nums')}</>
      case 'currency': {
        if (!multiCurrency) return null
        const value = recordType === 'vendor' ? vendor.currency : customer.currency
        return <><Label>{label(placement, tc('labels.currency'))}</Label>{editable ? <Select value={value ?? ''} onChange={(event) => recordType === 'vendor' ? setVendor({ ...vendor, currency: event.target.value }) : setCustomer({ ...customer, currency: event.target.value })}>{!value && <option value="">—</option>}{currencies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select> : partyValue(value ? `${value} · ${currencyDisplayName(value, locale)}` : value)}</>
      }
      case 'ar_account_id': return <><Label>{label(placement, t('receivableAccount'))}</Label>{editable ? <Select value={customer.arAccountId} onChange={(event) => setCustomer({ ...customer, arAccountId: event.target.value })}><option value="">—</option>{accounts.filter((account) => account.type === 'asset_receivable').map((account) => <option key={account.id} value={account.id}>{account.label ?? account.name}</option>)}</Select> : partyValue(optionName(accounts, customer.arAccountId))}</>
      case 'sales_rep_id': return <><Label>{label(placement, t('salesRepresentative'))}</Label>{editable ? <Select value={customer.salesRepId} onChange={(event) => setCustomer({ ...customer, salesRepId: event.target.value })}><option value="">—</option>{salesReps.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}</Select> : partyValue(optionName(salesReps, customer.salesRepId))}</>
      case 'tax_code_id': {
        const value = recordType === 'vendor' ? vendor.taxCodeId : customer.taxCodeId
        return <><Label>{label(placement, t('taxCode'))}</Label>{editable ? <Select value={value} onChange={(event) => recordType === 'vendor' ? setVendor({ ...vendor, taxCodeId: event.target.value }) : setCustomer({ ...customer, taxCodeId: event.target.value })}><option value="">—</option>{taxCodes.map((code) => <option key={code.id} value={code.id}>{code.label ?? code.name}</option>)}</Select> : partyValue(optionName(taxCodes, value))}</>
      }
      // Invoicing preferences + labor pricing now live on dedicated subtabs, not
      // inline in the overview layout — see the 'invoicing' / 'pricing' tabs.
      case 'invoicing_preference': return null
      case 'labor_pricing': return null
      case 'payment_method': {
        const method = PAYMENT_METHOD_OPTIONS.find((option) => option.value === vendor.paymentMethod)
        return <><Label>{label(placement, t('paymentMethod'))}</Label>{editable ? <Select value={vendor.paymentMethod} onChange={(event) => setVendor({ ...vendor, paymentMethod: event.target.value })}><option value="">—</option>{PAYMENT_METHOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}</Select> : partyValue(method ? t(method.labelKey) : '')}</>
      }
      case 'eft_notification_email': return <><Label>{label(placement, t('eftNotificationEmail'))}</Label>{editable ? <Input type="email" value={vendor.eftNotificationEmail} onChange={(event) => setVendor({ ...vendor, eftNotificationEmail: event.target.value })} /> : partyValue(vendor.eftNotificationEmail)}</>
      case 'is_1099_or_t4a': return editable ? <label className="flex items-center gap-2 pt-7"><input type="checkbox" checked={vendor.is1099OrT4a} onChange={(event) => setVendor({ ...vendor, is1099OrT4a: event.target.checked })} className={checkboxClass} /><span className="text-sm">{label(placement, t('t4aReportable'))}</span></label> : <><Label>{label(placement, t('t4aReportable'))}</Label>{partyValue(vendor.is1099OrT4a ? tc('labels.yes') : tc('labels.no'))}</>
      case 'ap_account_id': return <><Label>{label(placement, t('payableAccount'))}</Label>{editable ? <Select value={vendor.apAccountId} onChange={(event) => setVendor({ ...vendor, apAccountId: event.target.value })}><option value="">—</option>{accounts.filter((account) => account.type === 'liability_payable').map((account) => <option key={account.id} value={account.id}>{account.label ?? account.name}</option>)}</Select> : partyValue(optionName(accounts, vendor.apAccountId))}</>
      case 'default_expense_account_id': return <><Label>{label(placement, t('defaultExpenseAccount'))}</Label>{editable ? <Select value={vendor.defaultExpenseAccountId} onChange={(event) => setVendor({ ...vendor, defaultExpenseAccountId: event.target.value })}><option value="">—</option>{accounts.filter((account) => account.type === 'expense' || account.type === 'expense_other' || account.type === 'cogs').map((account) => <option key={account.id} value={account.id}>{account.label ?? account.name}</option>)}</Select> : partyValue(optionName(accounts, vendor.defaultExpenseAccountId))}</>
      case 'employee_number': return <><Label>{label(placement, t('employeeNumber'))}</Label>{editable ? <Input value={employee.employeeNumber} onChange={(event) => setEmployee({ ...employee, employeeNumber: event.target.value })} /> : partyValue(employee.employeeNumber, 'font-mono')}</>
      case 'job_title': return <><Label>{label(placement, t('jobTitle'))}</Label>{editable ? <Input value={employee.jobTitle} onChange={(event) => setEmployee({ ...employee, jobTitle: event.target.value })} /> : partyValue(employee.jobTitle)}</>
      case 'department_id': return <><Label>{label(placement, tc('labels.department'))}</Label>{editable ? <Select value={employee.departmentId} onChange={(event) => setEmployee({ ...employee, departmentId: event.target.value })}><option value="">—</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select> : partyValue(optionName(departments, employee.departmentId))}</>
      case 'trade_id': return <><Label>{label(placement, t('trade'))}</Label>{editable ? <Select value={employee.tradeId} onChange={(event) => setEmployee({ ...employee, tradeId: event.target.value })}><option value="">—</option>{trades.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select> : partyValue(optionName(trades, employee.tradeId))}</>
      case 'worker_comp_group_id': if (!payrollEnabled) return null; return <><Label>{label(placement, t('workerCompGroup'))}</Label>{editable ? <Select value={employee.workerCompGroupId} onChange={(event) => setEmployee({ ...employee, workerCompGroupId: event.target.value })}><option value="">—</option>{workerCompGroups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select> : partyValue(optionName(workerCompGroups, employee.workerCompGroupId))}</>
      case 'hired_on': return <><Label>{label(placement, t('hiredOn'))}</Label>{editable ? <Input type="date" value={employee.hiredOn} onChange={(event) => setEmployee({ ...employee, hiredOn: event.target.value })} /> : partyValue(employee.hiredOn)}</>
      default: return null
    }
  }
  // ONE rail, in reading order: what the account is, then how we sell to it,
  // then what we have done with it, then (appended by the shell) the record's
  // own evidence. These ride the shared flyout's strip as `detailTabs`, so
  // the shell renders no second strip above them.
  const tabs: Array<{ key: PartyTab; label: string; count?: number }> = [
    { key: 'overview', label: t('tabs.overview') },
    ...(role === 'customer' && !isPlaceholderName ? [{ key: 'pulse' as const, label: t('tabs.pulse') }] : []),
    ...(showRelationshipTab ? [{ key: 'relationship' as const, label: t('tabs.relationship') }] : []),
    // Invoicing preferences + labor pricing live on their own subtabs (customers only),
    // out of the crowded overview.
    ...(role === 'customer' ? [{ key: 'invoicing' as const, label: t('tabs.invoicing') }] : []),
    ...(role === 'customer' && !isPlaceholderName ? [{ key: 'pricing' as const, label: t('tabs.pricing') }] : []),
    { key: 'transactions', label: t('tabs.transactions'), count: payload.transactionSummary.count },
    ...(role === 'customer' && canReadActivities ? [{ key: 'activities' as const, label: t('tabs.activities') }] : []),
    { key: 'contacts', label: t('tabs.contacts'), count: contacts.length },
    { key: 'addresses', label: t('tabs.addresses'), count: addresses.length },
    ...(!effectiveLayout || !role || role === 'vendor' ? [{ key: 'accounting' as const, label: role === 'vendor' && effectiveLayout ? t('bankAccountsHeading') : t('tabs.accounting') }] : []),
    ...(showComplianceTab ? [{ key: 'compliance' as const, label: t('tabs.compliance') }] : []),
    ...(role === 'employee' && canManageWages ? [{ key: 'wages' as const, label: t('tabs.wages') }] : []),
    ...(role === 'employee' && canManagePayroll ? [{ key: 'payroll' as const, label: t('tabs.payroll') }] : []),
    // Attachments and Audit trail close the rail. They are the shared shell's
    // own panels, so the shell appends them itself — listing them here would
    // duplicate the buttons.
  ]

  const selectForm = (formId: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (formId) next.set('partyForm', formId)
    else next.delete('partyForm')
    const query = next.toString()
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <TransactionDrawer
      closeHref={basePath}
      recordId={String(p.id)}
      targetTable="parties"
      canEditAttachments={canManage}
      detailsLabel={t('tabs.overview')}
      keepChildrenMounted
      detailTabs={tabs
        .filter((item) => item.key !== 'overview')
        .map((item) => ({
          key: item.key,
          label: (
            <>
              {item.label}
              {item.count != null ? <span className="text-xs tabular-nums text-slate-400">{item.count}</span> : null}
            </>
          ),
        }))}
      activeTab={toShellTab(tab)}
      onActiveTabChange={(key) => showTab(fromShellTab(key))}
      title={
        <span className="flex items-center gap-2.5">
          <span>{displayName.trim() || t('newPartyFallback')}</span>
          <Badge variant={isActive ? 'success' : 'outline'}>{isActive ? tc('status.active') : tc('status.inactive')}</Badge>
        </span>
      }
      description={mode === 'edit' ? tc('feedback.editingHint') : undefined}
      primaryAction={canManage ? <Button variant="outline" size="sm" disabled={busy} onClick={() => mode === 'edit' ? cancel() : setMode('edit')}>{mode === 'edit' ? tc('actions.cancel') : tc('actions.edit')}</Button> : undefined}
      actionsMenuHeader={forms.length > 0 ? (
        <div className="border-b border-slate-200 p-2 dark:border-slate-800">
          <Label className="mb-1 block text-xs">{t('customForm')}</Label>
          <Select value={currentFormId ?? ''} onChange={(event) => selectForm(event.target.value)}>
            {forms.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}
          </Select>
        </div>
      ) : undefined}
      actions={canManage || canCustomize || payload.customer || payload.vendor ? (
        <>
          {canManage ? isActive ? (
            <Button disabled={busy} onClick={() => setActiveState(false)}>{t('deactivate')}</Button>
          ) : (
            <Button disabled={busy || !nameValid} onClick={() => setActiveState(true)}>{t('activate')}</Button>
          ) : null}
          {canCustomize && recordType ? (
            <Button asChild><Link href={`/admin/customization?recordType=${recordType}&tab=forms`}>{t('manageForms')}</Link></Button>
          ) : null}
          {mode !== 'edit' && (payload.customer || payload.vendor) ? (
            <>
              <Button asChild variant="outline">
                <Link href={`/reports/statements/${payload.party.id}?side=${payload.vendor && !payload.customer ? 'ap' : 'ar'}`}>{t('viewStatement')}</Link>
              </Button>
              {canManage ? (
                <SendButton
                  recordType="party_statement"
                  recordId={payload.party.id}
                  baseUrl={`/api/parties/${payload.party.id}/statement/send?side=${payload.vendor && !payload.customer ? 'ap' : 'ar'}`}
                />
              ) : null}
            </>
          ) : null}
        </>
      ) : undefined}
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {mode === 'edit'
              ? saveState === 'saving'
                ? tc('actions.saving')
                : saveState === 'error'
                  ? t('saveFailedRetry')
                  : dirty
                    ? t('unsavedChanges')
                    : null
              : null}
          </span>
          {mode === 'edit' ? (
            <div className="ml-auto flex items-center gap-2">
              <Button disabled={busy} onClick={save}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
            </div>
          ) : null}
        </div>
      }
    >
      <ActionAlert error={refusal} fallbackMessage={t('autosaveFailed')} title={t('saveFailedRetry')} className="mb-4" />
      <TabContent tabKey={tab}>
      <div className="space-y-7 p-1">
        {tab === 'overview' ? (
          effectiveLayout && role ? (
            <>
              <PartySummary payload={payload} />
              <HeaderFields
                layout={effectiveLayout}
                editable={!ro}
                renderField={renderPartyField}
              />
            </>
          ) : (
          <>
          <PartySummary payload={payload} />
        {/* -- identity ------------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={field}>
            <Label>{t('kind')}</Label>
            {editable ? <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="company">{t('kindCompany')}</option>
              <option value="person">{t('kindPerson')}</option>
              <option value="customer">{t('kindCustomer')}</option>
              <option value="vendor">{t('kindVendor')}</option>
              <option value="employee">{t('kindEmployee')}</option>
            </Select> : partyValue(kindLabel)}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {t('displayName')}{editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? <>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={kind === 'person' ? t('personNamePlaceholder') : t('companyNamePlaceholder')}
                aria-invalid={nameError && !nameValid}
              />
              {nameError && !nameValid ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('nameRequired')}</p> : null}
            </> : partyValue(displayName)}
          </div>
          <div className={field}>
            <Label>{t('shortCode')}</Label>
            {editable ? <Input
              value={shortCode}
              onChange={(e) => setShortCode(e.target.value)}
              className="font-mono"
              placeholder={t('shortCodePlaceholder')}
            /> : partyValue(shortCode, 'font-mono')}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{t('legalName')}</Label>
            {editable ? <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} /> : partyValue(legalName)}
          </div>
          <div className={field}>
            <Label>{tc('labels.email')}</Label>
            {editable ? <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /> : partyValue(email)}
          </div>
          <div className={field}>
            <Label>{t('phone')}</Label>
            {editable ? <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /> : partyValue(phone)}
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{t('website')}</Label>
            {editable ? <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={t('websitePlaceholder')} /> : partyValue(website)}
          </div>
        </section>

        <CustomFieldInputs defs={fieldDefs} values={customValues} onChange={setCustomValues} readOnly={ro} />

        {multiSubsidiary ? (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('subsidiariesHeading')}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className={field}>
                <Label>{t('primarySubsidiary')}</Label>
                {editable ? <Select value={subsidiaryId} onChange={(e) => setSubsidiaryId(e.target.value)}>
                  {subsidiaries.filter((s) => !s.isElimination).map((s) => (
                    <option key={s.id} value={s.id}>{`${'— '.repeat(s.depth)}${s.name ?? ''}`}</option>
                  ))}
                </Select> : partyValue(optionName(subsidiaries, subsidiaryId))}
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('primarySubsidiaryHint')}</p>
              </div>
              <div className={field}>
                <Label>{t('additionalSubsidiaries')}</Label>
                {editable ? <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  {subsidiaries.filter((s) => !s.isElimination && s.id !== subsidiaryId).map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-center gap-2.5 py-1.5">
                      <input
                        type="checkbox"
                        checked={additionalSubsidiaryIds.has(s.id)}
                        onChange={(e) => setAdditionalSubsidiaryIds((previous) => {
                          const next = new Set(previous)
                          if (e.target.checked) next.add(s.id)
                          else next.delete(s.id)
                          return next
                        })}
                        className={checkboxClass}
                      />
                      <span className="text-sm text-slate-800 dark:text-slate-200" style={{ paddingLeft: `${s.depth * 12}px` }}>
                        {s.name}
                      </span>
                    </label>
                  ))}
                </div> : partyValue(subsidiaries.filter((item) => additionalSubsidiaryIds.has(item.id)).map((item) => item.name).filter(Boolean).join(', '))}
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('additionalSubsidiariesHint')}</p>
              </div>
            </div>
          </section>
        ) : null}

          </>
          )
        ) : null}

        {/* -- roles ------------------------------------------------------
             Role-scoped open (Customers/Vendors/Employees list): only that
             role's details render, with no enable checkbox — the multi-role
             party model is an internal abstraction. The unified /parties
             directory (no `role`) keeps the full checkbox view. */}
        {tab === 'accounting' && (!effectiveLayout || !role) && ro ? (
          <section className="space-y-5">
            {(!role || role === 'customer') && customer.enabled ? (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tc('labels.customer')}</h3>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <PartyReadOnlyField label={t('paymentTerms')} value={optionName(paymentTerms, customer.paymentTermsId)} />
                  <PartyReadOnlyField label={t('creditLimit')} value={customer.creditLimit} className="tabular-nums" />
                  {multiCurrency ? <PartyReadOnlyField label={tc('labels.currency')} value={customer.currency} className="font-mono" /> : null}
                  <PartyReadOnlyField label={t('receivableAccount')} value={optionName(accounts, customer.arAccountId)} />
                  <PartyReadOnlyField label={t('salesRepresentative')} value={optionName(salesReps, customer.salesRepId)} />
                  <PartyReadOnlyField label={t('taxCode')} value={optionName(taxCodes, customer.taxCodeId)} />
                </div>
              </div>
            ) : null}
            {(!role || role === 'vendor') && vendor.enabled ? (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tc('labels.vendor')}</h3>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <PartyReadOnlyField label={t('paymentMethod')} value={vendor.paymentMethod ? t(PAYMENT_METHOD_OPTIONS.find((option) => option.value === vendor.paymentMethod)?.labelKey ?? 'paymentMethods.other') : ''} />
                  <PartyReadOnlyField label={t('eftNotificationEmail')} value={vendor.eftNotificationEmail} />
                  <PartyReadOnlyField label={t('paymentTerms')} value={optionName(paymentTerms, vendor.paymentTermsId)} />
                  {multiCurrency ? <PartyReadOnlyField label={tc('labels.currency')} value={vendor.currency} className="font-mono" /> : null}
                  <PartyReadOnlyField label={t('t4aReportable')} value={vendor.is1099OrT4a ? tc('labels.yes') : tc('labels.no')} />
                  <PartyReadOnlyField label={t('payableAccount')} value={optionName(accounts, vendor.apAccountId)} />
                  <PartyReadOnlyField label={t('defaultExpenseAccount')} value={optionName(accounts, vendor.defaultExpenseAccountId)} />
                  <PartyReadOnlyField label={t('taxCode')} value={optionName(taxCodes, vendor.taxCodeId)} />
                </div>
              </div>
            ) : null}
            {(!role || role === 'employee') && employee.enabled ? (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tc('labels.employee')}</h3>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <PartyReadOnlyField label={t('employeeNumber')} value={employee.employeeNumber} className="font-mono" />
                  <PartyReadOnlyField label={t('jobTitle')} value={employee.jobTitle} />
                  <PartyReadOnlyField label={tc('labels.department')} value={optionName(departments, employee.departmentId)} />
                  <PartyReadOnlyField label={t('trade')} value={optionName(trades, employee.tradeId)} />
                  {payrollEnabled ? <PartyReadOnlyField label={t('workerCompGroup')} value={optionName(workerCompGroups, employee.workerCompGroupId)} /> : null}
                  <PartyReadOnlyField label={t('hiredOn')} value={employee.hiredOn} />
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {tab === 'accounting' && (!effectiveLayout || !role) && editable ? (
        <>
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {role ? t(`detailsHeading.${role}`) : t('rolesHeading')}
          </h3>

          {!role || role === 'customer' ? (
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            {!role ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={customer.enabled}
                  onChange={(e) => setCustomer({ ...customer, enabled: e.target.checked })}
                  disabled={ro}
                  className={checkboxClass}
                />
                <span className="text-sm font-medium">{tc('labels.customer')}</span>
              </label>
            ) : null}
            {role === 'customer' || customer.enabled ? (
              <>
              <div className={`${role ? '' : 'mt-3 '}grid gap-3 sm:grid-cols-3`}>
                <div className={field}>
                  <Label>{t('paymentTerms')}</Label>
                  <Select
                    value={customer.paymentTermsId}
                    onChange={(e) => setCustomer({ ...customer, paymentTermsId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {paymentTerms.map((term) => (
                      <option key={term.id} value={term.id}>
                        {term.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={field}>
                  <Label>{t('creditLimit')}</Label>
                  <Input
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={customer.creditLimit}
                    onChange={(e) => setCustomer({ ...customer, creditLimit: e.target.value })}
                    disabled={ro}
                  />
                </div>
                {multiCurrency ? <div className={field}>
                  <Label>{tc('labels.currency')}</Label>
                  <Input
                    maxLength={3}
                    className="font-mono uppercase"
                    placeholder={t('currencyPlaceholder')}
                    value={customer.currency}
                    onChange={(e) => setCustomer({ ...customer, currency: e.target.value.toUpperCase() })}
                    disabled={ro}
                  />
                </div> : null}
                <div className={field}>
                  <Label>{t('receivableAccount')}</Label>
                  <Select value={customer.arAccountId} onChange={(e) => setCustomer({ ...customer, arAccountId: e.target.value })} disabled={ro}>
                    <option value="">—</option>
                    {accounts.filter((account) => account.type === 'asset_receivable').map((account) => <option key={account.id} value={account.id}>{account.label ?? account.name}</option>)}
                  </Select>
                </div>
                <div className={field}>
                  <Label>{t('salesRepresentative')}</Label>
                  <Select value={customer.salesRepId} onChange={(e) => setCustomer({ ...customer, salesRepId: e.target.value })} disabled={ro}>
                    <option value="">—</option>
                    {salesReps.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
                  </Select>
                </div>
                <div className={field}>
                  <Label>{t('taxCode')}</Label>
                  <Select value={customer.taxCodeId} onChange={(e) => setCustomer({ ...customer, taxCodeId: e.target.value })} disabled={ro}>
                    <option value="">—</option>
                    {taxCodes.map((code) => <option key={code.id} value={code.id}>{code.label ?? code.name}</option>)}
                  </Select>
                </div>
                <label className="flex items-center gap-2 self-end pb-2">
                  <input
                    type="checkbox"
                    checked={customer.isOnHold}
                    onChange={(event) => setCustomer({ ...customer, isOnHold: event.target.checked })}
                    disabled={ro}
                    className={checkboxClass}
                  />
                  <span className="text-sm">{t('creditHold')}</span>
                </label>
                {customer.isOnHold ? (
                  <div className={`${field} sm:col-span-2`}>
                    <Label>{t('holdReason')}</Label>
                    <Input value={customer.holdReason} onChange={(event) => setCustomer({ ...customer, holdReason: event.target.value })} disabled={ro} />
                  </div>
                ) : null}
              </div>
              </>
            ) : null}
          </div>
          ) : null}

          {!role || role === 'vendor' ? (
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            {!role ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={vendor.enabled}
                  onChange={(e) => setVendor({ ...vendor, enabled: e.target.checked })}
                  disabled={ro}
                  className={checkboxClass}
                />
                <span className="text-sm font-medium">{tc('labels.vendor')}</span>
              </label>
            ) : null}
            {role === 'vendor' || vendor.enabled ? (
              <div className={`${role ? '' : 'mt-3 '}grid gap-3 sm:grid-cols-3`}>
                <div className={field}>
                  <Label>{t('paymentMethod')}</Label>
                  <Select
                    value={vendor.paymentMethod}
                    onChange={(e) => setVendor({ ...vendor, paymentMethod: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {PAYMENT_METHOD_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {t(o.labelKey)}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={`${field} sm:col-span-2`}>
                  <Label>{t('eftNotificationEmail')}</Label>
                  <Input
                    type="email"
                    value={vendor.eftNotificationEmail}
                    onChange={(e) => setVendor({ ...vendor, eftNotificationEmail: e.target.value })}
                    disabled={ro}
                  />
                </div>
                <div className={field}>
                  <Label>{t('paymentTerms')}</Label>
                  <Select
                    value={vendor.paymentTermsId}
                    onChange={(e) => setVendor({ ...vendor, paymentTermsId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {paymentTerms.map((term) => (
                      <option key={term.id} value={term.id}>
                        {term.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {multiCurrency ? <div className={field}>
                  <Label>{tc('labels.currency')}</Label>
                  <Input
                    maxLength={3}
                    className="font-mono uppercase"
                    placeholder={t('currencyPlaceholder')}
                    value={vendor.currency}
                    onChange={(e) => setVendor({ ...vendor, currency: e.target.value.toUpperCase() })}
                    disabled={ro}
                  />
                </div> : null}
                <label className="flex items-center gap-2 self-end pb-2">
                  <input
                    type="checkbox"
                    checked={vendor.is1099OrT4a}
                    onChange={(e) => setVendor({ ...vendor, is1099OrT4a: e.target.checked })}
                    disabled={ro}
                    className={checkboxClass}
                  />
                  <span className="text-sm">{t('t4aReportable')}</span>
                </label>
                <div className={field}>
                  <Label>{t('payableAccount')}</Label>
                  <Select value={vendor.apAccountId} onChange={(e) => setVendor({ ...vendor, apAccountId: e.target.value })} disabled={ro}>
                    <option value="">—</option>
                    {accounts.filter((account) => account.type === 'liability_payable').map((account) => <option key={account.id} value={account.id}>{account.label ?? account.name}</option>)}
                  </Select>
                </div>
                <div className={field}>
                  <Label>{t('defaultExpenseAccount')}</Label>
                  <Select value={vendor.defaultExpenseAccountId} onChange={(e) => setVendor({ ...vendor, defaultExpenseAccountId: e.target.value })} disabled={ro}>
                    <option value="">—</option>
                    {accounts.filter((account) => account.type === 'expense' || account.type === 'expense_other' || account.type === 'cogs').map((account) => <option key={account.id} value={account.id}>{account.label ?? account.name}</option>)}
                  </Select>
                </div>
                <div className={field}>
                  <Label>{t('taxCode')}</Label>
                  <Select value={vendor.taxCodeId} onChange={(e) => setVendor({ ...vendor, taxCodeId: e.target.value })} disabled={ro}>
                    <option value="">—</option>
                    {taxCodes.map((code) => <option key={code.id} value={code.id}>{code.label ?? code.name}</option>)}
                  </Select>
                </div>
                <label className="flex items-center gap-2 self-end pb-2">
                  <input
                    type="checkbox"
                    checked={vendor.isOnHold}
                    onChange={(event) => setVendor({ ...vendor, isOnHold: event.target.checked })}
                    disabled={ro}
                    className={checkboxClass}
                  />
                  <span className="text-sm">{t('paymentHold')}</span>
                </label>
                {vendor.isOnHold ? (
                  <div className={`${field} sm:col-span-2`}>
                    <Label>{t('holdReason')}</Label>
                    <Input value={vendor.holdReason} onChange={(event) => setVendor({ ...vendor, holdReason: event.target.value })} disabled={ro} />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          ) : null}

          {!role || role === 'employee' ? (
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            {!role ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={employee.enabled}
                  onChange={(e) => setEmployee({ ...employee, enabled: e.target.checked })}
                  disabled={ro}
                  className={checkboxClass}
                />
                <span className="text-sm font-medium">{tc('labels.employee')}</span>
              </label>
            ) : null}
            {role === 'employee' || employee.enabled ? (
              <div className={`${role ? '' : 'mt-3 '}grid gap-3 sm:grid-cols-4`}>
                <div className={field}>
                  <Label>{t('employeeNumber')}</Label>
                  <Input
                    className="font-mono"
                    value={employee.employeeNumber}
                    onChange={(e) => setEmployee({ ...employee, employeeNumber: e.target.value })}
                    disabled={ro}
                  />
                </div>
                <div className={field}>
                  <Label>{t('jobTitle')}</Label>
                  <Input
                    value={employee.jobTitle}
                    onChange={(e) => setEmployee({ ...employee, jobTitle: e.target.value })}
                    disabled={ro}
                    placeholder={t('jobTitlePlaceholder')}
                  />
                </div>
                <div className={field}>
                  <Label>{tc('labels.department')}</Label>
                  <Select
                    value={employee.departmentId}
                    onChange={(e) => setEmployee({ ...employee, departmentId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={field}>
                  <Label>{t('trade')}</Label>
                  <Select
                    value={employee.tradeId}
                    onChange={(e) => setEmployee({ ...employee, tradeId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {trades.map((trade) => (
                      <option key={trade.id} value={trade.id}>
                        {trade.name}
                      </option>
                    ))}
                  </Select>
                </div>
                {payrollEnabled ? <div className={field}>
                  <Label>{t('workerCompGroup')}</Label>
                  <Select
                    value={employee.workerCompGroupId}
                    onChange={(e) => setEmployee({ ...employee, workerCompGroupId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {workerCompGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                </div> : null}
                <div className={field}>
                  <Label>{t('hiredOn')}</Label>
                  <Input
                    type="date"
                    value={employee.hiredOn}
                    onChange={(e) => setEmployee({ ...employee, hiredOn: e.target.value })}
                    disabled={ro}
                  />
                </div>
              </div>
            ) : null}
          </div>
          ) : null}
        </section>

        </>
        ) : null}

        {tab === 'invoicing' && role === 'customer' ? (
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tInv('heading')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{tInv('customerHint')}</p>
            </div>
            <InvoicingPreferenceFields value={invoicingPref} onChange={setInvoicingPref} disabled={ro} />
          </section>
        ) : null}
        {tab === 'pricing' && role === 'customer' && !isPlaceholderName ? (
          <RateBookAssignmentSection scope="customer" scopeId={String(p.id)} editable={editable} />
        ) : null}

        {tab === 'transactions' ? <TransactionSublist partyId={String(p.id)} role={role} /> : null}
        {tab === 'pulse' && role === 'customer' && !isPlaceholderName ? <PartyPulseSection partyId={String(p.id)} /> : null}
        {tab === 'relationship' && showRelationshipTab ? (
          <PartyRelationshipSection partyId={String(p.id)} canManage={canManageCrmAccounts} />
        ) : null}
        {tab === 'activities' && role === 'customer' && canReadActivities ? (
          <ActivitySublist partyId={String(p.id)} canManage={canManageActivities} />
        ) : null}

        {tab === 'contacts' ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SublistHeading title={t('contactsHeading')} description={t('contactsDescription')} icon={<Users size={16} />} />
              {canManage ? (
                <Button variant="outline" size="sm" onClick={() => setContactDraft({ index: null, row: emptyContact() })}>
                  <Plus size={14} />{t('addContact')}
                </Button>
              ) : null}
            </div>
            {contacts.length === 0 ? (
              <SublistEmpty icon={<Users size={22} />} text={t('noContacts')} />
            ) : (
              <ReadOnlyLineSublist
                columns={contactColumns}
                rows={contacts}
                searchPlaceholder={t('contactSearch')}
                onEdit={canManage ? (row, index) => setContactDraft({ index, row: { ...row } }) : undefined}
              />
            )}
          </section>
        ) : null}

        {tab === 'addresses' ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SublistHeading title={t('addressesHeading')} description={t('addressesDescription')} icon={<Building2 size={16} />} />
              {canManage ? (
                <Button variant="outline" size="sm" onClick={() => setAddressDraft({ index: null, row: emptyAddress() })}>
                  <Plus size={14} />{t('addAddress')}
                </Button>
              ) : null}
            </div>
            {addresses.length === 0 ? (
              <SublistEmpty icon={<Building2 size={22} />} text={t('noAddresses')} />
            ) : (
              <ReadOnlyLineSublist
                columns={addressColumns}
                rows={addresses}
                searchPlaceholder={t('addressSearch')}
                onEdit={canManage ? (row, index) => setAddressDraft({ index, row: { ...row } }) : undefined}
              />
            )}
          </section>
        ) : null}

        {tab === 'accounting' && (!role || role === 'vendor') ? (
          <BankAccountsPanel partyId={String(p.id)} initialAccounts={payload.bankAccounts} canManage={canManage} multiCurrency={multiCurrency} />
        ) : null}

        {tab === 'compliance' && showComplianceTab && compliance ? (
          <VendorCompliancePanel
            partyId={String(p.id)}
            initialClassId={compliance.classId}
            classes={compliance.classes}
            canManage={canManageCompliance}
          />
        ) : null}

      </div>

      <Drawer
        open={contactDraft !== null}
        onClose={() => { if (!relatedBusy) setContactDraft(null) }}
        stacked
        size="md"
        title={contactDraft?.index === null ? t('addContact') : `${tc('actions.edit')} · ${contactDraft?.row.name || t('contactName')}`}
        footer={contactDraft ? (
          <>
            <Button variant="outline" disabled={relatedBusy} onClick={() => setContactDraft(null)}>{tc('actions.cancel')}</Button>
            <Button disabled={relatedBusy || !contactDraft.row.name.trim()} onClick={() => saveRelatedRows('contacts')}>
              {relatedBusy ? tc('actions.saving') : tc('actions.save')}
            </Button>
          </>
        ) : undefined}
      >
        {contactDraft ? (
          <>
          <ActionAlert error={relatedAction.refusal} fallbackMessage={t('autosaveFailed')} />
          <ContactForm
            row={contactDraft.row}
            onChange={(row) => setContactDraft({ ...contactDraft, row })}
            yesNo={yesNo}
            labels={{
              name: t('contactName'),
              title: t('contactTitle'),
              role: t('contactRole'),
              email: tc('labels.email'),
              phone: t('phone'),
              mobilePhone: t('mobilePhone'),
              primary: t('primaryContact'),
              active: tc('labels.active'),
            }}
          />
          </>
        ) : null}
      </Drawer>

      <Drawer
        open={addressDraft !== null}
        onClose={() => { if (!relatedBusy) setAddressDraft(null) }}
        stacked
        size="md"
        title={addressDraft?.index === null ? t('addAddress') : `${tc('actions.edit')} · ${addressDraft?.row.label || t('addressesHeading')}`}
        footer={addressDraft ? (
          <>
            <Button variant="outline" disabled={relatedBusy} onClick={() => setAddressDraft(null)}>{tc('actions.cancel')}</Button>
            <Button
              disabled={relatedBusy || ![
                addressDraft.row.label,
                addressDraft.row.line1,
                addressDraft.row.line2,
                addressDraft.row.city,
                addressDraft.row.region,
                addressDraft.row.postalCode,
                addressDraft.row.country,
              ].some((value) => value.trim())}
              onClick={() => saveRelatedRows('addresses')}
            >
              {relatedBusy ? tc('actions.saving') : tc('actions.save')}
            </Button>
          </>
        ) : undefined}
      >
        {addressDraft ? (
          <>
          <ActionAlert error={relatedAction.refusal} fallbackMessage={t('autosaveFailed')} />
          <AddressForm
            row={addressDraft.row}
            onChange={(row) => setAddressDraft({ ...addressDraft, row })}
            countries={countries}
            yesNo={yesNo}
            labels={{
              label: t('addressLabel'),
              labelPlaceholder: t('addressLabelPlaceholder'),
              line1: t('line1'),
              line2: t('line2'),
              city: t('city'),
              region: t('region'),
              postalCode: t('postalCode'),
              country: t('country'),
              defaultBilling: t('defaultBilling'),
              defaultShipping: t('defaultShipping'),
            }}
          />
          </>
        ) : null}
      </Drawer>
      </TabContent>
      {/* Employee compensation tabs stay mounted once visited (hidden, outside
          the remounting TabContent) so switching tabs never discards their
          local edits — the payroll profile editor and wage-rate form hold
          unsaved state locally (F-t08-003). Mounting stays lazy: an unvisited
          tab issues no requests until first opened. */}
      {role === 'employee' && canManageWages && keptTabs.has('wages') ? (
        <div hidden={tab !== 'wages'} className="space-y-7 p-1">
          <EmployeeWageRates partyId={String(p.id)} />
        </div>
      ) : null}
      {role === 'employee' && canManagePayroll && keptTabs.has('payroll') ? (
        <div hidden={tab !== 'payroll'} className="space-y-6 p-1">
          <PayrollProfileTab partyId={String(p.id)} partyName={String(p.display_name ?? '')} />
          {/* Pay banks (banked time, vacation, benefit recoup) belong beside
              the payroll profile — one home for this person's compensation. */}
          <EmployeeEntitlementBalances partyId={String(p.id)} />
          {/* Direct deposit: the same approval-gated bank accounts the AP
              side uses — the pay-run bank file only pays approved accounts. */}
          <BankAccountsPanel partyId={String(p.id)} initialAccounts={payload.bankAccounts} canManage={canManage} multiCurrency={multiCurrency} />
        </div>
      ) : null}
    </TransactionDrawer>
  )
}

function PartyReadOnlyField({
  label,
  value,
  className,
}: {
  label: ReactNode
  value: ReactNode
  className?: string
}) {
  return (
    <div className={field}>
      <Label>{label}</Label>
      <ReadOnlyValue value={value} className={className} />
    </div>
  )
}

function PartySummary({ payload }: { payload: PartyPayload }) {
  const { money } = useMoney()
  const t = useTranslations('parties.drawer')
  const summary = payload.transactionSummary
  const primaryCurrency = summary.currencies.length === 1 ? summary.currencies[0] : null
  const cards = [
    { label: t('summary.transactions'), value: String(summary.count), icon: <FileText size={17} /> },
    { label: t('summary.openTransactions'), value: String(summary.openCount), icon: <CircleDollarSign size={17} /> },
    {
      label: t('summary.openBalance'),
      value: primaryCurrency ? money(primaryCurrency.openBalance, { currency: primaryCurrency.currency }) : t('summary.multipleCurrencies'),
      icon: <CircleDollarSign size={17} />,
    },
    {
      label: t('summary.lastTransaction'),
      value: summary.lastDate ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${summary.lastDate}T00:00:00`)) : '—',
      icon: <CalendarDays size={17} />,
    },
  ]
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-950/30">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            <span className="text-teal-600 dark:text-teal-400">{card.icon}</span>{card.label}
          </div>
          <p className="mt-2 text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{card.value}</p>
        </div>
      ))}
    </section>
  )
}

function SublistHeading({ title, description, icon }: { title: string; description: string; icon: React.ReactNode }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{icon}{title}</h3>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  )
}

function SublistEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-slate-400 dark:border-slate-700 dark:text-slate-500">
      {icon}<p className="text-sm">{text}</p>
    </div>
  )
}

function ReadOnlyLineSublist<Row extends Record<string, unknown>>({
  columns,
  rows,
  searchPlaceholder,
  onEdit,
}: {
  columns: LineGridColumn<Row>[]
  rows: Row[]
  searchPlaceholder: string
  onEdit?: (row: Row, index: number) => void
}) {
  const tc = useTranslations('common')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const perPage = 10
  const filtered = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase()
    if (!needle) return rows
    return rows.filter((row) => columns.some((column) => String(row[column.key] ?? '').toLocaleLowerCase().includes(needle)))
  }, [columns, q, rows])
  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const shown = filtered.slice((page - 1) * perPage, page * perPage)
  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
        <Input value={q} onChange={(event) => { setQ(event.target.value); setPage(1) }} placeholder={searchPlaceholder} className="pl-8" />
      </div>
      {shown.length ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => <TableHead key={String(column.key)}>{column.label}</TableHead>)}
                {onEdit ? <TableHead className="text-right">{tc('labels.actions')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row, shownIndex) => (
                <TableRow key={String(row.id ?? `${page}-${shownIndex}`)}>
                  {columns.map((column) => {
                    const value = String(row[column.key] ?? '')
                    const option = column.options?.find((item) => item.value === value)
                    return <TableCell key={String(column.key)}>{option?.label ?? (value || '—')}</TableCell>
                  })}
                  {onEdit ? (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => onEdit(row, rows.indexOf(row))}>{tc('actions.edit')}</Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{tc('feedback.noResults')}</p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{tc('actions.previous')}</Button>
        <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>{tc('actions.next')}</Button>
      </div>
    </div>
  )
}

function ContactForm({
  row,
  onChange,
  yesNo,
  labels,
}: {
  row: ContactRow
  onChange: (row: ContactRow) => void
  yesNo: Array<{ value: string; label: string }>
  labels: Record<'name' | 'title' | 'role' | 'email' | 'phone' | 'mobilePhone' | 'primary' | 'active', string>
}) {
  const set = (key: keyof ContactRow, value: string) => onChange({ ...row, [key]: value })
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className={`${field} sm:col-span-2`}><Label>{labels.name} <span className="text-red-500">*</span></Label><Input value={row.name} onChange={(event) => set('name', event.target.value)} /></div>
      <div className={field}><Label>{labels.title}</Label><Input value={row.title} onChange={(event) => set('title', event.target.value)} /></div>
      <div className={field}><Label>{labels.role}</Label><Input value={row.role} onChange={(event) => set('role', event.target.value)} /></div>
      <div className={`${field} sm:col-span-2`}><Label>{labels.email}</Label><Input type="email" value={row.email} onChange={(event) => set('email', event.target.value)} /></div>
      <div className={field}><Label>{labels.phone}</Label><Input type="tel" value={row.phone} onChange={(event) => set('phone', event.target.value)} /></div>
      <div className={field}><Label>{labels.mobilePhone}</Label><Input type="tel" value={row.mobilePhone} onChange={(event) => set('mobilePhone', event.target.value)} /></div>
      <div className={field}><Label>{labels.primary}</Label><Select value={row.isPrimary} onChange={(event) => set('isPrimary', event.target.value)}>{yesNo.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
      <div className={field}><Label>{labels.active}</Label><Select value={row.isActive} onChange={(event) => set('isActive', event.target.value)}>{yesNo.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
    </div>
  )
}

function AddressForm({
  row,
  onChange,
  countries,
  yesNo,
  labels,
}: {
  row: AddressRow
  onChange: (row: AddressRow) => void
  countries: Array<{ value: string; label: string }>
  yesNo: Array<{ value: string; label: string }>
  labels: Record<'label' | 'labelPlaceholder' | 'line1' | 'line2' | 'city' | 'region' | 'postalCode' | 'country' | 'defaultBilling' | 'defaultShipping', string>
}) {
  const set = (key: keyof AddressRow, value: string) => onChange({ ...row, [key]: value })
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className={`${field} sm:col-span-2`}><Label>{labels.label}</Label><Input value={row.label} placeholder={labels.labelPlaceholder} onChange={(event) => set('label', event.target.value)} /></div>
      <div className={`${field} sm:col-span-2`}><Label>{labels.line1}</Label><Input value={row.line1} onChange={(event) => set('line1', event.target.value)} /></div>
      <div className={`${field} sm:col-span-2`}><Label>{labels.line2}</Label><Input value={row.line2} onChange={(event) => set('line2', event.target.value)} /></div>
      <div className={field}><Label>{labels.city}</Label><Input value={row.city} onChange={(event) => set('city', event.target.value)} /></div>
      <div className={field}><Label>{labels.region}</Label><Input value={row.region} onChange={(event) => set('region', event.target.value)} /></div>
      <div className={field}><Label>{labels.postalCode}</Label><Input value={row.postalCode} onChange={(event) => set('postalCode', event.target.value)} /></div>
      <div className={field}><Label>{labels.country}</Label><SearchSelect value={row.country} onChange={(country) => set('country', country)} options={countries} sheetTitle={labels.country} clearable ariaLabel={labels.country} /></div>
      <div className={field}><Label>{labels.defaultBilling}</Label><Select value={row.isDefaultBilling} onChange={(event) => set('isDefaultBilling', event.target.value)}>{yesNo.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
      <div className={field}><Label>{labels.defaultShipping}</Label><Select value={row.isDefaultShipping} onChange={(event) => set('isDefaultShipping', event.target.value)}>{yesNo.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
    </div>
  )
}

interface BankAccountDraft {
  id: string | null
  bankName: string
  country: string
  currency: string
  routingNumber: string
  branchNumber: string
  accountNumber: string
  routingBase: Record<string, string>
  lastFour: string
  updatedAt: string
}

const emptyBankDraft = (): BankAccountDraft => ({
  id: null, bankName: '', country: '', currency: '', routingNumber: '', branchNumber: '',
  accountNumber: '', routingBase: {}, lastFour: '', updatedAt: '',
})

function BankAccountsPanel({
  partyId,
  initialAccounts,
  canManage,
  multiCurrency = false,
}: {
  partyId: string
  initialAccounts: BankAccountClient[]
  canManage: boolean
  multiCurrency?: boolean
}) {
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const [accounts, setAccounts] = useState(initialAccounts)
  const [draft, setDraft] = useState<BankAccountDraft | null>(null)
  const [historyAccount, setHistoryAccount] = useState<BankAccountClient | null>(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  // Bank saves and retires pin beside the panel until the next action AND
  // toast; a 409 refreshes the list behind the still-open draft (the stale
  // token is never adopted) so the next save cannot overwrite unseen work.
  const { busy, refusal, execute, refuse } = useAppAction()
  const perPage = 10
  const countries = useMemo(() => countryOptions(locale), [locale])
  const currencies = useMemo(() => currencyOptions(locale), [locale])

  const filtered = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase()
    if (!needle) return accounts
    return accounts.filter((account) => [account.bank_name, account.country, account.currency, account.account_last_four, ...Object.values(account.routing ?? {})]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)))
  }, [accounts, q])
  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const shown = filtered.slice((page - 1) * perPage, page * perPage)

  function edit(account: BankAccountClient) {
    const routing = (account.routing ?? {}) as Record<string, string>
    setDraft({
      id: String(account.id), bankName: account.bank_name ?? '', country: account.country ?? '',
      currency: account.currency ?? '',
      routingNumber: routing.routingNumber ?? routing.institution ?? '',
      branchNumber: routing.branchNumber ?? routing.transit ?? '',
      accountNumber: '', routingBase: routing, lastFour: account.account_last_four ?? '',
      updatedAt: account.updated_at ?? '',
    })
  }

  async function refreshAccounts() {
    const response = await fetch(`/api/parties/${partyId}`)
    if (!response.ok) return
    const next = await response.json()
    setAccounts(next.bankAccounts ?? [])
    router.refresh()
  }

  async function saveBankAccount() {
    if (!draft) return
    if (!draft.bankName.trim()) {
      refuse(t('bankAccountValidation.bankName'), t('bankAccountSaveFailed'))
      return
    }
    if (!draft.id && draft.accountNumber.trim().length < 4) {
      refuse(t('bankAccountValidation.accountNumber'), t('bankAccountSaveFailed'))
      return
    }
    if (draft.currency && !/^[A-Za-z]{3}$/.test(draft.currency)) {
      refuse(t('bankAccountValidation.currency'), t('bankAccountSaveFailed'))
      return
    }
    const routing = { ...draft.routingBase }
    delete routing.institution
    delete routing.transit
    delete routing.routingNumber
    delete routing.branchNumber
    if (draft.routingNumber.trim()) routing.routingNumber = draft.routingNumber.trim()
    if (draft.branchNumber.trim()) routing.branchNumber = draft.branchNumber.trim()
    let changeReason: string | undefined
    if (draft.id) {
      const reason = await promptDialog({
        title: tc('amendment.title'),
        label: tc('amendment.reason'),
        placeholder: tc('amendment.placeholder'),
        confirmLabel: tc('actions.save'),
      })
      if (!reason) return
      changeReason = reason
    }
    const body = {
      bankName: draft.bankName.trim(), country: draft.country.trim() || null,
      ...(multiCurrency ? { currency: draft.currency.trim().toUpperCase() || null } : {}), routing,
      ...(draft.accountNumber.trim() ? { accountNumber: draft.accountNumber.trim() } : {}),
      ...(draft.id ? { expectedUpdatedAt: draft.updatedAt, changeReason } : {}),
    }
    const savedId = draft.id
    const ok = await execute(
      () =>
        fetchAction(
          savedId
            ? `/api/parties/${partyId}/bank-accounts?accountId=${encodeURIComponent(savedId)}`
            : `/api/parties/${partyId}/bank-accounts`,
          {
            method: savedId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        ),
      {
        fallbackMessage: t('bankAccountSaveFailed'),
        successMessage: t(savedId ? 'bankAccountUpdated' : 'bankAccountAdded'),
        onOk: () => {
          setDraft(null)
        },
        onRefused: (error) => {
          // A 409 reloads the list behind the still-open draft — the server
          // reason names the recovery, and the stale token is never adopted,
          // so the next save still cannot overwrite unseen work. (F-t04-004:
          // the pre-fix bug was truncated tokens 409ing every save; the
          // route bodies are clean human sentences now, safe to surface.)
          if (error.kind === 'conflict') void refreshAccounts()
        },
      },
    )
    if (ok) await refreshAccounts()
  }

  async function retire(account: Record<string, unknown>) {
    const reason = await promptDialog({
      title: tc('actions.retire'),
      label: tc('amendment.reason'),
      placeholder: tc('amendment.voidPlaceholder'),
      confirmLabel: tc('actions.retire'),
    })
    if (!reason) return
    const ok = await execute(
      () =>
        fetchAction(
          `/api/parties/${partyId}/bank-accounts?accountId=${encodeURIComponent(String(account.id))}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              retirementReason: reason,
              expectedUpdatedAt: account.updated_at,
            }),
          },
        ),
      {
        fallbackMessage: t('bankAccountSaveFailed'),
        successMessage: tc('actions.retire'),
        onRefused: (error) => {
          if (error.kind === 'conflict') void refreshAccounts()
        },
      },
    )
    if (ok) await refreshAccounts()
  }

  const statusLabel = (account: Record<string, unknown>) => {
    if (account.retired_at) return tc('status.retired')
    const status = String(account.approval_status ?? (account.approved_at ? 'approved' : 'pending'))
    if (status === 'approved') return tc('status.approved')
    if (status === 'rejected') return tc('status.rejected')
    return tc('status.pendingApproval')
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SublistHeading title={t('bankAccountsHeading')} description={t('bankAccountsDescription')} icon={<Landmark size={16} />} />
        {canManage ? <Button variant="outline" size="sm" onClick={() => setDraft(emptyBankDraft())}><Plus size={14} />{t('addBankAccount')}</Button> : null}
      </div>

      <Drawer
        open={draft !== null}
        onClose={() => { if (!busy) setDraft(null) }}
        stacked
        size="md"
        title={draft?.id ? t('editBankAccount') : t('addBankAccount')}
        description={t('bankAccountApprovalNote')}
        headerActions={<Badge variant="warning">{tc('status.pendingApproval')}</Badge>}
        footer={draft ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>{tc('actions.cancel')}</Button>
            <Button disabled={busy} onClick={saveBankAccount}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
          </>
        ) : undefined}
      >
        {draft ? (
          <>
          <ActionAlert error={refusal} fallbackMessage={t('bankAccountSaveFailed')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={field}><Label>{t('bankName')}</Label><Input value={draft.bankName} onChange={(event) => setDraft({ ...draft, bankName: event.target.value })} /></div>
            <div className={field}><Label>{t('country')}</Label><SearchSelect value={draft.country} onChange={(country) => setDraft({ ...draft, country })} options={countries} sheetTitle={t('country')} clearable ariaLabel={t('country')} /></div>
            {multiCurrency ? <div className={field}><Label>{tc('labels.currency')}</Label><Select value={draft.currency ?? ''} onChange={(event) => setDraft({ ...draft, currency: event.target.value })}>{!draft.currency && <option value="">—</option>}{currencies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select></div> : null}
            <div className={field}><Label>{t('routingNumber')}</Label><Input className="font-mono" value={draft.routingNumber} onChange={(event) => setDraft({ ...draft, routingNumber: event.target.value })} /></div>
            <div className={field}><Label>{t('branchNumber')}</Label><Input className="font-mono" value={draft.branchNumber} onChange={(event) => setDraft({ ...draft, branchNumber: event.target.value })} /></div>
            <div className={field}>
              <Label>{t('accountNumber')}</Label>
              <Input type="password" autoComplete="off" className="font-mono" value={draft.accountNumber} onChange={(event) => setDraft({ ...draft, accountNumber: event.target.value })} placeholder={draft.id ? t('accountNumberUnchanged', { lastFour: draft.lastFour }) : undefined} />
            </div>
          </div>
          </>
        ) : null}
      </Drawer>

      <Drawer
        open={historyAccount !== null}
        onClose={() => setHistoryAccount(null)}
        stacked
        size="md"
        title={tc('approvalFlow.historyTitle')}
        description={historyAccount?.bank_name ?? t('bankAccountFallback')}
      >
        {historyAccount ? (
          <ApprovalHistory
            subjectKind="party_bank_account"
            subjectId={String(historyAccount.id)}
            showEmptyState
          />
        ) : null}
      </Drawer>

      <ActionAlert error={refusal} fallbackMessage={t('bankAccountSaveFailed')} />

      {accounts.length === 0 ? (
        <SublistEmpty icon={<Landmark size={22} />} text={t('noBankAccounts')} />
      ) : (
        <>
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
            <Input value={q} onChange={(event) => { setQ(event.target.value); setPage(1) }} placeholder={t('bankAccountSearch')} className="pl-8" />
          </div>
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('bankName')}</TableHead><TableHead>{t('routing')}</TableHead>
              <TableHead>{t('accountNumber')}</TableHead><TableHead>{tc('labels.currency')}</TableHead>
              <TableHead>{tc('labels.status')}</TableHead><TableHead className="text-right">{tc('labels.actions')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {shown.map((account) => (
                <TableRow key={String(account.id)}>
                  <TableCell className="font-medium">{account.bank_name || t('bankAccountFallback')}</TableCell>
                  <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">{Object.values(account.routing ?? {}).filter(Boolean).join(' · ') || '—'}</TableCell>
                  <TableCell className="font-mono">•••• {account.account_last_four || '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{account.currency || '—'}</TableCell>
                  <TableCell><Badge variant={account.retired_at ? 'outline' : account.approval_status === 'approved' || account.approved_at ? 'success' : account.approval_status === 'rejected' ? 'outline' : 'warning'}>{statusLabel(account)}</Badge></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <FlowManualButtons subjectKind="party_bank_account" subjectId={String(account.id)} />
                      <ApprovalActions
                        subjectKind="party_bank_account"
                        subjectId={String(account.id)}
                        submitApprovalHref={
                          canManage
                            ? `/api/parties/${partyId}/bank-accounts/submit?accountId=${encodeURIComponent(String(account.id))}`
                            : undefined
                        }
                      />
                      <Button variant="ghost" size="sm" onClick={() => setHistoryAccount(account)}>
                        {tc('approvalFlow.historyTitle')}
                      </Button>
                      {canManage && !account.retired_at ? <Button variant="ghost" size="sm" onClick={() => edit(account)}>{tc('actions.edit')}</Button> : null}
                      {canManage && !account.retired_at ? <Button variant="ghost" size="sm" onClick={() => retire(account)}>{tc('actions.retire')}</Button> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{tc('actions.previous')}</Button>
            <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>{tc('actions.next')}</Button>
          </div>
        </>
      )}
    </section>
  )
}

interface ActivityRow {
  id: string
  kind: 'task' | 'call' | 'event' | 'email' | 'note'
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled'
  subject: string
  activity_date: string
}

interface ActivityResponse {
  rows: ActivityRow[]
  total: number
  page: number
  perPage: number
  kinds: ActivityRow['kind'][]
  statuses: ActivityRow['status'][]
}

function ActivitySublist({ partyId, canManage }: { partyId: string; canManage: boolean }) {
  const t = useTranslations('parties.drawer')
  const tcrm = useTranslations('crm')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { busy, execute } = useAppAction()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ActivityResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ page: String(page) })
      if (q.trim()) params.set('q', q.trim())
      if (kind) params.set('kind', kind)
      if (status) params.set('status', status)
      fetch(`/api/parties/${partyId}/activities?${params}`, { signal: controller.signal })
        .then(async (response) => {
          const body = await response.json()
          if (!response.ok) throw new Error(tc('feedback.loadFailed'))
          setData(body as ActivityResponse)
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          toast.error(error instanceof Error ? error.message : tc('feedback.loadFailed'))
        })
        .finally(() => setLoading(false))
    }, q ? 200 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [kind, page, partyId, q, status, tc])

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.perPage ?? 15)))
  // Activities are full CRM records with their own editor, so Add mints the
  // draft already linked to this account and hands off to that editor —
  // carrying `drawerReturn` so Close lands back on this flyout rather than
  // stranding the user on the activities list. The row links do the same.
  const activityHref = (id: string) => {
    const current = searchParams.toString()
    const back = current ? `${pathname}?${current}` : pathname
    return `/crm/activities?activity=${id}&drawerReturn=${encodeURIComponent(back)}`
  }
  const addActivity = async () => {
    let createdId: string | null = null
    const ok = await execute<{ id?: string }>(
      async () => {
        const result = await fetchAction<{ id?: string }>('/api/crm/activities/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subjectKind: 'account', subjectId: partyId }),
        })
        if (result.ok) createdId = result.data?.id ?? null
        return result
      },
      { fallbackMessage: tc('feedback.saveFailed') },
    )
    if (ok && createdId) router.push(activityHref(createdId))
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SublistHeading title={tcrm('activities.title')} description={tcrm('activities.description')} icon={<CalendarDays size={16} />} />
        {canManage ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={addActivity}>
            <Plus size={14} />{t('addActivity')}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
          <Input value={q} onChange={(event) => { setQ(event.target.value); setPage(1) }} placeholder={tcrm('activities.search')} className="pl-8" />
        </div>
        <Select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tcrm('fields.activityType')}>
          <option value="">{t('allTypes')}</option>
          {(data?.kinds ?? []).map((value) => <option key={value} value={value}>{tcrm(`activityKinds.${value}`)}</option>)}
        </Select>
        <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tcrm('fields.status')}>
          <option value="">{t('allStatuses')}</option>
          {(data?.statuses ?? []).map((value) => <option key={value} value={value}>{tcrm(`activityStatuses.${value}`)}</option>)}
        </Select>
      </div>
      {loading && !data ? (
        <div className="h-48 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
      ) : !data?.rows.length ? (
        <SublistEmpty icon={<CalendarDays size={22} />} text={tcrm('activities.emptyDescription')} />
      ) : (
        <>
          <Table>
            <TableHeader><TableRow>
              <TableHead>{tcrm('fields.subject')}</TableHead><TableHead>{tcrm('fields.activityType')}</TableHead>
              <TableHead>{tcrm('fields.status')}</TableHead><TableHead>{tcrm('fields.date')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={row.id} className={loading ? 'opacity-60' : undefined}>
                  <TableCell><Link href={activityHref(row.id)} className="font-semibold text-teal-700 hover:underline dark:text-teal-300">{row.subject}</Link></TableCell>
                  <TableCell>{tcrm(`activityKinds.${row.kind}`)}</TableCell>
                  <TableCell><Badge variant={row.status === 'completed' ? 'success' : 'outline'}>{tcrm(`activityStatuses.${row.status}`)}</Badge></TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{new Date(row.activity_date).toLocaleString(locale)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400">{t('activityCount', { count: data.total })}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>{tc('actions.previous')}</Button>
              <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages || loading} onClick={() => setPage((value) => value + 1)}>{tc('actions.next')}</Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

interface TransactionRow {
  id: string
  kind: string
  document_number: string
  reference_number: string | null
  document_date: string
  due_date: string | null
  status: string
  currency: string
  total: string
  open_balance: string | null
  memo: string | null
}

interface TransactionResponse {
  rows: TransactionRow[]
  total: number
  page: number
  perPage: number
  kinds: string[]
  statuses: string[]
}

const STATUS_KEYS: Record<string, string> = {
  draft: 'draft', pending_approval: 'pendingApproval', approved: 'approved', rejected: 'rejected',
  posted: 'posted', paid: 'paid', partially_paid: 'partiallyPaid', voided: 'voided',
  reversed: 'reversed', cancelled: 'cancelled',
}

function transactionTarget(row: TransactionRow): { path: string; param: string } {
  if (row.kind === 'vendor_bill' || row.kind === 'vendor_credit') return { path: '/ap', param: 'doc' }
  if (row.kind === 'customer_invoice' || row.kind === 'customer_credit') return { path: '/ar', param: 'doc' }
  if (row.kind === 'vendor_payment') return { path: '/payments', param: 'payment' }
  if (row.kind === 'customer_payment') return { path: '/receipts', param: 'payment' }
  if (row.kind === 'purchase_order') return { path: '/purchase-orders', param: 'order' }
  if (row.kind === 'sales_order') return { path: '/sales-orders', param: 'order' }
  if (row.kind === 'quote') return { path: '/estimates', param: 'estimate' }
  if (row.kind === 'expense_report') return { path: '/expenses/reports', param: 'expense' }
  if (row.kind === 'journal') return { path: '/journal', param: 'entry' }
  return { path: '/banking/transactions', param: 'doc' }
}

function TransactionSublist({ partyId, role }: { partyId: string; role?: 'customer' | 'vendor' | 'employee' }) {
  const { money } = useMoney()
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const pathname = usePathname() ?? '/parties'
  const currentSearchParams = useSearchParams()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<TransactionResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      const params = new URLSearchParams({ page: String(page) })
      if (q.trim()) params.set('q', q.trim())
      if (kind) params.set('kind', kind)
      if (status) params.set('status', status)
      fetch(`/api/parties/${partyId}/transactions?${params}`, { signal: controller.signal })
        .then(async (response) => {
          const body = await response.json()
          if (!response.ok) throw new Error(body.error ?? tc('feedback.loadFailed'))
          setData(body as TransactionResponse)
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          toast.error(error instanceof Error ? error.message : tc('feedback.loadFailed'))
        })
        .finally(() => setLoading(false))
    }, q ? 200 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [kind, page, partyId, q, status, tc])

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.perPage ?? 15)))
  const statusLabel = (value: string) => {
    const key = STATUS_KEYS[value]
    return key ? tc(`status.${key}` as never) : value.replace(/_/g, ' ')
  }
  const transactionHref = (row: TransactionRow) => {
    const returnParams = new URLSearchParams(currentSearchParams.toString())
    if (returnParams.has('party')) {
      returnParams.set('partyTab', 'transactions')
      returnParams.set('partyTxn', row.id)
      returnParams.set('partyTxnKind', row.kind)
      returnParams.delete('drawerReturn')
      returnParams.delete('relatedParty')
      returnParams.delete('relatedPartyRole')
      returnParams.delete('relatedPartyTab')
      return `${pathname}?${returnParams.toString()}`
    }

    if (returnParams.has('relatedParty')) {
      returnParams.set('relatedPartyTab', 'transactions')
      returnParams.set('partyTxn', row.id)
      returnParams.set('partyTxnKind', row.kind)
      returnParams.delete('drawerReturn')
      return `${pathname}?${returnParams.toString()}`
    }

    // Defensive fallback for a PartyDrawer mounted outside either supported
    // URL host. Normal vendor/customer flows never leave their current page.
    const returnQuery = returnParams.toString()
    const returnHref = returnQuery ? `${pathname}?${returnQuery}` : pathname
    const target = transactionTarget(row)
    const params = new URLSearchParams({
      [target.param]: row.id,
      relatedParty: partyId,
      relatedPartyTab: 'transactions',
      drawerReturn: returnHref,
    })
    if (role) params.set('relatedPartyRole', role)
    return `${target.path}?${params.toString()}`
  }
  return (
    <section className="space-y-3">
      <SublistHeading title={t('transactionsHeading')} description={t('transactionsDescription')} icon={<FileText size={16} />} />
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" size={15} />
          <Input value={q} onChange={(event) => { setQ(event.target.value); setPage(1) }} placeholder={t('transactionSearch')} className="pl-8" />
        </div>
        <Select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tc('labels.type')}>
          <option value="">{t('allTypes')}</option>
          {(data?.kinds ?? []).map((value) => {
            const meta = docTypeMeta(value)
            return <option key={value} value={value}>{tc(`transactionTypes.${meta.labelKey}` as never)}</option>
          })}
        </Select>
        <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }} className="w-auto min-w-40" aria-label={tc('labels.status')}>
          <option value="">{t('allStatuses')}</option>
          {(data?.statuses ?? []).map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
        </Select>
      </div>
      {loading && !data ? (
        <div className="h-48 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
      ) : !data?.rows.length ? (
        <SublistEmpty icon={<FileText size={22} />} text={t('noTransactions')} />
      ) : (
        <>
          <Table>
            <TableHeader><TableRow>
              <TableHead>{tc('labels.number')}</TableHead><TableHead>{tc('labels.date')}</TableHead>
              <TableHead>{tc('labels.reference')}</TableHead><TableHead>{tc('labels.status')}</TableHead>
              <TableHead className="text-right">{tc('labels.total')}</TableHead><TableHead className="text-right">{tc('labels.openBalance')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={row.id} className={loading ? 'opacity-60' : undefined}>
                  <TableCell><div className="flex items-center gap-2"><DocTypeBadge kind={row.kind} /><Link href={transactionHref(row) as never} className="font-mono text-[13px] font-semibold text-teal-700 hover:underline dark:text-teal-300">{row.document_number}</Link></div></TableCell>
                  <TableCell>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${row.document_date}T00:00:00`))}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{row.reference_number || '—'}</TableCell>
                  <TableCell><Badge variant={row.status === 'posted' ? 'success' : row.status === 'pending_approval' ? 'warning' : 'secondary'}>{statusLabel(row.status)}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.total, { currency: row.currency })}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.open_balance == null ? '—' : money(row.open_balance, { currency: row.currency })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500 dark:text-slate-400">{t('transactionCount', { count: data.total })}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}>{tc('actions.previous')}</Button>
              <span className="text-xs tabular-nums text-slate-500">{page} / {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages || loading} onClick={() => setPage((value) => value + 1)}>{tc('actions.next')}</Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
