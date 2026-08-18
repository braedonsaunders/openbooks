'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Alert, Badge, Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'

/**
 * Statutory rates the employer supplies — at the scope the country pack says
 * each one varies by.
 *
 * Nothing here is jurisdictional. The surface renders the installed packs'
 * declared rate slots (engine/src/payroll/statutory-rates.ts): the slot's label,
 * why it cannot be a published constant, its citation, and one input per
 * declared field with that field's own help. A pack that declares a new levy —
 * or a new region for an existing one — appears here with no edit to this file,
 * which is the whole point: the previous screen hardcoded a FUTA box, a SUI
 * table and an Ontario EHT box, so a two-EIN employer and a British Columbia
 * employer both had nowhere to put a real number.
 *
 * House composition: PagedTable for the list, the house Drawer for the detail,
 * field help in the FieldLabel `?` popover.
 */

type Scope = 'org' | 'region' | 'sub_region' | 'filing_account'

interface RateField {
  key: string
  label: string
  kind: 'rate' | 'percent' | 'amount'
  decimals: number
  min: string
  max: string
  required: boolean
  help: string
}

interface RateSlot {
  key: string
  label: string
  scope: Scope
  programType: string | null
  regions: string[] | null
  citation: string
  variesBecause: string
  systemKeys: string[]
  fields: RateField[]
}

interface RateAccount {
  id: string
  accountNumber: string
  name: string
  programType: string
  stateCode: string | null
}

interface RatePack {
  country: string
  regionLabel: string
  knownRegions: string[]
  slots: RateSlot[]
  accounts: RateAccount[]
}

interface RateRow {
  id: string
  country: string
  rateKey: string
  region: string | null
  subRegion: string | null
  filingAccountId: string | null
  accountNumber: string | null
  accountName: string | null
  taxYear: number
  values: Record<string, string>
}

interface RateGap {
  country: string
  slotKey: string
  label: string
  region: string | null
  subRegion?: string | null
  filingAccountId: string | null
  message: string
}

interface Coverage {
  country: string
  supported: number[]
  draft: number[]
  ratesModule: string
  regions: { region: string; supported: number[]; draft: number[] }[]
  editions: { year: number; label: string; effectiveFrom: string; status: string; region?: string }[]
}

interface Payload {
  year: number
  installed: string[]
  packs: RatePack[]
  rows: RateRow[]
  gaps: RateGap[]
  coverage: Coverage[]
}

interface DraftRate {
  country: string
  rateKey: string
  region: string
  subRegion: string
  filingAccountId: string
  taxYear: number
  values: Record<string, string>
  existingId: string | null
}

