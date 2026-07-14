'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CalendarClock } from 'lucide-react'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type SelectOption,
} from '@openbooks/ui'

export type AccountOption = { id: string; label: string; type: string }

type ControlAccounts = {
  ar: string
  ap: string
  bank: string
  taxCollected: string
  taxPaid: string
  employeePayable: string
}

type Initial = {
  name: string
  legalName: string
  country: string
  baseCurrency: string
  fiscalYearStartMonth: number
  controlAccounts: ControlAccounts
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const CONTROL_FIELDS: { key: keyof ControlAccounts; label: string; hint: string }[] = [
  { key: 'ar', label: 'Accounts receivable', hint: 'Customer balances post here' },
  { key: 'ap', label: 'Accounts payable', hint: 'Vendor balances post here' },
  { key: 'bank', label: 'Default bank', hint: 'Default cash account for payments & receipts' },
  { key: 'taxCollected', label: 'Tax collected', hint: 'Sales tax owed on invoices' },
  { key: 'taxPaid', label: 'Tax paid', hint: 'Recoverable tax on bills' },
  { key: 'employeePayable', label: 'Employee payable', hint: 'Expense reimbursements owed to staff' },
]

/** Ordinal-ish label for a fiscal year that ends in month `m` (start month). */
function fiscalRangeLabel(startMonth: number): string {
  const start = MONTHS[startMonth - 1]
  const end = MONTHS[(startMonth + 10) % 12]
  return `${start} → ${end}`
}

export function SettingsForm({
  initial,
  accounts,
  currencies,
  numberSequences,
}: {
  initial: Initial
  accounts: AccountOption[]
  currencies: { code: string; name: string }[]
  numberSequences: {
    document_kind: string
    prefix: string
    next_number: number
    padding: number
    gapless: boolean
  }[]
}) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(initial)

  const accountOptions: SelectOption[] = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: a.label })),
    [accounts],
  )

  const startMonthChanged = form.fiscalYearStartMonth !== initial.fiscalYearStartMonth

  function setControl(key: keyof ControlAccounts, value: string) {
    setForm((f) => ({ ...f, controlAccounts: { ...f.controlAccounts, [key]: value } }))
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error('Display name is required')
      return
    }
    if (!form.country.trim()) {
      toast.error('Country is required')
      return
    }
    setSaving(true)
    const res = await fetch('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error ?? 'Save failed')
      return
    }
    const data = (await res.json()) as { changed?: boolean; periodsRederived?: boolean }
    if (data.changed === false) {
      toast('No changes to save')
      return
    }
    toast.success(
      data.periodsRederived
        ? 'Settings saved — accounting periods re-labelled to the new fiscal year'
        : 'Settings saved',
    )
    router.refresh()
  }

  return (
    <div className="space-y-6">
      {/* Organization identity */}
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>How this company is identified across the app.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Display name</Label>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Acme Manufacturing"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="legalName">Legal name</Label>
            <Input
              id="legalName"
              value={form.legalName}
              onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
              placeholder="Acme Manufacturing Inc."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="country">Country</Label>
            <Input
              id="country"
              value={form.country}
              onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
              placeholder="CA"
              maxLength={2}
              className="uppercase"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Two-letter ISO code (e.g. CA, US, GB).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="baseCurrency">Base currency</Label>
            <Select
              id="baseCurrency"
              value={form.baseCurrency}
              onChange={(e) => setForm((f) => ({ ...f, baseCurrency: e.target.value }))}
            >
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              The reporting currency the ledger balances in. Add more currencies before switching.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Fiscal year — the headline setting */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock size={17} className="text-teal-600 dark:text-teal-300" />
            Fiscal year
          </CardTitle>
          <CardDescription>
            The month your financial year begins. Everything fiscal-year-aware — reports, period
            close, presets — reads this.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fiscalStart">Fiscal year starts in</Label>
              <Select
                id="fiscalStart"
                value={String(form.fiscalYearStartMonth)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, fiscalYearStartMonth: Number(e.target.value) }))
                }
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={String(i + 1)}>
                    {m}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Fiscal year runs</Label>
              <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                {fiscalRangeLabel(form.fiscalYearStartMonth)}
              </div>
            </div>
          </div>
          {startMonthChanged ? (
            <Alert variant="warning">
              <AlertDescription>
                Changing the start month re-labels <strong>every accounting period</strong> — their
                fiscal year, period number and name are re-derived from each period&apos;s start
                date the moment you save. Journal entries and dates are untouched, but reports and
                period-close groupings will shift to the new calendar.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {/* Control accounts */}
      <Card>
        <CardHeader>
          <CardTitle>Control accounts</CardTitle>
          <CardDescription>
            The general-ledger accounts subledgers and tax post through. Only postable
            (non-summary) accounts appear.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {CONTROL_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`ctrl-${field.key}`}>{field.label}</Label>
              <SearchSelect
                id={`ctrl-${field.key}`}
                value={form.controlAccounts[field.key]}
                onChange={(v) => setControl(field.key, v)}
                options={accountOptions}
                placeholder="Select an account…"
                searchPlaceholder="Search accounts…"
                sheetTitle={field.label}
                clearable
                emptyLabel="Not set"
                ariaLabel={field.label}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">{field.hint}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Document numbering (display) */}
      <Card>
        <CardHeader>
          <CardTitle>Document numbering</CardTitle>
          <CardDescription>
            Sequences that generate document numbers. Prefix and padding shown for each kind.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {numberSequences.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No sequences configured yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead className="text-right">Next #</TableHead>
                  <TableHead className="text-right">Padding</TableHead>
                  <TableHead>Example</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {numberSequences.map((s) => (
                  <TableRow key={s.document_kind}>
                    <TableCell className="font-medium capitalize">
                      {s.document_kind.replace(/_/g, ' ')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.prefix || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.next_number}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.padding}</TableCell>
                    <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      {s.prefix}
                      {String(s.next_number).padStart(s.padding, '0')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" disabled={saving} onClick={() => setForm(initial)}>
          Reset
        </Button>
        <Button disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}
