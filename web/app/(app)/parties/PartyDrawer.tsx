'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Building2, CalendarDays, CircleDollarSign, FileText, Landmark, Plus, Search, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
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
  UrlDrawer,
  cn,
} from '@openbooks/ui'
import { InvoicingPreferenceFields, type InvoicingPref } from '../../../components/invoicing-preference-fields'
import { CustomFieldInputs, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { DocTypeBadge, docTypeMeta } from '../../../components/doc-type-badge'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { AuditTrailPanel } from '../../../components/audit-trail-panel'
import { EmployeeWageRates } from './EmployeeWageRates'
import { RateBookAssignmentSection } from './RateBookAssignmentSection'
import { ApprovalActions } from '../../../components/approval-actions'
import { FlowManualButtons } from '../../../components/flow-manual-buttons'
import { money } from '../../../lib/format'
import { countryOptions } from '../../../lib/countries'

interface Opt {
  id: string
  name?: string
  label?: string
  type?: string
}
interface PartyPayload {
  party: Record<string, any>
  customer: Record<string, any> | null
  vendor: Record<string, any> | null
  employee: Record<string, any> | null
  addresses: Record<string, any>[]
  contacts: Record<string, any>[]
  bankAccounts: Record<string, any>[]
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
  firstName: '', lastName: '', name: '', title: '', role: '', email: '', phone: '',
  mobilePhone: '', isPrimary: 'false', isActive: 'true',
})

export type PartyTab = 'overview' | 'transactions' | 'activities' | 'contacts' | 'addresses' | 'accounting' | 'wages' | 'audit'

