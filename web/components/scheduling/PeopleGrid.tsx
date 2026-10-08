'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ClipboardPaste, Copy, Eraser, Pencil, Scissors, SquareSplitHorizontal, Trash2 } from 'lucide-react'
import { ContextMenu, cn, useContextMenu, type ContextMenuEntry } from '@openbooks/ui'
import { AbsenceChip, BookingChip } from './BookingChip'
import { SourceRecordChip } from './SourceRecord'
import { bookingLegendKey, filterBoardRows, sourceLegendKey } from './legend'
import type { BoardSourceRecord } from '@openbooks/engine/src/schedule-boards/source-history.ts'
import { TargetPicker, type PickedTarget } from './TargetPicker'
import { searchTargets } from './api'
import {
  cellKey, clampCell, dayTotals, entryTemplate, formatMinutes, groupRows, indexAbsences, indexEntries, initials,
  rectCells, selectionRect, targetHue, tilePattern, type BoardChange, type BoardEntry, type BoardRow, type CellAddress,
  type ClipCell, type GroupBy, type Rect, type Selection, type SpanInput,
} from './model'
import type { BoardController } from './use-board'
import type { BoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'

const NAME_W = 232
const TOTAL_W = 64
const HEADER_H = 56
const GROUP_H = 28
const FOOTER_H = 40
const OVERSCAN = 8

export interface GridProps {
  readonly controller: BoardController
  readonly window: BoardWindow
  readonly groupBy: GroupBy
  readonly search: string
  readonly compact: boolean
  readonly spotlight: string | null
  readonly onOpenEntry: (entry: BoardEntry) => void
  readonly onOpenSourceRecord: (record: BoardSourceRecord) => void
  readonly today: string
}

type Clip = { block: ClipCell[][]; text: string }

const newId = () => crypto.randomUUID()
const targetKey = (entry: BoardEntry) => bookingLegendKey(entry) ?? 'none'

export function PeopleGrid({ controller, window: board, groupBy, search, compact, spotlight, onOpenEntry, onOpenSourceRecord, today }: GridProps) {
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const menu = useContextMenu()
  const rowH = compact ? 34 : 46
  const footerH = board.board.showTotals ? FOOTER_H : 0
  const days = useMemo(() => board.days.filter((day) => board.board.showWeekends || !day.isWeekend), [board.days, board.board.showWeekends])
  const dates = useMemo(() => days.map((day) => day.date), [days])
  const index = useMemo(() => indexEntries(board.entries), [board.entries])
  const sourceIndex = useMemo(() => {
    const out = new Map<string, BoardSourceRecord[]>()
    for (const record of board.sourceRecords ?? []) {
      const key = cellKey(record.workerPartyId, record.onDate)
      const rows = out.get(key) ?? []; rows.push(record); out.set(key, rows)
    }
    return out
  }, [board.sourceRecords])
  const absences = useMemo(() => indexAbsences(board.absences), [board.absences])
  const replaced = useMemo(() => new Set(board.replaced), [board.replaced])

  const people = useMemo(() => filterBoardRows(board, search, spotlight), [board, search, spotlight])
  const { items, persons } = useMemo(() => groupRows(people, groupBy, t('grid.ungrouped')), [groupBy, people, t])
  const offsets = useMemo(() => {
    const tops: number[] = []
    const personTop = new Map<number, number>()
    let y = 0
    for (const item of items) {
      tops.push(y)
      if (item.kind === 'person') personTop.set(item.personIndex!, y)
      y += item.kind === 'group' ? GROUP_H : rowH
    }
    return { tops, personTop, height: y }
  }, [items, rowH])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 1200, height: 600, scrollTop: 0 })
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = () => setViewport((current) => ({ ...current, width: element.clientWidth, height: element.clientHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const dayW = Math.max(compact ? 74 : 92, Math.floor((viewport.width - NAME_W - TOTAL_W) / Math.max(1, dates.length)))
  const contentW = NAME_W + dayW * dates.length + TOTAL_W

  const firstVisible = Math.max(0, offsets.tops.findIndex((top, i) => top + (items[i]?.kind === 'group' ? GROUP_H : rowH) >= viewport.scrollTop - HEADER_H) - OVERSCAN)
  let lastVisible = firstVisible
  while (lastVisible < items.length && offsets.tops[lastVisible]! < viewport.scrollTop + viewport.height + rowH * OVERSCAN) lastVisible++

  const [selection, setSelection] = useState<Selection | null>(null)
  const [editing, setEditing] = useState<{ text: string; replaceExisting: boolean } | null>(null)
  const [fillTo, setFillTo] = useState<CellAddress | null>(null)
  const dragMode = useRef<'select' | 'fill' | null>(null)
  const clip = useRef<Clip | null>(null)
  const [hoverTarget, setHoverTarget] = useState<string | null>(null)
  const activeSpotlight = spotlight ?? hoverTarget
  const canManage = board.canManage
  const rect = selection ? selectionRect(selection) : null
  const cols = dates.length
  const rows = persons.length

  // Reset the selection when the shown cells change underneath it.
  useEffect(() => {
    setSelection((current) => (current && (current.focus.row >= rows || current.focus.col >= cols) ? null : current))
  }, [rows, cols])

  const totals = useMemo(() => dayTotals(dates, persons, index, replaced), [dates, index, persons, replaced])
  const personMinutes = useMemo(() => {
    const out = new Map<string, number>()
    const shown = new Set(dates)
    for (const entry of board.entries) {
      if (!shown.has(entry.startsOn) || replaced.has(entry.id) || entry.target?.counts === false) continue
      out.set(entry.subjectId, (out.get(entry.subjectId) ?? 0) + entry.workedMinutes)
    }
    return out
  }, [board.entries, dates, replaced])

  const editableIn = useCallback((cell: CellAddress): BoardEntry[] => {
    const person = persons[cell.row]
    const date = dates[cell.col]
    if (!person || !date) return []
    return (index.get(cellKey(person.subjectId, date)) ?? []).filter((entry) => entry.boardId === board.board.id && entry.startsOn === date && !replaced.has(entry.id))
  }, [board.board.id, dates, index, persons, replaced])

  const hasLeave = useCallback((cell: CellAddress) => {
    const person = persons[cell.row]
    const date = dates[cell.col]
    return Boolean(person && date && (absences.get(cellKey(person.subjectId, date)) ?? []).length)
  }, [absences, dates, persons])

  const defaultSpan = useCallback((): SpanInput => board.board.grain === 'day' || !board.board.dayPolicyKnown
    ? { mode: 'day' }
    : { mode: 'timed', starts: board.board.dayStarts, ends: board.board.dayEnds, breakMinutes: board.board.dayBreakMinutes }, [board.board])

  // ---------------------------------------------------------------- writes
  const writeCells = useCallback(async (writes: { cell: CellAddress; content: ClipCell; replace: boolean }[], label: string) => {
    const changes: BoardChange[] = []
    let skipped = 0
    const series = new Map<number, string>()
    for (const { cell, content, replace } of writes) {
      const person = persons[cell.row]
      const date = dates[cell.col]
      if (!person || !date) continue
      const existing = editableIn(cell)
      if (content.length && hasLeave(cell)) {
        skipped++
        continue
      }
      if (replace && existing.length === 1 && content.length === 1) {
        const fields = content[0]!
        changes.push({ op: 'update', id: existing[0]!.id, expectedRevision: existing[0]!.revision, fields: { target: fields.target, projectTaskId: fields.projectTaskId ?? null, detail: fields.detail ?? null, span: fields.span } })
        continue
      }
      if (replace) for (const entry of existing) changes.push({ op: 'cancel', id: entry.id, expectedRevision: entry.revision })
      for (const fields of content) {
        // Consecutive days booked for one person in one gesture form a run.
        const seriesId = writes.length > 1 ? (series.get(cell.row) ?? (series.set(cell.row, newId()), series.get(cell.row)!)) : null
        changes.push({ op: 'create', id: newId(), ...fields, subject: { kind: person.subjectKind, id: person.subjectId }, onDate: date, seriesId })
      }
    }
    if (skipped) controller.notify('error', t('notices.skippedLeave', { count: skipped }), t('notices.skippedLeaveRemedy'))
    await controller.run(changes, label)
  }, [controller, dates, editableIn, hasLeave, persons, t])

  const commitPicked = useCallback(async (picked: PickedTarget) => {
    if (!rect) return
    setEditing(null)
    const span = picked.span ?? defaultSpan()
    const content: ClipCell = [{ target: { kind: picked.target.kind, id: picked.target.id }, projectTaskId: null, detail: picked.detail, notes: null, span }]
    await writeCells(rectCells(rect).map((cell) => ({ cell, content, replace: true })), t('history.book', { target: picked.target.code ?? picked.target.label }))
    scrollRef.current?.focus()
  }, [defaultSpan, rect, t, writeCells])

  const clearSelection = useCallback(async () => {
    if (!rect) return
    const changes: BoardChange[] = []
    for (const cell of rectCells(rect)) for (const entry of editableIn(cell)) changes.push({ op: 'cancel', id: entry.id, expectedRevision: entry.revision })
    if (changes.length) await controller.run(changes, t('history.clear', { count: changes.length }))
  }, [controller, editableIn, rect, t])

  const blockOf = useCallback((area: Rect): ClipCell[][] => {
    const block: ClipCell[][] = []
    for (let row = area.top; row <= area.bottom; row++) {
      const line: ClipCell[] = []
      for (let col = area.left; col <= area.right; col++) {
        const person = persons[row]
        const date = dates[col]
        const entries = person && date ? (index.get(cellKey(person.subjectId, date)) ?? []).filter((entry) => entry.startsOn === date && !replaced.has(entry.id)) : []
        line.push(entries.map(entryTemplate))
      }
      block.push(line)
    }
    return block
  }, [dates, index, persons, replaced])

  const copySelection = useCallback((event?: ClipboardEvent) => {
    if (!rect) return
    const block = blockOf(rect)
    const text = block.map((line, r) => line.map((_, c) => {
      const person = persons[rect.top + r]
      const date = dates[rect.left + c]
      const entries = person && date ? (index.get(cellKey(person.subjectId, date)) ?? []).filter((entry) => entry.startsOn === date) : []
      return entries.map((entry) => `${entry.target?.code ?? entry.target?.label ?? ''}${entry.detail ? `/${entry.detail}` : ''}`).join(' + ')
    }).join('\t')).join('\n')
    clip.current = { block, text }
    if (event) {
      event.clipboardData.setData('text/plain', text)
      event.preventDefault()
    } else {
      void navigator.clipboard?.writeText(text).catch(() => undefined)
    }
    controller.notify('success', t('notices.copied', { count: rectCells(rect).length }))
  }, [blockOf, controller, dates, index, persons, rect, t])

  const pasteBlock = useCallback(async (block: ClipCell[][]) => {
    if (!rect || !block.length) return
    const writes = tilePattern(block, rect)
      .filter(({ cell }) => cell.row < rows && cell.col < cols)
      .map(({ cell, content }) => ({ cell, content, replace: true }))
    await writeCells(writes, t('history.paste', { count: writes.length }))
  }, [cols, rect, rows, t, writeCells])

  /** Paste text copied from a spreadsheet: each cell names a code or target. */
  const pasteText = useCallback(async (text: string) => {
    const lines = text.replace(/\r/g, '').split('\n').filter((line, i, all) => line.length > 0 || i < all.length - 1)
    const tokens = new Set<string>()
    const grid = lines.map((line) => line.split('\t').map((cell) => cell.trim()))
    for (const line of grid) for (const cell of line) if (cell) tokens.add(cell.split('/')[0]!.trim())
    const resolved = new Map<string, NonNullable<ClipCell[number]['target']>>()
    const unknown: string[] = []
    await Promise.all([...tokens].map(async (token) => {
      const code = board.codes.find((candidate) => candidate.code.toLowerCase() === token.toLowerCase())
      if (code) {
        resolved.set(token, { kind: 'code', id: code.id })
        return
      }
      const found = await searchTargets(board.board.id, token, t('errors.search')).catch(() => ({ targets: [] }))
      const exact = found.targets.find((target) => (target.code ?? '').toLowerCase() === token.toLowerCase())
        ?? found.targets.find((target) => target.label.toLowerCase() === token.toLowerCase())
      if (exact) resolved.set(token, { kind: exact.kind, id: exact.id })
      else unknown.push(token)
    }))
    const block: ClipCell[][] = grid.map((line) => line.map((cell) => {
      if (!cell) return []
      const [token, ...rest] = cell.split('/')
      const target = resolved.get(token!.trim())
      return target ? [{ target, projectTaskId: null, detail: rest.join('/').trim() || null, notes: null, span: defaultSpan() }] : []
    }))
    if (unknown.length) controller.notify('error', t('notices.unknownCodes', { codes: unknown.slice(0, 6).join(', '), count: unknown.length }), t('notices.unknownCodesRemedy'))
    await pasteBlock(block)
  }, [board.board.id, board.codes, controller, defaultSpan, pasteBlock, t])

  const onPaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    if (!canManage || !rect || editing) return
    const text = event.clipboardData.getData('text/plain')
    event.preventDefault()
    if (clip.current && (text === '' || text === clip.current.text)) void pasteBlock(clip.current.block)
    else if (text) void pasteText(text)
  }, [canManage, editing, pasteBlock, pasteText, rect])

  const fill = useCallback(async (direction: 'down' | 'right') => {
    if (!rect) return
    const source: Rect = direction === 'down'
      ? { top: rect.top, bottom: rect.top, left: rect.left, right: rect.right }
      : { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.left }
    const block = blockOf(source)
    const destination: Rect = direction === 'down' ? { ...rect, top: rect.top + 1 } : { ...rect, left: rect.left + 1 }
    if (destination.top > destination.bottom || destination.left > destination.right) return
    await writeCells(tilePattern(block, destination).map(({ cell, content }) => ({ cell, content, replace: true })), t('history.fill'))
  }, [blockOf, rect, t, writeCells])

  const splitDay = useCallback(async (entry: BoardEntry) => {
    const [startH, startM] = entry.startClock.split(':').map(Number)
    const [endH, endM] = entry.endClock.split(':').map(Number)
    const start = startH! * 60 + startM!
    let end = endH! * 60 + endM!
    if (end <= start) end += 1440
    const middle = start + Math.round((end - start) / 2 / 15) * 15
    const at = (minutes: number) => `${String(Math.floor((minutes % 1440) / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    const template = entryTemplate(entry)
    await controller.run([
      { op: 'update', id: entry.id, expectedRevision: entry.revision, fields: { span: { mode: 'timed', starts: at(start), ends: at(middle), breakMinutes: 0 } } },
      { op: 'create', id: newId(), ...template, subject: { kind: entry.subjectKind, id: entry.subjectId }, onDate: entry.startsOn, span: { mode: 'timed', starts: at(middle), ends: at(end), breakMinutes: 0 } },
    ], t('history.split'))
  }, [controller, t])

  // ---------------------------------------------------------------- pointer
  const cellFromPoint = useCallback((clientX: number, clientY: number): CellAddress | null => {
    const element = scrollRef.current
    if (!element) return null
    const box = element.getBoundingClientRect()
    const x = clientX - box.left + element.scrollLeft - NAME_W
    const y = clientY - box.top + element.scrollTop - HEADER_H
    if (x < 0 || y < 0) return null
    const col = Math.floor(x / dayW)
    let itemIndex = offsets.tops.findIndex((top, i) => y >= top && y < top + (items[i]!.kind === 'group' ? GROUP_H : rowH))
    if (itemIndex < 0) itemIndex = items.length - 1
    let item = items[itemIndex]
    if (item?.kind === 'group') item = items[itemIndex + 1]
    if (!item || item.kind !== 'person' || col >= cols) return null
    return { row: item.personIndex!, col }
  }, [cols, dayW, items, offsets.tops, rowH])

  const onMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-fill-handle]')) {
      dragMode.current = 'fill'
      event.preventDefault()
      return
    }
    const cell = cellFromPoint(event.clientX, event.clientY)
    if (!cell) return
    setEditing(null)
    dragMode.current = 'select'
    setSelection((current) => (event.shiftKey && current ? { anchor: current.anchor, focus: cell } : { anchor: cell, focus: cell }))
  }, [cellFromPoint])

  useEffect(() => {
    function move(event: globalThis.MouseEvent) {
      if (!dragMode.current) return
      const cell = cellFromPoint(event.clientX, event.clientY)
      if (!cell) return
      if (dragMode.current === 'select') setSelection((current) => (current ? { anchor: current.anchor, focus: cell } : current))
      else setFillTo(cell)
    }
    function up() {
      const mode = dragMode.current
      dragMode.current = null
      if (mode === 'fill' && rect && fillTo) {
        const destination: Rect = {
          top: Math.min(rect.top, fillTo.row), bottom: Math.max(rect.bottom, fillTo.row),
          left: Math.min(rect.left, fillTo.col), right: Math.max(rect.right, fillTo.col),
        }
        const block = blockOf(rect)
        const writes = tilePattern(block, destination)
          .filter(({ cell }) => cell.row < rect.top || cell.row > rect.bottom || cell.col < rect.left || cell.col > rect.right)
          .map(({ cell, content }) => ({ cell, content, replace: true }))
        setSelection({ anchor: { row: destination.top, col: destination.left }, focus: { row: destination.bottom, col: destination.right } })
        if (writes.length) void writeCells(writes, t('history.fill'))
      }
      setFillTo(null)
    }
    globalThis.addEventListener('mousemove', move)
    globalThis.addEventListener('mouseup', up)
    return () => {
      globalThis.removeEventListener('mousemove', move)
      globalThis.removeEventListener('mouseup', up)
    }
  }, [blockOf, cellFromPoint, fillTo, rect, t, writeCells])

  const onDragStartChip = useCallback((event: DragEvent<HTMLDivElement>, entry: BoardEntry) => {
    dragMode.current = null
    event.dataTransfer.setData('application/x-openbooks-booking', entry.id)
    event.dataTransfer.effectAllowed = 'copyMove'
  }, [])

  const onDrop = useCallback(async (event: DragEvent<HTMLDivElement>) => {
    const id = event.dataTransfer.getData('application/x-openbooks-booking')
    if (!id || !canManage) return
    event.preventDefault()
    const entry = controller.entriesById.get(id)
    const cell = cellFromPoint(event.clientX, event.clientY)
    if (!entry || !cell) return
    const person = persons[cell.row]!
    const date = dates[cell.col]!
    if (person.subjectId === entry.subjectId && date === entry.startsOn) return
    setSelection({ anchor: cell, focus: cell })
    if (event.altKey || event.ctrlKey || event.metaKey) {
      await controller.run([{ op: 'create', id: newId(), ...entryTemplate(entry), subject: { kind: person.subjectKind, id: person.subjectId }, onDate: date }], t('history.copy'))
    } else {
      await controller.run([{ op: 'update', id: entry.id, expectedRevision: entry.revision, fields: { subject: { kind: person.subjectKind, id: person.subjectId }, onDate: date } }], t('history.move', { name: person.name }))
    }
  }, [canManage, cellFromPoint, controller, dates, persons, t])

  // ---------------------------------------------------------------- keyboard
  const scrollCellIntoView = useCallback((cell: CellAddress) => {
    const element = scrollRef.current
    const top = offsets.personTop.get(cell.row)
    if (!element || top === undefined) return
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowH + HEADER_H + footerH > element.scrollTop + element.clientHeight) element.scrollTop = top + rowH + HEADER_H + footerH - element.clientHeight
    const left = NAME_W + cell.col * dayW
    if (left < element.scrollLeft + NAME_W) element.scrollLeft = left - NAME_W
    else if (left + dayW > element.scrollLeft + element.clientWidth - TOTAL_W) element.scrollLeft = left + dayW - element.clientWidth + TOTAL_W
  }, [dayW, offsets.personTop, rowH])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (editing || rows === 0) return
    const current = selection ?? { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }
    const mod = event.metaKey || event.ctrlKey
    const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (step[event.key]) {
      event.preventDefault()
      const [dr, dc] = step[event.key]!
      const jump = mod ? 1000 : 1
      const focus = clampCell({ row: current.focus.row + dr * jump, col: current.focus.col + dc * jump }, rows, cols)
      setSelection(event.shiftKey ? { anchor: current.anchor, focus } : { anchor: focus, focus })
      scrollCellIntoView(focus)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const focus = clampCell({ row: current.focus.row, col: current.focus.col + (event.shiftKey ? -1 : 1) }, rows, cols)
      setSelection({ anchor: focus, focus })
      scrollCellIntoView(focus)
      return
    }
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      void (event.shiftKey ? controller.redo() : controller.undo())
      return
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      void controller.redo()
      return
    }
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      setSelection({ anchor: { row: 0, col: 0 }, focus: { row: rows - 1, col: cols - 1 } })
      return
    }
    if (!canManage) return
    if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      void fill('down')
      return
    }
    if (mod && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      void fill('right')
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      void clearSelection()
      return
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      if (!selection) setSelection(current)
      const existing = editableIn(current.focus)
      if (existing.length === 1 && event.key === 'Enter' && event.shiftKey) onOpenEntry(existing[0]!)
      else setEditing({ text: existing[0]?.target?.code ?? existing[0]?.target?.label ?? '', replaceExisting: true })
      return
    }
    if (event.key === 'Escape') {
      setSelection((value) => (value ? { anchor: value.focus, focus: value.focus } : value))
      return
    }
    if (event.key.length === 1 && !mod && !event.altKey) {
      event.preventDefault()
      if (!selection) setSelection(current)
      setEditing({ text: event.key, replaceExisting: true })
    }
  }, [canManage, clearSelection, cols, controller, editableIn, editing, fill, onOpenEntry, rows, scrollCellIntoView, selection])

  // ---------------------------------------------------------------- context menu
  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    if (!selection) return []
    const existing = editableIn(selection.focus)
    const items: ContextMenuEntry[] = []
    if (canManage) items.push({ key: 'book', label: t('menu.book'), icon: Pencil, onSelect: () => setEditing({ text: '', replaceExisting: true }) })
    if (existing.length === 1) {
      items.push({ key: 'details', label: t('menu.details'), icon: Pencil, onSelect: () => onOpenEntry(existing[0]!) })
      if (canManage) items.push({ key: 'split', label: t('menu.split'), icon: SquareSplitHorizontal, onSelect: () => void splitDay(existing[0]!) })
    }
    items.push({ key: 'sep1', separator: true })
    items.push({ key: 'copy', label: t('menu.copy'), icon: Copy, onSelect: () => copySelection() })
    if (canManage) {
      items.push({ key: 'cut', label: t('menu.cut'), icon: Scissors, onSelect: () => { copySelection(); void clearSelection() } })
      items.push({ key: 'paste', label: t('menu.paste'), icon: ClipboardPaste, disabled: !clip.current, onSelect: () => clip.current && void pasteBlock(clip.current.block) })
      items.push({ key: 'fillDown', label: t('menu.fillDown'), icon: Eraser, onSelect: () => void fill('down') })
      items.push({ key: 'fillRight', label: t('menu.fillRight'), icon: Eraser, onSelect: () => void fill('right') })
      items.push({ key: 'sep2', separator: true })
      items.push({ key: 'clear', label: t('menu.clear'), icon: Trash2, danger: true, onSelect: () => void clearSelection() })
    }
    return items
  }, [canManage, clearSelection, copySelection, editableIn, fill, onOpenEntry, pasteBlock, selection, splitDay, t])

  // ---------------------------------------------------------------- geometry
  const pickerAnchor = useMemo(() => {
    if (!editing || !rect || !scrollRef.current) return null
    const box = scrollRef.current.getBoundingClientRect()
    const top = offsets.personTop.get(rect.top)
    if (top === undefined) return null
    return {
      left: box.left + NAME_W + rect.left * dayW - scrollRef.current.scrollLeft,
      top: box.top + HEADER_H + top - scrollRef.current.scrollTop + rowH + 2,
      width: dayW * (rect.right - rect.left + 1),
    }
  }, [dayW, editing, offsets.personTop, rect, rowH])

  const overlay = useMemo(() => {
    if (!rect) return null
    const top = offsets.personTop.get(rect.top)
    const bottomTop = offsets.personTop.get(rect.bottom)
    if (top === undefined || bottomTop === undefined) return null
    return { left: NAME_W + rect.left * dayW, top, width: (rect.right - rect.left + 1) * dayW, height: bottomTop + rowH - top }
  }, [dayW, offsets.personTop, rect, rowH])

  const fillOverlay = useMemo(() => {
    if (!rect || !fillTo) return null
    const area: Rect = { top: Math.min(rect.top, fillTo.row), bottom: Math.max(rect.bottom, fillTo.row), left: Math.min(rect.left, fillTo.col), right: Math.max(rect.right, fillTo.col) }
    const top = offsets.personTop.get(area.top)
    const bottomTop = offsets.personTop.get(area.bottom)
    if (top === undefined || bottomTop === undefined) return null
    return { left: NAME_W + area.left * dayW, top, width: (area.right - area.left + 1) * dayW, height: bottomTop + rowH - top }
  }, [dayW, fillTo, offsets.personTop, rect, rowH])

  const weekday = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }), [locale])
  const monthFormat = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }), [locale])
  const months = useMemo(() => {
    const bands: { label: string; start: number; span: number }[] = []
    days.forEach((day, i) => {
      const label = monthFormat.format(new Date(`${day.date}T00:00:00Z`))
      const last = bands.at(-1)
      if (last && last.label === label) last.span++
      else bands.push({ label, start: i, span: 1 })
    })
    return bands
  }, [days, monthFormat])

  const selectionCount = rect ? (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1) : 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-label={t('grid.label')}
        aria-rowcount={rows}
        aria-colcount={cols}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onCopy={(event) => copySelection(event)}
        onPaste={onPaste}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-openbooks-booking')) {
            event.preventDefault()
            event.dataTransfer.dropEffect = event.altKey || event.ctrlKey || event.metaKey ? 'copy' : 'move'
          }
        }}
        onDrop={(event) => void onDrop(event)}
        onContextMenu={(event) => {
          const cell = cellFromPoint(event.clientX, event.clientY)
          if (!cell) return
          if (!rect || cell.row < rect.top || cell.row > rect.bottom || cell.col < rect.left || cell.col > rect.right) setSelection({ anchor: cell, focus: cell })
          menu.onContextMenu(event)
        }}
        onScroll={(event) => {
          const scrollTop = event.currentTarget.scrollTop
          setViewport((current) => (current.scrollTop === scrollTop ? current : { ...current, scrollTop }))
          if (editing) setEditing(null)
        }}
        className="relative min-h-0 flex-1 select-none overflow-auto rounded-xl border border-slate-200 bg-white outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 dark:border-slate-800 dark:bg-slate-950"
      >
        <div style={{ width: contentW, height: HEADER_H + offsets.height + footerH }} className="relative">
          {/* Header */}
          <div className="sticky top-0 z-20 flex border-b border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95" style={{ height: HEADER_H, width: contentW }}>
            <div className="sticky left-0 z-10 flex items-end bg-white/95 px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-950/95" style={{ width: NAME_W }}>
              {t(board.board.rowKind === 'resources' ? 'grid.resources' : 'grid.people', { count: rows })}
            </div>
            <div className="relative" style={{ width: dayW * cols }}>
              <div className="flex h-5">
                {months.map((band) => (
                  <div key={`${band.label}-${band.start}`} className="truncate border-l border-slate-100 px-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400 first:border-l-0 dark:border-slate-800" style={{ width: band.span * dayW }}>
                    {band.label}
                  </div>
                ))}
              </div>
              <div className="flex" style={{ height: HEADER_H - 20 }}>
                {days.map((day) => {
                  const isToday = day.date === today
                  const weekStart = new Date(`${day.date}T00:00:00Z`).getUTCDay() === board.board.weekStartsOn
                  return (
                    <div
                      key={day.date}
                      className={cn(
                        'flex flex-col items-center justify-center border-l text-center',
                        weekStart ? 'border-slate-300 dark:border-slate-700' : 'border-slate-100 dark:border-slate-800',
                        day.isWeekend && 'bg-slate-200/60 dark:bg-slate-800/70',
                        day.isHoliday && 'bg-rose-50/80 dark:bg-rose-950/30',
                      )}
                      style={{ width: dayW }}
                      title={day.isHoliday ? t('grid.holiday') : undefined}
                    >
                      <span className={cn('text-[10px] font-medium uppercase', isToday ? 'text-teal-700 dark:text-teal-300' : 'text-slate-400')}>
                        {weekday.format(new Date(`${day.date}T00:00:00Z`))}
                      </span>
                      <span className={cn(
                        'mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm font-semibold tabular-nums',
                        isToday ? 'bg-teal-600 text-white' : day.isHoliday ? 'text-rose-600 dark:text-rose-300' : 'text-slate-700 dark:text-slate-200',
                      )}>
                        {Number(day.date.slice(8))}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="sticky right-0 flex items-end justify-end bg-white/95 px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-950/95" style={{ width: TOTAL_W }}>
              {t('grid.hours')}
            </div>
          </div>

          {/* Body */}
          <div className="relative" style={{ width: contentW, height: offsets.height }}>
            {/* Day column backgrounds */}
            <div className="pointer-events-none absolute inset-y-0 flex" style={{ left: NAME_W }}>
              {days.map((day) => (
                <div
                  key={day.date}
                  className={cn(
                    'h-full border-l',
                    new Date(`${day.date}T00:00:00Z`).getUTCDay() === board.board.weekStartsOn ? 'border-slate-200 dark:border-slate-700' : 'border-slate-100 dark:border-slate-800/80',
                    day.isWeekend && 'bg-slate-200/50 dark:bg-slate-800/60',
                    day.isHoliday && 'bg-rose-50/60 dark:bg-rose-950/20',
                    day.date === today && 'bg-teal-50/50 dark:bg-teal-950/20',
                  )}
                  style={{ width: dayW }}
                />
              ))}
            </div>
            {items.slice(firstVisible, lastVisible).map((item, offset) => {
              const i = firstVisible + offset
              const top = offsets.tops[i]!
              if (item.kind === 'group') {
                return (
                  <div key={item.key} className="absolute left-0 flex items-center border-b border-slate-100 bg-slate-50/90 dark:border-slate-800 dark:bg-slate-900/80" style={{ top, height: GROUP_H, width: contentW }}>
                    <div className="sticky left-0 flex items-center gap-2 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {item.label}
                      <span className="rounded-full bg-slate-200/80 px-1.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{item.count}</span>
                    </div>
                  </div>
                )
              }
              const person = item.person!
              return (
                <PersonRow
                  key={item.key}
                  person={person}
                  top={top}
                  rowH={rowH}
                  dayW={dayW}
                  contentW={contentW}
                  dates={dates}
                  boardId={board.board.id}
                  index={index}
                  sourceIndex={sourceIndex}
                  absences={absences}
                  replaced={replaced}
                  compact={compact}
                  spotlight={activeSpotlight}
                  canManage={canManage}
                  minutes={personMinutes.get(person.subjectId) ?? 0}
                  onDragStartChip={onDragStartChip}
                  onOpenEntry={onOpenEntry}
                  onOpenSourceRecord={onOpenSourceRecord}
                  onHoverTarget={setHoverTarget}
                />
              )
            })}
            {overlay ? (
              <div
                className="pointer-events-none absolute z-10 rounded-[3px] border-2 border-teal-600 bg-teal-500/[0.07] dark:border-teal-400"
                style={overlay}
              >
                {canManage ? (
                  <div data-fill-handle className="pointer-events-auto absolute -bottom-[5px] -right-[5px] h-2.5 w-2.5 cursor-crosshair rounded-[2px] border-2 border-white bg-teal-600 shadow dark:border-slate-950" title={t('grid.fillHandle')} />
                ) : null}
              </div>
            ) : null}
            {fillOverlay ? <div className="pointer-events-none absolute z-10 rounded-[3px] border-2 border-dashed border-teal-500" style={fillOverlay} /> : null}
          </div>

          {/* Totals use each booked span, never a fixed number of hours per day. */}
          {board.board.showTotals ? <div className="sticky bottom-0 z-20 flex border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95" style={{ height: FOOTER_H, width: contentW }}>
            <div className="sticky left-0 z-10 flex items-center bg-white/95 px-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-950/95" style={{ width: NAME_W }}>
              {t('grid.onSite')}
            </div>
            {days.map((day) => {
              const total = totals.get(day.date)
              const hasSourceDates = (board.sourceRecords ?? []).some(r => r.onDate === day.date)
              return (
                <div
                  key={day.date}
                  className="flex flex-col items-center justify-center border-l border-slate-100 text-center dark:border-slate-800"
                  style={{ width: dayW }}
                  title={total?.byTarget.map((slot) => `${slot.target.code ?? slot.target.label}: ${slot.people}`).join('\n')}
                >
                  <span className="text-sm font-semibold tabular-nums text-slate-800 dark:text-slate-100">{hasSourceDates ? '—' : total?.people ?? 0}</span>
                  <span className="text-[10px] tabular-nums text-slate-400" title={hasSourceDates ? t('source.unknownHours') : undefined}>
                    {hasSourceDates ? '—' : formatMinutes(total?.minutes ?? 0)}
                  </span>
                </div>
              )
            })}
            <div className="sticky right-0 bg-white/95 dark:bg-slate-950/95" style={{ width: TOTAL_W }} />
          </div> : null}
        </div>
        {rows === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-24 text-center text-sm text-slate-500">
            {search || spotlight ? t('grid.noMatch') : t('grid.noPeople')}
          </div>
        ) : null}
      </div>

      {selectionCount > 1 || controller.saving ? <div className="flex shrink-0 items-center justify-between px-1 py-0.5 text-[11px] text-slate-500" role="status">
        <span>{selectionCount > 1 ? t('grid.selected', { count: selectionCount }) : null}</span>
        {controller.saving ? <span className="animate-pulse">{t('grid.saving')}</span> : null}
      </div> : null}

      {editing && pickerAnchor ? (
        <TargetPicker
          boardId={board.board.id}
          codes={board.codes}
          initialText={editing.text}
          anchor={pickerAnchor}
          cellCount={selectionCount}
          onCommit={(picked) => void commitPicked(picked)}
          onCancel={() => {
            setEditing(null)
            scrollRef.current?.focus()
          }}
        />
      ) : null}
      <ContextMenu open={menu.open} position={menu.position} items={menuItems} onClose={menu.close} />
    </div>
  )
}

function PersonRow({
  person, top, rowH, dayW, contentW, dates, boardId, index, sourceIndex, absences, replaced, compact, spotlight, canManage, minutes,
  onDragStartChip, onOpenEntry, onOpenSourceRecord, onHoverTarget,
}: {
  person: BoardRow
  top: number
  rowH: number
  dayW: number
  contentW: number
  dates: readonly string[]
  boardId: string
  index: ReadonlyMap<string, BoardEntry[]>
  sourceIndex: ReadonlyMap<string, BoardSourceRecord[]>
  absences: ReadonlyMap<string, import('./model').BoardAbsence[]>
  replaced: ReadonlySet<string>
  compact: boolean
  spotlight: string | null
  canManage: boolean
  minutes: number
  onDragStartChip: (event: DragEvent<HTMLDivElement>, entry: BoardEntry) => void
  onOpenEntry: (entry: BoardEntry) => void
  onOpenSourceRecord: (record: BoardSourceRecord) => void
  onHoverTarget: (key: string | null) => void
}) {
  const t = useTranslations('scheduling')
  const hue = targetHue({ id: person.subjectId, color: null })
  return (
    <div className="absolute left-0 flex border-b border-slate-100 hover:bg-slate-50/60 dark:border-slate-800/70 dark:hover:bg-slate-900/40" style={{ top, height: rowH, width: contentW }} role="row">
      <div className="sticky left-0 z-[5] flex items-center gap-2.5 border-r border-slate-100 bg-white px-3 dark:border-slate-800 dark:bg-slate-950" style={{ width: NAME_W }} role="rowheader">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
          style={{ backgroundColor: `hsl(${hue} 60% 90%)`, color: `hsl(${hue} 50% 30%)` }}
          aria-hidden
        >
          {initials(person.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-slate-900 dark:text-slate-100">{person.name}</span>
            {!person.inScope ? (
              <span className="shrink-0 rounded bg-indigo-50 px-1 text-[9px] font-semibold uppercase text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300" title={t('grid.fromElsewhere', { department: person.departmentName ?? t('grid.ungrouped') })}>
                {t('grid.borrowed')}
              </span>
            ) : null}
          </span>
          {!compact ? (
            <span className="block truncate text-[11px] text-slate-400">{[person.jobTitle, person.tradeName].filter(Boolean).join(' · ') || person.departmentName}</span>
          ) : null}
        </span>
      </div>
      {dates.map((date) => {
        const key = cellKey(person.subjectId, date)
        const entries = index.get(key) ?? []
        const leave = absences.get(key) ?? []
        return (
          <div key={date} role="gridcell" className="flex items-center gap-0.5 px-[3px]" style={{ width: dayW, backgroundColor: entries.find((entry) => entry.target?.color && !replaced.has(entry.id))?.target?.color ? `color-mix(in srgb, ${entries.find((entry) => entry.target?.color && !replaced.has(entry.id))!.target!.color} 20%, transparent)` : undefined }}>
            {leave.map((absence) => <AbsenceChip key={`${absence.leaveTypeCode}`} absence={absence} compact={compact} />)}
            <SourceRecordChip records={sourceIndex.get(key) ?? []} dimmed={Boolean(spotlight && !(sourceIndex.get(key) ?? []).some(record => sourceLegendKey(record.label) === spotlight))} compact={compact} onOpen={onOpenSourceRecord} />
            {entries.map((entry) => (
              <BookingChip
                key={entry.id}
                entry={entry}
                boardId={boardId}
                compact={compact}
                replaced={replaced.has(entry.id)}
                dimmed={spotlight !== null && targetKey(entry) !== spotlight}
                draggable={canManage}
                onDragStart={(event) => onDragStartChip(event, entry)}
                onDoubleClick={() => onOpenEntry(entry)}
                onMouseEnter={() => onHoverTarget(targetKey(entry))}
                onMouseLeave={() => onHoverTarget(null)}
              />
            ))}
          </div>
        )
      })}
      <div className="sticky right-0 flex items-center justify-end border-l border-slate-100 bg-white px-3 text-xs font-semibold tabular-nums text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300" style={{ width: TOTAL_W }}>
        {dates.some(date => sourceIndex.has(cellKey(person.subjectId,date)))
          ? <span title={t('source.unknownHours')}>—</span>
          : minutes ? formatMinutes(minutes) : <span className="text-slate-300 dark:text-slate-700">—</span>}
      </div>
    </div>
  )
}
