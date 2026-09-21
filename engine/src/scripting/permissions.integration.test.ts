// Run with:  node --import tsx --import ./engine/src/testing/database-bypass.ts --test engine/src/scripting/permissions.integration.test.ts   (from repo root)
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
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import {
  MAX_SCRIPT_LOG_BYTES,
  MAX_SCRIPT_LOG_ENTRIES,
  MAX_SCRIPT_QUERY_RESULT_BYTES,
  SCRIPT_HOST_TIMEOUT,
  runEndpointScript,
  runScheduledScript,
  runScript,
  scriptHostAllowsJournal,
  scriptHostAllowsQuery,
  scriptQueryResultCapRefusal,
  serializeScriptQueryResult,
  withScriptHostDeadline,
} from "./scripting.ts";

test("the __journal_create host fn resolves the live permission gate before any ledger write", () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const host = source.slice(source.indexOf('"__journal_create"'), source.indexOf('vm.setProp(obHandle, "log"'));
  const permAt = host.indexOf('actorHasPermission(db, ctx.org.id, ctx.user.id, "gl.post")');
  const writeAt = host.indexOf("createScriptJournal");
  assert.ok(permAt >= 0, "gl.post must be re-resolved live");
  assert.ok(writeAt >= 0, "createScriptJournal must exist");
  assert.ok(permAt < writeAt, "permission gate must run before the ledger write");
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
  const host = source.slice(source.indexOf('"__query"'), source.indexOf('"__journal_create"'));
  const refuseAt = host.indexOf("scriptQueryRefusal(ctx)");
  const sqlAt = host.indexOf("runUserSql");
  assert.ok(refuseAt >= 0, "scriptQueryRefusal must run on the query host");
  assert.ok(sqlAt >= 0, "runUserSql must exist");
  assert.ok(refuseAt < sqlAt, "query gates must run before SQL");
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

// ---------------------------------------------------------------------------
// Human-driven document triggers must carry ctx.user so query/journal gates
// never take the actor-less system path for a signed-in submit/post/void.
// ---------------------------------------------------------------------------

const HOSTLESS_ORG = { id: "00000000-0000-4000-8000-000000000001", name: "Host", baseCurrency: "CAD" };

function callerSource(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

test("human submit/post/void callers resolve the actor into ctx.user before runTriggerScripts", () => {
  const submit = callerSource("../flows/submit.ts");
  const submitCtx = submit.slice(submit.indexOf("const scriptCtx: ScriptContext"), submit.indexOf("runTriggerScripts(\"before_submit\""));
  assert.match(submit, /resolveScriptUser\(/);
  assert.match(submitCtx, /user/);

  const prepare = callerSource("../ledger/posting-prepare.ts");
  const beforePostAt = prepare.indexOf("const scriptCtx: ScriptContext");
  const beforePost = prepare.slice(prepare.lastIndexOf("resolveScriptUser", beforePostAt), prepare.indexOf("runTriggerScripts(\"before_post\""));
  assert.match(beforePost, /resolveScriptUser\(/);
  assert.match(beforePost, /user/);
  const dispatch = callerSource("../ledger/posting-dispatch.ts");
  const afterPostAt = dispatch.indexOf("const ctx: ScriptContext");
  const afterPost = dispatch.slice(dispatch.lastIndexOf("resolveScriptUser", afterPostAt), dispatch.indexOf("runTriggerScripts(\"after_post\""));
  assert.match(afterPost, /resolveScriptUser\(/);
  assert.match(afterPost, /user/);

  const voids = callerSource("../ledger/document-void.ts");
  const beforeVoid = voids.slice(voids.indexOf("const scriptCtx: ScriptContext"), voids.indexOf("runTriggerScripts(\"before_void\""));
  assert.match(voids, /resolveScriptUser\(/);
  assert.match(beforeVoid, /user/);
});

test("script host I/O is raced against the same wall-clock deadline as the interrupt handler", async () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const queryFn = source.slice(source.indexOf("\"__query\""), source.indexOf("\"__journal_create\""));
  assert.match(queryFn, /withScriptHostDeadline/);
  assert.match(queryFn, /remainingMs <= 0/);
  const queryRaceAt = queryFn.indexOf("withScriptHostDeadline");
  assert.ok(queryRaceAt >= 0, "__query must race host I/O");
  const queryBeforeRace = queryFn.slice(0, queryRaceAt);
  const queryRaced = queryFn.slice(queryRaceAt);
  assert.doesNotMatch(
    queryBeforeRace,
    /scriptQueryRefusal|runUserSql/,
    "query authorization and SQL must not await outside the host deadline",
  );
  assert.match(queryRaced, /scriptQueryRefusal/);
  assert.match(queryRaced, /runUserSql/);

  const journalFn = source.slice(source.indexOf("\"__journal_create\""), source.indexOf("vm.setProp(obHandle, \"log\""));
  assert.match(journalFn, /withScriptHostDeadline/);
  assert.match(journalFn, /remainingMs <= 0/);
  const journalRaceAt = journalFn.indexOf("withScriptHostDeadline");
  assert.ok(journalRaceAt >= 0, "__journal_create must race host I/O");
  const journalBeforeRace = journalFn.slice(0, journalRaceAt);
  const journalRaced = journalFn.slice(journalRaceAt);
  assert.doesNotMatch(
    journalBeforeRace,
    /actorHasPermission|actorAllowedSubsidiaryIds|createScriptJournal/,
    "journal authorization and scope reads must not await outside the host deadline",
  );
  assert.match(journalRaced, /actorHasPermission/);
  assert.match(journalRaced, /actorAllowedSubsidiaryIds/);
  assert.match(journalRaced, /createScriptJournal/);

  let ranAfterDeadline = false;
  const alreadyOver = await withScriptHostDeadline(Date.now() - 1, async () => {
    ranAfterDeadline = true;
    return "ran";
  });
  assert.equal(alreadyOver, SCRIPT_HOST_TIMEOUT);
  assert.equal(ranAfterDeadline, false, "a host call must not start once the deadline has passed");

  const started = Date.now();
  const raced = await withScriptHostDeadline(Date.now() + 25, () =>
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("late"), 250);
    }),
  );
  assert.equal(raced, SCRIPT_HOST_TIMEOUT);
  assert.ok(Date.now() - started < 200, `host deadline race exceeded bound: ${Date.now() - started}ms`);
});

test("ob.log is capped on the host side independently of the QuickJS heap", async () => {
  const res = await runScript(
    `function main(ctx) {
      for (var i = 0; i < 400; i++) ob.log("${"x".repeat(400)}");
      return { n: 1 };
    }`,
    { trigger: "before_submit", org: HOSTLESS_ORG },
    2_000,
  );
  assert.equal(res.status, "ok", res.abortReason ?? "");
  assert.ok(res.logs.length <= MAX_SCRIPT_LOG_ENTRIES + 1, `uncapped entries: ${res.logs.length}`);
  const bytes = res.logs.reduce((n, line) => n + Buffer.byteLength(line, "utf8"), 0);
  assert.ok(bytes <= MAX_SCRIPT_LOG_BYTES + 256, `uncapped log bytes: ${bytes}`);
  assert.match(res.logs.at(-1) ?? "", /ob\.log truncated/);
});

test("payment_format and unknown triggers fail closed: no query or journal host I/O", async () => {
  assert.equal(scriptHostAllowsQuery("payment_format"), false);
  assert.equal(scriptHostAllowsJournal("payment_format"), false);
  assert.equal(scriptHostAllowsQuery("not_a_real_trigger"), false);
  assert.equal(scriptHostAllowsJournal("not_a_real_trigger"), false);
  assert.equal(scriptHostAllowsQuery("before_submit"), true);
  assert.equal(scriptHostAllowsJournal("scheduled"), true);
  assert.equal(scriptHostAllowsQuery("custom_gl_lines", { deterministic: true }), false);

  const query = await runScript(
    `function main(ctx) { return ob.query("select 1"); }`,
    { trigger: "payment_format", org: HOSTLESS_ORG },
    2_000,
  );
  assert.equal(query.status, "error");
  assert.match(query.abortReason ?? "", /query is not available in payment_format/);

  const journal = await runScript(
    `function main(ctx) { return ob.journal.create({ lines: [] }); }`,
    { trigger: "payment_format", org: HOSTLESS_ORG },
    2_000,
  );
  assert.equal(journal.status, "error");
  assert.match(journal.abortReason ?? "", /journal\.create is not available in payment_format/);
});

test("ob.query encodes rows under a byte cap and never JSON.stringifies the complete result first", () => {
  const source = readFileSync(new URL("./scripting.ts", import.meta.url), "utf8");
  const queryFn = source.slice(source.indexOf("\"__query\""), source.indexOf("\"__journal_create\""));
  assert.doesNotMatch(
    queryFn,
    /JSON\.stringify\(\s*result/,
    "the host must not materialize an unbounded JSON copy before the byte cap",
  );
  assert.match(queryFn, /serializeScriptQueryResult/);

  const rows = [{ id: 1, memo: "freight", amount: "10.00" }];
  const under = serializeScriptQueryResult(rows, 256);
  assert.equal(under.ok, true);
  assert.equal(under.json, JSON.stringify(rows));

  const over = serializeScriptQueryResult([{ blob: "x".repeat(200) }], 64);
  assert.equal(over.ok, false);
  assert.match(over.refusal, /host result cap/);
  assert.match(over.refusal, /64/);
  assert.equal("json" in over, false);

  const many = Array.from({ length: 40 }, (_, i) => ({ i, blob: "yyyyyyyyyy" }));
  const manyOver = serializeScriptQueryResult(many, 128);
  assert.equal(manyOver.ok, false);
  assert.match(manyOver.refusal, /host result cap/);

  const dated = [{ postedAt: new Date("2020-01-01T00:00:00.000Z"), empty: null, flag: true }];
  const datedOut = serializeScriptQueryResult(dated, 256);
  assert.equal(datedOut.ok, true);
  assert.equal(datedOut.json, JSON.stringify(dated));

  const named = scriptQueryResultCapRefusal();
  assert.match(named, /host result cap/);
  assert.match(named, new RegExp(String(MAX_SCRIPT_QUERY_RESULT_BYTES)));
  assert.doesNotMatch(named, /undefined/);
});
