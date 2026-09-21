/**
 * HR-20 crew_time_batch adapter — batches waiting on the actor.
 *
 * Approver leg: flow gates on crew_time_batch subjects, acting through
 * decideGate / delegateGate — the same release path the crew surface
 * uses. Own leg: my draft or rejected batches, link-only. Submission
 * and posting run through the crew service guards, which the inbox
 * does not duplicate — subtitles name the remedy.
 */

import { sql } from "drizzle-orm";
import { CREW_TIME_BATCH_SUBJECT_KIND } from "../../flows/crew-batches-adapter.ts";
import { decideGate, delegateGate } from "../../flows/gates.ts";
import { worklistApprovals } from "../../flows/approval-worklist.ts";
import { actorPartyId, toWorklistScope } from "../guard.ts";
import { db } from "../../platform/db.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId, priorityForDueDate } from "../types.ts";

type OwnBatchRow = {
  id: string;
  worked_on: string;
  status: string;
  project_name: string | null;
};

export const crewTimeBatchAdapter: InboxAdapter = {
  kind: "crew_time_batch",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const out: InboxItem[] = [];
    const approvals = await worklistApprovals(ctx.orgId, ctx.actorId, toWorklistScope(ctx));
    for (const item of approvals) {
      if (item.kind !== "flow_gate" || item.gate.subjectKind !== CREW_TIME_BATCH_SUBJECT_KIND) continue;
      const gate = item.gate;
      const dueAt = gate.escalateAt ? new Date(gate.escalateAt).toISOString() : null;
      out.push({
        id: inboxItemId("crew_time_batch", `gate:${gate.id}`),
        kind: "crew_time_batch",
        title: gate.title,
        subtitle: `crew batch approval${gate.onBehalfOf ? ` on behalf of ${gate.onBehalfOf.name}` : ""} — waiting since ${new Date(gate.createdAt).toISOString().slice(0, 10)}`,
        dueAt,
        createdAt: new Date(gate.createdAt).toISOString(),
        priority: priorityForDueDate(dueAt, ctx.asOf),
        subjectHref: gate.href ?? "/time/crew",
        actions: [
          { key: "approve", label: "Approve", style: "primary" as const, needsReason: false },
          { key: "reject", label: "Reject", style: "danger" as const, needsReason: true },
          { key: "delegate", label: "Delegate", style: "secondary" as const, needsReason: true },
        ],
        source: { kind: "crew_time_batch_gate", id: gate.id },
      });
    }
    const partyId = await actorPartyId(ctx.orgId, ctx.actorId);
    if (partyId) {
      const batches = (await db.execute<OwnBatchRow>(sql`
        select b.id::text as id, b.worked_on::text as worked_on, b.status,
               p.name as project_name
          from crew_time_batches b
          left join projects p on p.org_id = b.org_id and p.id = b.project_id
         where b.org_id = ${ctx.orgId}
           and b.foreman_party_id = ${partyId}
           and b.status in ('draft', 'rejected')
         order by b.worked_on desc
         limit 10
      `)).rows;
      for (const batch of batches) {
        out.push({
          id: inboxItemId("crew_time_batch", `own:${batch.id}`),
          kind: "crew_time_batch",
          title: `Crew batch ${batch.status === "rejected" ? "rejected" : "unsubmitted"} — ${batch.project_name ?? "project"} ${batch.worked_on}`,
          subtitle:
            batch.status === "rejected"
              ? "rejected — fix the flagged lines and resubmit the batch in Crew time"
              : "the batch is still a draft — sign and submit it in Crew time",
          dueAt: null,
          createdAt: new Date(`${batch.worked_on}T00:00:00Z`).toISOString(),
          priority: "normal" as const,
          subjectHref: `/time/crew?batch=${batch.id}`,
          actions: [],
          source: { kind: "crew_time_batch", id: batch.id },
        });
      }
    }
    return out;
  },
  async act(ctx, sourceId, actionKey, reason): Promise<void> {
    if (sourceId.startsWith("gate:")) {
      const gateId = sourceId.slice("gate:".length);
      if (actionKey === "approve") {
        await decideGate({ gateId, decision: "approved", userId: ctx.actorId, comment: reason });
        return;
      }
      if (actionKey === "reject") {
        await decideGate({ gateId, decision: "rejected", userId: ctx.actorId, comment: reason });
        return;
      }
      if (actionKey === "delegate") {
        const match = /^user:([0-9a-f-]{36})\s*:?\s*(.*)$/i.exec(reason ?? "");
        if (!match) {
          throw new Error(
            "delegation needs a recipient — give the reason as the colleague taking over, then the handover note",
          );
        }
        await delegateGate(gateId, ctx.actorId, match[1]!);
        return;
      }
    }
    throw new Error(
      `action ${JSON.stringify(actionKey)} is not available here — decide the batch in Crew time`,
    );
  },
};
