import { Badge } from '@openbooks/ui'

/**
 * The storefront or integrator identity that created a document, when one
 * exists. Read-only provenance beside the number: the operator sees at a
 * glance which external system to reconcile against, and there is no edit
 * path — the pair is stamped by the API and guarded by storage.
 */
export function ExternalRefChip({
  externalRef,
  externalSource,
}: {
  externalRef: unknown
  externalSource: unknown
}) {
  if (typeof externalRef !== 'string' || typeof externalSource !== 'string') return null
  if (!externalRef || !externalSource) return null
  return (
    <Badge variant="outline" className="shrink-0 font-mono">
      {`${externalSource} · ${externalRef}`}
    </Badge>
  )
}
