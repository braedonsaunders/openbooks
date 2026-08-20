import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("activated rate evidence is immutable while controlled dating and retirement remain possible", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const bookId = randomUUID();
    const versionId = randomUUID();
    const lineId = randomUUID();
    const policyId = randomUUID();
    const scopeId = randomUUID();
    const adjustmentId = randomUUID();
    const targetId = randomUUID();
    const termId = randomUUID();

    await db.execute(sql`
      insert into item_rate_books (id, org_id, code, name, currency)
      values (${bookId}, ${org.orgId}, 'CONTROLLED', 'Controlled Rates', 'CAD')`);
    await db.execute(sql`
      insert into item_rate_versions (
        id, org_id, rate_book_id, effective_from, status, custom
      ) values (
        ${versionId}, ${org.orgId}, ${bookId}, '2026-07-01', 'draft', '{}'::jsonb
      )`);
    await db.execute(sql`
      insert into item_rate_lines (
        id, org_id, version_id, item_id, unit_code, unit_name,
        base_quantity, cost_rate, bill_rate
      ) values (
        ${lineId}, ${org.orgId}, ${versionId}, ${org.items.service},
        'hour', 'Hour', 1, 75, 125
      )`);
    await db.execute(sql`
      insert into labor_rate_version_policies (
        id, org_id, version_id, derivation_policy
      ) values (
        ${policyId}, ${org.orgId}, ${versionId}, 'explicit'
      )`);
    await db.execute(sql`
      insert into labor_rate_version_scopes (
        id, org_id, version_id, scope_type, scope_value_text
      ) values (
        ${scopeId}, ${org.orgId}, ${versionId}, 'trade', 'electrician'
      )`);
    await db.execute(sql`
      insert into labor_rate_adjustments (
        id, org_id, version_id, code, name, category, calculation, value
      ) values (
        ${adjustmentId}, ${org.orgId}, ${versionId},
        'SHIFT', 'Shift premium', 'markup', 'percent', 10
      )`);
    await db.execute(sql`
      insert into labor_rate_adjustment_targets (
        id, org_id, adjustment_id, target_type, target_value_text
      ) values (
        ${targetId}, ${org.orgId}, ${adjustmentId}, 'labor', 'all'
      )`);
    await db.execute(sql`
      insert into labor_rate_terms (
        id, org_id, version_id, code, label, content
      ) values (
        ${termId}, ${org.orgId}, ${versionId},
        'MINIMUM', 'Minimum', 'Four-hour minimum'
      )`);

    // Draft configuration remains authorable.
    await db.execute(sql`
      update item_rate_lines set bill_rate = 130 where id = ${lineId}`);
    await db.execute(sql`
      update labor_rate_version_policies
         set derivation_policy = 'time_type_multipliers'
       where id = ${policyId}`);
    await db.execute(sql`
      update labor_rate_version_scopes
         set scope_value_text = 'master electrician'
       where id = ${scopeId}`);
    await db.execute(sql`
      update labor_rate_adjustments set value = 12.5 where id = ${adjustmentId}`);
    await db.execute(sql`
      update labor_rate_adjustment_targets
         set target_value_text = 'field labor'
       where id = ${targetId}`);
    await db.execute(sql`
      update labor_rate_terms set content = 'Three-hour minimum' where id = ${termId}`);

    await db.execute(sql`
      update item_rate_versions set status = 'active' where id = ${versionId}`);

    const forbidden = [
      () => db.execute(sql`update item_rate_lines set bill_rate = 131 where id = ${lineId}`),
      () => db.execute(sql`
        update labor_rate_version_policies
           set derivation_policy = 'explicit'
         where id = ${policyId}`),
      () => db.execute(sql`
        update labor_rate_version_scopes
           set scope_value_text = 'journeyperson'
         where id = ${scopeId}`),
      () => db.execute(sql`
        update labor_rate_adjustments set value = 15 where id = ${adjustmentId}`),
      () => db.execute(sql`
        update labor_rate_adjustment_targets
           set target_value_text = 'shop labor'
         where id = ${targetId}`),
      () => db.execute(sql`
        update labor_rate_terms set content = 'One-hour minimum' where id = ${termId}`),
      () => db.execute(sql`
        insert into item_rate_lines (
          org_id, version_id, item_id, unit_code, unit_name,
          base_quantity, cost_rate, bill_rate
        ) values (
          ${org.orgId}, ${versionId}, ${org.items.service},
          'day', 'Day', 8, 600, 1000
        )`),
      () => db.execute(sql`delete from item_rate_lines where id = ${lineId}`),
      () => db.execute(sql`update item_rate_books set currency = 'USD' where id = ${bookId}`),
      () => db.execute(sql`delete from item_rate_versions where id = ${versionId}`),
    ];
    for (const mutation of forbidden) {
      await assert.rejects(mutation);
    }

    // An active version may only close its open-ended validity range.
    await db.execute(sql`
      update item_rate_versions
         set effective_to = '2026-12-31'
       where id = ${versionId}`);
    await db.execute(sql`
      update item_rate_versions
         set effective_to = '2026-11-30'
       where id = ${versionId}`);
    await assert.rejects(() => db.execute(sql`
      update item_rate_versions
         set effective_to = '2027-01-31'
       where id = ${versionId}`));

    await db.execute(sql`
      update item_rate_versions set status = 'retired' where id = ${versionId}`);
    await assert.rejects(() => db.execute(sql`
      update item_rate_versions set status = 'active' where id = ${versionId}`));
    await assert.rejects(() => db.execute(sql`
      update item_rate_versions set effective_to = '2026-10-31' where id = ${versionId}`));
    await assert.rejects(() => db.execute(sql`
      update item_rate_lines set cost_rate = 76 where id = ${lineId}`));

    const evidence = (await db.execute<{
        status: string;
        effective_to: string;
        cost_rate: string;
        bill_rate: string;
        derivation_policy: string;
        value: string;
        content: string;
      }>(sql`
      select version.status, version.effective_to, line.cost_rate, line.bill_rate,
             policy.derivation_policy, adjustment.value, term.content
        from item_rate_versions version
        join item_rate_lines line on line.version_id = version.id
        join labor_rate_version_policies policy on policy.version_id = version.id
        join labor_rate_adjustments adjustment on adjustment.version_id = version.id
        join labor_rate_terms term on term.version_id = version.id
       where version.id = ${versionId}`));
    assert.deepEqual(evidence.rows, [{
      status: "retired",
      effective_to: "2026-11-30",
      cost_rate: "75.0000",
      bill_rate: "130.0000",
      derivation_policy: "time_type_multipliers",
      value: "12.5000000000",
      content: "Three-hour minimum",
    }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
