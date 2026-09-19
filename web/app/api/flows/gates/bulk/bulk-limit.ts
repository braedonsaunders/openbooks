import { APPROVALS_BULK_BATCH_MAX } from '../../../../../lib/approvals-limits'

/**
 * Maximum number of gates that may be decided in one request. Aliased to the
 * shared approvals ceiling so the worklist page size and the request cap
 * cannot drift apart (a page selection always fits one request).
 */
export const MAX_BULK_ITEMS = APPROVALS_BULK_BATCH_MAX
