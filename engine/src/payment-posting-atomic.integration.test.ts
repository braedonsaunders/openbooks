import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "./db.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { createPaymentDocument, postPaymentWithApplications } from "./payments.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a failed draft payment post rolls its approval release back atomically",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Payment poster", "admin"),
      );
      const payment = await withOrgContext(org.orgId, () =>
        createPaymentDocument({
          orgId: org.orgId,
          kind: "customer_payment",
          createdBy: actorId,
          partyId: org.customerId,
          bankAccountId: org.accounts.bank,
          subsidiaryId: org.subsidiaryId,
          documentDate: org.date,
          currency: "CAD",
        }),
      );

      await assert.rejects(
        withOrgTransaction(org.orgId, async () => {
          const released = await submitAndReleaseIfUngated(
            "customer_payment",
            payment.id,
            actorId,
          );
          assert.equal(released.autoApproved, true);
          await postPaymentWithApplications(
            payment.id,
            undefined,
            actorId,
            "ui",
            { deferEffects: true },
          );
        }),
        /select at least one open item to apply/,
      );

      const state = await withOrgContext(org.orgId, async () =>
        (await db.execute(sql`
          select status, submitted_at, posted_entry_id,
                 (select count(*)::int from journal_entries
                   where source_document_id = ${payment.id}) as entry_count
            from documents where id = ${payment.id}
        `)) as unknown as {
          rows: Array<{
            status: string;
            submitted_at: string | null;
            posted_entry_id: string | null;
            entry_count: number;
          }>;
        },
      );
      assert.deepEqual(state.rows[0], {
        status: "draft",
        submitted_at: null,
        posted_entry_id: null,
        entry_count: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
