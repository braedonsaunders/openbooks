'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'
import { readApiErrorMessage } from '@/lib/api-error'
import { useDirtyClose } from '@/lib/use-dirty-close'

const FIELDS = ['addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'country'] as const
type AddressField = (typeof FIELDS)[number]

/** Opens the create drawer (`?warehouseNew=1`); nothing is written until Save. */
export function NewWarehouseButton({ label }: { label: string }) {
  return <UnsavedCreateButton base="/warehouse" param="warehouseNew" clear={['warehouse', 'rule']} label={label} />
}

/**
 * Create a warehouse in draft: its code, name, business location and
 * address. It takes no stock until it is activated from the warehouse list.
 */
export function NewWarehouseDrawer({
  locations,
  closeHref,
}: {
  locations: { id: string; name: string }[]
  closeHref: string
}) {
  const t = useTranslations('warehouse')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [locationId, setLocationId] = useState(locations.length === 1 ? locations[0]!.id : '')
  const [address, setAddress] = useState<Record<AddressField, string>>({
    addressLine1: '', addressLine2: '', city: '', region: '', postalCode: '', country: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeGuard = useDirtyClose({
    dirty: code !== '' || name !== '' || Object.values(address).some((value) => value !== ''),
    busy,
    onClose: () => {},
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  async function save() {
    if (!code.trim() || !name.trim() || !locationId) {
      setError(t('create.missing'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          locationId,
          ...Object.fromEntries(FIELDS.map((field) => [field, address[field].trim() || null])),
        }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t('create.failed')))
        return
      }
      router.push(closeHref as never)
      router.refresh()
    } catch {
      setError(t('create.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      beforeClose={closeGuard.beforeClose}
      size="md"
      title={t('create.title')}
      description={t('create.description')}
      headerActions={
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? tCommon('actions.saving') : t('create.save')}
        </Button>
      }
    >
      <div className="space-y-4" inert={busy}>
        {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="warehouse-code">{t('fields.code')}</Label>
            <Input id="warehouse-code" value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="warehouse-name">{t('fields.name')}</Label>
            <Input id="warehouse-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="warehouse-location">{t('fields.location')}</Label>
          <Select id="warehouse-location" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">{t('fields.chooseLocation')}</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>{location.name}</option>
            ))}
          </Select>
        </div>
        {FIELDS.map((field) => (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={`warehouse-${field}`}>{t(`fields.${field}`)}</Label>
            <Input
              id={`warehouse-${field}`}
              value={address[field]}
              maxLength={field === 'country' ? 2 : field === 'postalCode' ? 40 : 200}
              onChange={(e) => setAddress((prev) => ({ ...prev, [field]: e.target.value }))}
            />
          </div>
        ))}
      </div>
    </UrlDrawer>
  )
}
