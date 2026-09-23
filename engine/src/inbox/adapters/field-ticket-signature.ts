/**
 * HR-15 field_ticket_signature adapter — signature requests addressed to me.
 *
 * A signature request is an email to a named recipient asking for the
 * ticket's CUSTOMER signature (the signing endpoint records role='customer'
 * and nothing else; requests carry no role column). The ticket waits on
 * the actor only when an open request (sent, not responded, not revoked,
 * not expired) is addressed to the actor's own user email and the customer
 * signature is still missing. Matching the foreman or the submitter instead
 * pages the wrong person: the request names its recipient, and only that
 * mailbox holds the signing link.
 *
 * Link-only: signing happens through the emailed token link, which the
 * inbox does not duplicate — the subtitle names that remedy (resend the
 * request from the ticket if the link is lost).
 */

import { sql } from "drizzle-orm";
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
    const rows = (await db.execute<TicketRow>(sql`
      select distinct t.document_id::text as ticket_id,
             coalesce(p.name, 'field ticket') as project_name,
             t.period_start::text as period_start,
             'customer' as role
        from field_tickets t
        join field_ticket_signature_requests r
          on r.org_id = t.org_id and r.field_ticket_id = t.document_id
        join users u
          on u.org_id = t.org_id and u.id = ${ctx.actorId}
         and lower(u.email) = lower(r.recipient)
        left join projects p on p.org_id = t.org_id and p.id = (
          select te.project_id from time_entries te
           where te.org_id = t.org_id and te.field_ticket_id = t.document_id
           limit 1)
       where t.org_id = ${ctx.orgId}
         and r.sent_at is not null
         and r.responded_at is null
         and r.revoked_at is null
         and r.expires_at > now()
         and not exists (
           select 1 from field_ticket_signatures s
            where s.org_id = t.org_id
              and s.field_ticket_id = t.document_id
              and s.role = 'customer')
       order by period_start, ticket_id
       limit 20
    `)).rows;
    return rows.map((row) => ({
      id: inboxItemId("field_ticket_signature", `${row.ticket_id}:${row.role}`),
      kind: "field_ticket_signature",
      title: `Sign ${row.project_name} ticket — customer signature`,
      subtitle: `week of ${row.period_start} waits for the customer signature — sign it from the link emailed to you`,
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
      "customer signing happens through the signing link emailed to you — open it from your email, or resend the request from the ticket",
    );
  },
};
