// Run with:  node --import tsx --import ./engine/src/test-database-bypass.ts --test engine/src/scripting-permissions.integration.test.ts   (from repo root)
//
// Regression coverage for fnd_mt97va1e_kiv9jd: the user-script runtime exposed
// ob.journal.create to ANY attributed caller (endpoint scripts ran with only
// scripts.execute), letting a scripts.execute-only principal create and post
// journals under its own identity. The runtime now demands the caller's
// gl.post before every governed ledger write, exactly like every HTTP journal
// boundary (guardPermission('gl.post')); system actors (scheduled/bulk/engine
// triggers have no signed-in user) keep the documented system-provenance path.
// Skipped unless OPENBOOKS_DB_URL is set.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "./db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "./test-fixtures.ts";
import { actorHasPermission } from "./actor-permissions.ts";
import { runEndpointScript, runScheduledScript } from "./scripting.ts";

test("the __journal_create host fn resolves the live permission gate before any ledger write", () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const hostStart = source.indexOf('"__journal_create"');
  const tryStart = source.indexOf("try {", hostStart);
  const boundary = source.slice(hostStart, tryStart);
  assert.match(boundary, /actorHasPermission\(db, ctx\.org\.id, ctx\.user\.id, "gl\.post"\)/);
});

const DB = !!process.env.OPENBOOKS_DB_URL;

const JOURNAL_SCRIPT = `
function main(ctx) {
  const post = !!(ctx.request && ctx.request.body && ctx.request.body.post);
  return ob.journal.create({
    documentDate: "2026-07-15",
    memo: "script accrual",
    lines: [
      { accountCode: "5100", amount: 25 },
      { accountCode: "2000", amount: -25 },
    ],
  }, post ? { post: true } : undefined);
}
`;

interface ScriptOrg {
  org: ScratchOrg;
  /** Holds only scripts.execute-class duties — no GL write rights. */
  clerkId: string;
  clerkRoleKey: string;
  posterId: string;
  /** Wildcard module grant that must still satisfy permissionSetCovers. */
  wildId: string;
  /** Role grants gl.post but a deny override removes it — deny wins. */
  deniedId: string;
  superId: string;
}

async function seedScriptOrg(): Promise<ScriptOrg> {
  const org = await createScratchOrg();
  // The scripting feature flag gates every execution path (org settings).
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true'::jsonb)
     where id = ${org.orgId}`);

  async function mk(name: string, key: string, permissions: string[]): Promise<string> {
    const userId = await createScratchUser(org.orgId, name, key);
    if (permissions.length) {
      await db.execute(sql`
        update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
         where org_id = ${org.orgId} and key = ${key}`);
    }
    return userId;
  }

  const clerkId = await mk("Clerk", "clerk", []);
  const posterId = await mk("Poster", "poster", ["gl.post"]);
  const wildId = await mk("Wilder", "wilder", ["gl.*"]);
  const deniedId = await mk("Denied", "denied", ["gl.post"]);
  const superId = await mk("Super", "super", []);
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${org.orgId}, ${deniedId}, 'gl.post', 'deny')`);
  await db.execute(sql`
    update users set is_super_admin = true where id = ${superId} and org_id = ${org.orgId}`);

  return { org, clerkId, clerkRoleKey: "clerk", posterId, wildId, deniedId, superId };
}

/** Count the ledger surface an unauthorized create/post must never touch. */
async function ledgerRowCounts(orgId: string): Promise<{ docs: string; lines: string; entries: string }> {
  const r = (await db.execute<{ docs: string; lines: string; entries: string }>(sql`
    select (select count(*) from documents where org_id = ${orgId})::text as docs,
           (select count(*) from document_lines where org_id = ${orgId})::text as lines,
           (select count(*) from journal_entries where org_id = ${orgId})::text as entries`));
  return r.rows[0]!;
}

