import { ServerPagedTable } from '../../../../components/server-paged-table'
import { Badge, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { asDate } from '../../../../lib/platform-console'
import type { PlatformGrant, PlatformOrganization, PlatformUser } from '../../../../lib/platform-admin'
import { revokeAccessAction } from '../actions'
import { GrantAccessForm } from '../_components/GrantAccessForm'
import { PlatformMutationButton } from '../_components/PlatformMutationButton'
import { ViewerDateTime } from '../../../../components/viewer-format'

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
    <ListPageLayout header={<PageHeader title="Cross-org access" description="Controlled mappings between login identities and organizations. Super admins do not require grants." back={{ href: '/platform', label: 'Back to platform' }} />}>
      <div className="space-y-5">
        <GrantAccessForm members={members} organizations={organizations} actingUsers={actingUsers} />
        <ServerPagedTable
          rows={grants} rowKey={(row) => row.id}
          total={total} page={page} perPage={perPage}
          basePath={basePath} currentParams={currentParams} sort={sort} dir={dir}
          empty={filtered ? 'No grants match these filters.' : 'No grants. Grant access above to map a login into another organization.'}
          toolbar={<><SearchInput placeholder="Search member, organization, or acting user…" /><FilterChips basePath={basePath} currentParams={currentParams} paramKey="status" label="Status" options={[
            { value: 'active', label: 'Active', count: Number(statusCounts.active ?? 0) },
            { value: 'inactive', label: 'Revoked', count: Number(statusCounts.inactive ?? 0) },
          ]} /></>}
          columns={[
          { key: 'member', header: 'Member', sortKey: 'member', cell: (grant) => <IdentityCell name={grant.memberName} detail={`${grant.memberEmail} · ${grant.memberOrgName}`} /> },
          { key: 'organization', header: 'Organization', sortKey: 'organization', cell: (grant) => grant.orgName },
          { key: 'actingUser', header: 'Acts as', sortKey: 'actingUser', cell: (grant) => <ActingCell name={grant.actingName} email={grant.actingEmail} /> },
          { key: 'status', header: 'Status', cell: (grant) => <Badge variant={grant.isActive ? 'success' : 'secondary'}>{grant.isActive ? 'Active' : 'Revoked'}</Badge> },
          { key: 'updated', header: 'Last changed', sortKey: 'updated', cell: (grant) => asDate(grant.updatedAt) ? <ViewerDateTime value={asDate(grant.updatedAt)!} /> : '—' },
          { key: 'revoke', header: <span className="sr-only">Revoke</span>, className: 'w-px whitespace-nowrap px-2 text-center', style: { width: 64 }, cell: (grant) => <AccessControlCell grantId={grant.id} isActive={grant.isActive} /> },
        ]}
        />
      </div>
    </ListPageLayout>
  )
}
