/**
 * HR-15 hrm_qualification_alert adapter — expiring qualifications (HR-14).
 *
 * Optional adapter: HR-14 has not landed, so no table or feature key
 * exists yet. The off state is probed explicitly — an information-schema
 * existence check for the HR-14 assignment table — never by catching
 * errors. While the table is absent the adapter lists nothing and the
 * inbox stays up; when HR-14 lands, the probe finds the table and the
 * adapter reads expiring assignments through the same HRM scope the
 * qualification surface uses.
 *
 * Expected HR-14 shape (to be pinned when it lands): a table holding one
 * row per held qualification with holder_party_id, expiry_on, and status.
 */

import { sql } from "drizzle-orm";
import { loadApprovalPerson } from "../../hrm/authorization.ts";
import { db } from "../../platform/db.ts";
import { hrmOn } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

/** HR-14 assignment table, in landing-preference order. */
const CANDIDATE_TABLES = ["hrm_qualification_assignments", "hrm_certification_assignments"] as const;

async function hr14Table(): Promise<string | null> {
  for (const table of CANDIDATE_TABLES) {
    const found = (await db.execute<{ exists: boolean }>(sql`
      select to_regclass(${`public.${table}`}) is not null as exists
    `)).rows[0]?.exists;
    if (found) return table;
  }
  return null;
}

export async function qualificationSourceAvailable(): Promise<boolean> {
  return (await hr14Table()) !== null;
}

type AlertRow = {
  id: string;
  name: string;
  expiry_on: string;
};

export const hrmQualificationAlertAdapter: InboxAdapter = {
  kind: "hrm_qualification_alert",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await hrmOn(db, ctx.orgId))) return [];
    const table = await hr14Table();
    if (!table) return [];
    const person = await loadApprovalPerson(db, ctx.orgId, ctx.actorId);
    if (!person.partyId) return [];
    // Column names follow the HR-14 contract (holder_party_id, expiry_on,
    // status, qualification name); probed shape, pinned when HR-14 lands.
    const rows = (await db.execute<AlertRow>(sql`
      select a.id, a.name, a.expiry_on::text as expiry_on
        from ${sql.raw(`public.${table}`)} a
       where a.org_id = ${ctx.orgId}
         and a.holder_party_id = ${person.partyId}
         and a.status = 'active'
         and a.expiry_on <= current_date + 30
       order by a.expiry_on, a.id
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
        priority: priorityForDueDate(dueAt, ctx.asOf),
        subjectHref: "/hrm/qualifications",
        actions: [],
        source: { kind: "hrm_qualification_assignment", id: row.id },
      } satisfies InboxItem;
    });
  },
  async act(): Promise<void> {
    throw new Error("qualification renewal happens in the qualifications surface — open it and renew there");
  },
};
