import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

// Data-io resources are server-only. Shim that marker so this focused
// PostgreSQL boundary test can import them under node's test runner.
const { DOC_KINDS } =
  (await import("../document-kinds.ts")) as typeof import("../document-kinds.ts");
const { transactionResource } =
  (await import("./transaction-resources.ts")) as typeof import("./transaction-resources.ts");

const { db, withBypassContext, withOrg } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { controlDeps } = await import("@openbooks/engine/ledger/document-service");
const { postDocument } = await import("@openbooks/engine/ledger/posting-document");
const { returnDocumentToDraft } = await import("@openbooks/engine/flows/module");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * An imported vendor bill whose line names a tax code must carry the same tax
 * calculation evidence a drawer-entered bill carries, so it approves, returns
 * to draft, and posts without the "no calculation evidence" refusal.
 */
test(
  "an imported vendor bill with a tax-profiled line carries calculation evidence and posts",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const taxCodeId = randomUUID();
      const expenseNumber = await withBypassContext(async () => {
        await db.execute(sql`
          update parties set short_code = 'IMPORT-VENDOR' where id = ${org.vendorId} and org_id = ${org.orgId}`);
        await db.execute(sql`
          insert into tax_codes
            (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
          values (${taxCodeId}, ${org.orgId}, 'GST-IMPORT', 'GST on purchases', 'both', 'standard',
                  ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`);
        await db.execute(sql`
          insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from)
          values (${randomUUID()}, ${org.orgId}, ${taxCodeId}, '5', '2000-01-01')`);
        return (
          await db.execute<{ number: string }>(
            sql`
          select number from accounts where id = ${org.accounts.freight}`,
            "objects",
          )
        )[0]!.number;
      });

      const cfg = DOC_KINDS.vendor_bill;
      assert.ok(cfg);
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const outcome = await withOrg(org.orgId, () =>
        transactionResource(cfg, org.orgId).write(
          [
            {
              documentDate: org.date,
              party: "IMPORT-VENDOR",
              lines: JSON.stringify([
                { account: expenseNumber, amount: "100.0000", taxCode: "GST-IMPORT" },
              ]),
            },
          ],
          "insert",
          { orgId: org.orgId, actorId, dryRun: false },
        ),
      );
      assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] });

      const draft = (
        await withBypassContext(() =>
          db.execute<{ id: string; status: string; tax_total: string; total: string }>(
            sql`
        select id, status, tax_total::text as tax_total, total::text as total
          from documents where org_id = ${org.orgId} and kind = 'vendor_bill'`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(draft.status, "draft");
      assert.equal(draft.tax_total, "5.0000");
      assert.equal(draft.total, "105.0000");

      const evidence = (
        await withBypassContext(() =>
          db.execute<{ components: string; tax_amount: string }>(
            sql`
        select count(c.id)::text as components, max(l.tax_amount)::text as tax_amount
          from document_lines l
          left join document_line_tax_components c on c.document_line_id = l.id and c.org_id = l.org_id
         where l.org_id = ${org.orgId} and l.document_id = ${draft.id}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(
        evidence.components,
        "1",
        "the tax-profiled line carries its component evidence",
      );
      assert.equal(evidence.tax_amount, "5.0000");

      // Approve, return to draft, approve again, post. Returning to draft
      // must not refuse on tax evidence the import already wrote.
      await withBypassContext(() =>
        db.execute(sql`
        update documents set status = 'approved' where id = ${draft.id} and org_id = ${org.orgId}`),
      );
      const returned = await withOrg(org.orgId, () =>
        returnDocumentToDraft({
          documentId: draft.id,
          orgId: org.orgId,
          actorId,
          reason: "Correct the vendor bill before posting",
        }),
      );
      assert.equal(returned.status, "draft");
      await withBypassContext(() =>
        db.execute(sql`
        update documents set status = 'approved' where id = ${draft.id} and org_id = ${org.orgId}`),
      );

      const entryId = await withOrg(org.orgId, async () =>
        postDocument(draft.id, await controlDeps(org.orgId)),
      );
      const recoverable = (
        await withBypassContext(() =>
          db.execute<{ amount: string }>(
            sql`
        select coalesce(sum(l.amount), 0)::text as amount
          from journal_lines l
         where l.org_id = ${org.orgId} and l.entry_id = ${entryId} and l.account_id = ${org.accounts.taxInput}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(
        recoverable.amount,
        "5.0000",
        "the recoverable tax posts from the imported evidence",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
