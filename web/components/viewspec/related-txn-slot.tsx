import 'server-only'

import { getAuthz } from '../../lib/authz'
import { RelatedTransactionDrawer } from '../related-transaction-drawer'

/**
 * The related-transaction drawer, for any record that opens one.
 *
 * It needs an `Authz` — a live capability object holding a permission Set —
 * which must never travel through a spec as data. So the slot re-derives it
 * from the session and the spec carries only ids. A spec author who names this
 * widget gains nothing: the session decides what it can read.
 *
 * `permission` names the read the HOST page already required, so the drawer
 * cannot be reached from a page whose own permission the session lacks.
 */
export async function RelatedTxnSlot({
  id,
  kind,
  partyId,
  projectId,
  formLayoutId,
}: {
  id: string
  kind: string
  partyId?: string
  projectId?: string
  formLayoutId?: string
}) {
  const authz = await getAuthz()
  if (!authz) return null
  return (
    <RelatedTransactionDrawer
      id={id}
      kind={kind}
      partyId={partyId}
      projectId={projectId}
      authz={authz}
      formLayoutId={formLayoutId}
    />
  )
}