async function seedEndpointScript(orgId: string, slug: string): Promise<void> {
  await db.execute(sql`
    insert into user_scripts (id, org_id, name, trigger_point, endpoint_slug, source)
    values (${randomUUID()}, ${orgId}, ${"restlet-" + slug}, 'endpoint', ${slug}, ${JOURNAL_SCRIPT})`);
}

test("an engine-only user's effective-permission gate resolves roles, wildcards, overrides, and identity", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    assert.equal(await actorHasPermission(db, seeded.org.orgId, seeded.clerkId, "gl.post"), false);
    assert.equal(await actorHasPermission(db, seeded.org.orgId, seeded.posterId, "gl.post"), true);
    assert.equal(await actorHasPermission(db, seeded.org.orgId, seeded.wildId, "gl.post"), true);
    assert.equal(await actorHasPermission(db, seeded.org.orgId, seeded.deniedId, "gl.post"), false);
    assert.equal(await actorHasPermission(db, seeded.org.orgId, seeded.superId, "gl.post"), true);
    // Fail closed on phantom or inactive principals.
    assert.equal(await actorHasPermission(db, seeded.org.orgId, randomUUID(), "gl.post"), false);
    await db.execute(sql`update users set is_active = false where id = ${seeded.posterId}`);
    await db.execute(sql`update users set is_active = false where id = ${seeded.posterId}`);
    assert.equal(await actorHasPermission(db, seeded.org.orgId, seeded.posterId, "gl.post"), false);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("a scripts.execute-only caller cannot draft a journal through an endpoint script", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const slug = "no-draft-rights";
    await seedEndpointScript(seeded.org.orgId, slug);
    const outcome = await runEndpointScript(
      slug,
      seeded.org.orgId,
      { id: seeded.clerkId, name: "Clerk", roles: [seeded.clerkRoleKey] },
      { method: "POST", query: {}, body: null },
    );
    assert.ok(outcome, "the active endpoint script was found");
    assert.equal(outcome!.status, "error");
    assert.match(outcome!.abortReason ?? "", /missing permission: gl\.post/);
    assert.deepEqual(await ledgerRowCounts(seeded.org.orgId), { docs: "0", lines: "0", entries: "0" });
    // The refusal stays on the audit trail as a failed run.
    const runs = (await db.execute<{ status: string; error_message: string | null }>(sql`
      select status::text as status, error_message from script_runs where org_id = ${seeded.org.orgId}`)).rows;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "error");
    assert.match(runs[0]!.error_message ?? "", /gl\.post/);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("the same caller cannot post either — refusal is independent of the draft case", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const slug = "no-post-rights";
    await seedEndpointScript(seeded.org.orgId, slug);
    const outcome = await runEndpointScript(
      slug,
      seeded.org.orgId,
      { id: seeded.clerkId, name: "Clerk", roles: [seeded.clerkRoleKey] },
      { method: "POST", query: {}, body: { post: true } },
    );
    assert.ok(outcome);
    assert.equal(outcome!.status, "error");
    assert.match(outcome!.abortReason ?? "", /missing permission: gl\.post/);
    assert.deepEqual(await ledgerRowCounts(seeded.org.orgId), { docs: "0", lines: "0", entries: "0" });
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("a gl.post holder creates drafts and posts through the unchanged sandbox path", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const slug = "poster-restlet";
    await seedEndpointScript(seeded.org.orgId, slug);
    const caller = (id: string) => ({ id, name: "Caller", roles: ["any"] });

    const draft = await runEndpointScript(slug, seeded.org.orgId, caller(seeded.posterId), {
      method: "POST",
      query: {},
      body: null,
    });
    assert.ok(draft && draft.status === "ok", `draft run errored: ${draft?.abortReason}`);
    const draftResult = draft!.returned as { id: string; documentNumber: string; entryId?: string };
    assert.ok(draftResult.documentNumber.startsWith("JE-"));
    assert.equal(draftResult.entryId, undefined, "draft-only creation posts nothing");
    const docRow = (await db.execute<{ created_by: string | null }>(sql`
      select created_by::text from documents where id = ${draftResult.id} and org_id = ${seeded.org.orgId}`)).rows[0];
    assert.equal(docRow?.created_by, seeded.posterId);

    const posted = await runEndpointScript(slug, seeded.org.orgId, caller(seeded.posterId), {
      method: "POST",
      query: {},
      body: { post: true },
    });
    assert.ok(posted && posted.status === "ok", `post run errored: ${posted?.abortReason}`);
    const postedResult = posted!.returned as { id: string; entryId?: string };
    assert.ok(postedResult.entryId, "posting returned a ledger entry");
    const entry = await db.execute(sql`
      select 1 from journal_entries where id = ${postedResult.entryId!} and org_id = ${seeded.org.orgId}`);
    assert.equal(entry.rows.length, 1);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("wildcard grants and platform super admins are authorized; a deny override is not", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const slug = "matrix-restlet";
    await seedEndpointScript(seeded.org.orgId, slug);
    const caller = (id: string) => ({ id, name: "Caller", roles: [] });

    for (const [label, userId, expectedOk] of [
      ["gl.* holder", seeded.wildId, true],
      ["super admin", seeded.superId, true],
      ["denied override", seeded.deniedId, false],
    ] as const) {
      const outcome = await runEndpointScript(slug, seeded.org.orgId, caller(userId), {
        method: "POST",
        query: {},
        body: { post: false },
      });
      if (expectedOk) {
        assert.ok(outcome && outcome.status === "ok", `${label} should pass: ${outcome?.abortReason}`);
      } else {
        assert.ok(outcome && outcome.status === "error", `${label} should be refused`);
        assert.match(outcome!.abortReason ?? "", /missing permission: gl\.post/);
      }
    }
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("system actors are untouched: an actor-less scheduled script still posts under system provenance", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    // The same ob.journal.create host call, but runScheduledScript supplies no
    // ctx.user — the documented system-provenance path must keep working.
    const scheduledSource = `
function main(ctx) {
  return ob.journal.create({
    documentDate: "${seeded.org.date}",
    memo: "scheduled accrual",
    lines: [
      { accountCode: "5100", amount: 40 },
      { accountCode: "2000", amount: -40 },
    ],
  }, { post: true });
}
`;
    const scriptId = randomUUID();
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, cron, next_run_at, source)
      values (${scriptId}, ${seeded.org.orgId}, 'nightly', 'scheduled', '* * * * *', now(), ${scheduledSource})`);

    const outcome = await runScheduledScript(scriptId, seeded.org.orgId);
    assert.equal(outcome.status, "ok");
    const result = outcome.returned as { entryId?: string };
    assert.ok(result.entryId, "actor-less posting still works");
    const docRow = (await db.execute<{ created_by: string | null; custom: Record<string, string> }>(sql`
      select d.created_by::text as created_by, d.custom
        from journal_entries e join documents d on d.id = e.source_document_id
       where e.id = ${result.entryId!} and e.org_id = ${seeded.org.orgId}`)).rows[0];
    // There is no signed-in user to authorize here; documented system provenance applies.
    assert.equal(docRow!.created_by, null);
    assert.equal(docRow!.custom.actorKind, "system");
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Subsidiary scope (X1): sandboxed journal writes always resolved the ROOT
// entity regardless of the caller's visibility. A restricted caller must be
// treated exactly like the HTTP draft route: an omitted subsidiaryId
// auto-selects only when the allowed set holds exactly one entity, an
// explicit out-of-scope id is "not found", and an empty scope is refused.
// ---------------------------------------------------------------------------

const SCOPED_JOURNAL_SCRIPT = `
function main(ctx) {
  const body = (ctx.request && ctx.request.body) || {};
  const input = {
    documentDate: "2026-07-15",
    memo: "scoped accrual",
    lines: [
      { accountCode: "5100", amount: 25 },
      { accountCode: "2000", amount: -25 },
    ],
  };
  if (body.subsidiaryId) input.subsidiaryId = body.subsidiaryId;
  return ob.journal.create(input, body.post ? { post: true } : undefined);
}
`;

async function seedChildSubsidiary(orgId: string, rootId: string): Promise<string> {
  const childId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    select ${childId}, ${orgId}, ${rootId}, 'Child entity', base_currency, country
      from subsidiaries where id = ${rootId} and org_id = ${orgId}`);
  return childId;
}

async function restrictRole(orgId: string, roleKey: string, subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function journalSubsidiaries(orgId: string): Promise<string[]> {
  const r = (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id::text from documents where org_id = ${orgId} and kind = 'journal'`));
  return r.rows.map((row) => row.subsidiary_id);
}

test("a caller restricted to a child entity never journals into the root, even when posting", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const rootId = seeded.org.subsidiaryId;
    const childId = await seedChildSubsidiary(seeded.org.orgId, rootId);
    await restrictRole(seeded.org.orgId, "poster", [childId]);
    const slug = "scoped-restlet";
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, endpoint_slug, source)
      values (${randomUUID()}, ${seeded.org.orgId}, 'scoped', 'endpoint', ${slug}, ${SCOPED_JOURNAL_SCRIPT})`);
    const caller = { id: seeded.posterId, name: "Poster", roles: ["poster"] };

    // Omitted subsidiaryId: the single allowed entity is selected, not the root.
    const posted = await runEndpointScript(slug, seeded.org.orgId, caller, {
      method: "POST", query: {}, body: { post: true },
    });
    assert.ok(posted && posted.status === "ok", `post run errored: ${posted?.abortReason}`);
    const result = posted!.returned as { entryId?: string };
    assert.ok(result.entryId, "posting succeeded inside the caller's own entity");
    assert.deepEqual(await journalSubsidiaries(seeded.org.orgId), [childId]);
    const entry = (await db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id::text from journal_entries where id = ${result.entryId!} and org_id = ${seeded.org.orgId}`)).rows[0];
    assert.equal(entry?.subsidiary_id, childId, "the ledger entry is booked in the child entity");

    // Explicit root: refused indistinguishably from a missing entity, zero rows written.
    const before = await ledgerRowCounts(seeded.org.orgId);
    const refused = await runEndpointScript(slug, seeded.org.orgId, caller, {
      method: "POST", query: {}, body: { post: true, subsidiaryId: rootId },
    });
    assert.ok(refused && refused.status === "error", "an out-of-scope entity is refused");
    assert.match(refused!.abortReason ?? "", /subsidiary not found/);
    assert.doesNotMatch(refused!.abortReason ?? "", /permission/);
    assert.deepEqual(await ledgerRowCounts(seeded.org.orgId), before);
    assert.deepEqual(await journalSubsidiaries(seeded.org.orgId), [childId]);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("an empty or ambiguous restricted scope is refused rather than defaulted to the root", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const rootId = seeded.org.subsidiaryId;
    const childId = await seedChildSubsidiary(seeded.org.orgId, rootId);
    const slug = "scope-edges";
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, endpoint_slug, source)
      values (${randomUUID()}, ${seeded.org.orgId}, 'edges', 'endpoint', ${slug}, ${SCOPED_JOURNAL_SCRIPT})`);
    const caller = { id: seeded.posterId, name: "Poster", roles: ["poster"] };

    await restrictRole(seeded.org.orgId, "poster", []);
    const empty = await runEndpointScript(slug, seeded.org.orgId, caller, { method: "POST", query: {}, body: null });
    assert.ok(empty && empty.status === "error");
    assert.match(empty!.abortReason ?? "", /no available subsidiary/);

    await restrictRole(seeded.org.orgId, "poster", [rootId, childId]);
    const ambiguous = await runEndpointScript(slug, seeded.org.orgId, caller, { method: "POST", query: {}, body: null });
    assert.ok(ambiguous && ambiguous.status === "error");
    assert.match(ambiguous!.abortReason ?? "", /subsidiaryId must be selected/);

    // Selecting one of the two allowed entities explicitly works.
    const chosen = await runEndpointScript(slug, seeded.org.orgId, caller, {
      method: "POST", query: {}, body: { subsidiaryId: childId },
    });
    assert.ok(chosen && chosen.status === "ok", `explicit in-scope entity errored: ${chosen?.abortReason}`);
    assert.deepEqual(await ledgerRowCounts(seeded.org.orgId), { docs: "1", lines: "2", entries: "0" });
    assert.deepEqual(await journalSubsidiaries(seeded.org.orgId), [childId]);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("an unrestricted caller keeps the root default and may pick any active entity", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const rootId = seeded.org.subsidiaryId;
    const childId = await seedChildSubsidiary(seeded.org.orgId, rootId);
    const slug = "unrestricted-scope";
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, endpoint_slug, source)
      values (${randomUUID()}, ${seeded.org.orgId}, 'unrestricted', 'endpoint', ${slug}, ${SCOPED_JOURNAL_SCRIPT})`);
    const caller = { id: seeded.posterId, name: "Poster", roles: ["poster"] };
    const defaulted = await runEndpointScript(slug, seeded.org.orgId, caller, { method: "POST", query: {}, body: null });
    assert.ok(defaulted && defaulted.status === "ok", defaulted?.abortReason ?? "");
    const explicit = await runEndpointScript(slug, seeded.org.orgId, caller, {
      method: "POST", query: {}, body: { subsidiaryId: childId },
    });
    assert.ok(explicit && explicit.status === "ok", explicit?.abortReason ?? "");
    assert.deepEqual((await journalSubsidiaries(seeded.org.orgId)).sort(), [rootId, childId].sort());
    const bogus = await runEndpointScript(slug, seeded.org.orgId, caller, {
      method: "POST", query: {}, body: { subsidiaryId: randomUUID() },
    });
    assert.ok(bogus && bogus.status === "error");
    assert.match(bogus!.abortReason ?? "", /invalid subsidiary/);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Raw SQL (X2): ob.query / ob.record.load / ob.search ran runUserSql for ANY
// attributed caller — a scripts.execute-only principal could read the whole
// governed catalog through a restlet. The host fn now demands exactly what
// /api/query demands of the caller: the queryConsole feature, sql.execute,
// and an unrestricted subsidiary scope. Actor-less system runs are untouched.
// ---------------------------------------------------------------------------

const QUERY_SCRIPT = `
function main(ctx) {
  const mode = (ctx.request && ctx.request.body && ctx.request.body.mode) || "query";
  if (mode === "load") return ob.record.load("accounts", ob.search("accounts", { number: "5100" })[0].id);
  if (mode === "search") return ob.search("accounts", { number: "5100" });
  return ob.query("select count(*)::int as n from journal_lines");
}
`;

async function seedQueryScript(orgId: string, slug: string): Promise<void> {
  await db.execute(sql`
    insert into user_scripts (id, org_id, name, trigger_point, endpoint_slug, source)
    values (${randomUUID()}, ${orgId}, ${"query-" + slug}, 'endpoint', ${slug}, ${QUERY_SCRIPT})`);
}

async function setQueryConsole(orgId: string, enabled: boolean): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,queryConsole}', ${enabled ? "true" : "false"}::jsonb, true)
     where id = ${orgId}`);
}

test("the __query host fn resolves the caller's query-console gates before any SQL runs", () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const hostStart = source.indexOf('"__query"');
  const tryStart = source.indexOf("try {", hostStart);
  const boundary = source.slice(hostStart, tryStart);
  assert.match(boundary, /scriptQueryRefusal\(ctx\)/);
  const gate = source.slice(source.indexOf("export async function scriptQueryRefusal"), source.indexOf("export async function scriptingFeatureEnabled"));
  assert.match(gate, /queryConsole/);
  assert.match(gate, /actorHasPermission\(db, ctx\.org\.id, userId, "sql\.execute"\)/);
  assert.match(gate, /actorAllowedSubsidiaryIds\(db, ctx\.org\.id, userId\)\) !== null/);
});

