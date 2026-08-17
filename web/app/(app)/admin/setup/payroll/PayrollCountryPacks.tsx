'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { BadgeCheck, Check, Download, Globe2, Trash2 } from 'lucide-react'
import { confirmDialog } from '../../../../../lib/confirm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@openbooks/ui'

/**
 * Payroll jurisdiction packs, in the spirit of the tax country packs: each
 * country is an installable statutory engine, and Canada is one pack among
 * many rather than the module's identity. Installing seeds the statutory
 * component set and records the pack in orgs.settings.payroll.
 */
/** One pack's declared statutory-table coverage (engine/src/payroll/tax-years.ts). */
export interface PackCoverage {
  country: string
  supported: number[]
  draft: number[]
  ratesModule: string
  editions: {
    year: number
    label: string
    effectiveFrom: string
    status: string
    region: string | null
  }[]
}

export function PayrollCountryPacks({
  installedCountries,
  componentCount,
  coverage,
}: {
  installedCountries: string[]
  componentCount: number
  coverage: PackCoverage[]
}) {
  const t = useTranslations('payroll.settingsPage.packs')
  // New keys ship with the handoff's message block; until it lands the strings
  // read as written rather than as a raw key path.
  const label = (key: string, fallback: string) => (t.has(key as never) ? t(key as never) : fallback)
  const locale = useLocale()
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(() => new Set(installedCountries))

  // Edition names are the agencies' own proper nouns, taken from the pack
  // declaration — never a list of countries this component knows about.
  const monthYear = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    [locale],
  )
  const editionLabels = useCallback(
    (country: string) =>
      (coverage.find((entry) => entry.country === country)?.editions ?? [])
        .filter((edition) => edition.region === null)
        .map((edition) =>
          `${edition.label} (${monthYear.format(new Date(`${edition.effectiveFrom}T00:00:00Z`))})`),
    [coverage, monthYear],
  )

  async function install(country: 'CA' | 'US') {
    setBusy(country)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install-pack', country }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setInstalled((current) => new Set(current).add(country))
      toast.success(t('installSuccess'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function uninstall(country: 'CA' | 'US') {
    const ok = await confirmDialog({
      title: t('uninstallTitle'),
      message: t('uninstallConfirm'),
      confirmLabel: t('uninstall'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(country)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'uninstall-pack', country }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setInstalled((current) => {
        const next = new Set(current)
        next.delete(country)
        return next
      })
      toast.success(t('uninstallSuccess'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /**
   * The years the pack's statutory tables are actually loaded for, and any year
   * that is scaffolded but not transcribed. Shown ON the pack card because
   * "which country do we run?" and "can we pay in January?" are the same
   * question, and the second one used to have no answer anywhere in the UI.
   */
  const coverageLine = (country: string) => {
    const entry = coverage.find((candidate) => candidate.country === country)
    if (!entry) return null
    return (
      <span className="flex flex-wrap items-center gap-1">
        <span>{label('taxYears', 'Statutory tables loaded for')}</span>
        {entry.supported.map((year) => (
          <Badge key={year} variant="success">{year}</Badge>
        ))}
        {entry.draft.map((year) => (
          <Badge key={year} variant="warning">
            {t.has('taxYearDraft' as never)
              ? (t as unknown as (key: string, values: Record<string, unknown>) => string)(
                  'taxYearDraft', { year },
                )
              : `${year} · scaffolded, not transcribed`}
          </Badge>
        ))}
        {entry.supported.length === 0 && entry.draft.length === 0 ? (
          <Badge variant="destructive">
            {label('taxYearNone', 'no statutory tables loaded')}
          </Badge>
        ) : null}
      </span>
    )
  }

  const packCard = (country: 'CA' | 'US', packKey: 'canada' | 'us', bullets: React.ReactNode[]) => {
    const isInstalled = installed.has(country)
    return (
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Globe2 size={18} className="text-slate-400" aria-hidden />
                {t(`${packKey}.title`)}
              </CardTitle>
              <CardDescription className="mt-1">{t(`${packKey}.description`)}</CardDescription>
            </div>
            {isInstalled ? (
              <Badge variant="success" className="shrink-0">
                <Check size={12} className="mr-0.5" aria-hidden />
                {t('installed')}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            {bullets.map((bullet, index) => (
              <li key={index} className="flex items-start gap-2">
                <BadgeCheck size={16} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
            {isInstalled && componentCount > 0 ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t('componentCount', { count: componentCount })}
              </span>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              {isInstalled ? (
                <Button variant="ghost" onClick={() => uninstall(country)} disabled={busy !== null}>
                  <Trash2 size={14} aria-hidden /> {t('uninstall')}
                </Button>
              ) : null}
              <Button
                variant={isInstalled ? 'outline' : 'default'}
                onClick={() => install(country)}
                disabled={busy !== null}
              >
                <Download size={14} aria-hidden /> {isInstalled ? t('reinstall') : t('install')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {packCard('CA', 'canada', [
          <span key="engine">
            {t('canada.engine')}{' '}
            <span className="text-slate-500 dark:text-slate-400">{editionLabels('CA').join(' + ')}</span>
          </span>,
          coverageLine('CA'),
          t('canada.coverage'),
          t('canada.components'),
          t('canada.verified'),
        ])}
        {packCard('US', 'us', [
          <span key="engine">
            {t('us.engine')}{' '}
            <span className="text-slate-500 dark:text-slate-400">{editionLabels('US').join(' + ')}</span>
          </span>,
          coverageLine('US'),
          t('us.coverage'),
          t('us.components'),
          t('us.config'),
        ])}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
    </div>
  )
}
