import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  column,
  drill,
  field,
  grid,
  money as moneyCell,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import type { ReportDrillTarget } from '../../../lib/report-drill'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { loadFundCoverageTieout, fundLedgerDrillScope } from '@openbooks/engine/src/nonprofit/statements.ts'
import { NonprofitError } from '@openbooks/engine/src/nonprofit/errors.ts'
import { getMoneyFormatter } from '../../../lib/money-server'
import { groupTabs } from '../../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../../components/module-home/ui'

/**
 * The nonprofit cockpit, split into a loader and a spec.
 *
 * Same archetype as the purchasing cockpit: ViewSpec composes the grid and
 * the panels; every panel body is a shared widget (vitals tiles, the pending
 * directory, the module directory, the attention list), so no bespoke block
 * vocabulary grows here. The directory is static and permission-gated in the
 * loader — it never reads the nav registry, so the cockpit stays honest
 * while entries are still landing.
 */

export interface PendingReleaseItem {
  id: string
  number: string
  amount: string
  releaseDate: string
  fromCode: string
  toCode: string
}

export interface AttentionEntry {
  tone: 'negative' | 'warning'
  text: string
  href: string
}

export interface NonprofitData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof groupTabs>>
  fundsLabel: string
  fundsValue: string
  fundsSub: string
  pairsLabel: string
  pairsValue: string
  pairsSub: string
  pendingLabel: string
  pendingValue: string
  pendingSub: string
  frameworkLabel: string
  frameworkValue: string
  hasPending: boolean
  heroTitle: string
  heroHint: string
  pendingItems: DirectoryItem[]
  directoryTitle: string
  directory: DirectoryItem[]
  attentionTitle: string
  attentionAllClear: string
  attention: AttentionEntry[]
  hasTieout: boolean
  tieoutTitle: string
  tieoutHint: string
  tieoutColFund: string
  tieoutColClass: string
  tieoutColCurrency: string
  tieoutColCash: string
  tieoutColNetAssets: string
  tieoutColCoverage: string
  tieoutRows: TieoutTableRow[]
}

export interface TieoutTableRow {
  rowKey: string
  label: string
  classLabel: string
  currency: string
  cash: string
  cashTone: 'default' | 'negative'
  cashDrill: ReportDrillTarget
  netAssets: string
  netAssetsTone: 'default' | 'negative'
  netAssetsDrill: ReportDrillTarget
  coverage: string
  coverageTone: 'default' | 'negative'
  coverageDrill: ReportDrillTarget
}

type FundCountRow = { total: number; active: number }
type PairCountRow = { total: number }
type PendingRow = {
  id: string
  release_number: string
  amount: string
  release_date: string
  from_code: string | null
  to_code: string | null
}
type FrameworkRow = { framework: string; reason: string; set_at: string }

const FRAMEWORK_LABEL: Record<string, string> = {
  us_asc958: 'US ASC 958',
  ew_sorp_frs102: 'EW SORP FRS 102',
}

