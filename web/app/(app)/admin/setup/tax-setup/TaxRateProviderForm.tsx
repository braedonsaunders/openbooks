'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CheckCircle2, CircleAlert, KeyRound, FlaskConical } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'

export type TaxRateProviderKey = 'avalara' | 'taxjar' | 'custom_http' | 'manual'

export type TaxRateProviderConfig = {
  provider: TaxRateProviderKey
  displayName: string
  isEnabled: boolean
  preferProvider: boolean
  settings: Record<string, unknown>
  hasSecret: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
}

/**
 * Destination sales-tax rate provider — sits on Tax Setup next to country packs.
 * Packs seed codes/returns; this provider supplies live destination rates (US primarily).
 */
export function TaxRateProviderForm({ initial }: { initial: TaxRateProviderConfig | null }) {
  const t = useTranslations('admin.setup.taxRateProvider')
  const tc = useTranslations('common')
  const router = useRouter()

  const [form, setForm] = useState({
    provider: (initial?.provider ?? 'manual') as TaxRateProviderKey,
    displayName: initial?.displayName ?? '',
    isEnabled: initial?.isEnabled ?? false,
    preferProvider: initial?.preferProvider ?? true,
    companyCode: String(initial?.settings?.companyCode ?? 'DEFAULT'),
    baseUrl: String(initial?.settings?.baseUrl ?? ''),
    quoteUrl: String(initial?.settings?.quoteUrl ?? ''),
    defaultRatePercent: String(initial?.settings?.defaultRatePercent ?? '0'),
  })
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [licenseKey, setLicenseKey] = useState('')
  const [clearSecret, setClearSecret] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [testAmount, setTestAmount] = useState('100.00')
  const [testRegion, setTestRegion] = useState('CA')
  const [testPostal, setTestPostal] = useState('94105')
  const [testCountry, setTestCountry] = useState('US')
  const [lastQuote, setLastQuote] = useState<{ taxAmount: string; components: { jurisdiction: string; ratePercent: string; taxAmount: string }[] } | null>(null)

  const needsAvalaraCreds = form.provider === 'avalara'
  const needsTaxJarKey = form.provider === 'taxjar'
  const needsCustomUrl = form.provider === 'custom_http'
  const needsManualRate = form.provider === 'manual'

  const settings = useMemo(() => {
    if (form.provider === 'avalara') return { companyCode: form.companyCode || 'DEFAULT', baseUrl: form.baseUrl || undefined }
    if (form.provider === 'taxjar') return { baseUrl: form.baseUrl || undefined }
    if (form.provider === 'custom_http') return { quoteUrl: form.quoteUrl }
    return { defaultRatePercent: Number(form.defaultRatePercent || 0) }
  }, [form])

  async function persist(): Promise<boolean> {
    const res = await fetch('/api/tax/rate-provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: form.provider,
        displayName: form.displayName || undefined,
        isEnabled: form.isEnabled,
        preferProvider: form.preferProvider,
        settings,
        apiKey: clearSecret ? null : apiKey.trim() || undefined,
        accountId: clearSecret ? null : accountId.trim() || undefined,
        licenseKey: clearSecret ? null : licenseKey.trim() || undefined,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error ?? tc('feedback.saveFailed'))
      return false
    }
    setApiKey('')
    setAccountId('')
    setLicenseKey('')
    setClearSecret(false)
    return true
  }

  async function save() {
    setBusy('save')
    if (await persist()) {
      toast.success(t('saved'))
      router.refresh()
    }
    setBusy(null)
  }

  async function testQuote() {
    setBusy('test')
    if (!(await persist())) {
      setBusy(null)
      return
    }
    const body =
      form.provider === 'manual'
        ? {
            action: 'manualQuote',
            taxableAmount: testAmount,
            ratePercent: Number(form.defaultRatePercent || 0),
            jurisdiction: testRegion || testCountry,
          }
        : {
            taxableAmount: testAmount,
            currency: 'USD',
            shipFrom: { country: testCountry, region: testRegion, postalCode: testPostal },
            shipTo: { country: testCountry, region: testRegion, postalCode: testPostal, city: '' },
          }
    const res = await fetch('/api/tax/rate-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(data.error ?? t('testFailed'))
      setBusy(null)
      return
    }
    setLastQuote({ taxAmount: data.taxAmount, components: data.components ?? [] })
    toast.success(t('testPassed', { tax: data.taxAmount }))
    router.refresh()
    setBusy(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="mt-0.5 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        {initial?.isEnabled ? (
          <Badge variant="success">{t('statusOn')}</Badge>
        ) : (
          <Badge variant="secondary">{t('statusOff')}</Badge>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t('provider')}</Label>
          <Select
            value={form.provider}
            onChange={(e) => setForm((c) => ({ ...c, provider: e.target.value as TaxRateProviderKey }))}
          >
            <option value="manual">{t('providers.manual')}</option>
            <option value="avalara">{t('providers.avalara')}</option>
            <option value="taxjar">{t('providers.taxjar')}</option>
            <option value="custom_http">{t('providers.custom_http')}</option>
          </Select>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t(`providerHelp.${form.provider}`)}</p>
        </div>
        <div className="space-y-1.5">
          <Label>{t('displayName')}</Label>
          <Input
            value={form.displayName}
            onChange={(e) => setForm((c) => ({ ...c, displayName: e.target.value }))}
            placeholder={t('displayNamePlaceholder')}
          />
        </div>

        {needsAvalaraCreds ? (
          <>
            <div className="space-y-1.5">
              <Label>{t('accountId')}</Label>
              <Input
                type="password"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value)
                  setClearSecret(false)
                }}
                placeholder={initial?.hasSecret ? t('secretStored') : t('accountIdPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('licenseKey')}</Label>
              <Input
                type="password"
                value={licenseKey}
                onChange={(e) => {
                  setLicenseKey(e.target.value)
                  setClearSecret(false)
                }}
                placeholder={initial?.hasSecret ? t('secretStored') : t('licenseKeyPlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('companyCode')}</Label>
              <Input value={form.companyCode} onChange={(e) => setForm((c) => ({ ...c, companyCode: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('baseUrl')}</Label>
              <Input
                value={form.baseUrl}
                onChange={(e) => setForm((c) => ({ ...c, baseUrl: e.target.value }))}
                placeholder="https://rest.avatax.com"
              />
            </div>
          </>
        ) : null}

        {needsTaxJarKey ? (
          <>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('apiKey')}</Label>
              <div className="flex items-center gap-2">
                <KeyRound size={16} className="text-slate-400" />
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
                    setClearSecret(false)
                  }}
                  placeholder={initial?.hasSecret ? t('secretStored') : t('apiKeyPlaceholder')}
                />
              </div>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('baseUrl')}</Label>
              <Input
                value={form.baseUrl}
                onChange={(e) => setForm((c) => ({ ...c, baseUrl: e.target.value }))}
                placeholder="https://api.taxjar.com"
              />
            </div>
          </>
        ) : null}

        {needsCustomUrl ? (
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('quoteUrl')}</Label>
            <Input
              value={form.quoteUrl}
              onChange={(e) => setForm((c) => ({ ...c, quoteUrl: e.target.value }))}
              placeholder="https://example.com/tax/quote"
            />
            <p className="text-xs text-slate-500">{t('quoteUrlHelp')}</p>
          </div>
        ) : null}

        {needsManualRate ? (
          <div className="space-y-1.5">
            <Label>{t('defaultRatePercent')}</Label>
            <Input
              inputMode="decimal"
              value={form.defaultRatePercent}
              onChange={(e) => setForm((c) => ({ ...c, defaultRatePercent: e.target.value }))}
            />
          </div>
        ) : null}
      </div>

      {(needsAvalaraCreds || needsTaxJarKey) && initial?.hasSecret ? (
        <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} />
          {t('clearSecret')}
        </label>
      ) : null}

      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={form.isEnabled}
          onChange={(e) => setForm((c) => ({ ...c, isEnabled: e.target.checked }))}
        />
        {t('enabled')}
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
        <input
          type="checkbox"
          checked={form.preferProvider}
          onChange={(e) => setForm((c) => ({ ...c, preferProvider: e.target.checked }))}
        />
        {t('preferProvider')}
      </label>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('preferProviderHelp')}</p>

      <div className="rounded-lg border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
        <p className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">{t('testTitle')}</p>
        <div className="grid gap-2 sm:grid-cols-4">
          <Input value={testAmount} onChange={(e) => setTestAmount(e.target.value)} placeholder={t('testAmount')} />
          <Input value={testCountry} onChange={(e) => setTestCountry(e.target.value)} placeholder="US" />
          <Input value={testRegion} onChange={(e) => setTestRegion(e.target.value)} placeholder="CA" />
          <Input value={testPostal} onChange={(e) => setTestPostal(e.target.value)} placeholder="94105" />
        </div>
        {lastQuote ? (
          <div className="mt-2 text-xs text-slate-600 dark:text-slate-300">
            <span className="font-medium">{t('lastQuote', { tax: lastQuote.taxAmount })}</span>
            <ul className="mt-1 list-inside list-disc">
              {lastQuote.components.map((c, i) => (
                <li key={i}>
                  {c.jurisdiction}: {c.ratePercent}% → {c.taxAmount}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={busy !== null}>
          {busy === 'save' ? tc('actions.saving') : tc('actions.save')}
        </Button>
        <Button variant="outline" onClick={testQuote} disabled={busy !== null}>
          <FlaskConical size={15} /> {t('test')}
        </Button>
        {busy === 'test' ? <CheckCircle2 size={16} className="animate-pulse text-teal-600" /> : null}
      </div>

      {initial?.lastError ? (
        <div className="flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          {initial.lastError}
        </div>
      ) : null}
      {initial?.lastSuccessAt ? (
        <p className="text-xs text-slate-500">
          {t('lastSuccess')}: {new Date(initial.lastSuccessAt).toLocaleString()}
        </p>
      ) : null}
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('relationToPacks')}</p>
    </div>
  )
}
