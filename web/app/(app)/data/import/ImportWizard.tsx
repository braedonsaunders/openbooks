'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, CheckCircle2, FileUp, Upload } from 'lucide-react'
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, PageHeader, Select, Textarea, cn } from '@openbooks/ui'
import { WizardLayout } from '../../../../components/page-layout'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { exportCsv } from '../../analytics/_ui/exportCsv'
import {
  forgetImportCommitIdentity,
  ImportIdentityPersistenceError,
  resolveImportCommitIdentity,
  type ImportCommitIdentity,
} from './commit-identity'

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
  warnings?: { row: number; message: string; field?: string }[]
}
type Step = 'source' | 'mapping' | 'preview' | 'result'
type Format = 'csv' | 'xlsx' | 'json'
type PreviewRequest = { resource: string; format: Format; rows: Record<string, unknown>[]; mapping: Record<string, string>; importMode: 'insert' | 'upsert'; post: boolean }
type PreviewState = { outcome: Outcome; revision: number; request: PreviewRequest }

export function ImportWizard() {
  const t = useTranslations('data')
  const tCatalog = useTranslations()
  const router = useRouter()
  const today = useBusinessToday()

  const [step, setStep] = useState<Step>('source')
  const [resources, setResources] = useState<ResourceDescriptor[]>([])
  const [resource, setResource] = useState('')
  const [format, setFormat] = useState<Format>('csv')
  const [fileName, setFileName] = useState('')
  const [text, setText] = useState('')
  const [base64, setBase64] = useState('')

  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [truncatedMax, setTruncatedMax] = useState<number | null>(null)
  const [fields, setFields] = useState<Field[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [importMode, setImportMode] = useState<'insert' | 'upsert'>('upsert')
  const [post, setPost] = useState(false)

  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [inputRevision, setInputRevision] = useState(0)
  const [result, setResult] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const commitIdentity = useRef<ImportCommitIdentity | null>(null)
  const inputRevisionRef = useRef(0)

  const invalidateInputs = () => {
    const revision = ++inputRevisionRef.current
    setInputRevision(revision)
    setPreview(null)
    setError(null)
  }

  useEffect(() => {
    fetch('/api/data/resources')
      .then(async (r) => {
        if (!r.ok) throw new Error(await readApiErrorMessage(r, t('import.loadFailed')))
        return r.json()
      })
      // Read-only resources are export-only: the import route refuses them
      // as 'resource is read-only', so the picker must not offer them. The
      // truthy check matches the server's own `!supportsImport` refusal.
      .then((d) => setResources((d.resources ?? []).filter((x: ResourceDescriptor & { supportsImport?: boolean }) => x?.supportsImport)))
      .catch((e) => {
        setError((e as Error).message)
        toast.error((e as Error).message)
      })
  }, [t])

  // Built-in names reuse the same catalogs as Setup, navigation, and records.
  // Custom resources keep the name supplied by their own definition.
  const resourceLabel = (item: ResourceDescriptor): string => {
    const key = item.group === 'Setup' ? `admin.setup.entities.${item.key}.title`
      : item.group === 'Master data' ? (item.key === 'parties' ? 'data.resources.parties' : `nav.modules.${item.key}`)
      : item.group === 'Transactions' ? (item.key === 'txn:pay_run' ? 'nav.modules.payroll-runs' : `common.transactionTypes.${item.key.replace(/^txn:/, '').replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`)
      : ''
    return key && tCatalog.has(key) ? tCatalog(key) : item.label
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

  const selectedResource = resources.find((item) => item.key === resource)

  const selectedCanPost = useMemo(
    () => resources.find((r) => r.key === resource)?.canPost ?? false,
    [resources, resource],
  )

  const fieldLabel = (field: Field): string => {
    if (field.label !== field.key) return field.label
    const namespace = selectedResource?.group === 'Setup' || resource === 'accounts' ? 'admin.setup.fields'
      : resource === 'parties' ? 'parties.drawer'
      : resource === 'items' ? 'items.labels' : ''
    const key = namespace && `${namespace}.${field.key}`
    return key && tCatalog.has(key) ? tCatalog(key) : field.label
  }

  const onFile = (file: File) => {
    invalidateInputs()
    const revision = inputRevisionRef.current
    setFileName(file.name)
    setText('')
    setBase64('')
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.xlsx')) {
      setFormat('xlsx')
      const reader = new FileReader()
      reader.onload = () => {
        if (inputRevisionRef.current !== revision) return
        const dataUrl = String(reader.result)
        setBase64(dataUrl.slice(dataUrl.indexOf(',') + 1))
      }
      reader.readAsDataURL(file)
    } else {
      setFormat(lower.endsWith('.json') ? 'json' : 'csv')
      const reader = new FileReader()
      reader.onload = () => {
        if (inputRevisionRef.current !== revision) return
        setText(String(reader.result))
      }
      reader.readAsText(file)
    }
  }

  const doParse = async () => {
    if (!resource) return
    const revision = inputRevisionRef.current
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'parse', resource, format, text, base64 }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('import.parseFailed')))
      const d = await res.json()
      if (inputRevisionRef.current !== revision) return
      if (!d.headers?.length) throw new Error(t('import.noColumns'))
      setHeaders(d.headers)
      setRows(d.rows ?? [])
      setTruncatedMax(d.truncated ? (typeof d.maxRows === 'number' ? d.maxRows : 20000) : null)
      setFields(d.fields ?? [])
      setMapping(d.mapping ?? {})
      setStep('mapping')
    } catch (e) {
      if (inputRevisionRef.current === revision) {
        setError((e as Error).message)
        toast.error((e as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  const doPreview = async () => {
    const revision = inputRevisionRef.current
    const request: PreviewRequest = { resource, format, rows, mapping, importMode, post }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview', ...request }),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t('import.previewFailed')))
      const d = await res.json()
      if (inputRevisionRef.current !== revision) return
      setPreview({ outcome: d.outcome, revision, request })
      setStep('preview')
    } catch (e) {
      if (inputRevisionRef.current === revision) {
        setError((e as Error).message)
        toast.error((e as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  const doCommit = async () => {
    if (!preview || preview.revision !== inputRevisionRef.current) return
    const request = preview.request
    setBusy(true)
    setError(null)
    try {
      // The key follows the exact request inputs. A lost response reuses it,
      // including after reload; editing the import creates a distinct request.
      let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null
      try {
        storage = window.sessionStorage
      } catch {
        throw new ImportIdentityPersistenceError()
      }
      const identity = await resolveImportCommitIdentity(
        { ...request, fileName },
        commitIdentity.current,
        storage,
        () => crypto.randomUUID(),
      )
      commitIdentity.current = identity
      const res = await fetch('/api/data/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'commit', ...request, fileName, idempotencyKey: identity.key }),
      })
      if (!res.ok) {
        if (res.status === 409) throw new Error(t('import.commitConflict'))
        throw new Error(await readApiErrorMessage(res, t('import.commitFailed')))
      }
      const d = await res.json()
      setResult(d.outcome)
      setStep('result')
      forgetImportCommitIdentity(identity, storage)
      commitIdentity.current = null
    } catch (e) {
      const message = e instanceof ImportIdentityPersistenceError ? t('import.commitPersistenceFailed') : (e as Error).message
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    commitIdentity.current = null
    setStep('source')
    setError(null)
    setFormat('csv')
    setResource('')
    setFileName('')
    setText('')
    setBase64('')
    setHeaders([])
    setRows([])
    setTruncatedMax(null)
    setFields([])
    setMapping({})
    setPreview(null)
    inputRevisionRef.current += 1
    setInputRevision(inputRevisionRef.current)
    setResult(null)
  }

  const downloadErrors = (outcome: Outcome) => {
    exportCsv(
      'import-errors',
      ['row', 'field', 'message'],
      outcome.errors.map((e) => [e.row, e.field ?? '', e.message]),
      today,
    )
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
          <Button variant="outline" disabled={busy} onClick={() => { setError(null); setStep('source') }}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('import.back')}
          </Button>
        )}
        {step === 'preview' && (
          <Button variant="outline" disabled={busy} onClick={() => { setError(null); setStep('mapping') }}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('import.back')}
          </Button>
        )}
        {step === 'source' && (
          <Button onClick={doParse} disabled={!resource || busy || (!text && !base64)}>
            {busy ? t('import.parsing') : t('import.next')}
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
          <Button onClick={doCommit} disabled={busy || preview.revision !== inputRevision || preview.outcome.created + preview.outcome.updated === 0}>
            <Upload className="mr-2 h-4 w-4" />
            {busy ? t('import.committing') : t('import.commit', { n: preview.outcome.created + preview.outcome.updated })}
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
    <WizardLayout
      header={header}
      footer={footer}
      steps={(['source', 'mapping', 'preview', 'result'] as const).map((key) => ({ key, label: t(`import.steps.${key}`) }))}
      currentStep={step}
      progressLabel={t('import.step', { n: stepIndex, total: 4 })}
    >
      {error && <Alert variant="destructive">{error}</Alert>}
      {step !== 'source' && (
        <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{selectedResource && resourceLabel(selectedResource)}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{fileName || t('import.pastedData')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{format.toUpperCase()}</Badge>
            <Badge variant="secondary">{t('import.rowCount', { n: rows.length })}</Badge>
          </div>
        </Card>
      )}
      {step === 'source' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('import.sourceTitle')}</CardTitle>
            <CardDescription>{t('import.sourceHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="import-resource">{t('import.resource')}</Label>
              <Select id="import-resource" disabled={busy} value={resource} onChange={(e) => { invalidateInputs(); setResource(e.target.value) }}>
                <option value="">{t('import.resourcePlaceholder')}</option>
                {grouped.map(([group, list]) => (
                  <optgroup key={group} label={group}>
                    {list.map((r) => <option key={r.key} value={r.key}>{resourceLabel(r)}</option>)}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div className="space-y-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-950/50">
              <div className="flex items-start gap-3">
                <FileUp aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-teal-600 dark:text-teal-400" />
                <div className="space-y-1">
                  <Label htmlFor="import-file">{t('import.chooseFile')}</Label>
                  <p id="import-file-hint" className="text-xs text-muted-foreground">{t('import.fileHint')}</p>
                </div>
              </div>
              <input
                id="import-file"
                type="file"
                disabled={busy}
                aria-describedby="import-file-hint"
                accept=".csv,.xlsx,.json,text/csv,application/json"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
                className="block w-full min-w-0 text-sm text-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground focus-visible:outline-teal-500"
              />
            </div>
            <details className="group border-t border-border pt-4">
              <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline-teal-500">{t('import.orPaste')}</summary>
              <div className="mt-4 space-y-3">
                <div className="max-w-xs space-y-2">
                  <Label htmlFor="import-paste-format">{t('import.format')}</Label>
                  <Select id="import-paste-format" disabled={busy || format === 'xlsx'} value={format} onChange={(e) => { invalidateInputs(); setFormat(e.target.value as Format) }}>
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                    {format === 'xlsx' && <option value="xlsx">Excel</option>}
                  </Select>
                </div>
                <Label htmlFor="import-paste" className="sr-only">{t('import.orPaste')}</Label>
                <Textarea
                  id="import-paste"
                  disabled={busy}
                  aria-describedby="import-paste-hint"
                  value={text}
                  onChange={(e) => {
                    invalidateInputs()
                    setText(e.target.value)
                    setFileName('')
                    setBase64('')
                    if (format === 'xlsx') setFormat('csv')
                  }}
                  rows={5}
                  className="font-mono"
                />
                <p id="import-paste-hint" className="text-xs text-muted-foreground">{t('import.pasteHint')}</p>
              </div>
            </details>
          </CardContent>
        </Card>
      )}

      {step === 'mapping' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('import.steps.mapping')}</CardTitle>
            <CardDescription>{t('import.mapHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {truncatedMax !== null && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                {t('import.truncatedWarning', { n: truncatedMax })}
              </div>
            )}
            {!selectedCanPost && (
              <div className="space-y-2">
                <Label htmlFor="import-mode">{t('import.mode')}</Label>
                <Select id="import-mode" disabled={busy} value={importMode} onChange={(e) => { invalidateInputs(); setImportMode(e.target.value as 'insert' | 'upsert') }}>
                  <option value="upsert">{t('import.modeUpsert')}</option>
                  <option value="insert">{t('import.modeInsert')}</option>
                </Select>
              </div>
            )}
            {selectedCanPost && (
              <div className="space-y-2">
                <Label htmlFor="import-post-mode">{t('import.postMode')}</Label>
                <Select id="import-post-mode" disabled={busy} value={post ? 'post' : 'draft'} onChange={(e) => { invalidateInputs(); setPost(e.target.value === 'post') }}>
                  <option value="draft">{t('import.postDraft')}</option>
                  <option value="post">{t('import.postPost')}</option>
                </Select>
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-border">
              <SharedTable className="w-full text-sm">
                <SharedTableHeader className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <SharedTableRow>
                    <SharedTableHead className="px-3 py-2">{t('import.sourceColumn')}</SharedTableHead>
                    <SharedTableHead className="px-3 py-2">{t('import.targetField')}</SharedTableHead>
                  </SharedTableRow>
                </SharedTableHeader>
                <SharedTableBody>
                  {headers.map((h) => (
                    <SharedTableRow key={h} className="border-t border-border">
                      <SharedTableCell className="px-3 py-2 font-mono text-xs">{h}</SharedTableCell>
                      <SharedTableCell className="px-3 py-2">
                        <Select
                          aria-label={`${h} — ${t('import.targetField')}`}
                          disabled={busy}
                          value={mapping[h] ?? ''}
                          onChange={(e) => { invalidateInputs(); setMapping((prev) => ({ ...prev, [h]: e.target.value })) }}
                          triggerClassName="h-8"
                        >
                          <option value="">{t('import.ignore')}</option>
                          {fields.map((f) => (
                            <option key={f.key} value={f.key}>
                              {fieldLabel(f)}
                              {f.required ? ' *' : ''}
                            </option>
                          ))}
                        </Select>
                      </SharedTableCell>
                    </SharedTableRow>
                  ))}
                </SharedTableBody>
              </SharedTable>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'preview' && preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('import.preview')}</CardTitle>
            <CardDescription>{t('import.reviewHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-3 gap-3">
              <StatTile label={t('import.toInsert')} value={preview.outcome.created} tone="green" />
              <StatTile label={t('import.toUpdate')} value={preview.outcome.updated} tone="blue" />
              <StatTile label={t('import.toFail')} value={preview.outcome.failed} tone="red" />
            </div>
            {preview.outcome.errors.length > 0 && <ErrorTable t={t} errors={preview.outcome.errors} />}
            {(preview.outcome.warnings?.length ?? 0) > 0 && (
              <ErrorTable t={t} errors={preview.outcome.warnings ?? []} tone="amber" title={t('import.warnings')} />
            )}
          </CardContent>
        </Card>
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
          {(result.warnings?.length ?? 0) > 0 && (
            <ErrorTable t={t} errors={result.warnings ?? []} tone="amber" title={t('import.warnings')} />
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
  tone = 'rose',
  title,
}: {
  t: ReturnType<typeof useTranslations>
  errors: { row: number; message: string; field?: string }[]
  tone?: 'rose' | 'amber'
  title?: string
}) {
  const frame =
    tone === 'amber'
      ? 'border-amber-200 dark:border-amber-900'
      : 'border-rose-200 dark:border-rose-900'
  const head =
    tone === 'amber'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
      : 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
  const rowLine =
    tone === 'amber' ? 'border-amber-100 dark:border-amber-900/50' : 'border-rose-100 dark:border-rose-900/50'
  return (
    <div className={`overflow-hidden rounded-lg border ${frame}`}>
      {title && <div className={`px-3 py-2 text-xs font-semibold uppercase ${head}`}>{title}</div>}
      <SharedTable className="w-full text-sm">
        <SharedTableHeader className={`text-left text-xs uppercase ${head}`}>
          <SharedTableRow>
            <SharedTableHead className="w-16 px-3 py-2">{t('import.row')}</SharedTableHead>
            <SharedTableHead className="px-3 py-2">{t('import.message')}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody>
          {errors.map((e, i) => (
            <SharedTableRow key={i} className={`border-t ${rowLine}`}>
              <SharedTableCell className="px-3 py-2 tabular-nums">{e.row}</SharedTableCell>
              <SharedTableCell className="px-3 py-2">
                {e.field && (
                  <Badge variant="outline" className="mr-2">
                    {e.field}
                  </Badge>
                )}
                {e.message}
              </SharedTableCell>
            </SharedTableRow>
          ))}
        </SharedTableBody>
      </SharedTable>
    </div>
  )
}
