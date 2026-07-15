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
import { loadFieldDefs } from '../../../lib/custom-fields'
import { loadParty } from '../../api/parties/_lib'
import { NewPartyButton } from './NewPartyButton'
import { NewPartyRedirect } from './NewPartyRedirect'
import { PartyDrawer } from './PartyDrawer'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  name: sql`p.display_name`,
  code: sql`p.short_code`,
} as const

// A party "is" a customer/vendor/employee when a live role row exists. The
// legacy sync tag (custom->>'nsKind') also counts until roles are backfilled.
const ROLE_CONDITIONS = {
  customer: sql`(exists (select 1 from customer_roles r where r.party_id = p.id and r.is_active) or p.custom->>'nsKind' = 'customer')`,
  vendor: sql`(exists (select 1 from vendor_roles r where r.party_id = p.id and r.is_active) or p.custom->>'nsKind' = 'vendor')`,
  employee: sql`(exists (select 1 from employee_roles r where r.party_id = p.id and r.is_active) or p.custom->>'nsKind' = 'employee')`,
} as const

export default async function Parties({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('parties.read')
  const canManage = can(authz, 'parties.manage')
  const orgId = authz.user.orgId
  const t = await getTranslations('parties')
  const tc = await getTranslations('common')

  const sp = await searchParams
  const partyId = typeof sp.party === 'string' ? sp.party : undefined
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'code'] as const,
  })
  const roleParam = pickString(sp.role)
  const role = roleParam === 'customer' || roleParam === 'vendor' || roleParam === 'employee' ? roleParam : undefined
  const statusParam = pickString(sp.status)
  const status = statusParam === 'active' || statusParam === 'inactive' ? statusParam : undefined

  const where = sql`p.org_id = ${orgId}
    ${
      params.q
        ? sql` and (p.display_name ilike ${'%' + params.q + '%'} or p.short_code ilike ${'%' + params.q + '%'} or p.email ilike ${'%' + params.q + '%'})`
        : sql``
    }
    ${role ? sql` and ${ROLE_CONDITIONS[role]}` : sql``}
    ${status === 'active' ? sql` and p.is_active` : status === 'inactive' ? sql` and not p.is_active` : sql``}`

  const [parties, counts] = await Promise.all([
    db.execute(sql`
      select p.id, p.display_name, p.short_code, p.email, p.phone, p.is_active,
             ${ROLE_CONDITIONS.customer} as is_customer,
             ${ROLE_CONDITIONS.vendor} as is_vendor,
             ${ROLE_CONDITIONS.employee} as is_employee
        from parties p
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total,
             count(*) filter (where ${ROLE_CONDITIONS.customer}) as customers,
             count(*) filter (where ${ROLE_CONDITIONS.vendor}) as vendors,
             count(*) filter (where ${ROLE_CONDITIONS.employee}) as employees,
             count(*) filter (where p.is_active) as active,
             count(*) filter (where not p.is_active) as inactive
        from parties p
       where p.org_id = ${orgId}
    `) as any,
  ])
  const c = counts.rows[0]
  const total = Number(c.total)
  const filteredTotal =
    params.q || role || status
      ? Number(((await db.execute(sql`select count(*) as n from parties p where ${where}`)) as any).rows[0].n)
      : total

  const [openParty, pickers] = await Promise.all([
    partyId && partyId !== 'new' && isUuid(partyId) ? loadParty(partyId, orgId) : null,
    partyId
      ? Promise.all([
          db.execute(sql`select id, name from payment_terms where is_active order by name`) as any,
          db.execute(sql`select id, name from departments where is_active order by name`) as any,
          db.execute(sql`select id, name from trades where is_active order by name`) as any,
          loadFieldDefs('parties'),
        ])
      : null,
  ])

  const roleOptions = [
    { value: 'customer', label: tc('labels.customer'), count: Number(c.customers) },
    { value: 'vendor', label: tc('labels.vendor'), count: Number(c.vendors) },
    { value: 'employee', label: tc('labels.employee'), count: Number(c.employees) },
  ]
  const statusOptions = [
    { value: 'active', label: tc('status.active'), count: Number(c.active) },
    { value: 'inactive', label: tc('status.inactive'), count: Number(c.inactive) },
  ]

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('list.title')}
            description={t('list.description')}
            actions={canManage ? <NewPartyButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <FilterChips basePath="/parties" currentParams={sp} paramKey="role" label={tc('labels.role')} options={roleOptions} />
            <FilterChips basePath="/parties" currentParams={sp} paramKey="status" label={tc('labels.status')} options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t('list.emptyTitle')}
          description={t('list.emptyDescription')}
          action={canManage ? <NewPartyButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/parties" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>{tc('labels.name')}</SortTh>
                <SortTh basePath="/parties" currentParams={sp} column="code" sort={params.sort} dir={params.dir}>{t('list.shortCode')}</SortTh>
                <TableHead>{t('list.roles')}</TableHead>
                <TableHead>{tc('labels.email')}</TableHead>
                <TableHead>{t('list.phone')}</TableHead>
                <TableHead>{tc('labels.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parties.rows.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="font-semibold">
                    <Link href={`/parties?party=${p.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {p.display_name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{p.short_code}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {p.is_customer ? <Badge variant="default">{tc('labels.customer')}</Badge> : null}
                      {p.is_vendor ? <Badge variant="secondary">{tc('labels.vendor')}</Badge> : null}
                      {p.is_employee ? <Badge variant="outline">{tc('labels.employee')}</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{p.email}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{p.phone}</TableCell>
                  <TableCell>
                    <Badge variant={p.is_active ? 'success' : 'outline'}>{p.is_active ? tc('status.active') : tc('status.inactive')}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/parties" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {partyId === 'new' && canManage ? <NewPartyRedirect /> : null}
      {openParty && pickers ? (
        <PartyDrawer
          key={String(openParty.party.id)}
          payload={openParty as any}
          paymentTerms={pickers[0].rows}
          departments={pickers[1].rows}
          trades={pickers[2].rows}
          fieldDefs={pickers[3] as any}
          canManage={canManage}
        />
      ) : null}
    </ListPageLayout>
  )
}
