import { isUuid } from '../list-params';

/**
 * Per-request ceiling on bulk ids: each id runs its own write in the
 * request, so an unbounded list is an unbounded request. Over-limit batches
 * are REFUSED by name (never silently truncated — truncating reported
 * success for ids that never ran). Clients chunk larger selections into
 * batches of this size and reconcile every requested id against the
 * returned results.
 */
export const BULK_ACTION_MAX_IDS = 50;

export type BulkActionParse =
  | { ok: true; action: string; ids: string[] }
  | { ok: false; error: string };

const BULK_ACTIONS = ["reprocess", "reject", "materialize"];

/**
 * Pure parse of a bulk-action body: action allow-list, id collection and
 * dedupe, then uuid shape, then the per-request ceiling — in that order, so
 * a bad action reads invalid_action even with bad ids.
 */
export function parseBulkActionIds(body: unknown): BulkActionParse {
  const data = (body ?? {}) as { action?: unknown; ids?: unknown };
  const action = typeof data.action === "string" ? data.action : "";
  if (!BULK_ACTIONS.includes(action))
    return { ok: false, error: 'invalid_action' };
  // Collect every supplied string id first, then refuse the non-uuid ones
  // with the same not_found the item routes compute: a dash-only string is
  // still a named id (it 404s instead of collapsing into invalid_action),
  // and it never reaches a uuid column because the parse returns ok: false.
  const ids = Array.isArray(data.ids)
    ? [...new Set(data.ids.filter((id) => typeof id === "string"))]
    : [];
  if (!ids.length) return { ok: false, error: 'invalid_action' };
  if (!ids.every(isUuid)) return { ok: false, error: 'not_found' };
  if (ids.length > BULK_ACTION_MAX_IDS) {
    return {
      ok: false,
      error: `too_many_ids: at most ${BULK_ACTION_MAX_IDS} ids per request`,
    };
  }
  return { ok: true, action, ids };
}
