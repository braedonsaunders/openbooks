import 'server-only'

import { getFlowAdapter } from '@openbooks/engine/src/flows/registry.ts'
import { moduleDrawerHref } from './txn-links'

/**
 * The URL that opens an approval subject's native record, or null when the
 * kind has no surface at all (the row renders as plain text). A non-document
 * subject opens wherever its flow adapter's deepLink says; document kinds
 * open their module drawer through the shared report→transaction map
 * (txn-links.ts), falling back to the adapter's link (the hub) when no
 * module surface exists.
 */
export function approvalRecordHref(
  kind: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!kind || !id) return null
  const adapter = getFlowAdapter(kind)
  if (adapter && adapter.scope.via !== 'document') return adapter.deepLink(id)
  return moduleDrawerHref(kind, id) ?? adapter?.deepLink(id) ?? null
}
