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
import { mergeHref, pickString, isUuid } from '../../../lib/list-params'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { requirePermission, can } from '../../../lib/authz'
import { purchaseOrderConversionPermission } from '../../../lib/permissions'
import { CONVERSION_TARGETS } from '../../../lib/order-kinds'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { dropShipOrderStatus } from '@openbooks/engine/src/sales/drop-ship.ts'
import { loadOrder } from '../../api/_order/lib'
import type { OrderDrawer } from '../_order/OrderDrawer'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'
import { taxCodeOptions, taxGroupOptions } from "../../../lib/documents.ts";
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
const CREATE_PARAM = 'orderNew'
type OrderDrawerProps = Parameters<typeof OrderDrawer>[0]
type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

export interface PurchaseOrdersData {
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  newOrderButtonLabel: string
  baseCurrencyConfigured: boolean
  createFailedMessage: string
  showNewRedirect: boolean
  drawer: (Record<string, unknown> & { remountKey: string }) | null
}

export async function loadPurchaseOrders(
  sp: Record<string, string | string[] | undefined>,
): Promise<PurchaseOrdersData> {
  const authz = await requirePermission('purchase_orders.read')
  await requireFeatureEnabled(authz.user.orgId, 'orders')
  const inventoryEnabled = await isFeatureEnabled(authz.user.orgId, 'inventory')
  const dropShipping = await isFeatureEnabled(authz.user.orgId, 'dropShipping')
  const barcodeScanningEnabled = await isFeatureEnabled(authz.user.orgId, 'barcodeScanning')
  const canManage = can(authz, 'purchase_orders.create')
  const t = await getTranslations('purchaseOrders')
  const openId = pickString(sp[PARAM])
  // Only a real document id may reach the uuid comparison: the create view
  // (no id, or the literal 'new') must not bind '' or 'new' to a uuid column.
  const openDocumentId = openId && isUuid(openId) ? openId : null
  // Unsaved-create: ?orderNew=1 opens an editable drawer on an in-memory
  // payload — zero writes on open, zero on Cancel, one idempotent POST on
  // Save. ?order=new deep links keep working through the redirect widget.
  const creating = pickString(sp[CREATE_PARAM]) === '1' && canManage
  const opening = (openId && openId !== 'new') || creating
  // The draft currency is the org's base currency — never invented. The New
  // button needs it on every render: without a configured currency it keeps
  // the draft-API path (which refuses by name with the setup remedy) instead
  // of opening an unsaved drawer, and a direct create URL opens no draft.
  const baseCurrency = (await db.execute<{ base_currency: string | null }>(sql`select base_currency from orgs where id = ${authz.user.orgId}`)).rows[0]?.base_currency ?? null

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND, authz.allowedSubsidiaryIds) : null,
    opening
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
            select it.id, it.code, it.name, it.default_rate, it.default_cost, it.income_account_id, it.expense_account_id, it.tax_code_id, it.unit,
                   exists (select 1 from item_inventory_profiles p where p.org_id = it.org_id and p.item_id = it.id) as has_inventory_profile
              from items it
             where it.org_id = ${authz.user.orgId} and it.is_active
               and (
                 ${inventoryEnabled ? sql`true` : sql`it.kind not in ('inventory', 'assembly', 'kit')`}
                 ${openDocumentId
                   ? sql`or it.id in (
                       select item_id from document_lines
                        where org_id = ${authz.user.orgId} and document_id = ${openDocumentId} and item_id is not null
                     )`
                   : sql``}
               )
             order by it.name limit 2000`),
          taxCodeOptions(authz.user.orgId),
          taxGroupOptions(authz.user.orgId),
          db.execute<ElementOf<OrderDrawerProps['departments']>>(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`),
          db.execute<ElementOf<OrderDrawerProps['projects']>>(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`),
          customSegmentOptions(authz.user.orgId, authz.allowedSubsidiaryIds),
          subsidiaryUiOptions(authz.user.orgId),
          inventoryEnabled
            ? db.execute<ElementOf<OrderDrawerProps['stockLocations']>>(sql`
              select sl.id, sl.code, l.subsidiary_id as "subsidiaryId"
                from stock_locations sl
                join locations l on l.id = sl.location_id and l.org_id = sl.org_id
               where sl.org_id = ${authz.user.orgId} and sl.is_active and sl.kind = 'warehouse' order by sl.code`)
            : null,
        ])
      : null,
  ])
  const linkedSalesOrderId = openOrder && dropShipping
    ? (await db.execute<{ sales_order_id: string }>(sql`
        select sales_order_id from drop_ship_orders
         where org_id = ${authz.user.orgId} and purchase_order_id = ${openDocumentId}`)).rows[0]?.sales_order_id ?? null
    : null
  const dropShipLines = linkedSalesOrderId
    ? await dropShipOrderStatus(db, authz.user.orgId, linkedSalesOrderId, authz.allowedSubsidiaryIds)
    : []
  const resolvedForm = openOrder && pickers ? await resolveFormLayout({
    orgId: authz.user.orgId, userId: authz.user.id, recordType: KIND,
    userRoles: authz.user.roles.map(({ key }) => key), headerDefs: [], lineDefs: [], explicitLayoutId: pickString(sp.form),
  }) : null
  const drawerOrder = openOrder as unknown as OrderDrawerProps['order'] | null
  // In-memory payload for the unsaved drawer: a draft header with no number
  // (allocated inside the Save transaction), no lines, no links, and the
  // org's currency/today so totals and date fields render before Save.
  const createDefaults = creating
    ? { currency: baseCurrency, today: await businessToday(authz.user.orgId) }
    : null
  const unsavedOrder: OrderDrawerProps['order'] | null =
    creating && createDefaults?.currency
      ? ({
          doc: {
            id: '',
            status: 'draft',
            currency: createDefaults.currency,
            subsidiary_id: null,
            project_id: null,
            department_id: null,
            memo: null,
            due_date: null,
            document_date: createDefaults.today,
            updated_at: '',
            subtotal: '0',
            tax_total: '0',
            total: '0',
            party_id: null,
            party_name: null,
            document_number: null,
            extra_dims: {},
          },
          lines: [],
          links: [],
        } as unknown as OrderDrawerProps['order'])
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    canManage,
    currentParams: sp,
    newOrderButtonLabel: t('list.newButton'),
    baseCurrencyConfigured: baseCurrency !== null,
    createFailedMessage: t('list.createDraftFailed'),
    showNewRedirect: openId === 'new' && canManage,
    drawer:
      (creating ? unsavedOrder : drawerOrder) && pickers
        ? {
            remountKey: creating ? 'new-purchase-order' : String(drawerOrder!.doc.id),
            order: (creating ? unsavedOrder : drawerOrder)!,
            initialMode: creating || pickString(sp.mode) === 'edit' ? 'edit' : 'view',
            createMode: creating || undefined,
            closeHref: creating
              ? mergeHref(BASE, sp, { [PARAM]: undefined, [CREATE_PARAM]: undefined, mode: undefined, form: undefined })
              : undefined,
            kind: KIND,
            parties: pickers[0].rows,
            accounts: pickers[1].rows,
            items: pickers[2].rows,
            stockLocations: pickers[9]?.rows ?? [],
            taxCodes: pickers[3],
            taxGroups: pickers[4],
            departments: pickers[5].rows,
            projects: pickers[6].rows,
            segments: pickers[7],
            subsidiaries: pickers[8]
              .filter((subsidiary) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(subsidiary.id))
              .map((subsidiary) => ({ id: subsidiary.id, name: `${'  '.repeat(subsidiary.depth)}${subsidiary.name}` })),
            canManage,
            // Receiving and billing are granted apart from authoring the
            // order; the drawer offers exactly the conversions the convert
            // endpoint will accept (receiving stock also needs items.post).
            allowedConvertKinds: CONVERSION_TARGETS.purchase_order
              .map((target) => target.kind)
              .filter((target) => can(authz, purchaseOrderConversionPermission(target))
                && (target !== 'purchase_receipt' || !inventoryEnabled || can(authz, 'items.post'))),
            layout: resolvedForm?.layout,
            dropShipping,
            dropShipLines,
            canConfirmDropShip: dropShipping && can(authz, 'items.post'),
            isDropShipPurchaseOrder: linkedSalesOrderId !== null,
            barcodeScanningEnabled,
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
      createParam: data.baseCurrencyConfigured ? CREATE_PARAM : undefined,
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
      createParam: CREATE_PARAM,
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
