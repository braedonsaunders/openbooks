/**
 * HR-15 field_ticket_signature adapter — DB integration.
 *
 * A signature request is an email to a named recipient asking for the
 * ticket's customer signature. The adapter surfaces the ticket only to
 * the ADDRESSED recipient (matched by user email) — never to the foreman
 * or submitter — and only while the request is open with the customer
 * signature still missing. The query resolves against columns the
 * requests table actually has (no undefined_column).
 *
 * Fixtures require a marked, dedicated ephemeral database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  assertDedicatedFixtureDatabase,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { countInbox, listInbox } from "./registry.ts";
import "./index.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const nowIso = (): string => new Date().toISOString();

/**
 * Signature requests are retained evidence. This cleanup is restricted to
 * the marked disposable fixture database and restores its immutable guard
 * in the same transaction.
 */
async function clearSignatureRequests(orgId: string): Promise<void> {
  await assertDedicatedFixtureDatabase();
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

async function userEmail(orgId: string, userId: string): Promise<string> {
  const row = (await db.execute<{ email: string }>(sql`
    select email from users where org_id = ${orgId} and id = ${userId}
  `)).rows[0];
  return row!.email;
}

async function seedTicketWithOpenRequest(
  org: ScratchOrg,
  foremanId: string,
  recipient: string,
): Promise<{ ticketId: string }> {
  const foremanParty = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${foremanParty}, ${org.orgId}, 'person', 'Ticket Foreman', true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${foremanParty} where id = ${foremanId} and org_id = ${org.orgId}`);
  const ticketId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, document_date, currency, status)
    values (${ticketId}, ${org.orgId}, 'field_ticket', ${`FT-${ticketId}`}, '2026-08-01', 'CAD', 'approved')
  `);
  await db.execute(sql`
    insert into field_tickets (document_id, org_id, period, period_start, period_end, foreman_party_id)
    values (${ticketId}, ${org.orgId}, 'weekly', '2026-07-27', '2026-08-02', ${foremanParty})
  `);
  await db.execute(sql`
    insert into field_ticket_signature_requests
      (id, org_id, field_ticket_id, recipient, sent_at, expires_at, token_digest)
    values (${randomUUID()}, ${org.orgId}, ${ticketId}, ${recipient},
            now(), now() + interval '7 days', ${`digest-${ticketId}`})
  `);
  return { ticketId };
}

