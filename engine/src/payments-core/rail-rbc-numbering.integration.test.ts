import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { allocateRbcStd152Number } from "./rail-rbc-identity.ts";

test(
  "RBC numbering serializes payroll/AP allocations, isolates clients and tenants, rolls back and refuses exhaustion",
  {
    skip: !process.env.OPENBOOKS_DB_URL,
  },
  async () => {
    const first = await createScratchOrg();
    const second = await createScratchOrg();
    const client = "1234567890";
    try {
      const numbers = await Promise.all(
        Array.from({ length: 4 }, () =>
          withOrgTransaction(first.orgId, () => allocateRbcStd152Number(db, first.orgId, client)),
        ),
      );
      assert.deepEqual(
        numbers.sort((a, b) => a - b),
        [1, 2, 3, 4],
      );
      assert.equal(
        await withOrgTransaction(second.orgId, () =>
          allocateRbcStd152Number(db, second.orgId, client),
        ),
        1,
      );
      assert.equal(
        await withOrgTransaction(first.orgId, () =>
          allocateRbcStd152Number(db, first.orgId, "9876543210"),
        ),
        1,
      );
      await assert.rejects(
        withOrgTransaction(first.orgId, async () => {
          assert.equal(await allocateRbcStd152Number(db, first.orgId, client), 5);
          throw new Error("rollback allocation");
        }),
        /rollback allocation/,
      );
      assert.equal(
        await withOrgTransaction(first.orgId, () =>
          allocateRbcStd152Number(db, first.orgId, client),
        ),
        5,
      );
      const kind = "rbc_std152:" + createHash("sha256").update(client).digest("hex");
      await withOrgContext(first.orgId, () =>
        db.execute(sql`
      update number_sequences set next_number=9999 where org_id=${first.orgId} and document_kind=${kind}
    `),
      );
      await assert.rejects(
        withOrgTransaction(first.orgId, () => allocateRbcStd152Number(db, first.orgId, client)),
        (error) => String(error instanceof Error ? error.message : error).includes("exhausted"),
      );
      const stored = await withOrgContext(first.orgId, () =>
        db.execute<{ next_number: number }>(
          sql`
      select next_number from number_sequences where org_id=${first.orgId} and document_kind=${kind}
    `,
          "objects",
        ),
      );
      assert.equal(Number(stored[0]!.next_number), 9999);
    } finally {
      await dropScratchOrgReporting(first.orgId);
      await dropScratchOrgReporting(second.orgId);
    }
  },
);