test("a scripts.execute-only caller cannot read the catalog through ob.query, ob.record.load, or ob.search", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    await setQueryConsole(seeded.org.orgId, true);
    const slug = "clerk-query";
    await seedQueryScript(seeded.org.orgId, slug);
    for (const mode of ["query", "load", "search"]) {
      const outcome = await runEndpointScript(
        slug,
        seeded.org.orgId,
        { id: seeded.clerkId, name: "Clerk", roles: [seeded.clerkRoleKey] },
        { method: "POST", query: {}, body: { mode } },
      );
      assert.ok(outcome, "the active endpoint script was found");
      assert.equal(outcome!.status, "error", `${mode} must be refused`);
      assert.match(outcome!.abortReason ?? "", /missing permission: sql\.execute/);
      assert.equal(outcome!.returned, undefined);
    }
    const runs = (await db.execute<{ status: string; error_message: string | null }>(sql`
      select status::text as status, error_message from script_runs where org_id = ${seeded.org.orgId}`)).rows;
    assert.equal(runs.length, 3);
    for (const run of runs) assert.match(run.error_message ?? "", /sql\.execute/);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("ob.query honours the queryConsole feature and the unrestricted-scope rule exactly like /api/query", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const slug = "analyst-query";
    await seedQueryScript(seeded.org.orgId, slug);
    const analystId = await createScratchUser(seeded.org.orgId, "Analyst", "analyst");
    await db.execute(sql`
      update app_roles set permissions = '["sql.execute"]'::jsonb
       where org_id = ${seeded.org.orgId} and key = 'analyst'`);
    const caller = { id: analystId, name: "Analyst", roles: ["analyst"] };
    const run = (body: Record<string, unknown> | null = null) =>
      runEndpointScript(slug, seeded.org.orgId, caller, { method: "POST", query: {}, body });

    // Feature off: refused by name even with the permission.
    await setQueryConsole(seeded.org.orgId, false);
    const disabled = await run();
    assert.equal(disabled!.status, "error");
    assert.match(disabled!.abortReason ?? "", /queryConsole feature is disabled/);

    // Feature on + sql.execute + unrestricted: rows flow.
    await setQueryConsole(seeded.org.orgId, true);
    const allowed = await run();
    assert.equal(allowed!.status, "ok", allowed!.abortReason ?? "");
    assert.deepEqual(allowed!.returned, [{ n: 0 }]);
    const loaded = await run({ mode: "load" });
    assert.equal(loaded!.status, "ok", loaded!.abortReason ?? "");
    assert.equal((loaded!.returned as { number: string }).number, "5100");
    const searched = await run({ mode: "search" });
    assert.equal(searched!.status, "ok", searched!.abortReason ?? "");
    assert.equal((searched!.returned as { number: string }[]).length, 1);

    // Restricted subsidiary scope: raw SQL cannot apply the allowlist, so refused.
    await restrictRole(seeded.org.orgId, "analyst", [seeded.org.subsidiaryId]);
    const restricted = await run();
    assert.equal(restricted!.status, "error");
    assert.match(restricted!.abortReason ?? "", /unrestricted subsidiary access/);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});

test("system-driven runs keep ob.query: an actor-less scheduled script still reads", { skip: !DB }, async () => {
  const seeded = await seedScriptOrg();
  try {
    const scriptId = randomUUID();
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, cron, next_run_at, source)
      values (${scriptId}, ${seeded.org.orgId}, 'nightly-read', 'scheduled', '* * * * *', now(), ${QUERY_SCRIPT})`);
    const outcome = await runScheduledScript(scriptId, seeded.org.orgId);
    assert.equal(outcome.status, "ok", outcome.abortReason ?? "");
    assert.deepEqual(outcome.returned, [{ n: 0 }]);
  } finally {
    await dropScratchOrgReporting(seeded.org.orgId);
  }
});
