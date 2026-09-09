import { revokeAccessAction } from '../actions'
import { PlatformMutationButton } from '../_components/PlatformMutationButton'

/**
 * Two composite cells in the cross-org access list.
 *
 * The control cell is the notable one: it binds a SERVER ACTION to a specific
 * grant id. A bound function is exactly what a spec must never carry — it is
 * not serializable and it is authority, not presentation — so the spec passes
 * the id and the binding happens here.
 */

/** Name over a muted "email · organization" line. */
export function IdentityCell({ name, detail }: { name: string; detail: string }) {
  return (
    <>
      <div className="font-medium">{name}</div>
      <div className="text-xs text-slate-500">{detail}</div>
    </>
  )
}

/** Plain name over a muted email. */
export function ActingCell({ name, email }: { name: string; email: string }) {
  return (
    <>
      <div>{name}</div>
      <div className="text-xs text-slate-500">{email}</div>
    </>
  )
}

/** Revoke button while the grant is live; a history note once it is not. */
export function AccessControlCell({ grantId, isActive }: { grantId: string; isActive: boolean }) {
  if (!isActive) return <span className="text-xs text-slate-400">History preserved</span>
  return (
    <PlatformMutationButton
      action={revokeAccessAction.bind(null, grantId)}
      success="Cross-organization access revoked"
      size="sm"
      variant="ghost"
    >
      Revoke
    </PlatformMutationButton>
  )
}
