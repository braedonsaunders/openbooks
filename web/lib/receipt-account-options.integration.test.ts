import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedPostingAccount,
} from "@openbooks/engine/testing/fixtures";
import { saveProcessorReceiptPolicy } from "@openbooks/engine/payments/documents";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { bankAccountOptions, receiptAccountOptions } from "./documents.ts";

test(
  "receipt options add only a dated provider pool and leave native bank options unchanged",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Receipt accountant", "receipt_accountant"),
      );
      await withBypassContext(() =>
        grantScratchPermissions(org.orgId, actorId, ["ar.pay", "admin.setup.manage"]),
      );
      const pool = await withBypassContext(() =>
        seedPostingAccount(org.orgId, "1040", "Processor clearing", "asset_current_other"),
      );
      const unconfigured = await withBypassContext(() =>
        seedPostingAccount(org.orgId, "1041", "Other clearing", "asset_current_other"),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update accounts set reconcilable = false where org_id = ${org.orgId} and id = ${pool}`,
        ),
      );
      await saveProcessorReceiptPolicy(
        org.orgId,
        "stripe",
        {
          id: randomUUID(),
          accountId: pool,
          subsidiaryId: org.subsidiaryId,
          currency: "CAD",
          effectiveFrom: org.date,
          effectiveTo: org.date,
        },
        actorId,
        "Recognize processor-funded customer receipts",
        null,
      );
      const input = {
        orgId: org.orgId,
        actorId,
        kind: "customer_payment" as const,
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        onDate: org.date,
        allowedSubsidiaryIds: null,
      };
      const eligible = (await receiptAccountOptions(input)).map((row) => row.id);
      assert.ok(eligible.includes(pool));
      assert.ok(!eligible.includes(unconfigured));
      assert.ok(
        !(await receiptAccountOptions({ ...input, onDate: "2000-01-01" })).some(
          (row) => row.id === pool,
        ),
      );
      assert.ok(
        !(await withBypassContext(() => bankAccountOptions(org.orgId))).some(
          (row) => row.id === pool,
        ),
      );
      await assert.rejects(
        receiptAccountOptions({ ...input, allowedSubsidiaryIds: new Set() }),
        ScopeNotFoundError,
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
