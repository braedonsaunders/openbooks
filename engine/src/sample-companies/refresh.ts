import { snapshotSampleRecords, assertSampleRecordsPreserved, assertSampleSettingsPreserved } from "./preservation.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { SAMPLE_COMPANY_BY_INDUSTRY } from "./catalog.ts";
import { DEMO_DATA_VERSION, installDemoScenarios, verifyDemoScenarios, sampleScenarioPreservationTables } from "./install-scenarios.ts";
import { verifyAndRegisterDemoAccounting } from "./accounting.ts";
import { reconcileDocumentSequences } from "../records/numbering.ts";
import { sampleSourceManifest } from "./manifest.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

export interface SampleRefreshTarget {
  orgId: string; name: string; industryKey: string; kind: "master" | "member";
  installedVersion: number; ownerUserId: string | null; templateOrgId: string | null;
}

/** Explicit inventory includes every prepared master and every ready exploration copy. */
export async function sampleRefreshPlan(industryKey?: string): Promise<{ version: number; definitionDigest: string; digest: string; targets: SampleRefreshTarget[]; preserved: Array<{ orgId: string; name: string; reason: string }>; excluded: Array<{ orgId: string; name: string; reason: string }> }> {
  if (industryKey && !SAMPLE_COMPANY_BY_INDUSTRY.has(industryKey)) throw new SampleCompanyError(`Unknown sample industry: ${industryKey}`);
  const candidates = await withBypassContext(() => db.execute<{
    id: string; name: string; settings: Record<string, unknown>; env: string;
  }>(sql`select id,name,settings,env_kind as env from orgs
    where settings ? 'sampleTemplate' or settings ? 'sampleCompany' order by id`));
  const targets: SampleRefreshTarget[] = [];
  const preserved: Array<{ orgId: string; name: string; reason: string }> = [];
  const excluded: Array<{ orgId: string; name: string; reason: string }> = [];
  for (const row of candidates.rows) {
    const member = row.settings.sampleCompany as Record<string, unknown> | undefined;
    const master = row.settings.sampleTemplate as Record<string, unknown> | undefined;
    const data = row.settings.demoData as Record<string, unknown> | undefined;
    const profileId = member?.profileId ?? master?.profileId;
    const profile = [...SAMPLE_COMPANY_BY_INDUSTRY.values()].find(p => p.profileId === profileId);
    if (industryKey && profile?.industryKey !== industryKey) continue;
    if (!member && (master?.enabled === false || (row.settings.sampleTemplateOracle as { status?: string } | undefined)?.status === "retired")) {
      preserved.push({ orgId: row.id, name: row.name, reason: "Registered source is disabled; retain its records and access without refreshing or requalifying the archive." }); continue;
    }
    if (!profile) { excluded.push({ orgId: row.id, name: row.name, reason: "Unrecognized sample profile; review native provenance before refreshing." }); continue; }
    if (member && (row.env !== "preview" || member.immutableSyntheticSource !== true
      || (member.provisioningStage != null && member.provisioningStage !== "ready"))) {
      excluded.push({ orgId: row.id, name: row.name, reason: "Exploration company is incomplete or lacks preview/source protection; resume its native provisioning before refresh." }); continue;
    }
    if (!member && row.settings.simHarness !== true) {
      excluded.push({ orgId: row.id, name: row.name, reason: "Master is not an identified synthetic simulator company; validate source provenance before refresh." }); continue;
    }
    targets.push({ orgId: row.id, name: row.name, industryKey: profile.industryKey,
      kind: member ? "member" : "master", installedVersion: Number(data?.version ?? 0),
      ownerUserId: typeof member?.ownerUserId === "string" ? member.ownerUserId : null,
      templateOrgId: typeof member?.templateOrgId === "string" ? member.templateOrgId : null });
  }
  targets.sort((a,b) => a.kind.localeCompare(b.kind) || a.industryKey.localeCompare(b.industryKey) || a.orgId.localeCompare(b.orgId));
  // Identity membership is fixed; installed versions can advance on a resumable retry.
  const definitionDigest = createHash("sha256").update(JSON.stringify({ version: DEMO_DATA_VERSION, manifest: sampleSourceManifest() })).digest("hex");
  const digest = createHash("sha256").update(JSON.stringify({ definitionDigest, targets: targets.map(({ installedVersion: _version, ...target }) => target), preserved, excluded })).digest("hex");
  return { version: DEMO_DATA_VERSION, definitionDigest, digest, targets, preserved, excluded };
}

