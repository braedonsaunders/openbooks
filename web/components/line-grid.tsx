'use client'

/**
 * LineGrid — the transaction line editor used by every document type
 * (vendor bills, invoices, journals, expense reports). NetSuite-grade grid
 * behavior, openbooks polish:
 *
 *  - spreadsheet keyboard model: Enter commits + moves down (appending a row
 *    at the bottom), Alt+↑/↓ moves the row, ⌘/Ctrl+D duplicates it,
 *    ⌘/Ctrl+Backspace deletes it, Tab walks cells naturally
 *  - per-row grip menu: insert above/below, duplicate, remove
 *  - amount cells edit raw, normalize to 2dp on blur, flag non-numeric input
 *  - column model is data: text / amount / select / search-select / readonly
 *    — custom-field columns are just more columns
 *  - controlled component: rows in, rows out; parent owns persistence
 *    (autosave) and computed values (tax, totals) via readonly columns
 */

import { useCallback, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button, Popover, SearchSelect, Select, cn } from '@openbooks/ui'

export interface LineGridOption {
  value: string
  label: string
}

export interface LineGridColumn<Row extends Record<string, unknown>> {
  key: string
  label: string
  /** CSS grid track, e.g. 'minmax(180px,2fr)' or '110px'. */
  width: string
  type: 'text' | 'amount' | 'select' | 'search-select' | 'readonly'
  align?: 'left' | 'right'
  options?: LineGridOption[]
  placeholder?: string
  required?: boolean
  /** Renderer for readonly columns (computed cells, e.g. line tax). */
  render?: (row: Row, index: number) => React.ReactNode
}

function normalizeAmount(v: string): string {
  const n = Number(v)
  if (v.trim() === '' || Number.isNaN(n)) return v
  return n.toFixed(2)
}

