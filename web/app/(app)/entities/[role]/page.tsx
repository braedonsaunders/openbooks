import Link from 'next/link'
import { notFound } from 'next/navigation'
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
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { loadParty } from '../../../api/parties/_lib'
import { NewPartyButton } from '../../parties/NewPartyButton'
import { NewPartyRedirect } from '../../parties/NewPartyRedirect'
import { PartyDrawer } from '../../parties/PartyDrawer'

export const dynamic = 'force-dynamic'

// URL slug (plural) → role key (singular) + display metadata.
const ROLES = {
  customers: { role: 'customer', title: 'Customers', desc: 'Companies and people you invoice.', badge: 'default' as const },
  vendors: { role: 'vendor', title: 'Vendors', desc: 'Suppliers you buy from and pay.', badge: 'secondary' as const },
  employees: { role: 'employee', title: 'Employees', desc: 'People on payroll and expense reports.', badge: 'outline' as const },
} as const

const ROLE_CONDITION = (role: string) =>
  sql`(exists (select 1 from ${sql.raw(role + '_roles')} r where r.party_id = p.id and r.is_active) or p.custom->>'nsKind' = ${role})`

const SORT_COLUMNS = { name: sql`p.display_name`, code: sql`p.short_code` } as const

export default async function EntityRole({
  params,
  searchParams,
}: {
  params: Promise<{ role: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { role: slug } = await params
  const meta = ROLES[slug as keyof typeof ROLES]
  if (!meta) notFound()
  const role = meta.role
  const basePath = `/entities/${slug}`

  const authz = await requirePermission('parties.read')
  const canManage = can(authz, 'parties.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const partyId = typeof sp.party === 'string' ? sp.party : undefined
  const listParams = parseListParams(sp, { sort: 'name', dir: 'asc', perPage: 25, allowedSorts: ['name', 'code'] as const })
  const statusParam = pickString(sp.status)
  const status = statusParam === 'active' || statusParam === 'inactive' ? statusParam : undefined

  const where = sql`p.org_id = ${orgId} and ${ROLE_CONDITION(role)}
    ${listParams.q ? sql` and (p.display_name ilike ${'%' + listParams.q + '%'} or p.short_code ilike ${'%' + listParams.q + '%'} or p.email ilike ${'%' + listParams.q + '%'})` : sql``}
    ${status === 'active' ? sql` and p.is_active` : status === 'inactive' ? sql` and not p.is_active` : sql``}`

  const [parties, counts] = await Promise.all([
    db.execute(sql`
      select p.id, p.display_name, p.short_code, p.email, p.phone, p.is_active
        from parties p where ${where}
       order by ${SORT_COLUMNS[listParams.sort]} ${listParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${listParams.perPage} offset ${(listParams.page - 1) * listParams.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total,
             count(*) filter (where p.is_active) as active,
             count(*) filter (where not p.is_active) as inactive
        from parties p where p.org_id = ${orgId} and ${ROLE_CONDITION(role)}
    `) as any,
  ])
  const c = counts.rows[0]
  const total = Number(c.total)
  const filteredTotal =
    listParams.q || status
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

  const statusOptions = [
    { value: 'active', label: 'Active', count: Number(c.active) },
    { value: 'inactive', label: 'Inactive', count: Number(c.inactive) },
  ]

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={meta.title}
            description={meta.desc}
            actions={canManage ? <NewPartyButton basePath={basePath} role={role} label={`New ${role}`} /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search name, code, email…" />
            <FilterChips basePath={basePath} currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={`No ${meta.title.toLowerCase()} yet`}
          description={`Add the first ${role} to start the directory.`}
          action={canManage ? <NewPartyButton basePath={basePath} role={role} label={`New ${role}`} /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath={basePath} currentParams={sp} column="name" sort={listParams.sort} dir={listParams.dir}>Name</SortTh>
                <SortTh basePath={basePath} currentParams={sp} column="code" sort={listParams.sort} dir={listParams.dir}>Short code</SortTh>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parties.rows.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="font-semibold">
                    <Link href={`${basePath}?party=${p.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {p.display_name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-[13px]">{p.short_code}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{p.email}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{p.phone}</TableCell>
                  <TableCell>
                    <Badge variant={p.is_active ? 'success' : 'outline'}>{p.is_active ? 'Active' : 'Inactive'}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath={basePath} currentParams={sp} total={filteredTotal} page={listParams.page} perPage={listParams.perPage} />
          </div>
        </>
      )}

      {partyId === 'new' && canManage ? <NewPartyRedirect basePath={basePath} role={role} /> : null}
      {openParty && pickers ? (
        <PartyDrawer
          payload={openParty as any}
          canManage={canManage}
          basePath={basePath}
          paymentTerms={pickers[0].rows}
          departments={pickers[1].rows}
          trades={pickers[2].rows}
          fieldDefs={pickers[3] as any}
        />
      ) : null}
    </ListPageLayout>
  )
}
