import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { db, pool } from "../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../engine/src/testing/fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

/**
 * 0192 HRM positions storage proof: the migration's tables, keys, exclusion,
 * closure-guard content allowlist, evidence guards, and tenant RLS exist on
 * the bootstrapped database (not SQL-file-only assertions), the bootstrap
 * ledger carries the 0192 ordinal, and a cross-org write is refused by RLS.
 */

async function session(bypass: boolean, orgId?: string): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', $1, true)", [bypass ? "on" : "off"]);
    if (orgId) await client.query("select set_config('app.current_org', $1, true)", [orgId]);
    return client;
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

async function end(client: PoolClient, commit: boolean): Promise<void> {
  try {
    await client.query(commit ? "commit" : "rollback");
  } finally {
    client.release();
  }
}

async function tableSecurity(): Promise<Map<string, { rls: boolean; force: boolean }>> {
  const rows = (await db.execute<{ name: string; rls: boolean; force: boolean }>(sql`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('positions', 'position_versions', 'position_funding', 'position_changes')`)).rows;
  return new Map(rows.map((row) => [row.name, { rls: row.rls, force: row.force }]));
}

async function hasConstraint(name: string): Promise<boolean> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
     where n.nspname = 'public' and c.conname = ${name}`)).rows;
  return (rows[0]?.n ?? 0) > 0;
}

async function hasPolicy(table: string, policy: string): Promise<boolean> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_policies
     where schemaname = 'public' and tablename = ${table} and policyname = ${policy}`)).rows;
  return (rows[0]?.n ?? 0) > 0;
}

test("fresh bootstrap carries the 0192 ordinal in its ledger", { skip }, async () => {
  const rows = (await db.execute<{ filename: string }>(sql`
    select filename from public._applied_migrations where filename = 'generated/0192_hrm_positions_headcount_plan.sql'`)).rows;
  assert.equal(rows.length, 1, "the bootstrap ledger must carry the 0192 migration");
});

test("position tables exist with enforced tenant RLS", { skip }, async () => {
  const security = await tableSecurity();
  for (const table of ["positions", "position_versions", "position_funding", "position_changes"]) {
    const state = security.get(table);
    assert.ok(state, `${table} must exist after bootstrap`);
    assert.equal(state.rls, true, `${table} must have RLS enabled`);
    assert.equal(state.force, true, `${table} must force RLS on table owners`);
    assert.ok(await hasPolicy(table, "org_isolation"), `${table} must carry the org_isolation policy`);
  }
});

test("position storage invariants exist by name", { skip }, async () => {
  for (const name of [
    "positions_org_code_unique",
    "position_versions_position_no",
    "position_versions_no_overlap",
    "position_funding_position_period",
    "position_changes_position_revision",
    "employment_assignment_versions_position_tenant_fkey",
  ]) {
    assert.ok(await hasConstraint(name), `${name} must exist after bootstrap`);
  }
  const guard = (await db.execute<{ definition: string }>(sql`
    select pg_get_functiondef(oid) as definition from pg_proc
     where proname = 'employment_assignment_versions_closure_guard'`)).rows[0]?.definition;
  assert.ok(guard, "the assignment closure guard must exist");
  assert.match(guard, /position_id/, "the closure allowlist must pin the position link (v2)");
});

test("a cross-org position write is refused by RLS", { skip }, async () => {
  const first = await createScratchOrg();
  const second = await createScratchOrg();
  const writer = await session(false, second.orgId);
  try {
    await writer.query("savepoint refused_probe");
    try {
      await assert.rejects(
        writer.query(`insert into positions (org_id, position_code) values ('${first.orgId}', 'X-1')`),
        /row-level security|policy/,
      );
    } finally {
      await writer.query("rollback to savepoint refused_probe");
    }
    const seen = await writer.query(`select count(*)::int as n from positions where org_id = '${first.orgId}'`);
    assert.equal(seen.rows[0].n, 0, "org B must not read org A's positions");
  } finally {
    await end(writer, false);
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});
