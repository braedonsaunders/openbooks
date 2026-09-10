import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  table,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { can, getAuthz } from '../../../../lib/authz'
import { RECORD_TYPES, RECORD_TYPE_BY_KEY, customFieldTargetFor, defaultFormLayout, type FormLayoutConfig } from '@openbooks/customization'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import type { ComponentProps } from 'react'
import type { FormDesigner } from './FormDesigner'
import type { ListViewDesigner } from './ListViewDesigner'
import { disabledRecordTypes } from '../../../../lib/customization/gates'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../lib/features'

/**
 * Record customization (forms + list views), split into a loader and a spec.
 *
 * Two tables behind a tab, each with its own pager; the views tab renders an
 * EmptyState while the forms tab renders bare headers on an empty result.
 * The branch selection stays in the loader as three presence flags
 * (`showFormsTable`, `showViewsTable`, `showViewsEmpty`) — the accounts-page
 * precedent for mutually exclusive bodies.
 *
 * The permission split is load-bearing: readers without
 * `admin.customization.manage` see only their own personal views (org-scope
 * rows are filtered at the query, including the counts), lose the back link
 * and the forms tab entirely, and never receive form payloads. The loader
 * reproduces the native gating verbatim, including `notFound` on a hidden
 * record type.
 */

type FormDesignerDef = NonNullable<ComponentProps<typeof FormDesigner>['def']>
type ListViewDesignerDef = NonNullable<ComponentProps<typeof ListViewDesigner>['def']>
interface FormListRow {
  id: string; name: string; recordType: string; isDefault: boolean;
  isActive: boolean; allowedRoles: string[] | null
}
interface ViewListRow {
  id: string; name: string; recordType: string; scope: 'org' | 'user';
  isDefault: boolean; isActive: boolean
}
interface FormCopySqlRow { name: string; layout: FormLayoutConfig }
interface FilterOptionResult { rows: Array<{ value: string; label: string }> }

const LINK = 'font-medium text-teal-700 hover:underline dark:text-teal-300'
/** The duplicate link is one size smaller than the name links beside it. */
const SMALL_LINK = 'text-sm font-medium text-teal-700 hover:underline dark:text-teal-300'

export interface CustomizationFormRow {
  id: string
  name: string
  href: string
  typeLabel: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
  showDefaultBadge: boolean
  defaultLabel: string
  rolesLabel: string
  duplicateHref: string
  duplicateLabel: string
}

export interface CustomizationViewRow {
  id: string
  name: string
  href: string
  typeLabel: string
  scopeLabel: string
  scopeVariant: 'default' | 'secondary'
  showDefaultBadge: boolean
  defaultLabel: string
  statusLabel: string
  statusVariant: 'success' | 'outline'
}

export interface CustomizationData {
  title: string
  description: string
  /** Present only for managers; the native back link is omitted otherwise. */
  showBack: boolean
  hideBack: boolean
  backHref: string
  backLabel: string
  docsHref: string
  docsLabel: string
  searchPlaceholder: string
  recordTypeFilterLabel: string
  recordTypeAllLabel: string
  recordTypeOptions: { value: string; label: string }[]
  recordTypeResetKeys: string[]
  showFormsTab: boolean
  formsTabHref: string
  viewsTabHref: string
  formsTabLabel: string
  viewsTabLabel: string
  formsTabActive: boolean
  newFormRecordType: string
  showNewForm: boolean
  newViewRecordType: string
  showNewView: boolean
  showFormsTable: boolean
  showViewsTable: boolean
  showViewsEmpty: boolean
  emptyTitle: string
  emptyDescription: string
  /** Widget name for the empty-state action, or '' for none (no record type picked). */
  emptyActionName: string
  columnName: string
  columnType: string
  columnStatus: string
  columnDefault: string
  columnActions: string
  columnScope: string
  formRows: CustomizationFormRow[]
  viewRows: CustomizationViewRow[]
  totalForms: number
  showFormsPager: boolean
  totalViews: number
  showViewsPager: boolean
  currentPage: number
  perPage: number
  formDrawerOpen: boolean
  formDrawerRecordType: string
  formDrawerDef: Record<string, unknown> | null
  formDrawerHeaderDefs: Record<string, unknown>[] | null
  formDrawerLineDefs: Record<string, unknown>[] | null
  formDrawerDuplicateFrom: { name: string; layout: FormLayoutConfig } | null
  subsidiaryEnabled: boolean
  viewDrawerOpen: boolean
  viewDrawerRecordType: string
  viewDrawerDef: Record<string, unknown> | null
  viewDrawerCanManage: boolean
  viewDrawerUserId: string
  viewDrawerShowInListDefs: Record<string, unknown>[]
  viewDrawerFilterOptions: Record<string, { value: string; label: string }[]>
  inventoryEnabled: boolean
  crmEnabled: boolean
}

