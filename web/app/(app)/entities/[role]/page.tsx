import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { ShowInactivesToggle } from '../../../../components/show-inactives-toggle'
import { Pagination } from '../../../../components/pagination'
import { SortTh } from '../../../../components/sortable-th'
import { can, requirePermission } from '../../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../../lib/list-params'
import { loadFieldDefs } from '../../../../lib/custom-fields'
import { loadParty } from '../../../api/parties/_lib'
import { subsidiaryOptions } from '../../../../lib/subsidiaries'
import { resolveFormLayout } from '../../../../lib/customization/resolve'
import { NewPartyButton } from '../../parties/NewPartyButton'
import { NewPartyRedirect } from '../../parties/NewPartyRedirect'
import { PartyDrawer, type PartyTab } from '../../parties/PartyDrawer'
import { RelatedTransactionDrawer } from '../../../../components/related-transaction-drawer'

export const dynamic = 'force-dynamic'

// URL slug (plural) → role key (singular) + badge variant. Display copy lives
// in the `entities` catalog under roles.<slug>.* and is translated at render.
const ROLES = {
  customers: { role: 'customer', badge: 'default' as const },
  vendors: { role: 'vendor', badge: 'secondary' as const },
  employees: { role: 'employee', badge: 'outline' as const },
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
  const t = await getTranslations('entities')
  const tc = await getTranslations('common')
  const newLabel = t(`roles.${slug}.newLabel`)

  const authz = await requirePermission('parties.read')
  const canManage = can(authz, 'parties.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const partyId = typeof sp.party === 'string' ? sp.party : undefined
  const partyTransactionId = pickString(sp.partyTxn)
  const partyTransactionKind = pickString(sp.partyTxnKind)
  const requestedPartyTab = pickString(sp.partyTab)
  const partyTab: PartyTab = requestedPartyTab === 'transactions' || requestedPartyTab === 'activities' || requestedPartyTab === 'contacts'
    || requestedPartyTab === 'addresses' || requestedPartyTab === 'accounting' || requestedPartyTab === 'wages'
    ? requestedPartyTab
    : 'overview'
  const listParams = parseListParams(sp, { sort: 'name', dir: 'asc', perPage: 25, allowedSorts: ['name', 'code'] as const })
  const showInactive = pickString(sp.showInactive) === 'true'

  const where = sql`p.org_id = ${orgId} and ${ROLE_CONDITION(role)}
    ${listParams.q ? sql` and (p.display_name ilike ${'%' + listParams.q + '%'} or p.short_code ilike ${'%' + listParams.q + '%'} or p.email ilike ${'%' + listParams.q + '%'})` : sql``}
    ${showInactive ? sql`` : sql` and p.is_active`}`

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
        from parties p where p.org_id = ${orgId} and ${ROLE_CONDITION(role)} ${showInactive ? sql`` : sql`and p.is_active`}
    `) as any,
  ])
  const c = counts.rows[0]
  const total = Number(c.total)
  const filteredTotal =
    listParams.q
      ? Number(((await db.execute(sql`select count(*) as n from parties p where ${where}`)) as any).rows[0].n)
      : total

  const [openParty, pickers] = await Promise.all([
    partyId && partyId !== 'new' && isUuid(partyId) ? loadParty(partyId, orgId) : null,
    partyId
      ? Promise.all([
          db.execute(sql`select id, name from payment_terms where org_id = ${orgId} and is_active order by name`) as any,
          db.execute(sql`select id, name from departments where org_id = ${orgId} and is_active order by name`) as any,
          db.execute(sql`select id, name from trades where org_id = ${orgId} and is_active order by name`) as any,
          loadFieldDefs('parties'),
          subsidiaryOptions(),
          db.execute(sql`select id, name, type, concat_ws(' · ', number, name) as label from accounts where org_id = ${orgId} and is_active and not is_summary order by number nulls last, name`) as any,
          db.execute(sql`select id, name, concat_ws(' · ', code, name) as label from tax_codes where org_id = ${orgId} and is_active order by code`) as any,
          db.execute(sql`select p.id, p.display_name as name from parties p join employee_roles er on er.party_id = p.id and er.is_active where p.org_id = ${orgId} and p.is_active order by p.display_name`) as any,
          db.execute(sql`select id, name from worker_comp_groups where org_id = ${orgId} and is_active order by name`) as any,
        ])
      : null,
  ])
  const resolvedPartyForm = openParty && pickers
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: role,
        userRoles: [authz.user.role],
        headerDefs: pickers[3] as any,
        lineDefs: [],
        explicitLayoutId: pickString(sp.partyForm),
      })
    : null

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t(`roles.${slug}.title`)}
            description={t(`roles.${slug}.description`)}
            actions={canManage ? <NewPartyButton basePath={basePath} role={role} label={newLabel} /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder={t('list.searchPlaceholder')} />
            <ShowInactivesToggle basePath={basePath} currentParams={sp} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title={t(`roles.${slug}.emptyTitle`)}
          description={t(`roles.${slug}.emptyDescription`)}
          action={canManage ? <NewPartyButton basePath={basePath} role={role} label={newLabel} /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath={basePath} currentParams={sp} column="name" sort={listParams.sort} dir={listParams.dir}>{tc('labels.name')}</SortTh>
                <SortTh basePath={basePath} currentParams={sp} column="code" sort={listParams.sort} dir={listParams.dir}>{t('list.shortCode')}</SortTh>
                <TableHead>{tc('labels.email')}</TableHead>
                <TableHead>{t('list.phone')}</TableHead>
                <TableHead>{tc('labels.status')}</TableHead>
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
                    <Badge variant={p.is_active ? 'success' : 'outline'}>{p.is_active ? tc('status.active') : tc('status.inactive')}</Badge>
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
          key={String(openParty.party.id)}
          payload={openParty as any}
          canManage={canManage}
          canReadActivities={can(authz, 'crm.activities.read')}
          canManageWages={can(authz, 'admin.setup.manage')}
          role={role}
          initialTab={partyTab}
          basePath={basePath}
          paymentTerms={pickers[0].rows}
          departments={pickers[1].rows}
          trades={pickers[2].rows}
          workerCompGroups={pickers[8].rows}
          fieldDefs={pickers[3] as any}
          subsidiaries={pickers[4]}
          accounts={pickers[5].rows}
          taxCodes={pickers[6].rows}
          salesReps={pickers[7].rows}
          layout={resolvedPartyForm?.layout}
          forms={resolvedPartyForm?.available ?? []}
          currentFormId={resolvedPartyForm?.row?.id ?? null}
          recordType={role}
          canCustomize={can(authz, 'admin.customization.manage')}
        />
      ) : null}
      {openParty && partyTransactionId && isUuid(partyTransactionId) && partyTransactionKind ? (
        <RelatedTransactionDrawer
          id={partyTransactionId}
          kind={partyTransactionKind}
          partyId={String(openParty.party.id)}
          authz={authz}
          formLayoutId={pickString(sp.form)}
        />
      ) : null}
    </ListPageLayout>
  )
}
