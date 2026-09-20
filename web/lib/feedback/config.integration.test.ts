import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withBypass } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const {
  clearFeedbackToken,
  getFeedbackRuntime,
  getFeedbackSettings,
  getFeedbackToken,
  isFeedbackReady,
  saveFeedbackSettings,
} = await import("./config");

/**
 * The in-app issue destination is INSTALLATION state, not tenant state: one
 * singleton row (migration 0173), reachable only through trusted server-side
 * code, holding an access token that is sealed at rest.
 *
 * Five claims are worth a database to prove, because each one is a promise
 * made to someone who cannot verify it themselves:
 *
 *   • the database admits only a bypass context — a policy, not just the UI;
 *   • the table is org-less, so no tenant archive or clone carries it away;
 *   • the token is never stored in plaintext;
 *   • a save without a token keeps the stored one rather than silently
 *     disarming the destination;
 *   • removing the token also turns reporting off, so no one is offered a
 *     report control that can only fail.
 */

const ACTOR = "00000000-0000-7000-8000-0000000000aa";
const TOKEN = "ghp_integration_example_token";

async function storedFeedback(): Promise<Record<string, unknown>> {
  const rows = await withBypass(() =>
    db.execute<{ feedback: Record<string, unknown> | null }>(sql`
      select settings -> 'feedback' as feedback from platform_settings where id = 'platform'`),
  );
  return rows.rows[0]?.feedback ?? {};
}

test("the deployment's issue destination is installation state, sealed and bypass-only", async (t) => {
  // Start from a known empty destination: the suite shares one database, and
  // this row is the only one of its kind.
  await withBypass(() =>
    db.execute(sql`update platform_settings set settings = '{}'::jsonb where id = 'platform'`),
  );

  await t.test("migration 0173 seeds exactly one row, and a second is impossible", async () => {
    const count = await withBypass(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from platform_settings`),
    );
    assert.equal(count.rows[0]?.n, 1);
    // The driver wraps the server error, so the constraint name is on the cause.
    await assert.rejects(
      () => withBypass(() => db.execute(sql`insert into platform_settings (id) values ('other')`)),
      (error: unknown) => {
        const text = JSON.stringify({
          message: (error as Error)?.message,
          cause: ((error as { cause?: Error })?.cause)?.message,
        });
        assert.match(text, /platform_settings_singleton/);
        return true;
      },
    );
  });

  await t.test("nothing is configured before an operator configures it", async () => {
    const settings = await getFeedbackSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.hasToken, false);
    assert.equal(settings.ready, false);
    assert.equal(await isFeedbackReady(), false);
    assert.equal(await getFeedbackRuntime(), null, "no destination means nothing to file against");
  });

  await t.test("a saved destination is usable and its token is sealed at rest", async () => {
    const saved = await saveFeedbackSettings(
      {
        enabled: true,
        owner: "openbooks",
        repo: "openbooks",
        labels: "bug, triage",
        searchDuplicates: true,
        token: TOKEN,
      },
      ACTOR,
    );
    assert.equal(saved.ready, true);
    assert.equal(saved.hasToken, true);
    assert.equal(saved.labels, "bug, triage");
    assert.equal(await isFeedbackReady(), true);

    const runtime = await getFeedbackRuntime();
    assert.ok(runtime);
    assert.equal(runtime.owner, "openbooks");
    assert.deepEqual(runtime.labels, ["bug", "triage"]);
    assert.equal(runtime.token, TOKEN, "the runtime unseals what the operator stored");

    const raw = await storedFeedback();
    assert.notEqual(raw.token, TOKEN, "a plaintext token must never reach the column");
    assert.match(String(raw.token), /^enc:v1:/);
    assert.equal(await getFeedbackToken(), TOKEN);

    const actor = await withBypass(() =>
      db.execute<{ updatedBy: string | null }>(sql`
        select updated_by as "updatedBy" from platform_settings where id = 'platform'`),
    );
    assert.equal(actor.rows[0]?.updatedBy, ACTOR, "who changed the destination is recorded");
  });

  await t.test("a save with no token keeps the stored credential", async () => {
    const sealedBefore = (await storedFeedback()).token;
    const saved = await saveFeedbackSettings(
      {
        enabled: true,
        owner: "openbooks",
        repo: "openbooks",
        labels: "bug",
        searchDuplicates: false,
        token: undefined,
      },
      ACTOR,
    );
    assert.equal(saved.hasToken, true);
    assert.equal(saved.searchDuplicates, false);
    assert.equal((await storedFeedback()).token, sealedBefore);
    const runtime = await getFeedbackRuntime();
    assert.equal(runtime?.searchDuplicates, false, "duplicate search is the operator's switch");
  });

  await t.test("the database itself admits only trusted server-side code", async () => {
    // A catalog assertion rather than a scoped query, deliberately: a
    // PostgreSQL superuser bypasses row-level security outright, and both the
    // local review database and CI connect as the schema owner — a scoped
    // SELECT would therefore pass or fail on the test connection's
    // privileges rather than on the policy this migration ships. What the
    // deployment relies on is the policy text, so that is what is pinned.
    const table = await withBypass(() =>
      db.execute<{ enabled: boolean; forced: boolean }>(sql`
        select relrowsecurity as enabled, relforcerowsecurity as forced
          from pg_class where relname = 'platform_settings'`),
    );
    assert.equal(table.rows[0]?.enabled, true, "row-level security is on");
    assert.equal(table.rows[0]?.forced, true, "and forced, so the owner is not exempt");

    const policies = await withBypass(() =>
      db.execute<{ policyname: string; cmd: string; qual: string; withCheck: string | null }>(sql`
        select policyname, cmd, qual, with_check as "withCheck"
          from pg_policies where tablename = 'platform_settings'`),
    );
    assert.equal(policies.rows.length, 1, "exactly one way in");
    const policy = policies.rows[0]!;
    assert.equal(policy.cmd, "ALL", "reads and writes are gated alike");
    for (const clause of [policy.qual, policy.withCheck]) {
      assert.match(
        String(clause),
        /current_setting\('app\.bypass_rls'::text, true\) = 'on'::text/,
        "only a bypass context matches — a tenant session matches no row",
      );
    }
  });

  await t.test("the row is org-less, so no tenant archive or clone carries it", async () => {
    const columns = await withBypass(() =>
      db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'platform_settings'`),
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.ok(
      !names.includes("org_id"),
      "backup, sandbox cloning and org teardown all select tables by org_id",
    );

    // And an organization coming and going leaves the destination alone.
    const org = await createScratchOrg();
    try {
      assert.equal((await getFeedbackRuntime())?.owner, "openbooks");
    } finally {
      await dropScratchOrg(org.orgId);
    }
    assert.equal((await getFeedbackRuntime())?.owner, "openbooks");
  });

  await t.test("removing the token disarms reporting rather than leaving it broken", async () => {
    await clearFeedbackToken(ACTOR);
    const settings = await getFeedbackSettings();
    assert.equal(settings.hasToken, false);
    assert.equal(settings.enabled, false, "a destination with no credential cannot be enabled");
    assert.equal(settings.owner, "openbooks", "the destination itself is remembered");
    assert.equal(await getFeedbackRuntime(), null);
    assert.equal(await isFeedbackReady(), false);
    assert.equal(await getFeedbackToken(), null);
  });

  await withBypass(() =>
    db.execute(sql`update platform_settings set settings = '{}'::jsonb where id = 'platform'`),
  );
});