export async function loadNonprofit(): Promise<NonprofitData> {
  const authz = await requirePermission('funds.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'nonprofit')
  const t = await getTranslations('nonprofit')
  const { money } = await getMoneyFormatter()

  const grants = { read: true, manage: can(authz, 'funds.manage') }
  const tabs = await groupTabs('nonprofit', '/nonprofit', { orgId })

  const [fundCounts, pairCounts, pending, framework] = await Promise.all([
    db.execute<FundCountRow>(sql`
      select count(*)::int as total,
             count(*) filter (where sv.is_active)::int as active
        from funds f
        join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
       where f.org_id = ${orgId}`),
    db.execute<PairCountRow>(sql`
      select count(*)::int as total from fund_pairs
       where org_id = ${orgId} and is_active`),
    db.execute<PendingRow>(sql`
      select r.id, r.release_number, r.amount::text as amount,
             r.release_date::text as release_date,
             ff.code as from_code, tf.code as to_code
        from fund_releases r
        join segment_values ff on ff.org_id = r.org_id and ff.id = r.from_fund_id
        join segment_values tf on tf.org_id = r.org_id and tf.id = r.to_fund_id
       where r.org_id = ${orgId} and r.status = 'pending_approval'
       order by r.submitted_at desc nulls last, r.id
       limit 6`),
    db.execute<FrameworkRow>(sql`
      select framework, reason, set_at::text as set_at from nonprofit_frameworks
       where org_id = ${orgId}`),
  ])
  const funds = fundCounts.rows[0] ?? { total: 0, active: 0 }
  const pairs = pairCounts.rows[0] ?? { total: 0 }
  const current = framework.rows[0] ?? null
  const pendingRows: PendingReleaseItem[] = pending.rows.map((row) => ({
    id: row.id,
    number: row.release_number,
    amount: row.amount,
    releaseDate: row.release_date,
    fromCode: row.from_code ?? '',
    toCode: row.to_code ?? '',
  }))

  const pendingItems: DirectoryItem[] = pendingRows.map((row) => ({
    href: `/nonprofit/releases?release=${row.id}`,
    label: `${row.number} · ${row.fromCode} → ${row.toCode}`,
    iconKey: 'clipboard',
    badge: { value: money(row.amount), hint: row.releaseDate, tone: 'warning' as const },
  }))

  const directory: DirectoryItem[] = [
    {
      href: '/nonprofit/funds',
      label: t('home.funds'),
      iconKey: 'building',
      badge: { value: String(funds.active), hint: t('home.fundsHint') },
    },
    {
      href: '/nonprofit/releases',
      label: t('home.pending'),
      iconKey: 'clipboard',
      badge: {
        value: String(pendingRows.length),
        hint: t('home.releasesHint'),
        tone: pendingRows.length > 0 ? 'warning' : 'neutral',
      },
    },
    ...(grants.manage
      ? [
          {
            href: '/nonprofit/setup',
            label: t('setup.title'),
            iconKey: 'gauge',
            badge: { value: '', hint: t('home.setupHint') },
          },
        ]
      : []),
  ]

  const attention: AttentionEntry[] = []
  if (!current) {
    attention.push({ tone: 'warning', text: t('home.attentionFramework'), href: '/nonprofit/setup' })
  }

  // Live fund tie-out: the loader emits typed native ledger-drill targets as
  // data and the spec declares drill cells, so every fund component and
  // currency total drills to exactly its posted journal lines with no
  // handcrafted URL and no shared-file change.
  const asOf = await businessToday(orgId)
  const tc = await getTranslations('common')
  let tieoutRows: TieoutTableRow[] = []
  let tieoutHint = ''
  if (await isFeatureEnabled(orgId, 'fundAccounting')) {
    try {
      const tieout = await loadFundCoverageTieout({ orgId, asOf })
      const rows: TieoutTableRow[] = []
      for (const item of tieout.rows) {
        const fundLabel = item.fundCode ?? t('home.tieoutUnassigned')
        const classLabel = item.restrictionClassLabel ?? t('home.tieoutUnassigned')
        rows.push({
          rowKey: `fund|${item.fundId ?? ''}|${item.restrictionClass ?? ''}|${item.baseCurrency}`,
          label: fundLabel,
          classLabel,
          currency: item.baseCurrency,
          cash: money(item.cash),
          cashTone: 'default',
          cashDrill: fundLedgerDrillScope({ bookId: tieout.bookId, asOf, fundId: item.fundId, label: `${fundLabel} · ${t('home.tieoutCash')}`, accountIds: item.cashAccountIds, accountTypes: ['asset_bank'] }),
          netAssets: money(item.netAssets),
          netAssetsTone: 'default',
          netAssetsDrill: fundLedgerDrillScope({ bookId: tieout.bookId, asOf, fundId: item.fundId, label: `${fundLabel} · ${t('home.tieoutNetAssets')}`, accountIds: item.netAssetAccountIds }),
          coverage: money(item.coverage),
          coverageTone: item.undercovered ? 'negative' : 'default',
          coverageDrill: fundLedgerDrillScope({ bookId: tieout.bookId, asOf, fundId: item.fundId, label: `${fundLabel} · ${t('home.tieoutCoverage')}`, accountIds: [...item.cashAccountIds, ...item.netAssetAccountIds] }),
        })
        if (item.undercovered) {
          attention.push({ tone: 'negative', text: t('home.tieoutUndercovered', { code: fundLabel, amount: money(item.coverage) }), href: '/nonprofit/funds' })
        }
      }
      for (const total of tieout.totals) {
        const components = tieout.rows.filter((item) => item.baseCurrency === total.baseCurrency)
        const cashIds = [...new Set(components.flatMap((item) => item.cashAccountIds))].sort()
        const netIds = [...new Set(components.flatMap((item) => item.netAssetAccountIds))].sort()
        const totalLabel = `${tc('labels.total')} · ${total.baseCurrency}`
        rows.push({
          rowKey: `total|${total.baseCurrency}`,
          label: totalLabel,
          classLabel: '',
          currency: total.baseCurrency,
          cash: money(total.cash),
          cashTone: 'default',
          cashDrill: fundLedgerDrillScope({ bookId: tieout.bookId, asOf, fundId: null, label: `${totalLabel} · ${t('home.tieoutCash')}`, accountIds: cashIds, accountTypes: ['asset_bank'] }),
          netAssets: money(total.netAssets),
          netAssetsTone: 'default',
          netAssetsDrill: fundLedgerDrillScope({ bookId: tieout.bookId, asOf, fundId: null, label: `${totalLabel} · ${t('home.tieoutNetAssets')}`, accountIds: netIds }),
          coverage: money(total.coverage),
          coverageTone: 'default',
          coverageDrill: fundLedgerDrillScope({ bookId: tieout.bookId, asOf, fundId: null, label: `${totalLabel} · ${t('home.tieoutCoverage')}`, accountIds: [...cashIds, ...netIds] }),
        })
      }
      tieoutRows = rows
      const ties = tieout.netAssetsTie.map((tie) => `${tie.baseCurrency} ${money(tie.statementTotal)}`).join(' · ')
      const reconciled = tieout.netAssetsTie.every((tie) => tie.tied) && tieout.interfund.every((line) => line.zero)
      tieoutHint = reconciled
        ? t('home.tieoutHint', { asOf }) + ' ' + t('home.tieoutProof', { ties })
        : t('home.tieoutHint', { asOf }) + ' ' + t('home.tieoutBroken')
    } catch (error) {
      if (!(error instanceof NonprofitError)) throw error
    }
  }
  for (const row of pendingRows.slice(0, 6)) {
    attention.push({
      tone: 'warning',
      text: t('home.attentionPending', { number: row.number, amount: money(row.amount) }),
      href: `/nonprofit/releases?release=${row.id}`,
    })
  }

  return {
    title: t('home.title'),
    description: t('home.description'),
    tabs,
    fundsLabel: t('home.funds'),
    fundsValue: String(funds.active),
    fundsSub: t('home.fundsSub', { active: funds.active, total: funds.total }),
    pairsLabel: t('home.pairs'),
    pairsValue: String(pairs.total),
    pairsSub: t('home.pairsSub', { count: pairs.total }),
    pendingLabel: t('home.pending'),
    pendingValue: String(pendingRows.length),
    pendingSub: t('home.pendingSub', { count: pendingRows.length }),
    frameworkLabel: t('home.framework'),
    frameworkValue: current ? (FRAMEWORK_LABEL[current.framework] ?? current.framework) : t('home.frameworkMissing'),
    hasPending: pendingRows.length > 0,
    heroTitle: t('home.heroTitle'),
    heroHint: t('home.heroHint'),
    pendingItems,
    directoryTitle: t('home.directoryTitle'),
    directory,
    attentionTitle: t('home.attentionTitle'),
    attentionAllClear: t('home.attentionAllClear'),
    attention,
    hasTieout: tieoutRows.length > 0,
    tieoutTitle: t('home.tieoutTitle'),
    tieoutHint,
    tieoutColFund: t('home.funds'),
    tieoutColClass: t('funds.restrictionClass'),
    tieoutColCurrency: tc('labels.currency'),
    tieoutColCash: t('home.tieoutCash'),
    tieoutColNetAssets: t('home.tieoutNetAssets'),
    tieoutColCoverage: t('home.tieoutCoverage'),
    tieoutRows,
  }
}

const f = ref<NonprofitData>()
const row = field

export function nonprofitSpec(data: NonprofitData): PageSpec {
  return page({
    route: '/nonprofit',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4', [
        statTile({ iconKey: 'building', accent: 'teal', label: f('fundsLabel'), value: f('fundsValue'), sub: f('fundsSub') }),
        statTile({ iconKey: 'trending-up', accent: 'sky', label: f('pairsLabel'), value: f('pairsValue'), sub: f('pairsSub') }),
        statTile({ iconKey: 'clipboard', accent: 'amber', label: f('pendingLabel'), value: f('pendingValue'), sub: f('pendingSub') }),
        statTile({ iconKey: 'check-circle', accent: 'emerald', label: f('frameworkLabel'), value: f('frameworkValue') }),
      ]),
      panel({
        title: f('heroTitle'),
        iconKey: 'clipboard',
        hint: f('heroHint'),
        bodyClassName: 'p-0',
        className: 'shrink-0',
        when: f('hasPending'),
        blocks: [widgetBlock('directory-section', { items: data.pendingItems, title: data.heroTitle })],
      }),
      widgetBlock('directory-section', { items: data.directory, title: data.directoryTitle }),
      panel({
        title: f('tieoutTitle'),
        iconKey: 'check-circle',
        hint: f('tieoutHint'),
        bodyClassName: 'p-0',
        className: 'shrink-0',
        when: f('hasTieout'),
        blocks: [
          table({
            variant: 'report',
            rows: f('tieoutRows'),
            rowKey: row('rowKey'),
            columns: [
              column(f('tieoutColFund'), text(row('label'))),
              column(f('tieoutColClass'), text(row('classLabel'))),
              column(f('tieoutColCurrency'), text(row('currency'))),
              column(f('tieoutColCash'), drill(row('cashDrill'), moneyCell(row('cash'), { tone: row('cashTone') })), { align: 'right' }),
              column(f('tieoutColNetAssets'), drill(row('netAssetsDrill'), moneyCell(row('netAssets'), { tone: row('netAssetsTone') })), { align: 'right' }),
              column(f('tieoutColCoverage'), drill(row('coverageDrill'), moneyCell(row('coverage'), { tone: row('coverageTone') })), { align: 'right' }),
            ],
          }),
        ],
      }),
      panel({
        title: f('attentionTitle'),
        iconKey: 'triangle-alert',
        bodyClassName: 'p-0',
        className: 'shrink-0',
        blocks: [widgetBlock('attention-list', { items: data.attention, allClear: data.attentionAllClear })],
      }),
    ],
  })
}
