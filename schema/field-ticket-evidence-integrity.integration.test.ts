/// <reference types="node" />

/**
 * Fresh-install regression coverage for migration 0018.  The baseline's
 * shared field-ticket evidence trigger referenced signature-only and
 * request-only columns directly, so the production signing-link INSERT
 * failed with 42703 before it could persist a request.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";
import { createScratchOrg, dropScratchOrg } from "../engine/src/test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

async function insertFieldTicket(orgId: string, date: string): Promise<string> {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, currency, created_by)
    values
      (${documentId}, ${orgId}, 'field_ticket', 'approved', ${`FT-${documentId.slice(0, 8)}`},
       ${date}, 'CAD', null)`);
  await db.execute(sql`
    insert into field_tickets
      (document_id, org_id, period, period_start, period_end)
    values (${documentId}, ${orgId}, 'daily', ${date}, ${date})`);
  return documentId;
}

async function insertEmailLog(orgId: string, id = randomUUID()): Promise<string> {
  await db.execute(sql`
    insert into email_log (id, org_id, subject, recipient_primary)
    values (${id}, ${orgId}, 'Field-ticket signature request', 'customer@example.test')`);
  return id;
}

async function insertSignatureFile(orgId: string, id = randomUUID()): Promise<string> {
  const folderId = randomUUID();
  await db.execute(sql`
    insert into folders (id, org_id, name)
    values (${folderId}, ${orgId}, 'Signature evidence')`);
  await db.execute(sql`
    insert into files
      (id, org_id, folder_id, name, extension, file_type, content_type, size_bytes)
    values (${id}, ${orgId}, ${folderId}, 'signature.png', 'png', 'image', 'image/png', 4)`);
  return id;
}

async function assertRejected(query: Promise<unknown>, scenario: string): Promise<void> {
  await assert.rejects(query, (error: unknown) => {
    const message = pgMessage(error);
    assert.doesNotMatch(message, /record "new" has no field/, `${scenario}: no 42703 row-shape failure`);
    return /field ticket evidence|signature file|signature email evidence|foreign key|violates not-null|duplicate key|unique constraint/i.test(message);
  }, scenario);
}

/** The production evidence tables are intentionally append-only.  Remove the
 * test rows under the same one-transaction trigger-disable escape used by the
 * repository teardown for unconditional evidence guards. */
async function clearFieldTicketEvidence(orgId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(
      'alter table public."field_ticket_signatures" disable trigger field_ticket_signature_immutable',
    ));
    await tx.execute(sql.raw(
      'alter table public."field_ticket_signature_requests" disable trigger field_ticket_signature_request_immutable',
    ));
    await tx.execute(sql`delete from field_ticket_signatures where org_id = ${orgId}`);
    await tx.execute(sql`delete from field_ticket_signature_requests where org_id = ${orgId}`);
    await tx.execute(sql.raw(
      'alter table public."field_ticket_signatures" enable trigger field_ticket_signature_immutable',
    ));
    await tx.execute(sql.raw(
      'alter table public."field_ticket_signature_requests" enable trigger field_ticket_signature_request_immutable',
    ));
  });
}

