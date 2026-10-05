import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { connectBypassLongClient, db, withBypass } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migration = () =>
  readFileSync(
    new URL(
      "../../../schema/migrations/generated/0565_true_cost_base_labor_rate_default.sql",
      import.meta.url,
    ),
    "utf8",
  );
const preflight = () =>
  readFileSync(
    new URL(
      "../../../schema/migrations/preflight/0565_true_cost_base_labor_rate_default.sql",
      import.meta.url,
    ),
    "utf8",
  );

async function seedProfiles(orgId: string, rates: Record<string, string>): Promise<void> {
  // Top-level merge: jsonb_set cannot create the missing intermediate
  // analytics/trueCost objects, so a nested set would silently keep the old
  // settings (row matched, nothing changed).
  const profiles = Object.entries(rates).map(([id, baseLaborRate]) => ({ id, name: `Profile ${id}`, baseLaborRate }));
  await db.execute(sql`update public.orgs set settings =
      coalesce(settings, '{}'::jsonb) ||
      ${JSON.stringify({ analytics: { trueCost: { profiles } } })}::jsonb
    where id = ${orgId}`);
}

async function baseRatesOf(orgId: string): Promise<Record<string, string>> {
  const rows = (await db.execute<{ profiles: { id: string; baseLaborRate: string }[] }>(sql`select
      settings -> 'analytics' -> 'trueCost' -> 'profiles' as profiles
    from public.orgs where id = ${orgId}`)).rows;
  return Object.fromEntries((rows[0]?.profiles ?? []).map((p) => [p.id, p.baseLaborRate]));
}

test("0565 clears only the unaudited 50.0000 default, one audit row per org", { skip: !DB }, async () => {
  const clearOrg = await withBypass(() => createScratchOrg());
  const ambiguousOrg = await withBypass(() => createScratchOrg());
  const otherOrg = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      await seedProfiles(clearOrg.orgId, { p1: "50.0000", p2: "50.0000" });
      await seedProfiles(ambiguousOrg.orgId, { p1: "50.0000" });
      await seedProfiles(otherOrg.orgId, { p1: "60.0000" });
      // Audited operator write carrying baseLaborRate 50.0000: the value
      // stays, and the preflight must list the profile instead.
      await db.execute(sql`insert into public.audit_log
        (org_id, table_name, row_id, action, actor_id, changes)
        values (${ambiguousOrg.orgId}, 'orgs', ${ambiguousOrg.orgId}, 'update', ${randomUUID()},
          '{"after": {"analytics": {"trueCost": {"profiles": [{"id": "p1", "baseLaborRate": "50.0000"}]}}}}'::jsonb)`);
    });
    // Through the migration-replay bypass client: orgs carries FORCE ROW
    // LEVEL SECURITY and a raw pool checkout sees zero rows, while drizzle
    // executes only the first statement of a multi-statement string.
    // Executed twice: the second run must be a no-op (every default already
    // cleared, so no candidates remain).
    const client = await connectBypassLongClient();
    try {
      await client.query(migration());
      await client.query(migration());
    } finally {
      client.release();
    }
    await withBypass(async () => {
      assert.deepEqual(await baseRatesOf(clearOrg.orgId), { p1: "", p2: "" }, "unaudited defaults return to unset");
      assert.deepEqual(
        await baseRatesOf(ambiguousOrg.orgId),
        { p1: "50.0000" },
        "audited value is left for the operator to decide",
      );
      assert.deepEqual(await baseRatesOf(otherOrg.orgId), { p1: "60.0000" }, "other values are untouched");

      const audits = (await db.execute<{ before: unknown; after: unknown; actor: string | null; reason: string | null }>(sql`select
          changes -> 'before' as before, changes -> 'after' as after,
          actor_id::text as actor, changes ->> 'reason' as reason
        from public.audit_log
        where org_id = ${clearOrg.orgId} and table_name = 'orgs' and action = 'update'`)).rows;
      assert.equal(audits.length, 1, "one audit row per changed org");
      assert.deepEqual(audits[0]!.before, { p1: { baseLaborRate: "50.0000" }, p2: { baseLaborRate: "50.0000" } });
      assert.deepEqual(audits[0]!.after, { p1: { baseLaborRate: "" }, p2: { baseLaborRate: "" } });
      assert.equal(audits[0]!.actor, null);
      assert.equal(audits[0]!.reason, "retired default base rate cleared; re-enter a deliberate value in True Cost configuration");

      const otherAudits = (await db.execute<{ n: string }>(sql`select count(*)::text as n
        from public.audit_log
        where org_id = ${otherOrg.orgId} and table_name = 'orgs'`)).rows;
      assert.equal(otherAudits[0]!.n, "0", "untouched orgs gain no audit rows");

      const findings = (await db.execute<{ code: string; subject: string }>(sql.raw(preflight()))).rows;
      assert.equal(findings.length, 1, "preflight lists only the ambiguous profile");
      assert.equal(findings[0]!.code, "0565.ambiguous_base_labor_rate");
      assert.match(findings[0]!.subject, new RegExp(`${ambiguousOrg.orgId}/p1`));
    });
  } finally {
    await withBypass(() => dropScratchOrg(clearOrg.orgId));
    await withBypass(() => dropScratchOrg(ambiguousOrg.orgId));
    await withBypass(() => dropScratchOrg(otherOrg.orgId));
  }
});
