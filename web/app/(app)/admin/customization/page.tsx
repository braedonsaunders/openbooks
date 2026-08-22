import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { BookOpen } from 'lucide-react'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { SearchSelectFilter } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { can, getAuthz } from '../../../../lib/authz'
import { RECORD_TYPES, RECORD_TYPE_BY_KEY, customFieldTargetFor, defaultFormLayout, type FormLayoutConfig } from '@openbooks/customization'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { FormDesigner, NewFormButton } from './FormDesigner'
import { ListViewDesigner, NewViewButton } from './ListViewDesigner'
import { disabledRecordTypes } from '../../../../lib/customization/gates'
import { isFeatureEnabled, subsidiaryFeatureEnabled } from '../../../../lib/features'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('customization')
  return { title: t('designer.title') }
}

export default async function CustomizationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  const canManageOrg = can(authz, 'admin.customization.manage')
  const [subsidiaryUiEnabled, inventoryEnabled] = await Promise.all([
    subsidiaryFeatureEnabled(authz.user.orgId),
    isFeatureEnabled(authz.user.orgId, 'inventory'),
  ])
  const t = await getTranslations('customization')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const tRoot = await getTranslations()
  const sp = await searchParams
  // Whitelist the record type — an unknown key must not reach the designer.
  // Optional-module kinds 404 when their Features switch is off; stored
  // layouts stay in the database and reappear when the switch comes back.
  const requestedType = pickString(sp.recordType)
  const catalogType = requestedType && requestedType in RECORD_TYPE_BY_KEY ? requestedType : null
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
    canManageOrg ? db.execute(sql`
      select id, name, record_type as "recordType", is_default as "isDefault",
             is_active as "isActive", allowed_roles as "allowedRoles"
        from form_layouts
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
       order by record_type, is_default desc, name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any : Promise.resolve({ rows: [] }),
    db.execute(sql`
      select id, name, record_type as "recordType", scope, is_default as "isDefault", is_active as "isActive"
        from list_views
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
         and ${canManageOrg ? sql`(scope = 'org' or owner_id = ${authz.user.id})` : sql`scope = 'user' and owner_id = ${authz.user.id}`}
       order by record_type, scope asc, is_default desc, name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    canManageOrg ? db.execute(sql`
      select count(*) as n from form_layouts
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
    `) as any : Promise.resolve({ rows: [{ n: 0 }] }),
    db.execute(sql`
      select count(*) as n from list_views
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
         and ${canManageOrg ? sql`(scope = 'org' or owner_id = ${authz.user.id})` : sql`scope = 'user' and owner_id = ${authz.user.id}`}
    `) as any,
  ])

  const openForm =
    formId && formId !== 'new'
      ? ((await db.execute(sql`select id, name, description, is_default as "isDefault", is_active as "isActive", allowed_roles as "allowedRoles", layout, record_type as "recordType" from form_layouts where id = ${formId} and org_id = ${authz.user.orgId}`)) as any).rows[0] ?? null
      : null
  const openView =
    viewId && viewId !== 'new'
      ? ((await db.execute(sql`select id, name, scope, is_default as "isDefault", is_active as "isActive", config, record_type as "recordType" from list_views where id = ${viewId} and org_id = ${authz.user.orgId} and ${canManageOrg ? sql`(scope = 'org' or owner_id = ${authz.user.id})` : sql`scope = 'user' and owner_id = ${authz.user.id}`}`)) as any).rows[0] ?? null
      : null
  if (openForm && hiddenKinds.has(openForm.recordType)) notFound()
  if (openView && hiddenKinds.has(openView.recordType)) notFound()

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
      const src = ((await db.execute(sql`select name, layout from form_layouts where id = ${fromParam} and org_id = ${authz.user.orgId} and record_type = ${recordType}`)) as any).rows[0]
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
      let result: any = null
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

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={canManageOrg ? { href: '/admin', label: tHub('title') } : undefined}
            title={t('designer.title')}
            description={t('designer.description')}
            actions={(
              <>
                <Button asChild variant="outline" size="sm">
                  <Link href="/docs/record-customization"><BookOpen size={14} aria-hidden />{t('designer.documentation')}</Link>
                </Button>
                {recordType ? (tab === 'forms' ? <NewFormButton recordType={recordType} /> : <NewViewButton recordType={recordType} />) : null}
              </>
            )}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
              {supportsForms ? (
                <Link
                  href={tabHref('forms')}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === 'forms' ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                >
                  {t('designer.tabs.forms')}
                </Link>
              ) : null}
              <Link
                href={tabHref('views')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === 'views' ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
              >
                {t('designer.tabs.views')}
              </Link>
            </div>
            <SearchSelectFilter
              paramKey="recordType"
              label={t('designer.recordTypeFilter')}
              allLabel={t('designer.allRecordTypes')}
              resetParamKeys={['form', 'view']}
              options={visibleTypes.map((rt) => ({
                value: rt.key,
                label: recordTypeLabel(rt.key),
              }))}
            />
            <SearchInput placeholder={t('designer.searchPlaceholder')} />
          </div>
        </>
      }
    >
      {tab === 'forms' ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('designer.forms.name')}</TableHead>
                <TableHead>{tCommon('labels.type')}</TableHead>
                <TableHead>{tCommon('labels.status')}</TableHead>
                <TableHead>{t('views.defaultBadge')}</TableHead>
                <TableHead className="text-right">{tCommon('labels.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.rows.map((f: any) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <Link href={`/admin/customization?recordType=${f.recordType}&tab=forms&form=${f.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {f.name}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{recordTypeLabel(f.recordType)}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={f.isActive ? 'success' : 'outline'}>{f.isActive ? tCommon('labels.active') : tCommon('labels.inactive')}</Badge>
                  </TableCell>
                  <TableCell>
                    {f.isDefault ? <Badge variant="default">{t('designer.forms.isDefault')}</Badge> : null}{' '}
                    {f.allowedRoles && f.allowedRoles.length ? <span className="text-xs text-slate-400">{f.allowedRoles.join(', ')}</span> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/admin/customization?recordType=${f.recordType}&tab=forms&form=new&from=${f.id}`} className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {t('designer.forms.duplicate')}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalForms > params.perPage ? (
            <div className="mt-3">
              <Pagination basePath="/admin/customization" currentParams={sp} total={totalForms} page={params.page} perPage={params.perPage} />
            </div>
          ) : null}
        </>
      ) : views.rows.length === 0 ? (
        <EmptyState title={t('designer.list.newTitle')} description={t('designer.description')} action={recordType ? <NewViewButton recordType={recordType} /> : undefined} />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('designer.list.name')}</TableHead>
                <TableHead>{tCommon('labels.type')}</TableHead>
                <TableHead>{t('designer.list.scope')}</TableHead>
                <TableHead>{tCommon('labels.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {views.rows.map((v: any) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <Link href={`/admin/customization?recordType=${v.recordType}&tab=views&view=${v.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                      {v.name}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="secondary">{recordTypeLabel(v.recordType)}</Badge></TableCell>
                  <TableCell>
                    <Badge variant={v.scope === 'org' ? 'default' : 'secondary'}>
                      {v.scope === 'org' ? t('designer.list.scopeOrg') : t('designer.list.scopeUser')}
                    </Badge>
                    {v.isDefault ? <Badge variant="outline">{t('designer.list.isDefault')}</Badge> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={v.isActive ? 'success' : 'outline'}>{v.isActive ? tCommon('labels.active') : tCommon('labels.inactive')}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalViews > params.perPage ? (
            <div className="mt-3">
              <Pagination basePath="/admin/customization" currentParams={sp} total={totalViews} page={params.page} perPage={params.perPage} />
            </div>
          ) : null}
        </>
      )}

      {formId && designerRecordType ? <FormDesigner recordType={designerRecordType} def={openForm} headerDefs={designerHeaderDefs as any} lineDefs={designerLineDefs as any} duplicateFrom={duplicateFrom} subsidiaryEnabled={subsidiaryUiEnabled} /> : null}
      {viewId && designerRecordType ? <ListViewDesigner recordType={designerRecordType} def={openView} canManageOrg={canManageOrg} userId={authz.user.id} showInListDefs={viewShowInList as any} filterOptions={listFilterOptions} inventoryEnabled={inventoryEnabled} /> : null}
    </ListPageLayout>
  )
}
