'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CreditCard } from 'lucide-react'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { Badge, Button, DisclosureSection, Input, Label, Select } from '@openbooks/ui'
import { Switch } from '../../../components/switch'
import { useAppAction } from '../../../lib/use-app-action'
import { confirmDialog } from '../../../lib/confirm'
import { SublistEmpty, SublistHeading } from './PartySummary'

interface StoredMethodRow {
  id: string
  provider: string
  providerCustomerId: string | null
  providerMethodId: string | null
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  mandateReference: string | null
  isDefault: boolean
  status: string
}

interface EnrollmentRow {
  id: string
  subscriptionId: string | null
  subscriptionName: string | null
  status: string
  chargeOnIssue: boolean
}

const PROVIDERS = ['stripe', 'adyen', 'gocardless'] as const

function providerLabel(provider: string): string {
  if (provider === 'gocardless') return 'GoCardless'
  if (provider === 'adyen') return 'Adyen'
  return 'Stripe'
}

function methodTitle(method: StoredMethodRow): string {
  if (method.brand && method.last4) return `${method.brand} •••• ${method.last4}`
  if (method.last4) return `•••• ${method.last4}`
  if (method.mandateReference) return method.mandateReference
  return providerLabel(method.provider)
}

/**
 * Stored payment methods and the autopay switch on a customer drawer.
 * Methods are tokens at the provider (brand, last four, expiry) — full
 * numbers never reach OpenBooks. Writes ride the autopay API routes, which
 * re-check every grant and refusal the panel gates on.
 */
