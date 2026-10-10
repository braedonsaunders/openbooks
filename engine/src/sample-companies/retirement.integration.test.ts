import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { db, withBypass, withMaintenanceTransaction, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { publishOperatingProfile, readPinnedOperatingProfile, saveOperatingProfileScope } from "../organization/operating-profiles.ts";
import { OPERATING_PRESETS } from "../organization/operating-profile-model.ts";
import { createProject } from "../projects/project-create.ts";
import { seedRolesForOrg } from "../provisioning/seed-roles.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { submitForApproval } from "../flows/submit.ts";
import { decideGate } from "../flows/gates.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, seedApprovalFlow, seedDraftDocument, type ScratchOrg } from "../testing/fixtures.ts";
import { loadCatalog } from "../sandbox/catalog.ts";
import { beginTenantRetirement, recordTenantRetirementFailure, releaseTenantRetirement, tenantRetirementStatus } from "../organization/tenant-retirement.ts";
import { sampleRetirementPlan } from "./retirement-plan.ts";
import { admitSampleRetirement, executeSampleRetirement } from "./retirement.ts";
import { deleteRetiredTenantRows, retirementDeletionOrder, type RetirementForeignKey, retirementFingerprint, retirementPredicate, RETIREMENT_AUTH_TABLES, retirementSharedDependencies, retirementOutstandingWork } from "./retirement-data.ts";
import { retirementDigest, type RetirementDatabaseIdentity } from "./retirement-contract.ts";
import { drainSampleFixtureFlowEmails, retireSampleFixtureCompanies } from "./retirement-test-fixtures.ts";

installEngineSeams();
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
type Plan = Awaited<ReturnType<typeof sampleRetirementPlan>>;
type Evidence = { org: ScratchOrg; actorId: string; postedId: string; draftId: string; gateId: string; sessionId: string; aiRunId: string; profileId: string; profileVersionId: string };
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
  // Authored historical dependency fixtures exercise native FK actions only;
  // no detector, model provider or external job is invoked by this caller.
  const aiRunId = randomUUID(), workItemId = randomUUID();
  await withOrgContext(org.orgId, async () => {
    await db.execute(sql`insert into ai_agent_runs(id,org_id,agent_key,trigger,status,detector_version,finished_at,initiated_by)
      values(${aiRunId},${org.orgId},'accounting','manual','completed','retirement-fixture',now(),${actorId})`);
    await db.execute(sql`insert into ai_work_items(id,org_id,agent_key,finding_type,detector_version,fingerprint,severity,last_detected_run_id,created_by,updated_by)
      values(${workItemId},${org.orgId},'accounting','retirement_dependency','retirement-fixture',${`retirement:${org.orgId}`},'info',${aiRunId},${actorId},${actorId})`);
    await db.execute(sql`insert into ai_work_item_evidence(org_id,work_item_id,kind,source_type,source_id,data)
      values(${org.orgId},${workItemId},'document','document',${draft.id},'{"fixture":"linked native dependency"}'::jsonb)`);
  });
  const preset = OPERATING_PRESETS.find(profile => profile.key === "shop_jobs")!;
  const profileId = randomUUID();
  const firstProfile = await withOrgTransaction(org.orgId, () => publishOperatingProfile(db, org.orgId, actorId, {
    id: profileId, code: "recovery_shop", name: "Shop work", definition: preset.definition,
    expectedVersion: 0, reason: "Preserve the workflow version used by existing customer work",
  }));
  await withOrgTransaction(org.orgId, () => saveOperatingProfileScope(db, org.orgId, actorId, {
    id: randomUUID(), departmentId: null, family: "project", profileIds: [profileId], defaultProfileId: profileId,
    expectedRevision: 0, reason: "Use the published shop workflow for new customer work",
  }));
  const projectId = randomUUID();
  await createProject({ orgId: org.orgId, actorId, allowedSubsidiaryIds: null }, projectId, {
    name: "Customer work with a pinned workflow", subsidiaryId: org.subsidiaryId,
  });
  const revised = { ...preset.definition, terminology: { singular: "Shop job", plural: "Shop jobs" } };
  await withOrgTransaction(org.orgId, () => publishOperatingProfile(db, org.orgId, actorId, {
    id: profileId, code: "recovery_shop", name: "Shop work", definition: revised,
    expectedVersion: 1, reason: "Improve names for future work while retaining prior evidence",
  }));
  await withOrgTransaction(org.orgId, async () => {
    assert.deepEqual(await readPinnedOperatingProfile(db, org.orgId, firstProfile.versionId, "project"), preset.definition);
    assert.equal((await db.execute<{ versionId: string }>(sql`select operating_profile_version_id as "versionId"
      from projects where org_id=${org.orgId} and id=${projectId}`)).rows[0]?.versionId, firstProfile.versionId);
  });
  for (const command of [
    () => db.execute(sql`update operating_profile_versions set reason='Forbidden historical rewrite' where org_id=${org.orgId} and id=${firstProfile.versionId}`),
    () => db.execute(sql`delete from operating_profile_versions where org_id=${org.orgId} and id=${firstProfile.versionId}`),
  ]) await assert.rejects(withOrgTransaction(org.orgId, command), error => /immutable/.test(nativeMessage(error)));
  const outstanding = await withMaintenanceTransaction(null, () => retirementOutstandingWork([org.orgId]));
  assert.equal(outstanding.find(row => row.table === "scheduler_outbox")?.count, "2", "native pending notices block retirement before their delivery lifecycle settles");
  assert.equal(await drainSampleFixtureFlowEmails(org.orgId), 2, "native gate and decision notices settle through the mocked queue boundary");
  assert.equal((await withMaintenanceTransaction(null, () => retirementOutstandingWork([org.orgId]))).some(row => row.table === "scheduler_outbox"), false);
  return { org, actorId, postedId: posted.id, draftId: draft.id, gateId, sessionId, aiRunId, profileId, profileVersionId: firstProfile.versionId };
}
async function planFor(retireIds: string[]): Promise<Plan> {
  const { database, live } = await withMaintenanceTransaction(null, async () => ({
    database: (await db.execute<RetirementDatabaseIdentity & Record<string, unknown>>(sql`select current_database() as database,inet_server_addr()::text as "serverAddress",
      inet_server_port() as "serverPort",current_setting('cluster_name') as "clusterName"`)).rows[0]!,
    live: (await db.execute<{ id: string }>(sql`select id from orgs order by id`)).rows.map(row => row.id),
  }));
  const plan = await sampleRetirementPlan({ version: 1, database, retainOrgIds: live.filter(id => !retireIds.includes(id)), retireOrgIds: retireIds,
    reason: "Retire only the exact disposable companies owned by this native lifecycle fixture" });
  assert.deepEqual(plan.blockers, [], "the matching native catalog and quiescent fixture must admit retirement");
  assert.equal(plan.admissible, true);
  return plan;
}
async function assertInitializedFence(orgId: string) {
  const result = await db.execute<{ state: string; initialized: number }>(sql`
    select f.state,(select count(*)::int from payroll_compensation_configuration where org_id=${orgId}) as initialized
    from tenant_retirement.fences f where f.tenant_id=${orgId}`);
  assert.deepEqual(result.rows, [{ state: "active", initialized: 1 }], "the new company fence permits its native AFTER INSERT child initializer");
}
async function fingerprint(orgId: string, assertSequentialParity = false) {
  return withMaintenanceTransaction(null, async () => {
    const catalog = await loadCatalog();
    const actual = await retirementFingerprint(catalog, orgId);
    if (assertSequentialParity) {
      // Compare complete native evidence against the original one-table query
      // in the same snapshot, including empty tables and global auth children.
      const owned = [...catalog.tenantTables.filter(table => table.name !== "orgs"), { name: "orgs", hasOrgId: false },
        ...RETIREMENT_AUTH_TABLES.map(name => ({ name, hasOrgId: false }))].sort((a, b) => a.name.localeCompare(b.name));
      assert.ok(owned.length > 64, "the native catalog exercises several bounded query groups");
      const tables: typeof actual.tables = [];
      for (const table of owned) {
        const result = await db.execute<{ count: string; digest: string }>(sql`
          select count(*)::text as count,encode(digest(coalesce(string_agg(row_hash,E'\n' order by row_hash),''),'sha256'),'hex') as digest
          from (select encode(digest(to_jsonb(owned_row)::text,'sha256'),'hex') as row_hash
            from public.${sql.identifier(table.name)} owned_row where ${retirementPredicate(table, orgId)}) owned_rows`);
        assert.equal(result.rows.length, 1);
        tables.push({ table: table.name, ...result.rows[0]! });
      }
      assert.ok(tables.some(row => row.count === "0"), "empty native tables remain part of the preservation digest");
      assert.deepEqual(actual, { digest: retirementDigest(tables), tables }, "batching preserves every table count, full-content hash, output position and aggregate digest");
    }
    return actual;
  }, { isolationLevel: "REPEATABLE READ" });
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
async function runtimeForgery(runtime: Client, orgId: string, runId: string, digest: string, postedId: string, profileVersionId: string) {
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
  await run(() => assert.rejects(runtime.query("select tenant_retirement.openbooks_retirement_row_org('auth_sessions',jsonb_build_object('user_id',$1::uuid))", [orgId]), /permission denied/i));
  await run(() => assert.rejects(runtime.query("insert into tenant_retirement.delete_authorities(transaction_id,backend_pid,tenant_id,run_id,login_name) values(txid_current(),pg_backend_pid(),$1,$2,session_user)", [orgId, runId]), /permission denied/i));
  await run(() => assert.rejects(runtime.query("delete from documents where org_id=$1 and id=$2", [orgId, postedId])));
  await run(() => assert.rejects(runtime.query("delete from operating_profile_versions where org_id=$1 and id=$2", [orgId, profileVersionId]), /immutable|retirement fence/i));
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
    await withMaintenanceTransaction(null, () => assertInitializedFence(anchor.orgId));
    const rolledBackOrgId = randomUUID();
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      // The same minimal native organization fixture as createScratchOrg,
      // kept inside this transaction to prove parent/child/fence rollback.
      await db.execute(sql`insert into orgs(id,name,base_currency,country,settings,env_kind)
        values(${rolledBackOrgId},'Rollback initialization fixture','CAD','CA','{}'::jsonb,'production')`);
      await assertInitializedFence(rolledBackOrgId);
      throw new Error("Roll back organization and native initializers");
    }), /Roll back organization and native initializers/);
    await withMaintenanceTransaction(null, async () => {
      const remaining = await db.execute<{ orgs: number; fences: number; configuration: number }>(sql`
        select (select count(*)::int from orgs where id=${rolledBackOrgId}) as orgs,
          (select count(*)::int from tenant_retirement.fences where tenant_id=${rolledBackOrgId}) as fences,
          (select count(*)::int from payroll_compensation_configuration where org_id=${rolledBackOrgId}) as configuration`);
      assert.deepEqual(remaining.rows, [{ orgs: 0, fences: 0, configuration: 0 }], "failed organization creation leaves no parent, child or retirement fence");
    });
    await assert.rejects(withMaintenanceTransaction(null, () => db.execute(sql`
      select tenant_retirement.openbooks_assert_tenant_available(${rolledBackOrgId}::uuid)`)), error => /retirement fence is missing/.test(nativeMessage(error)));
    await runtime.connect(); connected = true;
    const retained = await createEvidence(retainedOrg);
    const target = await createEvidence(targetOrg);
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await db.execute(sql`insert into app_listings(publisher_org_id,key,name,version,created_by,updated_by)
        values(${retainedOrg.orgId},${`retained-${randomUUID()}`},'Retained publisher fixture','1.0.0',${retained.actorId},${retained.actorId})`);
      assert.deepEqual(await retirementSharedDependencies([targetOrg.orgId]), [], "unrelated shared publications do not block a different company");
      for (const active of [true, false]) await db.execute(sql`
        insert into app_listings(publisher_org_id,key,name,version,is_active,created_by,updated_by)
        values(${targetOrg.orgId},${`target-${randomUUID()}`},'Publisher dependency fixture','1.0.0',${active},${target.actorId},${target.actorId})`);
      assert.deepEqual(await retirementSharedDependencies([targetOrg.orgId]), [{ table: "app_listings", orgId: targetOrg.orgId, count: "2" }], "active and withdrawn publications both retain their publisher");
      throw new Error("Roll back shared publication fixtures without deleting shared history");
    }), /Roll back shared publication fixtures/);
    const beforeRetained = await fingerprint(retainedOrg.orgId);
    const beforeTarget = await fingerprint(targetOrg.orgId, true);
    for (const evidence of [beforeRetained, beforeTarget]) {
      for (const table of ["documents", "document_lines", "journal_entries", "journal_lines", "flow_gates", "audit_log", "auth_sessions", "role_assignments", "ai_agent_runs", "ai_work_items", "ai_work_item_evidence", "operating_profiles", "operating_profile_versions", "operating_profile_scopes", "projects"])
        assert.ok(BigInt(evidence.tables.find(row => row.table === table)!.count) > 0n, `the preservation proof includes real ${table} evidence`);
    }
    const plan = await planFor([targetOrg.orgId]);
    const runId = randomUUID();
    await assert.rejects(admitSampleRetirement({ plan, runId, actorId: anchorActor, recovery: {} }), /Recovery evidence/);
    await runtimeForgery(runtime, targetOrg.orgId, runId, plan.digest, target.postedId, target.profileVersionId);
    await assert.rejects(admitSampleRetirement({ plan, runId, actorId: anchorActor, recovery: { ...recovery(), verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() } }), error => /verified within 24 hours/.test(nativeMessage(error)));
    await admitSampleRetirement({ plan, runId, actorId: anchorActor, recovery: recovery() });
    active = { runId, plan };
    assert.equal((await tenantRetirementStatus(runId)).targets[0]!.state, "quarantined");
    assert.deepEqual(await fingerprint(targetOrg.orgId), beforeTarget, "quarantine changes no target business/auth rows");
    await assert.rejects(withOrgTransaction(targetOrg.orgId, () => db.execute(sql`update documents set memo='Disallowed while quarantined' where org_id=${targetOrg.orgId} and id=${target.draftId}`)), error => /retirement fence/.test(nativeMessage(error)));
    await runtimeForgery(runtime, targetOrg.orgId, runId, plan.digest, target.postedId, target.profileVersionId);
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
      await refusedStatement(() => db.execute(sql`insert into app_listings(publisher_org_id,key,name,version,created_by,updated_by)
        values(${targetOrg.orgId},${`quarantined-${randomUUID()}`},'Forbidden publication','1.0.0',${target.actorId},${target.actorId})`), /retirement fence/);
      await refusedStatement(() => db.execute(sql`delete from documents where org_id=${retainedOrg.orgId} and id=${retained.postedId}`), /posted|immutable|delete/i);
      await refusedStatement(() => db.execute(sql`delete from ai_agent_runs where org_id=${targetOrg.orgId} and id=${target.aiRunId}`), /retirement fence/);
      await refusedStatement(() => db.execute(sql`update operating_profile_versions set reason='DELETE authority cannot rewrite published versions'
        where org_id=${targetOrg.orgId} and id=${target.profileVersionId}`), /immutable|retirement fence/);
      await refusedStatement(() => db.execute(sql`update operating_profiles set name='Forbidden quarantined configuration'
        where org_id=${targetOrg.orgId} and id=${target.profileId}`), /retirement fence/);
      await refusedStatement(() => db.execute(sql`insert into operating_profiles(org_id,code,name,family)
        values(${targetOrg.orgId},'forbidden_workflow','Forbidden workflow','project')`), /retirement fence/);
      await refusedStatement(() => db.execute(sql`delete from operating_profile_versions
        where org_id=${retainedOrg.orgId} and id=${retained.profileVersionId}`), /immutable/);
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
    const receipt = completed.targets[0]!.receipt as { retainedBefore: Record<string, string>; retainedAfter: Record<string, string>; administrativeDeltas: unknown; storageManifestDigest: string; explicitlyDeletedRows: Record<string, string> };
    assert.deepEqual(receipt.retainedAfter, receipt.retainedBefore);
    for (const table of ["ai_work_item_evidence", "ai_work_items", "ai_agent_runs"]) {
      assert.equal(receipt.explicitlyDeletedRows[table], "1", `${table} is removed explicitly, without cascade deletion or SET NULL updates`);
    }
    assert.equal(receipt.explicitlyDeletedRows.operating_profiles, "1");
    assert.equal(receipt.explicitlyDeletedRows.operating_profile_versions, "2", "both published versions are removed only through exact-target DELETE authority");
    assert.equal(receipt.explicitlyDeletedRows.operating_profile_scopes, "1");
    assert.equal(receipt.explicitlyDeletedRows.projects, "1", "native work referencing the historical version is deleted before its parent evidence");
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
      assert.equal(await retireSampleFixtureCompanies(anchor.orgId, remaining), true);
    }
    await withBypass(() => dropScratchOrg(anchor.orgId));
  }
});


