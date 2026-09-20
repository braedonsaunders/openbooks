'use client'

/**
 * LineGrid — the transaction line editor used by every document type
 * (vendor bills, invoices, journals, expense reports). source platform-grade grid
 * behavior, openbooks polish:
 *
 *  - spreadsheet keyboard model: Enter commits + moves down (appending a row
 *    at the bottom), Alt+↑/↓ moves the row, ⌘/Ctrl+D duplicates it,
 *    ⌘/Ctrl+Backspace deletes it, Tab walks cells naturally
 *  - per-row grip menu: insert above/below, duplicate, remove
 *  - amount cells retain ledger scale; decimal cells preserve commercial
 *    precision while hiding insignificant storage-scale zeroes
 *  - column model is data: text / amount / decimal / select / search-select / readonly
 *    — custom-field columns are just more columns
 *  - controlled component: rows in, rows out; parent owns persistence
 *    (autosave) and computed values (tax, totals) via readonly columns
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, GripVertical, Lock, LockOpen, Plus, RotateCcw, Split, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Badge, Button, ContextMenu, FieldLabel, Popover, SearchSelect, Select, cn, useContextMenu, type ContextMenuEntry } from '@openbooks/ui'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import {
  displayLineDecimal,
  invalidLineDecimal,
  normalizeLineDecimal,
} from '../lib/line-grid-decimal'
import type { DistributionMenuKey, GroupHeaderModel, RowDistributionChip } from './allocations/distribution-groups'

export interface LineGridOption {
  value: string
  label: string
}

export interface LineGridColumn<Row extends Record<string, unknown>> {
  key: string
  label: string
  /** Optional explanation shown from the column heading. */
  help?: React.ReactNode
  /** CSS grid track, e.g. 'minmax(180px,2fr)' or '110px'. */
  width: string
  type: 'text' | 'amount' | 'decimal' | 'select' | 'search-select' | 'readonly' | 'tax'
  /** Maximum exact scale for non-money decimal cells such as quantity/rate. */
  decimalScale?: number
  align?: 'left' | 'right'
  options?: LineGridOption[]
  placeholder?: string
  required?: boolean
  /**
   * Per-row edit gate for editable cells (line warehouse pickers): when
   * present and false for a row, the cell renders empty instead of a
   * control, so a picker never appears on a line it does not apply to
   * (e.g. a non-stocked item). Read-only grids and readonly columns are
   * unaffected. Defaults to editable.
   */
  isCellEditable?: (row: Row, index: number) => boolean
  /** Renderer for readonly columns (computed cells, e.g. line tax). */
  render?: (row: Row, index: number) => React.ReactNode
  /**
   * For `type: 'tax'` columns: the tax the engine computes from the code's
   * rate. When the user edits the cell to anything other than this value, the
   * line is flagged overridden; a reset affordance clears the override and
   * falls back to this computed value.
   */
  computeTax?: (row: Row) => string
  /**
   * For `type: 'tax'` columns: apply a manual override to a line — set the
   * explicit tax amount and the overridden flag. `overridden: false` clears the
   * override (reset to computed).
   */
  onTaxChange?: (index: number, next: { taxAmount: string; overridden: boolean }) => void
}

function normalizeAmount(v: string): string {
  if (v.trim() === '') return v
  try { return normalizeMoney(v) } catch { return v }
}

function invalidAmount(value: unknown): boolean {
  if (value === '' || value == null) return false
  try { normalizeMoney(String(value)); return false } catch { return true }
}

