import type { DashboardQuickAction } from '@openbooks/schema'

export type QuickAction = DashboardQuickAction

type QuickActionsSaveResult = { ok: true } | { ok: false; error?: string }

export type SaveQuickActionsAction = (input: QuickAction[]) => Promise<QuickActionsSaveResult>

export type QuickActionOption = {
  label: string
  href: string
  iconKey: string
  tone: string
  hint?: string
}

export type QuickActionOptions = {
  common: QuickActionOption[]
}

type QuickActionTone =
  | 'rose' | 'orange' | 'amber' | 'emerald' | 'teal' | 'sky' | 'blue' | 'violet' | 'slate'

type ToneClasses = {
  tile: string
  chip: string
  label: string
  arrow: string
  swatch: string
  name: string
}

export const TONES: Record<QuickActionTone, ToneClasses> = {
  rose: {
    tile: 'border-slate-200/70 bg-white hover:border-rose-300 hover:bg-rose-50/70 focus-visible:ring-rose-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-rose-800/70 dark:hover:bg-rose-950/30',
    chip: 'bg-rose-100 text-rose-700 group-hover:bg-rose-600 group-hover:text-white dark:bg-rose-950/60 dark:text-rose-300 dark:group-hover:bg-rose-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-rose-900 dark:text-slate-200 dark:group-hover:text-rose-100',
    arrow: 'text-rose-500 dark:text-rose-400',
    swatch: 'bg-rose-500',
    name: 'Rose',
  },
  orange: {
    tile: 'border-slate-200/70 bg-white hover:border-orange-300 hover:bg-orange-50/70 focus-visible:ring-orange-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-orange-800/70 dark:hover:bg-orange-950/30',
    chip: 'bg-orange-100 text-orange-700 group-hover:bg-orange-600 group-hover:text-white dark:bg-orange-950/60 dark:text-orange-300 dark:group-hover:bg-orange-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-orange-900 dark:text-slate-200 dark:group-hover:text-orange-100',
    arrow: 'text-orange-500 dark:text-orange-400',
    swatch: 'bg-orange-500',
    name: 'Orange',
  },
  amber: {
    tile: 'border-slate-200/70 bg-white hover:border-amber-300 hover:bg-amber-50/70 focus-visible:ring-amber-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-amber-800/70 dark:hover:bg-amber-950/30',
    chip: 'bg-amber-100 text-amber-700 group-hover:bg-amber-500 group-hover:text-white dark:bg-amber-950/60 dark:text-amber-300 dark:group-hover:bg-amber-500 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-amber-900 dark:text-slate-200 dark:group-hover:text-amber-100',
    arrow: 'text-amber-500 dark:text-amber-400',
    swatch: 'bg-amber-500',
    name: 'Amber',
  },
  emerald: {
    tile: 'border-slate-200/70 bg-white hover:border-emerald-300 hover:bg-emerald-50/70 focus-visible:ring-emerald-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-emerald-800/70 dark:hover:bg-emerald-950/30',
    chip: 'bg-emerald-100 text-emerald-700 group-hover:bg-emerald-600 group-hover:text-white dark:bg-emerald-950/60 dark:text-emerald-300 dark:group-hover:bg-emerald-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-emerald-900 dark:text-slate-200 dark:group-hover:text-emerald-100',
    arrow: 'text-emerald-500 dark:text-emerald-400',
    swatch: 'bg-emerald-500',
    name: 'Emerald',
  },
  teal: {
    tile: 'border-slate-200/70 bg-white hover:border-teal-300 hover:bg-teal-50/70 focus-visible:ring-teal-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-teal-800/70 dark:hover:bg-teal-950/30',
    chip: 'bg-teal-100 text-teal-700 group-hover:bg-teal-600 group-hover:text-white dark:bg-teal-950/60 dark:text-teal-300 dark:group-hover:bg-teal-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-teal-900 dark:text-slate-200 dark:group-hover:text-teal-100',
    arrow: 'text-teal-500 dark:text-teal-400',
    swatch: 'bg-teal-500',
    name: 'Teal',
  },
  sky: {
    tile: 'border-slate-200/70 bg-white hover:border-sky-300 hover:bg-sky-50/70 focus-visible:ring-sky-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-sky-800/70 dark:hover:bg-sky-950/30',
    chip: 'bg-sky-100 text-sky-700 group-hover:bg-sky-600 group-hover:text-white dark:bg-sky-950/60 dark:text-sky-300 dark:group-hover:bg-sky-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-sky-900 dark:text-slate-200 dark:group-hover:text-sky-100',
    arrow: 'text-sky-500 dark:text-sky-400',
    swatch: 'bg-sky-500',
    name: 'Sky',
  },
  blue: {
    tile: 'border-slate-200/70 bg-white hover:border-blue-300 hover:bg-blue-50/70 focus-visible:ring-blue-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-blue-800/70 dark:hover:bg-blue-950/30',
    chip: 'bg-blue-100 text-blue-700 group-hover:bg-blue-600 group-hover:text-white dark:bg-blue-950/60 dark:text-blue-300 dark:group-hover:bg-blue-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-blue-900 dark:text-slate-200 dark:group-hover:text-blue-100',
    arrow: 'text-blue-500 dark:text-blue-400',
    swatch: 'bg-blue-500',
    name: 'Blue',
  },
  violet: {
    tile: 'border-slate-200/70 bg-white hover:border-violet-300 hover:bg-violet-50/70 focus-visible:ring-violet-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-violet-800/70 dark:hover:bg-violet-950/30',
    chip: 'bg-violet-100 text-violet-700 group-hover:bg-violet-600 group-hover:text-white dark:bg-violet-950/60 dark:text-violet-300 dark:group-hover:bg-violet-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-violet-900 dark:text-slate-200 dark:group-hover:text-violet-100',
    arrow: 'text-violet-500 dark:text-violet-400',
    swatch: 'bg-violet-500',
    name: 'Violet',
  },
  slate: {
    tile: 'border-slate-200/70 bg-white hover:border-slate-300 hover:bg-slate-50 focus-visible:ring-slate-400/70 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
    chip: 'bg-slate-200 text-slate-700 group-hover:bg-slate-700 group-hover:text-white dark:bg-slate-800 dark:text-slate-200 dark:group-hover:bg-slate-600 dark:group-hover:text-white',
    label: 'text-slate-700 group-hover:text-slate-900 dark:text-slate-200 dark:group-hover:text-white',
    arrow: 'text-slate-500 dark:text-slate-400',
    swatch: 'bg-slate-500',
    name: 'Slate',
  },
}