test(
  "field-ticket signing evidence is valid, tenant-bound, replay-safe, and migration-replay safe",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const org = await createScratchOrg();
    const otherOrg = await createScratchOrg();
    try {
      const ticketId = await insertFieldTicket(org.orgId, org.date);
      const emailLogId = await insertEmailLog(org.orgId);
      const signatureFileId = await insertSignatureFile(org.orgId);
      const requestId = randomUUID();
      const tokenDigest = `digest-${randomUUID()}`;

      // This is the exact column shape used by web/lib/field-ticket-signing.ts.
      await db.execute(sql`
        insert into field_ticket_signature_requests
          (id, org_id, field_ticket_id, recipient, message, sent_at, expires_at,
           token_digest, email_log_id, created_by)
        values (${requestId}, ${org.orgId}, ${ticketId}, 'customer@example.test',
                'Please sign this field ticket', null, now() + interval '1 day',
                ${tokenDigest}, ${emailLogId}, null)`);

      await db.execute(sql`
        insert into field_ticket_signatures
          (id, org_id, field_ticket_id, role, signer_name, comment,
           signature_file_id, signed_at, created_by)
        values (${randomUUID()}, ${org.orgId}, ${ticketId}, 'customer', 'Customer',
                'Approved', ${signatureFileId}, now(), null)`);

      const persisted = await db.execute<{ requests: number; signatures: number }>(sql`
        select
          (select count(*)::int from field_ticket_signature_requests where id = ${requestId}) as requests,
          (select count(*)::int from field_ticket_signatures where org_id = ${org.orgId} and field_ticket_id = ${ticketId}) as signatures`);
      assert.deepEqual(persisted.rows[0], { requests: 1, signatures: 1 }, "valid request and signature evidence persists");

      // A request replay with the same possession digest is rejected by the
      // storage uniqueness fence, while the original evidence remains intact.
      await assertRejected(
        db.execute(sql`
          insert into field_ticket_signature_requests
            (id, org_id, field_ticket_id, recipient, expires_at, token_digest)
          values (${randomUUID()}, ${org.orgId}, ${ticketId}, 'customer@example.test',
                  now() + interval '1 day', ${tokenDigest})`),
        "replayed signing-link request",
      );

      const foreignEmailLogId = await insertEmailLog(otherOrg.orgId);
      await assertRejected(
        db.execute(sql`
          insert into field_ticket_signature_requests
            (id, org_id, field_ticket_id, recipient, expires_at, token_digest, email_log_id)
          values (${randomUUID()}, ${org.orgId}, ${ticketId}, 'customer@example.test',
                  now() + interval '1 day', ${`foreign-email-${randomUUID()}`}, ${foreignEmailLogId})`),
        "cross-organization email evidence",
      );

      const foreignSignatureFileId = await insertSignatureFile(otherOrg.orgId);
      await assertRejected(
        db.execute(sql`
          insert into field_ticket_signatures
            (id, org_id, field_ticket_id, role, signer_name, signature_file_id, signed_at)
          values (${randomUUID()}, ${org.orgId}, ${ticketId}, 'foreman', 'Foreman',
                  ${foreignSignatureFileId}, now())`),
        "cross-organization signature-file evidence",
      );

      await assertRejected(
        db.execute(sql`
          insert into field_ticket_signatures
            (id, org_id, field_ticket_id, role, signer_name, signature_file_id, signed_at)
          values (${randomUUID()}, ${org.orgId}, ${ticketId}, 'foreman', 'Foreman',
                  ${randomUUID()}, now())`),
        "missing signature-file evidence",
      );

      // Replaying this forward migration must be a no-op for data and must not
      // restore the baseline's row-shape error.
      const migrationPath = fileURLToPath(
        new URL("./migrations/generated/0018_field_ticket_evidence_integrity_guard.sql", import.meta.url),
      );
      await pool.query(readFileSync(migrationPath, "utf8"));
      const afterReplay = await db.execute<{ requests: number; signatures: number }>(sql`
        select
          (select count(*)::int from field_ticket_signature_requests where id = ${requestId}) as requests,
          (select count(*)::int from field_ticket_signatures where org_id = ${org.orgId} and field_ticket_id = ${ticketId}) as signatures`);
      assert.deepEqual(afterReplay.rows[0], { requests: 1, signatures: 1 }, "migration replay preserves existing evidence rows");

      const secondTicketId = await insertFieldTicket(org.orgId, org.date);
      await db.execute(sql`
        insert into field_ticket_signature_requests
          (id, org_id, field_ticket_id, recipient, expires_at, token_digest)
        values (${randomUUID()}, ${org.orgId}, ${secondTicketId}, 'customer@example.test',
                now() + interval '1 day', ${`post-replay-${randomUUID()}`})`);
    } finally {
      await clearFieldTicketEvidence(otherOrg.orgId);
      await clearFieldTicketEvidence(org.orgId);
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
