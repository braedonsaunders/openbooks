'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Briefcase, Building2, Clock, CornerDownLeft, MapPin, Tag } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { searchTargets } from './api'
import { parseCellInput, targetHue, type BoardTarget, type ParsedInput } from './model'
import type { BoardCode } from '@openbooks/engine/src/schedule-boards/window.ts'

export interface PickedTarget extends ParsedInput {
  readonly target: BoardTarget
}

const KIND_ICON = { customer: Building2, project: Briefcase, location: MapPin, code: Tag } as const

export function codeTarget(code: BoardCode): BoardTarget {
  return { kind: 'code', id: code.id, code: code.code, label: code.label, context: null, color: code.color, counts: code.category === 'work' }
}

/**
 * The cell editor: type a code or name, pick a native target. A slash adds a
 * detail ("BIRLA/kiln 2"); a trailing range books hours ("SHOP 6-14:30").
 * Positioned over the cell being edited and rendered above the grid.
 */
export function TargetPicker({
  boardId,
  codes,
  initialText,
  anchor,
  cellCount,
  onCommit,
  onCancel,
}: {
  boardId: string
  codes: readonly BoardCode[]
  initialText: string
  anchor: { left: number; top: number; width: number }
  cellCount: number
  onCommit: (picked: PickedTarget) => void
  onCancel: () => void
}) {
  const t = useTranslations('scheduling')
  const [text, setText] = useState(initialText)
  const [remote, setRemote] = useState<BoardTarget[]>([])
  const [active, setActive] = useState(0)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const parsed = useMemo(() => parseCellInput(text), [text])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(true)
      searchTargets(boardId, parsed.query, t('errors.search'), controller.signal)
        .then((body) => setRemote(body.targets))
        .catch(() => undefined)
        .finally(() => setSearching(false))
    }, parsed.query ? 110 : 0)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [boardId, parsed.query, t])

  const options = useMemo(() => {
    const query = parsed.query.toLowerCase()
    const local = codes
      .filter((code) => !query || code.code.toLowerCase().startsWith(query) || code.label.toLowerCase().includes(query))
      .map(codeTarget)
    const seen = new Set(local.map((target) => `${target.kind}:${target.id}`))
    const merged = [...local]
    for (const target of remote) {
      const key = `${target.kind}:${target.id}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(target)
      }
    }
    // An exact code match always leads, wherever it came from.
    merged.sort((a, b) => Number((b.code ?? '').toLowerCase() === query) - Number((a.code ?? '').toLowerCase() === query))
    return merged.slice(0, 12)
  }, [codes, parsed.query, remote])

  const safeActive = Math.min(active, Math.max(0, options.length - 1))

  function commit(index: number) {
    const target = options[index]
    if (!target) return
    onCommit({ ...parsed, target })
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => Math.min(options.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      commit(safeActive)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
    event.stopPropagation()
  }

  const width = Math.max(anchor.width, 320)
  return createPortal(
    <div
      className="fixed z-[60] rounded-xl border border-slate-200 bg-white shadow-2xl ring-1 ring-black/5 dark:border-slate-700 dark:bg-slate-900"
      style={{ left: Math.min(anchor.left, globalThis.innerWidth - width - 12), top: anchor.top, width }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(onCancel, 120)}
          placeholder={t('picker.placeholder')}
          aria-label={t('picker.placeholder')}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100"
        />
        {cellCount > 1 ? (
          <span className="shrink-0 rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-700 dark:bg-teal-950 dark:text-teal-300">
            {t('picker.cells', { count: cellCount })}
          </span>
        ) : null}
      </div>
      {parsed.detail || parsed.span ? (
        <div className="flex flex-wrap gap-2 border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {parsed.detail ? <span>{t('picker.detail', { detail: parsed.detail })}</span> : null}
          {parsed.span?.mode === 'timed' ? (
            <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{parsed.span.starts}–{parsed.span.ends}</span>
          ) : null}
        </div>
      ) : null}
      <ul role="listbox" aria-label={t('picker.results')} className="max-h-72 overflow-y-auto py-1">
        {options.map((target, index) => {
          const Icon = KIND_ICON[target.kind]
          const hue = targetHue(target)
          return (
            <li key={`${target.kind}:${target.id}`} role="option" aria-selected={index === safeActive}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(index)}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm',
                  index === safeActive ? 'bg-slate-100 dark:bg-slate-800' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60',
                )}
              >
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `hsl(${hue} 75% 92%)`, color: `hsl(${hue} 55% 30%)` }}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    {target.code ? <span className="font-mono text-xs font-semibold text-slate-900 dark:text-slate-100">{target.code}</span> : null}
                    <span className="truncate text-slate-700 dark:text-slate-300">{target.label}</span>
                  </span>
                  <span className="block truncate text-[11px] text-slate-400">
                    {target.context ?? t(`kinds.${target.kind}`)}
                    {target.kind === 'code' && !target.counts ? ` · ${t('picker.unavailable')}` : ''}
                  </span>
                </span>
                {index === safeActive ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-slate-400" /> : null}
              </button>
            </li>
          )
        })}
        {options.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-slate-500">{searching ? t('picker.searching') : t('picker.none')}</li>
        ) : null}
      </ul>
      <div className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400 dark:border-slate-800">
        <span>{t('picker.hint')}</span>
        <span>{t('picker.keys')}</span>
      </div>
    </div>,
    document.body,
  )
}
