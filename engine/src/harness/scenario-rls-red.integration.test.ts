import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { runUserSql } from "../platform/sqlapi.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { probeTableIsolation, runScenario } from "./scenario.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Anti-false-green for the harness's `rls-org-isolation` check — "an org's
 * data is never readable from another org, by any reader".
 *
 * Two proofs. First, the catalog half: a freshly created org-scoped table
 * with no policy must fail the check by name — the defect class is "a new
 * table nobody wired up", so the proof creates exactly that table and drops
 * it in a finally. Second, the mechanism half: two scratch orgs, one draft
 * document living in org B, read from org A's scope through the base table
 * via probeTableIsolation (one pool client in A's scope inside a READ ONLY
 * transaction, assuming the runtime role first when the login itself
 * bypasses RLS — a superuser login is exempt from RLS entirely, so a raw
 * read would prove nothing there) AND through the governed reader (the
 * openbooks_query view web readers use, read via runUserSql, the production
 * governed path: temp-table tenant context plus tenant GUCs under the
 * SELECT-only role — RLS-subject in every environment, so this half guards
 * the governed mechanism independently of the login's posture). Both A-scope
 * reads must be empty, and each mechanism is read back from org B's own
 * scope too — a scope that silently fails closed would otherwise pass
 * vacuously, and the governed view in particular returns empty whenever its
 * temp context is missing, so the B-side governed read is what proves the
 * A-side emptiness means isolation rather than an unestablished context.
 */

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const c = cp.checks.find((c) => c.name === name);
  assert.ok(c, `checkpoint must carry the ${name} check`);
  return c;
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
      const id = randomUUID();
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, currency)
        values (${id}, ${orgB.orgId}, 'customer_invoice', ${`RLS-B-${id.slice(0, 8)}`}, ${orgB.date}, 'CAD')`);
      return id;
    });
    // Foreign reads from A's scope: base table through an RLS-subject reader
    // (the harness pool login itself is a superuser in CI and rehearsal, and
    // PostgreSQL exempts such logins from RLS entirely — reading raw would
    // prove nothing there, so the probe assumes the runtime role first).
    const tableProbe = await probeTableIsolation(orgA.orgId, entryB);
    assert.equal(tableProbe.established, true, `table probe must run as an RLS-subject role: ${tableProbe.detail}`);
    assert.equal(tableProbe.tableHidden, true, "org A must not see org B's entry through the table");
    // The governed view scopes by its own temp-table tenant context, which the
    // app pool scope does not establish — reading it there returns empty for
    // every session with or without isolation, a vacuous proof. Read it the
    // way web readers do instead: runUserSql establishes the temp context and
    // the tenant GUCs and executes as the SELECT-only role, so both the view
    // predicate and the underlying base-table policies must agree to hide the
    // row. The console search_path resolves the bare table name to the view,
    // exactly as a user query would.
    const seenView = await runUserSql(
      `select id from documents where id = '${entryB}'`,
      { orgId: orgA.orgId },
    );
    assert.equal(seenView.rowCount, 0, "org A must not see org B's entry through the web-reader view");
    // Non-vacuity, both mechanisms: B's own scope sees it — through the
    // RLS-subject probe and through the governed reader. The governed B-side
    // read in particular proves the A-side governed emptiness means
    // isolation: with no temp context (or a broken one) the view is empty
    // for B as well.
    const seenOwn = await probeTableIsolation(orgB.orgId, entryB);
    assert.equal(seenOwn.established, true, `own-scope probe must run as an RLS-subject role: ${seenOwn.detail}`);
    assert.equal(seenOwn.tableHidden, false, "org B must see its own entry — otherwise the emptiness above proves nothing");
    const seenOwnGoverned = await runUserSql(
      `select id from documents where id = '${entryB}'`,
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

/**
 * The rehearsal/CI harness logs in as a superuser, which PostgreSQL exempts
 * from RLS entirely (FORCE included) — so the table half of the probe must
 * assume the runtime role first. With two document-holding orgs the probe is
 * live (not vacuous): it must PASS on a clean catalog. Where the test login
 * itself bypasses, the detail must say which runtime role was assumed, which
 * pins the switch; where the login is already RLS-subject (ownership
 * transfer), the same test still pins the passing behavior.
 */
test("rls-org-isolation passes with live foreign rows, even when the login bypasses RLS", { skip: !DB }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, currency)
        values (${randomUUID()}, ${orgB.orgId}, 'customer_invoice', ${`RLS-PROBE-${orgB.orgId.slice(0, 8)}`},
                ${orgB.date}, 'CAD')`);
    });
    const login = await withBypassContext(async () => {
      const r = await db.execute<{ bypass: boolean }>(sql`
        select coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), true) as bypass`);
      return r.rows[0]!;
    });
    const cp = await runScenario(orgA.orgId, { at: orgA.date });
    const rls = check(cp, "rls-org-isolation");
    assert.equal(rls.ok, true, `RLS gate must hold with live foreign rows: ${rls.detail}`);
    assert.match(rls.detail, /foreign doc invisible via table=true view=true/, "both halves must genuinely probe");
    if (login.bypass) {
      assert.match(
        rls.detail,
        /table half assumed runtime role [a-z_]+; harness login \S+ bypasses RLS/,
        "a bypassing login must assume the runtime role for the table half",
      );
    }
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});
