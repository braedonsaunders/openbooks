'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { BadgeCheck, Check, Download, Globe2, Search, Trash2 } from 'lucide-react'
import { readApiErrorMessage } from '../../../../../lib/api-error'
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
  installable,
  componentCount,
  coverage,
}: {
  installedCountries: string[]
  /** Every pack the registry declares installable — the grid renders one card
   * per entry, so a new pack appears with no component edit. Carries each
   * pack's own name so a card never has to fall back to a bare country code. */
  installable: { country: string; name: string }[]
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
  const [query, setQuery] = useState('')
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

  async function install(country: string) {
    setBusy(country)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install-pack', country }),
      })
      // The status is checked before the body is parsed: a non-JSON error body
      // (this route rethrows non-domain errors as an unhandled empty 500) must
      // surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, `failed to install the ${country} payroll pack`))
      setInstalled((current) => new Set(current).add(country))
      toast.success(t('installSuccess'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function uninstall(country: string) {
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
      // The status is checked before the body is parsed (see install above).
      if (!res.ok) throw new Error(await readApiErrorMessage(res, `failed to uninstall the ${country} payroll pack`))
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

  /**
   * Locale namespace per pack. Pack copy is pack CONTENT, not a country
   * allowlist: an installable pack with no namespace here still renders —
   * under its country code with its data-driven lines — the way the setup
   * wizard already falls back (payroll-pack-display.ts). Adding copy for a
   * new pack is a translation edit, never a component edit.
   */
  const packI18nKey = (country: string) =>
    ({ CA: 'canada', US: 'us' })[country] ?? country.toLowerCase()
  const packName = (country: string) =>
    installable.find((entry) => entry.country === country)?.name ?? country
  const packCopy = (country: string, key: string, fallback: string) => {
    const namespaced = `${packI18nKey(country)}.${key}`
    return t.has(namespaced as never) ? t(namespaced as never) : fallback
  }

  const packCard = (country: string) => {
    const isInstalled = installed.has(country)
    // Data-driven lines every pack gets: the statutory-engine editions and
    // the loaded-years coverage, both read off the pack declaration. The
    // remaining bullets are pack copy where it exists — the same keys in the
    // same order as the per-pack cards this replaces, so CA/US read
    // identically and a pack with no copy ships an honest sparse card.
    const bullets = [
      <span key="engine">
        {packCopy(country, 'engine', label('engine', 'Statutory engine'))}{' '}
        <span className="text-slate-500 dark:text-slate-400">{editionLabels(country).join(' + ')}</span>
      </span>,
      coverageLine(country),
      ...(['coverage', 'components', 'verified', 'config'] as const).flatMap((key) => {
        const namespaced = `${packI18nKey(country)}.${key}`
        return t.has(namespaced as never)
          ? [<span key={key}>{t(namespaced as never)}</span>]
          : []
      }),
    ]
    return (
      <Card key={country}>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Globe2 size={18} className="text-slate-400" aria-hidden />
                {packCopy(country, 'title', packName(country))}
              </CardTitle>
              <CardDescription className="mt-1">{packCopy(country, 'description', '')}</CardDescription>
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

  // Match on the name AND the code, because an operator who knows the country
  // by either should find it: "United Kingdom", "uk" and "GB" all reach GB.
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? installable.filter((entry) =>
        entry.name.toLowerCase().includes(needle)
        || entry.country.toLowerCase().includes(needle))
    : installable

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={label('searchPlaceholder', 'Search countries')}
          aria-label={label('searchLabel', 'Search payroll country packs')}
          className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {shown.map((entry) => packCard(entry.country))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {label('searchEmpty', 'No payroll country pack matches that search.')}
        </p>
      ) : null}
      <p className="text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>
    </div>
  )
}
