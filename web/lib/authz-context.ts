import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Authz } from './authz-core'

const authority = new AsyncLocalStorage<Authz>()
export const requestAuthzContext = () => authority.getStore()

/** Reuse a principal already verified for this request. A shared calculation
 * must run under exactly the grants used to partition its result cache, even
 * if an administrator changes the initiating user's roles during the read. */
export function withAuthzContext<T>(authz: Authz, work: () => T): T {
  const snapshot: Authz = { ...authz, user: { ...authz.user }, permissions: new Set(authz.permissions), allowedSubsidiaryIds: authz.allowedSubsidiaryIds === null ? null : new Set(authz.allowedSubsidiaryIds) }
  return authority.run(snapshot, work)
}
