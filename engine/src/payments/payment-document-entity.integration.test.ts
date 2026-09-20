import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createPaymentDocument } from "./payment-documents.ts";

test("payment drafts persist the explicit entity or resolve the party then root entity", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      const childId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, name, base_currency, country, parent_id)
        values (${childId}, ${org.orgId}, 'Payment entity', 'CAD', 'CA', ${org.subsidiaryId})
      `);
      await db.execute(sql`
        update parties set subsidiary_id = ${childId}
         where id = ${org.customerId} and org_id = ${org.orgId}
      `);
      const common = {
        orgId: org.orgId,
        kind: "customer_payment" as const,
        createdBy: null,
        documentDate: org.date,
      };
      const fromParty = await createPaymentDocument({ ...common, partyId: org.customerId });
      const fromRoot = await createPaymentDocument(common);
      const explicit = await createPaymentDocument({
        ...common, partyId: org.customerId, subsidiaryId: org.subsidiaryId,
      });
      for (const [document, expected] of [
        [fromParty, childId], [fromRoot, org.subsidiaryId], [explicit, org.subsidiaryId],
      ] as const) {
        const stored = await db.execute<{ subsidiary_id: string; org_id: string }>(sql`
          select subsidiary_id, org_id from documents
           where id = ${document.id} and org_id = ${org.orgId}
        `);
        assert.equal(stored.rows.length, 1, "the created draft must be readable in its organization");
        assert.equal(stored.rows[0]!.org_id, org.orgId);
        assert.equal(stored.rows[0]!.subsidiary_id, expected);
      }
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
