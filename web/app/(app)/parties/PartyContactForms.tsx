'use client'

/** Split from PartyDrawer.tsx; moved without behavior changes. */
import { type AddressRow, type ContactRow, field } from './party-drawer-model'
import { Input, Label, SearchSelect, Select } from '@openbooks/ui'

export function ContactForm({
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

export function AddressForm({
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
