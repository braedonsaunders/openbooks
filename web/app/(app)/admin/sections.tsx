import Link from 'next/link'
import {
  ArrowUpRight,
  Blocks,
  Boxes,
  Code2,
  Database,
  DatabaseBackup,
  KeyRound,
  Link as LinkIcon,
  Mail,
  PanelLeft,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@openbooks/ui'

// Per-accent class sets, kept as complete literal strings so Tailwind's scanner
// picks them up (dynamic `bg-${x}` names would be purged).
const ACCENTS = {
  teal: {
    chip: 'bg-teal-50 text-teal-700 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300',
    border: 'hover:border-teal-300 dark:hover:border-teal-700',
    link: 'group-hover:text-teal-600 dark:group-hover:text-teal-300',
  },
  violet: {
    chip: 'bg-violet-50 text-violet-700 ring-violet-100 dark:bg-violet-950/50 dark:text-violet-300',
    border: 'hover:border-violet-300 dark:hover:border-violet-700',
    link: 'group-hover:text-violet-600 dark:group-hover:text-violet-300',
  },
  amber: {
    chip: 'bg-amber-50 text-amber-700 ring-amber-100 dark:bg-amber-950/50 dark:text-amber-300',
    border: 'hover:border-amber-300 dark:hover:border-amber-700',
    link: 'group-hover:text-amber-600 dark:group-hover:text-amber-300',
  },
  sky: {
    chip: 'bg-sky-50 text-sky-700 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300',
    border: 'hover:border-sky-300 dark:hover:border-sky-700',
    link: 'group-hover:text-sky-600 dark:group-hover:text-sky-300',
  },
} as const

export type AdminHubAccent = keyof typeof ACCENTS

const ICONS: Record<string, LucideIcon> = {
  users: Users,
  'shield-check': ShieldCheck,
  sparkles: Sparkles,
  'panel-left': PanelLeft,
  mail: Mail,
  'scroll-text': ScrollText,
  'code-2': Code2,
  workflow: Workflow,
  blocks: Blocks,
  'key-round': KeyRound,
  database: Database,
  boxes: Boxes,
  'database-backup': DatabaseBackup,
  link: LinkIcon,
}

/**
 * One admin-hub navigation card.
 *
 * A widget rather than spec blocks: the card composes a Next Link, a
 * per-card lucide icon and accent-scoped Tailwind classes into a single
 * anchor. The icon and accent are `iconKey`/`accent` lookups resolved here,
 * so the spec carries only data — the loader's card rows are serializable
 * and the class strings stay complete literals for Tailwind's scanner.
 */
export function AdminHubCard({
  href,
  iconKey,
  title,
  description,
  accent,
}: {
  href: string
  iconKey: string
  title: string
  description: string
  accent: AdminHubAccent
}) {
  const classes = ACCENTS[accent]
  const Icon = ICONS[iconKey] ?? Code2
  return (
    <Link
      href={href as never}
      title={description}
      className={cn(
        'group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition-all hover:shadow-md dark:border-slate-800 dark:bg-slate-900',
        classes.border,
      )}
    >
      <span
        className={cn(
          'grid h-10 w-10 shrink-0 place-items-center rounded-lg ring-1',
          classes.chip,
        )}
      >
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      <ArrowUpRight
        size={15}
        aria-hidden
        className={cn(
          'shrink-0 text-slate-300 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 dark:text-slate-600',
          classes.link,
        )}
      />
    </Link>
  )
}
