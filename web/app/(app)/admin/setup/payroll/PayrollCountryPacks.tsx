'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { BadgeCheck, Check, Download, Globe2 } from 'lucide-react'
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
 * (eventually) many rather than the module's identity. Installing seeds the
 * statutory component set and records the pack in orgs.settings.payroll.
 */
export function PayrollCountryPacks({
  installedCountries,
  componentCount,
  editions,
}: {
  installedCountries: string[]
  componentCount: number
  editions: { edition: number; effectiveFrom: string }[]
}) {
  const t = useTranslations('payroll.settingsPage.packs')
  const locale = useLocale()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState<Set<string>>(() => new Set(installedCountries))

  const editionLabels = useMemo(() => {
    const monthYear = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' })
    return editions.map((e) =>
      t('canada.edition', { edition: e.edition, effective: monthYear.format(new Date(`${e.effectiveFrom}T00:00:00Z`)) }),
    )
  }, [editions, locale, t])

  const canadaInstalled = installed.has('CA')

  async function installCanada() {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install-pack', country: 'CA' }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setInstalled((current) => new Set(current).add('CA'))
      toast.success(t('installSuccess'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Globe2 size={18} className="text-slate-400" aria-hidden />
                  {t('canada.title')}
                </CardTitle>
                <CardDescription className="mt-1">{t('canada.description')}</CardDescription>
              </div>
              {canadaInstalled ? (
                <Badge variant="success" className="shrink-0">
                  <Check size={12} className="mr-0.5" aria-hidden />
                  {t('installed')}
                </Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
              <li className="flex items-start gap-2">
                <BadgeCheck size={16} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                <span>
                  {t('canada.engine')}{' '}
                  <span className="text-slate-500 dark:text-slate-400">{editionLabels.join(' + ')}</span>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <BadgeCheck size={16} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                <span>{t('canada.coverage')}</span>
              </li>
              <li className="flex items-start gap-2">
                <BadgeCheck size={16} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                <span>{t('canada.components')}</span>
              </li>
              <li className="flex items-start gap-2">
                <BadgeCheck size={16} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                <span>{t('canada.verified')}</span>
              </li>
            </ul>
            <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
              {canadaInstalled && componentCount > 0 ? (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {t('componentCount', { count: componentCount })}
                </span>
              ) : (
                <span />
              )}
              <Button
                variant={canadaInstalled ? 'outline' : 'default'}
                onClick={installCanada}
                disabled={busy}
              >
                <Download size={14} aria-hidden /> {canadaInstalled ? t('reinstall') : t('install')}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="opacity-75">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Globe2 size={18} className="text-slate-400" aria-hidden />
                  {t('us.title')}
                </CardTitle>
                <CardDescription className="mt-1">{t('us.description')}</CardDescription>
              </div>
              <Badge variant="outline" className="shrink-0">
                {t('planned')}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-end border-t border-slate-100 pt-3 dark:border-slate-800">
              <Button variant="outline" disabled>
                {t('plannedAction')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
    </div>
  )
}
