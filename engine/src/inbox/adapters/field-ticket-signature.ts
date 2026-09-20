/**
 * HR-15 field_ticket_signature adapter — tickets awaiting my signature.
 *
 * A ticket waits on the actor when they are its foreman (or submitted it)
 * and an unanswered signature request is open on it (sent, not responded,
 * not revoked, not expired), or the ticket's role signature is simply
 * missing. Link-only: signing captures a typed attestation through the
 * ticket signing surface (token + e-sign), which the inbox does not
 * duplicate — the subtitle names that remedy.
 */

import { sql } from "drizzle-orm";
import { actorPartyId } from "../guard.ts";
import { db } from "../../platform/db.ts";
import type { InboxAdapter } from "../registry.ts";
import type { InboxItem, InboxListContext } from "../types.ts";
import { inboxItemId } from "../types.ts";

type TicketRow = {
  ticket_id: string;
  project_name: string;
  period_start: string;
  role: string;
};

export const fieldTicketSignatureAdapter: InboxAdapter = {
  kind: "field_ticket_signature",
  async list(ctx: InboxListContext): Promise<InboxItem[]> {
    const partyId = await actorPartyId(ctx.orgId, ctx.actorId);
    if (!partyId) return [];
    const rows = (await db.execute<TicketRow>(sql`
      select distinct t.document_id::text as ticket_id,
             coalesce(p.name, 'field ticket') as project_name,
             t.period_start::text as period_start,
             r.role as role
        from field_tickets t
        join field_ticket_signature_requests r
          on r.org_id = t.org_id and r.field_ticket_id = t.document_id
        left join projects p on p.org_id = t.org_id and p.id = (
          select te.project_id from time_entries te
           where te.org_id = t.org_id and te.field_ticket_id = t.document_id
           limit 1)
       where t.org_id = ${ctx.orgId}
         and (t.foreman_party_id = ${partyId} or t.submitted_by = ${ctx.actorId})
         and r.sent_at is not null
         and r.responded_at is null
         and r.revoked_at is null
         and r.expires_at > now()
         and not exists (
           select 1 from field_ticket_signatures s
            where s.org_id = t.org_id
              and s.field_ticket_id = t.document_id
              and s.role = r.role)
       order by t.period_start, t.document_id
       limit 20
    `)).rows;
    return rows.map((row) => ({
      id: inboxItemId("field_ticket_signature", `${row.ticket_id}:${row.role}`),
      kind: "field_ticket_signature",
      title: `Sign ${row.project_name} ticket — ${row.role}`,
      subtitle: `week of ${row.period_start} waits for your ${row.role} signature — sign it on the ticket`,
      dueAt: null,
      createdAt: ctx.asOf,
      priority: "due_soon" as const,
      subjectHref: `/field-tickets?ticket=${row.ticket_id}`,
      actions: [],
      source: { kind: "field_ticket_signature_request", id: row.ticket_id },
    }));
  },
  async act(): Promise<void> {
    throw new Error(
      "signing happens on the field ticket — open it and sign with your typed attestation",
    );
  },
};
