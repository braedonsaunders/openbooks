'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { CustomFieldInputs, type CustomFieldDefClient } from '../../../components/custom-field-inputs'

interface Opt {
  id: string
  name?: string
}
interface PartyPayload {
  party: Record<string, any>
  customer: Record<string, any> | null
  vendor: Record<string, any> | null
  employee: Record<string, any> | null
  addresses: Record<string, any>[]
  bankAccounts: Record<string, any>[]
}
interface AddressRow {
  label: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  country: string
  isDefaultBilling: boolean
  isDefaultShipping: boolean
}

const PAYMENT_METHOD_OPTIONS = [
  { value: 'eft', label: 'EFT' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
]

const emptyAddress = (): AddressRow => ({
  label: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  isDefaultBilling: false,
  isDefaultShipping: false,
})

const checkboxClass = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500'
const field = 'space-y-1.5'

export function PartyDrawer({
  payload,
  paymentTerms,
  departments,
  trades,
  fieldDefs,
  canManage,
}: {
  payload: PartyPayload
  paymentTerms: Opt[]
  departments: Opt[]
  trades: Opt[]
  fieldDefs: CustomFieldDefClient[]
  canManage: boolean
}) {
  const router = useRouter()
  const p = payload.party
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

  // -- roles -------------------------------------------------------------
  const [customer, setCustomer] = useState({
    enabled: !!payload.customer && payload.customer.is_active !== false,
    paymentTermsId: payload.customer?.payment_terms_id ?? '',
    creditLimit: payload.customer?.credit_limit != null ? Number(payload.customer.credit_limit).toFixed(2) : '',
    currency: payload.customer?.currency ?? '',
  })
  const [vendor, setVendor] = useState({
    enabled: !!payload.vendor && payload.vendor.is_active !== false,
    paymentMethod: payload.vendor?.payment_method ?? '',
    eftNotificationEmail: payload.vendor?.eft_notification_email ?? '',
    paymentTermsId: payload.vendor?.payment_terms_id ?? '',
    currency: payload.vendor?.currency ?? '',
    is1099OrT4a: payload.vendor?.is_t4a === true,
  })
  const [employee, setEmployee] = useState({
    enabled: !!payload.employee && payload.employee.is_active !== false,
    employeeNumber: payload.employee?.employee_number ?? '',
    departmentId: payload.employee?.department_id ?? '',
    tradeId: payload.employee?.trade_id ?? '',
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
      isDefaultBilling: a.is_default_billing === true,
      isDefaultShipping: a.is_default_shipping === true,
    })),
  )
  function setAddress(i: number, patch: Partial<AddressRow>) {
    setAddresses((rows) =>
      rows.map((row, j) => {
        if (j === i) return { ...row, ...patch }
        // a party has at most one default billing / shipping address
        const cleared = { ...row }
        if (patch.isDefaultBilling) cleared.isDefaultBilling = false
        if (patch.isDefaultShipping) cleared.isDefaultShipping = false
        return cleared
      }),
    )
  }

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  const nameValid = displayName.trim().length > 0 && displayName.trim() !== 'New party'

  // -- autosave (debounced PATCH) ------------------------------------------
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
      roles: {
        customer: {
          enabled: customer.enabled,
          paymentTermsId: customer.paymentTermsId || null,
          creditLimit: customer.creditLimit || null,
          currency: customer.currency || null,
        },
        vendor: {
          enabled: vendor.enabled,
          paymentMethod: vendor.paymentMethod || null,
          eftNotificationEmail: vendor.eftNotificationEmail || null,
          paymentTermsId: vendor.paymentTermsId || null,
          currency: vendor.currency || null,
          is1099OrT4a: vendor.is1099OrT4a,
        },
        employee: {
          enabled: employee.enabled,
          employeeNumber: employee.employeeNumber || null,
          departmentId: employee.departmentId || null,
          tradeId: employee.tradeId || null,
          hiredOn: employee.hiredOn || null,
        },
      },
      addresses,
    }),
    [kind, displayName, legalName, shortCode, email, phone, website, customValues, customer, vendor, employee, addresses, isActive],
  )
  const first = useRef(true)
  useEffect(() => {
    if (!canManage) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/parties/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload),
      })
      if (res.ok) {
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePayload, canManage])

  async function setActiveState(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/parties/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: next }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Update failed')
    else {
      setIsActive(next)
      toast.success(next ? 'Party activated' : 'Party deactivated')
    }
    setBusy(false)
    router.refresh()
  }

  const ro = !canManage

  return (
    <UrlDrawer
      open
      closeHref="/parties"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{displayName.trim() || 'New party'}</span>
          <Badge variant={isActive ? 'success' : 'outline'}>{isActive ? 'Active' : 'Inactive'}</Badge>
        </span>
      }
      description={canManage ? 'Changes save automatically.' : undefined}
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {canManage
              ? saveState === 'saved'
                ? 'All changes saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'error'
                    ? 'Save failed — fix and retry'
                    : 'Unsaved changes…'
              : null}
          </span>
          <span className="flex-1" />
          {canManage ? (
            isActive ? (
              <Button variant="outline" disabled={busy} onClick={() => setActiveState(false)}>
                Deactivate
              </Button>
            ) : (
              <>
                {!nameValid ? (
                  <span className="text-xs text-slate-500 dark:text-slate-400">Name the party to activate it</span>
                ) : null}
                <Button disabled={busy || !nameValid} onClick={() => setActiveState(true)}>
                  Activate
                </Button>
              </>
            )
          ) : null}
        </div>
      }
    >
      <div className="space-y-7 p-1">
        {/* -- identity ------------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={field}>
            <Label>Kind</Label>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} disabled={ro}>
              <option value="company">Company</option>
              <option value="person">Person</option>
            </Select>
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>
              Display name<span className="text-red-500"> *</span>
            </Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={kind === 'person' ? 'Full name…' : 'Company name…'}
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>Short code</Label>
            <Input
              value={shortCode}
              onChange={(e) => setShortCode(e.target.value)}
              className="font-mono"
              placeholder="ACME"
              disabled={ro}
            />
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>Legal name</Label>
            <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} disabled={ro} />
          </div>
          <div className={field}>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={ro} />
          </div>
          <div className={field}>
            <Label>Phone</Label>
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={ro} />
          </div>
          <div className={`${field} lg:col-span-2`}>
            <Label>Website</Label>
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" disabled={ro} />
          </div>
        </section>

        <CustomFieldInputs defs={fieldDefs} values={customValues} onChange={setCustomValues} readOnly={ro} />

        {/* -- roles ------------------------------------------------------ */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Roles</h3>

          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={customer.enabled}
                onChange={(e) => setCustomer({ ...customer, enabled: e.target.checked })}
                disabled={ro}
                className={checkboxClass}
              />
              <span className="text-sm font-medium">Customer</span>
            </label>
            {customer.enabled ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className={field}>
                  <Label>Payment terms</Label>
                  <Select
                    value={customer.paymentTermsId}
                    onChange={(e) => setCustomer({ ...customer, paymentTermsId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {paymentTerms.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={field}>
                  <Label>Credit limit</Label>
                  <Input
                    inputMode="decimal"
                    className="text-right tabular-nums"
                    value={customer.creditLimit}
                    onChange={(e) => setCustomer({ ...customer, creditLimit: e.target.value })}
                    disabled={ro}
                  />
                </div>
                <div className={field}>
                  <Label>Currency</Label>
                  <Input
                    maxLength={3}
                    className="font-mono uppercase"
                    placeholder="CAD"
                    value={customer.currency}
                    onChange={(e) => setCustomer({ ...customer, currency: e.target.value.toUpperCase() })}
                    disabled={ro}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={vendor.enabled}
                onChange={(e) => setVendor({ ...vendor, enabled: e.target.checked })}
                disabled={ro}
                className={checkboxClass}
              />
              <span className="text-sm font-medium">Vendor</span>
            </label>
            {vendor.enabled ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className={field}>
                  <Label>Payment method</Label>
                  <Select
                    value={vendor.paymentMethod}
                    onChange={(e) => setVendor({ ...vendor, paymentMethod: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {PAYMENT_METHOD_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={`${field} sm:col-span-2`}>
                  <Label>EFT notification email</Label>
                  <Input
                    type="email"
                    value={vendor.eftNotificationEmail}
                    onChange={(e) => setVendor({ ...vendor, eftNotificationEmail: e.target.value })}
                    disabled={ro}
                  />
                </div>
                <div className={field}>
                  <Label>Payment terms</Label>
                  <Select
                    value={vendor.paymentTermsId}
                    onChange={(e) => setVendor({ ...vendor, paymentTermsId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {paymentTerms.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={field}>
                  <Label>Currency</Label>
                  <Input
                    maxLength={3}
                    className="font-mono uppercase"
                    placeholder="CAD"
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
                  <span className="text-sm">1099 / T4A reportable</span>
                </label>
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={employee.enabled}
                onChange={(e) => setEmployee({ ...employee, enabled: e.target.checked })}
                disabled={ro}
                className={checkboxClass}
              />
              <span className="text-sm font-medium">Employee</span>
            </label>
            {employee.enabled ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                <div className={field}>
                  <Label>Employee #</Label>
                  <Input
                    className="font-mono"
                    value={employee.employeeNumber}
                    onChange={(e) => setEmployee({ ...employee, employeeNumber: e.target.value })}
                    disabled={ro}
                  />
                </div>
                <div className={field}>
                  <Label>Department</Label>
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
                  <Label>Trade</Label>
                  <Select
                    value={employee.tradeId}
                    onChange={(e) => setEmployee({ ...employee, tradeId: e.target.value })}
                    disabled={ro}
                  >
                    <option value="">—</option>
                    {trades.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className={field}>
                  <Label>Hired on</Label>
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
        </section>

        {/* -- addresses ----------------------------------------------- */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Addresses</h3>
            {!ro ? (
              <Button variant="outline" size="sm" onClick={() => setAddresses([...addresses, emptyAddress()])}>
                <Plus size={14} /> Add address
              </Button>
            ) : null}
          </div>
          {addresses.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No addresses on file.</p>
          ) : (
            addresses.map((a, i) => (
              <div key={i} className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className={field}>
                    <Label>Label</Label>
                    <Input
                      placeholder="Head office"
                      value={a.label}
                      onChange={(e) => setAddress(i, { label: e.target.value })}
                      disabled={ro}
                    />
                  </div>
                  <div className={`${field} sm:col-span-2`}>
                    <Label>Line 1</Label>
                    <Input value={a.line1} onChange={(e) => setAddress(i, { line1: e.target.value })} disabled={ro} />
                  </div>
                  <div className={`${field} sm:col-span-3`}>
                    <Label>Line 2</Label>
                    <Input value={a.line2} onChange={(e) => setAddress(i, { line2: e.target.value })} disabled={ro} />
                  </div>
                  <div className={field}>
                    <Label>City</Label>
                    <Input value={a.city} onChange={(e) => setAddress(i, { city: e.target.value })} disabled={ro} />
                  </div>
                  <div className={field}>
                    <Label>Province / state</Label>
                    <Input value={a.region} onChange={(e) => setAddress(i, { region: e.target.value })} disabled={ro} />
                  </div>
                  <div className={field}>
                    <Label>Postal code</Label>
                    <Input
                      value={a.postalCode}
                      onChange={(e) => setAddress(i, { postalCode: e.target.value })}
                      disabled={ro}
                    />
                  </div>
                  <div className={field}>
                    <Label>Country</Label>
                    <Input value={a.country} onChange={(e) => setAddress(i, { country: e.target.value })} disabled={ro} />
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={a.isDefaultBilling}
                      onChange={(e) => setAddress(i, { isDefaultBilling: e.target.checked })}
                      disabled={ro}
                      className={checkboxClass}
                    />
                    <span className="text-sm">Default billing</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={a.isDefaultShipping}
                      onChange={(e) => setAddress(i, { isDefaultShipping: e.target.checked })}
                      disabled={ro}
                      className={checkboxClass}
                    />
                    <span className="text-sm">Default shipping</span>
                  </label>
                  <span className="flex-1" />
                  {!ro ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAddresses(addresses.filter((_, j) => j !== i))}
                      aria-label="Remove address"
                    >
                      <Trash2 size={14} /> Remove
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </section>

        {/* -- bank accounts (read-only in the directory) ---------------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Bank accounts</h3>
          {payload.bankAccounts.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No bank accounts on file.</p>
          ) : (
            <div className="space-y-2">
              {payload.bankAccounts.map((b) => (
                <div
                  key={String(b.id)}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"
                >
                  <span className="text-sm font-medium">{b.bank_name ?? 'Bank account'}</span>
                  {b.account_last_four ? (
                    <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
                      ····{String(b.account_last_four)}
                    </span>
                  ) : null}
                  {b.currency ? (
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{String(b.currency)}</span>
                  ) : null}
                  <span className="flex-1" />
                  {b.approved_at ? (
                    <Badge variant="success">Approved {String(b.approved_at)}</Badge>
                  ) : (
                    <Badge variant="warning">Pending approval</Badge>
                  )}
                  {b.is_active === false ? <Badge variant="outline">Inactive</Badge> : null}
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Bank accounts are added and approved in the Payments module.
          </p>
        </section>
      </div>
    </UrlDrawer>
  )
}
