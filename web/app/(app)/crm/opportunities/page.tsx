import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../../lib/list-params'
import { loadOpportunity } from '../../../../lib/crm'
import { CrmNewButton } from '../CrmNewButton'
import { OpportunityDrawer } from '../OpportunityDrawer'
export const dynamic='force-dynamic'
const SORTS={number:sql`o.opportunity_number`,title:sql`o.title`,account:sql`p.display_name`,status:sql`s.sequence`,close:sql`o.expected_close_date`,amount:sql`o.projected_amount`,owner:sql`u.name`} as const
export default async function Opportunities({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const authz=await requirePermission('crm.opportunities.read');const manage=can(authz,'crm.opportunities.manage');const t=await getTranslations('crm');const sp=await searchParams;const list=parseListParams(sp,{sort:'close',dir:'asc',perPage:25,allowedSorts:['number','title','account','status','close','amount','owner'] as const});const status=pickString(sp.status);const owner=pickString(sp.owner);const category=pickString(sp.category);const openId=pickString(sp.opportunity)
 const where=sql`o.org_id=${authz.user.orgId} and o.is_active ${list.q?sql`and (o.title ilike ${`%${list.q}%`} or o.opportunity_number ilike ${`%${list.q}%`} or p.display_name ilike ${`%${list.q}%`})`:sql``} ${status&&isUuid(status)?sql`and o.status_id=${status}`:sql``} ${owner&&isUuid(owner)?sql`and o.owner_user_id=${owner}`:sql``} ${category?sql`and o.forecast_category=${category}`:sql``}`
 const [rows,count,statuses,owners,accounts,contacts,teams,sources,items,currencies,open]=await Promise.all([
  db.execute(sql`select o.*,p.display_name account_name,s.name status_name,s.is_closed,s.is_won,u.name owner_name from crm_opportunities o join crm_opportunity_statuses s on s.id=o.status_id left join parties p on p.id=o.party_id left join users u on u.id=o.owner_user_id where ${where} order by ${SORTS[list.sort]} ${list.dir==='asc'?sql`asc`:sql`desc`} nulls last limit ${list.perPage} offset ${(list.page-1)*list.perPage}`) as any,
  db.execute(sql`select count(*)::int n from crm_opportunities o join crm_opportunity_statuses s on s.id=o.status_id left join parties p on p.id=o.party_id left join users u on u.id=o.owner_user_id where ${where}`) as any,
  db.execute(sql`select * from crm_opportunity_statuses where org_id=${authz.user.orgId} and is_active order by sequence`) as any,
  db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`) as any,
  db.execute(sql`select p.id,p.display_name name from crm_account_profiles cp join parties p on p.id=cp.party_id where cp.org_id=${authz.user.orgId} and cp.is_active order by p.display_name limit 2000`) as any,
  db.execute(sql`select id,party_id,name from contacts where org_id=${authz.user.orgId} and is_active order by name limit 4000`) as any,
  db.execute(sql`select id,name from crm_sales_teams where org_id=${authz.user.orgId} and is_active order by name`) as any,
  db.execute(sql`select id,name from crm_lead_sources where org_id=${authz.user.orgId} and is_active order by name`) as any,
  db.execute(sql`select id,concat_ws(' · ',code,name) name from items where org_id=${authz.user.orgId} and is_active order by name limit 2000`) as any,
  db.execute(sql`select code,name from currencies order by code`) as any,
  openId&&isUuid(openId)?loadOpportunity(openId,authz.user.orgId):null])
 const button=manage?<CrmNewButton apiPath="/api/crm/opportunities/draft" basePath="/crm/opportunities" param="opportunity" label={t('opportunities.new')} failed={t('feedback.createFailed')}/>:undefined
 return <ListPageLayout header={<><PageHeader title={t('opportunities.title')} description={t('opportunities.description')} actions={button}/><div className="flex flex-wrap gap-2"><SearchInput placeholder={t('opportunities.search')}/><FilterChips basePath="/crm/opportunities" currentParams={sp} paramKey="status" label={t('fields.status')} options={statuses.rows.map((o:any)=>({value:o.id,label:o.name}))}/><FilterChips basePath="/crm/opportunities" currentParams={sp} paramKey="owner" label={t('fields.owner')} options={owners.rows.map((o:any)=>({value:o.id,label:o.name}))}/><FilterChips basePath="/crm/opportunities" currentParams={sp} paramKey="category" label={t('fields.forecastCategory')} options={['omitted','worst_case','most_likely','upside'].map(v=>({value:v,label:t(`forecastCategories.${v}`)}))}/></div></>}>
 {!rows.rows.length?<EmptyState title={t('opportunities.emptyTitle')} description={t('opportunities.emptyDescription')} action={button}/>:<><Table><TableHeader><TableRow><SortTh basePath="/crm/opportunities" currentParams={sp} column="number" sort={list.sort} dir={list.dir}>{t('fields.number')}</SortTh><SortTh basePath="/crm/opportunities" currentParams={sp} column="title" sort={list.sort} dir={list.dir}>{t('fields.title')}</SortTh><SortTh basePath="/crm/opportunities" currentParams={sp} column="account" sort={list.sort} dir={list.dir}>{t('fields.account')}</SortTh><SortTh basePath="/crm/opportunities" currentParams={sp} column="status" sort={list.sort} dir={list.dir}>{t('fields.status')}</SortTh><SortTh basePath="/crm/opportunities" currentParams={sp} column="owner" sort={list.sort} dir={list.dir}>{t('fields.owner')}</SortTh><SortTh basePath="/crm/opportunities" currentParams={sp} column="close" sort={list.sort} dir={list.dir}>{t('fields.expectedClose')}</SortTh><SortTh basePath="/crm/opportunities" currentParams={sp} column="amount" sort={list.sort} dir={list.dir} className="text-right">{t('fields.projectedAmount')}</SortTh></TableRow></TableHeader><TableBody>{rows.rows.map((r:any)=><TableRow key={r.id}><TableCell className="font-mono">{r.opportunity_number}</TableCell><TableCell><Link href={`/crm/opportunities?opportunity=${r.id}`} className="font-semibold text-teal-700 hover:underline dark:text-teal-300">{r.title}</Link></TableCell><TableCell>{r.account_name??'—'}</TableCell><TableCell><Badge variant={r.is_won?'success':r.is_closed?'outline':'default'}>{r.status_name}</Badge></TableCell><TableCell>{r.owner_name??t('fields.unassigned')}</TableCell><TableCell>{r.expected_close_date??'—'}</TableCell><TableCell className="text-right tabular-nums">{r.currency} {r.projected_amount}</TableCell></TableRow>)}</TableBody></Table><Pagination basePath="/crm/opportunities" currentParams={sp} total={Number(count.rows[0]?.n??0)} page={list.page} perPage={list.perPage}/></>}
 {open?<OpportunityDrawer data={open} statuses={statuses.rows} owners={owners.rows} accounts={accounts.rows} contacts={contacts.rows} teams={teams.rows} sources={sources.rows} items={items.rows} currencies={currencies.rows} canManage={manage}/>:null}
 </ListPageLayout>
}
