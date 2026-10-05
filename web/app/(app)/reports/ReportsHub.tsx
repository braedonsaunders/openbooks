'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  ArrowUpRight,
  Boxes,
  BrainCircuit,
  BriefcaseBusiness,
  Bookmark,
  BookOpen,
  Calculator,
  CalendarClock,
  ClipboardList,
  Coins,
  FileText,
  Gauge,
  HandCoins,
  Landmark,
  Network,
  NotebookPen,
  Receipt,
  Scale,
  Sparkles,
  Target,
  Users,
  Wallet,
  Waves,
} from 'lucide-react'
import { PageHeader, cn } from '@openbooks/ui'
import { RecordTabs } from '../../../components/module-home/record-tabs'
import { SearchInput } from '../../../components/search-input'
import { NewReportButton } from './custom/NewReportButton'

const ICONS: Record<string, typeof FileText> = {
  Users,
  FileText,
  Scale,
  Waves,
  ClipboardList,
  BookOpen,
  NotebookPen,
  CalendarClock,
  Receipt,
  Wallet,
  Landmark,
  Target,
  Sparkles,
  Coins,
  Bookmark,
  HandCoins,
  Boxes,
  BrainCircuit,
  BriefcaseBusiness,
  Network,
  Calculator,
  Gauge,
}

// Full literal accent class sets so Tailwind's scanner keeps them.
const ACCENTS: Record<string, { chip: string; ink: string; ribbon: string; link: string }> = {
  teal: {
    chip: 'bg-teal-50 text-teal-700 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300 dark:ring-teal-900/60',
    ink: 'bg-teal-500/40 dark:bg-teal-400/40',
    ribbon: 'bg-teal-600 dark:bg-teal-500',
    link: 'group-hover:text-teal-600 dark:group-hover:text-teal-300',
  },
  sky: {
    chip: 'bg-sky-50 text-sky-700 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900/60',
    ink: 'bg-sky-500/40 dark:bg-sky-400/40',
    ribbon: 'bg-sky-600 dark:bg-sky-500',
    link: 'group-hover:text-sky-600 dark:group-hover:text-sky-300',
  },
  emerald: {
    chip: 'bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900/60',
    ink: 'bg-emerald-500/40 dark:bg-emerald-400/40',
    ribbon: 'bg-emerald-600 dark:bg-emerald-500',
    link: 'group-hover:text-emerald-600 dark:group-hover:text-emerald-300',
  },
  violet: {
    chip: 'bg-violet-50 text-violet-700 ring-violet-100 dark:bg-violet-950/50 dark:text-violet-300 dark:ring-violet-900/60',
    ink: 'bg-violet-500/40 dark:bg-violet-400/40',
    ribbon: 'bg-violet-600 dark:bg-violet-500',
    link: 'group-hover:text-violet-600 dark:group-hover:text-violet-300',
  },
  amber: {
    chip: 'bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900/60',
    ink: 'bg-amber-500/40 dark:bg-amber-400/40',
    ribbon: 'bg-amber-600 dark:bg-amber-500',
    link: 'group-hover:text-amber-600 dark:group-hover:text-amber-300',
  },
  slate: {
    chip: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
    ink: 'bg-slate-500/45 dark:bg-slate-400/40',
    ribbon: 'bg-slate-600 dark:bg-slate-400',
    link: 'group-hover:text-slate-700 dark:group-hover:text-slate-200',
  },
}

/**
 * The layout a report prints in. Each hub card draws a miniature of its
 * sheet in this form, so a statement, a ledger and an aging schedule are
 * recognisable at a glance before the report is opened.
 */
export type PaperForm = 'statement' | 'ledger' | 'aging' | 'chart' | 'list' | 'studio'
export type HubCard = { href: string; title: string; desc: string; icon: string; form: PaperForm; saved?: boolean }
export type HubGroup = { key: string; label: string; accent: string; cards: HubCard[] }

/** Deterministic per-card variation so server and client draw the same sheet. */
function seeded(text: string) {
  let state = 2166136261
  for (let index = 0; index < text.length; index++) state = Math.imul(state ^ text.charCodeAt(index), 16777619)
  return (min: number, max: number) => {
    state = Math.imul(state ^ (state >>> 15), 2246822507)
    state = Math.imul(state ^ (state >>> 13), 3266489909)
    const unit = ((state ^= state >>> 16) >>> 0) / 4294967296
    return Math.round(min + unit * (max - min))
  }
}

function Bar({ width, className }: { width: number; className?: string }) {
  return <span className={cn('block h-[3px] rounded-full', className)} style={{ width: `${width}%` }} />
}

