'use client'

import { Table as SharedTable, TableHeader as SharedTableHeader, TableRow as SharedTableRow, TableHead as SharedTableHead, TableBody as SharedTableBody, TableCell as SharedTableCell } from "@openbooks/ui"
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, ArrowRight, CheckCircle2, Download, FileUp, Upload } from 'lucide-react'
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, PageHeader, Select, Textarea, cn } from '@openbooks/ui'
import { dataResourceLabel, dataFieldLabel } from '../../../../lib/data-io/labels'
import { WizardLayout } from '../../../../components/page-layout'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { guessMapping } from '../../../../lib/data-io/mapping'
import { templateHref } from '../../../../lib/data-io/template-links'
import { requestTransfer, transferCommand, uploadTransfer, useTransferJob } from '../../../../lib/data-io/transfer-client'
import { DataTransferStatus } from '../../../../components/data-transfer-status'
import { DataTransferPicker } from '../../../../components/data-transfer-picker'

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
type PreviewState = { outcome: Outcome; revision: number }

export function ImportWizard({ backHref = '/', backLabel }: { backHref?: string; backLabel?: string } = {}) {
  const t = useTranslations('data')
  const tCatalog = useTranslations()
  const router = useRouter()
  const { job, remember, connectionError, running } = useTransferJob('import')

  const [step, setStep] = useState<Step>('source')
  const [resources, setResources] = useState<ResourceDescriptor[]>([])
  const [resource, setResource] = useState('')
  const [format, setFormat] = useState<Format>('csv')
  const [fileName, setFileName] = useState('')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [totalRows, setTotalRows] = useState(0)
  const creationKey = useRef<string | null>(null)
  const restoredPhase = useRef<string | null>(null)

  const [headers, setHeaders] = useState<string[]>([])
  const [fields, setFields] = useState<Field[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [importMode, setImportMode] = useState<'insert' | 'upsert'>('upsert')
  const [post, setPost] = useState(false)

  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [inputRevision, setInputRevision] = useState(0)
  const [result, setResult] = useState<Outcome | null>(null)
  const [working, setBusy] = useState(false)
  const busy = working || running
  const [error, setError] = useState<string | null>(null)
  const inputRevisionRef = useRef(0)

  const invalidateInputs = () => {
    const revision = ++inputRevisionRef.current
    setInputRevision(revision)
    setPreview(null)
    setError(null)
    creationKey.current = null
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

  const resourceLabel = (item: ResourceDescriptor) => dataResourceLabel(item, tCatalog)

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

  const fieldLabel = (field: Field) => dataFieldLabel(field, selectedResource, tCatalog)

  /* eslint-disable react-hooks/set-state-in-effect -- Durable server phase changes restore editable form state once per phase. */
  useEffect(() => {
    if (!job) { restoredPhase.current = null; return }
    const phase = `${job.id}:${job.state}`
    if (restoredPhase.current === phase) return
    restoredPhase.current = phase
    // Synchronize the form with durable server phase changes; progress polls
    // must not replace mapping edits made by the operator.
    setResource(job.resource); setFormat(job.format); setFileName(job.filename)
    setHeaders(job.headers); setTotalRows(job.totalRows)
    setFields(job.fields.filter((field) => !field.readOnly))
    if (job.state === 'mapping') {
      setMapping(guessMapping(job.headers, job.fields.filter((field) => !field.readOnly).map((field) => field.key)))
      setStep('mapping')
    } else if (job.state === 'ready') {
      setMapping(job.options.mapping ?? {}); setImportMode(job.options.importMode ?? 'upsert'); setPost(job.options.post ?? false)
      setPreview({ outcome: job.preview, revision: inputRevisionRef.current }); setStep('preview')
    } else if (job.state === 'completed') {
      setResult(job.outcome); setStep('result')
      // Committed rows change the lists, counters and workspace badges the
      // operator returns to: drop the router's cached views so the next
      // visit renders the imported records instead of the pre-import state.
      router.refresh()
    }
  }, [job, router])
  /* eslint-enable react-hooks/set-state-in-effect */

  const onFile = (file: File) => {
    invalidateInputs(); setFile(file); setFileName(file.name); setText('')
    setFormat(file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv')
  }
  const doParse = async () => {
    if (!resource) return
    setBusy(true); setError(null)
    try {
      const source = file ?? new Blob([text], { type: format === 'json' ? 'application/json' : 'text/csv' })
      if (!creationKey.current) creationKey.current = crypto.randomUUID()
      const pending = job?.state === 'uploading' && job.resource === resource && job.format === format && job.filename === (fileName || `import.${format}`) && job.bytes === source.size
        ? job : await requestTransfer('/api/data/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestKey: creationKey.current, kind: 'import', resource, format, filename: fileName || `import.${format}`, bytes: source.size }) })
      remember(pending)
      if (pending.state === 'uploading') remember(await uploadTransfer(source, pending, remember))
      else if (pending.state === 'mapping') setStep('mapping')
      else if (pending.state === 'ready') setStep('preview')
    } catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  const doPreview = async () => {
    if (!job) return
    setBusy(true); setError(null)
    try { remember(await transferCommand(job, 'preview', { options: { mapping, importMode, post } })) }
    catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  const doCommit = async () => {
    if (!job || !preview || preview.revision !== inputRevisionRef.current) return
    setBusy(true); setError(null)
    try { remember(await transferCommand(job, 'commit', { approvalHash: job.approvalHash })) }
    catch (error) { setError((error as Error).message) } finally { setBusy(false) }
  }
  const reset = () => {
    remember(null); setStep('source'); setError(null); setFile(null); setText(''); setFileName('')
    setHeaders([]); setTotalRows(0); setFields([]); setMapping({}); setPreview(null); setResult(null)
    invalidateInputs()
  }

  const stepIndex = { source: 1, mapping: 2, preview: 3, result: 4 }[step]

  const header = (
    <PageHeader
      title={t('import.title')}
      description={t('import.description')}
      back={{ href: backHref, label: backLabel ?? tCatalog('nav.modules.dashboard') }}
    />
  )

  // Why Import is unavailable, named rather than left as a dead button.
  const commitRows = preview ? preview.outcome.created + preview.outcome.updated + (job?.preview.deleted ?? 0) : 0
  const commitBlocked = step !== 'preview' || !preview || busy
    ? null
    : preview.revision !== inputRevision
      ? t('import.commitBlocked.stale')
      : preview.outcome.failed > 0
        ? t('import.commitBlocked.errors', { n: preview.outcome.failed })
        : commitRows === 0
          ? t('import.commitBlocked.nothing')
          : job?.state !== 'ready'
            ? t('import.commitBlocked.notReady')
            : null

  const footer = (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <span className="text-xs text-muted-foreground">{t('import.step', { n: stepIndex, total: 4 })}</span>
        {commitBlocked ? <p role="status" className="mt-1 text-sm text-amber-700 dark:text-amber-400">{commitBlocked}</p> : null}
      </div>
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
          <Button onClick={doParse} disabled={!resource || busy || (!text && !file)}>
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
          <Button onClick={doCommit} disabled={busy || commitBlocked !== null}>
            <Upload className="mr-2 h-4 w-4" />
            {busy ? t('import.committing') : t('import.commit', { n: commitRows })}
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
      <DataTransferPicker kind="import" job={job} onChange={remember} disabled={working} />
      {job && !busy && step !== 'result' && <Button variant="outline" size="sm" onClick={reset}>{t('import.importAnother')}</Button>}
      {error && <Alert variant="destructive">{error}</Alert>}
      {job && <DataTransferStatus job={job} onChange={remember} connectionError={connectionError} />}
      {!job && connectionError && <Alert variant="warning">{connectionError}</Alert>}
      {step !== 'source' && (
        <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{selectedResource && resourceLabel(selectedResource)}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{fileName || t('import.pastedData')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{format.toUpperCase()}</Badge>
            <Badge variant="secondary">{t('import.rowCount', { n: totalRows })}</Badge>
          </div>
        </Card>
      )}
      {step === 'source' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('import.sourceTitle')}</CardTitle>
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
              {resource ? (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{t('templates.hint')}</span>
                  <a className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline dark:text-teal-300" href={templateHref(resource, 'xlsx')} download>
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />{t('templates.downloadXlsx')}
                  </a>
                  <a className="font-medium text-teal-700 hover:underline dark:text-teal-300" href={templateHref(resource, 'csv')} download>{t('templates.downloadCsv')}</a>
                </p>
              ) : null}
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
                    setFile(null)
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
            <CardTitle className="text-sm">{t('import.steps.mapping')}</CardTitle>
            <CardDescription>{t('import.mapHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
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
            <CardTitle className="text-sm">{t('import.preview')}</CardTitle>
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
              <Button variant="outline" asChild>
                <a href={`/api/data/transfers/${job?.id}/issues?phase=commit`}>{t('import.downloadErrors')}</a>
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
