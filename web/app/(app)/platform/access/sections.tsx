import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Pagination } from '../../../../components/pagination'
import { PerPageSelect } from '../../../../components/per-page-select'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { SortTh } from '../../../../components/sortable-th'
import { asDate } from '../../../../lib/platform-console'
import type { PlatformGrant, PlatformOrganization, PlatformUser } from '../../../../lib/platform-admin'
import { revokeAccessAction } from '../actions'
import { GrantAccessForm } from '../_components/GrantAccessForm'
import { PlatformMutationButton } from '../_components/PlatformMutationButton'

/**
 * Two composite cells in the cross-org access list.
 *
 * The control cell is the notable one: it binds a SERVER ACTION to a specific
 * grant id. A bound function is exactly what a spec must never carry — it is
 * not serializable and it is authority, not presentation — so the spec passes
 * the id and the binding happens here.
 */

/** Name over a muted "email · organization" line. */
export function IdentityCell({ name, detail }: { name: string; detail: string }) {
  return (
    <>
      <div className="font-medium">{name}</div>
      <div className="text-xs text-slate-500">{detail}</div>
    </>
  )
}

/** Plain name over a muted email. */
export function ActingCell({ name, email }: { name: string; email: string }) {
  return (
    <>
      <div>{name}</div>
      <div className="text-xs text-slate-500">{email}</div>
    </>
  )
}

/** Revoke button while the grant is live; a history note once it is not. */
export function AccessControlCell({ grantId, isActive }: { grantId: string; isActive: boolean }) {
  if (!isActive) return <span className="text-xs text-slate-400">History preserved</span>
  return (
    <PlatformMutationButton
      action={revokeAccessAction.bind(null, grantId)}
      success="Cross-organization access revoked"
      size="sm"
      variant="ghost"
    >
      Revoke
    </PlatformMutationButton>
  )
}

/**
 * The cross-org access list on the house list composition (toolbar + sortable
 * table + pager), driven server-side by platformGrants.
 *
 * It replaces the AppKit RecordList wrapper, which paged only by swapping
 * the fetched page under a client-side table: search, sort and the grant
 * form all read a single page as the control plane. Sort, search, status
 * and page size now travel on the URL and narrow in SQL; the grant form and
 * the revoke control are unchanged client islands. The row cells stay the
 * shared cells above that the viewspec platform widgets also render.
 */
export function AccessList({
  grants,
  total,
  page,
  perPage,
  sort,
  dir,
  status,
  statusCounts,
  basePath,
  currentParams,
  members,
  organizations,
  actingUsers,
}: {
  grants: PlatformGrant[]
  total: number
  page: number
  perPage: number
  sort: 'member' | 'organization' | 'actingUser' | 'updated'
  dir: 'asc' | 'desc'
  status: 'active' | 'inactive' | undefined
  statusCounts: Record<string, number>
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  members: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
  organizations: Pick<PlatformOrganization, 'id' | 'name'>[]
  actingUsers: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
}) {
  const filtered = currentParams.q !== undefined || status !== undefined
  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Cross-org access"
            description="Controlled mappings between login identities and organizations. Super admins do not require grants."
            back={{ href: '/platform', label: 'Back to platform' }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search member, organization, or acting user…" />
            <FilterChips
              basePath={basePath}
              currentParams={currentParams}
              paramKey="status"
              label="Status"
              options={[
                { value: 'active', label: 'Active', count: Number(statusCounts.active ?? 0) },
                { value: 'inactive', label: 'Revoked', count: Number(statusCounts.inactive ?? 0) },
              ]}
            />
            <PerPageSelect basePath={basePath} currentParams={currentParams} perPage={perPage} />
          </div>
        </>
      }
    >
      <div className="space-y-5">
        <GrantAccessForm members={members} organizations={organizations} actingUsers={actingUsers} />
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <SortTh basePath={basePath} currentParams={currentParams} column="member" sort={sort} dir={dir}>
                    Member
                  </SortTh>
                  <SortTh basePath={basePath} currentParams={currentParams} column="organization" sort={sort} dir={dir}>
                    Organization
                  </SortTh>
                  <SortTh basePath={basePath} currentParams={currentParams} column="actingUser" sort={sort} dir={dir}>
                    Acts as
                  </SortTh>
                  <TableHead>Status</TableHead>
                  <SortTh basePath={basePath} currentParams={currentParams} column="updated" sort={sort} dir={dir}>
                    Last changed
                  </SortTh>
                  <TableHead className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                    <span className="sr-only">Revoke</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
                      {filtered
                        ? 'No grants match these filters.'
                        : 'No grants. Grant access above to map a login into another organization.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  grants.map((grant) => (
                    <TableRow key={grant.id}>
                      <TableCell>
                        <IdentityCell
                          name={grant.memberName}
                          detail={`${grant.memberEmail} · ${grant.memberOrgName}`}
                        />
                      </TableCell>
                      <TableCell className="text-slate-600 dark:text-slate-400">{grant.orgName}</TableCell>
                      <TableCell>
                        <ActingCell name={grant.actingName} email={grant.actingEmail} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={grant.isActive ? 'success' : 'secondary'}>
                          {grant.isActive ? 'Active' : 'Revoked'}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-slate-600 dark:text-slate-400">
                        {(asDate(grant.updatedAt) ?? new Date()).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                        <AccessControlCell grantId={grant.id} isActive={grant.isActive} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <Pagination basePath={basePath} currentParams={currentParams} total={total} page={page} perPage={perPage} />
        </div>
      </div>
    </ListPageLayout>
  )
}