test("retirement ordering includes referential actions and preserves immediate dependencies inside the deferred tail", () => {
  const fk = (table: string, referencedTable: string, deleteAction: string, deferrable = true): RetirementForeignKey =>
    ({ table, referencedTable, deleteAction, deferrable, columns: ["parent_id"], referencedColumns: ["id"] });
  const aiOrder = retirementDeletionOrder(["ai_agent_runs", "ai_work_items", "ai_work_item_evidence", "users"], [
    fk("ai_work_items", "ai_agent_runs", "n"), fk("ai_work_item_evidence", "ai_work_items", "c"), fk("ai_agent_runs", "users", "n"),
  ]);
  assert.deepEqual(aiOrder, ["ai_work_item_evidence", "ai_work_items", "ai_agent_runs", "users"]);
  const tailOrder = retirementDeletionOrder(["accounts", "documents", "journal_entries", "journal_lines"], [
    fk("documents", "journal_entries", "a"), fk("journal_entries", "documents", "c"),
    fk("journal_lines", "journal_entries", "c"), fk("documents", "accounts", "r"),
  ]);
  assert.deepEqual(tailOrder, ["journal_lines", "journal_entries", "documents", "accounts"],
    "a deferred backlink does not erase CASCADE or RESTRICT dependencies in the remaining graph");
  const immediateCycle = [fk("first", "second", "n"), fk("second", "first", "n")];
  assert.deepEqual(retirementDeletionOrder(["first", "second"], immediateCycle), ["first", "second"],
    "structural cycles remain for native row-level refusal; no edge is converted into an UPDATE exemption");
});
