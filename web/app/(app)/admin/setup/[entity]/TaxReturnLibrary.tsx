'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight, Library, Search } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UrlDrawer,
} from '@openbooks/ui'
import { countryOptions } from '../../../../../lib/countries'

const PACKS_PER_PAGE = 5

export interface TaxPackOption {
  code: string
  name: string
  country: string
}

export function TaxReturnLibrary({
  packs,
  installedCodes,
  open,
  openHref,
  closeHref,
}: {
  packs: TaxPackOption[]
  installedCodes: string[]
  open: boolean
  openHref: string
  closeHref: string
}) {
  const t = useTranslations('admin.setup.taxLibrary')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(() => new Set())
  const [installedCodesState, setInstalledCodesState] = useState<Set<string>>(() => new Set(installedCodes))
  const [busy, setBusy] = useState<'install' | string | null>(null)
  const countryNames = useMemo(
    () => new Map(countryOptions(locale).map((country) => [country.value, country.label])),
    [locale],
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale)
    if (!needle) return packs
    return packs.filter((pack) => [pack.code, pack.name, pack.country, countryNames.get(pack.country)]
      .some((value) => String(value ?? '').toLocaleLowerCase(locale).includes(needle)))
  }, [countryNames, locale, packs, query])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PACKS_PER_PAGE))
  const shown = filtered.slice((page - 1) * PACKS_PER_PAGE, page * PACKS_PER_PAGE)
  const visibleAvailable = shown.filter((pack) => !installedCodesState.has(pack.code))
  const allVisibleSelected = visibleAvailable.length > 0 && visibleAvailable.every((pack) => selectedCodes.has(pack.code))

  useEffect(() => {
    setInstalledCodesState(new Set(installedCodes))
  }, [installedCodes])

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  function toggle(code: string) {
    setSelectedCodes((current) => {
      const next = new Set(current)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  function toggleVisible() {
    setSelectedCodes((current) => {
      const next = new Set(current)
      for (const pack of visibleAvailable) {
        if (allVisibleSelected) next.delete(pack.code)
        else next.add(pack.code)
      }
      return next
    })
  }

  async function installSelected() {
    const packsToInstall = [...selectedCodes].filter((code) => !installedCodesState.has(code))
    if (packsToInstall.length === 0) return
    setBusy('install')
    try {
      const response = await fetch('/api/tax/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packs: packsToInstall, mode: 'install' }),
      })
      if (!response.ok) throw new Error()
      const data = await response.json() as { installed?: string[] }
      const completed = data.installed ?? packsToInstall
      setInstalledCodesState((current) => new Set([...current, ...completed]))
      setSelectedCodes((current) => new Set([...current].filter((code) => !completed.includes(code))))
      toast.success(t('installSuccess', { count: completed.length }))
      router.refresh()
    } catch {
      toast.error(tCommon('feedback.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function reset(pack: TaxPackOption) {
    if (!confirm(t('confirmReset', { name: pack.name }))) return
    setBusy(pack.code)
    try {
      const response = await fetch('/api/tax/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packs: [pack.code], mode: 'reset' }),
      })
      if (!response.ok) throw new Error()
      toast.success(t('resetSuccess'))
      router.refresh()
    } catch {
      toast.error(tCommon('feedback.saveFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Button asChild variant="outline">
        <Link href={openHref as any}>
          <Library size={15} />
          {t('open')}
        </Link>
      </Button>
      {open ? (
        <UrlDrawer
          open
          closeHref={closeHref}
          size="lg"
          title={t('title')}
          description={t('description')}
          footer={
            <Button onClick={installSelected} disabled={busy !== null || selectedCodes.size === 0}>
              {busy === 'install' ? t('working') : t('installSelected', { count: selectedCodes.size })}
            </Button>
          }
        >
          <div className="space-y-3 p-1">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 text-slate-400" size={16} />
              <Input
                type="search"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setPage(1) }}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchPlaceholder')}
                className="pl-9"
              />
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleVisible}
                        disabled={visibleAvailable.length === 0}
                        aria-label={t('selectVisible')}
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                    </TableHead>
                    <TableHead>{t('pack')}</TableHead>
                    <TableHead className="w-28">{t('status')}</TableHead>
                    <TableHead className="w-28 text-right">{tCommon('labels.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((pack) => {
                    const installed = installedCodesState.has(pack.code)
                    return (
                      <TableRow key={pack.code}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selectedCodes.has(pack.code)}
                            onChange={() => toggle(pack.code)}
                            disabled={installed || busy !== null}
                            aria-label={t('selectPack', { name: pack.name })}
                            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                          />
                        </TableCell>
                        <TableCell>
                          <div className="font-medium text-slate-900 dark:text-slate-100">{pack.name}</div>
                          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            {countryNames.get(pack.country) ?? pack.country} · <span className="font-mono">{pack.code}</span>
                          </div>
                          {pack.code === 'US_SALES_TAX_WORKPAPER' ? (
                            <p className="mt-1 max-w-xl text-xs text-amber-700 dark:text-amber-300">{t('usNotice')}</p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge variant={installed ? 'success' : 'outline'}>
                            {installed ? t('installed') : t('available')}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {installed ? (
                            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => reset(pack)}>
                              {busy === pack.code ? t('working') : tCommon('actions.reset')}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {shown.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-sm text-slate-500">
                        {tCommon('feedback.noResults')}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <span>{t('resultCount', { count: filtered.length })}</span>
                {pageCount > 1 ? (
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} aria-label={tCommon('actions.previous')}>
                      <ChevronLeft size={14} />
                    </Button>
                    <span>{t('pageOf', { page, pages: pageCount })}</span>
                    <Button variant="ghost" size="sm" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)} aria-label={tCommon('actions.next')}>
                      <ChevronRight size={14} />
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('selectionCount', { count: selectedCodes.size })}
            </p>
          </div>
        </UrlDrawer>
      ) : null}
    </>
  )
}
