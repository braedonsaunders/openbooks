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
