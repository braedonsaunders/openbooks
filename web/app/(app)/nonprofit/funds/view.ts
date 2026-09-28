import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../lib/list-params'
import { groupTabs } from '../../../../components/module-home/group-tabs'

/**
 * The fund register, split into a loader and a spec.
 *
 * The fixed-asset register archetype: the list itself is the universal
 * EntityListView (`fund`), so it arrives through the slot that re-derives
 * Authz server-side. The spec carries only the record type, the current
 * params, and a widget ref for the drawer — never an org id. The drawer
 * payload (fund classification, interfund pairs, recent releases) is ledger
 * truth read here, beside the list, exactly like the asset pickers.
 */

export interface FundDetail {
  id: string
  code: string
  name: string
  kind: string
  restrictionClass: string
  budgetaryControl: string
  isActive: boolean
}

export interface FundPairLink {
  id: string
  fromFundId: string
  toFundId: string
  fromCode: string
  toCode: string
  dueFromNumber: string | null
  dueToNumber: string | null
}

export interface FundReleaseRef {
  id: string
  number: string
  amount: string
  releaseDate: string
  status: string
}

export interface FundDrawerData {
  remountKey: string
  fund: FundDetail
  pairs: FundPairLink[]
  releases: FundReleaseRef[]
  canManage: boolean
  canCustomize: boolean
  closeHref: string
}

export interface FundsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  tabs: Awaited<ReturnType<typeof groupTabs>>
  drawer: FundDrawerData | null
}

type FundRow = {
  id: string
  code: string | null
  name: string
  kind: string
  restriction_class: string
  budgetary_control: string
  is_active: boolean
}
type PairRow = {
  id: string
  from_fund_id: string
  to_fund_id: string
  from_code: string | null
  to_code: string | null
  due_from_number: string | null
  due_to_number: string | null
}
type ReleaseRow = { id: string; release_number: string; amount: string; release_date: string; status: string }

export async function loadFunds(
  sp: Record<string, string | string[] | undefined>,
): Promise<FundsData> {
  const authz = await requirePermission('funds.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'fundAccounting')
  const t = await getTranslations('nonprofit')
  const tabs = await groupTabs('nonprofit', '/nonprofit/funds', { orgId })

  const base: FundsData = {
    title: t('funds.title'),
    description: t('funds.description'),
    currentParams: sp,
    tabs,
    drawer: null,
  }

  const fundId = pickString(sp.fund)
  if (!fundId || !isUuid(fundId)) return base
  const found = (
    await db.execute<FundRow>(sql`
      select f.id::text as id, sv.code, sv.name, f.kind,
             f.restriction_class, f.budgetary_control, sv.is_active
        from funds f
        join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
       where f.org_id = ${orgId} and f.id = ${fundId}`)
  ).rows[0]
  if (!found) return base

  const [pairs, releases] = await Promise.all([
    db.execute<PairRow>(sql`
      select p.id::text as id, p.from_fund_id::text as from_fund_id,
             p.to_fund_id::text as to_fund_id,
             ff.code as from_code, tf.code as to_code,
             af.number as due_from_number, at.number as due_to_number
        from fund_pairs p
        join segment_values ff on ff.org_id = p.org_id and ff.id = p.from_fund_id
        join segment_values tf on tf.org_id = p.org_id and tf.id = p.to_fund_id
        join accounts af on af.org_id = p.org_id and af.id = p.due_from_account_id
        join accounts at on at.org_id = p.org_id and at.id = p.due_to_account_id
       where p.org_id = ${orgId} and p.is_active
         and (p.from_fund_id = ${fundId} or p.to_fund_id = ${fundId})
       order by ff.code, tf.code`),
    db.execute<ReleaseRow>(sql`
      select id::text as id, release_number, amount::text as amount,
             release_date::text as release_date, status
        from fund_releases
       where org_id = ${orgId} and (from_fund_id = ${fundId} or to_fund_id = ${fundId})
       order by release_date desc, release_number desc
       limit 5`),
  ])

  return {
    ...base,
    drawer: {
      remountKey: found.id,
      fund: {
        id: found.id,
        code: found.code ?? '',
        name: found.name,
        kind: found.kind,
        restrictionClass: found.restriction_class,
        budgetaryControl: found.budgetary_control,
        isActive: found.is_active,
      },
      pairs: pairs.rows.map((row) => ({
        id: row.id,
        fromFundId: row.from_fund_id,
        toFundId: row.to_fund_id,
        fromCode: row.from_code ?? '',
        toCode: row.to_code ?? '',
        dueFromNumber: row.due_from_number,
        dueToNumber: row.due_to_number,
      })),
      releases: releases.rows.map((row) => ({
        id: row.id,
        number: row.release_number,
        amount: row.amount,
        releaseDate: row.release_date,
        status: row.status,
      })),
      canManage: can(authz, 'funds.manage'),
      canCustomize: can(authz, 'admin.customization.manage'),
      closeHref: '/nonprofit/funds',
    },
  }
}

const f = ref<FundsData>()

export function fundsSpec(data: FundsData): PageSpec {
  return page({
    route: '/nonprofit/funds',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center justify-end gap-2',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      {
        ...widgetBlock('entity-list-view', {
          recordType: 'fund',
          sp: data.currentParams,
          drawer: [data.drawer ? { widget: 'fund-drawer', props: { drawer: data.drawer } } : null].filter(
            Boolean,
          ),
          emptyAction: null,
        }),
      },
    ],
  })
}
