import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { mergeHref, pickString, isUuid } from '../../../lib/list-params'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { requirePermission, can } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { isFeatureEnabled } from '../../../lib/features'
import { loadOrder } from '../../api/_order/lib'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { customSegmentOptions } from '../../../lib/segments'
import { taxCodeOptions, taxGroupOptions } from "../../../lib/documents.ts";
import { subsidiaryUiOptions } from '../../../lib/subsidiaries'

/**
 * Estimates (quotes), split into a loader and a spec. The loader copies the
 * native page's query, permission and formatting logic verbatim: ar.read gate,
 * the orders feature gate (404 when the module is off), the inventory flag
 * for the items picker, the customer-scoped parties picker, the income-only
 * accounts picker, the ?estimate= drawer with its form-layout resolution, and
 * the ?estimate=new create redirect.
 *
 * The list itself is the universal RecordListView — a whole host component
 * placed by name through the `record-list-view` widget (see
 * the registry entry), the same arrangement the AP bills page uses. The header
 * carries only the New button (`new-estimate-order` widget, named after the
 * shared _order components two sibling pages will reuse).
 *
 * The drawer composes TWO widgets when open: the redirect (create flow) and
 * the OrderDrawer flyout (record flow). The native page renders both as
 * siblings inside one fragment, and the entity-list slot accepts a list of
 * widget refs for exactly this shape.
 */

const KIND = 'quote' as const
const BASE = '/estimates'
const PARAM = 'estimate'
const API = '/api/estimates'
const CREATE_PARAM = 'estimateNew'

type ElementOf<T> = NonNullable<T> extends readonly (infer Item)[] ? Item : never

export interface EstimateDrawer {
  remountKey: string
  order: unknown
  initialMode: 'edit' | 'view'
  createMode?: boolean
  closeHref?: string
  kind: string
  parties: unknown
  accounts: unknown
  items: unknown
  stockLocations: unknown
  taxCodes: unknown
  taxGroups: unknown
  departments: unknown
  projects: unknown
  segments: unknown
  subsidiaries: unknown
  canManage: boolean
  canOverrideCredit: boolean
  layout: unknown
}

export interface EstimatesData {
  title: string
  description: string
  canManage: boolean
  currentParams: Record<string, string | string[] | undefined>
  newOrder: {
    apiPath: string
    base: string
    param: string
    label: string
    createFailedMessage: string
  }
  showNewRedirect: boolean
  redirectFailedMessage: string
  drawerOpen: boolean
  drawer: EstimateDrawer | null
}