const checkboxClass = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500'
const field = 'space-y-1.5'

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
  canManageWages = false,
  role,
  initialTab = 'overview',
  basePath = '/parties',
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
  /** admin.setup.manage — wage data is confidential; gates the Wages tab. */
  canManageWages?: boolean
  /** When set, the drawer was opened from a role-scoped list (Customers /
   *  Vendors / Employees): only that role's fields render — the underlying
   *  multi-role party model stays hidden from end users — and saving always
   *  keeps that role enabled. Omitted on the unified /parties directory. */
  role?: 'customer' | 'vendor' | 'employee'
  initialTab?: PartyTab
  basePath?: string
}) {
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const tInv = useTranslations('projects.invoicingPref')
  const locale = useLocale()
  const router = useRouter()
  const allowedInitialTab = initialTab === 'wages' && (role !== 'employee' || !canManageWages) ? 'overview' : initialTab
  const [tab, setTab] = useState<PartyTab>(allowedInitialTab)
  useEffect(() => setTab(allowedInitialTab), [allowedInitialTab])
  const p = payload.party
  const [invoicingPref, setInvoicingPref] = useState<InvoicingPref>((payload.party.invoicing_preference as InvoicingPref) ?? {})
  // 'New party' is the server-side draft sentinel stored in the DB — compare
  // and persist it verbatim; only the *displayed* fallback is translated.
  const isPlaceholderName = p.display_name === 'New party'

  // -- identity --------------------------------------------------------------
  const [kind, setKind] = useState<string>(p.kind ?? 'company')
  const [displayName, setDisplayName] = useState<string>(isPlaceholderName ? '' : (p.display_name ?? ''))
  const [legalName, setLegalName] = useState<string>(p.legal_name ?? '')
  const [shortCode, setShortCode] = useState<string>(p.short_code ?? '')
  const [email, setEmail] = useState<string>(p.email ?? '')
  const [phone, setPhone] = useState<string>(p.phone ?? '')
  const [website, setWebsite] = useState<string>(p.website ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(p.custom ?? {})
  const [isActive, setIsActive] = useState<boolean>(p.is_active === true)
  const multiSubsidiary = subsidiaries.filter((s) => !s.isElimination).length > 1
  const rootSubsidiaryId = subsidiaries.find((s) => s.parentId === null)?.id ?? ''
  const [subsidiaryId, setSubsidiaryId] = useState<string>(p.subsidiary_id ?? rootSubsidiaryId)
  const [additionalSubsidiaryIds, setAdditionalSubsidiaryIds] = useState<Set<string>>(
    new Set(payload.additionalSubsidiaryIds ?? []),
  )

  // -- roles -------------------------------------------------------------
  const [customer, setCustomer] = useState({
    enabled: !!payload.customer && payload.customer.is_active !== false,
    paymentTermsId: payload.customer?.payment_terms_id ?? '',
    creditLimit: payload.customer?.credit_limit != null ? Number(payload.customer.credit_limit).toFixed(2) : '',
    currency: payload.customer?.currency ?? '',
    arAccountId: payload.customer?.ar_account_id ?? '',
    salesRepId: payload.customer?.sales_rep_id ?? '',
    taxCodeId: payload.customer?.tax_code_id ?? '',
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
    payload.addresses.map((a) => ({
      label: a.label ?? '',
      line1: a.line1 ?? '',
      line2: a.line2 ?? '',
      city: a.city ?? '',
      region: a.region ?? '',
      postalCode: a.postal_code ?? '',
      country: a.country ?? '',
      isDefaultBilling: a.is_default_billing === true ? 'true' : 'false',
      isDefaultShipping: a.is_default_shipping === true ? 'true' : 'false',
    })),
  )
  const [contacts, setContacts] = useState<ContactRow[]>(
    payload.contacts.map((contact) => ({
      firstName: contact.first_name ?? '', lastName: contact.last_name ?? '', name: contact.name ?? '',
      title: contact.title ?? '', role: contact.role ?? '', email: contact.email ?? '', phone: contact.phone ?? '',
      mobilePhone: contact.mobile_phone ?? '', isPrimary: contact.is_primary === true ? 'true' : 'false',
      isActive: contact.is_active === false ? 'false' : 'true',
    })),
  )

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // source platform-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // — even for drafts — with an Edit button in the header. Save is EXPLICIT —
  // one Save button, no per-field autosave.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canManage

  const nameValid = displayName.trim().length > 0 && displayName.trim() !== 'New party'

  // -- explicit save (no autosave) -------------------------------------------
  const savePayload = useMemo(
    () => ({
      kind,
      displayName: displayName.trim() || (isActive ? displayName : 'New party'),
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
          enabled: role === 'customer' ? true : customer.enabled,
          paymentTermsId: customer.paymentTermsId || null,
          creditLimit: customer.creditLimit || null,
          currency: customer.currency || null,
          arAccountId: customer.arAccountId || null,
          salesRepId: customer.salesRepId || null,
          taxCodeId: customer.taxCodeId || null,
        },
        vendor: {
          enabled: role === 'vendor' ? true : vendor.enabled,
          paymentMethod: vendor.paymentMethod || null,
          eftNotificationEmail: vendor.eftNotificationEmail || null,
          paymentTermsId: vendor.paymentTermsId || null,
          currency: vendor.currency || null,
          is1099OrT4a: vendor.is1099OrT4a,
          apAccountId: vendor.apAccountId || null,
          defaultExpenseAccountId: vendor.defaultExpenseAccountId || null,
          taxCodeId: vendor.taxCodeId || null,
        },
        employee: {
          enabled: role === 'employee' ? true : employee.enabled,
          employeeNumber: employee.employeeNumber || null,
          jobTitle: employee.jobTitle || null,
          departmentId: employee.departmentId || null,
          tradeId: employee.tradeId || null,
          workerCompGroupId: employee.workerCompGroupId || null,
          hiredOn: employee.hiredOn || null,
        },
      },
      addresses: addresses.map((address) => ({
        ...address,
        isDefaultBilling: address.isDefaultBilling === 'true',
        isDefaultShipping: address.isDefaultShipping === 'true',
      })),
      contacts: contacts.map((contact) => ({
        ...contact,
        isPrimary: contact.isPrimary === 'true',
        isActive: contact.isActive === 'true',
      })),
    }),
    [kind, displayName, legalName, shortCode, email, phone, website, customValues, invoicingPref, subsidiaryId, additionalSubsidiaryIds, multiSubsidiary, customer, vendor, employee, addresses, contacts, isActive, role],
  )
  // Track unsaved edits (no autosave — Save is an explicit button).
  const [dirty, setDirty] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePayload])

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
      creditLimit: payload.customer?.credit_limit != null ? Number(payload.customer.credit_limit).toFixed(2) : '',
      currency: payload.customer?.currency ?? '',
      arAccountId: payload.customer?.ar_account_id ?? '',
      salesRepId: payload.customer?.sales_rep_id ?? '',
      taxCodeId: payload.customer?.tax_code_id ?? '',
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
    setAddresses(
      payload.addresses.map((a) => ({
        label: a.label ?? '',
        line1: a.line1 ?? '',
        line2: a.line2 ?? '',
        city: a.city ?? '',
        region: a.region ?? '',
        postalCode: a.postal_code ?? '',
        country: a.country ?? '',
        isDefaultBilling: a.is_default_billing === true ? 'true' : 'false',
        isDefaultShipping: a.is_default_shipping === true ? 'true' : 'false',
      })),
    )
    setContacts(payload.contacts.map((contact) => ({
      firstName: contact.first_name ?? '', lastName: contact.last_name ?? '', name: contact.name ?? '',
      title: contact.title ?? '', role: contact.role ?? '', email: contact.email ?? '', phone: contact.phone ?? '',
      mobilePhone: contact.mobile_phone ?? '', isPrimary: contact.is_primary === true ? 'true' : 'false',
      isActive: contact.is_active === false ? 'false' : 'true',
    })))
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`/api/parties/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savePayload),
    })
    if (res.ok) {
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('autosaveFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function setActiveState(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/parties/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: next }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('updateFailed'))
    else {
      setIsActive(next)
      toast.success(next ? t('activated') : t('deactivated'))
    }
    setBusy(false)
    router.refresh()
  }

  const ro = !editable
  const yesNo = useMemo(() => [
    { value: 'false', label: tc('labels.no') },
    { value: 'true', label: tc('labels.yes') },
  ], [tc])
  const countries = useMemo(() => countryOptions(locale), [locale])
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
  const tabs: Array<{ key: PartyTab; label: string; count?: number }> = [
    { key: 'overview', label: t('tabs.overview') },
    { key: 'transactions', label: t('tabs.transactions'), count: payload.transactionSummary.count },
    ...(role === 'customer' && canReadActivities ? [{ key: 'activities' as const, label: t('tabs.activities') }] : []),
    { key: 'contacts', label: t('tabs.contacts'), count: contacts.length },
    { key: 'addresses', label: t('tabs.addresses'), count: addresses.length },
    { key: 'accounting', label: t('tabs.accounting') },
    ...(role === 'employee' && canManageWages ? [{ key: 'wages' as const, label: t('tabs.wages') }] : []),
    { key: 'audit', label: tc('auditTrail.tabs.audit') },
  ]

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      contextualReturn={false}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{displayName.trim() || t('newPartyFallback')}</span>
          <Badge variant={isActive ? 'success' : 'outline'}>{isActive ? tc('status.active') : tc('status.inactive')}</Badge>
        </span>
      }
      description={mode === 'edit' ? tc('feedback.editingHint') : undefined}
      subtabs={
        <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={t('tabs.ariaLabel')}>
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                tab === item.key
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200',
              )}
            >
              {item.label}
              {item.count != null ? <span className="text-xs tabular-nums text-slate-400">{item.count}</span> : null}
            </button>
          ))}
        </nav>
      }
      headerActions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tc('actions.saving') : tc('actions.save')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tc('actions.cancel')}
              </Button>
            </>
          ) : canManage ? (
            <>
              <Button variant="outline" onClick={() => setMode('edit')}>
                {tc('actions.edit')}
              </Button>
              {isActive ? (
                <Button variant="outline" disabled={busy} onClick={() => setActiveState(false)}>
                  {t('deactivate')}
                </Button>
              ) : (
                <>
                  {!nameValid ? (
                    <span className="text-xs text-slate-500 dark:text-slate-400">{t('nameToActivate')}</span>
                  ) : null}
                  <Button disabled={busy || !nameValid} onClick={() => setActiveState(true)}>
                    {t('activate')}
                  </Button>
                </>
              )}
            </>
          ) : null}
        </>
      }
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
        </div>
      }
    >
      <TabContent tabKey={tab}>
      <div className="space-y-7 p-1">
        {tab === 'overview' ? (
          <>
          <PartySummary payload={payload} />
        {/* -- identity ------------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={field}>
            <Label>{t('kind')}</Label>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} disabled={ro}>
              <option value="company">{t('kindCompany')}</option>
              <option value="person">{t('kindPerson')}</option>
            </Select>
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {t('displayName')}<span className="text-red-500"> *</span>
            </Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={kind === 'person' ? t('personNamePlaceholder') : t('companyNamePlaceholder')}
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>{t('shortCode')}</Label>
            <Input
              value={shortCode}
              onChange={(e) => setShortCode(e.target.value)}
              className="font-mono"
              placeholder={t('shortCodePlaceholder')}
              disabled={ro}
            />
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{t('legalName')}</Label>
            <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} disabled={ro} />
          </div>
          <div className={field}>
            <Label>{tc('labels.email')}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={ro} />
          </div>
          <div className={field}>
            <Label>{t('phone')}</Label>
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={ro} />
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>{t('website')}</Label>
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={t('websitePlaceholder')} disabled={ro} />
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
                <Select value={subsidiaryId} onChange={(e) => setSubsidiaryId(e.target.value)} disabled={ro}>
                  {subsidiaries.filter((s) => !s.isElimination).map((s) => (
                    <option key={s.id} value={s.id}>{`${'— '.repeat(s.depth)}${s.name ?? ''}`}</option>
                  ))}
                </Select>
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('primarySubsidiaryHint')}</p>
              </div>
              <div className={field}>
                <Label>{t('additionalSubsidiaries')}</Label>
                <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                  {subsidiaries.filter((s) => !s.isElimination && s.id !== subsidiaryId).map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-center gap-2.5 py-1.5">
                      <input
                        type="checkbox"
                        checked={additionalSubsidiaryIds.has(s.id)}
                        disabled={ro}
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
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('additionalSubsidiariesHint')}</p>
              </div>
            </div>
          </section>
        ) : null}

          </>
        ) : null}

        {/* -- roles ------------------------------------------------------
             Role-scoped open (Customers/Vendors/Employees list): only that
             role's details render, with no enable checkbox — the multi-role
             party model is an internal abstraction. The unified /parties
             directory (no `role`) keeps the full checkbox view. */}
        {tab === 'accounting' ? (
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
                <div className={field}>
                  <Label>{tc('labels.currency')}</Label>
                  <Input
                    maxLength={3}
                    className="font-mono uppercase"
                    placeholder={t('currencyPlaceholder')}
                    value={customer.currency}
                    onChange={(e) => setCustomer({ ...customer, currency: e.target.value.toUpperCase() })}
                    disabled={ro}
                  />
                </div>
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
              </div>
              <div className="mt-4 space-y-2">
                <div>
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{tInv('heading')}</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{tInv('customerHint')}</p>
                </div>
                <InvoicingPreferenceFields value={invoicingPref} onChange={setInvoicingPref} disabled={ro} />
              </div>
              {role === 'customer' && !isPlaceholderName ? (
                <RateBookAssignmentSection scope="customer" scopeId={String(p.id)} />
              ) : null}
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
                <div className={field}>
                  <Label>{tc('labels.currency')}</Label>
                  <Input
                    maxLength={3}
                    className="font-mono uppercase"
                    placeholder={t('currencyPlaceholder')}
                    value={vendor.currency}
                    onChange={(e) => setVendor({ ...vendor, currency: e.target.value.toUpperCase() })}
                    disabled={ro}
                  />
                </div>
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
                <div className={field}>
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
                </div>
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

        {tab === 'transactions' ? <TransactionSublist partyId={String(p.id)} role={role} /> : null}
        {tab === 'activities' && role === 'customer' && canReadActivities ? <ActivitySublist partyId={String(p.id)} /> : null}

        {tab === 'contacts' ? (
          <section className="space-y-3">
            <SublistHeading title={t('contactsHeading')} description={t('contactsDescription')} icon={<Users size={16} />} />
            {contacts.length === 0 && ro ? (
              <SublistEmpty icon={<Users size={22} />} text={t('noContacts')} />
            ) : ro ? (
              <ReadOnlyLineSublist columns={contactColumns} rows={contacts} searchPlaceholder={t('contactSearch')} />
            ) : (
              <LineGrid<ContactRow>
                columns={contactColumns}
                rows={contacts}
                onRowsChange={setContacts}
                emptyRow={emptyContact}
                minRows={0}
                readOnly={ro}
                addLabel={t('addContact')}
              />
            )}
          </section>
        ) : null}

        {tab === 'addresses' ? (
          <section className="space-y-3">
            <SublistHeading title={t('addressesHeading')} description={t('addressesDescription')} icon={<Building2 size={16} />} />
            {addresses.length === 0 && ro ? (
              <SublistEmpty icon={<Building2 size={22} />} text={t('noAddresses')} />
            ) : ro ? (
              <ReadOnlyLineSublist columns={addressColumns} rows={addresses} searchPlaceholder={t('addressSearch')} />
            ) : (
              <LineGrid<AddressRow>
                columns={addressColumns}
                rows={addresses}
                onRowsChange={setAddresses}
                emptyRow={emptyAddress}
                minRows={0}
                readOnly={ro}
                addLabel={t('addAddress')}
              />
            )}
          </section>
        ) : null}

        {tab === 'accounting' ? (
          <BankAccountsPanel partyId={String(p.id)} initialAccounts={payload.bankAccounts} canManage={canManage} />
        ) : null}

        {tab === 'wages' && role === 'employee' && canManageWages ? <EmployeeWageRates partyId={String(p.id)} /> : null}
        {tab === 'audit' ? <AuditTrailPanel table="parties" recordId={String(p.id)} /> : null}
      </div>
      </TabContent>
    </UrlDrawer>
  )
}

function PartySummary({ payload }: { payload: PartyPayload }) {
  const t = useTranslations('parties.drawer')
  const summary = payload.transactionSummary
  const primaryCurrency = summary.currencies.length === 1 ? summary.currencies[0] : null
  const cards = [
    { label: t('summary.transactions'), value: String(summary.count), icon: <FileText size={17} /> },
    { label: t('summary.openTransactions'), value: String(summary.openCount), icon: <CircleDollarSign size={17} /> },
    {
      label: t('summary.openBalance'),
      value: primaryCurrency ? `${money(primaryCurrency.openBalance)} ${primaryCurrency.currency}` : t('summary.multipleCurrencies'),
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
}: {
  columns: LineGridColumn<Row>[]
  rows: Row[]
  searchPlaceholder: string
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
        <LineGrid<Row> columns={columns} rows={shown} onRowsChange={() => undefined} emptyRow={() => ({} as Row)} readOnly minRows={0} />
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
}

const emptyBankDraft = (): BankAccountDraft => ({
  id: null, bankName: '', country: '', currency: '', routingNumber: '', branchNumber: '',
  accountNumber: '', routingBase: {}, lastFour: '',
})

function BankAccountsPanel({
  partyId,
  initialAccounts,
  canManage,
}: {
  partyId: string
  initialAccounts: Record<string, any>[]
  canManage: boolean
}) {
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const [accounts, setAccounts] = useState(initialAccounts)
  const [draft, setDraft] = useState<BankAccountDraft | null>(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const perPage = 10
  const countries = useMemo(() => countryOptions(locale), [locale])

  const filtered = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase()
    if (!needle) return accounts
    return accounts.filter((account) => [account.bank_name, account.country, account.currency, account.account_last_four, ...Object.values(account.routing ?? {})]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)))
  }, [accounts, q])
  const pages = Math.max(1, Math.ceil(filtered.length / perPage))
  const shown = filtered.slice((page - 1) * perPage, page * perPage)

  function edit(account: Record<string, any>) {
    const routing = (account.routing ?? {}) as Record<string, string>
    setDraft({
      id: String(account.id), bankName: account.bank_name ?? '', country: account.country ?? '',
      currency: account.currency ?? '',
      routingNumber: routing.routingNumber ?? routing.institution ?? '',
      branchNumber: routing.branchNumber ?? routing.transit ?? '',
      accountNumber: '', routingBase: routing, lastFour: account.account_last_four ?? '',
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
      toast.error(t('bankAccountValidation.bankName'))
      return
    }
    if (!draft.id && draft.accountNumber.trim().length < 4) {
      toast.error(t('bankAccountValidation.accountNumber'))
      return
    }
    if (draft.currency && !/^[A-Za-z]{3}$/.test(draft.currency)) {
      toast.error(t('bankAccountValidation.currency'))
      return
    }
    const routing = { ...draft.routingBase }
    delete routing.institution
    delete routing.transit
    delete routing.routingNumber
    delete routing.branchNumber
    if (draft.routingNumber.trim()) routing.routingNumber = draft.routingNumber.trim()
    if (draft.branchNumber.trim()) routing.branchNumber = draft.branchNumber.trim()
    const body = {
      bankName: draft.bankName.trim(), country: draft.country.trim() || null,
      currency: draft.currency.trim().toUpperCase() || null, routing,
      ...(draft.accountNumber.trim() ? { accountNumber: draft.accountNumber.trim() } : {}),
    }
    setBusy(true)
    try {
      const url = draft.id
        ? `/api/parties/${partyId}/bank-accounts?accountId=${encodeURIComponent(draft.id)}`
        : `/api/parties/${partyId}/bank-accounts`
      const response = await fetch(url, {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? t('bankAccountSaveFailed'))
      setDraft(null)
      await refreshAccounts()
      toast.success(t(draft.id ? 'bankAccountUpdated' : 'bankAccountAdded'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('bankAccountSaveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = (account: Record<string, any>) => {
    const status = String(account.approval_status ?? (account.approved_at ? 'approved' : 'pending'))
    if (status === 'approved') return tc('status.approved')
    if (status === 'rejected') return tc('status.rejected')
    return tc('status.pendingApproval')
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SublistHeading title={t('bankAccountsHeading')} description={t('bankAccountsDescription')} icon={<Landmark size={16} />} />
        {canManage && !draft ? <Button variant="outline" size="sm" onClick={() => setDraft(emptyBankDraft())}><Plus size={14} />{t('addBankAccount')}</Button> : null}
      </div>

      {draft ? (
        <div className="space-y-4 rounded-lg border border-teal-200 bg-teal-50/40 p-4 dark:border-teal-900 dark:bg-teal-950/20">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold">{draft.id ? t('editBankAccount') : t('addBankAccount')}</h4>
            <Badge variant="warning">{tc('status.pendingApproval')}</Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className={field}><Label>{t('bankName')}</Label><Input value={draft.bankName} onChange={(event) => setDraft({ ...draft, bankName: event.target.value })} /></div>
            <div className={field}><Label>{t('country')}</Label><SearchSelect value={draft.country} onChange={(country) => setDraft({ ...draft, country })} options={countries} sheetTitle={t('country')} clearable ariaLabel={t('country')} /></div>
            <div className={field}><Label>{tc('labels.currency')}</Label><Input maxLength={3} className="font-mono uppercase" value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })} /></div>
            <div className={field}><Label>{t('routingNumber')}</Label><Input className="font-mono" value={draft.routingNumber} onChange={(event) => setDraft({ ...draft, routingNumber: event.target.value })} /></div>
            <div className={field}><Label>{t('branchNumber')}</Label><Input className="font-mono" value={draft.branchNumber} onChange={(event) => setDraft({ ...draft, branchNumber: event.target.value })} /></div>
            <div className={field}>
              <Label>{t('accountNumber')}</Label>
              <Input type="password" autoComplete="off" className="font-mono" value={draft.accountNumber} onChange={(event) => setDraft({ ...draft, accountNumber: event.target.value })} placeholder={draft.id ? t('accountNumberUnchanged', { lastFour: draft.lastFour }) : undefined} />
            </div>
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-300">{t('bankAccountApprovalNote')}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>{tc('actions.cancel')}</Button>
            <Button disabled={busy} onClick={saveBankAccount}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
          </div>
        </div>
      ) : null}

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
                  <TableCell><Badge variant={account.approval_status === 'approved' || account.approved_at ? 'success' : account.approval_status === 'rejected' ? 'outline' : 'warning'}>{statusLabel(account)}</Badge></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <FlowManualButtons subjectKind="party_bank_account" subjectId={String(account.id)} />
                      <ApprovalActions subjectKind="party_bank_account" subjectId={String(account.id)} />
                      {canManage ? <Button variant="ghost" size="sm" onClick={() => edit(account)}>{tc('actions.edit')}</Button> : null}
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

function ActivitySublist({ partyId }: { partyId: string }) {
  const t = useTranslations('parties.drawer')
  const tcrm = useTranslations('crm')
  const tc = useTranslations('common')
  const locale = useLocale()
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
  return (
    <section className="space-y-3">
      <SublistHeading title={tcrm('activities.title')} description={tcrm('activities.description')} icon={<CalendarDays size={16} />} />
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
                  <TableCell><Link href={`/crm/activities?activity=${row.id}`} className="font-semibold text-teal-700 hover:underline dark:text-teal-300">{row.subject}</Link></TableCell>
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
                  <TableCell className="text-right tabular-nums">{money(row.total)} <span className="text-xs text-slate-400">{row.currency}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{row.open_balance == null ? '—' : money(row.open_balance)}</TableCell>
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
