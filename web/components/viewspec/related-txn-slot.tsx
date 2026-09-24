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
 * There is deliberately no `permission` prop to thread a host page's read
 * through: none is needed. The drawer gates every query itself from the
 * session Authz — organization match, subsidiary fence, per-kind feature and
 * enablement flags, and ap.read/ar.read for payments (see
 * related-transaction-drawer.tsx) — and renders null when any gate fails, so
 * no host page can leak through it a row its own session could not read.
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
