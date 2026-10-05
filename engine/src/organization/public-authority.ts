/** Native authority controls shared by requests and background execution. */
export { denyInactiveExtensionPermissions, extensionPermissionAvailability } from './extension-permission-availability.ts'
export { subsidiaryScopeAllows, withScopeSnapshot } from './subsidiary-scope.ts'
export { subsidiaryVisibleFilter, ScopeNotFoundError } from './subsidiary-scope.ts'
