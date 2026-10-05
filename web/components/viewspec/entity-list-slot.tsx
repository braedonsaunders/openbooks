import 'server-only'

import type { ReactNode } from 'react'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { can, getAuthz } from '../../lib/authz'
import { summarizeGroup, type ConditionGroup, type FieldDef } from '../../lib/conditions'
import { EntityListView } from '../entity-list-view'
import { SuggestionChip } from '../suggestion-chip'
import { buildListDrawerHref } from '../../lib/list-params'
import { entityListSource } from '../../lib/list/entity-sources'
import { Sparkline } from '../module-home/ui'

/**
 * Weekly demand behind one planning suggestion, drawn from the list's own
 * `trend` column (twelve trailing weeks of issued quantities, oldest
 * first). The values are display-only demand history, never money, so they
 * parse to chart points the way any roster number does.
 */
function demandTrendFormatValue(): (_row: unknown, columnKey: string, value: unknown) => ReactNode {
  function DemandTrendCell(_row: unknown, columnKey: string, value: unknown) {
    if (columnKey !== 'trend') return undefined
    const raw = Array.isArray(value) ? value : []
    const points = raw
      .map((point) => (typeof point === 'number' ? point : typeof point === 'string' ? Number(point) : NaN))
      .filter((point) => Number.isFinite(point))
    if (points.length < 2) return <span className="text-slate-400">—</span>
    return <Sparkline points={points} width={96} height={24} />
  }
  return DemandTrendCell
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The one entity list whose cells are not typed by the customization
 * registry: a bank rule's `when` and `outcome` columns hold condition JSON
 * that has to be summarized into prose.
 *
 * It lives here rather than in the loader because the summaries must render
 * INSIDE the list's own cells, and the list is one host component the spec
 * never decomposes. Precomputing them in the loader would mean running the
 * list query twice. Copied verbatim from the native page — the fallbacks and
 * the "+n more" split are part of the byte contract.
 */
async function bankRuleFormatValue(orgId: string) {
  const t = await getTranslations('banking')
  const accounts = await db.execute<{ id: string; number: string | null; name: string }>(sql`
    select id, number, name from accounts
     where org_id = ${orgId} and is_active and not is_summary
     order by number nulls last, name`)
  const accountLabel = new Map(
    accounts.rows.map((account) => [
      account.id,
      [account.number, account.name].filter(Boolean).join(' · '),
    ]),
  )
  const summaryCatalog: FieldDef[] = [
    { key: 'description', label: t('rules.fields.description'), kind: 'text' },
    { key: 'payee', label: t('rules.fields.payee'), kind: 'text' },
    { key: 'anyText', label: t('rules.fields.anyText'), kind: 'text' },
    { key: 'reference', label: t('rules.fields.reference'), kind: 'text' },
    { key: 'amount', label: t('rules.fields.amount'), kind: 'number' },
    {
      key: 'flow',
      label: t('rules.fields.flow'),
      kind: 'flow',
      options: [
        { value: 'in', label: t('rules.signIn') },
        { value: 'out', label: t('rules.signOut') },
      ],
    },
    { key: 'date', label: t('rules.fields.date'), kind: 'date' },
  ]
  const operatorLabels = Object.fromEntries(
    [
      'contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'isBlank',
      'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is', 'on', 'before',
      'after', 'withinDays',
    ].map((key) => [key, t(`rules.ops.${key}`)]),
  )
  return (_row: unknown, columnKey: string, value: unknown): ReactNode => {
    if (columnKey === 'criteria_summary') {
      if (!isRecord(value) || !isRecord(value.match) || !Array.isArray(value.match.rules)) {
        return t('rules.summary.anyLine')
      }
      return (
        summarizeGroup(value.match as unknown as ConditionGroup, summaryCatalog, {
          and: t('rules.summary.and'),
          or: t('rules.summary.or'),
          operatorLabels,
        }) || t('rules.summary.anyLine')
      )
    }
    if (columnKey === 'outcome_summary') {
      if (!isRecord(value)) return '—'
      if (value.action === 'exclude') return t('rules.summary.exclude')
      if (value.action !== 'categorize') return '—'
      const lines = Array.isArray(value.lines) ? value.lines : []
      const firstLine = isRecord(lines[0]) ? lines[0] : null
      const first =
        accountLabel.get(typeof firstLine?.accountId === 'string' ? firstLine.accountId : '') ?? '—'
      const extra = Math.max(0, lines.length - 1)
      return extra > 0
        ? t('rules.summary.categorizeSplit', { account: first, count: extra })
        : t('rules.summary.categorize', { account: first })
    }
    return undefined
  }
}

/**
 * Slot for the universal entity list.
 *
 * `EntityListView` needs an org id, a user id and a permission decision. None
 * of those may travel through a spec: a spec is data, and data that names an
 * org id is a cross-tenant read waiting to happen. So the slot re-derives all
 * three from the session — the spec supplies only the record type and the URL
 * it was already rendering with.
 *
 * `drawer` and `emptyAction` are components, so the spec names widgets and the
 * caller resolves them, the same indirection the empty state uses for its
 * action button.
 */
export async function EntityListSlot({
  recordType,
  sp,
  drawer,
  emptyAction,
  emptyTitle,
  emptyDescription,
}: {
  recordType: string
  sp: Record<string, string | string[] | undefined>
  drawer?: ReactNode
  emptyAction?: ReactNode
  emptyTitle?: string
  emptyDescription?: string
}) {
  const authz = await getAuthz()
  if (!authz) return null
  const formatValue = recordType === 'bank_rule'
    ? await bankRuleFormatValue(authz.user.orgId)
    : recordType === 'demand_suggestion'
      ? demandTrendFormatValue()
      : undefined
  // Change sets are PRODUCTION configuration, read from a sandbox-aware
  // session: the native page lists them against `productionOrgId`, not the
  // current org, and hardcodes `canManage`. Decided here rather than passed,
  // for the same reason the org id itself is — a spec that could name either
  // is a spec that could name the wrong one. Keyed on the record type, the
  // way `bank_rule` above already is.
  const productionConfig = recordType === 'change_set'
  // The needs-attention queues carry a one-click path into their proposed
  // fix: the chip opens the row drawer, where the suggestion loads with its
  // evidence and the approve action. Keyed on the record type like
  // `formatValue` above, so no other list renders it.
  let rowTrailing: ((row: Record<string, unknown>) => ReactNode) | undefined
  if (recordType === 'channel_exception' || recordType === 'psp_settlement_line_unmatched') {
    const source = entityListSource(recordType)
    const chipT = recordType === 'channel_exception'
      ? await getTranslations('channels')
      : await getTranslations('banking')
    const chipLabel = recordType === 'channel_exception'
      ? chipT('assistance.chipLabel')
      : chipT('payoutAssistance.chipLabel')
    if (source) {
      const basePath = source.basePath
      const drawerParam = source.drawerParam
      rowTrailing = (row: Record<string, unknown>) => (
        <SuggestionChip
          href={buildListDrawerHref(basePath, sp, drawerParam, String(row.id))}
          label={chipLabel}
        />
      )
    }
  }
  return (
    <EntityListView
      formatValue={formatValue}
      rowTrailing={rowTrailing}
      recordType={recordType}
      orgId={productionConfig ? authz.user.productionOrgId : authz.user.orgId}
      userId={authz.user.id}
      canManage={productionConfig || can(authz, 'admin.customization.manage')}
      // Decided here for the same reason the org id is: the customer list
      // spans the relationship lifecycle only for a viewer holding
      // crm.accounts.read, and a capability that travelled through the spec
      // is a capability a spec could assert for someone who lacks it. The
      // employee list's employment filters and columns likewise require
      // hrm.employment.read — parties.read alone never shows them.
      crmAccountsVisible={can(authz, 'crm.accounts.read')}
      hrmEmploymentVisible={can(authz, 'hrm.employment.read')}
      sp={sp}
      drawer={drawer}
      emptyAction={emptyAction}
      emptyTitle={emptyTitle}
      emptyDescription={emptyDescription}
    />
  )
}