export function PartyPaymentMethodsPanel({
  partyId,
  canManageMethods,
  canManageAutopay,
  defaultCurrency,
}: {
  partyId: string
  canManageMethods: boolean
  canManageAutopay: boolean
  defaultCurrency: string
}) {
  const t = useTranslations('parties.drawer.autopay')
  const tc = useTranslations('common')
  const { busy, refusal, execute } = useAppAction()
  const [methods, setMethods] = useState<StoredMethodRow[] | null>(null)
  const [enrollments, setEnrollments] = useState<EnrollmentRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [provider, setProvider] = useState<string>('stripe')
  const [currency, setCurrency] = useState(defaultCurrency)
  const [setupUrl, setSetupUrl] = useState<string | null>(null)
  const [chargeOnIssue, setChargeOnIssue] = useState(false)

  // The mount effect keeps its promise-chain shape, which never resets state
  // synchronously inside the effect body; mutations refresh through the
  // same reload and apply pair.
  const reload = useCallback(async (signal?: AbortSignal) => {
    const [methodsRes, enrollmentsRes] = await Promise.all([
      fetch(`/api/autopay/methods?partyId=${encodeURIComponent(partyId)}`, { signal }),
      fetch(`/api/autopay/enrollments?partyId=${encodeURIComponent(partyId)}`, { signal }),
    ])
    if (!methodsRes.ok || !enrollmentsRes.ok) {
      const failed = !methodsRes.ok ? methodsRes : enrollmentsRes
      const body = await failed.json().catch(() => null)
      throw new Error((body?.error as string | undefined) ?? t('loadFailed'))
    }
    const methodsBody = (await methodsRes.json()) as { methods?: StoredMethodRow[] }
    const enrollmentsBody = (await enrollmentsRes.json()) as { enrollments?: EnrollmentRow[] }
    return { methods: methodsBody.methods ?? [], enrollments: enrollmentsBody.enrollments ?? [] }
  }, [partyId, t])

  const applyLoaded = useCallback((applied: { methods: StoredMethodRow[]; enrollments: EnrollmentRow[] }) => {
    setMethods(applied.methods)
    setEnrollments(applied.enrollments)
    setLoadError(null)
  }, [])

  const applyRefusal = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    setLoadError(error instanceof Error ? error.message : t('loadFailed'))
    setMethods(null)
    setEnrollments(null)
  }, [t])

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).then(applyLoaded, applyRefusal)
    return () => controller.abort()
  }, [reload, applyLoaded, applyRefusal])

  function refresh(): void {
    void reload().then(applyLoaded, applyRefusal)
  }

  async function setDefault(methodId: string) {
    await execute(() => fetchAction(`/api/autopay/methods/${methodId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    }), {
      fallbackMessage: t('setDefaultFailed'),
      onOk: () => refresh(),
    })
  }

  async function remove(method: StoredMethodRow) {
    const confirmed = await confirmDialog({
      title: t('removeTitle'),
      message: t('removeMessage'),
      confirmLabel: t('remove'),
      cancelLabel: tc('actions.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    await execute(() => fetchAction(`/api/autopay/methods/${method.id}`, { method: 'DELETE' }), {
      fallbackMessage: t('removeFailed'),
      onOk: () => refresh(),
    })
  }

  async function sendSetupLink() {
    setSetupUrl(null)
    const code = currency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) return
    const ok = await execute(() => fetchAction<{ setupUrl?: string }>(`/api/autopay/methods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partyId, provider, currency: code }),
    }), {
      fallbackMessage: t('sendFailed'),
      onOk: (value) => {
        if (value?.setupUrl) setSetupUrl(value.setupUrl)
      },
    })
    if (ok) refresh()
  }

  async function copySetupUrl() {
    if (!setupUrl) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${setupUrl}`)
      toast.success(t('linkCopied'))
    } catch {
      toast.error(t('sendFailed'))
    }
  }

  async function enroll() {
    await execute(() => fetchAction(`/api/autopay/enrollments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partyId, chargeOnIssue }),
    }), {
      fallbackMessage: t('enrollFailed'),
      onOk: () => refresh(),
    })
  }

  async function moveEnrollment(id: string, status: 'active' | 'paused') {
    await execute(() => fetchAction(`/api/autopay/enrollments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }), {
      fallbackMessage: t('updateFailed'),
      onOk: () => refresh(),
    })
  }

  const loaded = methods !== null && enrollments !== null
  const customerEnrollment = enrollments?.find((row) => row.subscriptionId === null)
  const subscriptionEnrollments = enrollments?.filter((row) => row.subscriptionId !== null) ?? []
  const defaultMethod = methods?.find((method) => method.isDefault && method.status === 'active')

  return (
    <section className="space-y-4">
      <SublistHeading
        title={t('heading')}
        description={t('description')}
        icon={<CreditCard size={16} />}
      />
      {refusal?.serverMessage ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {refusal.serverMessage}
        </p>
      ) : null}
      {!loaded ? (
        loadError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => refresh()}>{t('tryAgain')}</Button>
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">{tc('feedback.loading')}</p>
        )
      ) : (
        <>
          {methods.length === 0 ? (
            <>
              <SublistEmpty icon={<CreditCard size={22} />} text={t('emptyTitle')} />
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('emptyDescription')}</p>
            </>
          ) : (
            <ul className="space-y-2">
              {methods.map((method) => (
                <li
                  key={method.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-slate-200 px-3 py-2.5 dark:border-slate-800"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {methodTitle(method)}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {providerLabel(method.provider)}
                      {method.expMonth && method.expYear
                        ? ` · ${t('expires', { month: method.expMonth, year: method.expYear })}`
                        : method.mandateReference
                          ? ` · ${t('mandate', { ref: method.mandateReference })}`
                          : ` · ${t('noExpiry')}`}
                    </p>
                  </div>
                  {method.isDefault ? <Badge variant="default">{t('defaultBadge')}</Badge> : null}
                  <Badge variant={method.status === 'active' ? 'success' : 'secondary'}>
                    {method.status === 'active' ? t('active') : t('awaitingCustomer')}
                  </Badge>
                  {canManageMethods && !method.isDefault && method.status === 'active' ? (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void setDefault(method.id)}>
                      {t('setDefault')}
                    </Button>
                  ) : null}
                  {canManageMethods ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(method)}>
                      {t('remove')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canManageMethods ? (
            <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('sendHint')}</p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label>{t('provider')}</Label>
                  <Select value={provider} onChange={(event) => setProvider(event.target.value)}>
                    {PROVIDERS.map((option) => (
                      <option key={option} value={option}>{providerLabel(option)}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label>{t('currency')}</Label>
                  <Input
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value)}
                    placeholder={t('currencyPlaceholder')}
                    className="w-24"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !/^[A-Za-z]{3}$/.test(currency.trim())}
                  onClick={() => void sendSetupLink()}
                >
                  {t('sendSetupLink')}
                </Button>
              </div>
              {setupUrl ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="w-full text-xs text-slate-500 dark:text-slate-400">{t('setupLinkReady')}</p>
                  <Input readOnly value={`${typeof window === 'undefined' ? '' : window.location.origin}${setupUrl}`} className="min-w-0 flex-1" />
                  <Button variant="outline" size="sm" onClick={() => void copySetupUrl()}>
                    {t('copyLink')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('enrollmentHeading')}</h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('enrollmentDescription')}</p>
            {customerEnrollment ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Switch
                  on={customerEnrollment.status === 'active'}
                  disabled={busy || !canManageAutopay}
                  label={t('customerScope')}
                  onToggle={() => void moveEnrollment(
                    customerEnrollment.id,
                    customerEnrollment.status === 'active' ? 'paused' : 'active',
                  )}
                />
                <Badge variant={customerEnrollment.status === 'active' ? 'success' : 'secondary'}>
                  {customerEnrollment.status === 'active' ? t('active') : t('paused')}
                </Badge>
              </div>
            ) : canManageAutopay ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void enroll()}>
                  {t('enroll')}
                </Button>
                <Switch on={chargeOnIssue} disabled={busy} label={t('chargeOnIssue')} onToggle={() => setChargeOnIssue((flag) => !flag)} />
              </div>
            ) : null}
            {subscriptionEnrollments.map((enrollment) => (
              <div key={enrollment.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Switch
                  on={enrollment.status === 'active'}
                  disabled={busy || !canManageAutopay}
                  label={t('subscriptionScope', { name: enrollment.subscriptionName ?? enrollment.subscriptionId ?? '' })}
                  onToggle={() => void moveEnrollment(
                    enrollment.id,
                    enrollment.status === 'active' ? 'paused' : 'active',
                  )}
                />
                <Badge variant={enrollment.status === 'active' ? 'success' : 'secondary'}>
                  {enrollment.status === 'active' ? t('active') : t('paused')}
                </Badge>
              </div>
            ))}
          </div>
          {defaultMethod?.providerCustomerId || defaultMethod?.providerMethodId ? (
            <DisclosureSection title={t('providerDetail')} summary={t('providerDetailSummary')}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-slate-500 dark:text-slate-400">{t('providerCustomer')}</dt>
                <dd className="break-all text-slate-900 dark:text-slate-100">{defaultMethod.providerCustomerId ?? '—'}</dd>
                <dt className="text-slate-500 dark:text-slate-400">{t('providerMethod')}</dt>
                <dd className="break-all text-slate-900 dark:text-slate-100">{defaultMethod.providerMethodId ?? '—'}</dd>
              </dl>
            </DisclosureSection>
          ) : null}
        </>
      )}
    </section>
  )
}
