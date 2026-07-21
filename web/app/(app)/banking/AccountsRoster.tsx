'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import type { PageLayoutPrefs } from '@openbooks/schema'
import type { BankingAccountRow } from '../../../lib/module-home/banking'
import { money } from '../../../lib/format'
import { HomePanel } from '../../../components/module-home/client'
import { Sparkline } from '../../../components/module-home/ui'
import { LayoutMenu } from '../../../components/page-layout/LayoutMenu'
import { usePageLayout } from '../../../components/page-layout/use-page-layout'

/** Statements older than this are flagged as a stale feed on the roster. */
const STALE_STATEMENT_DAYS = 30
const PAGE_KEY = 'banking-accounts'

/**
 * The Banking home's account roster — per-user customizable at ROW level:
 * each account can be hidden or reordered (user_page_layouts, keys = account
 * ids; new accounts append visible). Hiding is presentational — section
 * totals stay the loader's full GL truth, with an "n hidden" hint when rows
 * are filtered out.
 */
export function AccountsRosterPanel({
  accounts,
  totalCash,
  totalCards,
  layoutPrefs,
}: {
  accounts: BankingAccountRow[]
  totalCash: number
  totalCards: number
  layoutPrefs: PageLayoutPrefs
}) {
  const t = useTranslations('banking')
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const layout = usePageLayout(
    PAGE_KEY,
    layoutPrefs,
    accounts.map((a) => a.id),
  )
  const ordered = layout.order.map((id) => byId.get(id)).filter(Boolean) as BankingAccountRow[]
  const isHidden = (a: BankingAccountRow) => layout.hidden.has(a.id)
  const banks = ordered.filter((a) => a.type === 'asset_bank')
  const cards = ordered.filter((a) => a.type !== 'asset_bank')
  const visibleBanks = banks.filter((a) => !isHidden(a))
  const visibleCards = cards.filter((a) => !isHidden(a))

  return (
    <HomePanel
      title={t('home.roster.title')}
      icon="building"
      bodyClassName="min-h-0 overflow-y-auto p-0"
      className="min-h-[24rem] lg:col-span-2"
      actions={
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 dark:text-slate-500">{t('home.roster.hint')}</span>
          <LayoutMenu
            size="xs"
            title={t('home.roster.customizeTitle')}
            triggerLabel={t('home.roster.customize')}
            resetLabel={t('home.roster.reset')}
            rows={ordered.map((a) => ({
              key: a.id,
              label: a.name,
              detail: a.number ?? undefined,
              hidden: isHidden(a),
            }))}
            onToggle={layout.toggle}
            onMove={layout.move}
            onReset={layout.reset}
          />
        </div>
      }
    >
      {accounts.length === 0 ? (
        <p className="px-6 py-16 text-center text-sm text-slate-400 dark:text-slate-500">{t('home.roster.empty')}</p>
      ) : visibleBanks.length === 0 && visibleCards.length === 0 ? (
        <p className="px-6 py-16 text-center text-sm text-slate-400 dark:text-slate-500">
          {t('home.roster.allHidden')}
        </p>
      ) : (
        <div>
          {visibleBanks.length > 0 ? (
            <RosterSection
              label={t('home.roster.bankSection')}
              accounts={visibleBanks}
              hiddenCount={banks.length - visibleBanks.length}
              totalLabel={t('home.vitals.cash')}
              total={totalCash}
            />
          ) : null}
          {visibleCards.length > 0 ? (
            <RosterSection
              label={t('home.roster.cardSection')}
              accounts={visibleCards}
              hiddenCount={cards.length - visibleCards.length}
              totalLabel={t('home.vitals.cards')}
              total={totalCards}
            />
          ) : null}
        </div>
      )}
    </HomePanel>
  )
}

function RosterSection({
  label,
  accounts,
  hiddenCount,
  totalLabel,
  total,
}: {
  label: string
  accounts: BankingAccountRow[]
  hiddenCount: number
  totalLabel: string
  total: number
}) {
  const t = useTranslations('banking')
  return (
    <div>
      <div className="sticky top-0 flex items-baseline justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-1.5 backdrop-blur dark:border-slate-800 dark:bg-slate-800/60">
        <span className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</span>
        {hiddenCount > 0 ? (
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {t('home.roster.hiddenCount', { count: hiddenCount })}
          </span>
        ) : null}
      </div>
      <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
        {accounts.map((a) => {
          const statementAge = daysSince(a.lastImportedAt)
          const stale = a.lastStatementDate !== null && statementAge !== null && statementAge > STALE_STATEMENT_DAYS
          return (
            <li key={a.id}>
              <Link
                href={`/banking/${a.id}` as never}
                className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{a.name}</span>
                    {a.number ? (
                      <span className="shrink-0 font-mono text-xs text-slate-400 dark:text-slate-500">{a.number}</span>
                    ) : null}
                    {a.currency ? (
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        {a.currency}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">
                    {a.reconciledThrough
                      ? t('home.roster.reconciledThrough', { date: String(a.reconciledThrough) })
                      : t('home.roster.neverReconciled')}
                    {' · '}
                    {a.lastStatementDate === null ? (
                      t('home.roster.noStatements')
                    ) : stale ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('home.roster.staleStatement', { date: String(a.lastStatementDate) })}
                      </span>
                    ) : (
                      t('home.roster.lastStatement', { date: String(a.lastStatementDate) })
                    )}
                  </span>
                </span>
                {a.unmatched > 0 ? (
                  <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 tabular-nums dark:bg-amber-950/50 dark:text-amber-300">
                    {t('home.roster.unmatchedChip', { count: a.unmatched })}
                  </span>
                ) : null}
                {a.openReconciliationId ? (
                  <span className="shrink-0 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                    {t('home.roster.reconciling')}
                  </span>
                ) : null}
                <Sparkline
                  points={a.spark}
                  className={cn(
                    'hidden sm:block',
                    a.balance < 0 ? 'text-red-400 dark:text-red-500' : 'text-teal-500 dark:text-teal-400',
                  )}
                />
                <span
                  className={cn(
                    'w-28 shrink-0 text-right text-sm font-semibold tabular-nums',
                    a.balance < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100',
                  )}
                >
                  {money(a.balance)}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/50 px-4 py-2.5 dark:border-slate-700 dark:bg-slate-800/30">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{totalLabel}</span>
        <span
          className={cn(
            'text-sm font-bold tabular-nums',
            total < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-slate-100',
          )}
        >
          {money(total)}
        </span>
      </div>
    </div>
  )
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}
