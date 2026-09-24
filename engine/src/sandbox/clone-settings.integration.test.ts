import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { rebaseSandboxControlAccounts } from "./lifecycle.ts";
import { runClone } from "./clone.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("control-account rebase uses the settings captured with the clone snapshot", { skip: !DB }, async () => {
  const production = await createScratchOrg();
  const sandbox = await createScratchOrg();
  const seed = randomUUID();
  try {
    // Keep the target fixture's own account numbers distinct from the
    // deterministic copies; account numbers are unique within each org.
    await db.execute(sql`update accounts
      set number = number || '-fixture'
      where org_id = ${sandbox.orgId} and number is not null`);
    const captured = await runClone({
      productionOrgId: production.orgId,
      sandboxOrgId: sandbox.orgId,
      seed,
      tier: "full",
      masked: false,
      onlyTables: new Set(["accounts"]),
    });
    assert.equal(
      (captured.sourceSettings?.controlAccounts as Record<string, string>).ar,
      production.accounts.ar,
    );

    // Model a production settings update landing after the copy snapshot has
    // committed but before refresh rebases the sandbox's JSON references.
    await db.execute(sql`update orgs
      set settings = jsonb_set(settings, '{controlAccounts,ar}', to_jsonb(${production.accounts.fxGainLoss}::text))
      where id = ${production.orgId}`);
    const rebased = await rebaseSandboxControlAccounts({
      productionOrgId: production.orgId,
      sandboxOrgId: sandbox.orgId,
      seed,
      productionSettings: captured.sourceSettings,
    });
    const expected = (await db.execute<{ id: string }>(sql`
      select ob_rebase(${production.accounts.ar}::uuid, ${seed}::uuid)::text as id`)).rows[0]!.id;
    assert.equal(rebased.ar, expected, "refresh must map the captured account identity, not the newer live setting");
  } finally {
    await dropScratchOrg(sandbox.orgId);
    await dropScratchOrg(production.orgId);
  }
});
