'use client'

import { Badge, Card, CardContent, PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { ServerPagedTable } from '../../../../components/server-paged-table'
import type { PlatformGrant, PlatformOrganization, PlatformUser } from '../../../../lib/platform-admin'
import { asDate } from '../../../../lib/platform-console'
import { GrantAccessForm } from './GrantAccessForm'
import { PlatformMutationButton } from './PlatformMutationButton'
import { setSuperAdminAction } from '../actions'
import { GrantActingCell, GrantControlCell } from '../users/[id]/sections'
import { useViewerFormat } from '@/lib/viewer-format'

export function PlatformUserDetailClient({
  user,
  grants,
  grantsTotal,
  grantsPage,
  grantsPerPage,
  basePath,
  listParams,
  members,
  organizations,
  actingUsers,
  isSelf,
}: {
  user: PlatformUser
  grants: PlatformGrant[]
  grantsTotal: number
  grantsPage: number
  grantsPerPage: number
  basePath: string
  listParams: Record<string, string | string[] | undefined>
  members: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
  organizations: Pick<PlatformOrganization, 'id' | 'name'>[]
  actingUsers: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
  isSelf: boolean
}) {
  const { dateTime } = useViewerFormat()
  return (
    <PageContainer>
      <div className="space-y-5">
        <PageHeader
          title={user.name}
          description={`${user.email} · ${user.orgName}`}
          back={{ href: '/platform/users', label: 'Users' }}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={user.isActive ? 'success' : 'secondary'}>
                {user.isActive ? 'Active' : 'Inactive'}
              </Badge>
              {user.isSuperAdmin ? <Badge variant="warning">Super admin</Badge> : null}
              <PlatformMutationButton
                action={setSuperAdminAction.bind(null, user.id, !user.isSuperAdmin)}
                success={user.isSuperAdmin ? 'Super-admin access revoked' : 'Super-admin access granted'}
                variant={user.isSuperAdmin ? 'destructive' : 'outline'}
                disabled={isSelf && user.isSuperAdmin}
              >
                {user.isSuperAdmin ? (isSelf ? 'Current operator' : 'Revoke super admin') : 'Make super admin'}
              </PlatformMutationButton>
            </div>
          }
        />
        <GrantAccessForm
          members={members}
          organizations={organizations}
          actingUsers={actingUsers}
          defaultMemberUserId={user.id}
        />
        <ServerPagedTable
          rows={grants} rowKey={(grant) => grant.id}
          total={grantsTotal} page={grantsPage} perPage={grantsPerPage}
          basePath={basePath} currentParams={listParams}
          empty="No grants. This identity only has its home organization, unless it is a super admin."
          columns={[
            { key: 'organization', header: 'Organization', cell: (grant) => grant.orgName },
            { key: 'actingUser', header: 'Acts as', cell: (grant) => <GrantActingCell name={grant.actingName} email={grant.actingEmail} /> },
            { key: 'status', header: 'Status', cell: (grant) => <Badge variant={grant.isActive ? 'success' : 'secondary'}>{grant.isActive ? 'Active' : 'Revoked'}</Badge> },
            { key: 'revoke', header: <span className="sr-only">Revoke</span>, className: 'w-px whitespace-nowrap px-2 text-center', style: { width: 64 }, cell: (grant) => <GrantControlCell grantId={grant.id} isActive={grant.isActive} /> },
          ]}
        />
        <Card>
          <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
            {[
              { label: 'Email', value: user.email },
              { label: 'Home organization', value: user.orgName },
              { label: 'Last login', value: asDate(user.lastLoginAt) ? dateTime(asDate(user.lastLoginAt)!) : 'Never' },
              { label: 'Created', value: asDate(user.createdAt) ? dateTime(asDate(user.createdAt)!) : '—' },
              { label: 'Account ID', value: user.id, mono: true },
            ].map((fact) => (
              <div key={fact.label}>
                <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{fact.label}</div>
                <div className={fact.mono ? 'mt-1 truncate font-mono text-xs text-fg' : 'mt-1 text-sm font-semibold text-fg'}>
                  {fact.value}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  )
}
