'use client'

import { Badge, PageContainer } from '@braedonsaunders/appkit-ui'
import { PlatformTenantsAdmin, type PlatformTenantRecord } from '@braedonsaunders/appkit-superadmin/react'
import type { PlatformOrganization } from '../../../../lib/platform-admin'
import { asDate } from '../../../../lib/platform-console'
import { enterOrganizationAction } from '../actions'

function toTenant(org: PlatformOrganization): PlatformTenantRecord {
  return {
    id: org.id,
    name: org.name,
    slug: org.id,
    status: 'active',
    memberCount: org.activeUserCount,
    createdAt: asDate(org.createdAt) ?? new Date(),
    updatedAt: asDate(org.createdAt) ?? new Date(),
  }
}

const ENV_VARIANT = {
  production: 'success',
  sandbox: 'warning',
  preview: 'secondary',
} as const

export function PlatformTenantsClient({ rows }: { rows: PlatformOrganization[] }) {
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  return (
    <PageContainer>
      <PlatformTenantsAdmin
        title="Organizations"
        description="Every production company, sandbox, and preview environment. Open enters that organization as the current workspace."
        tenants={rows.map(toTenant)}
        canCreate={false}
        showSlug={false}
        disableDrawer
        extraColumns={[
          {
            key: 'environment',
            label: 'Environment',
            render: (tenant) => {
              const org = byId[tenant.id]
              if (!org) return null
              return (
                <div>
                  <Badge variant={ENV_VARIANT[org.envKind]}>{org.envKind}</Badge>
                  {org.parentName ? (
                    <div className="mt-0.5 text-xs text-fg-muted">of {org.parentName}</div>
                  ) : null}
                </div>
              )
            },
          },
          {
            key: 'locale',
            label: 'Locale',
            render: (tenant) => {
              const org = byId[tenant.id]
              if (!org) return null
              return (
                <span className="text-fg-muted">
                  {org.country} · {org.baseCurrency}
                </span>
              )
            },
          },
          {
            key: 'sandboxes',
            label: 'Sandboxes',
            render: (tenant) => (
              <span className="tabular-nums text-fg-muted">{byId[tenant.id]?.sandboxCount ?? 0}</span>
            ),
          },
        ]}
        onViewAs={async (tenant) => {
          const form = new FormData()
          form.set('orgId', tenant.id)
          await enterOrganizationAction(form)
        }}
        viewAsLabel="Open"
      />
    </PageContainer>
  )
}
