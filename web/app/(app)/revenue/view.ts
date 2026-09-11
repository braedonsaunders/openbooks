import 'server-only'

import { getTranslations } from 'next-intl/server'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { isUuid, pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { loadContract } from './_lib'
import type { ContractDrawer } from './ContractDrawer'

/**
 * Revenue recognition (ASC 606), split into a loader and a spec.
 *
 * The list itself is the universal EntityListView, so the spec places a slot
 * instead of a table: the slot re-derives org/user/permissions from the
 * session. A spec that could name an org id is a cross-tenant read — the same
 * rule that put EntityListView behind `entity-list-view` when the accounts
 * and journal pages were converted. No capability travels through the spec.
 *
 * The header action (Run recognition) and the contract drawer are whole
 * components, not decomposed cells: the loader resolves the permission bit
 * and the drawer payload (with the org guard), and the widgets render them.
 * The drawer owns its per-obligation run buttons internally, exactly as on
 * the native path.
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * permission gates and the ?contract= flyout resolution (uuid guard, org
 * guard via loadContract, drawerReturn scoping).
 */

type ContractDrawerProps = Parameters<typeof ContractDrawer>[0]

export interface RevenueData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canRun: boolean
  drawerOpen: boolean
  drawer: ContractDrawerProps | null
}

export async function loadRevenue(
  sp: Record<string, string | string[] | undefined>,
): Promise<RevenueData> {
  const t = await getTranslations('revenue')

  const authz = await requirePermission('ar.read')
  const canRun = can(authz, 'ar.post')
  const orgId = authz.user.orgId

  const contractId = typeof sp.contract === 'string' ? sp.contract : undefined
  const openContract =
    contractId && isUuid(contractId) ? await loadContract(contractId, orgId) : null
  const requestedReturn = pickString(sp.drawerReturn)

  const drawer: ContractDrawerProps | null = openContract
    ? {
        payload: openContract,
        canRun,
        closeHref: requestedReturn?.startsWith('/revenue') ? requestedReturn : '/revenue',
      }
    : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    canRun,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<RevenueData>()

export function revenueSpec(data: RevenueData): PageSpec {
  const runRecognition = { widget: 'run-recognition', props: {} }
  return page({
    route: '/revenue',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(runRecognition.widget, runRecognition.props, f('canRun'))],
      }),
    ],
    body: [
      // The universal entity list, placed through a slot: it needs an org id,
      // a user id and a permission decision, none of which may travel through
      // a spec. The spec supplies only the record type and the URL it was
      // already rendering with. The native page passes no emptyAction, so
      // neither does the spec — the list's generic empty state renders.
      widgetBlock('entity-list-view', {
        recordType: 'revenue_contract',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'contract-drawer', props: { drawer: data.drawer } } : null,
      }),
    ],
  })
}
