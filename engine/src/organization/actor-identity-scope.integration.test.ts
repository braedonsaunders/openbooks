import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import {
  db,
  env,
  pinnedTransactionExecutor,
  withOrg,
  withOrgContext,
  withBypass,
  withBypassContext,
  type SqlExecutor,
} from "../platform/db.ts";
import {
  actorHasPermission,
  actorIdentity,
  createActorPermissionRead,
  lockActorIdentity,
} from "./actor-permissions.ts";
import { lockActorCommandAuthority } from "./actor-command-authority.ts";
import { actorAllowedSubsidiaryIds } from "./actor-subsidiaries.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";

async function permissionBoth(exec: typeof db, orgId: string, actorId: string, permission: string) {
  const live = await actorHasPermission(exec, orgId, actorId, permission);
  assert.equal(
    await createActorPermissionRead(exec, orgId, actorId)(permission),
    live,
    "read authority preserves native home identity and target grants",
  );
  return live;
}

test(
  "engine authorization separates home identity from active-organization grants",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const home = await createScratchOrg();
    const target = await createScratchOrg();
    try {
      const actor = await createScratchUser(home.orgId, "Cross-org administrator", "admin");
      await db.execute(sql`update users set is_super_admin=true where id=${actor}`);
      await withOrg(home.orgId, async () => {
        await db.execute(sql`update users set is_active=false where id=${actor}`);
        assert.equal(await permissionBoth(db, home.orgId, actor, "gl.post"), false);
        await db.execute(sql`update users set is_active=true where id=${actor}`);
      });
      await withOrg(target.orgId, async () => {
        assert.equal(await permissionBoth(db, target.orgId, actor, "gl.post"), true);
        assert.equal(
          await withBypassContext(() => actorAllowedSubsidiaryIds(db, target.orgId, actor)),
          null,
        );
      });
      await db.execute(sql`update users set is_super_admin=false where id=${actor}`);
      assert.equal(await permissionBoth(db, target.orgId, actor, "gl.post"), false);
      assert.equal(
        await actorIdentity(db, target.orgId, actor),
        undefined,
        "an active foreign user alone is not a tenant identity",
      );
      const local = await createScratchUser(target.orgId, "Target role owner", "poster");
      await db.execute(
        sql`update app_roles set permissions='["gl.post"]'::jsonb where org_id=${target.orgId} and key='poster'`,
      );
      await assert.rejects(
        db.execute(sql`insert into role_assignments (org_id,user_id,role_id)
      select ${target.orgId},${actor},role_id from role_assignments where user_id=${local} and org_id=${target.orgId}`),
        (error: unknown) =>
          (error as { cause?: { constraint?: string } }).cause?.constraint ===
          "role_assignments_user_id_fkey",
      );
      // Cross-company access maps the login identity to a real target users row.
      // The authentication layer resolves that mapping before calling the engine.
      await db.execute(sql`insert into user_org_access(member_user_id,org_id,acting_user_id)
      values(${actor},${target.orgId},${local})`);
      await withOrg(target.orgId, async () => {
        assert.equal(
          await permissionBoth(db, target.orgId, actor, "gl.post"),
          false,
          "home identity cannot borrow the target actor's grants",
        );
        assert.equal(await permissionBoth(db, target.orgId, local, "gl.post"), true);
        assert.equal(await permissionBoth(db, target.orgId, local, "documents.manage"), false);
      });
      await db.execute(sql`update users set is_active=false where id=${local}`);
      assert.equal(await permissionBoth(db, target.orgId, local, "gl.post"), false);
      assert.deepEqual(
        await withBypassContext(() => actorAllowedSubsidiaryIds(db, target.orgId, local)),
        new Set(),
      );
      await db.execute(sql`update users set is_active=false where id=${actor}`);
      assert.equal(await permissionBoth(db, target.orgId, actor, "gl.post"), false);
      assert.deepEqual(
        await withBypassContext(() => actorAllowedSubsidiaryIds(db, target.orgId, actor)),
        new Set(),
      );
    } finally {
      await dropScratchOrg(target.orgId);
      await dropScratchOrg(home.orgId);
    }
  },
);

