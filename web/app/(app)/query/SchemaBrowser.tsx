'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRight, Columns3, Database, Eye, KeyRound, Search, Table2 } from 'lucide-react'
import { Input, cn } from '@openbooks/ui'

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
}
export interface SchemaTable {
  name: string
  kind: 'table' | 'view'
  columns: SchemaColumn[]
}

/**
 * Live schema tree for the console left rail. Fed by /api/query/schema (which
 * introspects under the same read-only role, so it lists exactly what the user
 * can query). Search matches both table and column names; a match on a column
 * auto-expands its table. Clicking a table or column name inserts it at the
 * editor caret via `onInsert`.
 */
export function SchemaBrowser({
  tables,
  loading,
  error,
  onInsert,
}: {
  tables: SchemaTable[]
  loading: boolean
  error: string | null
  onInsert: (text: string) => void
}) {
  const t = useTranslations('query')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})

  const query = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!query) return tables
    return tables
      .map((tbl) => {
        if (tbl.name.toLowerCase().includes(query)) return tbl
        const cols = tbl.columns.filter((c) => c.name.toLowerCase().includes(query))
        return cols.length ? { ...tbl, columns: cols } : null
      })
      .filter((x): x is SchemaTable => x !== null)
  }, [tables, query])

  const isOpen = (name: string) => open[name] ?? Boolean(query)

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 p-2 dark:border-slate-800">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('schema.searchPlaceholder')}
            className="h-8 pl-8 text-xs"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          <div className="space-y-1 p-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-7 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
            ))}
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-red-600 dark:text-red-400">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-slate-400 dark:text-slate-500">
            <Database size={20} />
            {t('schema.noMatch')}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((tbl) => (
              <li key={tbl.name}>
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [tbl.name]: !isOpen(tbl.name) }))}
                  className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[13px] hover:bg-slate-100 dark:hover:bg-slate-800/70"
                >
                  <ChevronRight
                    size={13}
                    className={cn('shrink-0 text-slate-400 transition-transform', isOpen(tbl.name) && 'rotate-90')}
                  />
                  {tbl.kind === 'view' ? (
                    <Eye size={13} className="shrink-0 text-violet-500" />
                  ) : (
                    <Table2 size={13} className="shrink-0 text-teal-600 dark:text-teal-400" />
                  )}
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-slate-200"
                    onClick={(e) => {
                      e.stopPropagation()
                      onInsert(tbl.name)
                    }}
                    title={t('schema.insertTable')}
                  >
                    {tbl.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-400 tabular-nums opacity-0 group-hover:opacity-100 dark:text-slate-500">
                    {tbl.columns.length}
                  </span>
                </button>
                {isOpen(tbl.name) ? (
                  <ul className="mb-1 ml-[1.35rem] border-l border-slate-200 pl-1.5 dark:border-slate-800">
                    {tbl.columns.map((col) => (
                      <li key={col.name}>
                        <button
                          type="button"
                          onClick={() => onInsert(col.name)}
                          title={t('schema.insertColumn')}
                          className="group flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800/70"
                        >
                          <Columns3 size={12} className="shrink-0 text-slate-400" />
                          <span className="min-w-0 flex-1 truncate font-mono text-slate-600 dark:text-slate-300">{col.name}</span>
                          {!col.nullable ? (
                            <KeyRound size={10} className="shrink-0 text-amber-500 opacity-70" />
                          ) : null}
                          <span className="shrink-0 font-mono text-[10px] text-slate-400 opacity-0 group-hover:opacity-100 dark:text-slate-500">
                            {col.type}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
