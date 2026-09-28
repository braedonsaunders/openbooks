import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getFundRelease } from '@openbooks/engine/src/nonprofit/releases.ts'
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
 * That row arrives through the canonical release reader, never a parallel
 * query, so the drawer and the adapter cannot disagree about a release. The
 * approvals tab reuses the native approval actions and history, bound to
 * the adapter's `fund_release` subject kind. This page lands before any
 * release-submitting surface: drafts are submitted elsewhere, decided here.
 * A named release the reader cannot see is a stale or foreign link, so it
 * ends on the shared not-found boundary instead of an empty page.
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
  const found = await getFundRelease({ orgId, releaseId })
  if (!found) notFound()

  return {
    ...base,
    drawer: {
      remountKey: found.id,
      release: {
        id: found.id,
        number: found.number,
        releaseDate: found.releaseDate,
        amount: found.amount,
        purpose: found.purpose,
        satisfactionRef: found.satisfactionRef,
        status: found.status,
        fromCode: found.fromCode ?? found.fromName,
        fromName: found.fromName,
        toCode: found.toCode ?? found.toName,
        toName: found.toName,
        postedEntryId: found.postedEntryId,
        voidEntryId: found.voidEntryId,
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