export const TONE_KEYS = Object.keys(TONES) as QuickActionTone[]

export function toneOf(tone: string): ToneClasses {
  return TONES[tone as QuickActionTone] ?? TONES.slate
}

export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

export const MAX_QUICK_ACTIONS = 12

type CuratedQuickAction = QuickActionOption & {
  id: string
  requiredPermission: string | null
}

export const CURATED_QUICK_ACTIONS: readonly CuratedQuickAction[] = [
  {
    id: 'd-journal',
    label: 'New journal entry',
    href: '/journal',
    iconKey: 'journal',
    tone: 'teal',
    hint: 'Create',
    requiredPermission: 'gl.post',
  },
  {
    id: 'd-bill',
    label: 'New bill',
    href: '/ap',
    iconKey: 'file',
    tone: 'orange',
    hint: 'Create',
    requiredPermission: 'ap.create',
  },
  {
    id: 'd-invoice',
    label: 'New invoice',
    href: '/ar',
    iconKey: 'file-check',
    tone: 'emerald',
    hint: 'Create',
    requiredPermission: 'ar.create',
  },
  {
    id: 'd-payment',
    label: 'New payment',
    href: '/payments',
    iconKey: 'receipt',
    tone: 'violet',
    hint: 'Create',
    requiredPermission: 'ap.pay',
  },
  {
    id: 'd-expense',
    label: 'New expense',
    href: '/expenses/reports',
    iconKey: 'clipboard',
    tone: 'amber',
    hint: 'Create',
    requiredPermission: 'expenses.create',
  },
  {
    id: 'd-report',
    label: 'Run report',
    href: '/reports',
    iconKey: 'chart',
    tone: 'slate',
    hint: 'Open',
    requiredPermission: 'reports.read',
  },
]

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = CURATED_QUICK_ACTIONS.map(
  ({ id, label, href, iconKey, tone }) => ({ id, label, href, iconKey, tone }),
)
