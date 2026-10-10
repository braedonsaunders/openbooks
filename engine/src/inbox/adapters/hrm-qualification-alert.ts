/**
 * HR-15 hrm_qualification_alert adapter — expiring qualifications (HR-14).
 *
 * Reads the real HR-14 ledger (migration 0225): hrm_worker_qualifications
 * joined through the actor's employments, projecting the same
 * expiring/expired derivation the qualification service uses (stored
 * valid, dated expiry within 30 days). The off state is probed
 * explicitly — a catalog existence check for the HR-14 table — never by
 * catching errors. While the table is absent the adapter lists nothing
 * and the inbox stays up.
 *
 * Delivery also flows through notifications (the alert scan writes
 * hrm_qualification_expiry notices, which the notification adapter
 * lists); this adapter covers holders whose scan row has not fired yet
 * and managers reading the same ledger.
 */

import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { actorPartyId, hrmOn, sourceTableInstalled } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

/** HR-14 ledger table (migration 0225). */
const HR14_TABLE = "hrm_worker_qualifications" as const;

export async function qualificationSourceAvailable(): Promise<boolean> {
  return sourceTableInstalled(HR14_TABLE);
}

type AlertRow = {
  id: string;
  name: string;
  expiry_on: string;
};

async function qualificationAlertSource(ctx: InboxListContext) {
  if (!(await hrmOn(ctx))) return null;
  if (!(await sourceTableInstalled(HR14_TABLE))) return null;
  const partyId = await actorPartyId(ctx);
  if (!partyId) return null;
  return sql`
    from public.hrm_worker_qualifications q
    join public.worker_employments e
      on e.org_id = q.org_id and e.id = q.employment_id
    join public.hrm_qualification_types t
      on t.org_id = q.org_id and t.id = q.type_id
    where q.org_id = ${ctx.orgId}
      and e.worker_party_id = ${partyId}
      and q.status = 'valid'
      and q.expires_on is not null
      and q.expires_on <= ${ctx.asOf}::date + 30`;
}

export const hrmQualificationAlertAdapter: InboxAdapter = {
  kind: "hrm_qualification_alert",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const source = await qualificationAlertSource(ctx);
    if (!source) return [];
    // The HR-14 read contract: stored valid rows with a dated expiry
    // inside the alert window, through the actor's employments (never a
    // caller-supplied worker). Expired rows sort first — they already
    // refuse gated work.
    const rows = (await db.execute<AlertRow>(sql`
      select q.id::text as id, t.name as name, q.expires_on::text as expiry_on
        ${source}
       order by q.expires_on, q.id
       limit 20
    `)).rows;
    return rows.map((row) => {
      const dueAt = new Date(`${row.expiry_on}T00:00:00Z`).toISOString();
      return {
        id: inboxItemId("hrm_qualification_alert", row.id),
        kind: "hrm_qualification_alert",
        title: `Qualification expiring — ${row.name}`,
        subtitle: `expires ${row.expiry_on} — renew it before work that needs it is refused`,
        dueAt,
        createdAt: dueAt,
        priority: priorityForDueDate(dueAt, ctx.asOf, ctx.timeZone),
        subjectHref: "/hrm/qualifications",
        actions: [],
        source: { kind: "hrm_worker_qualification", id: row.id },
      } satisfies InboxItem;
    });
  },
  async count(ctx: InboxListContext): Promise<number> {
    const source = await qualificationAlertSource(ctx);
    if (!source) return 0;
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n ${source}`);
    return rows.rows[0]?.n ?? 0;
  },
  async act(): Promise<void> {
    throw new Error("qualification renewal happens in the qualifications surface — open it and renew there");
  },
};
