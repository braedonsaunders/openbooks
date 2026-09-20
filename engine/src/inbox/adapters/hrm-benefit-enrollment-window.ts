/**
 * HR-15 hrm_benefit_enrollment_window adapter — open windows, no election yet.
 *
 * Link-only by design: electing is a human-attested benefits action with
 * plan/level choices the inbox does not duplicate. Scoped strictly to the
 * actor's own employments (party → employments, the self-service own
 * rule) — the aggregate benefits loaders stay HR-scoped and are not used
 * here, so the inbox never widens visibility.
 */

import { sql } from "drizzle-orm";
import { loadApprovalPerson } from "../../hrm/authorization.ts";
import { findEmploymentsByParty } from "../../hrm/employment-read.ts";
import { db } from "../../platform/db.ts";
import { hrmOn } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

type WindowRow = {
  id: string;
  name: string;
  closes_on: string;
};

export const hrmBenefitEnrollmentWindowAdapter: InboxAdapter = {
  kind: "hrm_benefit_enrollment_window",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await hrmOn(db, ctx.orgId))) return [];
    const person = await loadApprovalPerson(db, ctx.orgId, ctx.actorId);
    if (!person.partyId) return [];
    const employmentIds = await findEmploymentsByParty({
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      workerPartyId: person.partyId,
    });
    if (employmentIds.length === 0) return [];
    const ids = [...employmentIds];
    const rows = (await db.execute<WindowRow>(sql`
      select w.id, w.name, w.closes_on::text as closes_on
        from hrm_enrollment_windows w
       where w.org_id = ${ctx.orgId}
         and w.status = 'open'
         and w.closes_on >= current_date
         and not exists (
           select 1 from hrm_benefit_enrollments e
            where e.org_id = w.org_id
              and e.window_id = w.id
              and e.employment_id in (
                select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as _e(value))
              and e.status in ('elected', 'approved', 'pending_approval'))
       order by w.closes_on, w.id
       limit 20
    `)).rows;
    return rows.map((row) => {
      const dueAt = new Date(`${row.closes_on}T00:00:00Z`).toISOString();
      return {
        id: inboxItemId("hrm_benefit_enrollment_window", row.id),
        kind: "hrm_benefit_enrollment_window",
        title: `Benefits enrollment open — ${row.name}`,
        subtitle: `you have no election yet — choose plans in benefits before ${row.closes_on}`,
        dueAt,
        createdAt: dueAt,
        priority: priorityForDueDate(dueAt, ctx.asOf),
        subjectHref: "/hrm/benefits",
        actions: [],
        source: { kind: "hrm_enrollment_window", id: row.id },
      } satisfies InboxItem;
    });
  },
  async act(): Promise<void> {
    throw new Error(
      "enrolling happens in benefits — open the window, choose a plan and level, then elect",
    );
  },
};