const INK = {
  label: 'bg-slate-300/70 dark:bg-slate-700',
  figure: 'bg-slate-400/55 dark:bg-slate-600',
  prior: 'bg-slate-300/60 dark:bg-slate-700/80',
  heading: 'bg-slate-500/55 dark:bg-slate-500',
  total: 'bg-slate-600/60 dark:bg-slate-400/70',
}

function StatementSheet({ rand }: { rand: ReturnType<typeof seeded> }) {
  const section = (lines: number, key: string) => (
    <div key={key} className="space-y-[5px]">
      <Bar width={rand(26, 40)} className={INK.heading} />
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="flex items-center gap-3 pl-2.5">
          <span className="flex-1"><Bar width={rand(42, 82)} className={INK.label} /></span>
          <span className="flex w-[15%] justify-end"><Bar width={rand(55, 95)} className={INK.figure} /></span>
          <span className="flex w-[15%] justify-end"><Bar width={rand(55, 95)} className={INK.prior} /></span>
        </div>
      ))}
      <div className="flex justify-end gap-3">
        <span className="w-[15%] border-t border-slate-300 pt-[3px] dark:border-slate-600"><Bar width={100} className={INK.heading} /></span>
        <span className="w-[15%] border-t border-slate-300 pt-[3px] dark:border-slate-600"><Bar width={100} className={INK.prior} /></span>
      </div>
    </div>
  )
  return (
    <div className="space-y-2">
      {section(rand(2, 3), 'a')}
      {section(2, 'b')}
      <div className="flex items-center gap-3">
        <span className="flex-1"><Bar width={rand(34, 46)} className={INK.total} /></span>
        <span className="w-[15%] border-b-[3px] border-double border-slate-400 pb-[2px] dark:border-slate-500"><Bar width={100} className={INK.total} /></span>
        <span className="w-[15%] border-b-[3px] border-double border-slate-300 pb-[2px] dark:border-slate-600"><Bar width={100} className={INK.prior} /></span>
      </div>
    </div>
  )
}

