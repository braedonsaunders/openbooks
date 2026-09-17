'use client'

import { Badge, PageContainer, PageHeader, RecordList } from '@braedonsaunders/appkit-ui'
import type { PlatformGrant, PlatformOrganization, PlatformUser } from '../../../../lib/platform-admin'
import { asDate } from '../../../../lib/platform-console'
import { GrantAccessForm } from './GrantAccessForm'
import { PlatformMutationButton } from './PlatformMutationButton'
import { revokeAccessAction } from '../actions'

export function PlatformAccessClient({
  grants,
  members,
  organizations,
  actingUsers,
}: {
  grants: PlatformGrant[]
  members: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
  organizations: Pick<PlatformOrganization, 'id' | 'name'>[]
  actingUsers: Pick<PlatformUser, 'id' | 'name' | 'email' | 'orgName' | 'orgId'>[]
}) {
  return (
    <PageContainer>
      <div className="space-y-5">
        <PageHeader
          title="Cross-org access"
          description="Controlled mappings between login identities and organizations. Super admins do not require grants."
          back={{ href: '/platform', label: 'Back to platform' }}
        />
        <GrantAccessForm members={members} organizations={organizations} actingUsers={actingUsers} />
        <RecordList
          columns={[
            {
              key: 'member',
              label: 'Member',
              render: (row) => (
                <div>
                  <div className="font-medium text-fg">{row.memberName}</div>
                  <div className="text-xs text-fg-muted">
                    {row.memberEmail} · {row.memberOrgName}
                  </div>
                </div>
              ),
            },
            {
              key: 'orgName',
              label: 'Organization',
              render: (row) => <span className="text-fg">{row.orgName}</span>,
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
              key: 'updatedAt',
              label: 'Last changed',
              render: (row) => (
                <span className="whitespace-nowrap text-fg-muted">
                  {(asDate(row.updatedAt) ?? new Date()).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
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
          empty={{ title: 'No grants', description: 'Grant access above to map a login into another organization.' }}
        />
      </div>
    </PageContainer>
  )
}
