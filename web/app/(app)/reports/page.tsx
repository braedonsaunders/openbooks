import type { ReactNode } from 'react'
import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import {
  ArrowUpRight,
  Bookmark,
  BookOpen,
  CalendarClock,
  ClipboardList,
  Coins,
  FileText,
  Landmark,
  NotebookPen,
  Receipt,
  Scale,
  Sparkles,
  Target,
  Wallet,
  Waves,
} from 'lucide-react'
import { cn } from '@openbooks/ui'
import { PageContainer } from '../../../components/page-layout'

export const dynamic = 'force-dynamic'

// Accent class sets kept as complete literals so Tailwind's scanner keeps them.
const ACCENTS = {
  teal: {
    chip: 'bg-teal-50 text-teal-700 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300',
    border: 'hover:border-teal-300 dark:hover:border-teal-700',
    link: 'group-hover:text-teal-600 dark:group-hover:text-teal-300',
  },
  sky: {
    chip: 'bg-sky-50 text-sky-700 ring-sky-100 dark:bg-sky-950/50 dark:text-sky-300',
    border: 'hover:border-sky-300 dark:hover:border-sky-700',
    link: 'group-hover:text-sky-600 dark:group-hover:text-sky-300',
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
  slate: {
    chip: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300',
    border: 'hover:border-slate-300 dark:hover:border-slate-600',
    link: 'group-hover:text-slate-700 dark:group-hover:text-slate-200',
  },
} as const

type Accent = keyof typeof ACCENTS
type Card = { href: string; key: string; icon: ReactNode }
type Group = { key: string; labelKey: string; accent: Accent; cards: Card[] }

function ReportCard({ href, title, desc, icon, accent }: { href: string; title: string; desc: string; icon: ReactNode; accent: (typeof ACCENTS)[Accent] }) {
  return (
    <Link
      href={href}
      title={desc}
      className={cn(
        'group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors dark:border-slate-800 dark:bg-slate-900',
        accent.border,
      )}
    >
      <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg ring-1', accent.chip)}>{icon}</span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{desc}</p>
      </div>
      <ArrowUpRight
        size={15}
        aria-hidden
        className={cn(
          'shrink-0 text-slate-300 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 dark:text-slate-600',
          accent.link,
        )}
      />
    </Link>
  )
}

export default async function Reports() {
  const t = await getTranslations('reports')

  const [saved, custom] = await Promise.all([
    db.execute(sql`select id, name, path, params from saved_reports order by created_at desc limit 8`) as Promise<{
      rows: { id: string; name: string; path: string; params: Record<string, string> }[]
    }>,
    db.execute(sql`select id, name, kind from report_definitions order by updated_at desc limit 8`) as Promise<{
      rows: { id: string; name: string; kind: string }[]
    }>,
  ])

  const groups: Group[] = [
    {
      key: 'financial',
      labelKey: 'hub.groups.financial',
      accent: 'teal',
      cards: [
        { href: `/reports/pnl`, key: 'pnl', icon: <FileText size={18} /> },
        { href: `/reports/balance-sheet`, key: 'balanceSheet', icon: <Scale size={18} /> },
        { href: `/reports/cash-flow`, key: 'cashFlow', icon: <Waves size={18} /> },
        { href: `/reports/trial-balance`, key: 'trialBalance', icon: <ClipboardList size={18} /> },
      ],
    },
    {
      key: 'ledger',
      labelKey: 'hub.groups.ledger',
      accent: 'sky',
      cards: [
        { href: `/reports/general-ledger`, key: 'generalLedger', icon: <BookOpen size={18} /> },
        { href: `/reports/journal`, key: 'journal', icon: <NotebookPen size={18} /> },
      ],
    },
    {
      key: 'receivablesPayables',
      labelKey: 'hub.groups.receivablesPayables',
      accent: 'violet',
      cards: [
        { href: `/reports/aging?side=ar`, key: 'aging', icon: <CalendarClock size={18} /> },
        { href: `/reports/registers?side=ar`, key: 'registers', icon: <Receipt size={18} /> },
        { href: `/reports/partners?kind=receivable`, key: 'receivables', icon: <Wallet size={18} /> },
        { href: `/reports/partners?kind=payable`, key: 'payables', icon: <Landmark size={18} /> },
      ],
    },
    {
      key: 'budgeting',
      labelKey: 'hub.groups.budgeting',
      accent: 'amber',
      cards: [{ href: `/reports/budget`, key: 'budget', icon: <Target size={18} /> }],
    },
  ]

  return (
    <PageContainer>
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{t('hub.title')}</h1>
          <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t('hub.description')}</p>
        </header>

        {groups.map((group) => {
          const accent = ACCENTS[group.accent]
          return (
            <section key={group.key} className="space-y-2.5">
              <h2 className="px-0.5 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {t(group.labelKey)}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {group.cards.map((card) => (
                  <ReportCard
                    key={card.href}
                    href={card.href}
                    title={t(`hub.cards.${card.key}Title`)}
                    desc={t(`hub.cards.${card.key}Description`)}
                    icon={card.icon}
                    accent={accent}
                  />
                ))}
              </div>
            </section>
          )
        })}

        {/* Custom reports — first-class alongside native, plus saved views. */}
        <section className="space-y-2.5">
          <h2 className="px-0.5 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {t('hub.groups.custom')}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            <ReportCard
              href="/reports/custom"
              title={t('hub.customStudio.title')}
              desc={t('hub.customStudio.description')}
              icon={<Sparkles size={18} />}
              accent={ACCENTS.slate}
            />
            {custom.rows.map((c) => (
              <ReportCard
                key={c.id}
                href={`/reports/custom/run/${c.id}`}
                title={c.name}
                desc={c.kind === 'built_in' ? t('custom.kind.builtIn') : t('custom.kind.custom')}
                icon={<Coins size={18} />}
                accent={ACCENTS.slate}
              />
            ))}
            {saved.rows.map((s) => {
              const qs = new URLSearchParams(s.params ?? {}).toString()
              return (
                <ReportCard
                  key={s.id}
                  href={`${s.path}${qs ? `?${qs}` : ''}`}
                  title={s.name}
                  desc={t('hub.savedViews')}
                  icon={<Bookmark size={18} />}
                  accent={ACCENTS.slate}
                />
              )
            })}
          </div>
        </section>
      </div>
    </PageContainer>
  )
}
