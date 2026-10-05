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

async function seedProfile(orgId: string, rate: string): Promise<void> {
  // Top-level merge: jsonb_set cannot create the missing intermediate
  // analytics/trueCost objects, so a nested set would silently keep the old
  // settings (row matched, nothing changed).
  await db.execute(sql`update public.orgs set settings =
      coalesce(settings, '{}'::jsonb) ||
      ${JSON.stringify({ analytics: { trueCost: { profiles: [{ id: "p1", name: "True Cost", baseLaborRate: rate }] } } })}::jsonb
    where id = ${orgId}`);
}

async function baseRateOf(orgId: string): Promise<string | null> {
  const rows = (await db.execute<{ rate: string | null }>(sql`select
      settings -> 'analytics' -> 'trueCost' -> 'profiles' -> 0 ->> 'baseLaborRate' as rate
    from public.orgs where id = ${orgId}`)).rows;
  return rows[0]?.rate ?? null;
}

test("0565 clears only the unaudited 50.0000 default and audits each clear", { skip: !DB }, async () => {
  const clearOrg = await withBypass(() => createScratchOrg());
  const ambiguousOrg = await withBypass(() => createScratchOrg());
  const otherOrg = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      await seedProfile(clearOrg.orgId, "50.0000");
      await seedProfile(ambiguousOrg.orgId, "50.0000");
      await seedProfile(otherOrg.orgId, "60.0000");
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
      assert.equal(await baseRateOf(clearOrg.orgId), "", "unaudited default returns to unset");
      assert.equal(
        await baseRateOf(ambiguousOrg.orgId),
        "50.0000",
        "audited value is left for the operator to decide",
      );
      assert.equal(await baseRateOf(otherOrg.orgId), "60.0000", "other values are untouched");

      const audits = (await db.execute<{ profile: string | null; actor: string | null; reason: string | null }>(sql`select
          changes ->> 'profileId' as profile, actor_id::text as actor,
          changes ->> 'reason' as reason
        from public.audit_log
        where org_id = ${clearOrg.orgId} and table_name = 'orgs'
          and changes -> 'after' ->> 'baseLaborRate' = ''`)).rows;
      assert.equal(audits.length, 1, "one audit row per cleared profile");
      assert.equal(audits[0]!.profile, "p1");
      assert.equal(audits[0]!.actor, null);
      assert.match(audits[0]!.reason ?? "", /0565/);

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
