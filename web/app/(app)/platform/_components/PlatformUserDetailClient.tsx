'use client'

import { Badge, Card, CardContent, PageContainer, PageHeader, RecordList } from '@braedonsaunders/appkit-ui'
import type { PlatformGrant, PlatformOrganization, PlatformUser } from '../../../../lib/platform-admin'
import { asDate } from '../../../../lib/platform-console'
import { GrantAccessForm } from './GrantAccessForm'
import { PlatformMutationButton } from './PlatformMutationButton'
import { revokeAccessAction, setSuperAdminAction } from '../actions'

export function PlatformUserDetailClient({
  user,
  grants,
  members,
  organizations,
  actingUsers,
  isSelf,
}: {
  user: PlatformUser
  grants: PlatformGrant[]
  members: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
  organizations: Pick<PlatformOrganization, 'id' | 'name'>[]
  actingUsers: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
  isSelf: boolean
}) {
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
        <RecordList
          columns={[
            {
              key: 'orgName',
              label: 'Organization',
              render: (row) => <span className="font-medium text-fg">{row.orgName}</span>,
            },
            {
              key: 'acting',
              label: 'Acts as',
              render: (row) => (
                <div>
                  <div>{row.actingName}</div>
                  <div className="text-xs text-fg-muted">{row.actingEmail}</div>
                </div>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              render: (row) => (
                <Badge variant={row.isActive ? 'success' : 'secondary'}>
                  {row.isActive ? 'Active' : 'Revoked'}
                </Badge>
              ),
            },
            {
              key: 'control',
              label: '',
              kind: 'actions',
              render: (row) =>
                row.isActive ? (
                  <PlatformMutationButton
                    action={revokeAccessAction.bind(null, row.id)}
                    success="Access revoked"
                    variant="outline"
                    size="sm"
                  >
                    Revoke
                  </PlatformMutationButton>
                ) : (
                  <span className="text-xs text-fg-subtle">Preserved</span>
                ),
            },
          ]}
          rows={grants}
          getRowId={(row) => row.id}
          empty={{
            title: 'No grants',
            description: 'This identity only has its home organization, unless it is a super admin.',
          }}
        />
        <Card>
          <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
            {[
              { label: 'Email', value: user.email },
              { label: 'Home organization', value: user.orgName },
              { label: 'Last login', value: asDate(user.lastLoginAt)?.toLocaleString() ?? 'Never' },
              { label: 'Created', value: asDate(user.createdAt)?.toLocaleString() ?? '—' },
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