function TableSheet({ rand, columns, rows, shade }: {
  rand: ReturnType<typeof seeded>
  columns: number
  rows: number
  /** Optional per-column fill, for schedules whose later columns weigh more. */
  shade?: (column: number) => string
}) {
  const template = { gridTemplateColumns: `1.6fr repeat(${columns - 1}, minmax(0, 1fr))` }
  return (
    <div className="space-y-[5px]">
      <div className="grid items-center gap-2 border-b border-slate-300 pb-[4px] dark:border-slate-600" style={template}>
        {Array.from({ length: columns }, (_, column) => (
          <span key={column} className={cn('flex', column > 0 && 'justify-end')}>
            <Bar width={column === 0 ? rand(45, 70) : rand(55, 90)} className={INK.heading} />
          </span>
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="grid items-center gap-2" style={template}>
          {Array.from({ length: columns }, (_, column) => {
            // Sparse right-hand cells read as a schedule, not a dense grid.
            const blank = column > 0 && shade !== undefined && rand(0, 9) < column
            return (
              <span key={column} className={cn('flex', column > 0 && 'justify-end')}>
                {blank ? null : (
                  <Bar
                    width={column === 0 ? rand(50, 95) : rand(40, 85)}
                    className={column === 0 ? INK.label : shade?.(column) ?? INK.figure}
                  />
                )}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function ChartSheet({ rand, ink }: { rand: ReturnType<typeof seeded>; ink: string }) {
  // Paired bars: the period against its comparative, as the printed chart draws them.
  const pairs = Array.from({ length: 8 }, () => [rand(30, 100), rand(25, 90)] as const)
  return (
    <div className="space-y-2.5">
      <div className="flex h-11 items-end gap-2 border-b border-slate-300 px-1 dark:border-slate-600">
        {pairs.map(([current, prior], index) => (
          <span key={index} className="flex h-full flex-1 items-end gap-px">
            <span className={cn('flex-1 rounded-t-[1px]', ink)} style={{ height: `${current}%` }} />
            <span className={cn('flex-1 rounded-t-[1px]', INK.prior)} style={{ height: `${prior}%` }} />
          </span>
        ))}
      </div>
      <div className="space-y-[5px]">
        {[0, 1].map((row) => (
          <div key={row} className="flex items-center justify-between">
            <Bar width={rand(30, 50)} className={INK.label} />
            <Bar width={rand(10, 16)} className={INK.figure} />
          </div>
        ))}
      </div>
    </div>
  )
}

function StudioSheet() {
  return (
    <div className="relative grid h-[4.75rem] grid-cols-3 gap-2 rounded-[3px] bg-[radial-gradient(var(--color-slate-300)_0.75px,transparent_0.75px)] [background-size:8px_8px] p-1.5 dark:bg-[radial-gradient(var(--color-slate-700)_0.75px,transparent_0.75px)]">
      <span className="col-span-2 rounded-[3px] border border-dashed border-slate-300 bg-white/70 dark:border-slate-600 dark:bg-slate-900/70" />
      <span className="rounded-[3px] border border-dashed border-slate-300 bg-white/70 dark:border-slate-600 dark:bg-slate-900/70" />
      <span className="col-span-3 grid place-items-center rounded-[3px] border border-dashed border-slate-300 bg-white/70 text-slate-400 dark:border-slate-600 dark:bg-slate-900/70 dark:text-slate-500">
        <Sparkles size={13} />
      </span>
    </div>
  )
}

const AGING_SHADE = [
  INK.figure,
  INK.figure,
  'bg-amber-300/60 dark:bg-amber-500/35',
  'bg-amber-400/55 dark:bg-amber-500/45',
  'bg-rose-300/70 dark:bg-rose-500/40',
  'bg-rose-400/60 dark:bg-rose-500/55',
]

function SheetBody({ card, ink }: { card: HubCard; ink: string }) {
  const rand = seeded(`${card.href}|${card.title}`)
  switch (card.form) {
    case 'statement':
      return <StatementSheet rand={rand} />
    case 'ledger':
      return <TableSheet rand={rand} columns={5} rows={7} />
    case 'aging':
      return <TableSheet rand={rand} columns={6} rows={6} shade={(column) => AGING_SHADE[column] ?? INK.figure} />
    case 'chart':
      return <ChartSheet rand={rand} ink={ink} />
    case 'studio':
      return <StudioSheet />
    default:
      return <TableSheet rand={rand} columns={4} rows={6} />
  }
}

// Shared sheet surface: the same paper, border and dark treatment as the
// rendered report (ReportPaper), so the miniature reads as that document.
const SHEET = 'rounded-[4px] border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'

/**
 * One report as a sheet resting on a small stack. The top sheet carries a
 * miniature of the printed report — letterhead, then its layout — over a
 * caption with the real title and description. On hover the stack fans,
 * the sheet lifts and its corner turns; reduced-motion users get the
 * static stack.
 */
function ReportSheet({ card, accent, descId }: { card: HubCard; accent: (typeof ACCENTS)[string]; descId: string }) {
  const Icon = ICONS[card.icon] ?? FileText
  const motion = 'transition-transform duration-300 ease-out motion-reduce:transition-none'
  return (
    <Link
      href={card.href}
      aria-describedby={descId}
      className="group relative block h-full rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-4 focus-visible:ring-offset-slate-50 dark:focus-visible:ring-offset-slate-950"
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 bg-slate-50 shadow-sm dark:bg-slate-900/70',
          SHEET,
          motion,
          '[transform:translate(5px,6px)_rotate(1deg)] group-hover:[transform:translate(11px,7px)_rotate(3deg)] motion-reduce:group-hover:[transform:translate(5px,6px)_rotate(1deg)]',
        )}
      />
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 shadow-sm',
          SHEET,
          motion,
          '[transform:translate(-1px,4px)_rotate(-0.8deg)] group-hover:[transform:translate(-7px,6px)_rotate(-2.6deg)] motion-reduce:group-hover:[transform:translate(-1px,4px)_rotate(-0.8deg)]',
        )}
      />
      <div
        className={cn(
          'relative h-full drop-shadow-sm group-hover:-translate-y-1 group-hover:drop-shadow-lg motion-reduce:group-hover:translate-y-0',
          motion,
        )}
      >
        <div
          className={cn(
            'relative flex h-full flex-col overflow-hidden transition-[clip-path,border-color] duration-300 ease-out group-hover:border-slate-300 motion-reduce:transition-none dark:group-hover:border-slate-700',
            SHEET,
            '[clip-path:polygon(0_0,100%_0,100%_0,100%_100%,0_100%)] group-hover:[clip-path:polygon(0_0,calc(100%-18px)_0,100%_18px,100%_100%,0_100%)] motion-reduce:group-hover:[clip-path:none]',
          )}
        >
          {/* The turned corner: the underside of the flap the clip cuts away. */}
          <span
            aria-hidden
            className="absolute top-0 right-0 z-10 size-[18px] origin-top-right scale-0 rounded-bl-[3px] bg-[linear-gradient(225deg,transparent_50%,var(--color-slate-200)_50%)] shadow-[-1px_1px_2px_rgb(15_23_42/0.12)] transition-transform duration-300 ease-out group-hover:scale-100 motion-reduce:hidden dark:bg-[linear-gradient(225deg,transparent_50%,var(--color-slate-700)_50%)]"
          />
          {card.saved ? (
            <span
              aria-hidden
              className={cn('absolute top-0 right-7 z-10 h-7 w-3.5 [clip-path:polygon(0_0,100%_0,100%_100%,50%_74%,0_100%)]', accent.ribbon)}
            />
          ) : null}
          <div aria-hidden className="h-[9.5rem] shrink-0 overflow-hidden px-[9%] pt-4 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
            <div className="mb-3.5 flex flex-col items-center gap-[5px]">
              <Bar width={22} className={INK.label} />
              <span className="max-w-full truncate text-[10.5px] leading-3 font-bold tracking-tight text-slate-700 dark:text-slate-200">
                {card.title}
              </span>
              <Bar width={32} className="bg-slate-200/80 dark:bg-slate-700/80" />
            </div>
            <SheetBody card={card} ink={accent.ink} />
          </div>
          <div className="flex flex-1 items-start gap-3 border-t border-slate-100 bg-slate-50/60 px-4 pt-3 pb-3.5 dark:border-slate-800 dark:bg-slate-950/30">
            <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1', accent.chip)}>
              <Icon size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="break-words text-sm font-semibold text-slate-900 dark:text-slate-100">{card.title}</h3>
              <p id={descId} className="mt-0.5 line-clamp-2 text-xs leading-4 text-slate-500 dark:text-slate-400">{card.desc}</p>
            </div>
            <ArrowUpRight
              size={15}
              aria-hidden
              className={cn(
                'mt-0.5 shrink-0 text-slate-300 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 dark:text-slate-600',
                accent.link,
              )}
            />
          </div>
        </div>
      </div>
    </Link>
  )
}

function SheetGrid({ group }: { group: HubGroup }) {
  const accent = ACCENTS[group.accent] ?? ACCENTS.slate!
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-9 pr-2 pb-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {group.cards.map((card, cardIndex) => (
        // Titles wrap instead of truncating mid-word, and a still-clamped
        // description stays reachable through aria-describedby — never a
        // title tooltip alone.
        <ReportSheet key={card.href} card={card} accent={accent} descId={`reports-hub-card-${group.key}-${cardIndex}`} />
      ))}
    </div>
  )
}

export function ReportsHub({
  title,
  groups,
  canCreate,
}: {
  title: string
  description: string
  groups: HubGroup[]
  canCreate: boolean
}) {
  const t = useTranslations('reports.hub')
  const [query, setQuery] = useState('')
  const [activeGroup, setActiveGroup] = useState('all')

  // The search also matches the group name, so "payroll" finds every
  // payroll report. Tab counts follow the search, showing where matches are.
  const matched = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return groups.map((group) => ({
      ...group,
      cards: needle
        ? group.cards.filter((card) => `${card.title} ${card.desc} ${group.label}`.toLocaleLowerCase().includes(needle))
        : group.cards,
    }))
  }, [groups, query])
  const total = matched.reduce((sum, group) => sum + group.cards.length, 0)
  const tabs = [
    { key: 'all', label: t('all'), count: total },
    ...groups.map((group, index) => ({ key: group.key, label: group.label, count: matched[index]!.cards.length })),
  ]
  const active = tabs.some((tab) => tab.key === activeGroup) ? activeGroup : 'all'
  const shown = matched.filter((group) => (active === 'all' || group.key === active) && group.cards.length > 0)

  let body: ReactNode
  if (shown.length === 0) {
    body = (
      <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center dark:border-slate-800">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('noMatches')}</p>
      </div>
    )
  } else if (active !== 'all') {
    body = <SheetGrid group={shown[0]!} />
  } else {
    body = shown.map((group) => (
      <section key={group.key} aria-labelledby={`reports-hub-group-${group.key}`} className="space-y-4">
        <div className="flex items-center gap-3">
          <h2 id={`reports-hub-group-${group.key}`} className="text-xs font-semibold tracking-wider text-slate-600 uppercase dark:text-slate-400">
            {group.label}
          </h2>
          <span aria-hidden className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          <span className="text-[11px] text-slate-400 tabular-nums dark:text-slate-500">{t('reportCount', { count: group.cards.length })}</span>
        </div>
        <SheetGrid group={group} />
      </section>
    ))
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title={title}
        actions={
          <>
            <SearchInput size="md" value={query} onValueChange={setQuery} placeholder={t('searchPlaceholder')} className="w-full sm:w-80 sm:max-w-none" />
            {canCreate ? <NewReportButton /> : null}
          </>
        }
      />
      <RecordTabs label={t('browseGroups')} tabs={tabs} active={active} onChange={setActiveGroup}>
        <div className="space-y-10 pt-5">{body}</div>
      </RecordTabs>
    </div>
  )
}
