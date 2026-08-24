'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  ClipboardCopy,
  Clock,
  Database,
  Download,
  Eraser,
  History,
  Play,
  Sparkles,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { Badge, Button, Input, Select, cn } from '@openbooks/ui'
import { useBusinessToday } from '../../../components/business-date-provider'
import { exportCsv } from '../analytics/_ui/exportCsv'
import { ResultsGrid, resultToCsv, type QueryResult } from './ResultsGrid'
import { SchemaBrowser, type SchemaTable } from './SchemaBrowser'
import { queryResponseError, readQueryResponse } from './query-response'
import { SNIPPETS } from './snippets'

const STARTER = `select a.number, a.name, sum(g.debit_total - g.credit_total) as balance
  from gl_month_activity g
  join accounts a on a.id = g.account_id and a.org_id = g.org_id
 group by a.number, a.name
 order by abs(sum(g.debit_total - g.credit_total)) desc
 limit 15`

const HISTORY_KEY = 'openbooks.sqlConsole.history.v1'
const DRAFT_KEY = 'openbooks.sqlConsole.draft.v1'
const SNIPPETS_KEY = 'openbooks.sqlConsole.snippets.v1'
const ROW_LIMITS = [100, 500, 1000, 5000]

interface HistoryItem {
  sql: string
  at: number
  ms: number
  rows: number
  ok: boolean
}

interface SavedSnippet {
  id: string
  name: string
  sql: string
  at: number
}

type RailTab = 'schema' | 'snippets' | 'history'

