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
 * many rather than the module's identity. Installing seeds the statutory
 * component set and records the pack in orgs.settings.payroll.
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
  const [busy, setBusy] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(() => new Set(installedCountries))

  const editionLabels = useMemo(() => {
    const monthYear = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' })
    return editions.map((e) =>
      t('canada.edition', { edition: e.edition, effective: monthYear.format(new Date(`${e.effectiveFrom}T00:00:00Z`)) }),
    )
  }, [editions, locale, t])

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
            <Button
              variant={isInstalled ? 'outline' : 'default'}
              onClick={() => install(country)}
              disabled={busy !== null}
            >
              <Download size={14} aria-hidden /> {isInstalled ? t('reinstall') : t('install')}
            </Button>
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
            <span className="text-slate-500 dark:text-slate-400">{editionLabels.join(' + ')}</span>
          </span>,
          t('canada.coverage'),
          t('canada.components'),
          t('canada.verified'),
        ])}
        {packCard('US', 'us', [
          t('us.engine'),
          t('us.coverage'),
          t('us.components'),
          t('us.config'),
        ])}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
    </div>
  )
}
