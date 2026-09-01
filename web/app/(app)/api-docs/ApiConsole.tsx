'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, BookOpen, Clock, KeyRound, Play, RotateCcw, Search, TerminalSquare } from 'lucide-react'
import { Badge, Button, Input, Select, cn } from '@openbooks/ui'

/**
 * Interactive REST console for /api/v1 — the query-console workbench applied to
 * the versioned API. The record-type rail, the fields reference, and the
 * request-body template are all generated from the SAME live schema that powers
 * the OpenAPI spec, so the console can never advertise an endpoint or field the
 * API doesn't actually serve.
 */

type Op = 'list' | 'get' | 'create' | 'update' | 'delete'

interface Field {
  name: string
  type: string
  required: boolean
  writable: boolean
  description: string | null
  custom: boolean
}

interface RecordType {
  key: string
  label: string
  description: string
  path: string
  readPermission: string
  writePermission: string | null
  operations: Op[]
  dynamic: boolean
  writer: { kind: 'custom_record' | 'document' | 'entity' | 'readonly' }
  fields: Field[]
}

type Method = 'GET' | 'GET_ONE' | 'POST' | 'PATCH' | 'DELETE'

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  POST: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  PATCH: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  DELETE: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
}

function sampleFor(type: string): unknown {
  const base = type.split(' (')[0]
  if (base === 'number') return 0
  if (base === 'boolean') return false
  if (base === 'array') return []
  if (base === 'object') return {}
  return ''
}

/** Build a request-body template shaped for the type's writer. */
function bodyTemplate(rt: RecordType): string {
  const writable = rt.fields.filter((f) => f.writable)
  if (rt.writer.kind === 'custom_record') {
    const data: Record<string, unknown> = {}
    for (const f of writable) data[f.name] = sampleFor(f.type)
    return JSON.stringify({ data }, null, 2)
  }
  if (rt.writer.kind === 'document') {
    return JSON.stringify(
      {
        documentDate: '',
        memo: '',
        lines: [{ accountId: '', amount: '0', description: '' }],
        action: 'draft',
      },
      null,
      2,
    )
  }
  const obj: Record<string, unknown> = {}
  for (const f of writable) if (f.required || f.custom) obj[f.name] = sampleFor(f.type)
  return JSON.stringify(obj, null, 2)
}

function methodsFor(rt: RecordType): { method: Method; label: string; op: Op }[] {
  const out: { method: Method; label: string; op: Op }[] = []
  if (rt.operations.includes('list')) out.push({ method: 'GET', label: 'GET (list)', op: 'list' })
  if (rt.operations.includes('get')) out.push({ method: 'GET_ONE', label: 'GET /{id}', op: 'get' })
  if (rt.operations.includes('create')) out.push({ method: 'POST', label: 'POST', op: 'create' })
  if (rt.operations.includes('update')) out.push({ method: 'PATCH', label: 'PATCH /{id}', op: 'update' })
  if (rt.operations.includes('delete')) out.push({ method: 'DELETE', label: 'DELETE /{id}', op: 'delete' })
  return out
}

interface ResponseState {
  status: number
  ms: number
  ok: boolean
  body: string
}

