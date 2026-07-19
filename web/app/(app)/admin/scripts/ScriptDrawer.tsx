'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Play, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { Badge, Button, Input, Label, Select, UrlDrawer, cn } from '@openbooks/ui'
import { dateTime } from '../../../../lib/format'
import { BUILT_IN_SCRIPT_KINDS, customRecordKind } from '../../../../lib/script-kinds'

// Enum values with their message keys under admin.scripts, translated at render.
const TRIGGERS: { value: string; labelKey: string }[] = [
  { value: 'before_submit', labelKey: 'triggers.beforeSubmit' },
  { value: 'before_post', labelKey: 'triggers.beforePost' },
  { value: 'after_post', labelKey: 'triggers.afterPost' },
  { value: 'before_void', labelKey: 'triggers.beforeVoid' },
  { value: 'scheduled', labelKey: 'triggers.scheduled' },
  { value: 'endpoint', labelKey: 'triggers.endpoint' },
  { value: 'bulk', labelKey: 'triggers.bulk' },
  { value: 'client', labelKey: 'triggers.client' },
]

const RUN_STATUSES = new Set(['ok', 'aborted', 'error', 'timeout'])
const TABS = ['general', 'code', 'runs', 'log'] as const
type Tab = (typeof TABS)[number]

const TEMPLATE = `// ctx = { trigger, document?, lines?, org, user? } — deep-frozen.
// ob.log(...) records to the run log; ob.abort('reason') vetoes.
// ob.query("SELECT ...") runs read-only SQL -> rows array.
// ob.journal.create({ lines: [...] }) — governed ledger write (draft here).
// ob.record.load(table, id) -> one row; ob.search(table, {col: val}) -> rows[]
// Return { set: { field: value } } to change whitelisted header fields.
function main(ctx) {
  const total = Number(ctx.document.total)
  ob.log('checking', ctx.document.documentNumber, 'total', total)
  if (total > 10000 && !ctx.document.memo) {
    ob.abort('documents over $10,000 need a memo')
  }
}
`

const SCHEDULED_TEMPLATE = `// Scheduled script — runs on a cron schedule, no document context.
// ctx = { trigger: 'scheduled', org } — deep-frozen.
// ob.query("SELECT ...") runs read-only SQL -> rows array.
// ob.journal.create({ lines: [...] }, { post: true }) — governed ledger write.
function main(ctx) {
  function sqlVal(v) {
    return "'" + String(v).replace(/'/g, "''") + "'"
  }
  var bills = ob.query("SELECT document_number, total FROM documents WHERE org_id = " + sqlVal(ctx.org.id) + " AND kind = 'vendor_bill' AND status = 'approved' AND total > 50000")
  bills.forEach(function(b) {
    ob.log('large unpaid bill:', b.document_number, b.total)
  })
}
`

const ENDPOINT_TEMPLATE = `// Endpoint script — HTTP-invokable: POST /api/scripts/e/<slug>
// Not tied to any record. ctx = { trigger: 'endpoint', request: { method, query, body }, org, user }
// The return value becomes the response body. Callers need scripts.execute.
function main(ctx) {
  ob.log('called by', ctx.user.name, 'method', ctx.request.method)
  return { echo: ctx.request.body, at: ctx.org.name }
}
`

const BULK_TEMPLATE = `// Bulk script — long-budget background job (30s deadline), run on the worker
// via the scripts queue ("Run now" enqueues it; inline fallback without Redis).
// ctx = { trigger: 'bulk', org }
function main(ctx) {
  function sqlVal(v) { return "'" + String(v).replace(/'/g, "''") + "'" }
  var rows = ob.query("SELECT id, document_number, total FROM documents WHERE org_id = " + sqlVal(ctx.org.id) + " AND kind = 'vendor_bill' LIMIT 5000")
  var total = 0
  rows.forEach(function(r) { total += Number(r.total) })
  ob.log('processed', rows.length, 'bills; total', total.toFixed(2))
  return { processed: rows.length, total: total }
}
`

