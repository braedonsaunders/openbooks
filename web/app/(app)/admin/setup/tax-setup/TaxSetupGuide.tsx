'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowRight, BadgeCheck, Check, ChevronDown, MapPin, Search } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@openbooks/ui'
import { countryOptions } from '../../../../../lib/countries'

export interface SupportedSubJurisdiction {
  packCode: string
  region: string
  name: string
}
export interface SupportedCountry {
  country: string
  name: string
  countryPack: string | null
  subs: SupportedSubJurisdiction[]
}

/**
 * Streamlined tax setup: pick the countries you do business in (and, where
 * supported, the states/provinces). One action then provisions the whole
 * indirect-tax stack for each — jurisdiction, tax code + rate, return form, and
 * nexus registration. Steps 2 and 3 link on to review what was created.
 */
export function TaxSetupGuide({
  countries,
  installedCodes,
  jurisdictionCount,
  registrationCount,
}: {
  countries: SupportedCountry[]
  installedCodes: string[]
  jurisdictionCount: number
  registrationCount: number
}) {
  const t = useTranslations('admin.setup.taxSetup')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [installed, setInstalled] = useState<Set<string>>(() => new Set(installedCodes))
  const [busy, setBusy] = useState(false)

  const countryNames = useMemo(
    () => new Map(countryOptions(locale).map((c) => [c.value, c.label])),
    [locale],
  )
  const label = (c: SupportedCountry) => countryNames.get(c.country) ?? c.name

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale)
    if (!needle) return countries
    return countries.filter((c) =>
      [label(c), c.country, ...c.subs.map((s) => s.name)].some((v) =>
        String(v ?? '').toLocaleLowerCase(locale).includes(needle),
      ),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countries, countryNames, locale, query])

  // Selecting a country selects its country pack; expand to add state packs.
  function toggleCountry(c: SupportedCountry) {
    const key = c.countryPack ?? c.subs[0]?.packCode
    if (!key) return
    setSelected((cur) => {
      const next = new Set(cur)
      const anySelected = c.countryPack ? next.has(c.countryPack) : c.subs.some((s) => next.has(s.packCode))
      if (anySelected) {
        // Deselect the country and all its subs.
        if (c.countryPack) next.delete(c.countryPack)
        c.subs.forEach((s) => next.delete(s.packCode))
      } else if (c.countryPack) {
        next.add(c.countryPack)
      } else if (c.subs[0]) {
        next.add(c.subs[0].packCode)
      }
      return next
    })
    if (c.subs.length) setExpanded((cur) => new Set(cur).add(c.country))
  }

  function toggleSub(packCode: string) {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(packCode)) next.delete(packCode)
      else next.add(packCode)
      return next
    })
  }

  const toProvision = useMemo(() => [...selected].filter((c) => !installed.has(c)), [selected, installed])

  async function provision() {
    if (toProvision.length === 0) return
    setBusy(true)
    try {
      const res = await fetch('/api/tax/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packs: toProvision }),
      })
      if (!res.ok) throw new Error()
      const data = (await res.json()) as { jurisdictionsCreated: number; taxCodesCreated: number; taxGroupsCreated: number; registrationsCreated: number }
      setInstalled((cur) => new Set([...cur, ...toProvision]))
      setSelected(new Set())
      toast.success(t('provisionSuccess', {
        jurisdictions: data.jurisdictionsCreated,
        codes: data.taxCodesCreated,
        groups: data.taxGroupsCreated,
        nexus: data.registrationsCreated,
      }))
      router.refresh()
    } catch {
      toast.error(tCommon('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-600 text-xs font-bold text-white">1</span>
                {t('step1.title')}
              </CardTitle>
              <CardDescription className="mt-1">{t('step1.description')}</CardDescription>
            </div>
            <Button onClick={provision} disabled={busy || toProvision.length === 0}>
              {busy ? t('provisioning') : t('provisionSelected', { count: toProvision.length })}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-3 text-slate-400" size={16} />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className="pl-9"
            />
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {filtered.map((c) => {
              const countrySelected = c.countryPack ? selected.has(c.countryPack) : c.subs.some((s) => selected.has(s.packCode))
              const countryInstalled = c.countryPack
                ? installed.has(c.countryPack)
                : c.subs.length > 0 && c.subs.every((s) => installed.has(s.packCode))
              const isOpen = expanded.has(c.country)
              const selectedSubs = c.subs.filter((s) => selected.has(s.packCode)).length
              return (
                <li key={c.country} className={`rounded-xl border ${countrySelected ? 'border-teal-500' : 'border-slate-200 dark:border-slate-800'}`}>
                  <div className="flex items-center gap-2 p-3">
                    <button
                      type="button"
                      onClick={() => toggleCountry(c)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${countrySelected ? 'border-teal-500 bg-teal-500 text-white' : 'border-slate-300 dark:border-slate-600'}`}>
                        {countrySelected ? <Check size={13} /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900 dark:text-slate-100">{label(c)}</span>
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                          {c.subs.length
                            ? t('statesAvailable', { count: c.subs.length })
                            : (c.countryPack ?? '').replace(/_/g, ' ')}
                        </span>
                      </span>
                    </button>
                    {countryInstalled ? <Badge variant="success" className="shrink-0"><Check size={12} className="mr-0.5" />{t('installed')}</Badge> : null}
                    {c.subs.length ? (
                      <button
                        type="button"
                        onClick={() => setExpanded((cur) => { const n = new Set(cur); n.has(c.country) ? n.delete(c.country) : n.add(c.country); return n })}
                        className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        aria-label={t('toggleStates', { country: label(c) })}
                      >
                        <ChevronDown size={16} className={isOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
                      </button>
                    ) : null}
                  </div>
                  {c.subs.length && isOpen ? (
                    <ul className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
                      {c.subs.map((s) => {
                        const on = selected.has(s.packCode)
                        const sInstalled = installed.has(s.packCode)
                        return (
                          <li key={s.packCode}>
                            <button
                              type="button"
                              onClick={() => toggleSub(s.packCode)}
                              disabled={sInstalled}
                              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-slate-50 disabled:opacity-60 dark:hover:bg-slate-900/40"
                            >
                              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on || sInstalled ? 'border-teal-500 bg-teal-500 text-white' : 'border-slate-300 dark:border-slate-600'}`}>
                                {on || sInstalled ? <Check size={11} /> : null}
                              </span>
                              <span className="text-slate-700 dark:text-slate-200">{s.name}</span>
                              {sInstalled ? <span className="ml-auto text-xs text-teal-600">{t('installed')}</span> : null}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                  {selectedSubs > 0 && !isOpen ? (
                    <div className="border-t border-slate-100 px-3 py-1.5 text-xs text-teal-700 dark:border-slate-800 dark:text-teal-300">
                      {t('statesSelected', { count: selectedSubs })}
                    </div>
                  ) : null}
                </li>
              )
            })}
            {filtered.length === 0 ? (
              <li className="col-span-full py-8 text-center text-sm text-slate-500">{tCommon('feedback.noResults')}</li>
            ) : null}
          </ul>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('provisionHint')}</p>
        </CardContent>
      </Card>

      <StepLink
        n={2}
        icon={<MapPin size={18} />}
        title={t('step2.title')}
        description={t('step2.description')}
        stat={t('step2.stat', { count: jurisdictionCount })}
        href="/admin/setup/tax-jurisdictions"
        cta={t('step2.cta')}
      />
      <StepLink
        n={3}
        icon={<BadgeCheck size={18} />}
        title={t('step3.title')}
        description={t('step3.description')}
        stat={t('step3.stat', { count: registrationCount })}
        href="/admin/setup/tax-registrations"
        cta={t('step3.cta')}
      />
    </div>
  )
}

function StepLink({
  n,
  icon,
  title,
  description,
  stat,
  href,
  cta,
}: {
  n: number
  icon: React.ReactNode
  title: string
  description: string
  stat: string
  href: string
  cta: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-200">{n}</span>
          <div>
            <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
              <span className="text-slate-400">{icon}</span>
              {title}
            </div>
            <p className="mt-0.5 max-w-xl text-sm text-slate-500 dark:text-slate-400">{description}</p>
            <p className="mt-1 text-xs font-medium text-teal-700 dark:text-teal-300">{stat}</p>
          </div>
        </div>
        <Button asChild variant="outline" className="shrink-0">
          <Link href={href as never}>
            {cta}
            <ArrowRight size={14} />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
