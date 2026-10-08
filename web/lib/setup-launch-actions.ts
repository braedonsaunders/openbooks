import { can, type Authz } from './authz'

export type SetupLaunchAction = 'invoice' | 'assistant' | 'migrate' | 'statement' | 'demo'

/** Existing destinations enforce their own permissions and financial controls. */
export function setupLaunchActions(authz: Authz): SetupLaunchAction[] {
  return [
    ...(can(authz, 'ar.create') ? ['invoice' as const] : []),
    // The migration assistant plans organization-wide work: setup authority over every entity.
    ...(can(authz, 'admin.setup.manage') && authz.allowedSubsidiaryIds === null ? ['assistant' as const] : []),
    ...(can(authz, 'sync.run') ? ['migrate' as const] : []),
    ...(can(authz, 'banking.reconcile') ? ['statement' as const] : []),
    ...(can(authz, 'admin.setup.manage') ? ['demo' as const] : []),
  ]
}