export function StatutoryRatesSection({ initialYear }: { initialYear?: number }) {
  const t = useTranslations('payroll.settingsPage')
  const label = (key: string, fallback: string) => (t.has(key as never) ? t(key as never) : fallback)
  const [data, setData] = useState<Payload | null>(null)
  const [year, setYear] = useState<number | null>(initialYear ?? null)
  const [draft, setDraft] = useState<DraftRate | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback(async (forYear: number | null) => {
    const query = forYear ? `?year=${forYear}` : ''
    const res = await fetch(`/api/payroll/settings/rates${query}`)
    const payload = (await res.json()) as Payload & { error?: string }
    if (!res.ok) {
      setFailure(payload.error ?? 'failed')
      return
    }
    setFailure(null)
    setData(payload)
    setYear(payload.year)
  }, [])

  useEffect(() => {
    void load(initialYear ?? null)
  }, [load, initialYear])

  const slotOf = useCallback(
    (country: string, rateKey: string): RateSlot | undefined =>
      data?.packs.find((pack) => pack.country === country)?.slots.find((slot) => slot.key === rateKey),
    [data],
  )

  const rows = data?.rows ?? []

  const yearOptions = useMemo(() => {
    const current = year ?? new Date().getFullYear()
    return [current - 1, current, current + 1]
  }, [year])

  async function save() {
    if (!draft) return
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/settings/rates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: draft.country,
          rateKey: draft.rateKey,
          region: draft.region || null,
          subRegion: draft.subRegion || null,
          filingAccountId: draft.filingAccountId || null,
          taxYear: draft.taxYear,
          values: draft.values,
        }),
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.error ?? 'failed')
      toast.success(label('saved', 'Saved'))
      setDraft(null)
      await load(year)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/payroll/settings/rates?id=${id}`, { method: 'DELETE' })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.error ?? 'failed')
      toast.success(label('saved', 'Saved'))
      setDraft(null)
      await load(year)
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const formatValues = (row: RateRow): string => {
    const slot = slotOf(row.country, row.rateKey)
    if (!slot) return Object.keys(row.values).map((key) => `${key} ${row.values[key]}`).join(' · ')
    return slot.fields
      .filter((field) => row.values[field.key] != null)
      .map((field) => `${field.label} ${row.values[field.key]}`)
      .join(' · ')
  }

  const scopeBadge = (slot: RateSlot | undefined, row: RateRow) => {
    if (!slot) return null
    if (slot.scope === 'org') return <Badge variant="outline">{label('rates.scope.org', 'Employer-wide')}</Badge>
    if (slot.scope === 'sub_region') {
      return (
        <Badge variant="outline">
          {label('rates.scope.subRegion', 'Per taxing jurisdiction')}
        </Badge>
      )
    }
    if (slot.scope === 'region' || !row.filingAccountId) {
      return <Badge variant="outline">{label('rates.scope.region', 'Per region')}</Badge>
    }
    return <Badge variant="success">{label('rates.scope.account', 'Per filing account')}</Badge>
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {label('rates.title', 'Statutory rates')}
        </h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          {label(
            'rates.description',
            'Rates no publication can supply, or that agencies publish per region or per registered account. Everything else — tax brackets, contribution maximums, credit amounts — comes from the country pack and cannot be edited here.',
          )}
        </p>
      </div>

      {failure ? <Alert variant="destructive">{failure}</Alert> : null}

      {data && data.packs.length === 0 ? (
        <Alert>
          {label(
            'rates.noPacks',
            'No installed country pack declares an employer-entered statutory rate. Install a pack on the Country packs tab.',
          )}
        </Alert>
      ) : null}

      {/* Which years each pack's statutory tables are actually loaded for. The
          same declaration the pay-run blocker and the year-end refusal read, so
          "2027 is not loaded yet" is visible here BEFORE January. */}
      {data?.coverage.map((entry) => (
        <div
          key={entry.country}
          className="rounded-xl border border-slate-200 bg-white p-3 text-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-900 dark:text-slate-100">{entry.country}</span>
            <span className="text-slate-500 dark:text-slate-400">
              {label('rates.tablesLoaded', 'Statutory tables loaded for')}
            </span>
            {entry.supported.map((loaded) => (
              <Badge key={loaded} variant="success">{loaded}</Badge>
            ))}
            {entry.draft.map((drafted) => (
              <Badge key={drafted} variant="warning">
                {drafted} · {label('rates.draftEdition', 'scaffolded, not transcribed')}
              </Badge>
            ))}
            {year != null && !entry.supported.includes(year) ? (
              <Badge variant="destructive">
                {year} · {label('rates.notLoaded', 'not loaded')}
              </Badge>
            ) : null}
          </div>
          {entry.regions.length > 0 ? (
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {entry.regions.map((region) => (
                <span key={region.region} className="mr-3">
                  {region.region}: {region.supported.join(', ') || label('rates.notLoaded', 'not loaded')}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Label htmlFor="rates-year" help={label('rates.yearHelp', 'Statutory rates are assigned for a tax year — a state rate notice, a credit-reduction determination, a provincial exemption. Rates entered for one year never reinterpret another year’s payroll.')}>
            {label('rates.year', 'Tax year')}
          </Label>
          <Select
            id="rates-year"
            value={String(year ?? '')}
            onChange={(e) => void load(Number(e.target.value))}
          >
            {yearOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </Select>
        </div>
        <Button
          disabled={!data || data.packs.length === 0}
          onClick={() => {
            const pack = data?.packs[0]
            const slot = pack?.slots[0]
            if (!pack || !slot || year == null) return
            setDraft({
              country: pack.country,
              rateKey: slot.key,
              region: '',
              subRegion: '',
              filingAccountId: '',
              taxYear: year,
              values: {},
              existingId: null,
            })
          }}
        >
          {label('rates.add', 'Add a rate')}
        </Button>
      </div>

      {/* Gaps: what the payroll population needs and nobody has entered. State
          text, not prose — it changes as rates are entered. */}
      {data && data.gaps.length > 0 ? (
        <Alert variant="warning">
          <div className="font-medium">{label('rates.gapsTitle', 'Not configured for this year')}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {data.gaps.map((gap) => (
              <li key={`${gap.country}-${gap.slotKey}-${gap.region ?? ''}-${gap.subRegion ?? ''}-${gap.filingAccountId ?? ''}`}>
                {gap.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <PagedTable
        rows={rows}
        rowKey={(row) => row.id}
        searchable
        empty={
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            {label('rates.empty', 'No statutory rates are entered for this year.')}
          </div>
        }
        onRowClick={(row) => setDraft({
          country: row.country,
          rateKey: row.rateKey,
          region: row.region ?? '',
          subRegion: row.subRegion ?? '',
          filingAccountId: row.filingAccountId ?? '',
          taxYear: row.taxYear,
          values: { ...row.values },
          existingId: row.id,
        })}
        columns={[
          {
            key: 'levy',
            header: label('rates.columns.levy', 'Rate'),
            cell: (row) => slotOf(row.country, row.rateKey)?.label ?? row.rateKey,
            search: (row) => `${row.country} ${slotOf(row.country, row.rateKey)?.label ?? row.rateKey}`,
          },
          {
            key: 'scope',
            header: label('rates.columns.scope', 'Scope'),
            cell: (row) => scopeBadge(slotOf(row.country, row.rateKey), row),
          },
          {
            key: 'region',
            header: label('rates.columns.region', 'Region'),
            // The jurisdiction below the region belongs beside it, not in a
            // column of its own: an Ohio municipal rate reads "OH · COLUMBUS",
            // and a state-wide rate reads "OH".
            cell: (row) => row.subRegion ? `${row.region ?? '—'} · ${row.subRegion}` : (row.region ?? '—'),
            search: (row) => `${row.region ?? ''} ${row.subRegion ?? ''}`,
          },
          {
            key: 'account',
            header: label('rates.columns.account', 'Filing account'),
            cell: (row) => row.accountNumber
              ? `${row.accountNumber}${row.accountName ? ` · ${row.accountName}` : ''}`
              : label('rates.allAccounts', 'All accounts'),
            search: (row) => `${row.accountNumber ?? ''} ${row.accountName ?? ''}`,
          },
          {
            key: 'values',
            header: label('rates.columns.values', 'Values'),
            cell: (row) => <span className="tabular-nums">{formatValues(row)}</span>,
          },
        ]}
      />

      <RateDrawer
        draft={draft}
        data={data}
        busy={busy}
        label={label}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={save}
        onRemove={remove}
      />
    </div>
  )
}

function RateDrawer({
  draft, data, busy, label, onChange, onClose, onSave, onRemove,
}: {
  draft: DraftRate | null
  data: Payload | null
  busy: boolean
  label: (key: string, fallback: string) => string
  onChange: (next: DraftRate) => void
  onClose: () => void
  onSave: () => void
  onRemove: (id: string) => void
}) {
  const pack = data?.packs.find((entry) => entry.country === draft?.country)
  const slot = pack?.slots.find((entry) => entry.key === draft?.rateKey)
  const regions = slot?.regions ?? pack?.knownRegions ?? []
  // Only accounts of the program type the slot declares can hold the rate — a
  // SUI rate cannot be attached to an EIN, and the API refuses it either way.
  const accounts = (pack?.accounts ?? []).filter((account) =>
    slot?.programType ? account.programType === slot.programType : true)

  return (
    <Drawer
      open={draft !== null}
      onClose={onClose}
      title={slot?.label ?? label('rates.add', 'Add a rate')}
      description={draft ? `${draft.country} · ${draft.taxYear}` : undefined}
      footer={draft ? (
        <div className="flex items-center justify-between gap-2">
          {draft.existingId ? (
            <Button variant="ghost" disabled={busy} onClick={() => onRemove(draft.existingId!)}>
              {label('rates.remove', 'Remove')}
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>{label('cancel', 'Cancel')}</Button>
            <Button disabled={busy} onClick={onSave}>{label('save', 'Save')}</Button>
          </div>
        </div>
      ) : undefined}
    >
      {draft && data ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {data.packs.length > 1 ? (
              <div>
                <Label htmlFor="rate-country">{label('rates.columns.country', 'Country pack')}</Label>
                <Select
                  id="rate-country"
                  value={draft.country}
                  disabled={draft.existingId !== null}
                  onChange={(e) => {
                    const next = data.packs.find((entry) => entry.country === e.target.value)
                    onChange({
                      ...draft,
                      country: e.target.value,
                      rateKey: next?.slots[0]?.key ?? '',
                      region: '', subRegion: '', filingAccountId: '', values: {},
                    })
                  }}
                >
                  {data.packs.map((entry) => (
                    <option key={entry.country} value={entry.country}>{entry.country}</option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div>
              <Label htmlFor="rate-slot" help={slot?.variesBecause}>
                {label('rates.columns.levy', 'Rate')}
              </Label>
              <Select
                id="rate-slot"
                value={draft.rateKey}
                disabled={draft.existingId !== null}
                onChange={(e) => onChange({
                  ...draft, rateKey: e.target.value,
                  region: '', subRegion: '', filingAccountId: '', values: {},
                })}
              >
                {(pack?.slots ?? []).map((entry) => (
                  <option key={entry.key} value={entry.key}>{entry.label}</option>
                ))}
              </Select>
            </div>
            {slot && slot.scope !== 'org' ? (
              <div>
                <Label
                  htmlFor="rate-region"
                  help={label('rates.regionHelp', 'The region the rate applies in. A rate entered for one region is never applied to another.')}
                >
                  {pack?.regionLabel ?? label('rates.columns.region', 'Region')}
                </Label>
                <Select
                  id="rate-region"
                  value={draft.region}
                  disabled={draft.existingId !== null}
                  onChange={(e) => onChange({
                    ...draft, region: e.target.value, subRegion: '', filingAccountId: '',
                  })}
                >
                  <option value="">—</option>
                  {regions.map((region) => (
                    <option key={region} value={region}>{region}</option>
                  ))}
                </Select>
              </div>
            ) : null}
            {slot?.scope === 'sub_region' ? (
              <div>
                <Label
                  htmlFor="rate-sub-region"
                  help={label(
                    'rates.subRegionHelp',
                    'The taxing jurisdiction inside the region — a Pennsylvania PSD code, an Ohio municipality, a Michigan city. Each one sets its own rate, so each one is entered separately; a jurisdiction with no rate on file refuses the pay run by name rather than withholding nothing.',
                  )}
                >
                  {label('rates.columns.subRegion', 'Taxing jurisdiction')}
                </Label>
                <Input
                  id="rate-sub-region"
                  value={draft.subRegion}
                  disabled={draft.existingId !== null}
                  onChange={(e) => onChange({ ...draft, subRegion: e.target.value })}
                />
              </div>
            ) : null}
            {slot?.scope === 'filing_account' ? (
              <div>
                <Label
                  htmlFor="rate-account"
                  help={label('rates.accountHelp', 'This rate is assigned to a registered account, so an employer with two accounts in one region has two rates. Leave as All accounts to use one value for every account in the region.')}
                >
                  {label('rates.columns.account', 'Filing account')}
                </Label>
                <Select
                  id="rate-account"
                  value={draft.filingAccountId}
                  disabled={draft.existingId !== null}
                  onChange={(e) => onChange({ ...draft, filingAccountId: e.target.value })}
                >
                  <option value="">{label('rates.allAccounts', 'All accounts')}</option>
                  {accounts
                    .filter((account) => !draft.region || !account.stateCode || account.stateCode === draft.region)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.accountNumber} · {account.name}
                      </option>
                    ))}
                </Select>
              </div>
            ) : null}
            <div>
              <Label htmlFor="rate-year">{label('rates.year', 'Tax year')}</Label>
              <Input
                id="rate-year"
                inputMode="numeric"
                value={String(draft.taxYear)}
                disabled={draft.existingId !== null}
                onChange={(e) => onChange({ ...draft, taxYear: Number(e.target.value) || draft.taxYear })}
              />
            </div>
          </div>

          {(slot?.fields ?? []).map((field) => (
            <div key={field.key}>
              <Label htmlFor={`rate-field-${field.key}`} help={field.help}>
                {field.label}
              </Label>
              <Input
                id={`rate-field-${field.key}`}
                inputMode="decimal"
                value={draft.values[field.key] ?? ''}
                onChange={(e) => onChange({
                  ...draft,
                  values: { ...draft.values, [field.key]: e.target.value },
                })}
              />
            </div>
          ))}

          {slot ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">{slot.citation}</p>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  )
}
