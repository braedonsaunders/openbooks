'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { fetchWindow, saveChanges, SchedulingRequestError } from './api'
import { inverseOf, type BoardChange, type BoardEntry, type BoardWindow, type ChangeResult } from './model'

export interface BoardNotice {
  readonly id: number
  readonly tone: 'error' | 'success'
  readonly message: string
  readonly remedy: string | null
}

interface HistoryStep {
  readonly label: string
  readonly changes: BoardChange[]
}

const newId = () => crypto.randomUUID()

/**
 * The live state of one people board: its window, saves, and undo history.
 * A save merges the server's results at once and then reloads the window in
 * the background, so the board always settles on what was actually stored.
 */
export function useBoard(boardId: string, initial: BoardWindow | null, range: { from: string; through: string }, enabled = true) {
  const t = useTranslations('scheduling')
  const compatible = (value: BoardWindow | null) => value?.board.id === boardId && value.from === range.from && value.through === range.through
  const [window, setWindow] = useState<BoardWindow | null>(compatible(initial) ? initial : null)
  const [loading, setLoading] = useState(enabled && !compatible(initial))
  const [saving, setSaving] = useState(0)
  const [notices, setNotices] = useState<BoardNotice[]>([])
  const [undoStack, setUndoStack] = useState<HistoryStep[]>([])
  const [redoStack, setRedoStack] = useState<HistoryStep[]>([])
  const noticeSeq = useRef(0)
  const requestSeq = useRef(0)
  const loadedRange=useRef(compatible(initial)?`${boardId}|${range.from}|${range.through}`:'')
  const pending = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current=true; return () => { mounted.current=false; ++requestSeq.current; pending.current?.abort() } }, [])
  const rangeRef = useRef(range)
  rangeRef.current = range

  const notify = useCallback((tone: BoardNotice['tone'], message: string, remedy: string | null = null) => {
    const id = ++noticeSeq.current
    setNotices((current) => [...current.slice(-4), { id, tone, message, remedy }])
    if (tone === 'success') setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 3500)
  }, [])
  const dismiss = useCallback((id: number) => setNotices((current) => current.filter((notice) => notice.id !== id)), [])

  const reload = useCallback(async () => {
    pending.current?.abort()
    const abort = new AbortController(); pending.current=abort
    const seq = ++requestSeq.current
    const { from, through } = rangeRef.current
    try {
      const next = await fetchWindow(boardId, from, through, t('errors.load'), abort.signal)
      if (seq === requestSeq.current) {
        if(next.board.id!==boardId||next.from!==from||next.through!==through)throw new SchedulingRequestError('The returned schedule does not match the requested board and dates.','Reload this board window.','schedule_window_mismatch')
        loadedRange.current=`${boardId}|${from}|${through}`;setWindow(next)
      }
    } catch (error) {
      if (seq !== requestSeq.current || abort.signal.aborted || !mounted.current) return
      notify('error', error instanceof Error ? error.message : t('errors.load'), error instanceof SchedulingRequestError ? error.remedy : null)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [boardId, notify, t])

  // A new board or date range loads its window; the server render already
  // supplied the first one.
  useEffect(() => {
    const key = `${boardId}|${range.from}|${range.through}`
    if (!enabled || key === loadedRange.current) return
    setLoading(true)
    void reload()
  }, [boardId, enabled, range.from, range.through, reload])

  // A refreshed server snapshot is authoritative only for its exact window.
  useEffect(() => {
    if (initial?.board.id !== boardId || initial.from !== range.from || initial.through !== range.through) return
    pending.current?.abort(); ++requestSeq.current
    loadedRange.current=`${boardId}|${initial.from}|${initial.through}`;setWindow(initial); setLoading(false)
  }, [initial, boardId])

  const shownWindow = compatible(window) ? window : null
  const entriesById = useMemo(() => new Map((window?.entries ?? []).map((entry) => [entry.id, entry])), [window])

  /** Merge accepted results into the shown window immediately. */
  const merge = useCallback((changes: readonly BoardChange[], results: readonly ChangeResult[]) => {
    setWindow((current) => {
      if (!current) return current
      const removed = new Set<string>()
      const added: BoardEntry[] = []
      results.forEach((result, index) => {
        if (!result.ok) return
        const change = changes[index]
        if (change?.op === 'cancel') removed.add(change.id)
        // A staged change keeps the published original on view, marked as replaced.
        if (change?.op === 'update' && (current.board.publishPolicy === 'live' || !result.replacedId)) removed.add(change.id)
        if (result.replacedId && current.board.publishPolicy === 'live') removed.add(result.replacedId)
        if (result.entry) {
          removed.add(result.entry.id)
          added.push(result.entry)
        }
      })
      const replaced = new Set(current.replaced)
      for (const result of results) if (result.ok && result.replacedId && current.board.publishPolicy === 'staged') replaced.add(result.replacedId)
      return {
        ...current,
        entries: [...current.entries.filter((entry) => !removed.has(entry.id)), ...added],
        replaced: [...replaced],
      }
    })
  }, [])

  const run = useCallback(async (changes: BoardChange[], label: string, history: 'record' | 'undo' | 'redo' = 'record'): Promise<ChangeResult[] | null> => {
    if (changes.length === 0) return []
    const before = new Map(entriesById)
    setSaving((count) => count + 1)
    try {
      const { results,distributionRefusals } = await saveChanges(boardId, changes, t('errors.save'))
      merge(changes, results)
      for(const refusal of distributionRefusals??[])notify('error',`Bookings saved; schedule email not queued: ${refusal.message}`,refusal.remedy)
      const refused = results.filter((result): result is Extract<ChangeResult, { ok: false }> => !result.ok)
      if (refused.length) {
        const first = refused[0]!
        notify('error', refused.length === 1 ? first.error : t('notices.someRefused', { count: refused.length, total: results.length, reason: first.error }), first.remedy)
      }
      const inverse = inverseOf(changes, results, before, newId)
      if (inverse.length) {
        const step = { label, changes: inverse }
        if (history === 'undo') setRedoStack((stack) => [...stack, step])
        else {
          setUndoStack((stack) => [...stack.slice(-49), step])
          if (history === 'record') setRedoStack([])
        }
      }
      void reload()
      return results
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('errors.save'), error instanceof SchedulingRequestError ? error.remedy : null)
      void reload()
      return null
    } finally {
      setSaving((count) => count - 1)
    }
  }, [boardId, entriesById, merge, notify, reload, t])

  const undo = useCallback(async () => {
    const step = undoStack.at(-1)
    if (!step) return
    setUndoStack((stack) => stack.slice(0, -1))
    await run(step.changes, step.label, 'undo')
  }, [run, undoStack])

  const redo = useCallback(async () => {
    const step = redoStack.at(-1)
    if (!step) return
    setRedoStack((stack) => stack.slice(0, -1))
    await run(step.changes, step.label, 'redo')
  }, [redoStack, run])

  return {
    window: shownWindow,
    loading,
    saving: saving > 0,
    notices,
    notify,
    dismiss,
    reload,
    run,
    undo,
    redo,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.at(-1)?.label ?? null,
    entriesById,
  }
}

export type BoardController = ReturnType<typeof useBoard>