test(
  "foreign platform identities are locked in the command transaction without changing tenant scope",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const home = await createScratchOrg();
    const target = await createScratchOrg();
    try {
      const actor = await createScratchUser(home.orgId, "Platform operator", "admin");
      await withBypassContext(() =>
        db.execute(sql`update users set is_super_admin=true where id=${actor}`),
      );
      await withOrg(target.orgId, async () => {
        assert.equal(
          (await db.execute(sql`select id from users where id=${actor}`, "objects")).length,
          0,
          "ordinary target FORCE-RLS does not expose the foreign home row",
        );
        assert.equal((await lockActorIdentity(db, target.orgId, actor))?.id, actor);
        assert.equal(await actorHasPermission(db, target.orgId, actor, "admin.setup.manage"), true);
        const scope = (
          await db.execute<{ scope: string }>(
            sql`select current_setting('app.current_org') as scope`,
            "objects",
          )
        )[0]!.scope;
        assert.equal(scope, target.orgId);
        assert.equal(
          (await db.execute(sql`select id from accounts where org_id=${home.orgId}`, "objects"))
            .length,
          0,
          "tenant reads remain isolated after identity resolution",
        );
      });
      await withBypassContext(() =>
        db.execute(sql`update users set is_active=false where id=${actor}`),
      );
      await withOrg(target.orgId, async () => {
        assert.equal(await lockActorIdentity(db, target.orgId, actor), undefined);
        assert.equal(
          await actorHasPermission(db, target.orgId, actor, "admin.setup.manage"),
          false,
        );
      });
    } finally {
      await dropScratchOrg(target.orgId);
      await dropScratchOrg(home.orgId);
    }
  },
);

test(
  "actor locks refuse pooled, unrelated and wrong-tenant executors before querying them",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const target = await createScratchOrg();
    const foreign = await createScratchOrg();
    try {
      const actor = await createScratchUser(target.orgId, "Tenant authority", "admin");
      let unrelatedQueries = 0;
      const unrelated: SqlExecutor = {
        execute: (() => {
          unrelatedQueries++;
          throw new Error("unrelated executor must not be queried");
        }) as SqlExecutor["execute"],
      };
      await withOrgContext(target.orgId, async () => {
        await assert.rejects(
          lockActorIdentity(db, target.orgId, actor),
          /pinned transaction executor/,
        );
        await assert.rejects(
          lockActorCommandAuthority(unrelated, target.orgId, actor, null, "gl.post"),
          /pinned transaction executor/,
        );
      });
      await withOrg(target.orgId, async () => {
        await assert.rejects(
          lockActorIdentity(unrelated, target.orgId, actor),
          /pinned transaction executor/,
        );
        await assert.rejects(
          lockActorCommandAuthority(unrelated, target.orgId, actor, null, "gl.post"),
          /pinned transaction executor/,
        );
        await assert.rejects(
          lockActorIdentity(db, foreign.orgId, actor),
          /pinned transaction executor/,
        );
        assert.equal(
          (await lockActorIdentity(pinnedTransactionExecutor()!, target.orgId, actor))?.id,
          actor,
        );
      });
      await withBypass(async () => {
        await assert.rejects(
          lockActorIdentity(db, target.orgId, actor),
          /pinned transaction executor/,
        );
      });
      assert.equal(unrelatedQueries, 0);
    } finally {
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(target.orgId);
    }
  },
);

test(
  "a foreign identity share lock remains held until the owning tenant transaction ends",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const home = await createScratchOrg();
    const target = await createScratchOrg();
    const contender = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    try {
      const actor = await createScratchUser(home.orgId, "Platform identity", "admin");
      await withBypassContext(() =>
        db.execute(sql`update users set is_super_admin=true where id=${actor}`),
      );
      await contender.connect();
      await contender.query("set lock_timeout='50ms'");
      await withOrg(target.orgId, async () => {
        assert.equal((await lockActorIdentity(db, target.orgId, actor))?.id, actor);
        await contender.query("begin");
        try {
          await contender.query(
            "select set_config('app.current_org',$1,true),set_config('app.bypass_rls','off',true)",
            [home.orgId],
          );
          await assert.rejects(
            contender.query("update users set is_active=false where org_id=$1 and id=$2", [
              home.orgId,
              actor,
            ]),
            (error: unknown) => (error as { code?: string }).code === "55P03",
          );
        } finally {
          await contender.query("rollback");
        }
        assert.equal((await lockActorIdentity(db, target.orgId, actor))?.isActive, true);
      });
      await contender.query("begin");
      await contender.query(
        "select set_config('app.current_org',$1,true),set_config('app.bypass_rls','off',true)",
        [home.orgId],
      );
      const deactivated = await contender.query(
        "update users set is_active=false where org_id=$1 and id=$2 returning id",
        [home.orgId, actor],
      );
      assert.equal(deactivated.rows.length, 1);
      await contender.query("commit");
      await withOrg(target.orgId, async () => {
        assert.equal(await lockActorIdentity(db, target.orgId, actor), undefined);
      });
    } finally {
      await contender.query("rollback").catch(() => {});
      await contender.end();
      await dropScratchOrg(target.orgId);
      await dropScratchOrg(home.orgId);
    }
  },
);

