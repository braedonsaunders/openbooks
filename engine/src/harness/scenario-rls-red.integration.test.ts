import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../db.ts";
import { runUserSql } from "../sqlapi.ts";
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
 * entry living in org B, read from org A's scope through the base table (the
 * RLS policy over the app pool's tenant GUCs — genuine only where the test
 * login is RLS-subject, which the test-database ownership transfer enforces)
 * AND through the governed reader (the openbooks_query view web readers use,
 * read via runUserSql, the production governed path: temp-table tenant
 * context plus tenant GUCs under the SELECT-only role — RLS-subject in every
 * environment, so this half guards the governed mechanism independently of
 * the login's posture). Both A-scope reads must be empty, and each mechanism
 * is read back from org B's own scope too — a scope that silently fails
 * closed would otherwise pass vacuously, and the governed view in particular
 * returns empty whenever its temp context is missing, so the B-side governed
 * read is what proves the A-side emptiness means isolation rather than an
 * unestablished context.
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
    // Foreign reads from A's scope: base table through the app pool's tenant
    // scope (the RLS policy over app.current_org / app.bypass_rls).
    const seenTable = await withOrgContext(orgA.orgId, async () => {
      const r = await db.execute(sql`select id from journal_entries where id = ${entryB}`);
      return r.rows;
    });
    assert.equal(seenTable.length, 0, "org A must not see org B's entry through the table");
    // The governed view scopes by its own temp-table tenant context, which the
    // app pool scope does not establish — reading it there returns empty for
    // every session with or without isolation, a vacuous proof. Read it the
    // way web readers do instead: runUserSql establishes the temp context and
    // the tenant GUCs and executes as the SELECT-only role, so both the view
    // predicate and the underlying base-table policies must agree to hide the
    // row. The console search_path resolves the bare table name to the view,
    // exactly as a user query would.
    const seenView = await runUserSql(
      `select id from journal_entries where id = '${entryB}'`,
      { orgId: orgA.orgId },
    );
    assert.equal(seenView.rowCount, 0, "org A must not see org B's entry through the web-reader view");
    // Non-vacuity, both mechanisms: B's own scope sees it — through the pool
    // and through the governed reader. The governed B-side read in particular
    // proves the A-side governed emptiness means isolation: with no temp
    // context (or a broken one) the view is empty for B as well.
    const seenOwn = await withOrgContext(orgB.orgId, async () => {
      const r = await db.execute(sql`select id from journal_entries where id = ${entryB}`);
      return r.rows;
    });
    assert.equal(seenOwn.length, 1, "org B must see its own entry — otherwise the emptiness above proves nothing");
    const seenOwnGoverned = await runUserSql(
      `select id from journal_entries where id = '${entryB}'`,
      { orgId: orgB.orgId },
    );
    assert.equal(seenOwnGoverned.rowCount, 1, "org B must see its own entry through the governed reader — otherwise the governed emptiness above proves nothing");
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