export function LineGrid<Row extends Record<string, unknown>>({
  columns,
  rows,
  onRowsChange,
  emptyRow,
  readOnly = false,
  minRows = 1,
  footer,
  addLabel = 'Add line',
}: {
  columns: LineGridColumn<Row>[]
  rows: Row[]
  onRowsChange: (rows: Row[]) => void
  emptyRow: () => Row
  readOnly?: boolean
  minRows?: number
  footer?: React.ReactNode
  addLabel?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [menuRow, setMenuRow] = useState<number | null>(null)

  const template = readOnly
    ? columns.map((c) => c.width).join(' ')
    : `34px ${columns.map((c) => c.width).join(' ')}`

  const setCell = useCallback(
    (i: number, key: string, value: unknown) => {
      onRowsChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)))
    },
    [rows, onRowsChange],
  )

  const insertRow = (at: number) => {
    const next = [...rows]
    next.splice(at, 0, emptyRow())
    onRowsChange(next)
    focusCell(at, 0)
  }
  const duplicateRow = (i: number) => {
    const next = [...rows]
    next.splice(i + 1, 0, { ...rows[i]! })
    onRowsChange(next)
    focusCell(i + 1, 0)
  }
  const removeRow = (i: number) => {
    if (rows.length <= minRows) {
      onRowsChange(rows.map((r, j) => (j === i ? emptyRow() : r)))
      return
    }
    onRowsChange(rows.filter((_, j) => j !== i))
  }
  const moveRow = (i: number, delta: number) => {
    const j = i + delta
    if (j < 0 || j >= rows.length) return
    const next = [...rows]
    const [row] = next.splice(i, 1)
    next.splice(j, 0, row!)
    onRowsChange(next)
    focusCell(j, focusedCol.current)
  }

  const focusedCol = useRef(0)
  function focusCell(row: number, col: number) {
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-lg-row="${row}"][data-lg-col="${col}"] input, [data-lg-row="${row}"][data-lg-col="${col}"] button, [data-lg-row="${row}"][data-lg-col="${col}"] select`,
      )
      el?.focus()
    })
  }

  function handleKeyDown(e: React.KeyboardEvent, i: number, colIndex: number) {
    focusedCol.current = colIndex
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      // let selects handle their own Enter (option commit)
      const tag = (e.target as HTMLElement).tagName
      const isOpenListbox = (e.target as HTMLElement).getAttribute('aria-expanded') === 'true'
      if (isOpenListbox) return
      e.preventDefault()
      if (i === rows.length - 1) {
        onRowsChange([...rows, emptyRow()])
        focusCell(i + 1, tag === 'SELECT' ? colIndex : colIndex)
      } else {
        focusCell(i + 1, colIndex)
      }
      return
    }
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault()
      moveRow(i, -1)
      return
    }
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault()
      moveRow(i, 1)
      return
    }
    if (mod && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      duplicateRow(i)
      return
    }
    if (mod && e.key === 'Backspace') {
      e.preventDefault()
      removeRow(i)
      focusCell(Math.max(0, i - 1), colIndex)
    }
  }

  const cellBase =
    'flex min-h-[38px] items-center border-b border-slate-100 px-1 dark:border-slate-800'
  const inputBase =
    'w-full rounded-sm border-0 bg-transparent px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-teal-500/60 dark:text-slate-100'

  return (
    <div>
      <div
        ref={containerRef}
        className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="grid min-w-fit" style={{ gridTemplateColumns: template }}>
          {/* header */}
          {!readOnly && <div className="border-b border-slate-200 dark:border-slate-800" />}
          {columns.map((c) => (
            <div
              key={c.key}
              className={cn(
                'border-b border-slate-200 px-2.5 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400',
                c.align === 'right' && 'text-right',
              )}
            >
              {c.label}
              {c.required && !readOnly ? <span className="text-red-500"> *</span> : null}
            </div>
          ))}

          {/* rows */}
          {rows.map((row, i) => (
            <RowCells
              key={i}
              row={row}
              index={i}
              columns={columns}
              readOnly={readOnly}
              cellBase={cellBase}
              inputBase={inputBase}
              setCell={setCell}
              handleKeyDown={handleKeyDown}
              menuOpen={menuRow === i}
              setMenuOpen={(open) => setMenuRow(open ? i : null)}
              insertRow={insertRow}
              duplicateRow={duplicateRow}
              removeRow={removeRow}
              moveRow={moveRow}
              canRemove={rows.length > minRows}
            />
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        {!readOnly ? (
          <Button type="button" variant="outline" size="sm" onClick={() => insertRow(rows.length)}>
            <Plus size={14} /> {addLabel}
          </Button>
        ) : (
          <span />
        )}
        {footer}
      </div>
      {!readOnly ? (
        <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
          Enter adds/moves down · Alt+↑/↓ reorders · ⌘D duplicates · ⌘⌫ removes
        </p>
      ) : null}
    </div>
  )
}

function RowCells<Row extends Record<string, unknown>>({
  row,
  index: i,
  columns,
  readOnly,
  cellBase,
  inputBase,
  setCell,
  handleKeyDown,
  menuOpen,
  setMenuOpen,
  insertRow,
  duplicateRow,
  removeRow,
  moveRow,
  canRemove,
}: {
  row: Row
  index: number
  columns: LineGridColumn<Row>[]
  readOnly: boolean
  cellBase: string
  inputBase: string
  setCell: (i: number, key: string, value: unknown) => void
  handleKeyDown: (e: React.KeyboardEvent, i: number, col: number) => void
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  insertRow: (at: number) => void
  duplicateRow: (i: number) => void
  removeRow: (i: number) => void
  moveRow: (i: number, delta: number) => void
  canRemove: boolean
}) {
  return (
    <>
      {!readOnly ? (
        <div className={cn(cellBase, 'justify-center px-0')}>
          <Popover
            open={menuOpen}
            onOpenChange={setMenuOpen}
            align="start"
            className="w-44"
            trigger={
              <button
                type="button"
                aria-label={`Line ${i + 1} actions`}
                onClick={() => setMenuOpen(!menuOpen)}
                className="group flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-slate-100 hover:text-slate-500 dark:hover:bg-slate-800"
              >
                <span className="text-[11px] tabular-nums group-hover:hidden">{i + 1}</span>
                <GripVertical size={13} className="hidden group-hover:block" />
              </button>
            }
          >
            <div className="py-1 text-sm">
              {[
                { label: 'Insert above', icon: ArrowUp, fn: () => insertRow(i) },
                { label: 'Insert below', icon: ArrowDown, fn: () => insertRow(i + 1) },
                { label: 'Duplicate', icon: Copy, fn: () => duplicateRow(i) },
              ].map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60"
                  onClick={() => {
                    a.fn()
                    setMenuOpen(false)
                  }}
                >
                  <a.icon size={14} className="text-slate-400" /> {a.label}
                </button>
              ))}
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                onClick={() => {
                  removeRow(i)
                  setMenuOpen(false)
                }}
              >
                <Trash2 size={14} /> {canRemove ? 'Remove line' : 'Clear line'}
              </button>
            </div>
          </Popover>
        </div>
      ) : null}

      {columns.map((c, colIndex) => {
        const value = row[c.key]
        if (readOnly || c.type === 'readonly') {
          return (
            <div
              key={c.key}
              className={cn(cellBase, 'px-2.5 text-sm', c.align === 'right' && 'justify-end tabular-nums')}
            >
              {c.render ? c.render(row, i) : ((value as string) ?? '')}
            </div>
          )
        }
        return (
          <div
            key={c.key}
            data-lg-row={i}
            data-lg-col={colIndex}
            className={cellBase}
            onKeyDown={(e) => handleKeyDown(e, i, colIndex)}
          >
            {c.type === 'search-select' ? (
              <SearchSelect
                options={c.options ?? []}
                value={(value as string) ?? ''}
                onChange={(v) => setCell(i, c.key, v ?? '')}
                placeholder={c.placeholder ?? '—'}
                className="w-full border-0 bg-transparent shadow-none"
              />
            ) : c.type === 'select' ? (
              <Select
                value={(value as string) ?? ''}
                onChange={(e) => setCell(i, c.key, e.target.value)}
                className="w-full border-0 bg-transparent shadow-none"
              >
                {(c.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : c.type === 'amount' ? (
              <input
                inputMode="decimal"
                value={(value as string) ?? ''}
                placeholder={c.placeholder ?? '0.00'}
                aria-invalid={
                  value !== '' && value != null && Number.isNaN(Number(value)) ? true : undefined
                }
                onChange={(e) => setCell(i, c.key, e.target.value)}
                onBlur={(e) => setCell(i, c.key, normalizeAmount(e.target.value))}
                className={cn(
                  inputBase,
                  'text-right tabular-nums',
                  value !== '' && value != null && Number.isNaN(Number(value)) &&
                    'text-red-600 focus:ring-red-500/60 dark:text-red-400',
                )}
              />
            ) : (
              <input
                value={(value as string) ?? ''}
                placeholder={c.placeholder}
                onChange={(e) => setCell(i, c.key, e.target.value)}
                className={inputBase}
              />
            )}
          </div>
        )
      })}
    </>
  )
}
