'use client'

import { Fragment, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, Download, Plus, Upload } from 'lucide-react'
import { Button, FieldHelp, Input } from '@openbooks/ui'

interface DeclaredLevy {
  country: string
  levyKey: string
  label: string
  description: string
  scope: string
}

interface StoredLevyOpening {
  country: string
  levyKey: string
  region: string | null
  baseYtd: string
}

interface LevySaveError {
  levyKey: string
  region: string | null
  message: string
}

/** The employer-levies save endpoint's response body (success or failure). */
interface LevySaveResult {
  error?: unknown
  errors?: LevySaveError[]
  created?: number
  updated?: number
  deleted?: number
}

interface AddedRegionRow {
  id: number
  country: string
  levyKey: string
  region: string
  baseYtd: string
}

/**
 * Employer-side adoption carry-in: the base the employer earned before the
 * adoption date in each pack-declared aggregate levy's scope.
 *
 * A SIBLING SECTION rather than more columns on the year grid above, and the
 * reason is the key, not the layout. A statutory carry-in is a fact about one
 * employee; an employer levy is a fact about the whole employer (or one
 * region) — it has no employee row to hang on. Levy kinds come from the
 * country packs, so this names no country: a third pack's levy arrives with
 * the pack. When no pack declares a levy there is nothing to carry in, and
 * the section renders nothing rather than an empty grid.
 */