export async function loadEstimates(
  sp: Record<string, string | string[] | undefined>,
): Promise<EstimatesData> {
  const authz = await requirePermission('ar.read')
  await requireFeatureEnabled(authz.user.orgId, 'orders')
  const inventoryEnabled = await isFeatureEnabled(authz.user.orgId, 'inventory')
  const canManage = can(authz, 'ar.create')
  const t = await getTranslations('estimates')
  const openId = pickString(sp[PARAM])
  // Only a real document id may reach the uuid comparison: the create view
  // (no id, or the literal 'new') must not bind '' or 'new' to a uuid column.
  const openDocumentId = openId && isUuid(openId) ? openId : null
  // Unsaved-create: ?estimateNew=1 opens an editable drawer on an in-memory
  // payload — zero writes on open, zero on Cancel, one idempotent POST on
  // Save. ?estimate=new deep links keep working through the redirect widget.
  const creating = pickString(sp[CREATE_PARAM]) === '1' && canManage
  const opening = (openId && openId !== 'new') || creating

  const [openOrder, pickers] = await Promise.all([
    openId && openId !== 'new' ? loadOrder(openId, authz.user.orgId, KIND, authz.allowedSubsidiaryIds) : null,
    opening
      ? Promise.all([
          db.execute(sql`
            select p.id, p.display_name from parties p
             where p.org_id = ${authz.user.orgId} and p.is_active
               and exists (
                 select 1 from customer_roles cr
                  where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active
               )
             order by p.display_name limit 2000`),
          db.execute(sql`select id, number, name from accounts where org_id = ${authz.user.orgId} and type in ('income','income_other') and is_active and not is_summary order by number nulls last`),
          db.execute(sql`
            select it.id, it.code, it.name, it.default_rate, it.income_account_id, it.expense_account_id, it.tax_code_id, it.unit,
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
          db.execute(sql`select id, name from departments where org_id = ${authz.user.orgId} and is_active order by name`),
          db.execute(sql`select id, name from projects where org_id = ${authz.user.orgId} and is_active order by name limit 2000`),
          customSegmentOptions(authz.user.orgId),
          subsidiaryUiOptions(authz.user.orgId),
          inventoryEnabled
            ? db.execute(sql`
              select id, code from stock_locations
               where org_id = ${authz.user.orgId} and is_active order by code`)
            : null,
        ])
      : null,
  ])
  const resolvedForm =
    (openOrder || creating) && pickers
      ? await resolveFormLayout({
          orgId: authz.user.orgId,
          userId: authz.user.id,
          recordType: KIND,
          userRoles: authz.user.roles.map(({ key }) => key),
          headerDefs: [],
          lineDefs: [],
          explicitLayoutId: pickString(sp.form),
        })
      : null
  const drawerOrder = openOrder as unknown as Record<string, unknown> | null
  // In-memory payload for the unsaved drawer: a draft header with no number
  // (allocated inside the Save transaction), no lines, no links, and the
  // org's currency/today so totals and date fields render before Save.
  const createDefaults = creating
    ? await (async () => {
        const [orgRow, today] = await Promise.all([
          db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${authz.user.orgId}`),
          businessToday(authz.user.orgId),
        ])
        return { currency: orgRow.rows[0]?.base_currency ?? 'CAD', today }
      })()
    : null
  const unsavedOrder: Record<string, unknown> | null =
    creating && createDefaults
      ? {
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
        }
      : null

  const drawer: EstimateDrawer | null =
    (drawerOrder || unsavedOrder) && pickers
      ? {
          remountKey: creating ? 'new-quote' : String(((drawerOrder as Record<string, unknown>).doc as Record<string, unknown>).id),
          order: (creating ? unsavedOrder : drawerOrder) as unknown,
          initialMode: creating || pickString(sp.mode) === 'edit' ? 'edit' : 'view',
          createMode: creating || undefined,
          closeHref: creating
            ? mergeHref(BASE, sp, { [PARAM]: undefined, [CREATE_PARAM]: undefined, mode: undefined, form: undefined })
            : undefined,
          kind: KIND,
          parties: (pickers[0] as { rows: unknown }).rows,
          accounts: (pickers[1] as { rows: unknown }).rows,
          items: (pickers[2] as { rows: unknown }).rows,
          stockLocations: (pickers[9] as { rows: unknown } | null)?.rows ?? [],
          taxCodes: pickers[3] as ElementOf<unknown[]> as unknown,
          taxGroups: pickers[4] as ElementOf<unknown[]> as unknown,
          departments: (pickers[5] as { rows: unknown }).rows,
          projects: (pickers[6] as { rows: unknown }).rows,
          segments: pickers[7] as unknown,
          subsidiaries: (
            pickers[8] as { id: string; name: string; depth?: number }[]
          )
            .filter(
              (subsidiary) =>
                !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(subsidiary.id),
            )
            .map((subsidiary) => ({
              id: subsidiary.id,
              name: `${'  '.repeat(subsidiary.depth ?? 0)}${subsidiary.name}`,
            })),
          canManage,
          canOverrideCredit: can(authz, 'ar.approve'),
          layout: resolvedForm?.layout,
        }
      : null

  return {
    title: t('list.title'),
    description: t('list.description'),
    canManage,
    currentParams: sp,
    newOrder: {
      apiPath: API,
      base: BASE,
      param: PARAM,
      label: t('list.newButton'),
      createFailedMessage: t('list.createDraftFailed'),
    },
    showNewRedirect: openId === 'new' && canManage,
    redirectFailedMessage: t('list.createDraftFailed'),
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<EstimatesData>()

export function estimatesSpec(data: EstimatesData): PageSpec {
  const newOrder = {
    widget: 'new-order',
    props: {
      apiPath: data.newOrder.apiPath,
      base: data.newOrder.base,
      param: data.newOrder.param,
      createParam: CREATE_PARAM,
      label: data.newOrder.label,
      createFailedMessage: data.newOrder.createFailedMessage,
    },
  }
  return page({
    route: '/estimates',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget(newOrder.widget, newOrder.props, f('canManage'))],
      }),
    ],
    body: [
      {
        ...widgetBlock('record-list-view', {
          recordType: KIND,
          basePath: BASE,
          drawerParam: PARAM,
          sp: data.currentParams,
          drawer: [
            ...(data.showNewRedirect
              ? [
                  {
                    widget: 'new-order-redirect',
                    props: {
                      apiPath: data.newOrder.apiPath,
                      base: data.newOrder.base,
                      param: data.newOrder.param,
                      createParam: CREATE_PARAM,
                      createFailedMessage: data.redirectFailedMessage,
                    },
                  },
                ]
              : []),
            ...(data.drawer
              ? [{ widget: 'order-drawer', props: { drawer: data.drawer } }]
              : []),
          ],
          emptyAction: data.canManage ? newOrder : null,
        }),
      },
    ],
  })
}
