import { platformEmails, platformGrants, platformOrganizations, platformUsers } from '../platform-admin'
import { parseListParams, pickString } from '../list-params'
import { requireSuperAdmin } from '../super-admin'

type Search = Record<string, string | string[] | undefined>

function defineSource<Sort extends string, Filter extends string, Result>(config: {
  basePath: string
  sort: Sort
  dir: 'asc' | 'desc'
  allowedSorts: readonly Sort[]
  filterKey: string
  filters: readonly Filter[]
}, load: (params: {
  q?: string; sort: Sort; dir: 'asc' | 'desc'; page: number; perPage: number; filter?: Filter
}) => Promise<Result>) {
  return {
    basePath: config.basePath,
    async read(search: Search) {
      // These sources deliberately read across tenants. Authorization must
      // precede the provider, independently of the enclosing page layout.
      await requireSuperAdmin()
      const params = parseListParams(search, { ...config, perPage: 50 })
      const requested = pickString(search[config.filterKey])
      const filter = config.filters.includes(requested as Filter) ? requested as Filter : undefined
      return { params, filter, result: await load({ ...params, filter }) }
    },
  }
}

export const platformListSources = {
  users: defineSource({
    basePath: '/platform/users', sort: 'name', dir: 'asc',
    allowedSorts: ['name', 'email', 'organization', 'role', 'lastLogin', 'grants'],
    filterKey: 'status', filters: ['active', 'inactive', 'super'],
  }, ({ filter, ...params }) => platformUsers({ ...params, status: filter })),
  tenants: defineSource({
    basePath: '/platform/tenants', sort: 'name', dir: 'asc',
    allowedSorts: ['name', 'environment', 'users', 'sandboxes', 'created'],
    filterKey: 'environment', filters: ['production', 'sandbox', 'preview'],
  }, ({ filter, ...params }) => platformOrganizations({ ...params, environment: filter })),
  access: defineSource({
    basePath: '/platform/access', sort: 'updated', dir: 'desc',
    allowedSorts: ['member', 'organization', 'actingUser', 'updated'],
    filterKey: 'status', filters: ['active', 'inactive'],
  }, ({ filter, ...params }) => platformGrants({ ...params, status: filter })),
  emails: defineSource({
    basePath: '/platform/email-log', sort: 'created', dir: 'desc',
    allowedSorts: ['created', 'organization', 'recipient', 'subject', 'status'],
    filterKey: 'status', filters: ['queued', 'sent', 'failed', 'suppressed', 'uncertain'],
  }, ({ filter, ...params }) => platformEmails({ ...params, status: filter })),
}
