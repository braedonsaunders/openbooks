import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { RECORD_TYPES, RECORD_TYPE_BY_KEY, defaultFormLayout, type FormLayoutConfig } from '@openbooks/customization'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { FormDesigner, NewFormButton } from './FormDesigner'
import { ListViewDesigner, NewViewButton } from './ListViewDesigner'
import { ensureCustomizationDefaults } from '../../../../lib/customization/seed-defaults'

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
  const authz = await requirePermission('admin.customization.manage')
  const t = await getTranslations('customization')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
  const sp = await searchParams
  // Whitelist the record type — an unknown key must not reach the designer.
  const requestedType = pickString(sp.recordType)
  const recordType = requestedType && requestedType in RECORD_TYPE_BY_KEY ? requestedType : null
  // The registry may eventually include list-only entities; every built-in
  // transaction kind currently exposes a configurable form.
  const supportsForms = !recordType || RECORD_TYPE_BY_KEY[recordType]?.supportsForms !== false
  const tab = !supportsForms ? 'views' : pickString(sp.tab) === 'views' ? 'views' : 'forms'
  const formId = pickString(sp.form)
  const viewId = pickString(sp.view)
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 100 })

  // Provision every baseline in one pass so Forms & Views always exposes an
  // editable default for the full catalog, not a virtual one-off fallback.
  await ensureCustomizationDefaults({ orgId: authz.user.orgId, actorId: authz.user.id })

  const typeFilter = recordType ? sql`record_type = ${recordType}` : sql`true`
  const searchFilter = params.q ? sql`name ilike ${`%${params.q}%`}` : sql`true`
  const [forms, views, formCount, viewCount] = await Promise.all([
    db.execute(sql`
      select id, name, record_type as "recordType", is_default as "isDefault",
             is_active as "isActive", allowed_roles as "allowedRoles"
        from form_layouts
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
       order by record_type, is_default desc, name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select id, name, record_type as "recordType", scope, is_default as "isDefault", is_active as "isActive"
        from list_views
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
         and (scope = 'org' or owner_id = ${authz.user.id})
       order by record_type, scope asc, is_default desc, name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as n from form_layouts
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
    `) as any,
    db.execute(sql`
      select count(*) as n from list_views
       where org_id = ${authz.user.orgId} and ${typeFilter} and ${searchFilter}
         and (scope = 'org' or owner_id = ${authz.user.id})
    `) as any,
  ])

  const openForm =
    formId && formId !== 'new'
      ? ((await db.execute(sql`select id, name, description, is_default as "isDefault", is_active as "isActive", allowed_roles as "allowedRoles", layout, record_type as "recordType" from form_layouts where id = ${formId} and org_id = ${authz.user.orgId}`)) as any).rows[0] ?? null
      : null
  const openView =
    viewId && viewId !== 'new'
      ? ((await db.execute(sql`select id, name, scope, is_default as "isDefault", is_active as "isActive", config, record_type as "recordType" from list_views where id = ${viewId} and org_id = ${authz.user.orgId} and (scope = 'org' or owner_id = ${authz.user.id})`)) as any).rows[0] ?? null
      : null

  // Copy source when creating a new form from an existing/standard baseline.
  const fromParam = pickString(sp.from)
  const typeLabel = recordType ? t(`recordTypes.${recordType}` as never) : ''
  let duplicateFrom: { name: string; layout: FormLayoutConfig } | null = null
  if (recordType && formId === 'new' && fromParam) {
    if (fromParam === 'standard') {
      duplicateFrom = { name: t('designer.forms.copyName', { name: t('designer.forms.standardName', { type: typeLabel }) }), layout: defaultFormLayout(recordType) }
    } else {
      const src = ((await db.execute(sql`select name, layout from form_layouts where id = ${fromParam} and org_id = ${authz.user.orgId} and record_type = ${recordType}`)) as any).rows[0]
      if (src) duplicateFrom = { name: t('designer.forms.copyName', { name: src.name }), layout: src.layout as FormLayoutConfig }
    }
  }

  // Live custom-field defs feed the designer palette (header + line).
  const designerRecordType = openForm?.recordType ?? openView?.recordType ?? recordType
  const [designerHeaderDefs, designerLineDefs] = (formId || viewId) && designerRecordType
    ? await Promise.all([
        loadFieldDefs('documents', designerRecordType),
        loadFieldDefs('document_lines', designerRecordType),
      ])
    : [null, null]
  const viewShowInList = (designerHeaderDefs ?? []).filter((d) => d.config.showInList)

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
            back={{ href: '/admin', label: tHub('title') }}
            title={t('designer.title')}
            description={t('designer.description')}
            actions={recordType ? (tab === 'forms' ? <NewFormButton recordType={recordType} /> : <NewViewButton recordType={recordType} />) : undefined}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <Link
              href={`/admin/customization?tab=${tab}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                !recordType
                  ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/40 dark:text-teal-300'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
              }`}
            >
              {t('designer.allRecordTypes')}
            </Link>
            {RECORD_TYPES.map((rt) => (
              <Link
                key={rt.key}
                href={`/admin/customization?recordType=${rt.key}&tab=${tab}`}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  rt.key === recordType
                    ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/40 dark:text-teal-300'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300'
                }`}
              >
                {t(`recordTypes.${rt.key}` as never)}
              </Link>
            ))}
          </div>
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
                  <TableCell><Badge variant="secondary">{t(`recordTypes.${f.recordType}` as never)}</Badge></TableCell>
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
                  <TableCell><Badge variant="secondary">{t(`recordTypes.${v.recordType}` as never)}</Badge></TableCell>
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

      {formId && designerRecordType ? <FormDesigner recordType={designerRecordType} def={openForm} headerDefs={designerHeaderDefs as any} lineDefs={designerLineDefs as any} duplicateFrom={duplicateFrom} /> : null}
      {viewId && designerRecordType ? <ListViewDesigner recordType={designerRecordType} def={openView} canManageOrg={true} userId={authz.user.id} showInListDefs={viewShowInList as any} /> : null}
    </ListPageLayout>
  )
}
