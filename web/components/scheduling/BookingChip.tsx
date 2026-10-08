'use client'

import type { CSSProperties, DragEvent, MouseEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Lock, MessageSquareText } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { targetHue, targetShortLabel, type BoardAbsence, type BoardEntry } from './model'

/** Hue-driven chip colours that hold in light and dark themes. */
export function chipStyle(hue: number, color?: string | null): CSSProperties {
  return { ['--chip-h' as string]: String(hue),
    ...(color && /^#[0-9a-f]{6}$/i.test(color) ? { '--chip-bg': `color-mix(in srgb, ${color} 28%, white)`, '--chip-dark-bg': `color-mix(in srgb, ${color} 25%, #0f172a)` } : {}),
  } as CSSProperties
}
export const CHIP_COLORS =
  'bg-[var(--chip-bg,hsl(var(--chip-h)_78%_93%))] text-[hsl(var(--chip-h)_55%_24%)] border-[hsl(var(--chip-h)_55%_78%)] ' +
  'dark:bg-[var(--chip-dark-bg,hsl(var(--chip-h)_38%_20%))] dark:text-[hsl(var(--chip-h)_70%_86%)] dark:border-[hsl(var(--chip-h)_35%_34%)]'

export function BookingChip({
  entry,
  boardId,
  compact,
  dimmed,
  replaced,
  draggable,
  onDragStart,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
}: {
  entry: BoardEntry
  boardId: string
  compact: boolean
  dimmed: boolean
  replaced: boolean
  draggable: boolean
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void
  onDoubleClick?: (event: MouseEvent<HTMLDivElement>) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const t = useTranslations('scheduling')
  const elsewhere = entry.boardId !== boardId
  const draft = entry.status === 'draft'
  const hue = targetHue(entry.target)
  const label = targetShortLabel(entry.target)
  const time = entry.spanMode === 'timed' ? `${entry.startClock}–${entry.endClock}` : null
  const title = [
    entry.target ? `${entry.target.label}${entry.target.context ? ` · ${entry.target.context}` : ''}` : t('chip.unassigned'),
    entry.projectTaskName,
    entry.detail,
    time,
    elsewhere ? t('chip.elsewhere', { board: entry.boardName }) : null,
    draft ? t('chip.draft') : null,
    entry.notes,
  ].filter(Boolean).join('\n')

  return (
    <div
      role="button"
      tabIndex={-1}
      title={title}
      draggable={draggable && !elsewhere}
      onDragStart={onDragStart}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={chipStyle(hue, entry.target?.color)}
      className={cn(
        'group/chip relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-md border px-1.5 text-left font-medium leading-tight shadow-[0_1px_0_rgba(15,23,42,0.04)] transition-opacity',
        CHIP_COLORS,
        compact ? 'h-[22px] text-[11px]' : 'h-[32px] text-xs',
        draft && 'border-dashed',
        elsewhere && 'cursor-default border-dotted opacity-70 saturate-50',
        !elsewhere && draggable && 'cursor-grab active:cursor-grabbing',
        replaced && 'opacity-40 line-through',
        dimmed && 'opacity-25',
      )}
    >
      {draft ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-label={t('chip.draft')} /> : null}
      {elsewhere ? <Lock className="h-3 w-3 shrink-0 opacity-70" aria-hidden /> : null}
      <span className="min-w-0 truncate">
        <span className="font-semibold">{label}</span>
        {entry.detail ? <span className="font-normal opacity-80">/{entry.detail}</span> : null}
        {!compact && (time || entry.projectTaskName) ? (
          <span className="block truncate text-[10px] font-normal opacity-75">{[time, entry.projectTaskName].filter(Boolean).join(' · ')}</span>
        ) : null}
      </span>
      {compact && time ? <span className="ml-auto shrink-0 text-[10px] font-normal opacity-75">{entry.startClock}</span> : null}
      {entry.notes ? <MessageSquareText className="ml-auto h-3 w-3 shrink-0 opacity-60" aria-hidden /> : null}
    </div>
  )
}

export function AbsenceChip({ absence, compact }: { absence: BoardAbsence; compact: boolean }) {
  const t = useTranslations('scheduling')
  return (
    <div
      title={t('chip.leave', { type: absence.leaveTypeName, hours: absence.hours })}
      className={cn(
        'flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md border border-amber-300/70 px-1.5 font-semibold text-amber-900 dark:border-amber-700/60 dark:text-amber-200',
        'bg-[repeating-linear-gradient(135deg,var(--color-amber-100)_0_6px,var(--color-amber-50)_6px_12px)] dark:bg-[repeating-linear-gradient(135deg,rgba(120,53,15,0.45)_0_6px,rgba(120,53,15,0.25)_6px_12px)]',
        compact ? 'h-[22px] text-[11px]' : 'h-[32px] text-xs',
      )}
    >
      <span className="truncate">{absence.leaveTypeCode}</span>
    </div>
  )
}
