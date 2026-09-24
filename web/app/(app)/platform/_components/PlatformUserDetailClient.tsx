'use client'

import { Badge, Card, CardContent, PageContainer, PageHeader } from '@braedonsaunders/appkit-ui'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import type { PlatformGrant, PlatformOrganization, PlatformUser } from '../../../../lib/platform-admin'
import { asDate } from '../../../../lib/platform-console'
import { Pagination } from '../../../../components/pagination'
import { PerPageSelect } from '../../../../components/per-page-select'
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
        <div className="space-y-3">
          <div className="flex justify-end">
            <PerPageSelect basePath={basePath} currentParams={listParams} perPage={grantsPerPage} />
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead>Acts as</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                      <span className="sr-only">Revoke</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grants.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
                        No grants. This identity only has its home organization, unless it is a super admin.
                      </TableCell>
                    </TableRow>
                  ) : (
                    grants.map((grant) => (
                      <TableRow key={grant.id}>
                        <TableCell className="font-medium text-slate-900 dark:text-slate-100">
                          {grant.orgName}
                        </TableCell>
                        <TableCell>
                          <GrantActingCell name={grant.actingName} email={grant.actingEmail} />
                        </TableCell>
                        <TableCell>
                          <Badge variant={grant.isActive ? 'success' : 'secondary'}>
                            {grant.isActive ? 'Active' : 'Revoked'}
                          </Badge>
                        </TableCell>
                        <TableCell className="w-px whitespace-nowrap px-2 text-center" style={{ width: 64 }}>
                          <GrantControlCell grantId={grant.id} isActive={grant.isActive} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <Pagination
              basePath={basePath}
              currentParams={listParams}
              total={grantsTotal}
              page={grantsPage}
              perPage={grantsPerPage}
            />
          </div>
        </div>
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
