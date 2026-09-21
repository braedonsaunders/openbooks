'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Check, ChevronRight, Landmark, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Select } from '@openbooks/ui'
import { countryOptions } from '../../../../../lib/countries'

type Pack = {
  code: string
  countryCode: string
  name: string
  calculationModel: 'pool' | 'macrs'
  classCount: number
}

export function TaxDepreciationSetup({
  companyCountry,
  packs,
  installedCodes,
  regimes,
  categories,
}: {
  companyCountry: string
  packs: Pack[]
  installedCodes: string[]
  regimes: { code: string; name: string; classAttribute: string; classes: { code: string; name: string }[] }[]
  categories: { id: string; name: string; taxAttributes: Record<string, unknown> }[]
}) {
  const t = useTranslations('admin.setup.taxDepreciationSetup')
  const locale = useLocale()
  const router = useRouter()
  const countryNames = useMemo(() => new Map(countryOptions(locale).map((item) => [item.value, item.label])), [locale])
  const [installed, setInstalled] = useState(() => new Set(installedCodes))
  const [busy, setBusy] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<Record<string, string>>(() => Object.fromEntries(
    categories.flatMap((category) => regimes.map((regime) => [`${category.id}:${regime.code}`, String(category.taxAttributes[regime.classAttribute] ?? '')])),
  ))

  async function install(code: string) {
    setBusy(code)
    try {
      const response = await fetch('/api/assets/tax-depreciation-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const result = (await response.json().catch(() => ({}))) as { classesCreated?: number; error?: string }
      if (!response.ok) throw new Error(result.error || t('installFailed'))
      setInstalled((current) => new Set([...current, code]))
      toast.success(t('installedToast', { count: result.classesCreated ?? 0 }))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('installFailed'))
    } finally {
      setBusy(null)
    }
  }

  async function assign(categoryId: string, regime: string, classCode: string) {
    const key = `${categoryId}:${regime}`
    const previous = assignments[key] ?? ''
    setAssignments((current) => ({ ...current, [key]: classCode }))
    try {
      const response = await fetch('/api/assets/tax-category-assignments', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId, regime, classCode: classCode || null }),
      })
      if (!response.ok) throw new Error()
    } catch {
      setAssignments((current) => ({ ...current, [key]: previous }))
      toast.error(t('assignmentFailed'))
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">{t('packsTitle')}</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('packsDescription')}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {[...packs].sort((a, b) => Number(b.countryCode === companyCountry) - Number(a.countryCode === companyCountry) || a.name.localeCompare(b.name)).map((pack) => {
            const isInstalled = installed.has(pack.code)
            const recommended = pack.countryCode === companyCountry
            return (
              <Card key={pack.code} className={recommended ? 'border-teal-500' : undefined}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Landmark size={16} />
                        {pack.name}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {countryNames.get(pack.countryCode) ?? pack.countryCode} · {t(`models.${pack.calculationModel}`)} · {t('classCount', { count: pack.classCount })}
                      </CardDescription>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {recommended ? <Badge variant="success">{t('recommended')}</Badge> : null}
                      {isInstalled ? <Badge variant="outline"><Check size={12} />{t('installed')}</Badge> : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button size="sm" variant={isInstalled ? 'outline' : 'default'} disabled={isInstalled || busy === pack.code} onClick={() => install(pack.code)}>
                    {busy === pack.code ? t('installing') : isInstalled ? t('installed') : t('install')}
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </section>

      {regimes.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="font-semibold text-slate-900 dark:text-slate-100">{t('assignmentsTitle')}</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('assignmentsDescription')}</p>
          </div>
          <Card><CardContent className="overflow-x-auto pt-6">
            <table className="w-full min-w-[42rem] text-sm">
              <thead><tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="px-3 py-2 text-left font-medium">{t('assetCategory')}</th>
                {regimes.map((regime) => <th key={regime.code} className="px-3 py-2 text-left font-medium">{regime.name}</th>)}
              </tr></thead>
              <tbody>{categories.map((category) => (
                <tr key={category.id} className="border-b border-slate-100 dark:border-slate-900">
                  <td className="px-3 py-2 font-medium">{category.name}</td>
                  {regimes.map((regime) => <td key={regime.code} className="px-3 py-2">
                    <Select value={assignments[`${category.id}:${regime.code}`] ?? ''} onChange={(event) => assign(category.id, regime.code, event.target.value)}>
                      <option value="">{t('notAssigned')}</option>
                      {regime.classes.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}
                    </Select>
                  </td>)}
                </tr>
              ))}</tbody>
            </table>
          </CardContent></Card>
        </section>
      ) : null}

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">{t('customizeTitle')}</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('customizeDescription')}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <SetupLink href="/admin/setup/tax-depreciation?tab=regimes" title={t('links.regimes.title')} description={t('links.regimes.description')} />
          <SetupLink href="/admin/setup/tax-depreciation?tab=classes" title={t('links.classes.title')} description={t('links.classes.description')} />
          <SetupLink href="/admin/setup/tax-depreciation?tab=first-year" title={t('links.firstYear.title')} description={t('links.firstYear.description')} />
          <SetupLink href="/admin/setup/asset-categories" title={t('links.assignments.title')} description={t('links.assignments.description')} />
        </div>
      </section>
    </div>
  )
}

function SetupLink({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link href={href as never} className="group rounded-xl border border-slate-200 bg-white p-4 hover:border-teal-500 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100"><Settings2 size={15} />{title}</div>
        <ChevronRight size={16} className="text-slate-400 group-hover:text-teal-600" />
      </div>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </Link>
  )
}
