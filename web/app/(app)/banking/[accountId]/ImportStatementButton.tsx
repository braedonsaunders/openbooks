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

interface StatementPreview {
  lines: PreviewLine[]
  imported: number
  duplicates: number
  sourceRevision: number
}

interface Mapping {
  date: string
  amount: string
  debitAmount: string
  description: string
  counterpartyRef: string
  bankTransactionId: string
}

type StatementTextSource = 'ofx' | 'csv' | 'camt053' | 'bai2' | 'mt940'

interface BrowserUploadEvidence {
  bytesBase64: string
  filename: string
  contentType: string | null
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

function statementSourceForFilename(filename: string): StatementTextSource | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.ofx') || lower.endsWith('.qfx')) return 'ofx'
  if (lower.endsWith('.xml')) return 'camt053'
  if (lower.endsWith('.bai') || lower.endsWith('.bai2')) return 'bai2'
  if (lower.endsWith('.sta') || lower.endsWith('.mt940')) return 'mt940'
  return null
}

const BROWSER_BASE64_CHUNK_BYTES = 0x8000

function browserBase64FromBytes(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += BROWSER_BASE64_CHUNK_BYTES) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BROWSER_BASE64_CHUNK_BYTES)))
  }
  return btoa(chunks.join(''))
}

/** Build exact upload evidence from one browser file read; only the engine decodes it. */
async function prepareBrowserStatementUpload(
  file: Pick<File, 'arrayBuffer' | 'name' | 'type'>,
  fallbackSource: StatementTextSource,
) {
  const source = statementSourceForFilename(file.name) ?? fallbackSource
  const bytes = new Uint8Array(await file.arrayBuffer())
  return {
    source,
    evidence: {
      bytesBase64: browserBase64FromBytes(bytes),
      filename: file.name,
      contentType: file.type.split(';')[0]?.trim() || null,
    } satisfies BrowserUploadEvidence,
  }
}

const PREVIEW_CAP = 100

/**
 * Import-statement flyout: paste OFX/CSV text or read a file client-side,
 * retaining browser uploads as base64 source bytes. The engine is the sole
 * decoding authority and returns review text before parsed preview/import.
 * Map CSV columns, preview parsed + deduped lines, then import.
 */
