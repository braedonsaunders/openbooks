import { createPlatformNav } from '@braedonsaunders/appkit-superadmin'

/** OpenBooks operator console: shared AppKit chrome plus the acting-user grants page. */
export const OPENBOOKS_PLATFORM_NAV = createPlatformNav({
  modules: ['overview', 'tenants', 'users', 'emailLog'],
  extras: [
    {
      id: 'access',
      href: '/platform/access',
      label: 'Cross-org access',
      description: 'Controlled mappings between login identities and organizations',
      iconKey: 'key',
    },
  ],
  labels: { tenants: 'Organizations' },
  descriptions: {
    tenants: 'Every production company, sandbox, and preview environment',
    users: 'Global operator view of production identities and privileges',
    emailLog: 'Delivery evidence across every organization',
  },
  workspaceHref: '/',
  workspaceLabel: 'Organization workspace',
})

export function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  return value instanceof Date ? value : new Date(value)
}
