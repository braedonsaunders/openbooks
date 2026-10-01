import { can, type Authz } from './authz'

export type SetupLaunchAction = 'invoice' | 'migrate' | 'statement' | 'demo'

/** Existing destinations enforce their own permissions and financial controls. */
export function setupLaunchActions(authz: Authz): SetupLaunchAction[] {
  return [
    ...(can(authz, 'ar.create') ? ['invoice' as const] : []),
    ...(can(authz, 'sync.run') ? ['migrate' as const] : []),
    ...(can(authz, 'banking.reconcile') ? ['statement' as const] : []),
    ...(can(authz, 'admin.setup.manage') ? ['demo' as const] : []),
  ]
}
