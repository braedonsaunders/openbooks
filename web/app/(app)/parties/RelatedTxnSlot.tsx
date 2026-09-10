import 'server-only'

import { requirePermission } from '../../../lib/authz'
import { RelatedTransactionDrawer } from '../../../components/related-transaction-drawer'

/**
 * The related-transaction drawer needs an `Authz`, which is a live capability
 * object holding a permission Set — exactly the kind of thing that must never
 * travel through a spec as data. So the slot re-derives it server-side from the
 * session, the same way the native page does, and the spec carries only the
 * ids. A spec author who names this widget gains nothing: the permission check
 * runs here.
 */
export async function RelatedTxnSlot({
  id,
  kind,
  partyId,
  formLayoutId,
}: {
  id: string
  kind: string
  partyId: string
  formLayoutId?: string
}) {
  const authz = await requirePermission('parties.read')
  return (
    <RelatedTransactionDrawer
      id={id}
      kind={kind}
      partyId={partyId}
      authz={authz}
      formLayoutId={formLayoutId}
    />
  )
}
