/**
 * Tenant isolation policies are role-gated and statement-scoped.
 *
 * Every org_isolation policy admits a row only when the role-gated
 * app_bypass_rls_active() predicate holds or the row's org_id equals the
 * session tenant. Both arms are wrapped in scalar subqueries so PostgreSQL
 * evaluates them once per statement as InitPlans rather than once per
 * protected row, and a runtime login setting app.bypass_rls cannot widen
 * access because the raw setting is never consulted.
 */
import { hasEphemeralDatabaseMarker } from "@openbooks/engine/testing/fixtures";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const DB = {
  skip: !process.env.OPENBOOKS_TEST_ADMIN_DB_URL || !process.env.OPENBOOKS_RUNTIME_DB_URL,
};
const BYPASS_ARM = /\( SELECT (public\.)?app_bypass_rls_active\(\) AS app_bypass_rls_active\)/;
const TENANT_ARM =
  /\(org_id\)::text = \( SELECT current_setting\('app\.current_org'::text, true\) AS current_setting\)/;
const FINANCIAL_POLICY_TABLES = [
  "account_translation_policies",
  "fx_rate_types",
  "gl_audit_number_assignments",
  "gl_audit_number_policies",
  "journal_reversal_instructions",
  "segment_balancing_policies",
  "subsidiary_accounting_preferences",
];

async function assertDisposable(admin: pg.Client) {
  const marker = (
    await admin.query(
      "select shobj_description(oid,'pg_database') as marker from pg_database where datname=current_database()",
    )
  ).rows[0]?.marker;
  assert.ok(
    hasEphemeralDatabaseMarker(marker, process.env.OPENBOOKS_TEST_DB_MARKER),
    "policy changes require the exact owned disposable database marker",
  );
}

test(
  "every installed org_isolation policy is the role-gated statement-scoped predicate",
  DB,
  async () => {
    const admin = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
    try {
      await admin.connect();
      const policies = (
        await admin.query<{
          tablename: string;
          cmd: string;
          permissive: string;
          roles: string;
          qual: string;
          with_check: string;
        }>(`
      select tablename, cmd, permissive, array_to_string(roles, ',') as roles, qual, with_check from pg_policies
       where schemaname = 'public' and policyname = 'org_isolation' order by tablename`)
      ).rows;
      assert.ok(
        policies.length > 100,
        `the installed schema carries org_isolation policies (found ${policies.length})`,
      );
      const tables = new Set(policies.map((policy) => policy.tablename));
      for (const table of FINANCIAL_POLICY_TABLES)
        assert.ok(tables.has(table), `${table} carries org_isolation`);
      for (const policy of policies) {
        const subject = `public.${policy.tablename}.org_isolation`;
        assert.deepEqual(
          [policy.cmd, policy.permissive, policy.roles],
          ["ALL", "PERMISSIVE", "public"],
          subject,
        );
        assert.equal(
          policy.qual,
          policy.with_check,
          `${subject} checks writes with its read predicate`,
        );
        assert.match(
          policy.qual,
          BYPASS_ARM,
          `${subject} bypasses only through the role-gated statement-scoped predicate`,
        );
        assert.match(
          policy.qual,
          TENANT_ARM,
          `${subject} reads the tenant setting once per statement`,
        );
        assert.equal(
          policy.qual.includes("app.bypass_rls"),
          false,
          `${subject} never trusts the raw bypass setting`,
        );
      }
    } finally {
      await admin.end();
    }
  },
);

test(
  "bootstrap policies isolate tenants for the runtime login and evaluate their predicate once per statement",
  DB,
  async () => {
    const admin = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
    const runtime = new pg.Client({ connectionString: process.env.OPENBOOKS_RUNTIME_DB_URL });
    const table = `tenant_policy_${randomUUID().replaceAll("-", "")}`;
    const orgA = randomUUID(),
      orgB = randomUUID();
    try {
      await admin.connect();
      await assertDisposable(admin);
      await runtime.connect();
      const role = (await runtime.query("select current_user as role")).rows[0].role as string;
      assert.match(role, /^[a-z_][a-z0-9_]*$/);
      await admin.query(`create table public.${table} (org_id uuid not null, n integer not null)`);
      await admin.query(
        `insert into public.${table} select $1::uuid,n from generate_series(1,10000) n`,
        [orgA],
      );
      await admin.query(`insert into public.${table} values ($1,10001)`, [orgB]);
      await admin.query(`grant select,insert,update,delete on public.${table} to ${role}`);
      await admin.query(readFileSync("schema/migrations/environments.sql", "utf8"));
      const installed = (
        await admin.query(
          `select c.relrowsecurity, c.relforcerowsecurity, p.polname,
        pg_get_expr(p.polqual,p.polrelid) as predicate, pg_get_expr(p.polwithcheck,p.polrelid) as check_predicate
      from pg_class c join pg_policy p on p.polrelid = c.oid where c.oid = $1::regclass`,
          [`public.${table}`],
        )
      ).rows;
      assert.equal(
        installed.length,
        1,
        "bootstrap installs exactly the tenant policy on a new org-scoped table",
      );
      const [policy] = installed;
      assert.deepEqual(
        [policy.relrowsecurity, policy.relforcerowsecurity, policy.polname],
        [true, true, "org_isolation"],
      );
      assert.match(policy.predicate, BYPASS_ARM);
      assert.match(policy.predicate, TENANT_ARM);
      assert.equal(policy.check_predicate, policy.predicate);

      const count = async (org: string, bypass: string) => {
        await runtime.query(
          "select set_config('app.current_org',$1,false),set_config('app.bypass_rls',$2,false)",
          [org, bypass],
        );
        return Number((await runtime.query(`select count(*) as n from public.${table}`)).rows[0].n);
      };
      assert.equal(await count("", "off"), 0);
      assert.equal(await count("", "on"), 0, "a runtime setting cannot grant cross-tenant access");
      assert.equal(await count(orgA, "on"), 10000);
      assert.equal(
        await count(orgB, "off"),
        1,
        "a later statement observes its new tenant context",
      );
      assert.equal(await count(orgA, "off"), 10000);
      await assert.rejects(
        runtime.query(`insert into public.${table} values ($1,2)`, [orgB]),
        /row-level security/,
      );
      assert.equal(
        (await runtime.query(`update public.${table} set n=0 where org_id=$1`, [orgB])).rowCount,
        0,
      );
      const plan = (
        await runtime.query(`explain (analyze,format json) select count(*) from public.${table}`)
      ).rows[0]["QUERY PLAN"][0].Plan;
      const initPlans: Array<Record<string, unknown>> = [];
      const walk = (node: Record<string, unknown>) => {
        if (node["Parent Relationship"] === "InitPlan") initPlans.push(node);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
      };
      walk(plan);
      assert.ok(initPlans.length >= 2, "bypass and tenant context must both be InitPlans");
      assert.ok(
        initPlans.every((node) => node["Actual Loops"] === 1),
        "the predicate must run once, not once per protected row",
      );
    } finally {
      await runtime.end();
      await admin.query(`drop table if exists public.${table}`);
      await admin.end();
    }
  },
);