export function ApiConsole({ schema }: { schema: RecordType[] }) {
  const t = useTranslations('apiDocs')
  const [token, setToken] = useState('')
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState(schema[0]?.key ?? '')
  const [pane, setPane] = useState<'reference' | 'console'>('reference')
  const [method, setMethod] = useState<Method>('GET')
  const [id, setId] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [response, setResponse] = useState<ResponseState | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const selected = useMemo(() => schema.find((s) => s.key === selectedKey) ?? null, [schema, selectedKey])
  const methods = useMemo(() => (selected ? methodsFor(selected) : []), [selected])

  // When the selected type or method changes, reseed the body template.
  const resetBody = useCallback(() => {
    if (selected) setBody(bodyTemplate(selected))
  }, [selected])

  useEffect(() => {
    if (!selected) return
    setMethod(methods[0]?.method ?? 'GET')
    setResponse(null)
    setBody(bodyTemplate(selected))
  }, [selectedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return schema
    return schema.filter(
      (s) => s.label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q),
    )
  }, [schema, query])

  const needsId = method === 'GET_ONE' || method === 'PATCH' || method === 'DELETE'
  const hasBody = method === 'POST' || method === 'PATCH'

  const send = useCallback(async () => {
    if (!selected || !token.trim()) return
    let url = selected.path
    let httpMethod = 'GET'
    if (method === 'GET') httpMethod = 'GET'
    else if (method === 'GET_ONE') { httpMethod = 'GET'; url = `${selected.path}/${id}` }
    else if (method === 'POST') httpMethod = 'POST'
    else if (method === 'PATCH') { httpMethod = 'PATCH'; url = `${selected.path}/${id}` }
    else if (method === 'DELETE') { httpMethod = 'DELETE'; url = `${selected.path}/${id}` }

    setBusy(true)
    setResponse(null)
    const start = performance.now()
    try {
      const res = await fetch(url, {
        method: httpMethod,
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(hasBody ? { body } : {}),
      })
      const text = await res.text()
      let pretty = text
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        /* leave raw */
      }
      setResponse({ status: res.status, ms: Math.round(performance.now() - start), ok: res.ok, body: pretty })
    } catch (e) {
      setResponse({ status: 0, ms: Math.round(performance.now() - start), ok: false, body: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }, [selected, token, method, id, body, hasBody])

  function onTokenChange(v: string) {
    setToken(v)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
            <TerminalSquare size={18} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
            <p className="hidden truncate text-xs text-slate-500 sm:block dark:text-slate-400">{t('description')}</p>
          </div>
          <Badge variant="secondary" className="shrink-0">v1</Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <KeyRound size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-slate-400" />
            <Input
              type="password"
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              placeholder={t('console.tokenPlaceholder')}
              aria-label={t('console.tokenLabel')}
              className="h-9 w-56 pl-8 font-mono text-xs"
              spellCheck={false}
            />
          </div>
        </div>
      </div>

      {/* Workbench */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Left rail: record types */}
        <aside className="hidden min-h-0 flex-col border-r border-slate-200 bg-slate-50/50 lg:flex dark:border-slate-800 dark:bg-slate-900/40">
          <div className="shrink-0 border-b border-slate-200 p-2 dark:border-slate-800">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute top-2.5 left-2.5 text-slate-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="h-8 pl-8 text-xs"
                spellCheck={false}
              />
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-2">
            {filtered.map((rt) => (
              <li key={rt.key}>
                <button
                  type="button"
                  onClick={() => setSelectedKey(rt.key)}
                  className={cn(
                    'w-full rounded-md px-2.5 py-2 text-left hover:bg-white hover:shadow-sm dark:hover:bg-slate-800/70',
                    rt.key === selectedKey && 'bg-white shadow-sm dark:bg-slate-800/70',
                  )}
                >
                  <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-slate-700 dark:text-slate-200">
                    <span className="truncate">{rt.label}</span>
                    {rt.dynamic ? <span className="text-[10px] text-teal-600 dark:text-teal-400">{t('customBadge')}</span> : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400 dark:text-slate-500">{rt.path}</p>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Main pane */}
        <div className="flex min-h-0 min-w-0 flex-col">
          {/* Pane tabs */}
          <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5 dark:border-slate-800 dark:bg-slate-900">
            {(['reference', 'console'] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPane(p)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  pane === p
                    ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
                )}
              >
                {p === 'reference' ? <BookOpen size={14} /> : <Play size={14} />}
                {p === 'reference' ? t('console.referenceTab') : t('console.consoleTab')}
              </button>
            ))}
          </div>

          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-10 text-sm text-slate-400">{t('console.selectType')}</div>
          ) : pane === 'reference' ? (
            <ReferencePane rt={selected} t={t} />
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
              {/* Request builder */}
              <div className="flex min-h-0 flex-col border-r border-slate-200 dark:border-slate-800">
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
                  <Select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as Method)}
                    aria-label={t('console.method')}
                    className="h-8 w-40"
                  >
                    {methods.map((m) => (
                      <option key={m.method} value={m.method}>{m.label}</option>
                    ))}
                  </Select>
                  {needsId ? (
                    <Input
                      value={id}
                      onChange={(e) => setId(e.target.value)}
                      placeholder={t('console.idPlaceholder')}
                      className="h-8 flex-1 font-mono text-xs"
                      spellCheck={false}
                    />
                  ) : null}
                  <Button size="sm" onClick={send} disabled={busy || !token.trim()} className="ml-auto">
                    <Play size={14} />
                    {busy ? t('console.sending') : t('console.send')}
                  </Button>
                </div>
                {hasBody ? (
                  <>
                    <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-1.5 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                      <span>{t('console.requestBody')}</span>
                      <button type="button" onClick={resetBody} className="flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200">
                        <RotateCcw size={11} /> {t('console.resetBody')}
                      </button>
                    </div>
                    <textarea
                      ref={bodyRef}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      spellCheck={false}
                      className="min-h-0 flex-1 resize-none border-0 bg-slate-50 p-3 font-mono text-[12px] leading-relaxed text-slate-800 outline-none dark:bg-slate-950 dark:text-slate-100"
                    />
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-slate-400 dark:text-slate-500">
                    {selected.path}{needsId ? '/{id}' : method === 'GET' ? '?page=1&perPage=25&q=' : ''}
                  </div>
                )}
                {!token.trim() ? (
                  <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                    {t('console.needToken')}
                  </div>
                ) : (
                  <div className="shrink-0 border-t border-slate-200 px-3 py-2 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    {t('console.tokenNote')}
                  </div>
                )}
              </div>

              {/* Response */}
              <div className="flex min-h-0 flex-col bg-white dark:bg-slate-950">
                <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
                  {response ? (
                    <>
                      <span
                        className={cn(
                          'rounded px-2 py-0.5 font-mono font-semibold',
                          response.ok
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                            : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
                        )}
                      >
                        {response.status || 'ERR'}
                      </span>
                      <span className="flex items-center gap-1 text-slate-400 tabular-nums dark:text-slate-500">
                        <Clock size={12} /> {response.ms}ms
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-400 dark:text-slate-500">{t('console.response')}</span>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {response ? (
                    <pre className="p-3 font-mono text-[12px] whitespace-pre-wrap text-slate-700 dark:text-slate-200">{response.body}</pre>
                  ) : (
                    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-slate-400 dark:text-slate-500">
                      {t('console.responseIdle')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReferencePane({ rt, t }: { rt: RecordType; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{rt.label}</h2>
        <code className="font-mono text-[12px] text-slate-400">{rt.path}</code>
        {rt.writer.kind === 'readonly' ? <Badge variant="outline">{t('console.readOnly')}</Badge> : null}
      </div>
      <p className="mb-3 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{rt.description}</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {rt.operations.map((op) => (
          <span
            key={op}
            className={cn(
              'rounded px-2 py-0.5 font-mono text-[11px] font-semibold uppercase',
              METHOD_STYLES[op === 'list' || op === 'get' ? 'GET' : op === 'create' ? 'POST' : op === 'update' ? 'PATCH' : 'DELETE'],
            )}
          >
            {op === 'list' || op === 'get' ? 'GET' : op === 'create' ? 'POST' : op.toUpperCase()}
          </span>
        ))}
        <span className="text-[11px] text-slate-400">
          {t('requires')} <code className="font-mono">{rt.readPermission}</code>
          {rt.writePermission ? <> · {t('writesRequire')} <code className="font-mono">{rt.writePermission}</code></> : null}
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900/60">
              <th className="px-4 py-2 font-medium">{t('fields.field')}</th>
              <th className="px-4 py-2 font-medium">{t('fields.type')}</th>
              <th className="px-4 py-2 font-medium">{t('fields.required')}</th>
              <th className="px-4 py-2 font-medium">{t('fields.description')}</th>
            </tr>
          </thead>
          <tbody>
            {rt.fields.map((f) => (
              <tr key={f.name} className="border-b border-slate-100 last:border-0 dark:border-slate-800/50">
                <td className="px-4 py-2 font-mono text-[12px] text-slate-700 dark:text-slate-300">
                  {f.name}
                  {f.custom ? <span className="ml-1.5 text-[10px] text-teal-600 dark:text-teal-400">{t('customBadge')}</span> : null}
                  {!f.writable ? <span className="ml-1.5 text-[10px] text-slate-400">read-only</span> : null}
                </td>
                <td className="px-4 py-2 font-mono text-[12px] text-slate-500 dark:text-slate-400">{f.type}</td>
                <td className="px-4 py-2">{f.required ? <Badge variant="warning">{t('fields.yes')}</Badge> : null}</td>
                <td className="px-4 py-2 text-slate-500 dark:text-slate-400">{f.description ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
