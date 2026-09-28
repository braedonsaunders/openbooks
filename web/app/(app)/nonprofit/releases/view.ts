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
 * The fund-release register, split into a loader and a spec.
 *
 * The fixed-asset register archetype again: the universal EntityListView
 * (`fund_release`) carries the list through the Authz-re-deriving slot, and
 * the drawer payload reads the same release row the flow adapter resolves —
 * from/to fund codes, lifecycle status, and the posted/void entry evidence.
 * The approvals tab reuses the native approval actions and history, bound to
 * the adapter's `fund_release` subject kind. This page lands before any
 * release-submitting surface: drafts are submitted elsewhere, decided here.
 */

export interface ReleaseDetail {
  id: string
  number: string
  releaseDate: string
  amount: string
  purpose: string
  satisfactionRef: string
  status: string
  fromCode: string
  fromName: string
  toCode: string
  toName: string
  postedEntryId: string | null
  voidEntryId: string | null
}

export interface ReleaseDrawerData {
  remountKey: string
  release: ReleaseDetail
  canManage: boolean
  canCustomize: boolean
  closeHref: string
}

export interface ReleasesData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  tabs: Awaited<ReturnType<typeof groupTabs>>
  drawer: ReleaseDrawerData | null
}

type ReleaseRow = {
  id: string
  release_number: string
  release_date: string
  amount: string
  purpose: string
  satisfaction_ref: string
  status: string
  from_code: string | null
  from_name: string
  to_code: string | null
  to_name: string
  posted_entry_id: string | null
  void_entry_id: string | null
}

export async function loadReleases(
  sp: Record<string, string | string[] | undefined>,
): Promise<ReleasesData> {
  const authz = await requirePermission('funds.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'fundAccounting')
  const t = await getTranslations('nonprofit')
  const tabs = await groupTabs('nonprofit', '/nonprofit/releases', { orgId })

  const base: ReleasesData = {
    title: t('releases.title'),
    description: t('releases.description'),
    currentParams: sp,
    tabs,
    drawer: null,
  }

  const releaseId = pickString(sp.release)
  if (!releaseId || !isUuid(releaseId)) return base
  const found = (
    await db.execute<ReleaseRow>(sql`
      select r.id::text as id, r.release_number, r.release_date::text as release_date,
             r.amount::text as amount, r.purpose, r.satisfaction_ref, r.status,
             ff.code as from_code, ff.name as from_name,
             tf.code as to_code, tf.name as to_name,
             r.posted_entry_id::text as posted_entry_id,
             r.void_entry_id::text as void_entry_id
        from fund_releases r
        join segment_values ff on ff.org_id = r.org_id and ff.id = r.from_fund_id
        join segment_values tf on tf.org_id = r.org_id and tf.id = r.to_fund_id
       where r.org_id = ${orgId} and r.id = ${releaseId}`)
  ).rows[0]
  if (!found) return base

  return {
    ...base,
    drawer: {
      remountKey: found.id,
      release: {
        id: found.id,
        number: found.release_number,
        releaseDate: found.release_date,
        amount: found.amount,
        purpose: found.purpose,
        satisfactionRef: found.satisfaction_ref,
        status: found.status,
        fromCode: found.from_code ?? found.from_name,
        fromName: found.from_name,
        toCode: found.to_code ?? found.to_name,
        toName: found.to_name,
        postedEntryId: found.posted_entry_id,
        voidEntryId: found.void_entry_id,
      },
      canManage: can(authz, 'funds.manage'),
      canCustomize: can(authz, 'admin.customization.manage'),
      closeHref: '/nonprofit/releases',
    },
  }
}

const f = ref<ReleasesData>()

export function releasesSpec(data: ReleasesData): PageSpec {
  return page({
    route: '/nonprofit/releases',
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
          recordType: 'fund_release',
          sp: data.currentParams,
          drawer: [data.drawer ? { widget: 'release-drawer', props: { drawer: data.drawer } } : null].filter(
            Boolean,
          ),
          emptyAction: null,
        }),
      },
    ],
  })
}
