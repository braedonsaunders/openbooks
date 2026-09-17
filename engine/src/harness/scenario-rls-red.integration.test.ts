import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../test-fixtures.ts";
import { runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's `rls-org-isolation` check — "an org's
 * data is never readable from another org, by any reader".
 *
 * Two proofs. First, the catalog half: a freshly created org-scoped table
 * with no policy must fail the check by name — the defect class is "a new
 * table nobody wired up", so the proof creates exactly that table and drops
 * it in a finally. Second, the mechanism half: two scratch orgs, one draft
 * entry living in org B, read from org A's scope through the base table AND
 * through the openbooks_query view web readers use (both must be empty)
 * and from org B's own scope (must see it — a scope that silently fails
 * closed would otherwise pass vacuously). The per-run harness probe reuses
 * this same mechanism against whatever foreign rows the cluster holds.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
}

async function draftEntry(orgId: string, bookId: string, subsidiaryId: string, periodId: string, tag: string): Promise<string> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, custom)
    values (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId}, ${`${tag}-${entryId.slice(0, 8)}`},
            '2026-07-15', ${periodId}, 'rls red-proof probe', 'draft', 'manual', '{}'::jsonb)`);
  return entryId;
}

test("rls-org-isolation fails on an org-scoped table with no policy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const table = `t3_rls_probe_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  try {
    await db.execute(sql.raw(`create table public.${table} (id uuid, org_id uuid)`));
    try {
      const cp = await runScenario(org.orgId, { at: org.date });
      const rls = check(cp, "rls-org-isolation");
      assert.equal(rls.ok, false, `RLS gate MUST fail: ${rls.detail}`);
      assert.match(rls.detail, new RegExp(`catalog gaps:.*${table}`));
      assert.equal(cp.pass, false, "an unwired table cannot be golden");
    } finally {
      await db.execute(sql.raw(`drop table public.${table}`));
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("one org's rows are invisible from another org's scope, via table and view", { skip: !DB }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const entryB = await withBypassContext(async () => {
      const id = await draftEntry(orgB.orgId, orgB.bookId, orgB.subsidiaryId, orgB.periodId, "RLS-B");
      return id;
    });
    // Foreign reads from A's scope: base table and web-reader view.
    const seenTable = await withOrgContext(orgA.orgId, async () => {
      const r = await db.execute(sql`select id from journal_entries where id = ${entryB}`);
      return r.rows;
    });
    assert.equal(seenTable.length, 0, "org A must not see org B's entry through the table");
    const seenView = await withOrgContext(orgA.orgId, async () => {
      const r = await db.execute(sql`select id from openbooks_query.journal_entries where id = ${entryB}`);
      return r.rows;
    });
    assert.equal(seenView.length, 0, "org A must not see org B's entry through the web-reader view");
    // Non-vacuity: B's own scope sees it.
    const seenOwn = await withOrgContext(orgB.orgId, async () => {
      const r = await db.execute(sql`select id from journal_entries where id = ${entryB}`);
      return r.rows;
    });
    assert.equal(seenOwn.length, 1, "org B must see its own entry — otherwise the emptiness above proves nothing");
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test("rls-org-isolation passes on a clean catalog with live foreign rows", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const cp = await runScenario(org.orgId, { at: org.date });
    const rls = check(cp, "rls-org-isolation");
    assert.equal(rls.ok, true, `RLS gate must hold on a clean tree: ${rls.detail}`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
