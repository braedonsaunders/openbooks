import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import type { EnqueueEmailData } from "@openbooks/jobs";
import { isEmailAttachmentRef } from "@openbooks/emails";
import { db } from "../platform/db.ts";
import { loadEmailAttachments } from "./email-attachments.ts";
import { dispatchReportDeliveries } from "./report-delivery.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

before(() => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
});

test("dispatched report mail carries attachment references, never file bytes", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = randomUUID();
    const definitionId = randomUUID();
    const scheduleId = randomUUID();
    const runId = randomUUID();
    const pdf = Buffer.from("%PDF-1.7\nby-reference evidence");
    await db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'byref-contract',
              'By-reference contract', '{}'::jsonb, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into report_schedules
        (id, org_id, definition_id, cadence, hour, minute, timezone, recipient_emails, filters,
         next_run_at, active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, ${definitionId}, 'daily', 7, 0, 'UTC',
              '["controller@example.com"]'::jsonb,
              '{"combinator":"and","rules":[]}'::jsonb, now(), true, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into report_runs
        (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for, recipient_emails, next_attempt_at)
      values (${runId}, ${org.orgId}, ${scheduleId}, ${definitionId}, 'scheduled', 'succeeded',
              now(), '["controller@example.com"]'::jsonb, now())
    `);
    await db.execute(sql`
      insert into report_run_artifacts
        (org_id, run_id, filename, content_type, size_bytes, content_hash, bytes)
      values (${org.orgId}, ${runId}, 'contract.pdf', 'application/pdf', ${pdf.length},
              ${createHash("sha256").update(pdf).digest("hex")}, ${pdf})
    `);
    await db.execute(sql`
      insert into report_delivery_outbox (org_id, run_id, recipient, status, next_attempt_at)
      values (${org.orgId}, ${runId}, 'controller@example.com', 'pending', now())
    `);

    const captured: EnqueueEmailData[] = [];
    const dispatched = await dispatchReportDeliveries(async (data) => {
      captured.push(data);
      return [];
    }, new Date(Date.now() + 60_000));
    assert.equal(dispatched, 1);
    assert.equal(captured.length, 1);
    const attachments = captured[0]!.attachments ?? [];
    assert.equal(attachments.length, 1);
    const ref = attachments[0]!;
    assert.ok(isEmailAttachmentRef(ref), "queue payload must reference the bytes, not carry them");
    assert.ok(!("content" in ref), "no file bytes may sit in the Redis job payload");
    assert.ok(ref.filename.endsWith(".pdf"));

    // The worker materializes the same bytes at send time.
    const loaded = await loadEmailAttachments(attachments);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.filename, ref.filename);
    assert.deepEqual(Buffer.from(loaded[0]!.content, "base64"), pdf);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
