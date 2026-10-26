import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function runtimeState() {
  return (
    await db.execute<{ org_id: string; bypass: string; privileged: boolean }>(
      sql`
    select current_setting('app.current_org',true) as org_id,
      current_setting('app.bypass_rls',true) as bypass,
      (rolsuper or rolbypassrls) as privileged from pg_roles where rolname=current_user`,
      "objects",
    )
  )[0]!;
}

test(
  "sandbox birth seeds its destination under runtime RLS and retains source actor ownership",
  { skip: !DB },
  async () => {
    const source = await createScratchOrg();
    const unrelated = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(source.orgId, "Sandbox owner", "admin"),
      );
      sandbox = await withOrgContext(source.orgId, async () => {
        assert.deepEqual(await runtimeState(), {
          org_id: source.orgId,
          bypass: "off",
          privileged: false,
        });
        const created = await createSandbox({
          productionOrgId: source.orgId,
          name: `Scoped birth ${randomUUID()}`,
          tier: "full",
          masked: false,
          createdBy: actor,
          lifecycleAuthority: { actorId: actor },
        });
        assert.deepEqual(await runtimeState(), {
          org_id: source.orgId,
          bypass: "off",
          privileged: false,
        });
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from fx_rate_types where org_id=${source.orgId}`,
              "objects",
            )
          )[0]?.count,
          3,
        );
        const audit = await db.execute<{ actor_id: string }>(
          sql`
        select actor_id from audit_log where org_id=${source.orgId} and row_id=${created.sandboxId}
          and table_name='sandbox_lifecycle' and changes->>'operation'='create'`,
          "objects",
        );
        assert.deepEqual(audit, [{ actor_id: actor }]);
        await assert.rejects(
          () =>
            db.execute(sql`
        insert into fx_rate_types(org_id,key,name) values(${unrelated.orgId},'forged','Forged foreign registry')`),
          (error) => errorChainMatches(error, /row-level security policy/),
        );
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from fx_rate_types where org_id=${unrelated.orgId}`,
              "objects",
            )
          )[0]?.count,
          0,
        );
        return created;
      });
      await withOrgContext(sandbox.sandboxOrgId, async () => {
        assert.deepEqual(await runtimeState(), {
          org_id: sandbox!.sandboxOrgId,
          bypass: "off",
          privileged: false,
        });
        const definitions = await db.execute<{ key: string }>(
          sql`select key from fx_rate_types where org_id=${sandbox!.sandboxOrgId} order by key`,
          "objects",
        );
        assert.deepEqual(
          definitions.map((row) => row.key),
          ["average", "historical", "spot"],
        );
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from fx_rate_types where org_id=${source.orgId}`,
              "objects",
            )
          )[0]?.count,
          0,
        );
      });
      await deleteSandbox(sandbox.sandboxId, { actorId: actor });
      sandbox = undefined;
    } finally {
      if (sandbox) await dropScratchOrgReporting(sandbox.sandboxOrgId);
      await dropScratchOrg(source.orgId);
      await dropScratchOrg(unrelated.orgId);
    }
  },
);

test(
  "failed sandbox birth restores the caller's scope and leaves no shell, seed or foreign-actor audit",
  { skip: !DB },
  async () => {
    const source = await createScratchOrg();
    const unrelated = await createScratchOrg();
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(source.orgId, "Sandbox owner", "admin"),
      );
      const foreignActor = await withBypassContext(() =>
        createScratchUser(unrelated.orgId, "Unrelated owner", "admin"),
      );
      await withOrgTransaction(source.orgId, async () => {
        const baseline = (
          await db.execute<{ shells: number; controls: number; rates: number }>(
            sql`
        select (select count(*)::int from orgs where sandbox_of=${source.orgId}) as shells,
          (select count(*)::int from sandboxes where production_org_id=${source.orgId}) as controls,
          (select count(*)::int from fx_rate_types where org_id=${source.orgId}) as rates`,
            "objects",
          )
        )[0]!;
        await assert.rejects(
          createSandbox({
            productionOrgId: source.orgId,
            name: `Foreign actor ${randomUUID()}`,
            createdBy: foreignActor,
            lifecycleAuthority: { actorId: foreignActor },
          }),
          /not an active user of the production organization/,
        );
        // A native NOT NULL refusal occurs during the destination INSERT, after
        // scope has changed; its statement/savepoint rollback precedes restoration.
        await assert.rejects(
          createSandbox({
            productionOrgId: source.orgId,
            name: null as unknown as string,
            createdBy: actor,
            lifecycleAuthority: { actorId: actor },
          }),
          (error) => errorChainMatches(error, /null value in column "name"/),
        );
        assert.deepEqual(await runtimeState(), {
          org_id: source.orgId,
          bypass: "off",
          privileged: false,
        });
        const after = (
          await db.execute<{ shells: number; controls: number; rates: number }>(
            sql`
        select (select count(*)::int from orgs where sandbox_of=${source.orgId}) as shells,
          (select count(*)::int from sandboxes where production_org_id=${source.orgId}) as controls,
          (select count(*)::int from fx_rate_types where org_id=${source.orgId}) as rates`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(after, baseline);
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from audit_log
        where org_id=${source.orgId} and table_name='sandbox_lifecycle' and actor_id=${foreignActor}`,
              "objects",
            )
          )[0]?.count,
          0,
        );
        const changed = await db.execute(
          sql`update orgs set legal_name='Source remains writable' where id=${source.orgId} returning id`,
          "objects",
        );
        assert.equal(changed.length, 1);
      });
    } finally {
      await dropScratchOrg(source.orgId);
      await dropScratchOrg(unrelated.orgId);
    }
  },
);
