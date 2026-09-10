import 'server-only'

import { can, requirePermission } from '../../lib/authz'
import { PaymentsSection } from '../../app/(app)/payments/PaymentsSection'
import { RunsSection } from '../../app/(app)/payments/RunsSection'

/**
 * Slots for the two money-movement sections.
 *
 * Both take an `Authz` — a live capability object — plus an org id and a user
 * id. None of those may travel through a spec, so each slot re-derives them
 * from the session and the spec carries only the kind, the base path and the
 * URL it was already rendering with. `PaymentsSection` re-checks the pay
 * permission for its own kind internally, so naming this widget grants
 * nothing a session does not already hold.
 */
export async function PaymentsSectionSlot({
  sp,
  basePath,
  kind,
}: {
  sp: Record<string, string | string[] | undefined>
  basePath: string
  kind: 'vendor_payment' | 'customer_payment'
}) {
  const authz = await requirePermission(kind === 'vendor_payment' ? 'ap.pay' : 'ar.pay')
  return (
    <PaymentsSection
      sp={sp}
      authz={authz}
      basePath={basePath}
      kind={kind}
      orgId={authz.user.orgId}
      userId={authz.user.id}
      canManage={can(authz, 'admin.customization.manage')}
      userRoles={authz.user.roles.map(({ key }) => key)}
    />
  )
}

export async function RunsSectionSlot({
  sp,
  basePath,
  direction,
}: {
  sp: Record<string, string | string[] | undefined>
  /** The runs section serves both money-out and money-in, and its own type
   *  keeps that list closed rather than accepting any string. */
  basePath: '/payments' | '/receipts'
  direction: 'outbound' | 'inbound'
}) {
  const authz = await requirePermission(direction === 'outbound' ? 'ap.pay' : 'ar.pay')
  return (
    <RunsSection
      sp={sp}
      authz={authz}
      canApprove={can(authz, direction === 'outbound' ? 'ap.approve' : 'ar.approve')}
      direction={direction}
      basePath={basePath}
    />
  )
}
