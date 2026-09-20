/**
 * Pure status-segment mapping for the org-wide employment change-request
 * queue (/hrm/change-requests). Zero imports: the queue loader and the unit
 * partition share this without pulling the database, auth, or catalogs.
 *
 * The queue speaks five operator segments; the service speaks six request
 * states. `submitted` names `pending_approval` (the state a submitted draft
 * waits in), and `applied` — a decided request already written onto the
 * canonical record — belongs to no segment: it lists under All, never
 * folded into Approved, so the segment counts stay exact.
 */
export const QUEUE_SEGMENTS = ['draft', 'submitted', 'approved', 'rejected', 'withdrawn'] as const

export type QueueSegment = (typeof QUEUE_SEGMENTS)[number]

/** The service request state each queue segment filters on. */
export const QUEUE_SEGMENT_STATUS: Record<QueueSegment, string> = {
  draft: 'draft',
  submitted: 'pending_approval',
  approved: 'approved',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
}

export interface QueueStatusRefusal {
  readonly code: 'UNKNOWN_QUEUE_STATUS'
  readonly message: string
}

export type QueueStatusResolution =
  | { readonly ok: true; readonly segment: QueueSegment | null; readonly serviceStatus: string | null }
  | { readonly ok: false; readonly refusal: QueueStatusRefusal }

/**
 * Resolve the raw `status` search param. Absent means All (no service
 * filter, applied rows included). Anything outside the five segments is a
 * refusal naming the valid segments — never a silent fall back to All,
 * which would show a different list than the URL promises.
 */
export function resolveQueueStatus(raw: string | null | undefined): QueueStatusResolution {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, segment: null, serviceStatus: null }
  }
  const segment = (QUEUE_SEGMENTS as readonly string[]).includes(raw)
    ? (raw as QueueSegment)
    : null
  if (segment === null) {
    return {
      ok: false,
      refusal: {
        code: 'UNKNOWN_QUEUE_STATUS',
        message: `unknown change-request segment ${JSON.stringify(raw)} — filter by one of ${QUEUE_SEGMENTS.join(', ')}, or clear the filter to list every request`,
      },
    }
  }
  return { ok: true, segment, serviceStatus: QUEUE_SEGMENT_STATUS[segment] }
}

/** The queue segment a service request state counts toward, or null for All-only states. */
export function segmentOfServiceStatus(status: string): QueueSegment | null {
  for (const segment of QUEUE_SEGMENTS) {
    if (QUEUE_SEGMENT_STATUS[segment] === status) return segment
  }
  return null
}
