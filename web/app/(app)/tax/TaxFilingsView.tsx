'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronDown, Download, ExternalLink, FileCheck2, Play } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Popover,
  Select,
} from '@openbooks/ui'

type Form = {
  code: string
  name: string
  country: string | null
  submission_channel: string
  government_format: string
  submission_url: string | null
  has_official: boolean
}
type Box = { lineCode: string; label: string; value: string; computed: boolean; editable: boolean }
type Result = {
  formCode: string
  formName: string
  from: string
  to: string
  submissionChannel: string
  watermark: string | null
  boxes: Box[]
}

function localIso(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function monthBounds(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return { from: localIso(from), to: localIso(to) }
}

function safeGovernmentUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export function TaxFilingsView({
  forms,
  canSave,
  canManageSetup,
}: {
  forms: Form[]
  canSave: boolean
  canManageSetup: boolean
}) {
  const t = useTranslations('tax')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const router = useRouter()
  const bounds = monthBounds()
  const [code, setCode] = useState(forms[0]?.code ?? '')
  const [from, setFrom] = useState(bounds.from)
  const [to, setTo] = useState(bounds.to)
  const [result, setResult] = useState<Result | null>(null)
  const [adjustments, setAdjustments] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const selectedForm = forms.find((form) => form.code === code)
  const governmentUrl = safeGovernmentUrl(selectedForm?.submission_url)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    void fetch(`/api/tax/filings?from=${bounds.from.slice(0, 4)}-01-01&to=${bounds.to}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { obligations?: { returnFormCode: string | null; reportableFrom: string; reportableTo: string }[] } | null) => {
        if (cancelled || !data?.obligations?.length) return
        const match = data.obligations.find((o) => o.returnFormCode === code)
          ?? data.obligations[data.obligations.length - 1]
        if (match) {
          setFrom(match.reportableFrom)
          setTo(match.reportableTo)
        }
      })
    return () => { cancelled = true }
  }, [code, bounds.from, bounds.to])

  const fmt = (value: string) =>
    Number(value).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const adjustmentQuery = (values: Record<string, string>) =>
    Object.entries(values)
      .filter(([, value]) => value.trim() !== '' && value.trim() !== '0')
      .map(([key, value]) => `&adj_${encodeURIComponent(key)}=${encodeURIComponent(value.trim())}`)
      .join('')

  async function compute(values: Record<string, string> = adjustments) {
    if (!code) return
    setBusy(true)
    try {
      const response = await fetch(`/api/tax/returns/${encodeURIComponent(code)}?from=${from}&to=${to}${adjustmentQuery(values)}`)
      if (!response.ok) throw new Error()
      setResult((await response.json()) as Result)
    } catch {
      toast.error(tCommon('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function saveSnapshot() {
    if (!result) return
    setSaving(true)
    try {
      const response = await fetch('/api/tax/filings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, from, to, adjustments }),
      })
      if (!response.ok) throw new Error()
      toast.success(t('history.saved'))
      router.refresh()
    } catch {
      toast.error(tCommon('feedback.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const exportHref = (format: string) =>
    `/api/tax/returns/${encodeURIComponent(code)}/export?from=${from}&to=${to}&format=${format}${adjustmentQuery(adjustments)}`

  return (
    <div className="space-y-6">
      {forms.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('noForms.title')}</CardTitle>
            <CardDescription>{t('noForms.description')}</CardDescription>
          </CardHeader>
          {canManageSetup ? (
            <CardContent>
              <Button asChild>
                <Link href="/admin/setup/tax-return-forms">{t('noForms.openSetup')}</Link>
              </Button>
            </CardContent>
          ) : null}
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 pt-6">
              <div className="min-w-52 flex-1 space-y-1.5">
                <Label htmlFor="tax-form">{t('form')}</Label>
                <Select
                  id="tax-form"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value)
                    setAdjustments({})
                    setResult(null)
                  }}
                >
                  {forms.map((form) => (
                    <option key={form.code} value={form.code}>{form.name}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tax-from">{t('from')}</Label>
                <Input id="tax-from" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setResult(null) }} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tax-to">{t('to')}</Label>
                <Input id="tax-to" type="date" value={to} onChange={(event) => { setTo(event.target.value); setResult(null) }} />
              </div>
              <Button onClick={() => compute()} disabled={busy}>
                <Play size={15} />
                {busy ? t('computing') : t('compute')}
              </Button>
            </CardContent>
            {selectedForm ? (
              <CardContent className="border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <FileCheck2 className="mt-0.5 text-teal-600 dark:text-teal-400" size={18} />
                      <div>
                        <p className="font-semibold text-slate-900 dark:text-slate-100">{t('submission.title')}</p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('submission.description')}</p>
                      </div>
                    </div>
                    {governmentUrl ? (
                      <Button variant="outline" size="sm" asChild>
                        <a href={governmentUrl} target="_blank" rel="noreferrer">
                          {t('submission.openGovernment')} <ExternalLink size={13} />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md bg-white px-3 py-2.5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                      <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('submission.channelLabel')}</dt>
                      <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`channels.${selectedForm.submission_channel}`)}</dd>
                    </div>
                    <div className="rounded-md bg-white px-3 py-2.5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                      <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('submission.actionLabel')}</dt>
                      <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`governmentFormats.${selectedForm.government_format}`)}</dd>
                    </div>
                  </dl>
                </div>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('submission.exportNotice')}</p>
                {code === 'CA_GST34' ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('submission.gst34Notice')}</p>
                ) : null}
              </CardContent>
            ) : null}
          </Card>

          {result ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>{result.formName}</CardTitle>
                    <CardDescription>{t('period', { from: result.from, to: result.to })}</CardDescription>
                  </div>
                  <Popover
                    open={exportOpen}
                    onOpenChange={setExportOpen}
                    align="end"
                    className="w-56 p-1"
                    trigger={
                      <Button size="sm" onClick={() => setExportOpen((o) => !o)}>
                        <Download size={14} />
                        {t('export.menu')}
                        <ChevronDown size={14} className="opacity-70" />
                      </Button>
                    }
                  >
                    <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('export.groupForm')}</div>
                    <ExportItem href={exportHref('facsimile')} onNavigate={() => setExportOpen(false)}>{t('export.facsimile')}</ExportItem>
                    {selectedForm?.has_official ? (
                      <ExportItem href={exportHref('official')} onNavigate={() => setExportOpen(false)}>{t('official.download')}</ExportItem>
                    ) : null}
                    <div className="mt-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{t('export.groupData')}</div>
                    <ExportItem href={exportHref('pdf')} onNavigate={() => setExportOpen(false)}>{t('export.pdf')}</ExportItem>
                    <ExportItem href={exportHref('xlsx')} onNavigate={() => setExportOpen(false)}>{t('export.xlsx')}</ExportItem>
                    <ExportItem href={exportHref('csv')} onNavigate={() => setExportOpen(false)}>{t('export.csv')}</ExportItem>
                    <ExportItem href={exportHref('json')} onNavigate={() => setExportOpen(false)}>{t('export.json')}</ExportItem>
                    {canSave ? (
                      <>
                        <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                        <button
                          type="button"
                          onClick={() => { setExportOpen(false); void saveSnapshot() }}
                          disabled={saving}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <FileCheck2 size={14} className="text-slate-400" />
                          {saving ? t('history.saving') : t('history.save')}
                        </button>
                      </>
                    ) : null}
                  </Popover>
                </div>
              </CardHeader>
              <CardContent>
                {result.watermark ? (
                  <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{result.watermark}</p>
                ) : null}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500 dark:border-slate-800">
                      <th className="py-2 pr-4 font-medium">{t('columns.line')}</th>
                      <th className="py-2 pr-4 font-medium">{t('columns.description')}</th>
                      <th className="py-2 text-right font-medium">{t('columns.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.boxes.map((box) => (
                      <tr key={box.lineCode} className={`border-b border-slate-100 dark:border-slate-900 ${box.computed ? 'font-semibold text-slate-900 dark:text-slate-100' : ''}`}>
                        <td className="py-2 pr-4 tabular-nums text-slate-500">{box.lineCode}</td>
                        <td className="py-2 pr-4">{box.label}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {box.editable ? (
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              aria-label={t('adjustmentAria', { label: box.label })}
                              className="w-32 rounded-md border border-slate-200 bg-white px-2 py-1 text-right tabular-nums focus:border-teal-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900"
                              value={adjustments[box.lineCode] ?? ''}
                              placeholder={t('adjustmentPlaceholder')}
                              onChange={(event) => setAdjustments((current) => ({ ...current, [box.lineCode]: event.target.value }))}
                              onBlur={() => compute()}
                            />
                          ) : fmt(box.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>
          )}
        </>
      )}
    </div>
  )
}

/** A download row inside the Export dropdown: a plain browser navigation to the
 *  export URL, closing the menu on click. */
function ExportItem({ href, onNavigate, children }: { href: string; onNavigate: () => void; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={onNavigate}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <Download size={14} className="text-slate-400" />
      {children}
    </a>
  )
}
