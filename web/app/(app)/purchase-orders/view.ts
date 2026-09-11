import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { loadOrder } from '../../api/_order/lib'
import type { OrderDrawer } from '../_order/OrderDrawer'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'
import { taxCodeOptions, taxGroupOptions } from '../../../lib/documents'
import { subsidiaryUiOptions } from '../../../lib/subsidiaries'

/**
 * Purchase orders, split into a loader and a spec.
 *
 * The page is a thin shell: the list itself is the universal RecordListView,
 * which takes capability objects (orgId, userId, live query state) a spec
 * must never carry. So the spec places a `record-list-view` slot that
 * re-derives auth server-side (the entity-list-view precedent), while the
 * loader owns everything page-specific: the header, the New button gating,
 * and the drawer payload. The drawer slot holds up to two widgets — the
 * create-redirect, then the order flyout — the same fragment the native page
 * passes, in the native order.
 */

const KIND = 'purchase_order' as const
const BASE = '/purchase-orders'
const PARAM = 'order'
const API = '/api/purchase-orders'
type OrderDrawerProps = Parameters<typeof OrderDrawer>[0]
type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

export interface PurchaseOrdersData {
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  newOrderButtonLabel: string
  createFailedMessage: string
  showNewRedirect: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
}

export async function loadPurchaseOrders(
  sp: Record<string, string | string[] | undefined>,
): Promise<PurchaseOrdersData> {
  const authz = await requirePermission('ap.read')
  await requireFeatureEnabled(authz.user.orgId, 'orders')
  const inventoryEnabled = await isFeatureEnabled(authz.user.orgId, 'inventory')
  const canManage = can(authz, 'ap.create')
  const t = await getTranslations('purchaseOrders')
  const openId = pickString(sp[PARAM])

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND) : null,
    openId && openId !== 'new'
      ? Promise.all([
          db.execute<ElementOf<OrderDrawerProps['parties']>>(sql`
            select p.id, p.display_name from parties p
             where p.org_id = ${authz.user.orgId} and p.is_active
               and exists (
                 select 1 from vendor_roles role
                  where role.org_id = p.org_id and role.party_id = p.id and role.is_active
               )
             order by p.display_name limit 2000`),
          db.execute<ElementOf<OrderDrawerProps['accounts']>>(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and is_active and not is_summary order by number nulls last`),
          db.execute<ElementOf<OrderDrawerProps['items']>>(sql`
            select id, code, name, default_rate, income_account_id, expense_account_id, tax_code_id, unit
              from items
             where org_id = ${authz.user.orgId} and is_active
               and (
                 ${inventoryEnabled ? sql`true` : sql`kind not in ('inventory', 'assembly', 'kit')`}
                 or id in (
                   select item_id from document_lines
                    where org_id = ${authz.user.orgId} and document_id = ${openId} and item_id is not null
                 )
               )
             order by name limit 2000`),
          taxCodeOptions(authz.user.orgId),
          taxGroupOptions(authz.user.orgId),
          db.execute<ElementOf<OrderDrawerProps['departments']>>(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`),
          db.execute<ElementOf<OrderDrawerProps['projects']>>(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`),
          customSegmentOptions(authz.user.orgId),
          subsidiaryUiOptions(authz.user.orgId),
        ])
      : null,
  ])
  const resolvedForm = openOrder && pickers ? await resolveFormLayout({
    orgId: authz.user.orgId, userId: authz.user.id, recordType: KIND,
    userRoles: authz.user.roles.map(({ key }) => key), headerDefs: [], lineDefs: [], explicitLayoutId: pickString(sp.form),
  }) : null
  const drawerOrder = openOrder as unknown as OrderDrawerProps['order'] | null

  return {
    title: t('list.title'),
    description: t('list.description'),
    canManage,
    currentParams: sp,
    newOrderButtonLabel: t('list.newButton'),
    createFailedMessage: t('list.createDraftFailed'),
    showNewRedirect: openId === 'new' && canManage,
    drawer:
      drawerOrder && pickers
        ? {
            remountKey: String(drawerOrder.doc.id),
            order: drawerOrder,
            initialMode: pickString(sp.mode) === 'edit' ? 'edit' : 'view',
            kind: KIND,
            parties: pickers[0].rows,
            accounts: pickers[1].rows,
            items: pickers[2].rows,
            taxCodes: pickers[3],
            taxGroups: pickers[4],
            departments: pickers[5].rows,
            projects: pickers[6].rows,
            segments: pickers[7],
            subsidiaries: pickers[8]
              .filter((subsidiary) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(subsidiary.id))
              .map((subsidiary) => ({ id: subsidiary.id, name: `${'  '.repeat(subsidiary.depth)}${subsidiary.name}` })),
            canManage,
            layout: resolvedForm?.layout,
          }
        : null,
  }
}

const f = ref<PurchaseOrdersData>()

export function purchaseOrdersSpec(data: PurchaseOrdersData): PageSpec {
  const newOrder = {
    widget: 'new-order',
    props: {
      apiPath: API,
      base: BASE,
      param: PARAM,
      label: data.newOrderButtonLabel,
      createFailedMessage: data.createFailedMessage,
    },
  }
  const newOrderRedirect = {
    widget: 'new-order-redirect',
    props: {
      apiPath: API,
      base: BASE,
      param: PARAM,
      createFailedMessage: data.createFailedMessage,
    },
  }
  return page({
    route: '/purchase-orders',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newOrder.widget, newOrder.props, f('canManage'))],
      }),
    ],
    body: [
      widgetBlock('record-list-view', {
        recordType: KIND,
        basePath: BASE,
        sp: data.currentParams,
        emptyAction: data.canManage ? newOrder : null,
        // Rendered in the native page's order: the create-redirect first,
        // then the order flyout stacked over it.
        drawer: [
          data.showNewRedirect ? newOrderRedirect : null,
          data.drawer ? { widget: 'order-drawer', props: { drawer: data.drawer } } : null,
        ].filter(Boolean),
      }),
    ],
  })
}
