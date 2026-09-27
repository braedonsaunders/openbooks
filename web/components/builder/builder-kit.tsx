'use client'

import { useCallback, useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { AlertTriangle, ArrowLeft, GripVertical, Info, MoreHorizontal } from 'lucide-react'
import { Alert, Button, Card, cn } from '@openbooks/ui'

/**
 * Shared frame for the Setup builders (review templates, hiring pipelines):
 * a header strip, a 1/3 outline beside a 2/3 inspector, selectable
 * outline rows with drag-to-reorder and a kebab menu, and an inspector
 * card. Composes the shared UI layer only (Card, Alert, cn); menus are the
 * shared ContextMenu and dialogs go through confirmDialog/promptDialog at
 * the call sites.
 */

export function BuilderHeader({
  backHref,
  backLabel,
  title,
  badges,
  status,
  actions,
}: {
  backHref: string
  backLabel: string
  title: ReactNode
  badges?: ReactNode
  status?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-5 space-y-2">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft size={13} /> {backLabel}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          {badges}
        </div>
        <div className="flex items-center gap-2">
          {status}
          {actions}
        </div>
      </div>
    </div>
  )
}

/** The 1/3 outline | 2/3 inspector split; the outline stays in view while the inspector scrolls. */
export function BuilderSplit({ outline, children }: { outline: ReactNode; children: ReactNode }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,1fr)_2fr]">
      <div className="lg:sticky lg:top-0">{outline}</div>
      <div className="min-w-0 space-y-5">{children}</div>
    </div>
  )
}

export function OutlinePanel({
  title,
  actions,
  children,
  footer,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5 dark:border-slate-800">
        <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">{title}</h3>
        {actions}
      </div>
      <div className="p-1.5">{children}</div>
      {footer ? <div className="border-t border-slate-100 p-2 dark:border-slate-800">{footer}</div> : null}
    </Card>
  )
}

export type DropPlace = 'before' | 'after'

/** Handlers an outline row spreads to take part in drag-to-reorder. */
export interface DragBinding {
  draggable: boolean
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDragLeave: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
}

/**
 * Native HTML drag-and-drop for outline rows. `bind` wires one drop target;
 * `canDrop` decides which dragged items it accepts (a stage row accepts
 * stages, a question row accepts questions) and `onDrop` receives the
 * dragged item plus whether it landed before or after the target. A row
 * that does not accept the dragged item lets the event bubble to its
 * container, so a section group can accept sections dragged over its
 * question rows.
 */
export function useOutlineDrag<T extends { key: string }>() {
  const [dragging, setDragging] = useState<T | null>(null)
  const [over, setOver] = useState<{ key: string; place: DropPlace } | null>(null)

  const reset = useCallback(() => {
    setDragging(null)
    setOver(null)
  }, [])

  const bind = useCallback(
    (
      key: string,
      item: T | null,
      options: { canDrop: (dragged: T) => boolean; onDrop: (dragged: T, place: DropPlace) => void },
    ): DragBinding => {
      const placeFor = (event: DragEvent<HTMLElement>): DropPlace => {
        const rect = event.currentTarget.getBoundingClientRect()
        return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      }
      return {
        draggable: item !== null,
        onDragStart: (event) => {
          if (!item) return
          event.stopPropagation()
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', item.key)
          setDragging(item)
        },
        onDragEnd: reset,
        onDragOver: (event) => {
          if (!dragging || dragging.key === key || !options.canDrop(dragging)) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          const place = placeFor(event)
          setOver((current) => (current?.key === key && current.place === place ? current : { key, place }))
        },
        onDragLeave: (event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setOver((current) => (current?.key === key ? null : current))
        },
        onDrop: (event) => {
          if (!dragging || dragging.key === key || !options.canDrop(dragging)) return
          event.preventDefault()
          event.stopPropagation()
          const place = placeFor(event)
          const dropped = dragging
          reset()
          options.onDrop(dropped, place)
        },
      }
    },
    [dragging, reset],
  )

  return {
    dragging,
    bind,
    dropPlace: (key: string): DropPlace | null => (over?.key === key ? over.place : null),
  }
}

