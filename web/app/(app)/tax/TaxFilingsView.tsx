'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, FileText, Play, Upload } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@openbooks/ui'

type Form = { code: string; name: string; submission_channel: string; has_official: boolean }
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

function monthBounds(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1)
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { from: iso(from), to: iso(to) }
}

const fmt = (v: string) =>
  Number(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function TaxFilingsView({ forms, canManage }: { forms: Form[]; canManage: boolean }) {
  const t = useTranslations('tax')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const bounds = monthBounds()
  const [code, setCode] = useState(forms[0]?.code ?? '')
  const [from, setFrom] = useState(bounds.from)
  const [to, setTo] = useState(bounds.to)
  const [result, setResult] = useState<Result | null>(null)
  const [adjustments, setAdjustments] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [uploading, setUploading] = useState(false)
  const selectedForm = forms.find((f) => f.code === code)

  async function uploadOfficial(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.set('file', file)
      const res = await fetch(`/api/tax/returns/${encodeURIComponent(code)}/official-pdf`, { method: 'POST', body: fd })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(d.error)
      }
      toast.success(t('official.uploaded'))
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed'))
    } finally {
      setUploading(false)
    }
  }

  async function removeOfficial() {
    setUploading(true)
    try {
      await fetch(`/api/tax/returns/${encodeURIComponent(code)}/official-pdf`, { method: 'DELETE' })
      toast.success(t('official.removed'))
      router.refresh()
    } finally {
      setUploading(false)
    }
  }

  const adjQuery = (adj: Record<string, string>) =>
    Object.entries(adj)
      .filter(([, v]) => v.trim() !== '' && v.trim() !== '0')
      .map(([k, v]) => `&adj_${encodeURIComponent(k)}=${encodeURIComponent(v.trim())}`)
      .join('')

  async function install() {
    setInstalling(true)
    try {
      const res = await fetch('/api/tax/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack: 'CA_GST34' }),
      })
      if (!res.ok) throw new Error()
      const data = (await res.json()) as { boxRows: number; mappedSalesCodes: number; mappedPurchaseCodes: number }
      toast.success(t('installed', { boxes: data.boxRows, sales: data.mappedSalesCodes, purchases: data.mappedPurchaseCodes }))
      router.refresh()
      if (result) await compute()
    } catch {
      toast.error(tCommon('feedback.saveFailed'))
    } finally {
      setInstalling(false)
    }
  }

  async function compute(adj: Record<string, string> = adjustments) {
    if (!code) return
    setBusy(true)
    try {
      const res = await fetch(`/api/tax/returns/${encodeURIComponent(code)}?from=${from}&to=${to}${adjQuery(adj)}`)
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(err.error)
      }
      setResult((await res.json()) as Result)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : tCommon('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const exportHref = (format: string) =>
    `/api/tax/returns/${encodeURIComponent(code)}/export?from=${from}&to=${to}&format=${format}${adjQuery(adjustments)}`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>

      {forms.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('noForms.title')}</CardTitle>
            <CardDescription>{t('noForms.description')}</CardDescription>
          </CardHeader>
          {canManage ? (
            <CardContent>
              <Button onClick={install} disabled={installing}>
                <FileText size={15} />
                {installing ? t('noForms.installing') : t('noForms.install')}
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
                <Select id="tax-form" value={code} onChange={(e) => setCode(e.target.value)}>
                  {forms.map((f) => (
                    <option key={f.code} value={f.code}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tax-from">{t('from')}</Label>
                <Input id="tax-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tax-to">{t('to')}</Label>
                <Input id="tax-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <Button onClick={() => compute()} disabled={busy}>
                <Play size={15} />
                {busy ? t('computing') : t('compute')}
              </Button>
              {canManage ? (
                <Button variant="outline" onClick={install} disabled={installing}>
                  <FileText size={15} />
                  {installing ? t('noForms.installing') : t('reinstall')}
                </Button>
              ) : null}
            </CardContent>
            {canManage ? (
              <CardContent className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
                <span className="text-sm text-slate-600 dark:text-slate-300">
                  {t('official.label')}: {selectedForm?.has_official ? t('official.present') : t('official.none')}
                </span>
                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) uploadOfficial(f)
                      e.target.value = ''
                    }}
                  />
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                    <Upload size={14} />
                    {uploading ? t('official.uploading') : t('official.upload')}
                  </span>
                </label>
                {selectedForm?.has_official ? (
                  <Button variant="ghost" size="sm" onClick={removeOfficial} disabled={uploading}>
                    {t('official.remove')}
                  </Button>
                ) : null}
                <span className="text-xs text-slate-400 dark:text-slate-500">{t('official.hint')}</span>
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
                  <div className="flex flex-wrap gap-2">
                    <a href={exportHref('pdf')}>
                      <Button variant="outline" size="sm">
                        <Download size={14} />
                        {t('export.pdf')}
                      </Button>
                    </a>
                    <a href={exportHref('xlsx')}>
                      <Button variant="outline" size="sm">
                        <Download size={14} />
                        {t('export.xlsx')}
                      </Button>
                    </a>
                    <a href={exportHref('csv')}>
                      <Button variant="outline" size="sm">
                        <Download size={14} />
                        {t('export.csv')}
                      </Button>
                    </a>
                    {selectedForm?.has_official ? (
                      <a href={exportHref('official')}>
                        <Button size="sm">
                          <Download size={14} />
                          {t('official.download')}
                        </Button>
                      </a>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {result.watermark ? (
                  <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    {result.watermark}
                  </p>
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
                    {result.boxes.map((b) => (
                      <tr
                        key={b.lineCode}
                        className={`border-b border-slate-100 dark:border-slate-900 ${b.computed ? 'font-semibold text-slate-900 dark:text-slate-100' : ''}`}
                      >
                        <td className="py-2 pr-4 tabular-nums text-slate-500">{b.lineCode}</td>
                        <td className="py-2 pr-4">{b.label}</td>
                        <td className="py-1.5 text-right tabular-nums">
                          {b.editable ? (
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              aria-label={b.label}
                              className="w-32 rounded-md border border-slate-200 bg-white px-2 py-1 text-right tabular-nums focus:border-teal-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900"
                              value={adjustments[b.lineCode] ?? ''}
                              placeholder="0.00"
                              onChange={(e) =>
                                setAdjustments((a) => ({ ...a, [b.lineCode]: e.target.value }))
                              }
                              onBlur={() => compute()}
                            />
                          ) : (
                            fmt(b.value)
                          )}
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
