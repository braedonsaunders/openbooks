import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { pickString } from '../../../lib/list-params'
import { can, requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { loadOrder } from '../../api/_order/lib'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'
import { taxCodeOptions, taxGroupOptions } from '../../../lib/documents'
import { subsidiaryUiOptions } from '../../../lib/subsidiaries'
import type { OrderDrawer } from '../_order/OrderDrawer'

/**
 * Sales orders, split into a loader and a spec.
 *
 * The list itself is the universal RecordListView, so the spec places the
 * `record-list-view` slot instead of a table: the slot re-derives
 * org/user/permissions from the session. A spec that could name an org id is
 * a cross-tenant read — the same rule that puts EntityListView behind
 * `entity-list-view`. The AR-invoices conversion proposed the record-list
 * equivalent (`record-list-view` widget + `RecordListSlot`); this page places
 * the same widget with its own drawer and empty-action refs.
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * `ar.read` gate, the `orders` feature gate (404 when disabled), the
 * `?order=` flyout resolution with its pickers, and the form-layout
 * resolution. The drawer payload, the form layout, and the New-button labels
 * are data, so they travel through the loader result and the widgets render
 * them.
 */

const KIND = 'sales_order' as const
const BASE = '/sales-orders'
const PARAM = 'order'
const API = '/api/sales-orders'

type OrderDrawerProps = Parameters<typeof OrderDrawer>[0]
type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

export interface SalesOrderDrawer {
  /** Remount key: switching orders must reset the drawer's client state. */
  remountKey: string
  order: OrderDrawerProps['order']
  initialMode: 'edit' | 'view'
  kind: typeof KIND
  parties: OrderDrawerProps['parties']
  accounts: OrderDrawerProps['accounts']
  items: OrderDrawerProps['items']
  taxCodes: OrderDrawerProps['taxCodes']
  taxGroups: OrderDrawerProps['taxGroups']
  departments: OrderDrawerProps['departments']
  projects: OrderDrawerProps['projects']
  segments: OrderDrawerProps['segments']
  subsidiaries: { id: string; name: string }[]
  canManage: boolean
  canOverrideCredit: boolean
  layout: OrderDrawerProps['layout']
}

export interface SalesOrdersData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  newButton: {
    apiPath: string
    base: string
    param: string
    label: string
    createFailedMessage: string
  }
  showNewRedirect: boolean
  newRedirect: {
    apiPath: string
    base: string
    param: string
    createFailedMessage: string
  }
  drawerOpen: boolean
  drawer: SalesOrderDrawer | null
}

export async function loadSalesOrders(
  sp: Record<string, string | string[] | undefined>,
): Promise<SalesOrdersData> {
  const authz = await requirePermission('ar.read')
  await requireFeatureEnabled(authz.user.orgId, 'orders')
  const inventoryEnabled = await isFeatureEnabled(authz.user.orgId, 'inventory')
  const canManage = can(authz, 'ar.create')
  const t = await getTranslations('salesOrders')
  const openId = pickString(sp[PARAM])

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND) : null,
    openId && openId !== 'new'
      ? Promise.all([
          db.execute<ElementOf<OrderDrawerProps['parties']>>(sql`
            select p.id, p.display_name from parties p
             where p.org_id = ${authz.user.orgId} and p.is_active
               and exists (
                 select 1 from customer_roles cr
                  where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active
               )
             order by p.display_name limit 2000`),
          db.execute<ElementOf<OrderDrawerProps['accounts']>>(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and type in ('income','income_other') and is_active and not is_summary order by number nulls last`),
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

  const newButton = {
    apiPath: API,
    base: BASE,
    param: PARAM,
    label: t('list.newButton'),
    createFailedMessage: t('list.createDraftFailed'),
  }

  const drawer =
    drawerOrder && pickers
      ? {
          remountKey: String(drawerOrder.doc.id),
          order: drawerOrder,
          initialMode: (pickString(sp.mode) === 'edit' ? 'edit' : 'view') as 'edit' | 'view',
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
          canOverrideCredit: can(authz, 'ar.approve'),
          layout: resolvedForm?.layout,
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    canManage,
    newButton,
    showNewRedirect: openId === 'new' && canManage,
    newRedirect: {
      apiPath: API,
      base: BASE,
      param: PARAM,
      createFailedMessage: t('list.createDraftFailed'),
    },
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<SalesOrdersData>()

export function salesOrdersSpec(data: SalesOrdersData): PageSpec {
  const newOrder = {
    widget: 'new-order',
    props: {
      apiPath: data.newButton.apiPath,
      base: data.newButton.base,
      param: data.newButton.param,
      label: data.newButton.label,
      createFailedMessage: data.newButton.createFailedMessage,
    },
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newOrder.widget, newOrder.props, f('canManage'))],
      }),
    ],
    body: [
      // The universal record list, placed through a slot: it needs an org id,
      // a user id and a permission decision, none of which may travel through
      // a spec. The `?order=new` redirect is a component (it fires a POST in
      // an effect), so it rides the `newRedirect` presence flag as a widget
      // the slot does not own — it renders alongside the list, exactly where
      // the native drawer fragment sits.
      widgetBlock('record-list-view', {
        recordType: 'sales_order',
        basePath: '/sales-orders',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'order-drawer', props: { drawer: data.drawer } } : null,
        emptyAction: data.canManage ? newOrder : null,
      }),
      widgetBlock(
        'new-order-redirect',
        {
          apiPath: data.newRedirect.apiPath,
          base: data.newRedirect.base,
          param: data.newRedirect.param,
          createFailedMessage: data.newRedirect.createFailedMessage,
        },
        f('showNewRedirect'),
      ),
    ],
  })
}
