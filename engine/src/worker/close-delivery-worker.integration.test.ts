import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { processCloseDeliveryJobData } from "./close-delivery-worker.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function seedPackage(orgId: string, recipients: unknown): Promise<{ packageId: string; periodId: string; bookId: string }> {
  const period = (await db.execute<{ id: string }>(sql`
    select id from accounting_periods where org_id = ${orgId} order by starts_on limit 1
  `)).rows[0]!;
  const book = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} limit 1
  `)).rows[0]!;
  assert.ok(period?.id && book?.id, "scratch org must carry a period and a book");
  const packageId = randomUUID();
  await db.execute(sql`
    insert into close_reporting_packages (id, org_id, name, reports, recipients, delivery)
    values (${packageId}, ${orgId}, 'recipient contract',
            '[{"slug":"no-such-report"}]'::jsonb, ${JSON.stringify(recipients)}::jsonb, '{}'::jsonb)
  `);
  return { packageId, periodId: period.id, bookId: book.id };
}

test("close delivery refuses a malformed recipient before any render work", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { packageId, periodId, bookId } = await seedPackage(org.orgId, ["not-an-email"]);
    // The bogus slug guarantees the pre-fix code reaches the render phase
    // (and dies there) instead of tripping over anything else first.
    await assert.rejects(
      processCloseDeliveryJobData({ orgId: org.orgId, packageId, periodId, bookId }),
      /invalid recipient/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
