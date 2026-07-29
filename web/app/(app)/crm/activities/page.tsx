import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { can, requirePermission } from '../../../../lib/authz'
import { buildListDrawerHref, isUuid, parseListParams, pickString } from '../../../../lib/list-params'
import { loadActivity } from '../../../../lib/crm'
import { CrmNewButton } from '../CrmNewButton'
import { ActivityDrawer } from '../ActivityDrawer'
export const dynamic = 'force-dynamic'
const SORTS = { subject: sql`a.subject`, customer: sql`customer.name`, date: sql`coalesce(a.starts_at,a.due_at,a.created_at)`, type: sql`a.kind`, status: sql`a.status`, owner: sql`u.name` } as const
export default async function Activities({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const authz = await requirePermission('crm.activities.read'); const manage = can(authz, 'crm.activities.manage'); const [t,locale] = await Promise.all([getTranslations('crm'),getLocale()]); const sp = await searchParams
  const list = parseListParams(sp, { sort: 'date', dir: 'desc', perPage: 25, allowedSorts: ['subject','customer','date','type','status','owner'] as const }); const kind=pickString(sp.kind); const status=pickString(sp.status); const owner=pickString(sp.owner); const openId=pickString(sp.activity)
  const from=sql`from crm_activities a left join users u on u.id=a.assigned_user_id left join lateral (select p.id,p.display_name name from crm_activity_links l join parties p on p.id=l.subject_id where l.activity_id=a.id and l.subject_kind='account' and l.org_id=a.org_id order by p.display_name limit 1) customer on true`
  const where=sql`a.org_id=${authz.user.orgId} ${list.q?sql`and (a.subject ilike ${`%${list.q}%`} or a.body ilike ${`%${list.q}%`} or customer.name ilike ${`%${list.q}%`})`:sql``} ${kind?sql`and a.kind=${kind}`:sql``} ${status?sql`and a.status=${status}`:sql``} ${owner&&isUuid(owner)?sql`and a.assigned_user_id=${owner}`:sql``}`
  const [rows,count,owners,accounts,opportunities,open]=await Promise.all([
    db.execute(sql`select a.*,u.name assigned_name,customer.id customer_id,customer.name customer_name ${from} where ${where} order by ${SORTS[list.sort]} ${list.dir==='asc'?sql`asc`:sql`desc`} nulls last limit ${list.perPage} offset ${(list.page-1)*list.perPage}`) as any,
    db.execute(sql`select count(*)::int n ${from} where ${where}`) as any,
    db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`) as any,
    db.execute(sql`select p.id,p.display_name name from crm_account_profiles cp join parties p on p.id=cp.party_id where cp.org_id=${authz.user.orgId} and cp.is_active order by p.display_name limit 2000`) as any,
    db.execute(sql`select id,opportunity_number,title from crm_opportunities where org_id=${authz.user.orgId} and is_active order by created_at desc limit 2000`) as any,
    openId&&isUuid(openId)?loadActivity(openId,authz.user.orgId):null,
  ])
  const button=manage?<CrmNewButton apiPath="/api/crm/activities/draft" basePath="/crm/activities" param="activity" label={t('activities.new')} failed={t('feedback.createFailed')} />:undefined
  return <ListPageLayout header={<><PageHeader title={t('activities.title')} description={t('activities.description')} actions={button}/><div className="flex flex-wrap gap-2"><SearchInput placeholder={t('activities.search')}/><FilterChips basePath="/crm/activities" currentParams={sp} paramKey="kind" label={t('fields.activityType')} options={['task','call','event','email','note'].map(v=>({value:v,label:t(`activityKinds.${v}`)}))}/><FilterChips basePath="/crm/activities" currentParams={sp} paramKey="status" label={t('fields.status')} options={['planned','in_progress','completed','cancelled'].map(v=>({value:v,label:t(`activityStatuses.${v}`)}))}/><FilterChips basePath="/crm/activities" currentParams={sp} paramKey="owner" label={t('fields.assignedTo')} options={owners.rows.map((o:any)=>({value:o.id,label:o.name}))}/></div></>}>
    {!rows.rows.length?<EmptyState title={t('activities.emptyTitle')} description={t('activities.emptyDescription')} action={button}/>:<><Table><TableHeader><TableRow><SortTh basePath="/crm/activities" currentParams={sp} column="subject" sort={list.sort} dir={list.dir}>{t('fields.subject')}</SortTh><SortTh basePath="/crm/activities" currentParams={sp} column="customer" sort={list.sort} dir={list.dir}>{t('fields.customer')}</SortTh><SortTh basePath="/crm/activities" currentParams={sp} column="type" sort={list.sort} dir={list.dir}>{t('fields.activityType')}</SortTh><SortTh basePath="/crm/activities" currentParams={sp} column="status" sort={list.sort} dir={list.dir}>{t('fields.status')}</SortTh><SortTh basePath="/crm/activities" currentParams={sp} column="owner" sort={list.sort} dir={list.dir}>{t('fields.assignedTo')}</SortTh><SortTh basePath="/crm/activities" currentParams={sp} column="date" sort={list.sort} dir={list.dir}>{t('fields.date')}</SortTh></TableRow></TableHeader><TableBody>{rows.rows.map((r:any)=>{const activityDate=r.starts_at??r.due_at??r.created_at;return <TableRow key={r.id}><TableCell><Link href={buildListDrawerHref('/crm/activities', sp, 'activity', String(r.id)) as any} className="font-semibold text-teal-700 hover:underline dark:text-teal-300">{r.subject}</Link></TableCell><TableCell>{r.customer_id?<Link href={`/entities/customers?party=${r.customer_id}`} className="text-teal-700 hover:underline dark:text-teal-300">{r.customer_name}</Link>:'—'}</TableCell><TableCell>{t(`activityKinds.${r.kind}`)}</TableCell><TableCell><Badge variant={r.status==='completed'?'success':'outline'}>{t(`activityStatuses.${r.status}`)}</Badge></TableCell><TableCell>{r.assigned_name??t('fields.unassigned')}</TableCell><TableCell className="whitespace-nowrap tabular-nums">{activityDate?new Date(activityDate).toLocaleString(locale):'—'}</TableCell></TableRow>})}</TableBody></Table><Pagination basePath="/crm/activities" currentParams={sp} total={Number(count.rows[0]?.n??0)} page={list.page} perPage={list.perPage}/></>}
    {open?<ActivityDrawer data={open} owners={owners.rows} accounts={accounts.rows} opportunities={opportunities.rows} canManage={manage}/>:null}
  </ListPageLayout>
}
