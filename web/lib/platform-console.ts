import { createPlatformNav } from '@braedonsaunders/appkit-superadmin'
import { clamp, pickString } from './list-params'

/** OpenBooks operator console: shared AppKit chrome plus the acting-user grants page. */
export const OPENBOOKS_PLATFORM_NAV = createPlatformNav({
  modules: ['overview', 'tenants', 'users', 'feedback', 'emailLog'],
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
    feedback: 'Where in-app product reports are filed, for the whole deployment',
    emailLog: 'Delivery evidence across every organization',
  },
  workspaceHref: '/',
  workspaceLabel: 'Organization workspace',
})

/**
 * The console lists keep a fixed sort and page size; only the page travels on
 * the URL. Parse it the house way (first value wins, non-finite refuses to
 * page one, clamped) so a hand-edited ?page= can neither 500 the loader nor
 * silently re-truncate the list it was meant to extend.
 */
export function platformListPage(
  searchParams: Record<string, string | string[] | undefined>,
): number {
  return clamp(Number(pickString(searchParams.page) ?? '1'), 1, 10_000)
}

export function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  return value instanceof Date ? value : new Date(value)
}