export function EmployerLevyOpeningsView({
  year,
  levies,
  rows,
  canManage,
}: {
  year: number
  levies: DeclaredLevy[]
  rows: StoredLevyOpening[]
  canManage: boolean
}) {
  const t = useTranslations('payroll')
  const router = useRouter()
  const text = (key: string, fallback: string) =>
    t.has(`openingBalances.employerLevies.${key}` as never)
      ? (t(`openingBalances.employerLevies.${key}` as never) as string)
      : fallback

  // Draft base amounts keyed by levy + region; rows the operator adds for a
  // new region ride in their own list because their key does not exist yet.
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [added, setAdded] = useState<AddedRegionRow[]>([])
  const [nextId, setNextId] = useState(1)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<LevySaveError[]>([])

  if (levies.length === 0) return null

  const rowKey = (country: string, levyKey: string, region: string | null) =>
    `${country}${levyKey}${region ?? ''}`

  const storedFor = (levy: DeclaredLevy) =>
    rows.filter((row) => row.country === levy.country && row.levyKey === levy.levyKey)

  const valueOf = (country: string, levyKey: string, region: string | null): string => {
    const key = rowKey(country, levyKey, region)
    const edited = draft[key]
    if (edited !== undefined) return edited
    const stored = rows.find(
      (row) =>
        row.country === country &&
        row.levyKey === levyKey &&
        (row.region ?? null) === (region ?? null),
    )?.baseYtd
    if (stored === undefined) return ''
    return Number(stored) === 0 ? '' : trimZeros(stored)
  }

  const setAmount = (country: string, levyKey: string, region: string | null, value: string) => {
    const key = rowKey(country, levyKey, region)
    setDraft((current) => ({ ...current, [key]: value }))
  }

  // Every row carrying an amount the operator typed (a blanked cell is a
  // clear only where a carry-in is stored — the service deletes on zero, so
  // a blank over nothing sends nothing).
  const payload = (): { country: string; levyKey: string; region: string | null; baseYtd: string }[] => {
    const out: { country: string; levyKey: string; region: string | null; baseYtd: string }[] = []
    for (const [key, value] of Object.entries(draft)) {
      const baseYtd = value.trim()
      if (baseYtd === '') continue
      const [country, levyKey, region] = key.split('')
      out.push({
        country: country!,
        levyKey: levyKey!,
        region: region === '' ? null : (region ?? null),
        baseYtd,
      })
    }
    for (const row of added) {
      if (row.baseYtd.trim() === '') continue
      out.push({
        country: row.country,
        levyKey: row.levyKey,
        region: row.region.trim() === '' ? null : row.region.trim(),
        baseYtd: row.baseYtd.trim(),
      })
    }
    return out
  }

  const dirtyCount = payload().length

  const save = async () => {
    const body_rows = payload()
    if (body_rows.length === 0) return
    setSaving(true)
    setErrors([])
    try {
      const response = await fetch('/api/payroll/opening-balances/employer-levies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taxYear: year, rows: body_rows }),
      })
      // The body is read once, tolerantly: a non-JSON error body (a proxy
      // page, an empty 502) falls back instead of throwing a SyntaxError out
      // of res.json(), and the status below decides how it is interpreted.
      // Named responseBody: the outer payload() builds the request rows, and
      // a typeof-self query on a shadowed name collapses the body to never.
      let responseBody: LevySaveResult | null = null
      try {
        responseBody = (await response.json()) as LevySaveResult
      } catch {
        responseBody = null
      }
      if (!response.ok) {
        const rawError = responseBody?.error
        const message =
          typeof rawError === 'string' && rawError.trim() !== ''
            ? rawError
            : `${text('saveFailed', 'Nothing was saved.')} (status ${response.status})`
        setErrors(responseBody?.errors ?? [{ levyKey: '', region: null, message }])
        toast.error(message)
        return
      }
      const body: LevySaveResult = responseBody ?? {}
      setDraft({})
      setAdded([])
      toast.success(
        text('saved', 'Employer carry-ins saved.') +
          ` (${body.created ?? 0} new, ${body.updated ?? 0} updated, ${body.deleted ?? 0} cleared)`,
      )
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-4" id="employer-levies">
      <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
        {text('title', 'Employer carry-ins (aggregate levies)')}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <FieldHelp
          help={text(
            'hint',
            'The base your previous provider had already counted this year, per employer levy. Without it the first run prices the full annual allowance again. A zero clears a carry-in.',
          )}
        />
        <Button variant="outline" size="sm" asChild>
          <Link href={'/data/import' as never}>
            <Upload size={14} aria-hidden />
            {text('bulkImport', 'Bulk load from a file')}
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href={'/data/export' as never}>
            <Download size={14} aria-hidden />
            {text('export', 'Export')}
          </Link>
        </Button>
        <div className="ml-auto flex items-center gap-3">
          {canManage && (
            <Button size="sm" disabled={saving || dirtyCount === 0} onClick={save}>
              {saving
                ? text('saving', 'Saving…')
                : `${text('save', 'Save')}${dirtyCount ? ` (${dirtyCount})` : ''}`}
            </Button>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-900/60 dark:bg-red-950/40">
          <p className="flex items-center gap-2 font-medium text-red-800 dark:text-red-300">
            <AlertTriangle size={15} aria-hidden />
            {text('rejected', 'Nothing was saved — fix these first.')}
          </p>
          <ul className="mt-2 space-y-1 text-red-700 dark:text-red-300">
            {errors.map((error, index) => (
              <li key={`${error.levyKey}-${error.region ?? ''}-${index}`}>
                {error.levyKey ? `${error.levyKey}${error.region ? ` (${error.region})` : ''}: ` : ''}
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
        <table className="w-full min-w-max text-sm">
          <thead className="bg-slate-50 text-left dark:bg-slate-900">
            <tr>
              <th className="px-3 py-2 font-medium text-slate-600 dark:text-slate-300">
                {text('levy', 'Levy')}
              </th>
              <th className="px-3 py-2 font-medium text-slate-600 dark:text-slate-300">
                {text('region', 'Region')}
              </th>
              <th className="px-3 py-2 font-medium text-slate-600 dark:text-slate-300">
                {text('baseYtd', 'Base year-to-date')}
              </th>
            </tr>
          </thead>
          <tbody>
            {levies.map((levy) => {
              const stored = storedFor(levy)
              // An org levy is one row; a region levy is one row per stored
              // region. Either renders a blank row when nothing is stored, so
              // the levy is enterable, not just editable.
              const editable =
                stored.length > 0
                  ? stored
                  : [{ country: levy.country, levyKey: levy.levyKey, region: null as string | null, baseYtd: '0' }]
              const levyAdded = added.filter(
                (row) => row.country === levy.country && row.levyKey === levy.levyKey,
              )
              return (
                <Fragment key={`${levy.country} ${levy.levyKey}`}>
                  {editable.map((row) => {
                    const key = rowKey(levy.country, levy.levyKey, row.region)
                    return (
                      <tr key={key} className="border-t border-slate-200 dark:border-slate-800">
                        <td className="px-3 py-2">
                          <span className="font-medium">{levy.label}</span>{' '}
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {levy.country} · {levy.description}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                          {levy.scope === 'region' ? (row.region ?? '—') : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            aria-label={`${levy.label} base year-to-date${row.region ? `, ${row.region}` : ''}`}
                            value={valueOf(levy.country, levy.levyKey, row.region)}
                            disabled={!canManage}
                            className="w-40"
                            inputMode="decimal"
                            onChange={(event) => setAmount(levy.country, levy.levyKey, row.region, event.target.value)}
                          />
                        </td>
                      </tr>
                    )
                  })}
                  {levyAdded.map((row) => (
                    <tr key={`added-${row.id}`} className="border-t border-slate-200 dark:border-slate-800">
                      <td className="px-3 py-2">
                        <span className="font-medium">{levy.label}</span>{' '}
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {levy.country} · {levy.description}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          aria-label={text('regionLabel', 'Region code')}
                          placeholder={text('regionPlaceholder', 'e.g. ON')}
                          value={row.region}
                          disabled={!canManage}
                          className="w-32"
                          onChange={(event) =>
                            setAdded((current) =>
                              current.map((candidate) =>
                                candidate.id === row.id ? { ...candidate, region: event.target.value } : candidate,
                              ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          aria-label={text('newBaseLabel', 'New region base year-to-date')}
                          className="w-40"
                          inputMode="decimal"
                          disabled={!canManage}
                          value={row.baseYtd}
                          onChange={(event) =>
                            setAdded((current) =>
                              current.map((candidate) =>
                                candidate.id === row.id ? { ...candidate, baseYtd: event.target.value } : candidate,
                              ),
                            )
                          }
                        />
                      </td>
                    </tr>
                  ))}
                  {levy.scope === 'region' && canManage && (
                    <tr className="border-t border-slate-200 dark:border-slate-800">
                      <td colSpan={3} className="px-3 py-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const id = nextId
                            setNextId(id + 1)
                            setAdded((current) => [
                              ...current,
                              { id, country: levy.country, levyKey: levy.levyKey, region: '', baseYtd: '' },
                            ])
                          }}
                        >
                          <Plus size={14} aria-hidden />
                          {text('addRegion', 'Add a region')}
                        </Button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function trimZeros(value: string): string {
  if (!value.includes('.')) return value
  return value.replace(/0+$/, '').replace(/\.$/, '')
}
