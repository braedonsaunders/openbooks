import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});
const { FieldRefusal, assetAccountScopeSql, parseAccountOverride } = await import("./_fields.ts");
hooks.deregister();

test("asset account overrides accept shared and caller-visible accounts and refuse an outside subsidiary", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const childId = randomUUID();
  const siblingId = randomUUID();
  const childAccountId = randomUUID();
  const siblingAccountId = randomUUID();
  const sharedAccountId = randomUUID();
  const inheritableAccountId = randomUUID();
  try {
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_active)
      values (${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Asset scope child', 'USD', 'US', true),
             (${siblingId}, ${org.orgId}, ${org.subsidiaryId}, 'Asset scope sibling', 'USD', 'US', true)`);
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, subsidiary_id, subsidiary_include_children)
      values (${childAccountId}, ${org.orgId}, 'ASSET-CHILD', 'Visible child account', 'asset_fixed', ${childId}, false),
             (${siblingAccountId}, ${org.orgId}, 'ASSET-SIBLING', 'Hidden sibling account', 'asset_fixed', ${siblingId}, false),
             (${sharedAccountId}, ${org.orgId}, 'ASSET-SHARED', 'Shared account', 'asset_fixed', null, false),
             (${inheritableAccountId}, ${org.orgId}, 'ASSET-PARENT', 'Parent account inherited by child', 'asset_fixed', ${org.subsidiaryId}, true)`);

    const scope = [childId];
    assert.equal(await parseAccountOverride(db, org.orgId, scope, childAccountId, "invalid_asset_account"), childAccountId);
    assert.equal(await parseAccountOverride(db, org.orgId, scope, sharedAccountId, "invalid_asset_account"), sharedAccountId);
    assert.equal(await parseAccountOverride(db, org.orgId, scope, inheritableAccountId, "invalid_asset_account"), inheritableAccountId);
    await assert.rejects(
      parseAccountOverride(db, org.orgId, scope, siblingAccountId, "invalid_asset_account"),
      (error: unknown) => error instanceof FieldRefusal && error.code === "invalid_asset_account",
    );

    const pickerAccounts = await db.execute<{ id: string }>(sql`
      select a.id from accounts a
       where a.org_id = ${org.orgId} and a.is_active and not a.is_summary
         ${assetAccountScopeSql(org.orgId, scope)}
         and a.id = any(${`{${childAccountId},${siblingAccountId},${sharedAccountId},${inheritableAccountId}}`}::uuid[])
    `);
    assert.deepEqual(
      new Set(pickerAccounts.rows.map((row) => row.id)),
      new Set([childAccountId, sharedAccountId, inheritableAccountId]),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