/** Per-company transactions preserve history; successful tenants are reusable after interruption. */
export async function refreshSampleCompany(orgId: string, industryKey: string): Promise<{ orgId: string; industryKey: string; version: number; kind: "master" | "member"; preservedEntries: number; historyDigest: string; preservedRecords: number; preservationDigest: string }> {
  return withOrgTransaction(orgId, async () => {
    const row = (await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id=${orgId} for update`)).rows[0];
    if (!row) throw new SampleCompanyError("The refresh target no longer exists; inspect the native sample inventory.");
    const member = !!row.settings.sampleCompany;
    const recordsBefore = await snapshotSampleRecords(orgId, await sampleScenarioPreservationTables(orgId, industryKey));
    const before = (await db.execute<{ id: string; digest: string }>(sql`
      select e.id,md5((to_jsonb(e)-'updated_at'-'updated_by')::text || coalesce((select jsonb_agg(to_jsonb(l) order by l.id)::text from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id),'[]')) as digest
      from journal_entries e where e.org_id=${orgId} and e.status in ('posted','reversed') order by e.id
    `)).rows;
    await installDemoScenarios(orgId, industryKey);
    await reconcileDocumentSequences(db, orgId);
    const after = (await db.execute<{ id: string; digest: string }>(sql`
      select e.id,md5((to_jsonb(e)-'updated_at'-'updated_by')::text || coalesce((select jsonb_agg(to_jsonb(l) order by l.id)::text from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id),'[]')) as digest
      from journal_entries e where e.org_id=${orgId} and e.status in ('posted','reversed') order by e.id
    `)).rows;
    const preserved = new Map(after.map(entry => [entry.id, entry.digest]));
    if (before.some(entry => preserved.get(entry.id) !== entry.digest)) throw new SampleCompanyError("Refresh changed existing posted accounting evidence; the company upgrade has been rolled back.");
    const result = await verifyDemoScenarios(orgId, industryKey);
    if (!result.ready) throw new SampleCompanyError(`Refresh did not meet native readiness: ${result.missing.join(", ")}`);
    const historyDigest = createHash("sha256").update(JSON.stringify(before)).digest("hex");
    const current = (await db.execute<{ settings: Record<string, unknown>; actorId: string }>(sql`select settings,settings->'demoData'->>'installedBy' as "actorId" from orgs where id=${orgId}`)).rows[0]!;
    const preservation = await assertSampleRecordsPreserved(orgId, recordsBefore);
    assertSampleSettingsPreserved(row.settings, current.settings, industryKey);
    const previousProof = (current.settings.demoData as Record<string, unknown>).refreshVerification;
    const proof = { version: DEMO_DATA_VERSION, status: "passed", preservedEntries: before.length, historyDigest, preservedRecords: preservation.records, preservationDigest: preservation.digest, protectedTables: [...recordsBefore.keys()], verifiedAt: new Date().toISOString(), verifiedBy: current.actorId };
    if ((previousProof as { historyDigest?: string } | undefined)?.historyDigest !== historyDigest || (previousProof as { preservationDigest?: string } | undefined)?.preservationDigest !== preservation.digest) {
      const updated = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{demoData,refreshVerification}',${JSON.stringify(proof)}::jsonb),updated_by=${current.actorId},updated_at=now() where id=${orgId} returning id`);
      if (updated.rows.length !== 1) throw new SampleCompanyError("The company disappeared while recording preserving refresh evidence.");
      await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values(${orgId},'orgs',${orgId},'update',${current.actorId},${JSON.stringify({ reason: "Verify additive sample upgrade preserves existing records, drafts, approvals, configuration and posted history", before: previousProof ?? null, after: proof })}::jsonb)`);
    }
    return { orgId, industryKey, version: DEMO_DATA_VERSION, kind: member ? "member" : "master", preservedEntries: before.length, historyDigest, preservedRecords: preservation.records, preservationDigest: preservation.digest };
  });
}

export async function refreshAllSampleCompanies(input: { digest: string; industryKey?: string; onResult?: (result: unknown) => void }): Promise<void> {
  const plan = await sampleRefreshPlan(input.industryKey);
  if (input.digest !== plan.digest) throw new SampleCompanyError("The sample population changed. Review refresh-plan and pass its current digest before refreshing.");
  if (plan.excluded.length) throw new SampleCompanyError(`Sample refresh has unresolved targets: ${plan.excluded.map(target => `${target.orgId}: ${target.reason}`).join("; ")}`);
  for (const target of plan.targets) {
    const result = await refreshSampleCompany(target.orgId, target.industryKey);
    if (target.kind === "master") await verifyAndRegisterDemoAccounting(target.orgId);
    input.onResult?.(result);
  }
}