async function waitForBlockedActorLock(monitor: pg.Client, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await monitor.query<{ waiting: boolean }>(
      "select exists(select 1 from pg_locks where pid=$1 and not granted) as waiting",
      [pid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Actor identity command did not reach its native row-lock fence");
}

test(
  "parallel financial reads on the pinned connection never observe a foreign actor home scope",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const home = await createScratchOrg();
    const target = await createScratchOrg();
    const blocker = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let pendingIdentity: Promise<unknown> | undefined;
    try {
      const actor = await createScratchUser(home.orgId, "Platform reader", "admin");
      await withBypassContext(() =>
        db.execute(sql`update users set is_super_admin=true where id=${actor}`),
      );
      await blocker.connect();
      await blocker.query("begin");
      await blocker.query(
        "select set_config('app.current_org',$1,true),set_config('app.bypass_rls','off',true)",
        [home.orgId],
      );
      await blocker.query("select id from users where org_id=$1 and id=$2 for update", [
        home.orgId,
        actor,
      ]);
      await withOrg(target.orgId, async () => {
        const pid = (
          await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`, "objects")
        )[0]!.pid;
        const identity = lockActorIdentity(db, target.orgId, actor);
        pendingIdentity = identity.catch(() => {});
        try {
          // Observe the actual row-lock wait, then queue a financial read on the
          // SAME connection before letting the identity command finish.
          await waitForBlockedActorLock(blocker, pid);
          const financialRead = db
            .execute<{ scope: string; foreignCount: string; ownCount: string }>(
              sql`
          select current_setting('app.current_org') as scope,
            (select count(*)::text from accounts where org_id=${home.orgId}) as "foreignCount",
            (select count(*)::text from accounts where org_id=${target.orgId}) as "ownCount"`,
              "objects",
            )
            .then((result) => result[0]!);
          await blocker.query("rollback");
          assert.equal((await identity)?.id, actor);
          const financial = await financialRead;
          assert.equal(financial.scope, target.orgId);
          assert.equal(financial.foreignCount, "0");
          assert.ok(
            BigInt(financial.ownCount) > 0n,
            "the financial read has a nonempty target account population",
          );
          assert.equal(
            (
              await db.execute<{ scope: string }>(
                sql`select current_setting('app.current_org') as scope`,
                "objects",
              )
            )[0]!.scope,
            target.orgId,
          );
        } finally {
          await blocker.query("rollback").catch(() => {});
          await pendingIdentity;
        }
      });
    } finally {
      await blocker.query("rollback").catch(() => {});
      await pendingIdentity?.catch(() => {});
      await blocker.end();
      await dropScratchOrg(target.orgId);
      await dropScratchOrg(home.orgId);
    }
  },
);

test(
  "a foreign actor's live revocation wins while its exact home-row lock waits",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const home = await createScratchOrg();
    const target = await createScratchOrg();
    const blocker = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let pendingIdentity: Promise<unknown> | undefined;
    try {
      const actor = await createScratchUser(home.orgId, "Platform command actor", "admin");
      await blocker.connect();
      for (const column of ["is_active", "is_super_admin"] as const) {
        await withBypassContext(() =>
          db.execute(sql`update users set is_super_admin=true,is_active=true where id=${actor}`),
        );
        await blocker.query("begin");
        await blocker.query(
          "select set_config('app.current_org',$1,true),set_config('app.bypass_rls','off',true)",
          [home.orgId],
        );
        await blocker.query(`update users set ${column}=false where org_id=$1 and id=$2`, [
          home.orgId,
          actor,
        ]);
        await assert.rejects(
          withOrg(target.orgId, async () => {
            const pid = (
              await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`, "objects")
            )[0]!.pid;
            const outcome = lockActorIdentity(db, target.orgId, actor).then(
              (value) => ({ value, error: undefined }),
              (error) => ({ value: undefined, error }),
            );
            pendingIdentity = outcome;
            try {
              await waitForBlockedActorLock(blocker, pid);
              await blocker.query("commit");
              const result = await outcome;
              if (result.error) throw result.error;
              assert.fail("Revoked platform identity must not receive command authority");
            } finally {
              await blocker.query("rollback").catch(() => {});
              await outcome;
            }
          }),
          (error) => errorChainMatches(error, /Actor is not eligible to command this organization/),
        );
        await withOrg(target.orgId, async () => {
          assert.equal(await lockActorIdentity(db, target.orgId, actor), undefined);
          assert.equal(
            (
              await db.execute<{ scope: string }>(
                sql`select current_setting('app.current_org') as scope`,
                "objects",
              )
            )[0]!.scope,
            target.orgId,
          );
        });
      }
    } finally {
      await blocker.query("rollback").catch(() => {});
      await pendingIdentity?.catch(() => {});
      await blocker.end();
      await dropScratchOrg(target.orgId);
      await dropScratchOrg(home.orgId);
    }
  },
);