/** One selectable outline entry: grip, icon, label and meta, kebab menu, drop indicator. */
export function OutlineRow({
  selected,
  depth = 0,
  icon,
  label,
  placeholder,
  meta,
  trailing,
  onSelect,
  onMenu,
  menuLabel,
  drag,
  dropPlace,
  dimmed,
  grabLabel,
}: {
  selected: boolean
  depth?: 0 | 1
  icon: ReactNode
  label: string
  /** Rendered in place of an empty label. */
  placeholder?: string
  meta?: ReactNode
  trailing?: ReactNode
  onSelect: () => void
  onMenu?: (anchor: HTMLElement) => void
  menuLabel?: string
  drag?: DragBinding
  dropPlace?: DropPlace | null
  dimmed?: boolean
  grabLabel?: string
}) {
  return (
    <div
      {...drag}
      onContextMenu={
        onMenu
          ? (event) => {
              event.preventDefault()
              onMenu(event.currentTarget)
            }
          : undefined
      }
      className={cn(
        'group relative flex items-center gap-1.5 rounded-md py-1.5 pr-1 transition-colors',
        depth === 1 ? 'pl-7' : 'pl-1',
        selected
          ? 'bg-teal-50 text-teal-900 ring-1 ring-teal-200 dark:bg-teal-950/40 dark:text-teal-100 dark:ring-teal-900'
          : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60',
        dimmed && 'opacity-40',
      )}
    >
      {dropPlace ? (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute right-1 left-1 h-0.5 rounded-full bg-teal-500',
            dropPlace === 'before' ? '-top-px' : '-bottom-px',
          )}
        />
      ) : null}
      <span
        aria-label={drag?.draggable ? grabLabel : undefined}
        className={cn(
          'flex h-5 w-4 shrink-0 items-center justify-center text-slate-300 dark:text-slate-600',
          drag?.draggable ? 'cursor-grab group-hover:text-slate-400 active:cursor-grabbing' : 'invisible',
        )}
      >
        <GripVertical size={13} />
      </span>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
      >
        <span className={cn('shrink-0', selected ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400')}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', depth === 0 && 'font-medium', !label && 'text-slate-400 italic')}>
            {label || placeholder}
          </span>
          {meta ? <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{meta}</span> : null}
        </span>
        {trailing}
      </button>
      {onMenu ? (
        <button
          type="button"
          aria-label={menuLabel}
          onClick={(event) => onMenu(event.currentTarget)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-200/70 hover:text-slate-700 focus-visible:opacity-100 dark:hover:bg-slate-700 dark:hover:text-slate-200"
        >
          <MoreHorizontal size={15} />
        </button>
      ) : null}
    </div>
  )
}

export function InspectorPanel({
  icon,
  eyebrow,
  title,
  actions,
  error,
  footer,
  children,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  actions?: ReactNode
  error?: string | null
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-300">
            {icon}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{eyebrow}</p>
            <h3 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          </div>
        </div>
        {actions}
      </div>
      <div className="space-y-5 px-5 py-5">
        {error ? (
          <Alert variant="destructive" className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </Alert>
        ) : null}
        {children}
      </div>
      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-lg border-t border-slate-100 bg-slate-50/60 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/60">
          {footer}
        </div>
      ) : null}
    </Card>
  )
}

/** A radio group of option cards (kind pickers): icon, label and one line of description. */
export function ChoiceCards<V extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  columns = 3,
  disabled,
}: {
  value: V
  options: { value: V; label: string; description?: string; icon?: ReactNode }[]
  onChange: (value: V) => void
  ariaLabel: string
  columns?: 2 | 3
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('grid gap-2', columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              active
                ? 'border-teal-500 bg-teal-50/70 ring-1 ring-teal-500 dark:border-teal-400 dark:bg-teal-950/40 dark:ring-teal-400'
                : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:border-slate-600 dark:hover:bg-slate-800/50',
            )}
          >
            {option.icon ? (
              <span className={cn('mt-0.5 shrink-0', active ? 'text-teal-600 dark:text-teal-300' : 'text-slate-400')}>{option.icon}</span>
            ) : null}
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{option.label}</span>
              {option.description ? (
                <span className="mt-0.5 block text-xs leading-snug text-slate-500 dark:text-slate-400">{option.description}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Builder health: what the owning service will refuse about this configuration, before it does. */
export function BuilderIssues({
  issues,
}: {
  issues: { key: string; tone: 'warning' | 'info'; message: string; onSelect?: () => void }[]
}) {
  if (issues.length === 0) return null
  return (
    <ul className="space-y-1.5">
      {issues.map((issue) => {
        const Icon = issue.tone === 'warning' ? AlertTriangle : Info
        const body = (
          <>
            <Icon size={14} className="mt-0.5 shrink-0" />
            <span>{issue.message}</span>
          </>
        )
        const tone =
          issue.tone === 'warning'
            ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'
            : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'
        return (
          <li key={issue.key}>
            {issue.onSelect ? (
              <button
                type="button"
                onClick={issue.onSelect}
                className={cn('flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-xs hover:underline', tone)}
              >
                {body}
              </button>
            ) : (
              <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', tone)}>{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Report an inspector's dirty state up, so switching selection can ask before discarding edits. */
export function useDirtyReport(dirty: boolean, onDirty: (dirty: boolean) => void) {
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
}

/** Inspector footer: optional left-side action, unsaved marker, Discard and Save. */
export function InspectorFooter({
  dirty,
  busy,
  onDiscard,
  onSave,
  extra,
}: {
  dirty: boolean
  busy: boolean
  onDiscard: () => void
  onSave: () => void
  extra?: ReactNode
}) {
  const tb = useTranslations('admin.setup.builder')
  const tc = useTranslations('common')
  return (
    <>
      <div className="mr-auto flex items-center gap-2">{extra}</div>
      {dirty ? <span className="text-xs text-amber-700 dark:text-amber-300">{tb('unsaved')}</span> : null}
      <Button type="button" variant="ghost" size="sm" disabled={!dirty || busy} onClick={onDiscard}>
        {tb('discard')}
      </Button>
      <Button type="button" size="sm" disabled={!dirty || busy} onClick={onSave}>
        {busy ? tc('actions.saving') : tb('saveChanges')}
      </Button>
    </>
  )
}
