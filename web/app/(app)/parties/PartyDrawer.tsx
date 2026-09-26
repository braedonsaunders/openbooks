'use client'

import { type Opt, type AddressApiRecord, type ContactApiRecord, type PartyPayload, type SubsidiaryOpt, type AddressRow, type ContactRow, PAYMENT_METHOD_OPTIONS, emptyAddress, emptyContact, addressFromApi, contactFromApi, serializeAddresses, serializeContacts, type PartyTab, toShellTab, fromShellTab, rememberDrawerTab, checkboxClass, field, formatCreditLimit } from './party-drawer-model'
import { PartyReadOnlyField, PartySummary, SublistHeading, SublistEmpty, ReadOnlyLineSublist } from './PartySummary'
import { ContactForm, AddressForm } from './PartyContactForms'
import { BankAccountsPanel } from './PartyBankAccountsPanel'
import { ActivitySublist } from './PartyActivitySublist'
import { TransactionSublist } from './PartyTransactionSublist'
import { initialDrawerMode, type DrawerMode } from '@/lib/drawer-mode'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Building2, Plus, Users } from 'lucide-react'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { customFieldDefKey, defaultFormLayout, isCustomFieldKey, type FormLayoutConfig, type HeaderFieldPlacement } from '@openbooks/customization'
import { Badge, Button, Drawer, Input, Label, Select, TabContent } from '@openbooks/ui'
import { FieldControlAssociations } from '@/components/field'
import { currencyDisplayName, currencyOptions } from '../../../lib/iso-currencies'
import { InvoicingPreferenceFields, type InvoicingPref } from '../../../components/invoicing-preference-fields'
import { CustomFieldInputs, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { CustomFieldInput } from '../../../components/custom-field-input'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import type { LineGridColumn } from '../../../components/line-grid'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { SendButton } from '../../../components/send-button'
import { EmployeeWageRates } from './EmployeeWageRates'
import { EmployeeEntitlementBalances } from './EmployeeEntitlementBalances'
import { PayrollProfileTab, type PayrollSubTab } from '../payroll/_ui/PayrollProfileTab'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { EmploymentTab } from '../hrm/EmploymentTab'
import { RateBookAssignmentSection } from './RateBookAssignmentSection'
import { VendorCompliancePanel, type ComplianceClassOption } from './VendorCompliancePanel'
import { countryOptions } from '../../../lib/countries'
import { ReadOnlyValue } from '../../../components/read-only-value'
import { confirmDialog } from '../../../lib/confirm'
import { promptDialog } from '../../../lib/prompt'
import { PartyPulseSection } from './PartyPulseSection'
import { PartyRelationshipSection } from './PartyRelationshipSection'

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
  hrm = null,
  role,
  initialTab = 'overview',
  initialMode = 'view',
  basePath = '/parties',
  createMode = false,
  closeHref,
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
   *  the vendor Compliance tab. */
  complianceEnabled?: boolean
  /** compliance.manage — assigning the class releases vendor money, so the
   *  tab is read-only without it (the PATCH route re-checks). */
  canManageCompliance?: boolean
  /** The vendor's assigned class + the active classes, for the Compliance tab. */
  compliance?: { classId: string | null; classes: ComplianceClassOption[] } | null
  /** Company Settings → Features. The HRM switch plus hrm.employment.read
   *  gate the employee Employment tab; the ids are the party's scoped
   *  employments (null = gated, so the tab never renders without the read
   *  surface behind it). */
  hrm?: { employmentIds: string[]; canManageHrm: boolean; canReadExits: boolean; canRecordExit: boolean; canVerb?: boolean } | null
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
  /**
   * Unsaved-create: the drawer opens editable on a payload with no persisted
   * row. Cancel navigates away with zero writes; Save persists through one
   * idempotent POST. Only the overview, invoicing, contacts, addresses, and
   * accounting tabs draw — every other tab reads a persisted party.
   */
  createMode?: boolean
  /** List URL (filters preserved) that Cancel and the close affordance return to. */
  closeHref?: string
}) {
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const th = useTranslations('hrm')
  const tInv = useTranslations('projects.invoicingPref')
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // The Compliance tab needs a vendor in a compliance-enabled org — the same
  // predicate gates the tab button and the deep-link, so a stale
  // ?partyTab=compliance can never strand the drawer on a missing panel.
  // OM-16: "a vendor" means the vendor ROLE row, never the role filter or
  // the kind column — ?role=vendor on a role-less party must not fake the
  // tab into existence. Employment, wages, and payroll read the same way.
  const showComplianceTab = complianceEnabled && payload.vendor != null
  // The Employment tab needs an employee in an HRM-enabled org whose viewer
  // holds the read grant — the loader passes null unless both hold, so the
  // same predicate gates the tab button and the deep-link like Compliance.
  const showEmploymentTab = hrm !== null && payload.employee != null
  const showWagesTab = role === 'employee' && canManageWages && payload.employee != null
  const showPayrollTab = role === 'employee' && canManagePayroll && payload.employee != null
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
  // Unsaved-create draws only the tabs that work without a persisted party:
  // identity, role selection, invoicing, and the local contacts/addresses
  // lists. Everything else (transactions, compliance, payroll, employment,
  // relationship, attachments, audit) reads the row this drawer has not
  // written yet.
  const CREATE_TABS: ReadonlySet<PartyTab> = new Set<PartyTab>([
    'overview', 'invoicing', 'contacts', 'addresses', 'accounting',
  ])
  const allowedInitialTab = createMode
    ? 'overview'
    : (initialTab === 'wages' && !showWagesTab) ||
    (initialTab === 'payroll' && !showPayrollTab) ||
    (initialTab === 'activities' && !canReadActivities) ||
    (initialTab === 'relationship' && !showRelationshipTab) ||
    (initialTab === 'pulse' && (role !== 'customer' || payload.party.display_name === 'New party' || payload.party.display_name === 'New lead')) ||
    (initialTab === 'compliance' && !showComplianceTab) ||
    (initialTab === 'employment' && !showEmploymentTab)
      ? 'overview'
      : initialTab
  const [tab, setTab] = useState<PartyTab>(allowedInitialTab)
  // The Payroll tab's own sub-tab. Client-local like the rail: switching
  // never navigates, and every section below stays mounted (hidden) so
  // unsaved edits survive sub-tab switches. A ?partyTab=payroll deep link
  // lands on the tab with the General half showing.
  const [payrollSubTab, setPayrollSubTab] = useState<PayrollSubTab>('general')
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
  // through to Company for a customer/vendor/employee row.
  // OM-16: a role-kind label additionally needs its ACTIVE role row behind
  // it — the list's role badges derive from the same rows, so the drawer
  // must not claim "Vendor" the badges (and compliance) cannot see. A
  // stored role-kind with no backing role (rows predating the write guards)
  // falls back to Company, the product default for a party with no roles;
  // company/person need no backing and render as stored, even beside roles.
  const kindRoleBacked =
    kind === 'customer'
      ? payload.customer != null && payload.customer.is_active !== false
      : kind === 'vendor'
        ? payload.vendor != null && payload.vendor.is_active !== false
        : kind === 'employee'
          ? payload.employee != null && payload.employee.is_active !== false
          : true
  const effectiveKind = kindRoleBacked ? kind : 'company'
  const kindLabel = effectiveKind === 'person'
    ? t('kindPerson')
    : effectiveKind === 'customer'
      ? t('kindCustomer')
      : effectiveKind === 'vendor'
        ? t('kindVendor')
        : effectiveKind === 'employee'
          ? t('kindEmployee')
          : t('kindCompany')
  const [displayName, setDisplayName] = useState<string>(isPlaceholderName ? '' : (p.display_name ?? ''))
  const [legalName, setLegalName] = useState<string>(p.legal_name ?? '')
  const [shortCode, setShortCode] = useState<string>(p.short_code ?? '')
  const [email, setEmail] = useState<string>(p.email ?? '')
  const [phone, setPhone] = useState<string>(p.phone ?? '')
  const [website, setWebsite] = useState<string>(p.website ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(p.custom ?? {})
  // Unsaved-create defaults the record to active: the drawer opens on nothing
  // persisted, so deactivation lifecycle guards have nothing to evaluate yet.
  const [isActive, setIsActive] = useState<boolean>(createMode ? true : p.is_active === true)
  const returnHref = closeHref ?? basePath
  const requestIdRef = useRef<string | null>(null)
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
  // the next action or cancel — a toast alone once let a refused save read as a
  // successful save while the data was silently lost.
  const { busy, refusal, execute, clearRefusal, refuse } = useAppAction()

  // Existing parties default to read-only; creation flows can explicitly
  // request edit mode. Permission checks remain authoritative. Unsaved-create
  // opens editable: there is no persisted record to read yet.
  const [mode, setMode] = useState<DrawerMode>(
    createMode ? 'edit' : initialDrawerMode(initialMode, canManage),
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
          // Same kind-echo as vendor below: choosing Kind Customer in the
          // generic drawer repairs the orphan in the same audited save.
          enabled: forcesCustomerRole || kind === 'customer' ? true : customer.enabled,
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
          // OM-16: choosing Kind Vendor means the vendor role. A role-scoped
          // drawer forces its own role (first clause); otherwise the drawer
          // writes kind+role atomically through this same payload — the
          // server refuses an unbacked role-kind by name — so an explicit
          // kind choice enables its role instead of stranding Save on a
          // remedy the overview tab cannot reach. In create mode the choice
          // creates the backing row; in edit mode it repairs an orphan (a
          // legacy row whose kind outlived its role). An unchecked role box
          // beside a role-kind kind still sends enabled — kind is the master
          // switch, and the server forbids the split pairing anyway.
          enabled: role === 'vendor' || kind === 'vendor' ? true : vendor.enabled,
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
          // Same kind-echo as vendor: choosing Kind Employee in the generic
          // drawer repairs the orphan in the same audited save.
          enabled: role === 'employee' || kind === 'employee' ? true : employee.enabled,
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
  // Nested payroll profile / certificate drafts keep their own local state
  // outside savePayload; the tab reports their dirtiness here.
  const [payrollDirty, setPayrollDirty] = useState(false)
  if (prevSavePayload !== savePayload) {
    setPrevSavePayload(savePayload)
    if (skipDirty) setSkipDirty(false)
    else if (editable) setDirty(true)
  }
  // Identity mirror of the draft snapshot for in-flight edit detection (see
  // save/saveNew): a response may only mark clean the exact payload it
  // persisted, never edits typed while the request was in flight.
  const latestSavePayload = useRef(savePayload)
  useEffect(() => {
    latestSavePayload.current = savePayload
  })

  // A dirty editor never closes silently: the X button (via beforeClose)
  // and Cancel both ask first, so typed work survives a stray click.
  async function confirmDiscard() {
    if (mode !== 'edit' || (!dirty && !payrollDirty)) return true
    return confirmDialog({
      message: tc('feedback.unsavedChanges'),
      confirmLabel: tc('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  async function cancelWithConfirm() {
    if (!(await confirmDiscard())) return
    cancel()
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
    // Unsaved-create keeps related rows local: there is no persisted party to
    // PATCH, so the dialog confirms into form state and the single create
    // POST persists everything together. Zero writes here by construction.
    if (createMode) {
      if (kind === 'addresses') {
        const nextAddress = draft.row as AddressRow
        const base = (draft.index === null
          ? [...addresses, draft.row]
          : addresses.map((row, index) => index === draft.index ? draft.row : row)) as AddressRow[]
        setAddresses(base.map((row, index) => ({
          ...row,
          isDefaultBilling: nextAddress.isDefaultBilling === 'true' && index !== (draft.index ?? base.length - 1) ? 'false' : row.isDefaultBilling,
          isDefaultShipping: nextAddress.isDefaultShipping === 'true' && index !== (draft.index ?? base.length - 1) ? 'false' : row.isDefaultShipping,
        })))
        setAddressDraft(null)
      } else {
        const nextContact = draft.row as ContactRow
        const base = (draft.index === null
          ? [...contacts, draft.row]
          : contacts.map((row, index) => index === draft.index ? draft.row : row)) as ContactRow[]
        // Selecting a new primary is an explicit reassignment, matching the
        // persisted path below: untouched rows keep their flags.
        setContacts(base.map((row, index) => ({
          ...row,
          isPrimary: nextContact.isPrimary === 'true' && index !== (draft.index ?? base.length - 1) ? 'false' : row.isPrimary,
        })))
        setContactDraft(null)
      }
      return
    }
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

  /**
   * Unsaved-create Save: one idempotent POST carrying the whole form —
   * identity, roles, addresses, and contacts. The key is minted once per
   * drawer session, so a double-click or a retried request returns the same
   * party instead of a duplicate. Cancel/close before this point wrote
   * nothing — this is the first and only write.
   */
  async function saveNew() {
    // A blank display name must never persist a nameless record: fail fast
    // with an inline error instead of POSTing a request known to 422.
    if (!nameValid) {
      setNameError(true)
      setSaveState('error')
      refuse(t('nameRequired'), t('autosaveFailed'))
      return
    }
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID()
    setSaveState('saving')
    // Snapshot the exact submitted draft: edits typed while the POST is in
    // flight must not be marked clean by this response (see onOk).
    const submitted = savePayload
    // The create body is picked field-by-field: expectedUpdatedAt belongs to
    // the PATCH concurrency token (no row to version against here), and
    // isActive rides along explicitly — creates default to active.
    const createBody = {
      kind: savePayload.kind,
      displayName: savePayload.displayName,
      legalName: savePayload.legalName,
      shortCode: savePayload.shortCode,
      email: savePayload.email,
      phone: savePayload.phone,
      website: savePayload.website,
      custom: savePayload.custom,
      invoicingPreference: savePayload.invoicingPreference,
      subsidiaryId: savePayload.subsidiaryId,
      additionalSubsidiaryIds: savePayload.additionalSubsidiaryIds,
      roles: savePayload.roles,
      addresses: savePayload.addresses,
      contacts: savePayload.contacts,
      isActive,
    }
    const ok = await execute(
      () =>
        fetchAction(`/api/parties`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestIdRef.current! },
          body: JSON.stringify(createBody),
        }),
      {
        fallbackMessage: t('autosaveFailed'),
        successMessage: tc('feedback.saved'),
        onOk: (data) => {
          const createdId = (data as { party?: { id?: unknown } } | null)?.party?.id
          if (latestSavePayload.current !== submitted) {
            // Edited mid-flight: stay with the draft dirty, and retire the
            // idempotency key — a retry sends a changed payload, which must
            // never reuse the submitted key.
            requestIdRef.current = null
            setSaveState('dirty')
            return
          }
          setSaveState('saved')
          setDirty(false)
          if (typeof createdId === 'string' && createdId) {
            const separator = returnHref.includes('?') ? '&' : '?'
            router.replace(`${returnHref}${separator}party=${createdId}` as never)
          } else {
            router.push(returnHref as never)
          }
          router.refresh()
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

  async function save() {
    if (createMode) {
      await saveNew()
      return
    }
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
    // Snapshot the exact submitted draft: edits typed while the PATCH is in
    // flight must not be marked clean by this response (see onOk).
    const submitted = savePayload
    const ok = await execute(
      () =>
        fetchAction(`/api/parties/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...submitted, changeReason }),
        }),
      {
        fallbackMessage: t('autosaveFailed'),
        onOk: (data) => {
          const party = (data as { party?: { is_active?: unknown } } | null)?.party
          setIsActive(party?.is_active === true)
          if (latestSavePayload.current !== submitted) {
            // Edited mid-flight: the response persisted the earlier draft,
            // so the form stays dirty in edit mode instead of reading clean.
            setSaveState('dirty')
            return
          }
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
    // Unsaved-create Cancel writes nothing: there is no persisted row to
    // restore, so leave the URL (and the database) exactly as found.
    if (createMode) {
      clearRefusal()
      router.push(returnHref as never)
      return
    }
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
    // Activating is a drawer submit too: an operator who picks a subsidiary
    // and then activates without a prior save must not lose the choice —
    // the party would stay org-wide (NULL) and every later payroll-profile
    // default would fall through to the root entity's country. Only an
    // EXPLICIT choice rides along, never the root default, so activating an
    // org-wide party cannot silently re-scope it. Deactivation carries
    // status only.
    const initialSubsidiaryId = p.subsidiary_id ?? rootSubsidiaryId
    const activateCarriesSubsidiary =
      next && multiSubsidiary && subsidiaryId !== initialSubsidiaryId
    await execute(
      () =>
        fetchAction(`/api/parties/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            isActive: next,
            expectedUpdatedAt: p.updated_at,
            changeReason: reason,
            ...(activateCarriesSubsidiary
              ? {
                  subsidiaryId: subsidiaryId || null,
                  additionalSubsidiaryIds: [...additionalSubsidiaryIds].filter((id) => id !== subsidiaryId),
                }
              : {}),
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
  const partyFieldsId = useId()
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
    const controlId = `${partyFieldsId}-${placement.key}`
    const labelId = `${controlId}-label`
    const content = (() => {
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
    })()
    return <FieldControlAssociations controlId={controlId} labelId={labelId}>{content}</FieldControlAssociations>
  }
  // ONE rail, in reading order: what the account is, then how we sell to it,
  // then what we have done with it, then (appended by the shell) the record's
  // own evidence. These ride the shared flyout's strip as `detailTabs`, so
  // the shell renders no second strip above them.
  const allTabs: Array<{ key: PartyTab; label: string; count?: number }> = [
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
    ...(showWagesTab ? [{ key: 'wages' as const, label: t('tabs.wages') }] : []),
    ...(showPayrollTab ? [{ key: 'payroll' as const, label: t('tabs.payroll') }] : []),
    ...(showEmploymentTab ? [{ key: 'employment' as const, label: t('tabs.employment') }] : []),
    // Attachments and Audit trail close the rail. They are the shared shell's
    // own panels, so the shell appends them itself — listing them here would
    // duplicate the buttons.
  ]
  const tabs = allTabs.filter((item) => !createMode || CREATE_TABS.has(item.key))

  const selectForm = (formId: string) => {
    const next = new URLSearchParams(searchParams.toString())
    if (formId) next.set('partyForm', formId)
    else next.delete('partyForm')
    const query = next.toString()
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <TransactionDrawer
      closeHref={returnHref}
      beforeClose={confirmDiscard}
      recordId={createMode ? '' : String(p.id)}
      targetTable="parties"
      canEditAttachments={canManage && !createMode}
      showEvidenceTabs={!createMode}
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
      primaryAction={canManage ? <Button variant="outline" size="sm" disabled={busy} onClick={() => mode === 'edit' ? cancelWithConfirm() : setMode('edit')}>{mode === 'edit' ? tc('actions.cancel') : tc('actions.edit')}</Button> : undefined}
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
          {/* Activation targets a persisted row: unsaved-create carries its
              active default into the create POST instead. */}
          {!createMode && canManage ? isActive ? (
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
              <Button disabled={busy || (createMode && !nameValid)} onClick={save}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
            </div>
          ) : null}
        </div>
      }
    >
      <ActionAlert error={refusal} fallbackMessage={t('autosaveFailed')} title={t('saveFailedRetry')} className="mb-4" />
      <TabContent tabKey={tab}>
      <div className="space-y-7 p-1" inert={busy}>
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
          {createMode && editable ? (
            <div className={field}>
              <Label>{tc('labels.active')}</Label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className={checkboxClass} />
                <span className="text-sm">{isActive ? tc('status.active') : tc('status.inactive')}</span>
              </label>
            </div>
          ) : null}
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

        {tab === 'employment' && showEmploymentTab && hrm ? (
          hrm.employmentIds.length === 1 ? (
            <EmploymentTab employmentId={hrm.employmentIds[0] as string} canManageHrm={hrm.canManageHrm} canReadExits={hrm.canReadExits} canRecordExit={hrm.canRecordExit} canVerb={hrm.canVerb ?? false} departmentOptions={departments.map((option) => ({ value: option.id, label: option.label ?? option.name ?? option.id }))} />
          ) : hrm.employmentIds.length === 0 ? (
            <div className="space-y-2 p-1">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {th('employment.noRecord.title')}
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">{th('employment.noRecord.description')}</p>
            </div>
          ) : (
            <div className="space-y-2 p-1">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {th('employment.multiple.title')}
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {th('employment.multiple.description', { count: hrm.employmentIds.length })}
              </p>
            </div>
          )
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
      {/* Relationship, vendor bank accounts, and vendor compliance hold
          unsaved edits in local component state, so they stay mounted once
          visited (hidden, outside the remounting TabContent) instead of
          discarding input on every tab switch. Mounting stays lazy:
          an unvisited tab issues no requests until first opened. */}
      {showRelationshipTab && keptTabs.has('relationship') ? (
        <div hidden={tab !== 'relationship'} className="space-y-7 p-1">
          <PartyRelationshipSection partyId={String(p.id)} canManage={canManageCrmAccounts} />
        </div>
      ) : null}
      {(!role || role === 'vendor') && keptTabs.has('accounting') ? (
        <div hidden={tab !== 'accounting'} className="space-y-7 p-1">
          <BankAccountsPanel partyId={String(p.id)} initialAccounts={payload.bankAccounts} canManage={canManage} multiCurrency={multiCurrency} />
        </div>
      ) : null}
      {showComplianceTab && compliance && keptTabs.has('compliance') ? (
        <div hidden={tab !== 'compliance'} className="space-y-7 p-1">
          <VendorCompliancePanel
            partyId={String(p.id)}
            initialClassId={compliance.classId}
            classes={compliance.classes}
            canManage={canManageCompliance}
          />
        </div>
      ) : null}
      {/* Employee compensation tabs stay mounted once visited (hidden, outside
          the remounting TabContent) so switching tabs never discards their
          local edits — the payroll profile editor and wage-rate form hold
          unsaved state locally. Mounting stays lazy: an unvisited
          tab issues no requests until first opened. */}
      {role === 'employee' && canManageWages && keptTabs.has('wages') ? (
        <div hidden={tab !== 'wages'} className="space-y-7 p-1">
          <EmployeeWageRates partyId={String(p.id)} />
        </div>
      ) : null}
      {role === 'employee' && canManagePayroll && keptTabs.has('payroll') ? (
        <div hidden={tab !== 'payroll'} className="space-y-6 p-1">
          {/* The Payroll tab splits into sub-tabs on the shared drawer strip
              (the same primitive as the rail, not a second tab style). The
              profile editor mounts once inside PayrollProfileTab and switches
              halves by prop; every section stays mounted (hidden). */}
          <DrawerTabStrip
            tabs={[
              { key: 'general', label: t('payrollTabs.general') },
              { key: 'tax', label: t('payrollTabs.tax') },
              { key: 'banks', label: t('payrollTabs.banks') },
              { key: 'accounts', label: t('payrollTabs.accounts') },
            ]}
            activeKey={payrollSubTab}
            onSelect={(key) => setPayrollSubTab(key as PayrollSubTab)}
            ariaLabel={t('payrollTabs.ariaLabel')}
          />
          <PayrollProfileTab
            partyId={String(p.id)}
            partyName={String(p.display_name ?? '')}
            readOnly={!editable}
            section={payrollSubTab}
            onDirtyChange={setPayrollDirty}
          />
          {/* Pay banks (banked time, vacation, benefit recoup) belong beside
              the payroll profile — one home for this person's compensation. */}
          <div hidden={payrollSubTab !== 'banks'}>
            <EmployeeEntitlementBalances partyId={String(p.id)} readOnly={!editable} />
          </div>
          {/* Direct deposit: the same approval-gated bank accounts the AP
              side uses — the pay-run bank file only pays approved accounts. */}
          <div hidden={payrollSubTab !== 'accounts'}>
            <BankAccountsPanel
              partyId={String(p.id)}
              initialAccounts={payload.bankAccounts}
              canManage={canManage}
              multiCurrency={multiCurrency}
              readOnly={!editable}
            />
          </div>
        </div>
      ) : null}
    </TransactionDrawer>
  )
}

// Split from this file; the same exports stay available from this path.
export type { PartyTab } from './party-drawer-model'
export { formatCreditLimit, rememberDrawerTab } from './party-drawer-model'
export { ActivitySublist } from './PartyActivitySublist'
export { TransactionSublist } from './PartyTransactionSublist'
