import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { CheckCircle2, LayoutGrid, Pencil, Sparkles, XCircle } from 'lucide-react'
import { Badge, Button, PageHeader } from '@openbooks/ui'
import { PageContainer } from '../../components/page-layout'
import { dashboardData, orgInfo } from '../../lib/data'
import { money } from '../../lib/format'
import { getAuthz } from '../../lib/authz'
import { loadDashboardEmbed, resolveHomeDashboard } from '../api/insights/_lib'
import { DashboardEmbed } from './insights/DashboardEmbed'

export const dynamic = 'force-dynamic'

/**
 * The home surface. Instead of a fixed grid of hardcoded stat cards, it renders
 * the user's resolved HOME DASHBOARD from the insights platform — a customizable
 * card grid (personal → role default → seeded system default). The one thing that
 * stays fixed is the ledger-health strip at the very top: a compact, always-on
 * read on whether the ledger balances and the parallel-run against the external
 * system matched. Everything below is a real insights dashboard, editable with
 * the same builder as any other board.
 */

/** A compact health pill (balanced ledger, parallel-run parity). */
function HealthPill({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ' +
        (ok
          ? 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-300'
          : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300')
      }
    >
      {ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
      {ok ? okText : badText}
    </span>
  )
}

export default async function Home() {
  const t = await getTranslations('dashboard')
  const th = await getTranslations('dashboard.home')

  const authz = await getAuthz()
  const [{ totals, runs }, org] = await Promise.all([dashboardData(), orgInfo()])

  // Ledger-health strip (kept from the old fixed dashboard).
  const balanced = Number(totals.ledger_sum) === 0
  const lastOk = runs.find((r: any) => r.status === 'ok')
  const lastTb = lastOk?.stats?.tb
  const parityOk = lastTb ? (lastTb.mismatches?.length ?? 0) === 0 : null

  // Resolve + load the home dashboard via the insights platform.
  const home = authz
    ? await resolveHomeDashboard(authz.user.orgId, authz.user.id, authz.user.role)
    : null
  // Viewers see only published cards; editors also see their drafts placed on the
  // board (matches the dashboards builder's publishedOnly logic).
  const canEditInsights = authz ? authz.permissions.has('insights.create') || authz.permissions.has('*') : false
  const embed =
    home && authz
      ? await loadDashboardEmbed(home.dashboardId, authz.user.orgId, { publishedOnly: !canEditInsights })
      : null

  const sourceBadge =
    home?.source === 'personal' ? th('personalBadge') : home?.source === 'role' ? th('roleBadge') : th('systemBadge')

  return (
    <PageContainer>
      <PageHeader
        title={t('title')}
        description={
          org
            ? t('orgDescription', { name: org.name, currency: org.base_currency, book: org.book })
            : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/insights/dashboards">
                <LayoutGrid size={14} /> {th('browseInsights')}
              </Link>
            </Button>
            {embed && canEditInsights ? (
              <Button asChild size="sm">
                <Link href={`/insights/dashboards/${home!.dashboardId}`} title={th('customizeHint')}>
                  <Pencil size={14} /> {th('customize')}
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Ledger-health strip — compact, always on. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <HealthPill
          ok={balanced}
          okText={th('ledgerBalanced')}
          badText={th('ledgerOut', { amount: money(totals.ledger_sum) })}
        />
        {lastTb ? (
          <HealthPill
            ok={parityOk === true}
            okText={t('stats.parallelRun', { source: lastOk.source }) + ' · ' + t('stats.parityValue', {
              matches: String(lastTb.matches),
              accounts: String(lastTb.accounts),
            })}
            badText={t('stats.parallelRun', { source: lastOk.source }) + ' · ' + t('stats.parityValue', {
              matches: String(lastTb.matches),
              accounts: String(lastTb.accounts),
            })}
          />
        ) : null}
        {home ? (
          <Badge variant="outline" className="ml-auto gap-1">
            <Sparkles size={11} /> {sourceBadge}
          </Badge>
        ) : null}
      </div>

      {/* The resolved home dashboard, rendered by the insights embed. */}
      <div className="mt-6">
        {embed ? (
          <DashboardEmbed cards={embed.cards} layout={embed.layout} />
        ) : (
          <div className="rounded-xl border border-dashed border-slate-300 px-6 py-16 text-center dark:border-slate-700">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{th('noBoard')}</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">{th('noBoardBody')}</p>
            <div className="mt-4">
              <Button asChild size="sm">
                <Link href="/insights/dashboards">
                  <LayoutGrid size={14} /> {th('openInsights')}
                </Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  )
}
