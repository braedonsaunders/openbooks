'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, CheckCircle2, Database, Sparkles, Upload } from 'lucide-react'
import { Badge, Button, PageHeader, Select, cn } from '@openbooks/ui'
import { WizardLayout } from '../../../../components/page-layout'
import { enterOrg } from '../../../../lib/sandbox-session'

interface ResourceDescriptor {
  key: string
  label: string
  group: string
  canPost?: boolean
}
interface Field {
  key: string
  label: string
  kind: string
  required?: boolean
  section?: string
}
interface Outcome {
  created: number
  updated: number
  failed: number
  errors: { row: number; message: string; field?: string }[]
}
interface SampleCompanyProfile {
  industryKey: string
  profileId: string
  companyName: string
  focus: string[]
  templateReady: boolean
  existingOrgId: string | null
}

type Step = 'source' | 'mapping' | 'preview' | 'result'
const FORMATS = ['csv', 'xlsx', 'json'] as const
type Format = (typeof FORMATS)[number]

export function ImportWizard() {
  const t = useTranslations('data')
  const router = useRouter()

  const [step, setStep] = useState<Step>('source')
  const [resources, setResources] = useState<ResourceDescriptor[]>([])
  const [resource, setResource] = useState('')
  const [format, setFormat] = useState<Format>('csv')
  const [fileName, setFileName] = useState('')
  const [text, setText] = useState('')
  const [base64, setBase64] = useState('')

  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [importMode, setImportMode] = useState<'insert' | 'upsert'>('upsert')
  const [post, setPost] = useState(false)

  const [preview, setPreview] = useState<Outcome | null>(null)
  const [result, setResult] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [sampleProfiles, setSampleProfiles] = useState<SampleCompanyProfile[]>([])
  const [sampleIndustry, setSampleIndustry] = useState('')
  const [sampleBusy, setSampleBusy] = useState(false)

  useEffect(() => {
    fetch('/api/data/resources')
      .then((r) => r.json())
      .then((d) => setResources((d.resources ?? []).filter((x: ResourceDescriptor & { supportsImport?: boolean }) => x)))
      .catch(() => setResources([]))
    fetch('/api/data/sample-companies')
      .then((r) => r.json())
      .then((d) => {
        const profiles = (d.profiles ?? []) as SampleCompanyProfile[]
        setSampleProfiles(profiles)
        setSampleIndustry((current) => current || profiles[0]?.industryKey || '')
      })
      .catch(() => setSampleProfiles([]))
  }, [])

  const selectedSample = useMemo(
    () => sampleProfiles.find((profile) => profile.industryKey === sampleIndustry) ?? null,
    [sampleIndustry, sampleProfiles],
  )

  const createOrOpenSample = async () => {
    if (!selectedSample) return
    setSampleBusy(true)
    let orgId = selectedSample.existingOrgId
    try {
      if (!orgId) {
        const response = await fetch('/api/data/sample-companies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ industry: selectedSample.industryKey }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || typeof data.orgId !== 'string') {
          throw new Error(data.error ?? t('import.sample.error'))
        }
        orgId = data.orgId
        toast.success(data.created ? t('import.sample.created') : t('import.sample.ready'))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('import.sample.error'))
      setSampleBusy(false)
      return
    }
    if (!orgId) {
      toast.error(t('import.sample.error'))
      setSampleBusy(false)
      return
    }
    await enterOrg(orgId)
  }

  const grouped = useMemo(() => {
    const map = new Map<string, ResourceDescriptor[]>()
    for (const r of resources) {
      const list = map.get(r.group) ?? []
      list.push(r)
      map.set(r.group, list)
    }
    return [...map.entries()]
  }, [resources])

  const selectedCanPost = useMemo(
    () => resources.find((r) => r.key === resource)?.canPost ?? false,
    [resources, resource],
  )

  const onFile = useCallback((file: File) => {
    setFileName(file.name)
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.xlsx')) {
      setFormat('xlsx')
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result)
        setBase64(dataUrl.slice(dataUrl.indexOf(',') + 1))
        setText('')
      }
      reader.readAsDataURL(file)
    } else {
      setFormat(lower.endsWith('.json') ? 'json' : 'csv')
      const reader = new FileReader()
      reader.onload = () => {
        setText(String(reader.result))
        setBase64('')
      }
      reader.readAsText(file)
    }
  }, [])

  const doParse = async () => {
    if (!resource) return
    setBusy(true)
    try {
      const res = await fetch('/api/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'parse', resource, format, text, base64 }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'parse failed')
      if (!d.headers?.length) throw new Error('No columns found in the file')
      setHeaders(d.headers)
      setRows(d.rows ?? [])
      setFields(d.fields ?? [])
      setMapping(d.mapping ?? {})
      setStep('mapping')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doPreview = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview', resource, format, rows, mapping, importMode, post }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'preview failed')
      setPreview(d.outcome)
      setStep('preview')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const doCommit = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'commit', resource, format, rows, mapping, importMode, fileName, post }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? 'import failed')
      setResult(d.outcome)
      setStep('result')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setStep('source')
    setResource('')
    setFileName('')
    setText('')
    setBase64('')
    setHeaders([])
    setRows([])
    setFields([])
    setMapping({})
    setPreview(null)
    setResult(null)
  }

  const downloadErrors = (outcome: Outcome) => {
    const lines = [['row', 'field', 'message'], ...outcome.errors.map((e) => [String(e.row), e.field ?? '', e.message])]
    const csv = lines.map((l) => l.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `import-errors.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const stepIndex = { source: 1, mapping: 2, preview: 3, result: 4 }[step]

  const header = (
    <PageHeader
      title={t('import.title')}
      description={t('import.description')}
      back={{ href: '/data/import/history', label: t('nav.history') }}
    />
  )

  const footer = (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{t('import.step', { n: stepIndex, total: 4 })}</span>
      <div className="flex gap-2">
        {step === 'mapping' && (
          <Button variant="outline" onClick={() => setStep('source')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('import.back')}
          </Button>
        )}
        {step === 'preview' && (
          <Button variant="outline" onClick={() => setStep('mapping')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('import.back')}
          </Button>
        )}
        {step === 'source' && (
          <Button onClick={doParse} disabled={!resource || busy || (!text && !base64)}>
            {t('import.next')}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
        {step === 'mapping' && (
          <Button onClick={doPreview} disabled={busy}>
            {busy ? t('import.previewing') : t('import.preview')}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        )}
        {step === 'preview' && preview && (
          <Button onClick={doCommit} disabled={busy || preview.created + preview.updated === 0}>
            <Upload className="mr-2 h-4 w-4" />
            {busy ? t('import.committing') : t('import.commit', { n: preview.created + preview.updated })}
          </Button>
        )}
        {step === 'result' && (
          <>
            <Button variant="outline" onClick={reset}>
              {t('import.importAnother')}
            </Button>
            <Button onClick={() => router.push('/data/import/history')}>{t('nav.history')}</Button>
          </>
        )}
      </div>
    </div>
  )

  return (
    <WizardLayout header={header} footer={footer}>
      {step === 'source' && (
        <div className="space-y-5">
          <section className="overflow-hidden rounded-xl border border-teal-200 bg-gradient-to-br from-teal-50 via-white to-cyan-50 dark:border-teal-900 dark:from-teal-950/40 dark:via-slate-950 dark:to-cyan-950/30">
            <div className="flex items-start gap-3 border-b border-teal-100 p-4 dark:border-teal-900/70">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-600 text-white shadow-sm">
                <Sparkles className="h-5 w-5" />
              </span>
              <div>
                <h2 className="font-semibold text-foreground">{t('import.sample.title')}</h2>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t('import.sample.description')}</p>
              </div>
            </div>
            <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('import.sample.industry')}</label>
                <Select value={sampleIndustry} onChange={(event) => setSampleIndustry(event.target.value)}>
                  {sampleProfiles.map((profile) => (
                    <option key={profile.industryKey} value={profile.industryKey}>{profile.companyName}</option>
                  ))}
                </Select>
                {selectedSample && (
                  <p className="text-xs text-muted-foreground">
                    {selectedSample.focus.join(' · ')}
                    {!selectedSample.templateReady && !selectedSample.existingOrgId ? ` · ${t('import.sample.firstGeneration')}` : ''}
                  </p>
                )}
              </div>
              <Button
                type="button"
                onClick={createOrOpenSample}
                disabled={!selectedSample || sampleBusy}
                className="sm:min-w-44"
              >
                <Database className="mr-2 h-4 w-4" />
                {sampleBusy
                  ? t('import.sample.preparing')
                  : selectedSample?.existingOrgId
                    ? t('import.sample.open')
                    : t('import.sample.create')}
              </Button>
            </div>
            <p className="px-4 pb-4 text-xs leading-relaxed text-muted-foreground">{t('import.sample.safety')}</p>
          </section>
          <div className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t('import.sample.orFile')}
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">{t('import.resource')}</label>
            <Select value={resource} onChange={(e) => setResource(e.target.value)}>
              <option value="">{t('import.resourcePlaceholder')}</option>
              {grouped.map(([group, list]) => (
                <optgroup key={group} label={group}>
                  {list.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">{t('import.file')}</label>
            <input
              type="file"
              accept=".csv,.xlsx,.json,text/csv,application/json"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            />
            {fileName && (
              <p className="text-xs text-muted-foreground">
                {fileName} · {format.toUpperCase()}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">{t('import.orPaste')}</label>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setBase64('')
                if (format === 'xlsx') setFormat('csv')
              }}
              rows={5}
              placeholder="code,name&#10;HST-BC,HST British Columbia"
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
            />
          </div>
        </div>
      )}

      {step === 'mapping' && (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">{t('import.mapHint')}</p>
          {!selectedCanPost && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">{t('import.mode')}</label>
              <Select value={importMode} onChange={(e) => setImportMode(e.target.value as 'insert' | 'upsert')}>
                <option value="upsert">{t('import.modeUpsert')}</option>
                <option value="insert">{t('import.modeInsert')}</option>
              </Select>
            </div>
          )}
          {selectedCanPost && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">{t('import.postMode')}</label>
              <Select value={post ? 'post' : 'draft'} onChange={(e) => setPost(e.target.value === 'post')}>
                <option value="draft">{t('import.postDraft')}</option>
                <option value="post">{t('import.postPost')}</option>
              </Select>
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('import.sourceColumn')}</th>
                  <th className="px-3 py-2">{t('import.targetField')}</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((h) => (
                  <tr key={h} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{h}</td>
                    <td className="px-3 py-2">
                      <Select
                        value={mapping[h] ?? ''}
                        onChange={(e) => setMapping((prev) => ({ ...prev, [h]: e.target.value }))}
                        triggerClassName="h-8"
                      >
                        <option value="">{t('import.ignore')}</option>
                        {fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                            {f.required ? ' *' : ''}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-3">
            <StatTile label={t('import.toInsert')} value={preview.created} tone="green" />
            <StatTile label={t('import.toUpdate')} value={preview.updated} tone="blue" />
            <StatTile label={t('import.toFail')} value={preview.failed} tone="red" />
          </div>
          {preview.errors.length > 0 && <ErrorTable t={t} errors={preview.errors} />}
        </div>
      )}

      {step === 'result' && result && (
        <div className="space-y-5">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            {t('import.done')}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <StatTile label={t('import.created', { n: result.created })} value={result.created} tone="green" />
            <StatTile label={t('import.updated', { n: result.updated })} value={result.updated} tone="blue" />
            <StatTile label={t('import.failed', { n: result.failed })} value={result.failed} tone="red" />
          </div>
          {result.errors.length > 0 && (
            <>
              <Button variant="outline" onClick={() => downloadErrors(result)}>
                {t('import.downloadErrors')}
              </Button>
              <ErrorTable t={t} errors={result.errors} />
            </>
          )}
        </div>
      )}
    </WizardLayout>
  )
}

function StatTile({ label, value, tone }: { label: string; value: number; tone: 'green' | 'blue' | 'red' }) {
  const toneClass = {
    green: 'text-emerald-600 dark:text-emerald-400',
    blue: 'text-sky-600 dark:text-sky-400',
    red: 'text-rose-600 dark:text-rose-400',
  }[tone]
  return (
    <div className="rounded-lg border border-border p-4">
      <div className={cn('text-2xl font-semibold tabular-nums', toneClass)}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function ErrorTable({
  t,
  errors,
}: {
  t: ReturnType<typeof useTranslations>
  errors: { row: number; message: string; field?: string }[]
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-rose-200 dark:border-rose-900">
      <table className="w-full text-sm">
        <thead className="bg-rose-50 text-left text-xs uppercase text-rose-700 dark:bg-rose-950 dark:text-rose-300">
          <tr>
            <th className="w-16 px-3 py-2">{t('import.row')}</th>
            <th className="px-3 py-2">{t('import.message')}</th>
          </tr>
        </thead>
        <tbody>
          {errors.slice(0, 200).map((e, i) => (
            <tr key={i} className="border-t border-rose-100 dark:border-rose-900/50">
              <td className="px-3 py-2 tabular-nums">{e.row}</td>
              <td className="px-3 py-2">
                {e.field && (
                  <Badge variant="outline" className="mr-2">
                    {e.field}
                  </Badge>
                )}
                {e.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