const CLIENT_TEMPLATE = `// Client script — runs in the user's browser inside a sandboxed iframe
// (never in the host page) when a form is saved. Works for transactions AND
// custom records (pick the record type above; blank = every form).
// ctx = { kind, doc } — the about-to-save payload.
// Return { abort: 'reason' } to block the save, or { warnings: ['...'] }.
function main(ctx) {
  var doc = ctx.doc || {}
  if (!doc.memo && Number(doc.total || 0) > 10000) {
    return { abort: 'documents over $10,000 need a memo' }
  }
  return { warnings: [] }
}
`

const TEMPLATE_BY_TRIGGER: Record<string, string> = {
  scheduled: SCHEDULED_TEMPLATE,
  endpoint: ENDPOINT_TEMPLATE,
  bulk: BULK_TEMPLATE,
  client: CLIENT_TEMPLATE,
}
const ALL_TEMPLATES = new Set([TEMPLATE, SCHEDULED_TEMPLATE, ENDPOINT_TEMPLATE, BULK_TEMPLATE, CLIENT_TEMPLATE, ''])

export function NewScriptButton() {
  const t = useTranslations('admin.scripts')
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/admin/scripts?script=new')}>
      <Plus size={15} /> {t('drawer.newScript')}
    </Button>
  )
}

