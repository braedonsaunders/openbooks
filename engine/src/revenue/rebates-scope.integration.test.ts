import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { attestRebateCost } from "./rebates.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("rebate cost attestation hides an out-of-scope document currency", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await withBypassContext(async () => {
      const actor = await createScratchUser(
        org.orgId,
        "Scoped accountant",
        "rebate_scope_accountant",
      );
      await grantScratchPermissions(org.orgId, actor, ["ar.post"]);
      await db.execute(sql`
        update app_roles
           set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
         where org_id = ${org.orgId} and key = 'rebate_scope_accountant'`);
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(settings, '{features,rebateManagement}', 'true'::jsonb, true)
         where id = ${org.orgId}`);
      return actor;
    });
    const hiddenSubsidiaryId = randomUUID();
    const documentId = randomUUID();
    const lineId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${hiddenSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate,
           subtotal, tax_total, total, created_by)
        values
          (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', ${`REBATE-SCOPE-${documentId}`},
           ${hiddenSubsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', 1, 100, 0, 100, ${actorId})`);
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount)
        values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, 1, 100, 100)`);
    });

    await assert.rejects(
      attestRebateCost(org.orgId, actorId, lineId, {
        costAmount: "10",
        currency: "USD",
        evidence: "Supplier invoice supports the recorded item cost",
      }),
      (error: unknown) => error instanceof ScopeNotFoundError,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
