import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";
import { featureDisableStatuses } from "./features";

/**
 * Turning Projects off is refused while a project still has open documents
 * of any kind: draft, awaiting approval or approved (field tickets are
 * counted on their own line).
 */
test(
  "open project documents of every kind block turning Projects off",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const project = randomUUID();
        await db.execute(
          sql`insert into projects (id, org_id, name, is_active, status) values (${project}, ${org.orgId}, 'Fence test', false, 'closed')`,
        );
        const insert = (kind: string, status: string) =>
          db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, project_id)
        values (${randomUUID()}, ${org.orgId}, ${kind}, ${status}, ${randomUUID()}, ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 1, 10, 0, 10, ${project})`);
        await insert("customer_invoice", "draft");
        await insert("estimate", "approved");
        await insert("vendor_bill", "pending_approval");
      });
      const projects = (
        await withBypassContext(() => featureDisableStatuses(org.orgId, ["projects"]))
      ).projects!;
      assert.deepEqual(
        projects.impacts.find((impact) => impact.labelKey === "openProjectDocuments"),
        { labelKey: "openProjectDocuments", count: 3 },
      );
      assert.equal(projects.blocked, true);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
