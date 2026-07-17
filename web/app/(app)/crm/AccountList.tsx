import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { loadParty } from '../../api/parties/_lib'
import { loadCrmAccount } from '../../../lib/crm'
import { CrmNewButton } from './CrmNewButton'
import { AccountDrawer } from './AccountDrawer'

const SORTS = { name: sql`p.display_name`, status: sql`s.sequence`, owner: sql`u.name`, activity: sql`cp.last_activity_at` } as const

export async function AccountList({ stage, searchParams }: { stage: 'lead' | 'prospect'; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const authz = await requirePermission('crm.accounts.read')
  const canManage = can(authz, 'crm.accounts.manage')
  const canCreate = can(authz, 'crm.accounts.create')
  const t = await getTranslations('crm')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const basePath = stage === 'lead' ? '/crm/leads' : '/crm/prospects'
  const openId = pickString(sp.account)
  const status = pickString(sp.status)
  const owner = pickString(sp.owner)
  const list = parseListParams(sp, { sort: 'activity', dir: 'desc', perPage: 25, allowedSorts: ['name', 'status', 'owner', 'activity'] as const })
  const where = sql`cp.org_id=${authz.user.orgId} and cp.lifecycle_stage=${stage} and cp.is_active and p.is_active
    ${list.q ? sql`and (p.display_name ilike ${`%${list.q}%`} or p.email ilike ${`%${list.q}%`} or p.phone ilike ${`%${list.q}%`})` : sql``}
    ${status && isUuid(status) ? sql`and cp.status_id=${status}` : sql``}
    ${owner && isUuid(owner) ? sql`and cp.owner_user_id=${owner}` : sql``}`
  const [rows, count, statuses, owners, territories, sources, open] = await Promise.all([
    db.execute(sql`select p.id,p.display_name,p.email,p.phone,cp.qualification_score,cp.last_activity_at,cp.next_action_at,s.name status_name,u.name owner_name,t.name territory_name
      from crm_account_profiles cp join parties p on p.id=cp.party_id left join crm_account_statuses s on s.id=cp.status_id left join users u on u.id=cp.owner_user_id left join crm_sales_territories t on t.id=cp.territory_id
      where ${where} order by ${SORTS[list.sort]} ${list.dir === 'asc' ? sql`asc` : sql`desc`} nulls last limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`) as any,
    db.execute(sql`select count(*)::int n from crm_account_profiles cp join parties p on p.id=cp.party_id left join crm_account_statuses s on s.id=cp.status_id left join users u on u.id=cp.owner_user_id where ${where}`) as any,
    db.execute(sql`select id,name,lifecycle_stage from crm_account_statuses where org_id=${authz.user.orgId} and is_active order by lifecycle_stage,sequence`) as any,
    db.execute(sql`select id,name from users where org_id=${authz.user.orgId} and is_active order by name`) as any,
    db.execute(sql`select id,name from crm_sales_territories where org_id=${authz.user.orgId} and is_active order by priority,name`) as any,
    db.execute(sql`select id,name from crm_lead_sources where org_id=${authz.user.orgId} and is_active order by name`) as any,
    openId && isUuid(openId) ? Promise.all([loadParty(openId, authz.user.orgId), loadCrmAccount(openId, authz.user.orgId)]) : null,
  ])
  const accountData = open?.[0] && open?.[1] ? { ...open[0], crm: open[1] } : null
  const newButton = canCreate ? <CrmNewButton apiPath="/api/crm/accounts/draft" basePath={basePath} param="account" label={t(`accounts.${stage}.new`)} failed={t('feedback.createFailed')} /> : undefined
  return <ListPageLayout header={<><PageHeader title={t(`accounts.${stage}.title`)} description={t(`accounts.${stage}.description`)} actions={newButton} /><div className="flex flex-wrap gap-2"><SearchInput placeholder={t('accounts.search')} /><FilterChips basePath={basePath} currentParams={sp} paramKey="status" label={t('fields.status')} options={statuses.rows.filter((s: any) => s.lifecycle_stage === stage).map((s: any) => ({ value: s.id, label: s.name }))} /><FilterChips basePath={basePath} currentParams={sp} paramKey="owner" label={t('fields.owner')} options={owners.rows.map((o: any) => ({ value: o.id, label: o.name }))} /></div></>}>
    {!rows.rows.length ? <EmptyState title={t(`accounts.${stage}.emptyTitle`)} description={t(`accounts.${stage}.emptyDescription`)} action={newButton} /> : <><Table><TableHeader><TableRow><SortTh basePath={basePath} currentParams={sp} column="name" sort={list.sort} dir={list.dir}>{t('fields.accountName')}</SortTh><SortTh basePath={basePath} currentParams={sp} column="status" sort={list.sort} dir={list.dir}>{t('fields.status')}</SortTh><SortTh basePath={basePath} currentParams={sp} column="owner" sort={list.sort} dir={list.dir}>{t('fields.owner')}</SortTh><TableHead>{t('fields.territory')}</TableHead><TableHead>{t('fields.qualificationScore')}</TableHead><SortTh basePath={basePath} currentParams={sp} column="activity" sort={list.sort} dir={list.dir}>{t('fields.lastActivity')}</SortTh></TableRow></TableHeader><TableBody>{rows.rows.map((row: any) => <TableRow key={row.id}><TableCell><Link className="font-semibold text-teal-700 hover:underline dark:text-teal-300" href={`${basePath}?account=${row.id}`}>{row.display_name}</Link><div className="text-xs text-slate-500">{row.email || row.phone}</div></TableCell><TableCell><Badge>{row.status_name ?? tc('labels.none')}</Badge></TableCell><TableCell>{row.owner_name ?? t('fields.unassigned')}</TableCell><TableCell>{row.territory_name ?? '—'}</TableCell><TableCell className="tabular-nums">{row.qualification_score ?? '—'}</TableCell><TableCell>{row.last_activity_at ? new Date(row.last_activity_at).toLocaleDateString() : '—'}</TableCell></TableRow>)}</TableBody></Table><Pagination basePath={basePath} currentParams={sp} total={Number(count.rows[0]?.n ?? 0)} page={list.page} perPage={list.perPage} /></>}
    {accountData ? <AccountDrawer data={accountData} statuses={statuses.rows} owners={owners.rows} territories={territories.rows} sources={sources.rows} basePath={basePath} canManage={canManage} /> : null}
  </ListPageLayout>
}