export async function loadCustomization(
  sp: Record<string, string | string[] | undefined>,
): Promise<CustomizationData> {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const canManageOrg = can(authz, 'admin.customization.manage')
  const [subsidiaryUiEnabled, inventoryEnabled, crmEnabled] = await Promise.all([
    subsidiaryFeatureEnabled(authz.user.orgId),
    isFeatureEnabled(authz.user.orgId, 'inventory'),
    isFeatureEnabled(authz.user.orgId, 'crm'),
  ])
  const t = await getTranslations('customization')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const tRoot = await getTranslations()
  // Whitelist the record type — an unknown key must not reach the designer.
  // Optional-module kinds 404 when their Features switch is off; stored
  // layouts stay in the database and reappear when the switch comes back.
  const requestedType = pickString(sp.recordType)
  const catalogType = requestedType && Object.hasOwn(RECORD_TYPE_BY_KEY, requestedType) ? requestedType : null
  const hiddenKinds = new Set(await disabledRecordTypes(authz.user.orgId))
  if (catalogType && hiddenKinds.has(catalogType)) notFound()
  const recordType = catalogType
  const visibleTypes = RECORD_TYPES.filter((rt) => !hiddenKinds.has(rt.key))
  // The registry may eventually include list-only entities; every built-in
  // transaction kind currently exposes a configurable form.
  const supportsForms = canManageOrg && (!recordType || RECORD_TYPE_BY_KEY[recordType]?.supportsForms !== false)
  const tab = !supportsForms ? 'views' : pickString(sp.tab) === 'views' ? 'views' : 'forms'
  const formId = canManageOrg ? pickString(sp.form) : undefined
  const viewId = pickString(sp.view)
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 100 })

  const hiddenList = [...hiddenKinds]
  const hiddenFilter = hiddenList.length === 0
    ? sql`true`
    : sql`record_type not in (${sql.join(hiddenList.map((k) => sql`${k}`), sql`, `)})`
  const typeFilter = recordType ? sql`record_type = ${recordType}` : hiddenFilter
  const searchFilter = params.q ? sql`name ilike ${`%${params.q}%`}` : sql`true`
  const [forms, views, formCount, viewCount] = await Promise.all([
    canManageOrg ? (db.execute(sql`
      select id, name, record_type as "recordType", is_default as "isDefault",
             is_active as "isActive", allowed_roles as "allowedRoles"
        from form_layouts
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
       order by record_type, is_default desc, name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)) : Promise.resolve({ rows: [] }),
    (db.execute(sql`
      select id, name, record_type as "recordType", scope, is_default as "isDefault", is_active as "isActive"
        from list_views
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
         and ${canManageOrg ? sql`(scope = 'org' or owner_id = ${authz.user.id})` : sql`scope = 'user' and owner_id = ${authz.user.id}`}
       order by record_type, scope asc, is_default desc, name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    canManageOrg ? (db.execute(sql`
      select count(*) as n from form_layouts
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
    `)) : Promise.resolve({ rows: [{ n: 0 }] }),
    (db.execute(sql`
      select count(*) as n from list_views
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
         and ${canManageOrg ? sql`(scope = 'org' or owner_id = ${authz.user.id})` : sql`scope = 'user' and owner_id = ${authz.user.id}`}
    `)),
  ])

  const openForm =
    formId && formId !== 'new'
      ? ((await db.execute(sql`select id, name, description, is_default as "isDefault", is_active as "isActive", allowed_roles as "allowedRoles", layout, record_type as "recordType" from form_layouts where id = ${formId} and org_id = ${authz.user.orgId}`)) as unknown as { rows: FormDesignerDef[] }).rows[0] ?? null
      : null
  const openView =
    viewId && viewId !== 'new'
      ? ((await db.execute(sql`select id, name, scope, is_default as "isDefault", is_active as "isActive", config, record_type as "recordType" from list_views where id = ${viewId} and org_id = ${authz.user.orgId} and ${canManageOrg ? sql`(scope = 'org' or owner_id = ${authz.user.id})` : sql`scope = 'user' and owner_id = ${authz.user.id}`}`)) as unknown as { rows: ListViewDesignerDef[] }).rows[0] ?? null
      : null
  if (openForm?.recordType && hiddenKinds.has(openForm.recordType)) notFound()
  if (openView?.recordType && hiddenKinds.has(openView.recordType)) notFound()

  // Copy source when creating a new form from an existing/standard baseline.
  const fromParam = pickString(sp.from)
  const recordTypeLabel = (key: string) => {
    const meta = RECORD_TYPE_BY_KEY[key]
    return meta ? tRoot(meta.labelKey as never) : key.replaceAll('_', ' ')
  }
  const typeLabel = recordType ? recordTypeLabel(recordType) : ''
  let duplicateFrom: { name: string; layout: FormLayoutConfig } | null = null
  if (recordType && formId === 'new' && fromParam) {
    if (fromParam === 'standard') {
      duplicateFrom = { name: t('designer.forms.copyName', { name: t('designer.forms.standardName', { type: typeLabel }) }), layout: defaultFormLayout(recordType) }
    } else {
      const src = ((await db.execute(sql`select name, layout from form_layouts where id = ${fromParam} and org_id = ${authz.user.orgId} and record_type = ${recordType}`)) as unknown as { rows: FormCopySqlRow[] }).rows[0]
      if (src) duplicateFrom = { name: t('designer.forms.copyName', { name: src.name }), layout: src.layout as FormLayoutConfig }
    }
  }

  // Live custom-field defs feed the designer palette (header + line). The target
  // table + kind depend on the record type: documents-backed transactions key
  // defs by kind; entity types (e.g. projects) use their own table with a null
  // kind and have no line grid.
  const designerRecordType = openForm?.recordType ?? openView?.recordType ?? recordType
  const cfTarget = designerRecordType ? customFieldTargetFor(designerRecordType) : null
  const [designerHeaderDefs, designerLineDefs] = (formId || viewId) && designerRecordType && cfTarget
    ? await Promise.all([
        loadFieldDefs(cfTarget.table, cfTarget.kind),
        cfTarget.lineTable ? loadFieldDefs(cfTarget.lineTable, cfTarget.lineKind) : Promise.resolve([]),
      ])
    : [null, null]
  const viewShowInList = (designerHeaderDefs ?? []).filter((d) => d.config.showInList)
  const listFilterOptions: Record<string, { value: string; label: string }[]> = {}
  if (viewId && designerRecordType) {
    const entityFilters = RECORD_TYPE_BY_KEY[designerRecordType]?.listFilters.filter((filter) => filter.entitySource) ?? []
    await Promise.all(entityFilters.map(async (filter) => {
      let result: FilterOptionResult | null = null
      switch (filter.entitySource) {
        case 'crm_opportunity_status':
          result = await db.execute(sql`select id::text as value, name as label from crm_opportunity_statuses where org_id=${authz.user.orgId} and is_active order by sequence, name`)
          break
        case 'crm_account_status_lead':
          result = await db.execute(sql`select id::text as value, name as label from crm_account_statuses where org_id=${authz.user.orgId} and lifecycle_stage='lead' and is_active order by sequence, name`)
          break
        case 'crm_account_status_prospect':
          result = await db.execute(sql`select id::text as value, name as label from crm_account_statuses where org_id=${authz.user.orgId} and lifecycle_stage='prospect' and is_active order by sequence, name`)
          break
        case 'crm_sales_territory':
          result = await db.execute(sql`select id::text as value, name as label from crm_sales_territories where org_id=${authz.user.orgId} and is_active order by priority, name`)
          break
        case 'user':
          result = await db.execute(sql`select id::text as value, name as label from users where org_id=${authz.user.orgId} and is_active order by name`)
          break
        case 'customer':
          result = await db.execute(sql`select p.id::text as value, p.display_name as label from parties p join customer_roles r on r.party_id=p.id and r.org_id=p.org_id and r.is_active where p.org_id=${authz.user.orgId} and p.is_active order by p.display_name`)
          break
        case 'vendor':
          result = await db.execute(sql`select p.id::text as value, p.display_name as label from parties p join vendor_roles r on r.party_id=p.id and r.org_id=p.org_id and r.is_active where p.org_id=${authz.user.orgId} and p.is_active order by p.display_name`)
          break
        case 'employee':
          result = await db.execute(sql`select p.id::text as value, p.display_name as label from parties p join employee_roles r on r.party_id=p.id and r.org_id=p.org_id and r.is_active where p.org_id=${authz.user.orgId} and p.is_active order by p.display_name`)
          break
        case 'project':
          result = await db.execute(sql`select id::text as value, concat_ws(' · ', code, name) as label from projects where org_id=${authz.user.orgId} and is_active order by name`)
          break
        case 'asset_category':
          result = await db.execute(sql`select id::text as value, name as label from asset_categories where org_id=${authz.user.orgId} and is_active order by name`)
          break
        case 'account':
          result = await db.execute(sql`select id::text as value, concat_ws(' · ', number, name) as label from accounts where org_id=${authz.user.orgId} and is_active order by number nulls last, name`)
          break
        case 'bank_account':
          result = await db.execute(sql`select id::text as value, concat_ws(' · ', number, name) as label from accounts where org_id=${authz.user.orgId} and is_active and not is_summary and reconcilable order by number nulls last, name`)
          break
        case 'item':
          result = await db.execute(sql`select id::text as value, concat_ws(' · ', code, name) as label from items where org_id=${authz.user.orgId} and is_active order by name`)
          break
        case 'stock_location':
          result = await db.execute(sql`select id::text as value, concat_ws(' · ', code, name) as label from stock_locations where org_id=${authz.user.orgId} and is_active order by code`)
          break
        case 'accounting_book':
          result = await db.execute(sql`select id::text as value, name as label from accounting_books where org_id=${authz.user.orgId} and is_active order by name`)
          break
        case 'equipment_item':
          result = await db.execute(sql`select id::text as value, concat_ws(' · ', code, name) as label from items where org_id=${authz.user.orgId} and kind='equipment_charge' and is_active order by name`)
          break
        case 'pay_schedule':
          result = await db.execute(sql`select id::text as value, name as label from pay_schedules where org_id=${authz.user.orgId} and is_active order by name`)
          break
        case 'fixed_asset':
          result = await db.execute(sql`select id::text as value, concat_ws(' · ', asset_number, name) as label from fixed_assets where org_id=${authz.user.orgId} order by asset_number`)
          break
      }
      if (result) listFilterOptions[filter.key] = result.rows
    }))
  }

  const tabHref = (t2: 'forms' | 'views') => recordType
    ? `/admin/customization?recordType=${recordType}&tab=${t2}`
    : `/admin/customization?tab=${t2}`
  const totalForms = Number(formCount.rows[0]?.n ?? 0)
  const totalViews = Number(viewCount.rows[0]?.n ?? 0)

  return {
    title: t('designer.title'),
    description: t('designer.description'),
    showBack: canManageOrg,
    hideBack: !canManageOrg,
    backHref: '/admin',
    backLabel: tHub('title'),
    docsHref: '/docs/record-customization',
    docsLabel: t('designer.documentation'),
    searchPlaceholder: t('designer.searchPlaceholder'),
    recordTypeFilterLabel: t('designer.recordTypeFilter'),
    recordTypeAllLabel: t('designer.allRecordTypes'),
    recordTypeOptions: visibleTypes.map((rt) => ({
      value: rt.key,
      label: recordTypeLabel(rt.key),
    })),
    recordTypeResetKeys: ['form', 'view'],
    showFormsTab: supportsForms,
    formsTabHref: tabHref('forms'),
    viewsTabHref: tabHref('views'),
    formsTabLabel: t('designer.tabs.forms'),
    viewsTabLabel: t('designer.tabs.views'),
    formsTabActive: tab === 'forms',
    newFormRecordType: recordType ?? '',
    showNewForm: Boolean(recordType) && tab === 'forms',
    newViewRecordType: recordType ?? '',
    showNewView: Boolean(recordType) && tab === 'views',
    showFormsTable: tab === 'forms',
    showViewsTable: tab === 'views' && views.rows.length > 0,
    showViewsEmpty: tab === 'views' && views.rows.length === 0,
    emptyTitle: t('designer.list.newTitle'),
    emptyDescription: t('designer.description'),
    emptyActionName: recordType ? 'new-view' : '',
    columnName: tab === 'forms' ? t('designer.forms.name') : t('designer.list.name'),
    columnType: tCommon('labels.type'),
    columnStatus: tCommon('labels.status'),
    columnDefault: t('views.defaultBadge'),
    columnActions: tCommon('labels.actions'),
    columnScope: t('designer.list.scope'),
    formRows: (forms.rows as unknown as FormListRow[]).map((f) => ({
      id: f.id,
      name: f.name,
      href: `/admin/customization?recordType=${f.recordType}&tab=forms&form=${f.id}`,
      typeLabel: recordTypeLabel(f.recordType),
      statusLabel: f.isActive ? tCommon('labels.active') : tCommon('labels.inactive'),
      statusVariant: f.isActive ? 'success' : 'outline',
      showDefaultBadge: f.isDefault,
      defaultLabel: t('designer.forms.isDefault'),
      rolesLabel: f.allowedRoles && f.allowedRoles.length ? f.allowedRoles.join(', ') : '',
      duplicateHref: `/admin/customization?recordType=${f.recordType}&tab=forms&form=new&from=${f.id}`,
      duplicateLabel: t('designer.forms.duplicate'),
    })),
    viewRows: (views.rows as unknown as ViewListRow[]).map((v) => ({
      id: v.id,
      name: v.name,
      href: `/admin/customization?recordType=${v.recordType}&tab=views&view=${v.id}`,
      typeLabel: recordTypeLabel(v.recordType),
      scopeLabel: v.scope === 'org' ? t('designer.list.scopeOrg') : t('designer.list.scopeUser'),
      scopeVariant: v.scope === 'org' ? 'default' : 'secondary',
      showDefaultBadge: v.isDefault,
      defaultLabel: t('designer.list.isDefault'),
      statusLabel: v.isActive ? tCommon('labels.active') : tCommon('labels.inactive'),
      statusVariant: v.isActive ? 'success' : 'outline',
    })),
    totalForms,
    showFormsPager: totalForms > params.perPage,
    totalViews,
    showViewsPager: totalViews > params.perPage,
    currentPage: params.page,
    perPage: params.perPage,
    formDrawerOpen: Boolean(formId && designerRecordType),
    formDrawerRecordType: designerRecordType ?? '',
    formDrawerDef: (openForm as unknown as Record<string, unknown> | null) ?? null,
    formDrawerHeaderDefs: (designerHeaderDefs as unknown as Record<string, unknown>[] | null) ?? null,
    formDrawerLineDefs: (designerLineDefs as unknown as Record<string, unknown>[] | null) ?? null,
    formDrawerDuplicateFrom: duplicateFrom,
    subsidiaryEnabled: subsidiaryUiEnabled,
    viewDrawerOpen: Boolean(viewId && designerRecordType),
    viewDrawerRecordType: designerRecordType ?? '',
    viewDrawerDef: (openView as unknown as Record<string, unknown> | null) ?? null,
    viewDrawerCanManage: canManageOrg,
    viewDrawerUserId: authz.user.id,
    viewDrawerShowInListDefs: (viewShowInList as unknown as Record<string, unknown>[]) ?? [],
    viewDrawerFilterOptions: listFilterOptions,
    inventoryEnabled,
    crmEnabled,
  }
}

const f = ref<CustomizationData>()
const item = field
const rootF = rootRef<CustomizationData>()

export function customizationSpec(data: CustomizationData): PageSpec {
  return page({
    layout: 'list',
    header: [
      // The back link is presence, not branching: two headers with
      // complementary loader flags, only one of which ever renders.
      {
        ...pageHeader({
          title: f('title'),
          description: f('description'),
          back: { href: f('backHref'), label: f('backLabel') },
          actions: [
            widget('docs-link-button', { href: data.docsHref, label: data.docsLabel }),
            widget('new-form', { recordType: data.newFormRecordType }, f('showNewForm')),
            widget('new-view', { recordType: data.newViewRecordType }, f('showNewView')),
          ],
        }),
        when: f('showBack'),
      },
      {
        ...pageHeader({
          title: f('title'),
          description: f('description'),
          actions: [
            widget('docs-link-button', { href: data.docsHref, label: data.docsLabel }),
            widget('new-form', { recordType: data.newFormRecordType }, f('showNewForm')),
            widget('new-view', { recordType: data.newViewRecordType }, f('showNewView')),
          ],
        }),
        when: f('hideBack'),
      },
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('customization-tabs', {
          formsHref: data.formsTabHref,
          viewsHref: data.viewsTabHref,
          formsLabel: data.formsTabLabel,
          viewsLabel: data.viewsTabLabel,
          formsActive: data.formsTabActive,
          showForms: data.showFormsTab,
        }),
        widgetBlock('search-select-filter', {
          paramKey: 'recordType',
          label: data.recordTypeFilterLabel,
          options: data.recordTypeOptions,
          allLabel: data.recordTypeAllLabel,
          resetParamKeys: data.recordTypeResetKeys,
        }),
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
      ]),
    ],
    body: [
      {
        ...table({
          variant: 'app',
          rows: f('formRows'),
          rowKey: item('id'),
          columns: [
            column(rootF('columnName'), link(item('name'), item('href'), LINK)),
            column(rootF('columnType'), badge(item('typeLabel'), { variant: 'secondary' })),
            column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
            column(
              rootF('columnDefault'),
              widgetCell('form-default-cell', {
                showDefault: item('showDefaultBadge'),
                defaultLabel: item('defaultLabel'),
                rolesLabel: item('rolesLabel'),
              }),
            ),
            column(rootF('columnActions'), link(item('duplicateLabel'), item('duplicateHref'), SMALL_LINK), {
              align: 'right',
            }),
          ],
        }),
        when: f('showFormsTable'),
      },
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: data.emptyActionName,
          actionProps: { recordType: data.newViewRecordType },
        }),
        when: f('showViewsEmpty'),
      },
      {
        ...table({
          variant: 'app',
          rows: f('viewRows'),
          rowKey: item('id'),
          columns: [
            column(rootF('columnName'), link(item('name'), item('href'), LINK)),
            column(rootF('columnType'), badge(item('typeLabel'), { variant: 'secondary' })),
            column(
              rootF('columnScope'),
              widgetCell('view-scope-cell', {
                scopeLabel: item('scopeLabel'),
                scopeVariant: item('scopeVariant'),
                showDefault: item('showDefaultBadge'),
                defaultLabel: item('defaultLabel'),
              }),
            ),
            column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
          ],
        }),
        when: f('showViewsTable'),
      },
      {
        ...pagination({
          basePath: '/admin/customization',
          total: f('totalForms'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('showFormsPager'),
      },
      {
        ...pagination({
          basePath: '/admin/customization',
          total: f('totalViews'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('showViewsPager'),
      },
      widgetBlock(
        'form-drawer',
        {
          recordType: data.formDrawerRecordType,
          def: data.formDrawerDef,
          headerDefs: data.formDrawerHeaderDefs,
          lineDefs: data.formDrawerLineDefs,
          duplicateFrom: data.formDrawerDuplicateFrom,
          subsidiaryEnabled: data.subsidiaryEnabled,
        },
        f('formDrawerOpen'),
      ),
      widgetBlock(
        'list-view-drawer',
        {
          recordType: data.viewDrawerRecordType,
          def: data.viewDrawerDef,
          canManageOrg: data.viewDrawerCanManage,
          userId: data.viewDrawerUserId,
          showInListDefs: data.viewDrawerShowInListDefs,
          filterOptions: data.viewDrawerFilterOptions,
          inventoryEnabled: data.inventoryEnabled,
          crmEnabled: data.crmEnabled,
        },
        f('viewDrawerOpen'),
      ),
    ],
  })
}