export function ImportStatementButton({ accountId }: { accountId: string }) {
  const { money } = useMoney()
  const t = useTranslations('banking.import')
  const tBanking = useTranslations('banking')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const fileReadVersion = useRef(0)
  const sourceRevision = useRef(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<StatementTextSource>('ofx')
  const [text, setText] = useState('')
  const [uploadEvidence, setUploadEvidence] = useState<BrowserUploadEvidence | null>(null)
  const [header, setHeader] = useState<string[] | null>(null)
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING)
  const [preview, setPreview] = useState<StatementPreview | null>(null)
  const [statementDate, setStatementDate] = useState('')
  const [openingBalance, setOpeningBalance] = useState('')
  const [closingBalance, setClosingBalance] = useState('')

  function reset() {
    fileReadVersion.current += 1
    sourceRevision.current += 1
    setText('')
    setUploadEvidence(null)
    setHeader(null)
    setMapping(EMPTY_MAPPING)
    setPreview(null)
    setStatementDate('')
    setOpeningBalance('')
    setClosingBalance('')
  }

  function onTextChanged(next: string) {
    fileReadVersion.current += 1
    sourceRevision.current += 1
    setText(next)
    setUploadEvidence(null)
    setHeader(null)
    setPreview(null)
  }

  async function readFile(file: File) {
    const readVersion = ++fileReadVersion.current
    const readSourceRevision = ++sourceRevision.current
    setText('')
    setUploadEvidence(null)
    setHeader(null)
    setPreview(null)

    try {
      const upload = await prepareBrowserStatementUpload(file, source)
      const decoded = await post({
        source: upload.source,
        sourceBytesBase64: upload.evidence.bytesBase64,
        mode: 'decode',
      }) as { text?: unknown }
      if (readVersion !== fileReadVersion.current || readSourceRevision !== sourceRevision.current) return
      if (typeof decoded.text !== 'string') throw new Error()

      setText(decoded.text)
      setUploadEvidence(upload.evidence)
      setSource(upload.source)
    } catch {
      if (readVersion !== fileReadVersion.current || readSourceRevision !== sourceRevision.current) return
      toast.error(tBanking('errors.fileReadFailed', { name: file.name }))
    }
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

  const sourcePayload = uploadEvidence
    ? {
        sourceBytesBase64: uploadEvidence.bytesBase64,
        filename: uploadEvidence.filename,
        contentType: uploadEvidence.contentType,
      }
    : { text }
  const hasSource = uploadEvidence !== null || text.trim() !== ''

  async function detectColumns() {
    const requestRevision = sourceRevision.current
    setBusy(true)
    try {
      const data = (await post({ source: 'csv', ...sourcePayload, mode: 'columns' })) as { header: string[] }
      if (requestRevision !== sourceRevision.current) return
      sourceRevision.current += 1
      setHeader(data.header)
      setPreview(null)
      setMapping({
        date: guessColumn(data.header, [/^date$/i, /date/i]),
        amount: guessColumn(data.header, [/^amount$/i, /amount|value|credit/i]),
        debitAmount: guessColumn(data.header, [/^debit$/i, /withdraw/i]),
        description: guessColumn(data.header, [/^desc/i, /desc|memo|narrat|detail|payee/i]),
        counterpartyRef: guessColumn(data.header, [/ref|cheque|check ?no/i]),
        bankTransactionId: guessColumn(data.header, [/transaction ?id|fitid/i]),
      })
    } catch (e) {
      if (requestRevision === sourceRevision.current) toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const csvReady = source !== 'csv' || (mapping.date !== '' && mapping.amount !== '' && mapping.description !== '')

  async function runPreview() {
    const requestRevision = sourceRevision.current
    setBusy(true)
    try {
      const data = await post({
        accountId,
        source,
        ...sourcePayload,
        mode: 'preview',
        ...(source === 'csv' ? { mapping: toEngineMapping(mapping) } : {}),
      })
      if (requestRevision !== sourceRevision.current) return
      setPreview({
        lines: data.lines ?? [],
        imported: data.imported,
        duplicates: data.duplicates,
        sourceRevision: requestRevision,
      })
      if (data.statementDate) setStatementDate((current) => current || data.statementDate)
      if (data.closingBalance) setClosingBalance((current) => current || data.closingBalance)
    } catch (e) {
      if (requestRevision === sourceRevision.current) {
        setPreview(null)
        toast.error((e as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!preview || preview.sourceRevision !== sourceRevision.current) {
      setPreview(null)
      return
    }
    setBusy(true)
    try {
      const data = await post({
        accountId,
        source,
        ...sourcePayload,
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
    } finally {
      setBusy(false)
    }
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
          disabled={busy}
          value={mapping[key]}
          onChange={(e) => {
            sourceRevision.current += 1
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
            <Button variant="outline" disabled={busy || !hasSource || !csvReady} onClick={runPreview}>
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
                disabled={busy}
                value={source}
                onChange={(e) => {
                  fileReadVersion.current += 1
                  sourceRevision.current += 1
                  setSource(e.target.value as StatementTextSource)
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
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void readFile(f)
                    e.target.value = ''
                  }}
                />
                <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {t('chooseFile')}
                </Button>
                <span className="truncate text-sm text-slate-500 dark:text-slate-400">
                  {uploadEvidence?.filename ?? t('orPasteBelow')}
                </span>
              </div>
            </div>
          </div>

          <div className={field}>
            <Label>{t('statementText')}</Label>
            <Textarea
              disabled={busy}
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
              <Button variant="outline" disabled={busy || !hasSource} onClick={detectColumns}>
                {t('detectColumns')}
              </Button>
            )
          ) : null}

          {preview ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className={field}>
                  <Label>{tBanking('labels.statementDate')}</Label>
                  <Input
                    disabled={busy}
                    type="date"
                    value={statementDate}
                    onChange={(e) => setStatementDate(e.target.value)}
                  />
                </div>
                <div className={field}>
                  <Label>{tBanking('labels.openingBalance')}</Label>
                  <Input
                    disabled={busy}
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
                    disabled={busy}
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
