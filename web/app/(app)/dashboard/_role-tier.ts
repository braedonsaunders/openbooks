import type { Authz } from '@/lib/authz'

export type RoleTier = 'admin' | 'controller' | 'accountant' | 'approver' | 'viewer'

export const TIER_RANK: Record<RoleTier, number> = {
  admin: 0,
  controller: 1,
  accountant: 2,
  approver: 3,
  viewer: 4,
}

export const ROLE_TIER_LABELS: Record<RoleTier, string> = {
  admin: 'Administrator',
  controller: 'Controller',
  accountant: 'Accountant',
  approver: 'Approver',
  viewer: 'Viewer',
}

export function inferRoleTier(roleKeys: readonly string[]): RoleTier {
  return (Object.keys(TIER_RANK) as RoleTier[])
    .filter((tier) => roleKeys.includes(tier))
    .sort((a, b) => TIER_RANK[a] - TIER_RANK[b])[0] ?? 'viewer'
}

export function getUserRoleTier(authz: Authz): RoleTier {
  return inferRoleTier(authz.user.roles.map(({ key }) => key))
}

export function dashboardSourceKeyForTier(tier: RoleTier): string {
  return `tier:${tier}`
}

export function dashboardSourceKeyForRole(roleKey: string): string {
  return `role:${roleKey}`
}