function DecimalCell({
  value,
  scale,
  inputBase,
  onChange,
}: {
  value: unknown
  scale: number
  inputBase: string
  onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? displayLineDecimal(value, scale)
  const invalid = invalidLineDecimal(shown, scale)

  return (
    <input
      inputMode="decimal"
      value={shown}
      placeholder="0"
      aria-invalid={invalid || undefined}
      onFocus={() => setDraft(displayLineDecimal(value, scale))}
      onChange={(event) => {
        setDraft(event.target.value)
        onChange(event.target.value)
      }}
      onBlur={(event) => {
        const normalized = normalizeLineDecimal(event.target.value, scale)
        setDraft(null)
        onChange(normalized ?? event.target.value)
      }}
      className={cn(
        inputBase,
        'text-right tabular-nums',
        invalid && 'text-red-600 focus:ring-red-500/60 dark:text-red-400',
      )}
    />
  )
}

/**
 * Entry-mode distribution affordances for one grid (shard A9). The grid owns
 * pixels only: group headers, the per-row distribution cell (applied-rule /
 * staged / suggest / Split…), and the Split… ContextMenu. The owning drawer
 * supplies the data closures, which it builds on
 * `./allocations/distribution-groups`. Absent (or read-only) means today's
 * grid exactly — children stay real lines and the read-only view is
 * untouched.
 */
export interface LineGridDistribution<Row extends Record<string, unknown>> {
  /** Synthetic group headers in grid order (firstIndex points at rows). */
  groups: GroupHeaderModel[]
  /** Row indexes whose cells indent under a group header. */
  groupedIndexes: Set<number>
  chipOf: (row: Row, index: number) => RowDistributionChip | null
  menuKeysOf: (row: Row, index: number) => DistributionMenuKey[]
  /** Group key for a grouped row (null for standalone rows). */
  groupKeyOf: (row: Row, index: number) => string | null
  onSplit: (index: number) => void
  onUnsplit: (groupKey: string) => void
  onToggleLock: (groupKey: string) => void
  onApplySuggestion: (index: number) => void
  onEditGroupTotal: (groupKey: string, total: string) => void
}

export function LineGrid<Row extends Record<string, unknown>>({
  columns,
  rows,
  onRowsChange,
  emptyRow,
  readOnly = false,
  minRows = 1,
  footer,
  addLabel,
  formatAmount,
  distribution,
}: {
  columns: LineGridColumn<Row>[]
  rows: Row[]
  onRowsChange: (rows: Row[]) => void
  emptyRow: () => Row
  readOnly?: boolean
  minRows?: number
  footer?: React.ReactNode
  addLabel?: string
  /**
   * Currency-aware read-only presentation supplied by the owning transaction.
   * Editable cells intentionally retain the exact ledger string.
   */
  formatAmount?: (value: string) => React.ReactNode
  distribution?: LineGridDistribution<Row>
}) {
  const t = useTranslations('ui.lineGrid')
  const tEntry = useTranslations('allocations')
  const containerRef = useRef<HTMLDivElement>(null)
  const [menuRow, setMenuRow] = useState<number | null>(null)
  const distMenu = useContextMenu()
  const [distTarget, setDistTarget] = useState<number | null>(null)

  // The distribution column and group headers are edit-mode UX only: the
  // read-only document view and the PDF data shape stay exactly as today.
  const showDist = distribution !== undefined && !readOnly

  const template = readOnly
    ? columns.map((c) => c.width).join(' ')
    : `34px ${columns.map((c) => c.width).join(' ')}${showDist ? ' 150px' : ''}`

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

  const headersByIndex = useMemo(() => {
    const map = new Map<number, GroupHeaderModel>()
    if (showDist) {
      for (const group of distribution?.groups ?? []) {
        if (group.firstIndex >= 0 && group.firstIndex < rows.length && !map.has(group.firstIndex)) {
          map.set(group.firstIndex, group)
        }
      }
    }
    return map
  }, [showDist, distribution, rows.length])

  const openDistMenu = useCallback(
    (e: React.MouseEvent, index: number) => {
      setDistTarget(index)
      distMenu.onContextMenu(e)
    },
    [distMenu],
  )

  const distMenuItems: ContextMenuEntry[] = useMemo(() => {
    if (!showDist || !distribution || distTarget === null) return []
    const row = rows[distTarget]
    if (!row) return []
    const chip = distribution.chipOf(row, distTarget)
    const suggestName = chip?.kind === 'suggest' ? chip.ruleName : null
    const groupKey = distribution.groupKeyOf(row, distTarget)
    return distribution.menuKeysOf(row, distTarget).map((key) => {
      if (key === 'split') {
        return { key, label: tEntry('entry.split'), icon: Split, onSelect: () => distribution.onSplit(distTarget) }
      }
      if (key === 'unsplit' && groupKey !== null) {
        return { key, label: tEntry('entry.unSplit'), onSelect: () => distribution.onUnsplit(groupKey) }
      }
      if (key === 'lock' && groupKey !== null) {
        return {
          key,
          label: tEntry('entry.lockGroup'),
          icon: Lock,
          onSelect: () => distribution.onToggleLock(groupKey),
        }
      }
      if (key === 'unlock' && groupKey !== null) {
        return {
          key,
          label: tEntry('entry.unlockGroup'),
          icon: LockOpen,
          onSelect: () => distribution.onToggleLock(groupKey),
        }
      }
      return {
        key,
        label: suggestName !== null ? tEntry('entry.suggestSplit', { rule: suggestName }) : tEntry('entry.split'),
        icon: Split,
        onSelect: () => distribution.onApplySuggestion(distTarget),
      }
    })
  }, [showDist, distribution, distTarget, rows, tEntry])

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
              <FieldLabel
                help={c.help}
                fieldName={c.label}
                className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400"
              >
                {c.label}
                {c.required && !readOnly ? <span className="text-red-500"> *</span> : null}
              </FieldLabel>
            </div>
          ))}
          {showDist ? (
            <div className="border-b border-slate-200 px-2.5 py-2 text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
              {tEntry('entry.distributionColumn')}
            </div>
          ) : null}

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
              formatAmount={formatAmount}
              groupHeader={showDist ? (headersByIndex.get(i) ?? null) : null}
              indented={showDist && (distribution?.groupedIndexes.has(i) ?? false)}
              dist={
                showDist && distribution
                  ? {
                      chip: distribution.chipOf(row, i),
                      onSplitBelow: (anchor) => {
                        setDistTarget(i)
                        distMenu.openBelow(anchor)
                      },
                      onApplySuggestion: () => distribution.onApplySuggestion(i),
                    }
                  : null
              }
              onCellContextMenu={
                showDist && distribution && distribution.menuKeysOf(row, i).length > 0
                  ? (e) => openDistMenu(e, i)
                  : undefined
              }
              onEditGroupTotal={showDist && distribution ? distribution.onEditGroupTotal : undefined}
              onToggleGroupLock={showDist && distribution ? distribution.onToggleLock : undefined}
              onUnsplitGroup={showDist && distribution ? distribution.onUnsplit : undefined}
            />
          ))}
        </div>
      </div>
      <ContextMenu open={distMenu.open} position={distMenu.position} items={distMenuItems} onClose={distMenu.close} />

      <div className="mt-2 flex items-center justify-between gap-3">
        {!readOnly ? (
          <Button type="button" variant="outline" size="sm" onClick={() => insertRow(rows.length)}>
            <Plus size={14} /> {addLabel ?? t('addLine')}
          </Button>
        ) : (
          <span />
        )}
        {footer}
      </div>
      {!readOnly ? (
        <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">
          {t('keyboardHint')}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Editable per-line tax cell. Displays the engine-computed tax from the code's
 * rate until the user types a different value — then the line is flagged
 * overridden and the typed value is kept verbatim. An amber dot + a reset button
 * make the override transparent; reset clears the flag and recomputes.
 */
function TaxCell<Row extends Record<string, unknown>>({
  row,
  column,
  index,
  inputBase,
}: {
  row: Row
  column: LineGridColumn<Row>
  index: number
  inputBase: string
}) {
  const t = useTranslations('ui.lineGrid.tax')
  const overridden = row.taxOverridden === true
  const computed = column.computeTax?.(row) ?? '0.0000'
  // While overridden, show the explicit amount; otherwise mirror the computed
  // value so the cell always reflects what will post.
  const [draft, setDraft] = useState<string | null>(null)
  const shown =
    draft != null ? draft : overridden ? String(row.taxAmount ?? '') : cmp(computed, '0') !== 0 ? computed : ''

  const commit = (raw: string) => {
    setDraft(null)
    let normalized: string
    try { normalized = normalizeMoney(raw) } catch { normalized = '' }
    if (raw.trim() === '' || normalized === '') {
      // Empty / invalid → treat as "reset to computed".
      column.onTaxChange?.(index, { taxAmount: computed, overridden: false })
      return
    }
    // Only an actual divergence from the computed value flags an override.
    const isOverride = cmp(normalized, computed) !== 0
    column.onTaxChange?.(index, { taxAmount: normalized, overridden: isOverride })
  }

  return (
    <div className="flex w-full items-center gap-1">
      {overridden ? (
        <span
          aria-label={t('overriddenAria')}
          title={t('overriddenTitle')}
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
        />
      ) : null}
      <input
        inputMode="decimal"
        value={shown}
        placeholder="0.00"
        aria-invalid={invalidAmount(shown) || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        title={
          overridden ? t('computedOverriddenTitle', { amount: computed }) : undefined
        }
        className={cn(
          inputBase,
          'text-right tabular-nums',
          overridden && 'font-medium text-amber-700 dark:text-amber-400',
          invalidAmount(shown) &&
            'text-red-600 focus:ring-red-500/60 dark:text-red-400',
        )}
      />
      {overridden ? (
        <button
          type="button"
          aria-label={t('resetAria')}
          title={t('resetTitle', { amount: computed })}
          onClick={() => {
            setDraft(null)
            column.onTaxChange?.(index, { taxAmount: computed, overridden: false })
          }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
        >
          <RotateCcw size={12} />
        </button>
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
  canRemove,
  formatAmount,
  groupHeader,
  indented,
  dist,
  onCellContextMenu,
  onEditGroupTotal,
  onToggleGroupLock,
  onUnsplitGroup,
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
  formatAmount?: (value: string) => React.ReactNode
  groupHeader: GroupHeaderModel | null
  indented: boolean
  dist: {
    chip: RowDistributionChip | null
    onSplitBelow: (anchor: HTMLElement) => void
    onApplySuggestion: () => void
  } | null
  onCellContextMenu?: (e: React.MouseEvent) => void
  onEditGroupTotal?: (groupKey: string, total: string) => void
  onToggleGroupLock?: (groupKey: string) => void
  onUnsplitGroup?: (groupKey: string) => void
}) {
  const t = useTranslations('ui.lineGrid')
  const tCommon = useTranslations('common')
  return (
    <>
      {groupHeader ? (
        <DistributionGroupHeader
          group={groupHeader}
          onEditTotal={onEditGroupTotal}
          onToggleLock={onToggleGroupLock}
          onUnsplit={onUnsplitGroup}
        />
      ) : null}
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
                aria-label={t('lineActionsAria', { number: i + 1 })}
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
                { label: t('insertAbove'), icon: ArrowUp, fn: () => insertRow(i) },
                { label: t('insertBelow'), icon: ArrowDown, fn: () => insertRow(i + 1) },
                { label: tCommon('actions.duplicate'), icon: Copy, fn: () => duplicateRow(i) },
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
                <Trash2 size={14} /> {canRemove ? t('removeLine') : t('clearLine')}
              </button>
            </div>
          </Popover>
        </div>
      ) : null}

      {columns.map((c, colIndex) => {
        const value = row[c.key]
        if (readOnly || c.type === 'readonly') {
          // Resolve select/search-select values to their human label — never
          // render a raw id/uuid in a read-only cell.
          let display: React.ReactNode
          if (c.type === 'tax') {
            const overridden = row.taxOverridden === true
            const shown = overridden ? String(row.taxAmount ?? '0.0000') : (c.computeTax?.(row) ?? '0.0000')
            display = (
              <span className="inline-flex items-center gap-1.5">
                {overridden ? (
                  <span
                    aria-label={t('tax.overriddenAria')}
                    title={t('tax.overriddenShortTitle')}
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                  />
                ) : null}
                {cmp(shown, '0') !== 0 ? (formatAmount?.(shown) ?? shown) : ''}
              </span>
            )
          } else if (c.render) display = c.render(row, i)
          else if ((c.type === 'select' || c.type === 'search-select') && value)
            display = c.options?.find((o) => o.value === value)?.label ?? ''
          else if (c.type === 'decimal')
            display = displayLineDecimal(value, c.decimalScale ?? 8)
          else if (c.type === 'amount')
            display = value == null || value === '' ? '' : (formatAmount?.(String(value)) ?? String(value))
          else display = (value as string) ?? ''
          return (
            <div
              key={c.key}
              className={cn(cellBase, 'px-2.5 text-sm', c.align === 'right' && 'justify-end tabular-nums')}
            >
              {display}
            </div>
          )
        }
        // A row the column does not apply to keeps an empty cell — never a
        // control with one meaningless choice, and never a stale label.
        if (c.isCellEditable && !c.isCellEditable(row, i)) {
          return <div key={c.key} className={cn(cellBase, 'px-2.5 text-sm')} />
        }
        return (
          <div
            key={c.key}
            data-lg-row={i}
            data-lg-col={colIndex}
            className={cn(cellBase, indented && colIndex === 0 && 'pl-6')}
            onKeyDown={(e) => handleKeyDown(e, i, colIndex)}
            onContextMenu={onCellContextMenu}
          >
            {c.type === 'search-select' ? (
              <SearchSelect
                options={c.options ?? []}
                value={(value as string) ?? ''}
                onChange={(v) => setCell(i, c.key, v ?? '')}
                placeholder={c.placeholder ?? '—'}
                className="w-full"
                triggerClassName="h-auto min-h-0 rounded-sm border-0 bg-transparent px-1.5 py-1 shadow-none focus:ring-0"
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
                  invalidAmount(value) || undefined
                }
                onChange={(e) => setCell(i, c.key, e.target.value)}
                onBlur={(e) => setCell(i, c.key, normalizeAmount(e.target.value))}
                className={cn(
                  inputBase,
                  'text-right tabular-nums',
                  invalidAmount(value) &&
                    'text-red-600 focus:ring-red-500/60 dark:text-red-400',
                )}
              />
            ) : c.type === 'decimal' ? (
              <DecimalCell
                value={value}
                scale={c.decimalScale ?? 8}
                inputBase={inputBase}
                onChange={(next) => setCell(i, c.key, next)}
              />
            ) : c.type === 'tax' ? (
              <TaxCell
                row={row}
                column={c}
                index={i}
                inputBase={inputBase}
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
      {dist ? (
        <div className={cn(cellBase, 'px-1.5')} onContextMenu={onCellContextMenu}>
          <DistributionCell
            chip={dist.chip}
            rowNumber={i + 1}
            onSplitBelow={dist.onSplitBelow}
            onApplySuggestion={dist.onApplySuggestion}
          />
        </div>
      ) : null}
    </>
  )
}

/**
 * One row's distribution affordance: the applied-rule chip for a group
 * child, the staged-rule chip for a line carrying a distributionKey the
 * server has not exploded yet, the "Split by <rule>?" suggest chip, or the
 * plain Split… entry point.
 */
function DistributionCell({
  chip,
  rowNumber,
  onSplitBelow,
  onApplySuggestion,
}: {
  chip: RowDistributionChip | null
  rowNumber: number
  onSplitBelow: (anchor: HTMLElement) => void
  onApplySuggestion: () => void
}) {
  const t = useTranslations('allocations')
  if (chip === null) return <span />
  if (chip.kind === 'rule') {
    return (
      <Badge
        variant="secondary"
        className="max-w-full gap-1 px-2 py-0.5 text-[11px] font-medium"
        title={chip.locked ? t('entry.groupLockedHint') : undefined}
      >
        {chip.locked ? <Lock size={11} className="shrink-0" /> : <Split size={11} className="shrink-0" />}
        <span className="truncate">{chip.ruleName}</span>
      </Badge>
    )
  }
  if (chip.kind === 'pending') {
    return (
      <Badge
        variant="outline"
        className="max-w-full gap-1 border-dashed px-2 py-0.5 text-[11px] font-medium"
        title={t('entry.pendingRule', { rule: chip.ruleName })}
      >
        <Split size={11} className="shrink-0" />
        <span className="truncate">{chip.ruleName}</span>
      </Badge>
    )
  }
  if (chip.kind === 'suggest') {
    return (
      <button
        type="button"
        onClick={onApplySuggestion}
        title={t('entry.suggestSplit', { rule: chip.ruleName })}
        aria-label={t('entry.groupActionsAria', { number: rowNumber })}
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-teal-200/70 bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-800 hover:bg-teal-100 dark:border-teal-800/60 dark:bg-teal-950/50 dark:text-teal-300 dark:hover:bg-teal-950"
      >
        <Split size={11} className="shrink-0" />
        <span className="truncate">{t('entry.suggestSplit', { rule: chip.ruleName })}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => onSplitBelow(e.currentTarget)}
      aria-label={t('entry.groupActionsAria', { number: rowNumber })}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
    >
      <Split size={12} /> {t('entry.split')}
    </button>
  )
}

/**
 * The synthetic header row above one distribution group's children: the
 * applied rule, the editable group total (re-explodes unless locked), the
 * lock toggle, and Un-split.
 */
function DistributionGroupHeader({
  group,
  onEditTotal,
  onToggleLock,
  onUnsplit,
}: {
  group: GroupHeaderModel
  onEditTotal?: (groupKey: string, total: string) => void
  onToggleLock?: (groupKey: string) => void
  onUnsplit?: (groupKey: string) => void
}) {
  const t = useTranslations('allocations')
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? group.total
  const invalid = invalidAmount(shown)

  const commit = () => {
    const raw = shown.trim()
    setDraft(null)
    if (raw === '') return
    try {
      const normalized = normalizeMoney(raw)
      if (cmp(normalized, group.total) !== 0) onEditTotal?.(group.key, normalized)
    } catch {
      // Malformed totals stay in the cell until fixed; the save boundary
      // rejects them exactly like a malformed line amount.
    }
  }

  return (
    <div
      style={{ gridColumn: '1 / -1' }}
      className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-800/40"
    >
      <Split size={12} className="shrink-0 text-slate-400" />
      {group.ruleName ? (
        <span className="truncate text-xs font-semibold text-slate-600 dark:text-slate-300">{group.ruleName}</span>
      ) : null}
      <span className="ml-auto shrink-0 text-[11px] text-slate-400">{t('entry.groupTotalLabel')}</span>
      <input
        inputMode="decimal"
        value={shown}
        disabled={group.locked}
        aria-label={t('entry.groupTotalAria')}
        aria-invalid={invalid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className={cn(
          'w-28 rounded-sm border border-slate-200 bg-white px-1.5 py-0.5 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-teal-500/60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
          invalid && 'text-red-600 focus:ring-red-500/60 dark:text-red-400',
          group.locked && 'opacity-60',
        )}
      />
      <button
        type="button"
        aria-label={group.locked ? t('entry.unlockGroup') : t('entry.lockGroup')}
        title={group.locked ? t('entry.unlockGroup') : t('entry.lockGroup')}
        onClick={() => onToggleLock?.(group.key)}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-300"
      >
        {group.locked ? <LockOpen size={13} /> : <Lock size={13} />}
      </button>
      <button
        type="button"
        onClick={() => onUnsplit?.(group.key)}
        className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-slate-500 hover:bg-slate-200/70 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200"
      >
        {t('entry.unSplit')}
      </button>
    </div>
  )
}