export default function QueryConsole() {
  const t = useTranslations('query')
  const today = useBusinessToday()
  const [sqlText, setSqlText] = useState(STARTER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [ranSelection, setRanSelection] = useState(false)
  const [maxRows, setMaxRows] = useState(500)
  const [resultFilter, setResultFilter] = useState('')

  const [tab, setTab] = useState<RailTab>('schema')
  const [schema, setSchema] = useState<SchemaTable[]>([])
  const [schemaLoading, setSchemaLoading] = useState(true)
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [saved, setSaved] = useState<SavedSnippet[]>([])
  const [snippetName, setSnippetName] = useState('')

  const [editorH, setEditorH] = useState(260)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const snippetNameRef = useRef<HTMLInputElement>(null)

  // --- restore draft + history + saved snippets, load schema ---
  useEffect(() => {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) setSqlText(draft)
      const h = localStorage.getItem(HISTORY_KEY)
      if (h) setHistory(JSON.parse(h))
      const s = localStorage.getItem(SNIPPETS_KEY)
      if (s) setSaved(JSON.parse(s))
    } catch {
      /* ignore corrupt storage */
    }
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/api/query/schema')
      .then(async (response) => ({ response, data: await readQueryResponse<{ tables?: unknown; error?: unknown }>(response) }))
      .then(({ response, data }) => {
        if (!alive) return
        if (!response.ok) {
          setSchemaError(queryResponseError(data, response.status))
          return
        }
        if (!Array.isArray(data.tables)) {
          setSchemaError('Query service returned an invalid schema response')
          return
        }
        setSchema(data.tables as SchemaTable[])
      })
      .catch((e) => alive && setSchemaError((e as Error).message))
      .finally(() => alive && setSchemaLoading(false))
    return () => {
      alive = false
    }
  }, [])

  // Persist draft (debounced-ish via effect on change).
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, sqlText)
    } catch {
      /* ignore */
    }
  }, [sqlText])

  const pushHistory = useCallback((item: HistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev.filter((h) => h.sql !== item.sql)].slice(0, 30)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const executeSql = useCallback(async (sql: string, selection = false) => {
    if (!sql.trim()) return
    setBusy(true)
    setRanSelection(selection)
    setError(null)
    setResultFilter('')
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, maxRows }),
      })
      const data = await readQueryResponse<QueryResult & { error?: unknown }>(res)
      if (!res.ok) throw new Error(queryResponseError(data, res.status))
      if (!Array.isArray(data.columns) || !Array.isArray(data.rows) || typeof data.rowCount !== 'number') {
        throw new Error('Query service returned an invalid result')
      }
      setResult(data)
      pushHistory({ sql: sql.trim(), at: Date.now(), ms: data.durationMs, rows: data.rowCount, ok: true })
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
      pushHistory({ sql: sql.trim(), at: Date.now(), ms: 0, rows: 0, ok: false })
    } finally {
      setBusy(false)
    }
  }, [maxRows, pushHistory])

  const run = useCallback(async () => {
    const el = editorRef.current
    let sql = sqlText
    let selection = false
    if (el && el.selectionStart !== el.selectionEnd) {
      sql = sqlText.slice(el.selectionStart, el.selectionEnd)
      selection = true
    }
    await executeSql(sql, selection)
  }, [executeSql, sqlText])

  // Replace the editor with a schema-browser query and run that exact text.
  // Passing the statement directly avoids executing a stale React state value.
  const browseRows = useCallback((sql: string) => {
    setSqlText(sql)
    requestAnimationFrame(() => editorRef.current?.focus())
    void executeSql(sql)
  }, [executeSql])

  // Insert text (table/column name) at the caret from the schema browser.
  const insertAtCaret = useCallback(
    (text: string) => {
      const el = editorRef.current
      if (!el) {
        setSqlText((s) => `${s}${text}`)
        return
      }
      const start = el.selectionStart
      const end = el.selectionEnd
      setSqlText((s) => s.slice(0, start) + text + s.slice(end))
      requestAnimationFrame(() => {
        el.focus()
        const pos = start + text.length
        el.setSelectionRange(pos, pos)
      })
    },
    [],
  )

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      run()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      setSqlText((s) => s.slice(0, start) + '  ' + s.slice(end))
      requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
    }
  }

  // --- vertical splitter between editor and results ---
  function startDrag(e: React.PointerEvent) {
    e.preventDefault()
    const box = workbenchRef.current
    if (!box) return
    const move = (ev: PointerEvent) => {
      const top = box.getBoundingClientRect().top
      setEditorH(Math.min(Math.max(ev.clientY - top - 44, 120), box.clientHeight - 160))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  async function copyCsv() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(resultToCsv(result))
      toast.success(t('copiedCsv'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  function downloadCsv() {
    if (!result) return
    const cell = (v: unknown): string | number | null => {
      if (v === null || v === undefined) return null
      if (typeof v === 'number') return v
      if (typeof v === 'object') return JSON.stringify(v)
      return String(v)
    }
    exportCsv(
      `query-${result.rowCount}rows`,
      result.columns,
      result.rows.map((row) => result.columns.map((col) => cell(row[col]))),
      today,
    )
  }

  function clearHistory() {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {
      /* ignore */
    }
  }

  function persistSaved(next: SavedSnippet[]) {
    setSaved(next)
    try {
      localStorage.setItem(SNIPPETS_KEY, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }

  function saveSnippet() {
    const sql = sqlText.trim()
    if (!sql) return
    const name = snippetName.trim() || sql.split('\n')[0]!.slice(0, 60)
    const item: SavedSnippet = { id: `${Date.now()}-${saved.length}`, name, sql, at: Date.now() }
    persistSaved([item, ...saved.filter((s) => s.name !== name)].slice(0, 100))
    setSnippetName('')
    toast.success(t('snippetSaved', { name }))
  }

  function deleteSnippet(id: string) {
    persistSaved(saved.filter((s) => s.id !== id))
  }

  // Jump to the Snippets tab with the name field focused, ready to save.
  function beginSaveSnippet() {
    if (!sqlText.trim()) return
    setTab('snippets')
    requestAnimationFrame(() => snippetNameRef.current?.focus())
  }

  const TABS: { key: RailTab; label: string; icon: typeof Database }[] = [
    { key: 'schema', label: t('rail.schema'), icon: Database },
    { key: 'snippets', label: t('rail.snippets'), icon: Sparkles },
    { key: 'history', label: t('rail.history'), icon: History },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
            <TerminalSquare size={18} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h1>
            <p className="hidden truncate text-xs text-slate-500 sm:block dark:text-slate-400">{t('subtitle')}</p>
          </div>
        </div>
        <Badge variant="secondary" className="hidden shrink-0 gap-1.5 sm:inline-flex">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          {t('readOnlyBadge')}
        </Badge>
      </div>

      {/* Workbench: left rail + editor/results */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Left rail */}
        <aside className="hidden min-h-0 flex-col border-r border-slate-200 bg-slate-50/50 lg:flex dark:border-slate-800 dark:bg-slate-900/40">
          <div className="flex shrink-0 border-b border-slate-200 dark:border-slate-800">
            {TABS.map((x) => (
              <button
                key={x.key}
                type="button"
                onClick={() => setTab(x.key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-xs font-medium transition-colors',
                  tab === x.key
                    ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                    : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
                )}
              >
                <x.icon size={14} />
                {x.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'schema' ? (
              <SchemaBrowser
                tables={schema}
                loading={schemaLoading}
                error={schemaError}
                onInsert={insertAtCaret}
                onBrowse={browseRows}
              />
            ) : tab === 'snippets' ? (
              <div className="flex h-full flex-col">
                {/* Save the current query */}
                <div className="shrink-0 border-b border-slate-200 p-2 dark:border-slate-800">
                  <div className="flex items-center gap-1.5">
                    <Input
                      ref={snippetNameRef}
                      value={snippetName}
                      onChange={(e) => setSnippetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          saveSnippet()
                        }
                      }}
                      placeholder={t('snippets.namePlaceholder')}
                      className="h-8 text-xs"
                      spellCheck={false}
                    />
                    <Button size="sm" variant="outline" onClick={saveSnippet} disabled={!sqlText.trim()} className="h-8 shrink-0">
                      <BookmarkPlus size={14} /> {t('snippets.save')}
                    </Button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {/* User-saved queries */}
                  {saved.length > 0 ? (
                    <div className="mb-2">
                      <div className="px-1.5 pb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
                        {t('snippets.savedHeading')}
                      </div>
                      <ul>
                        {saved.map((s) => (
                          <li key={s.id} className="group relative">
                            <button
                              type="button"
                              onClick={() => {
                                setSqlText(s.sql)
                                requestAnimationFrame(() => editorRef.current?.focus())
                              }}
                              className="w-full rounded-md px-2.5 py-2 pr-8 text-left hover:bg-white hover:shadow-sm dark:hover:bg-slate-800/70"
                            >
                              <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-slate-700 dark:text-slate-200">
                                <Bookmark size={12} className="shrink-0 text-teal-500" />
                                <span className="truncate">{s.name}</span>
                              </div>
                              <p className="mt-0.5 truncate pl-[1.15rem] font-mono text-[11px] text-slate-400 dark:text-slate-500">
                                {s.sql.split('\n')[0]}
                              </p>
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteSnippet(s.id)}
                              aria-label={t('snippets.delete')}
                              className="absolute top-2 right-1.5 rounded p-1 text-slate-300 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-red-950/40"
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {/* Built-in examples */}
                  <div className="px-1.5 pb-1 text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
                    {t('snippets.examplesHeading')}
                  </div>
                  <ul>
                    {SNIPPETS.map((s) => (
                      <li key={s.key}>
                        <button
                          type="button"
                          onClick={() => {
                            setSqlText(s.sql)
                            requestAnimationFrame(() => editorRef.current?.focus())
                          }}
                          className="group w-full rounded-md px-2.5 py-2 text-left hover:bg-white hover:shadow-sm dark:hover:bg-slate-800/70"
                        >
                          <div className="flex items-center gap-1.5 text-[13px] font-medium text-slate-700 group-hover:text-teal-700 dark:text-slate-200 dark:group-hover:text-teal-300">
                            <Sparkles size={12} className="shrink-0 text-teal-500" />
                            {t(`snippets.${s.key}.label` as never)}
                          </div>
                          <p className="mt-0.5 pl-[1.15rem] text-xs text-slate-500 dark:text-slate-400">
                            {t(`snippets.${s.key}.description` as never)}
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                {history.length > 0 ? (
                  <div className="flex shrink-0 items-center justify-between px-3 py-1.5 text-[11px] text-slate-400 dark:text-slate-500">
                    <span>{t('history.count', { count: history.length })}</span>
                    <button type="button" onClick={clearHistory} className="hover:text-slate-700 dark:hover:text-slate-200">
                      {t('history.clear')}
                    </button>
                  </div>
                ) : null}
                <ul className="min-h-0 flex-1 overflow-y-auto p-2">
                  {history.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-slate-400 dark:text-slate-500">
                      <History size={20} />
                      {t('history.empty')}
                    </div>
                  ) : (
                    history.map((h, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          onClick={() => {
                            setSqlText(h.sql)
                            requestAnimationFrame(() => editorRef.current?.focus())
                          }}
                          className="group w-full rounded-md px-2.5 py-2 text-left hover:bg-white hover:shadow-sm dark:hover:bg-slate-800/70"
                        >
                          <div className="truncate font-mono text-xs text-slate-600 group-hover:text-teal-700 dark:text-slate-300 dark:group-hover:text-teal-300">
                            {h.sql.split('\n')[0]}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-400 dark:text-slate-500">
                            {h.ok ? (
                              <span className="tabular-nums">{t('history.rows', { count: h.rows })} · {h.ms}ms</span>
                            ) : (
                              <span className="text-red-500">{t('history.failed')}</span>
                            )}
                          </div>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            )}
          </div>
        </aside>

        {/* Editor + results */}
        <div ref={workbenchRef} className="flex min-h-0 min-w-0 flex-col">
          {/* Editor toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
            <Button size="sm" onClick={run} disabled={busy}>
              <Play size={14} />
              {busy ? t('running') : t('run')}
            </Button>
            <Button size="sm" variant="outline" onClick={beginSaveSnippet} disabled={!sqlText.trim()}>
              <BookmarkPlus size={14} />
              {t('snippets.save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSqlText('')} disabled={!sqlText}>
              <Eraser size={14} />
              {t('clear')}
            </Button>
            <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 sm:inline-block dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              ⌘⏎
            </kbd>
            <div className="ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <label htmlFor="rowlimit">{t('rowLimit')}</label>
              <Select
                id="rowlimit"
                value={String(maxRows)}
                onChange={(e) => setMaxRows(Number(e.target.value))}
                className="h-8 w-24"
                aria-label={t('rowLimit')}
              >
                {ROW_LIMITS.map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {/* Editor */}
          <div className="shrink-0 bg-slate-50 dark:bg-slate-950" style={{ height: editorH }}>
            <textarea
              ref={editorRef}
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              onKeyDown={onEditorKeyDown}
              spellCheck={false}
              placeholder={t('editorPlaceholder')}
              className="h-full w-full resize-none border-0 bg-transparent p-3 font-mono text-[13px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
            />
          </div>

          {/* Splitter */}
          <div
            onPointerDown={startDrag}
            className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-y border-slate-200 bg-slate-100 hover:bg-teal-100 dark:border-slate-800 dark:bg-slate-800 dark:hover:bg-teal-900/40"
          >
            <div className="h-0.5 w-8 rounded-full bg-slate-300 group-hover:bg-teal-500 dark:bg-slate-600" />
          </div>

          {/* Results toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2 text-xs">
              {error ? (
                <span className="flex items-center gap-1.5 font-medium text-red-600 dark:text-red-400">
                  <AlertTriangle size={13} /> {t('failed')}
                </span>
              ) : result ? (
                <>
                  <span className="font-medium text-slate-700 tabular-nums dark:text-slate-200">
                    {t('rowCount', { count: result.rowCount })}
                  </span>
                  <span className="flex items-center gap-1 text-slate-400 tabular-nums dark:text-slate-500">
                    <Clock size={12} /> {result.durationMs}ms
                  </span>
                  {result.truncated ? <Badge variant="warning">{t('truncated', { max: maxRows })}</Badge> : null}
                  {ranSelection ? <Badge variant="outline">{t('ranSelection')}</Badge> : null}
                </>
              ) : (
                <span className="text-slate-400 dark:text-slate-500">{t('resultsIdle')}</span>
              )}
            </div>
            {result && result.rowCount > 0 ? (
              <div className="ml-auto flex items-center gap-1.5">
                <div className="relative">
                  <Input
                    value={resultFilter}
                    onChange={(e) => setResultFilter(e.target.value)}
                    placeholder={t('filterResults')}
                    className="h-7 w-40 text-xs"
                    spellCheck={false}
                  />
                </div>
                <Button size="sm" variant="outline" onClick={copyCsv} className="h-7">
                  <ClipboardCopy size={13} /> {t('copyCsv')}
                </Button>
                <Button size="sm" variant="outline" onClick={downloadCsv} className="h-7">
                  <Download size={13} /> CSV
                </Button>
              </div>
            ) : null}
          </div>

          {/* Results body */}
          <div className="min-h-0 flex-1 overflow-hidden bg-white dark:bg-slate-950">
            {error ? (
              <div className="p-4">
                <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/40">
                  <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
                    <AlertTriangle size={15} /> {t('queryError')}
                  </div>
                  <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap text-red-700 dark:text-red-300">{error}</pre>
                </div>
              </div>
            ) : result ? (
              <ResultsGrid result={result} filter={resultFilter} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
                  <Play size={20} />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-600 dark:text-slate-300">{t('runToSeeResults')}</p>
                  <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{t('runHint')}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
