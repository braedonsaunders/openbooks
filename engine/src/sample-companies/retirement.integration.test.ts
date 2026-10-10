import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { db, withBypass, withMaintenanceTransaction, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { seedRolesForOrg } from "../provisioning/seed-roles.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { submitForApproval } from "../flows/submit.ts";
import { decideGate } from "../flows/gates.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow, seedDraftDocument, type ScratchOrg } from "../testing/fixtures.ts";
import { loadCatalog } from "../sandbox/catalog.ts";
import { beginTenantRetirement, recordTenantRetirementFailure, releaseTenantRetirement, tenantRetirementStatus } from "../organization/tenant-retirement.ts";
import { sampleRetirementPlan } from "./retirement-plan.ts";
import { admitSampleRetirement, executeSampleRetirement } from "./retirement.ts";
import { deleteRetiredTenantRows, retirementFingerprint } from "./retirement-data.ts";
import type { RetirementDatabaseIdentity } from "./retirement-contract.ts";

installEngineSeams();
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Plan = Awaited<ReturnType<typeof sampleRetirementPlan>>;
type Evidence = { org: ScratchOrg; actorId: string; postedId: string; draftId: string; gateId: string; sessionId: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Synthetic attestations exercise the disposable-fixture admission contract.
 * They are never operational backup or restore qualification receipts. */
function recovery() {
  return { backupSha256: hash("disposable fixture backup attestation"), restoreReceiptSha256: hash("disposable fixture restore attestation"),
    preservationReceiptSha256: hash("disposable fixture preservation attestation"), objectRetentionReceiptSha256: hash("disposable fixture has no storage objects"),
    verifiedAt: new Date().toISOString(), verifier: "Native retirement integration fixture" };
}
async function createEvidence(org: ScratchOrg): Promise<Evidence> {
  const { actorId, reviewerId } = await withBypass(async () => {
    await seedRolesForOrg(org.orgId);
    const actorId = await createScratchUser(org.orgId, "Retirement fixture author", "admin");
    const reviewerId = await createScratchUser(org.orgId, "Independent fixture reviewer", "admin");
    return { actorId, reviewerId };
  });
  const posted = await withOrgContext(org.orgId, () => createScriptJournal(org.orgId, actorId, {
    documentDate: org.date, subsidiaryId: org.subsidiaryId, memo: "Native posted history retained by retirement recovery",
    lines: [{ accountId: org.accounts.bank, amount: "125.25" }, { accountId: org.accounts.adjustment, amount: "-125.25" }],
  }, { post: true, allowedSubsidiaryIds: null, idempotencyKey: `retirement-fixture:${org.orgId}` }));
  assert.ok(posted.entryId && !posted.approvalPending);
  const draft = await withOrgContext(org.orgId, () => createScriptJournal(org.orgId, actorId, {
    documentDate: org.date, subsidiaryId: org.subsidiaryId, memo: "Operator draft with exact lines",
    lines: [{ accountId: org.accounts.bank, amount: "40.10" }, { accountId: org.accounts.adjustment, amount: "-40.10" }],
  }, { post: false, allowedSubsidiaryIds: null }));
  const approvalId = await withBypass(async () => {
    await seedApprovalFlow(org.orgId, { subjectKind: "vendor_bill", assignees: [{ type: "user", userId: reviewerId }], mode: "any", preventSelfApproval: true });
    return seedDraftDocument(org.orgId, { kind: "vendor_bill", createdBy: actorId, total: "60.00" });
  });
  const submitted = await withOrgContext(org.orgId, () => submitForApproval("vendor_bill", approvalId, actorId));
  assert.equal(submitted.gated, true);
  const gateId = await withOrgContext(org.orgId, async () => (await db.execute<{ id: string }>(sql`
    select id from flow_gates where org_id=${org.orgId} and subject_id=${approvalId}`)).rows[0]!.id);
  await withOrgContext(org.orgId, () => decideGate({ gateId, decision: "rejected", userId: reviewerId, comment: "Retain the independent review and original operator draft" }));
  const sessionId = randomUUID();
  // The session collection is web-owned; this fixture supplies only a native
  // user-linked authentication row, without issuing a token or importing web code.
  await withBypass(() => db.execute(sql`insert into auth_sessions(id,user_id,token_hash,auth_method,expires_at)
    values(${sessionId},${actorId},${hash(randomUUID())},'password',now()+interval '1 hour')`));
  return { org, actorId, postedId: posted.id, draftId: draft.id, gateId, sessionId };
}
async function planFor(retireIds: string[]): Promise<Plan> {
  const { database, live } = await withMaintenanceTransaction(null, async () => ({
    database: (await db.execute<RetirementDatabaseIdentity>(sql`select current_database() as database,inet_server_addr()::text as "serverAddress",
      inet_server_port() as "serverPort",current_setting('cluster_name') as "clusterName"`)).rows[0]!,
    live: (await db.execute<{ id: string }>(sql`select id from orgs order by id`)).rows.map(row => row.id),
  }));
  const plan = await sampleRetirementPlan({ version: 1, database, retainOrgIds: live.filter(id => !retireIds.includes(id)), retireOrgIds: retireIds,
    reason: "Retire only the exact disposable companies owned by this native lifecycle fixture" });
  assert.deepEqual(plan.blockers, [], "the matching native catalog and quiescent fixture must admit retirement");
  assert.equal(plan.admissible, true);
  return plan;
}
async function fingerprint(orgId: string) {
  return withMaintenanceTransaction(null, async () => retirementFingerprint(await loadCatalog(), orgId));
}
function nativeMessage(error: unknown): string {
  const value = error as { message?: string; cause?: unknown };
  return `${value?.message ?? String(error)} ${value?.cause ? nativeMessage(value.cause) : ""}`;
}
async function refusedStatement(command: () => Promise<unknown>, pattern: RegExp) {
  await db.execute(sql`savepoint refusal_probe`);
  try { await assert.rejects(command(), error => pattern.test(nativeMessage(error))); }
  finally { await db.execute(sql`rollback to savepoint refusal_probe`); await db.execute(sql`release savepoint refusal_probe`); }
}
async function runtimeForgery(runtime: Client, orgId: string, runId: string, digest: string, postedId: string) {
  const run = async (command: () => Promise<unknown>) => {
    await runtime.query("begin");
    try {
      await runtime.query("select set_config('app.current_org',$1,true),set_config('app.bypass_rls','on',true),set_config('openbooks.clone','on',true),set_config('openbooks.sandbox_wipe','on',true),set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)", [orgId]);
      await runtime.query("select set_config('openbooks.retirement_run',$1,true),set_config('openbooks.retirement_tenant',$2,true)", [runId, orgId]);
      await command();
    } finally { await runtime.query("rollback"); }
  };
  await run(async () => {
    const posture = (await runtime.query(`select r.rolsuper,r.rolbypassrls,
      tenant_retirement.openbooks_tenant_retirement_delete_allowed('orgs',jsonb_build_object('id',$1::uuid)) as allowed
      from pg_roles r where rolname=session_user`, [orgId])).rows[0];
    assert.deepEqual(posture, { rolsuper: false, rolbypassrls: false, allowed: false }, "actual runtime SESSION_USER cannot forge maintenance authority with GUCs");
  });
  await run(() => assert.rejects(runtime.query("select tenant_retirement.openbooks_retirement_begin($1,$2,$3)", [runId, orgId, digest]), /maintenance login/i));
  await run(() => assert.rejects(runtime.query("insert into tenant_retirement.delete_authorities(transaction_id,backend_pid,tenant_id,run_id,login_name) values(txid_current(),pg_backend_pid(),$1,$2,session_user)", [orgId, runId]), /permission denied/i));
  await run(() => assert.rejects(runtime.query("delete from documents where org_id=$1 and id=$2", [orgId, postedId])));
}

test("native tenant retirement rejects forged authority and preserves posted, draft, approval and auth evidence through quarantine, rollback and release", enabled, async () => {
  assert.ok(process.env.OPENBOOKS_RUNTIME_DB_URL, "qualification requires the actual restricted runtime login, never a maintenance fallback");
  const runtime = new Client({ connectionString: process.env.OPENBOOKS_RUNTIME_DB_URL });
  const anchor = await withBypass(() => createScratchOrg());
  const anchorActor = await withBypass(() => createScratchUser(anchor.orgId, "Recovery administrator", "admin"));
  const retainedOrg = await withBypass(() => createScratchOrg());
  const targetOrg = await withBypass(() => createScratchOrg());
  let active: { runId: string; plan: Plan } | undefined;
  let connected = false;
  try {
    await runtime.connect(); connected = true;
    const retained = await createEvidence(retainedOrg);
    const target = await createEvidence(targetOrg);
    const beforeRetained = await fingerprint(retainedOrg.orgId);
    const beforeTarget = await fingerprint(targetOrg.orgId);
    for (const evidence of [beforeRetained, beforeTarget]) {
      for (const table of ["documents", "document_lines", "journal_entries", "journal_lines", "flow_gates", "audit_log", "auth_sessions", "role_assignments"])
        assert.ok(BigInt(evidence.tables.find(row => row.table === table)!.count) > 0n, `the preservation proof includes real ${table} evidence`);
    }
    const plan = await planFor([targetOrg.orgId]);
    const runId = randomUUID();
    await assert.rejects(admitSampleRetirement({ plan, runId, actorId: anchorActor, recovery: {} }), /Recovery evidence/);
    await runtimeForgery(runtime, targetOrg.orgId, runId, plan.digest, target.postedId);
    await assert.rejects(admitSampleRetirement({ plan, runId, actorId: anchorActor, recovery: { ...recovery(), verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() } }), error => /verified within 24 hours/.test(nativeMessage(error)));
    await admitSampleRetirement({ plan, runId, actorId: anchorActor, recovery: recovery() });
    active = { runId, plan };
    assert.equal((await tenantRetirementStatus(runId)).targets[0]!.state, "quarantined");
    assert.deepEqual(await fingerprint(targetOrg.orgId), beforeTarget, "quarantine changes no target business/auth rows");
    await assert.rejects(withOrgTransaction(targetOrg.orgId, () => db.execute(sql`update documents set memo='Disallowed while quarantined' where org_id=${targetOrg.orgId} and id=${target.draftId}`)), error => /retirement fence/.test(nativeMessage(error)));
    await runtimeForgery(runtime, targetOrg.orgId, runId, plan.digest, target.postedId);
    await assert.rejects(withMaintenanceTransaction(null, () => beginTenantRetirement(runId, retainedOrg.orgId, plan.digest)), error => /Unreviewed retirement target/.test(nativeMessage(error)));
    await assert.rejects(withMaintenanceTransaction(null, () => beginTenantRetirement(runId, targetOrg.orgId, hash("unreviewed plan"))), error => /Unreviewed retirement target/.test(nativeMessage(error)));
    // A real competing row lock makes the public execution command time out
    // after beginning deletion; its own failure handler must roll everything back.
    await runtime.query("begin");
    try {
      await runtime.query("select set_config('app.current_org',$1,true),set_config('app.bypass_rls','off',true)", [targetOrg.orgId]);
      const locked = await runtime.query("select id from documents where org_id=$1 and id=$2 for share", [targetOrg.orgId, target.postedId]);
      assert.equal(locked.rows.length, 1);
      await assert.rejects(executeSampleRetirement({ runId, orgId: targetOrg.orgId, planDigest: plan.digest }), error => /lock timeout/.test(nativeMessage(error)));
    } finally { await runtime.query("rollback"); }
    assert.deepEqual(await fingerprint(targetOrg.orgId), beforeTarget, "the execution service rolls back a real lock-timeout failure");
    assert.ok((await tenantRetirementStatus(runId)).events.some(event => event.kind === "target_rolled_back" && event.tenant_id === targetOrg.orgId && event.detail.code === "55P03"), "the service records the original lock refusal after rolling back the target");
    assert.deepEqual(await fingerprint(retainedOrg.orgId), beforeRetained);
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      assert.equal(await beginTenantRetirement(runId, targetOrg.orgId, plan.digest), true);
      await refusedStatement(() => db.execute(sql`update documents set memo='DELETE authority is not UPDATE authority' where org_id=${targetOrg.orgId} and id=${target.draftId}`), /retirement fence/);
      await refusedStatement(() => db.execute(sql`insert into parties(org_id,kind,display_name) values(${targetOrg.orgId},'person','Forbidden insert')`), /retirement fence/);
      await refusedStatement(() => db.execute(sql`delete from documents where org_id=${retainedOrg.orgId} and id=${retained.postedId}`), /posted|immutable|delete/i);
      await db.execute(sql`set constraints all deferred`);
      await deleteRetiredTenantRows(await loadCatalog(), targetOrg.orgId);
      assert.equal((await db.execute(sql`select id from orgs where id=${targetOrg.orgId}`)).rows.length, 0);
      throw new Error("Roll back the complete native target deletion before commit");
    }), /Roll back the complete native target deletion/);
    await recordTenantRetirementFailure(runId, targetOrg.orgId, plan.digest, "fixture_rollback");
    assert.deepEqual(await fingerprint(targetOrg.orgId), beforeTarget, "all target posted/draft/review/auth rows return after rollback");
    assert.deepEqual(await fingerprint(retainedOrg.orgId), beforeRetained);
    assert.equal((await tenantRetirementStatus(runId)).targets[0]!.state, "quarantined");
    await releaseTenantRetirement({ runId, orgId: targetOrg.orgId, planDigest: plan.digest, actorId: anchorActor, reason: "Release the intact company after proving target rollback" });
    active = undefined;
    assert.ok((await tenantRetirementStatus(runId)).events.some(event => event.kind === "quarantine_released" && event.detail.actorId === anchorActor), "release retains its actor and reason outside the target");
    await withOrgContext(targetOrg.orgId, () => createScriptJournal(targetOrg.orgId, target.actorId, {
      documentDate: targetOrg.date, subsidiaryId: targetOrg.subsidiaryId, memo: "Native draft creation works after release",
      lines: [{ accountId: targetOrg.accounts.bank, amount: "10.00" }, { accountId: targetOrg.accounts.adjustment, amount: "-10.00" }],
    }, { post: false, allowedSubsidiaryIds: null }));
    const fresh = await planFor([targetOrg.orgId]);
    const freshRun = randomUUID();
    await admitSampleRetirement({ plan: fresh, runId: freshRun, actorId: anchorActor, recovery: recovery() });
    active = { runId: freshRun, plan: fresh };
    const completed = await executeSampleRetirement({ runId: freshRun, orgId: targetOrg.orgId, planDigest: fresh.digest });
    assert.equal(completed.targets[0]!.state, "deleted");
    assert.deepEqual(await fingerprint(retainedOrg.orgId), beforeRetained, "successful retirement retains every protected row, not just ledger totals");
    const receipt = completed.targets[0]!.receipt as { retainedBefore: Record<string, string>; retainedAfter: Record<string, string>; administrativeDeltas: unknown; storageManifestDigest: string };
    assert.deepEqual(receipt.retainedAfter, receipt.retainedBefore);
    assert.ok(receipt.administrativeDeltas && receipt.storageManifestDigest);
    assert.deepEqual(await executeSampleRetirement({ runId: freshRun, orgId: targetOrg.orgId, planDigest: fresh.digest }), completed, "a completed target is a durable replay with no second deletion");
    await assert.rejects(releaseTenantRetirement({ runId: freshRun, orgId: targetOrg.orgId, planDigest: fresh.digest, actorId: anchorActor, reason: "Cannot release a deleted company" }), error => /existing quarantined target/.test(nativeMessage(error)));
    active = undefined;
  } finally {
    if (connected) await runtime.end();
    if (active && (await tenantRetirementStatus(active.runId)).targets.some(target => target.tenant_id === targetOrg.orgId && target.state === "quarantined")) {
      await releaseTenantRetirement({ runId: active.runId, orgId: targetOrg.orgId, planDigest: active.plan.digest, actorId: anchorActor, reason: "Release the intact fixture before reviewed native cleanup" });
    }
    const remaining = await withMaintenanceTransaction(null, async () => (await db.execute<{ id: string }>(sql`
      select id from orgs where id in (${targetOrg.orgId}::uuid,${retainedOrg.orgId}::uuid) order by id`)).rows.map(row => row.id));
    if (remaining.length) {
      const cleanup = await planFor(remaining);
      const cleanupRun = randomUUID();
      await admitSampleRetirement({ plan: cleanup, runId: cleanupRun, actorId: anchorActor, recovery: recovery() });
      for (const orgId of remaining) await executeSampleRetirement({ runId: cleanupRun, orgId, planDigest: cleanup.digest });
    }
    await withBypass(() => dropScratchOrg(anchor.orgId));
  }
});