test("an open request surfaces the ticket to its addressed recipient, not the foreman", { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org: ScratchOrg = await createScratchOrg();
  try {
    const foremanId = await createScratchUser(org.orgId, "Ticket Foreman", "foreman");
    const addresseeId = await createScratchUser(org.orgId, "Ticket Addressee", "foreman");
    const recipient = await userEmail(org.orgId, addresseeId);
    const { ticketId } = await seedTicketWithOpenRequest(org, foremanId, recipient);

    // The foreman owns the ticket but holds no signing link: nothing waits
    // on them, even though the old matcher paged exactly them.
    const foremanItems = await listInbox(
      { orgId: org.orgId, actorId: foremanId, asOf: nowIso() },
      { kinds: ["field_ticket_signature"] },
    );
    assert.equal(foremanItems.length, 0, "a request addressed elsewhere is not the foreman's work");
    assert.equal(await countInbox({ orgId: org.orgId, actorId: foremanId, asOf: nowIso() },
      { kinds: ["field_ticket_signature"] }), 0);

    // The addressed recipient sees the ticket once, named as the customer
    // signature with the emailed link as the remedy.
    const items = await listInbox(
      { orgId: org.orgId, actorId: addresseeId, asOf: nowIso() },
      { kinds: ["field_ticket_signature"] },
    );
    assert.equal(items.length, 1, "the addressed recipient sees exactly one item");
    const [item] = items;
    assert.ok(item);
    assert.equal(item.source.id, ticketId);
    assert.match(item.title, /customer signature/);
    assert.ok(item.subtitle, "the item names its remedy");
    assert.match(item.subtitle, /link emailed to you/);
    assert.equal(await countInbox({ orgId: org.orgId, actorId: addresseeId, asOf: nowIso() },
      { kinds: ["field_ticket_signature"] }), 1);
  } finally {
    await clearSignatureRequests(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("an answered request leaves the addressed recipient's inbox", { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org: ScratchOrg = await createScratchOrg();
  try {
    const foremanId = await createScratchUser(org.orgId, "Ticket Foreman", "foreman");
    const addresseeId = await createScratchUser(org.orgId, "Ticket Addressee", "foreman");
    const recipient = await userEmail(org.orgId, addresseeId);
    const { ticketId } = await seedTicketWithOpenRequest(org, foremanId, recipient);
    await db.execute(sql`
      update field_ticket_signature_requests set responded_at = now()
       where org_id = ${org.orgId} and field_ticket_id = ${ticketId}
    `);
    const items = await listInbox(
      { orgId: org.orgId, actorId: addresseeId, asOf: nowIso() },
      { kinds: ["field_ticket_signature"] },
    );
    assert.equal(items.length, 0, "an answered request is no one's inbox work");
    assert.equal(await countInbox({ orgId: org.orgId, actorId: addresseeId, asOf: nowIso() },
      { kinds: ["field_ticket_signature"] }), 0);
  } finally {
    await clearSignatureRequests(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});

test("signature counts span pages, deduplicate requests and preserve recipient and live-response scope", { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org = await createScratchOrg();
  try {
    const foremanId = await createScratchUser(org.orgId, "Ticket Foreman", "foreman");
    const actorId = await createScratchUser(org.orgId, "Ticket Addressee", "foreman");
    const recipient = await userEmail(org.orgId, actorId);
    const tickets: string[] = [];
    for (let i = 0; i < 24; i++) {
      tickets.push((await seedTicketWithOpenRequest(org, foremanId, recipient.toUpperCase())).ticketId);
    }
    await seedTicketWithOpenRequest(org, foremanId, await userEmail(org.orgId, foremanId));
    await db.execute(sql`insert into field_ticket_signature_requests
      (id, org_id, field_ticket_id, recipient, sent_at, expires_at, token_digest)
      values (${randomUUID()}, ${org.orgId}, ${tickets[0]!}, ${recipient}, now(),
        now() + interval '7 days', ${randomUUID()})`);
    const ctx = { orgId: org.orgId, actorId, asOf: nowIso() };
    const kinds = ["field_ticket_signature"] as const;
    assert.equal(await countInbox(ctx, { kinds: [...kinds] }), 24,
      "the badge counts all distinct addressed tickets, including those beyond its first page");
    const first = await listInbox(ctx, { kinds: [...kinds], page: { limit: 20, offset: 0 } });
    const second = await listInbox(ctx, { kinds: [...kinds], page: { limit: 20, offset: 20 } });
    assert.equal(first.length, 20);
    assert.equal(second.length, 4);
    assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 24,
      "stable page boundaries neither repeat nor omit a ticket");
    assert.deepEqual([...first, ...second].map((item) => item.source.id).sort(), tickets.sort());
    await db.execute(sql`update field_ticket_signature_requests set responded_at = now()
      where org_id = ${org.orgId} and field_ticket_id = ${tickets[0]!}`);
    assert.equal(await countInbox(ctx, { kinds: [...kinds] }), 23,
      "the next count observes a response even when the same read context is reused");
    assert.equal(await countInbox({ ...ctx, actorId: randomUUID() }, { kinds: [...kinds] }), 0);
    assert.equal(await countInbox({ ...ctx, orgId: randomUUID() }, { kinds: [...kinds] }), 0,
      "the recipient identity never widens another organization's ticket visibility");
  } finally {
    await clearSignatureRequests(org.orgId);
    await dropScratchOrg(org.orgId);
  }
});
