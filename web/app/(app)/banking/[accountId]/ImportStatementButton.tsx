'use client'

import { useMoney } from '@/components/money-provider'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { FileUp, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
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
  const { money } = useMoney()
  const t = useTranslations('banking.import')
  const tBanking = useTranslations('banking')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<'ofx' | 'csv' | 'camt053' | 'bai2' | 'mt940'>('ofx')
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
      if (lower.endsWith('.csv')) setSource('csv')
      else if (lower.endsWith('.ofx') || lower.endsWith('.qfx')) setSource('ofx')
      else if (lower.endsWith('.xml')) setSource('camt053')
      else if (lower.endsWith('.bai') || lower.endsWith('.bai2')) setSource('bai2')
      else if (lower.endsWith('.sta') || lower.endsWith('.mt940')) setSource('mt940')
    }
    reader.onerror = () => toast.error(tBanking('errors.fileReadFailed', { name: file.name }))
    reader.readAsText(file)
  }

  async function post(body: Record<string, unknown>) {
    const res = await fetch('/api/banking/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? tBanking('errors.requestFailed'))
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

  const csvReady = source !== 'csv' || (mapping.date !== '' && mapping.amount !== '' && mapping.description !== '')

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
      toast.success(t('importedToast', { imported: data.imported, duplicates: data.duplicates }))
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
          <option value="">{required ? t('selectColumn') : '—'}</option>
          {header.map((h, i) => (
            <option key={i} value={String(i)}>
              {h.trim() || t('columnN', { n: i + 1 })}
            </option>
          ))}
        </Select>
      </div>
    ) : null

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FileUp size={15} /> {t('button')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={t('title')}
        description={t('description')}
        headerActions={
          <>
            <Button variant="outline" disabled={busy || !text.trim() || !csvReady} onClick={runPreview}>
              {t('preview')}
            </Button>
            <Button disabled={busy || !preview || preview.imported === 0} onClick={runImport}>
              <Upload size={15} />{' '}
              {preview && preview.imported > 0 ? t('importCount', { count: preview.imported }) : t('importAction')}
            </Button>
          </>
        }
        footer={
          <div className="flex w-full items-center gap-3">
            {preview ? (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {t('previewSummary', { imported: preview.imported, duplicates: preview.duplicates })}
              </span>
            ) : null}
            <span className="flex-1" />
          </div>
        }
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={field}>
              <Label>{t('format')}</Label>
              <Select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as 'ofx' | 'csv' | 'camt053' | 'bai2' | 'mt940')
                  setHeader(null)
                  setPreview(null)
                }}
              >
                <option value="ofx">{t('formatOfx')}</option>
                <option value="csv">{t('formatCsv')}</option>
                <option value="camt053">{t('formatCamt053')}</option>
                <option value="bai2">{t('formatBai2')}</option>
                <option value="mt940">{t('formatMt940')}</option>
              </Select>
            </div>
            <div className={field}>
              <Label>{t('file')}</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".ofx,.qfx,.csv,.xml,.bai,.bai2,.sta,.mt940,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) readFile(f)
                    e.target.value = ''
                  }}
                />
                <Button variant="outline" onClick={() => fileRef.current?.click()}>
                  {t('chooseFile')}
                </Button>
                <span className="truncate text-sm text-slate-500 dark:text-slate-400">{fileName ?? t('orPasteBelow')}</span>
              </div>
            </div>
          </div>

          <div className={field}>
            <Label>{t('statementText')}</Label>
            <Textarea
              value={text}
              onChange={(e) => onTextChanged(e.target.value)}
              rows={8}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={source === 'csv' ? t('pastePlaceholderCsv') : t('pastePlaceholderOfx')}
            />
          </div>

          {source === 'csv' ? (
            header ? (
              <div className="space-y-3">
                <Label>{t('columnMapping')}</Label>
                <div className="grid gap-3 sm:grid-cols-3">
                  {mappingSelect('date', tCommon('labels.date'), true)}
                  {mappingSelect('amount', tCommon('labels.amount'), true)}
                  {mappingSelect('description', tCommon('labels.description'), true)}
                  {mappingSelect('debitAmount', t('debitColumn'), false)}
                  {mappingSelect('counterpartyRef', tCommon('labels.reference'), false)}
                  {mappingSelect('bankTransactionId', t('bankTransactionId'), false)}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('mappingHelp')}</p>
              </div>
            ) : (
              <Button variant="outline" disabled={busy || !text.trim()} onClick={detectColumns}>
                {t('detectColumns')}
              </Button>
            )
          ) : null}

          {preview ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className={field}>
                  <Label>{tBanking('labels.statementDate')}</Label>
                  <Input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
                </div>
                <div className={field}>
                  <Label>{tBanking('labels.openingBalance')}</Label>
                  <Input
                    inputMode="decimal"
                    value={openingBalance}
                    onChange={(e) => setOpeningBalance(e.target.value)}
                    placeholder={t('optionalPlaceholder')}
                    className="text-right tabular-nums"
                  />
                </div>
                <div className={field}>
                  <Label>{tBanking('labels.closingBalance')}</Label>
                  <Input
                    inputMode="decimal"
                    value={closingBalance}
                    onChange={(e) => setClosingBalance(e.target.value)}
                    placeholder={t('optionalPlaceholder')}
                    className="text-right tabular-nums"
                  />
                </div>
              </div>

              {preview.imported === 0 ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
                  {t('nothingNew')}
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                      <tr>
                        <th className="px-3 py-2">{tCommon('labels.date')}</th>
                        <th className="px-3 py-2">{tCommon('labels.description')}</th>
                        <th className="px-3 py-2">{tBanking('labels.ref')}</th>
                        <th className="px-3 py-2 text-right">{tCommon('labels.amount')}</th>
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
                      {t('moreLines', { count: preview.lines.length - PREVIEW_CAP })}
                      <Badge variant="secondary" className="ml-2">
                        {t('totalBadge', { count: preview.lines.length })}
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
