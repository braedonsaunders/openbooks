import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("sandbox RLS requires the sandbox org to belong to its production org", { skip: !DB }, async () => {
  const owner = await createScratchOrg();
  const unrelated = await createScratchOrg();
  const ownerSandboxOrgId = randomUUID();
  const unrelatedSandboxOrgId = randomUUID();
  const validSandboxId = randomUUID();
  const forgedSandboxId = randomUUID();
  const unownedOrgSandboxId = randomUUID();

  try {
    await withBypassContext(async () => {
      for (const [id, productionOrgId] of [
        [ownerSandboxOrgId, owner.orgId],
        [unrelatedSandboxOrgId, unrelated.orgId],
      ] as const) {
        await db.execute(sql`
          insert into orgs (id, name, base_currency, country, settings, env_kind, sandbox_of)
          values (${id}, 'RLS test sandbox', 'CAD', 'CA', '{}'::jsonb, 'sandbox', ${productionOrgId})`);
      }
    });

    await withOrg(owner.orgId, () => db.execute(sql`
      insert into sandboxes (id, org_id, production_org_id, name, tier, masked, status)
      values (${validSandboxId}, ${ownerSandboxOrgId}, ${owner.orgId}, 'Valid sandbox', 'masked', true, 'provisioning')`));
    const visible = await withOrg(owner.orgId, () => db.execute<{ id: string }>(sql`
      select id from sandboxes where id = ${validSandboxId}`));
    assert.deepEqual(visible.rows, [{ id: validSandboxId }]);

    await assert.rejects(
      withOrg(owner.orgId, () => db.execute(sql`
        insert into sandboxes (id, org_id, production_org_id, name, tier, masked, status)
        values (${forgedSandboxId}, ${unrelatedSandboxOrgId}, ${owner.orgId}, 'Forged sandbox', 'masked', true, 'provisioning')`)),
      (error: unknown) => {
        const messages: string[] = [];
        for (let cause: unknown = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
          messages.push(String((cause as { message?: unknown }).message ?? ""));
        }
        assert.match(messages.join(" "), /row-level security policy/);
        return true;
      },
    );
    await assert.rejects(
      withOrg(owner.orgId, () => db.execute(sql`
        update sandboxes set org_id = ${unrelatedSandboxOrgId} where id = ${validSandboxId}`)),
      (error: unknown) => {
        const messages: string[] = [];
        for (let cause: unknown = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
          messages.push(String((cause as { message?: unknown }).message ?? ""));
        }
        assert.match(messages.join(" "), /row-level security policy/);
        return true;
      },
    );
    await assert.rejects(
      withOrg(owner.orgId, () => db.execute(sql`
        insert into sandboxes (id, org_id, production_org_id, name, tier, masked, status)
        values (${unownedOrgSandboxId}, ${owner.orgId}, ${owner.orgId}, 'Non-sandbox org', 'masked', true, 'provisioning')`)),
      (error: unknown) => {
        const messages: string[] = [];
        for (let cause: unknown = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
          messages.push(String((cause as { message?: unknown }).message ?? ""));
        }
        assert.match(messages.join(" "), /row-level security policy/);
        return true;
      },
    );
    const stillValid = await withOrg(owner.orgId, () => db.execute<{ org_id: string }>(sql`
      select org_id from sandboxes where id = ${validSandboxId}`));
    assert.deepEqual(stillValid.rows, [{ org_id: ownerSandboxOrgId }]);
  } finally {
    await withBypassContext(async () => {
      await db.execute(sql`delete from sandboxes where id in (${validSandboxId}, ${forgedSandboxId}, ${unownedOrgSandboxId})`);
      await db.execute(sql`delete from orgs where id in (${ownerSandboxOrgId}, ${unrelatedSandboxOrgId})`);
    });
    await dropScratchOrg(owner.orgId);
    await dropScratchOrg(unrelated.orgId);
  }
});
