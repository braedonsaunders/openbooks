'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileUp, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
import { money } from '../../../../lib/format'

interface PreviewLine {
  postedOn: string
  amount: string
  description: string | null
  counterpartyRef?: string | null
}

interface Mapping {
  date: string
  amount: string
  debitAmount: string
  description: string
  counterpartyRef: string
  bankTransactionId: string
}

const EMPTY_MAPPING: Mapping = {
  date: '',
  amount: '',
  debitAmount: '',
  description: '',
  counterpartyRef: '',
  bankTransactionId: '',
}

/** Guess a CSV column index whose header matches one of the patterns. */
function guessColumn(header: string[], patterns: RegExp[]): string {
  for (const p of patterns) {
    const i = header.findIndex((h) => p.test(h.trim()))
    if (i >= 0) return String(i)
  }
  return ''
}

function toEngineMapping(m: Mapping) {
  return {
    date: Number(m.date),
    amount: Number(m.amount),
    description: Number(m.description),
    ...(m.debitAmount !== '' ? { debitAmount: Number(m.debitAmount) } : {}),
    ...(m.counterpartyRef !== '' ? { counterpartyRef: Number(m.counterpartyRef) } : {}),
    ...(m.bankTransactionId !== '' ? { bankTransactionId: Number(m.bankTransactionId) } : {}),
  }
}

const PREVIEW_CAP = 100

/**
 * Import-statement flyout: paste OFX/CSV text or read a file client-side
 * (FileReader → text POST — no object storage in v1), map CSV columns,
 * preview the parsed + deduped lines, then import.
 */
