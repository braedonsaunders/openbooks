/**
 * HR-15 field_ticket_signature adapter — DB integration.
 *
 * The adapter's request join must resolve against columns the
 * field_ticket_signature_requests table actually has: with an established
 * actor identity the query runs (no undefined_column) and surfaces the
 * ticket with its pending customer role.
 *
 * Integration partition: skips without OPENBOOKS_DB_URL; run one file per
 * database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { listInbox } from "./registry.ts";
import "./index.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const nowIso = (): string => new Date().toISOString();

/**
 * Signature requests are retained evidence: the immutable trigger refuses
 * DELETE. Clear this test's rows under the same one-transaction
 * trigger-disable escape the evidence suite uses, so the scratch org can
 * drop.
 */
async function clearSignatureRequests(orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(
      'alter table public."field_ticket_signature_requests" disable trigger field_ticket_signature_request_immutable',
    ));
    await tx.execute(sql`delete from field_ticket_signature_requests where org_id = ${orgId}`);
    await tx.execute(sql.raw(
      'alter table public."field_ticket_signature_requests" enable trigger field_ticket_signature_request_immutable',
    ));
  });
}

async function seedTicketWithOpenRequest(org: ScratchOrg, actorId: string): Promise<{ ticketId: string }> {
  const foremanParty = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${foremanParty}, ${org.orgId}, 'person', 'Ticket Foreman', true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${foremanParty} where id = ${actorId} and org_id = ${org.orgId}`);
  const ticketId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, document_date, currency, status)
    values (${ticketId}, ${org.orgId}, 'field_ticket', 'FT-1', '2026-08-01', 'CAD', 'approved')
  `);
  await db.execute(sql`
    insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id)
    values (${ticketId}, ${org.orgId}, 'weekly', '2026-07-27', '2026-08-02', ${foremanParty})
  `);
  await db.execute(sql`
    insert into field_ticket_signature_requests
      (id, org_id, field_ticket_id, recipient, sent_at, expires_at, token_digest)
    values (${randomUUID()}, ${org.orgId}, ${ticketId}, 'customer@example.com',
            now(), now() + interval '7 days', ${`digest-${ticketId}`})
  `);
  return { ticketId };
}

test("an open signature request surfaces the ticket instead of failing the inbox read", { skip: !DB }, async () => {
  const org: ScratchOrg = await createScratchOrg();
  try {
    const foremanId = await createScratchUser(org.orgId, "Ticket Foreman", "foreman");
    const { ticketId } = await seedTicketWithOpenRequest(org, foremanId);
    const ctx = { orgId: org.orgId, actorId: foremanId, asOf: nowIso() };
    const items = await listInbox(ctx, { kinds: ["field_ticket_signature"] });
    assert.equal(items.length, 1, "the foreman's ticket with an open request lists exactly once");
    assert.equal(items[0]!.source.id, ticketId);
    assert.match(items[0]!.title, /customer/);
  } finally {
    await clearSignatureRequests(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});
