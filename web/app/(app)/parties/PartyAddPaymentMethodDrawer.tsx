'use client'

import { useEffect, useId, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { useAppAction } from '../../../lib/use-app-action'
import { readApiErrorMessage } from '../../../lib/api-error'
import { SublistLoadError, SublistLoading } from '../../../components/drawer-sublist'
import { field } from './party-drawer-model'

type Provider = 'stripe' | 'adyen' | 'gocardless'

interface SetupOptions {
  currencies: Array<{ value: string; label: string }>
  defaultCurrency: string | null
  providers: Provider[]
  recipients: Array<{ email: string; name: string; source: 'party' | 'contact' }>
  emailConfigured: boolean
}

interface SetupResult {
  setupUrl?: string
  delivery?: { status: 'sent' | 'uncertain' | 'failed'; recipient: string } | null
}

export function providerLabel(provider: string): string {
  if (provider === 'gocardless') return 'GoCardless'
  if (provider === 'adyen') return 'Adyen'
  return 'Stripe'
}

/**
 * Add payment method: the customer receives a secure hosted link where they
 * save a card or bank account with the provider. The drawer names who the
 * link goes to and what they receive; recipients are the addresses on the
 * customer's record and currencies are the ones its legal entity may
 * collect in. The setup route re-checks both.
 */
export function AddPaymentMethodDrawer({
  partyId,
  open,
  onClose,
  onCreated,
}: {
  partyId: string
  open: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const t = useTranslations('parties.drawer.autopay')
  const tc = useTranslations('common')
  const ids = useId()
  const { busy, refusal, execute, clearRefusal } = useAppAction()
  const [options, setOptions] = useState<{ partyId: string; value: SetupOptions } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [provider, setProvider] = useState<Provider | ''>('')
  const [currency, setCurrency] = useState('')
  const [recipient, setRecipient] = useState('')
  const [result, setResult] = useState<SetupResult | null>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    fetch(`/api/autopay/methods/setup-options?partyId=${encodeURIComponent(partyId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('optionsLoadFailed')))
        const value = (await response.json()) as SetupOptions
        setOptions({ partyId, value })
        setLoadError(null)
        setProvider(value.providers[0] ?? '')
        setCurrency(value.defaultCurrency ?? value.currencies[0]?.value ?? '')
        setRecipient(value.recipients.length === 1 ? value.recipients[0]!.email : '')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setLoadError(error instanceof Error ? error.message : t('optionsLoadFailed'))
      })
    return () => controller.abort()
  }, [open, partyId, reload, t])

  function close() {
    if (busy) return
    setResult(null)
    setOptions(null)
    setLoadError(null)
    clearRefusal()
    onClose()
  }

  const loaded = options?.partyId === partyId ? options.value : null
  const sendsEmail = loaded?.emailConfigured === true && (loaded.recipients.length ?? 0) > 0
  const ready = loaded !== null && provider !== '' && currency !== '' && (!sendsEmail || recipient !== '')

  async function submit() {
    if (!ready) return
    const created = await execute<SetupResult>(
      () => fetchAction<SetupResult>('/api/autopay/methods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partyId, provider, currency, ...(sendsEmail ? { recipientEmail: recipient } : {}) }),
      }),
      {
        fallbackMessage: t('sendFailed'),
        onOk: (value) => setResult(value ?? {}),
      },
    )
    if (created) onCreated()
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('linkCopied'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  const absoluteUrl = result?.setupUrl ? `${typeof window === 'undefined' ? '' : window.location.origin}${result.setupUrl}` : ''
  const recipientRow = loaded?.recipients.find((row) => row.email === recipient)

  return (
    <Drawer
      open={open}
      onClose={close}
      stacked
      size="md"
      title={t('addTitle')}
      description={t('addDescription')}
      footer={result ? (
        <Button onClick={close}>{tc('actions.done')}</Button>
      ) : (
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{tc('actions.cancel')}</Button>
          <Button disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? tc('actions.saving') : sendsEmail ? t('sendSetupLink') : t('createLink')}
          </Button>
        </>
      )}
    >
      {result ? (
        <div className="space-y-3" data-setup-result="">
          {result.delivery ? (
            <p role={result.delivery.status === 'sent' ? 'status' : 'alert'} className={result.delivery.status === 'sent' ? 'text-sm text-slate-700 dark:text-slate-300' : 'text-sm text-amber-700 dark:text-amber-300'}>
              {result.delivery.status === 'sent'
                ? t('sent', { recipient: result.delivery.recipient })
                : result.delivery.status === 'uncertain'
                  ? t('deliveryUncertain', { recipient: result.delivery.recipient })
                  : t('deliveryFailed', { recipient: result.delivery.recipient })}
            </p>
          ) : (
            <p className="text-sm text-slate-700 dark:text-slate-300">{t('setupLinkReady')}</p>
          )}
          {absoluteUrl ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={absoluteUrl} aria-label={t('setupLink')} className="min-w-0 flex-1" />
              <Button variant="outline" size="sm" onClick={() => void copy(absoluteUrl)}>{t('copyLink')}</Button>
            </div>
          ) : null}
        </div>
      ) : loadError ? (
        <SublistLoadError message={loadError} onRetry={() => { setLoadError(null); setReload((value) => value + 1) }} />
      ) : !loaded ? (
        <SublistLoading />
      ) : (
        <div className="space-y-4">
          <ActionAlert error={refusal} fallbackMessage={t('sendFailed')} />
          {loaded.emailConfigured ? (
            <div className={field}>
              <Label htmlFor={`${ids}-recipient`}>{t('recipient')}</Label>
              {loaded.recipients.length ? (
                <>
                  <Select id={`${ids}-recipient`} value={recipient} onChange={(event) => setRecipient(event.target.value)}>
                    <option value="">{t('recipientSelect')}</option>
                    {loaded.recipients.map((row) => (
                      <option key={row.email} value={row.email}>{row.name ? `${row.name} <${row.email}>` : row.email}</option>
                    ))}
                  </Select>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('recipientHint')}</p>
                </>
              ) : (
                <p className="text-sm text-slate-600 dark:text-slate-300">{t('noRecipients')}</p>
              )}
            </div>
          ) : (
            <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
              {t.rich('emailNotConfigured', {
                link: (chunks) => <Link href="/admin/email" className="font-medium text-teal-700 hover:underline dark:text-teal-300">{chunks}</Link>,
              })}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={field}>
              <Label htmlFor={`${ids}-provider`}>{t('provider')}</Label>
              {loaded.providers.length ? (
                <Select id={`${ids}-provider`} value={provider} onChange={(event) => setProvider(event.target.value as Provider)}>
                  {loaded.providers.map((option) => <option key={option} value={option}>{providerLabel(option)}</option>)}
                </Select>
              ) : (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {t.rich('noProviders', {
                    link: (chunks) => <Link href="/admin/setup/payment-providers" className="font-medium text-teal-700 hover:underline dark:text-teal-300">{chunks}</Link>,
                  })}
                </p>
              )}
            </div>
            <div className={field}>
              <Label htmlFor={`${ids}-currency`}>{t('currency')}</Label>
              {loaded.currencies.length ? (
                <Select id={`${ids}-currency`} value={currency} onChange={(event) => setCurrency(event.target.value)}>
                  {loaded.currencies.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
              ) : (
                <p className="text-sm text-slate-600 dark:text-slate-300">{t('noCurrencies')}</p>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-3 text-sm text-slate-700 dark:border-teal-900 dark:bg-teal-950/30 dark:text-slate-200" data-setup-summary="">
            {sendsEmail
              ? recipientRow
                ? t('whatIsSent', { recipient: recipientRow.email })
                : t('chooseRecipient')
              : t('whatIsCreated')}
          </div>
        </div>
      )}
    </Drawer>
  )
}
