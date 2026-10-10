'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, FieldLabel, Input, SearchSelect, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { countryOptions } from '../../../../lib/countries'
import { currencyOptions } from '../../../../lib/iso-currencies'
import { InviteLinkDrawer } from '../../admin/users/InviteLinkDrawer'

type CreatedOrganization = {
  orgId: string
  name: string
  administrator: { userId: string; email: string }
  emailQueued: boolean
  setPasswordUrl?: string
}

/**
 * The Organizations page's one primary action: a drawer that creates a
 * production organization and invites its first administrator. The server
 * seeds the organization's books, periods, legal entity, roles and defaults
 * in one transaction; this form only gathers the identity and the reason.
 * When no mailbox can carry the administrator's set-password link, the
 * one-time link replaces the form so the operator can hand it over.
 */
export function NewOrganizationButton({ basePath }: { basePath: string }) {
  const t = useTranslations('platform.organizations.create')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('newButton')}</Button>
      {open ? <NewOrganizationDrawer basePath={basePath} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function NewOrganizationDrawer({ basePath, onClose }: { basePath: string; onClose: () => void }) {
  const t = useTranslations('platform.organizations.create')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const countries = useMemo(() => countryOptions(locale), [locale])
  const currencies = useMemo(() => currencyOptions(locale), [locale])
  const [name, setName] = useState('')
  const [country, setCountry] = useState('')
  const [currency, setCurrency] = useState('')
  const [adminName, setAdminName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedOrganization | null>(null)

  // Show the new organization: the list filtered to its name, refreshed
  // from the server so the row reflects what was committed.
  function showCreated(organization: CreatedOrganization) {
    onClose()
    router.push(`${basePath}?q=${encodeURIComponent(organization.name)}`)
    router.refresh()
  }

  if (created?.setPasswordUrl) {
    return (
      <InviteLinkDrawer
        email={created.administrator.email}
        url={created.setPasswordUrl}
        onClose={() => showCreated(created)}
      />
    )
  }

  async function submit() {
    if (!name.trim() || !country || !currency || !adminName.trim() || !adminEmail.trim() || !reason.trim()) {
      toast.error(t('required'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/platform/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          country,
          currency,
          adminName: adminName.trim(),
          adminEmail: adminEmail.trim(),
          reason: reason.trim(),
        }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('requestFailed')))
        // A refusal after creation still committed the organization; the
        // list must show it while the operator follows the remedy.
        router.refresh()
        return
      }
      const organization = (await res.json()) as CreatedOrganization
      if (typeof organization.setPasswordUrl === 'string') {
        toast.success(t('createdLinkOnly', { name: organization.name }))
        setCreated(organization)
        return
      }
      toast.success(t('created', { name: organization.name, email: organization.administrator.email }))
      showCreated(organization)
    } catch {
      // The request may have reached the server: keep the entries so the
      // operator can check the list and retry; a repeat is refused by name.
      toast.error(t('requestFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="md"
      title={t('title')}
      description={t('description')}
      headerActions={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tCommon('actions.cancel')}
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy ? t('creating') : t('create')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="new-org-name">{t('nameLabel')}</FieldLabel>
          <Input
            id="new-org-name"
            value={name}
            maxLength={200}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('namePlaceholder')}
          />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="new-org-country" help={t('countryHint')}>{t('countryLabel')}</FieldLabel>
            <SearchSelect
              id="new-org-country"
              ariaLabel={t('countryLabel')}
              sheetTitle={t('countryLabel')}
              value={country}
              disabled={busy}
              onChange={(value) => setCountry((value ?? '').toUpperCase())}
              options={countries}
              placeholder={t('countryPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="new-org-currency" help={t('currencyHint')}>{t('currencyLabel')}</FieldLabel>
            <SearchSelect
              id="new-org-currency"
              ariaLabel={t('currencyLabel')}
              sheetTitle={t('currencyLabel')}
              value={currency}
              disabled={busy}
              onChange={(value) => setCurrency(value ?? '')}
              options={currencies}
              placeholder={t('currencyPlaceholder')}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="new-org-admin-name">{t('adminNameLabel')}</FieldLabel>
          <Input
            id="new-org-admin-name"
            value={adminName}
            maxLength={200}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setAdminName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="new-org-admin-email" help={t('adminEmailHint')}>{t('adminEmailLabel')}</FieldLabel>
          <Input
            id="new-org-admin-email"
            type="email"
            value={adminEmail}
            maxLength={320}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setAdminEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="new-org-reason" help={t('reasonHint')}>{t('reasonLabel')}</FieldLabel>
          <Textarea
            id="new-org-reason"
            value={reason}
            rows={3}
            maxLength={1000}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
          />
        </div>
      </div>
    </Drawer>
  )
}
