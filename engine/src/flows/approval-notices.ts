import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { getFlowAdapter } from "./registry.ts";

/**
 * Resolve "Approval requested" notices once the request they announce is no
 * longer waiting on the person.
 *
 * Every approval gate writes its assignee an `approval` notice linking to the
 * subject. When the gate is decided, cancelled by quorum, superseded by a
 * rejection, escalated away or cancelled with its run, that notice would
 * otherwise sit unread in My tasks and on the dashboard after the work is
 * done. This marks it read for every recipient who no longer holds a pending
 * gate on that subject; anyone still asked to decide keeps theirs.
 *
 * Notices carry the subject's deep link rather than a gate id, so they are
 * matched by link. A subject adapter whose link names no specific record
 * (one list for every subject of the kind) resolves only when the recipient
 * has no pending gate on any subject of that kind, so a notice is never
 * cleared while related work is still waiting.
 *
 * Runs on the ambient handle so it commits or rolls back with the decision.
 */
export async function resolveApprovalRequestNotices(
  orgId: string,
  subjectKind: string,
  subjectId: string,
): Promise<number> {
  const adapter = getFlowAdapter(subjectKind);
  const href = adapter?.deepLink(subjectId) ?? null;
  if (!href) return 0;
  const subjectSpecific = href.includes(subjectId);
  const resolved = await db.execute<{ id: string }>(sql`
    update notifications n
       set read_at = now(), updated_at = now()
     where n.org_id = ${orgId}
       and n.kind = 'approval'
       and n.read_at is null
       and n.href = ${href}
       and not exists (
         select 1 from flow_gates g
          where g.org_id = n.org_id
            and g.assignee_user_id = n.user_id
            and g.subject_kind = ${subjectKind}
            ${subjectSpecific ? sql`and g.subject_id = ${subjectId}` : sql``}
            and g.status = 'pending'
       )
    returning n.id
  `);
  return resolved.rows.length;
}
