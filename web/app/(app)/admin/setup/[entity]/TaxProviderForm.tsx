'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { CircleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, DisclosureSection, Input, Label, Select } from '@openbooks/ui'

type Provider = 'avalara' | 'taxjar' | 'custom_http' | 'manual'
type Config = {
  provider: Provider
  displayName: string
  isEnabled: boolean
  preferProvider: boolean
  settings: Record<string, unknown>
  hasSecret: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  updatedAt: string | null
}

export function TaxProviderForm({ initial }: { initial: Config | null }) {
  const t = useTranslations('admin.setup.taxProvider')
  const tc = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const [form, setForm] = useState(() => ({
    provider: (initial?.provider ?? 'avalara') as Provider,
    displayName: initial?.displayName ?? '',
    isEnabled: initial?.isEnabled ?? false,
    // Commits default on the moment a provider is configured: a configured
    // provider whose transactions are never committed cannot feed returns.
    commitTransactions: initial ? initial.settings.commitTransactions !== false : true,
    preferProvider: initial?.preferProvider ?? true,
  }))
  const [busy, setBusy] = useState(false)

  const formatDateTime = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/tax/rate-provider', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: form.provider,
          displayName: form.displayName || undefined,
          isEnabled: form.isEnabled,
          preferProvider: form.preferProvider,
          commitTransactions: form.commitTransactions,
          expectedUpdatedAt: initial?.updatedAt ?? null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(typeof data.error === 'string' ? data.error : tc('feedback.saveFailed'))
        return
      }
      toast.success(t('saved'))
      router.refresh()
    } catch {
      toast.error(tc('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label help={t(`providerHelp.${form.provider}`)}>{t('provider')}</Label>
            <Select
              value={form.provider}
              onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value as Provider }))}
            >
              <option value="avalara">{t('providers.avalara')}</option>
              <option value="taxjar">{t('providers.taxjar')}</option>
              <option value="custom_http">{t('providers.custom_http')}</option>
              <option value="manual">{t('providers.manual')}</option>
            </Select>
          </div>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={form.isEnabled} onChange={(event) => setForm((current) => ({ ...current, isEnabled: event.target.checked }))} />
          {t('enabled')}
        </label>

        <label className="mt-4 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.commitTransactions}
            onChange={(event) => setForm((current) => ({ ...current, commitTransactions: event.target.checked }))}
          />
          <span>
            <span className="font-medium">{t('commitTransactions')}</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">{t('commitHelp')}</span>
          </span>
        </label>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
        </div>
      </div>

      <DisclosureSection
        title={t('advanced')}
        summary={t('advancedSummary', { prefer: form.preferProvider ? t('preferOn') : t('preferOff') })}
        forceOpen={Boolean(initial?.lastError)}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('displayName')}</Label>
            <Input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder={t('displayNamePlaceholder')} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={form.preferProvider} onChange={(event) => setForm((current) => ({ ...current, preferProvider: event.target.checked }))} />
            {t('preferProvider')}
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('preferProviderHelp')}</p>

        <div className="mt-4">
          <h3 className="font-medium text-slate-900 dark:text-slate-100">{t('status')}</h3>
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><span className="text-slate-500">{t('lastSuccess')}</span><p>{initial?.lastSuccessAt ? formatDateTime(initial.lastSuccessAt) : '—'}</p></div>
            <div>
              <span className="text-slate-500">{t('commitState')}</span>
              <p><Badge variant={form.commitTransactions ? 'success' : 'secondary'}>{form.commitTransactions ? t('commitOn') : t('commitOff')}</Badge></p>
            </div>
          </div>
          {initial?.lastError ? <div className="mt-3 flex gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"><CircleAlert size={16} className="mt-0.5 shrink-0" />{initial.lastError}</div> : null}
        </div>
      </DisclosureSection>
    </div>
  )
}