export function ImportStatementButton({ accountId }: { accountId: string }) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<'ofx' | 'csv'>('ofx')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [header, setHeader] = useState<string[] | null>(null)
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING)
  const [preview, setPreview] = useState<{ lines: PreviewLine[]; imported: number; duplicates: number } | null>(null)
  const [statementDate, setStatementDate] = useState('')
  const [openingBalance, setOpeningBalance] = useState('')
  const [closingBalance, setClosingBalance] = useState('')

  function reset() {
    setText('')
    setFileName(null)
    setHeader(null)
    setMapping(EMPTY_MAPPING)
    setPreview(null)
    setStatementDate('')
    setOpeningBalance('')
    setClosingBalance('')
  }

  function onTextChanged(next: string) {
    setText(next)
    setHeader(null)
    setPreview(null)
  }

  function readFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      onTextChanged(String(reader.result ?? ''))
      setFileName(file.name)
      const lower = file.name.toLowerCase()
      if (lower.endsWith('.csv') || lower.endsWith('.txt')) setSource('csv')
      else if (lower.endsWith('.ofx') || lower.endsWith('.qfx')) setSource('ofx')
    }
    reader.onerror = () => toast.error(`Could not read ${file.name}`)
    reader.readAsText(file)
  }

  async function post(body: Record<string, unknown>) {
    const res = await fetch('/api/banking/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Request failed')
    return data
  }

  async function detectColumns() {
    setBusy(true)
    try {
      const data = (await post({ source: 'csv', text, mode: 'columns' })) as { header: string[] }
      setHeader(data.header)
      setMapping({
        date: guessColumn(data.header, [/^date$/i, /date/i]),
        amount: guessColumn(data.header, [/^amount$/i, /amount|value|credit/i]),
        debitAmount: guessColumn(data.header, [/^debit$/i, /withdraw/i]),
        description: guessColumn(data.header, [/^desc/i, /desc|memo|narrat|detail|payee/i]),
        counterpartyRef: guessColumn(data.header, [/ref|cheque|check ?no/i]),
        bankTransactionId: guessColumn(data.header, [/transaction ?id|fitid/i]),
      })
    } catch (e) {
      toast.error((e as Error).message)
    }
    setBusy(false)
  }

  const csvReady = source === 'ofx' || (mapping.date !== '' && mapping.amount !== '' && mapping.description !== '')

  async function runPreview() {
    setBusy(true)
    try {
      const data = await post({
        accountId,
        source,
        text,
        mode: 'preview',
        ...(source === 'csv' ? { mapping: toEngineMapping(mapping) } : {}),
      })
      setPreview({ lines: data.lines ?? [], imported: data.imported, duplicates: data.duplicates })
      if (data.statementDate && !statementDate) setStatementDate(data.statementDate)
      if (data.closingBalance && !closingBalance) setClosingBalance(data.closingBalance)
    } catch (e) {
      setPreview(null)
      toast.error((e as Error).message)
    }
    setBusy(false)
  }

  async function runImport() {
    setBusy(true)
    try {
      const data = await post({
        accountId,
        source,
        text,
        mode: 'import',
        statementDate: statementDate || null,
        openingBalance: openingBalance || null,
        closingBalance: closingBalance || null,
        ...(source === 'csv' ? { mapping: toEngineMapping(mapping) } : {}),
      })
      toast.success(
        `Imported ${data.imported} line${data.imported === 1 ? '' : 's'}` +
          (data.duplicates > 0 ? ` — ${data.duplicates} duplicate${data.duplicates === 1 ? '' : 's'} skipped` : ''),
      )
      setOpen(false)
      reset()
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    }
    setBusy(false)
  }

  const field = 'space-y-1.5'
  const mappingSelect = (key: keyof Mapping, label: string, required: boolean) =>
    header ? (
      <div className={field}>
        <Label>
          {label}
          {required ? <span className="text-red-500"> *</span> : null}
        </Label>
        <Select
          value={mapping[key]}
          onChange={(e) => {
            setMapping((m) => ({ ...m, [key]: e.target.value }))
            setPreview(null)
          }}
        >
          <option value="">{required ? 'Select column…' : '—'}</option>
          {header.map((h, i) => (
            <option key={i} value={String(i)}>
              {h.trim() || `Column ${i + 1}`}
            </option>
          ))}
        </Select>
      </div>
    ) : null

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FileUp size={15} /> Import statement
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Import bank statement"
        description="Paste OFX or CSV text, or pick a file — it is read in your browser and imported as parsed lines."
        footer={
          <div className="flex w-full items-center gap-3">
            {preview ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {preview.imported} new line{preview.imported === 1 ? '' : 's'}
                {preview.duplicates > 0 ? ` · ${preview.duplicates} duplicate${preview.duplicates === 1 ? '' : 's'} skipped` : ''}
              </span>
            ) : null}
            <span className="flex-1" />
            <Button variant="outline" disabled={busy || !text.trim() || !csvReady} onClick={runPreview}>
              Preview
            </Button>
            <Button disabled={busy || !preview || preview.imported === 0} onClick={runImport}>
              <Upload size={15} /> Import {preview && preview.imported > 0 ? `${preview.imported} lines` : ''}
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={field}>
              <Label>Format</Label>
              <Select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as 'ofx' | 'csv')
                  setHeader(null)
                  setPreview(null)
                }}
              >
                <option value="ofx">OFX / QFX</option>
                <option value="csv">CSV</option>
              </Select>
            </div>
            <div className={field}>
              <Label>File</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".ofx,.qfx,.csv,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) readFile(f)
                    e.target.value = ''
                  }}
                />
                <Button variant="outline" onClick={() => fileRef.current?.click()}>
                  Choose file…
                </Button>
                <span className="truncate text-sm text-slate-500 dark:text-slate-400">{fileName ?? 'or paste below'}</span>
              </div>
            </div>
          </div>

          <div className={field}>
            <Label>Statement text</Label>
            <Textarea
              value={text}
              onChange={(e) => onTextChanged(e.target.value)}
              rows={8}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={source === 'ofx' ? '<OFX>…<STMTTRN>…' : 'Date,Description,Amount\n2026-07-02,Payroll run,-18250.00'}
            />
          </div>

          {source === 'csv' ? (
            header ? (
              <div className="space-y-3">
                <Label>Column mapping</Label>
                <div className="grid gap-3 sm:grid-cols-3">
                  {mappingSelect('date', 'Date', true)}
                  {mappingSelect('amount', 'Amount', true)}
                  {mappingSelect('description', 'Description', true)}
                  {mappingSelect('debitAmount', 'Debit column (if split)', false)}
                  {mappingSelect('counterpartyRef', 'Reference', false)}
                  {mappingSelect('bankTransactionId', 'Bank transaction id', false)}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  With a debit column mapped, Amount is treated as the credit (money-in) column and debits import negated.
                  Ambiguous numeric dates are read as MM/DD/YYYY.
                </p>
              </div>
            ) : (
              <Button variant="outline" disabled={busy || !text.trim()} onClick={detectColumns}>
                Detect columns
              </Button>
            )
          ) : null}

          {preview ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className={field}>
                  <Label>Statement date</Label>
                  <Input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
                </div>
                <div className={field}>
                  <Label>Opening balance</Label>
                  <Input
                    inputMode="decimal"
                    value={openingBalance}
                    onChange={(e) => setOpeningBalance(e.target.value)}
                    placeholder="optional"
                    className="text-right tabular-nums"
                  />
                </div>
                <div className={field}>
                  <Label>Closing balance</Label>
                  <Input
                    inputMode="decimal"
                    value={closingBalance}
                    onChange={(e) => setClosingBalance(e.target.value)}
                    placeholder="optional"
                    className="text-right tabular-nums"
                  />
                </div>
              </div>

              {preview.imported === 0 ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
                  Every parsed line already exists on this account — nothing new to import.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2">Ref</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {preview.lines.slice(0, PREVIEW_CAP).map((l, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 whitespace-nowrap">{l.postedOn}</td>
                          <td className="max-w-[18rem] truncate px-3 py-1.5">{l.description ?? '—'}</td>
                          <td className="px-3 py-1.5 text-slate-500 dark:text-slate-400">{l.counterpartyRef ?? ''}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{money(l.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.lines.length > PREVIEW_CAP ? (
                    <div className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      …and {(preview.lines.length - PREVIEW_CAP).toLocaleString()} more lines
                      <Badge variant="secondary" className="ml-2">
                        {preview.lines.length.toLocaleString()} total
                      </Badge>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </Drawer>
    </>
  )
}