export function ScriptDrawer({
  script,
  runs,
  customTypes,
}: {
  script: Record<string, any> | null
  runs: Record<string, any>[]
  /** Published custom record types (for kind narrowing): { key, name }. */
  customTypes: { key: string; name: string }[]
}) {
  const t = useTranslations('admin.scripts')
  const tCommon = useTranslations('common')
  const creating = !script
  const router = useRouter()
  const [tab, setTab] = useState<Tab>(creating ? 'general' : 'code')
  const [name, setName] = useState<string>(script?.name ?? '')
  const [triggerPoint, setTriggerPoint] = useState<string>(script?.trigger_point ?? 'before_post')
  const [documentKind, setDocumentKind] = useState<string>(script?.document_kind ?? '')
  const [endpointSlug, setEndpointSlug] = useState<string>(script?.endpoint_slug ?? '')
  const [source, setSource] = useState<string>(script?.source ?? TEMPLATE)
  const [cron, setCron] = useState<string>(script?.cron ?? '0 * * * *')
  const [timeoutMs, setTimeoutMs] = useState<string>(String(script?.timeout_ms ?? 2000))
  const [sortOrder, setSortOrder] = useState<string>(String(script?.sort_order ?? 100))
  const [isActive, setIsActive] = useState<boolean>(script?.is_active ?? true)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [selectedRun, setSelectedRun] = useState<number>(0)

  const isScheduled = triggerPoint === 'scheduled'
  const isEndpoint = triggerPoint === 'endpoint'
  const endpointUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/scripts/e/${endpointSlug.trim()}`
  const isBulk = triggerPoint === 'bulk'
  // Record narrowing applies to lifecycle triggers and client scripts;
  // endpoint/bulk/scheduled scripts aren't tied to a record at all.
  const hasDocKind = !isScheduled && !isEndpoint && !isBulk
  const canRunNow = isScheduled || isBulk

  async function save() {
    setBusy(true)
    const res = await fetch('/api/admin/scripts', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: script?.id,
        name,
        triggerPoint,
        documentKind: hasDocKind ? (documentKind || null) : null,
        endpointSlug: isEndpoint ? endpointSlug.trim() : null,
        source,
        cron: isScheduled ? cron : null,
        timeoutMs: Number(timeoutMs) || 2000,
        sortOrder: Number(sortOrder) || 100,
        isActive,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.saveFailed'))
      setBusy(false)
      return
    }
    toast.success(creating ? t('drawer.created') : t('drawer.saved'))
    router.push('/admin/scripts')
    router.refresh()
  }

  async function deleteScript() {
    if (!script?.id) return
    if (!confirm(t('drawer.deleteConfirm'))) return
    setBusy(true)
    const res = await fetch(`/api/admin/scripts/${script.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const data = await res.json()
      toast.error(data.error ?? t('drawer.deleteFailed'))
      setBusy(false)
      return
    }
    toast.success(t('drawer.deleted'))
    router.push('/admin/scripts')
    router.refresh()
  }

  async function runNow() {
    if (!script?.id) return
    setRunning(true)
    try {
      const res = await fetch(`/api/admin/scripts/${script.id}/run`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('drawer.runFailed'))
      } else if (data.queued) {
        toast.success(t('drawer.runOk', { ms: 0 }))
      } else if (data.status === 'ok') {
        toast.success(t('drawer.runOk', { ms: data.durationMs }))
      } else {
        toast.error(t('drawer.runFailed') + (data.abortReason ? `: ${data.abortReason}` : ''))
      }
      setTab('log')
      setSelectedRun(0)
      router.refresh()
    } catch {
      toast.error(t('drawer.runFailed'))
    } finally {
      setRunning(false)
    }
  }

  function onTriggerChange(v: string) {
    setTriggerPoint(v)
    // Swap starter templates only while the source is still an untouched template.
    if (ALL_TEMPLATES.has(source)) {
      setSource(TEMPLATE_BY_TRIGGER[v] ?? TEMPLATE)
    }
  }

  const run = runs[selectedRun]

  return (
    <UrlDrawer
      open
      closeHref="/admin/scripts"
      size="xl"
      title={creating ? t('drawer.newTitle') : script!.name}
      description={t('drawer.description')}
      headerActions={
        <>
          {script?.id && canRunNow && (
            <Button variant="outline" size="sm" disabled={running || busy} onClick={runNow}>
              <Play size={14} /> {running ? tCommon('actions.running') : t('drawer.runNow')}
            </Button>
          )}
          {!creating && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={deleteScript} className="text-red-600 hover:text-red-700 dark:text-red-400">
              <Trash2 size={14} /> {t('drawer.delete')}
            </Button>
          )}
          <Button
            disabled={busy || !name || !source.includes('function main') || (isEndpoint && !endpointSlug.trim())}
            onClick={save}
          >
            {busy
              ? tCommon('actions.saving')
              : creating
                ? t('drawer.createScript')
                : t('drawer.saveScript')}
          </Button>
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            {tCommon('labels.active')}
          </label>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* Subtab bar */}
        <div className="flex shrink-0 gap-1 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                tab === k
                  ? 'border-teal-500 text-teal-700 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
              )}
            >
              {t(`tabs.${k}`)}
              {k === 'runs' && runs.length > 0 ? (
                <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500 dark:bg-slate-800">
                  {runs.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div key={tab} className="min-h-0 flex-1 overflow-y-auto p-1 pt-4">
          {tab === 'general' ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{tCommon('labels.name')}</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('drawer.namePlaceholder')} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('drawer.trigger')}</Label>
                  <Select value={triggerPoint} onChange={(e) => onTriggerChange(e.target.value)}>
                    {TRIGGERS.map((tr) => (
                      <option key={tr.value} value={tr.value}>
                        {t(tr.labelKey)}
                      </option>
                    ))}
                  </Select>
                </div>
                {hasDocKind && (
                  <div className="space-y-1.5">
                    <Label>{t('drawer.documentKind')}</Label>
                    <Select value={documentKind} onChange={(e) => setDocumentKind(e.target.value)}>
                      <option value="">{t('drawer.allKindsOption')}</option>
                      <optgroup label={t('drawer.builtInGroup')}>
                        {BUILT_IN_SCRIPT_KINDS.map((k) => (
                          <option key={k.value} value={k.value}>
                            {t(k.labelKey)}
                          </option>
                        ))}
                      </optgroup>
                      {customTypes.length > 0 && (
                        <optgroup label={t('drawer.customRecordsGroup')}>
                          {customTypes.map((ct) => (
                            <option key={ct.key} value={customRecordKind(ct.key)}>
                              {ct.name}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </Select>
                  </div>
                )}
                {isScheduled && (
                  <div className="space-y-1.5">
                    <Label>
                      {t('drawer.cron')}{' '}
                      <span className="font-normal text-slate-400">{t('drawer.cronHint')}</span>
                    </Label>
                    <Input
                      value={cron}
                      onChange={(e) => setCron(e.target.value)}
                      placeholder="0 * * * *"
                      className="font-mono text-[13px]"
                    />
                  </div>
                )}
                {isEndpoint && (
                  <div className="space-y-1.5">
                    <Label>
                      {t('drawer.endpointSlug')}{' '}
                      <span className="font-normal text-slate-400">/api/scripts/e/…</span>
                    </Label>
                    <Input
                      value={endpointSlug}
                      onChange={(e) => setEndpointSlug(e.target.value)}
                      placeholder="my-endpoint"
                      className="font-mono text-[13px]"
                    />
                    {endpointSlug.trim() && (
                      <div className="space-y-1 pt-1">
                        <Label>{t('drawer.endpointUrl')}</Label>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 truncate rounded bg-slate-100 px-2 py-1.5 font-mono text-xs dark:bg-slate-800" title={endpointUrl}>
                            {endpointUrl}
                          </code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => { navigator.clipboard?.writeText(endpointUrl); toast.success(t('drawer.urlCopied')) }}
                          >
                            {t('drawer.copyUrl')}
                          </Button>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.endpointUrlHint')}</p>
                      </div>
                    )}
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label>{t('drawer.timeoutMs')}</Label>
                  <Input inputMode="numeric" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('drawer.runOrder')}</Label>
                  <Input inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'code' ? (
            <div className="space-y-1.5">
              <Label>
                {t('drawer.source')}{' '}
                <span className="font-normal text-slate-400">{t('drawer.sourceHint')}</span>
              </Label>
              <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                <CodeMirror
                  value={source}
                  onChange={(v) => setSource(v)}
                  extensions={[javascript()]}
                  theme="dark"
                  minHeight="420px"
                  maxHeight="640px"
                  basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true }}
                />
              </div>
            </div>
          ) : null}

          {tab === 'runs' ? (
            runs.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 p-6 text-sm text-slate-500 dark:border-slate-800">
                {t('drawer.noRuns')}
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {runs.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setSelectedRun(i)
                      setTab('log')
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-900',
                      i === selectedRun && 'bg-slate-50 dark:bg-slate-900',
                    )}
                  >
                    <Badge variant={r.status === 'ok' ? 'success' : r.status === 'aborted' ? 'warning' : 'destructive'}>
                      {RUN_STATUSES.has(r.status) ? t(`drawer.runStatus.${r.status}`) : r.status}
                    </Badge>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {dateTime(r.at)} · {r.target_kind} · {r.duration_ms}ms
                    </span>
                    {r.error_message ? (
                      <span className="min-w-0 flex-1 truncate text-xs text-red-600 dark:text-red-400">{r.error_message}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            )
          ) : null}

          {tab === 'log' ? (
            !run ? (
              <p className="rounded-lg border border-dashed border-slate-200 p-6 text-sm text-slate-500 dark:border-slate-800">
                {runs.length === 0 ? t('drawer.noRuns') : t('drawer.selectRun')}
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge variant={run.status === 'ok' ? 'success' : run.status === 'aborted' ? 'warning' : 'destructive'}>
                    {RUN_STATUSES.has(run.status) ? t(`drawer.runStatus.${run.status}`) : run.status}
                  </Badge>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {dateTime(run.at)} · {run.target_kind} · {run.duration_ms}ms
                  </span>
                </div>
                {run.error_message ? (
                  <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                    {run.error_message}
                  </p>
                ) : null}
                <div className="rounded-lg bg-slate-950 p-4">
                  {Array.isArray(run.logs) && run.logs.length > 0 ? (
                    <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed text-slate-100">
                      {run.logs.join('\n')}
                    </pre>
                  ) : (
                    <p className="font-mono text-[12px] text-slate-500">{t('drawer.logEmpty')}</p>
                  )}
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>
    </UrlDrawer>
  )
}
