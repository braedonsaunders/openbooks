/**
 * HR-15 hrm_process_step adapter — my checklist steps.
 *
 * Lists pending steps in open processes where the actor is the owner
 * (the same owner resolution completeProcessStep enforces: employee
 * owner on their own employment, or a named party). Acts through
 * completeProcessStep — the step-complete route's service.
 *
 * Steps needing attachment evidence are link-only: completing them
 * needs a file picker the inbox does not duplicate, and the subtitle
 * names that remedy.
 */

import { sql } from "drizzle-orm";
import { actorPartyId } from "../guard.ts";
import { completeProcessStep } from "../../hrm/processes.ts";
import { businessToday } from "../../platform/business-date.ts";
import { db } from "../../platform/db.ts";
import { hrmOn } from "../guard.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

type StepRow = {
  id: string;
  process_id: string;
  title: string;
  due_on: string;
  required: boolean;
  evidence_kind: string;
  worker_name: string;
  process_kind: string;
};

export const hrmProcessStepAdapter: InboxAdapter = {
  kind: "hrm_process_step",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    if (!(await hrmOn(db, ctx.orgId))) return [];
    const partyId = await actorPartyId(ctx.orgId, ctx.actorId);
    if (!partyId) return [];
    const today = await businessToday(ctx.orgId);
    const rows = (await db.execute<StepRow>(sql`
      select s.id, s.process_id::text as process_id, s.title,
             s.due_on::text as due_on, s.required, s.evidence_kind,
             wp.display_name as worker_name, p.kind as process_kind
        from hrm_process_steps s
        join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
        join worker_employments e on e.org_id = s.org_id and e.id = p.employment_id
        join parties wp on wp.org_id = s.org_id and wp.id = e.worker_party_id
       where s.org_id = ${ctx.orgId}
         and p.status = 'open'
         and s.status = 'pending'
         and ((s.owner_kind = 'employee' and e.worker_party_id = ${partyId})
              or (s.owner_kind = 'named_party' and s.owner_party_id = ${partyId}))
       order by s.due_on, s.id
       limit 100
    `)).rows;
    return rows.map((row) => {
      const dueAt = new Date(`${row.due_on}T00:00:00Z`).toISOString();
      const needsFile = row.evidence_kind === "attachment";
      return {
        id: inboxItemId("hrm_process_step", row.id),
        kind: "hrm_process_step",
        title: row.title,
        subtitle: needsFile
          ? `${row.process_kind} for ${row.worker_name} — needs a file attached in the checklist before it can complete`
          : `${row.process_kind} for ${row.worker_name}${row.required ? " — required" : ""}`,
        dueAt,
        createdAt: dueAt,
        priority: priorityForDueDate(dueAt, today),
        subjectHref: `/hrm/processes?process=${row.process_id}`,
        actions: needsFile
          ? []
          : [{ key: "complete", label: "Mark complete", style: "primary", needsReason: false }],
        source: { kind: "hrm_process_step", id: row.id },
      } satisfies InboxItem;
    });
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    if (actionKey !== "complete") {
      throw new Error(`action ${JSON.stringify(actionKey)} is not available on this checklist step`);
    }
    void reason;
    await completeProcessStep({ orgId: ctx.orgId, actorId: ctx.actorId, stepId: sourceId });
  },
};
