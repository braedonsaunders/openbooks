'use client'

import { useRouter } from 'next/navigation'
import { Badge, PageContainer } from '@braedonsaunders/appkit-ui'
import { PlatformUsersAdmin, type PlatformUserRecord } from '@braedonsaunders/appkit-superadmin/react'
import type { PlatformUser } from '../../../../lib/platform-admin'
import { asDate } from '../../../../lib/platform-console'

function toUser(user: PlatformUser): PlatformUserRecord {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: null,
    emailVerified: true,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin,
    hasCredential: true,
    activeSessionCount: 0,
    lastSeenAt: asDate(user.lastLoginAt),
    createdAt: asDate(user.createdAt) ?? new Date(),
    updatedAt: asDate(user.createdAt) ?? new Date(),
  }
}

export function PlatformUsersClient({ rows }: { rows: PlatformUser[] }) {
  const router = useRouter()
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  return (
    <PageContainer>
      <PlatformUsersAdmin
        title="Users"
        description="Production login identities, organization roles, and platform privileges."
        users={rows.map(toUser)}
        canCreate={false}
        showSignIn={false}
        showSessions={false}
        extraColumns={[
          {
            key: 'organization',
            label: 'Home organization',
            render: (user) => <span className="text-fg-muted">{byId[user.id]?.orgName ?? '—'}</span>,
          },
          {
            key: 'roles',
            label: 'Roles',
            render: (user) => (
              <div className="flex flex-wrap gap-1">
                {(byId[user.id]?.roles ?? []).map((role) => (
                  <Badge key={role} variant="outline">
                    {role}
                  </Badge>
                ))}
              </div>
            ),
          },
          {
            key: 'grants',
            label: 'Grants',
            render: (user) => {
              const count = byId[user.id]?.grantCount ?? 0
              return (
                <span className={count ? 'font-medium tabular-nums' : 'text-fg-muted'}>
                  {count ? `${count} explicit` : 'Home only'}
                </span>
              )
            },
          },
        ]}
        onSelectUser={(user) => router.push(`/platform/users/${user.id}`)}
      />
    </PageContainer>
  )
}
