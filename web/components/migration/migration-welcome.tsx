'use client'

import { useTranslations } from 'next-intl'
import { ArrowRight, Compass, FileSpreadsheet, RefreshCcw, Rocket, Sprout } from 'lucide-react'
import type { MigrationPath } from '@/lib/migration/plan-model'

const PATHS: { key: MigrationPath; icon: typeof Rocket }[] = [
  { key: 'cutover', icon: Rocket },
  { key: 'mirror', icon: RefreshCcw },
  { key: 'spreadsheet', icon: FileSpreadsheet },
  { key: 'fresh', icon: Sprout },
]

/**
 * The opening of a migration conversation: four ways books arrive, each a
 * one-click start that the assistant takes from there. Choosing a card only
 * starts the conversation; the plan changes when the user approves it.
 */
export function MigrationWelcome({ onPick, sourceHint }: { onPick: (prompt: string) => void; sourceHint: string | null }) {
  const t = useTranslations('sync.migrationAssistant.welcome')
  return (
    <div className="mx-auto max-w-2xl pt-6 pb-2">
      <div className="relative overflow-hidden rounded-2xl border border-teal-200/70 bg-gradient-to-br from-teal-50 via-white to-emerald-50 p-6 shadow-sm dark:border-teal-900/60 dark:from-teal-950/40 dark:via-slate-950 dark:to-emerald-950/30">
        <div aria-hidden="true" className="absolute -top-16 -right-16 h-48 w-48 rounded-full bg-teal-400/10 blur-2xl" />
        <p className="text-[11px] font-semibold tracking-wide text-teal-700 uppercase dark:text-teal-300">{t('kicker')}</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">{t('title')}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{t('description')}</p>
        {sourceHint ? <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{sourceHint}</p> : null}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {PATHS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onPick(t(`paths.${key}.prompt`))}
            className="group flex flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-800"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
              <Icon className="h-5 w-5" />
            </span>
            <span className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`paths.${key}.title`)}</span>
            <span className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{t(`paths.${key}.description`)}</span>
            <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-teal-700 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-teal-300">
              {t('start')}<ArrowRight className="h-3 w-3" />
            </span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => onPick(t('unsure.prompt'))} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-teal-300 hover:text-teal-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <Compass className="h-3.5 w-3.5" />{t('unsure.label')}
        </button>
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('dropHint')}</p>
      </div>
    </div>
  )
}
