import { verifySampleOperatingHistory } from "./readiness.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction } from "../platform/db.ts";
import { runScenario } from "../golden/scenario.ts";
import { DEMO_DATA_VERSION } from "./install-scenarios.ts";
import { SampleCompanyPreconditionError } from "./provisioning-failures.ts";

/** A source must reconcile, including inherited history, before it is advertised. */
export async function verifyAndRegisterDemoAccounting(orgId: string): Promise<{ fingerprint: string; checks: number }> {
  return withMaintenanceTransaction(orgId, async () => {
    const row = (await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id=${orgId} for update`)).rows[0];
    if (row?.settings.simHarness !== true || row.settings.sampleCompany || (row.settings.demoData as { version?: number } | undefined)?.version !== DEMO_DATA_VERSION) {
      throw new SampleCompanyPreconditionError("Accounting verification requires an installed synthetic master demo; prepare its native scenarios first.");
    }
    const industryKey = (row.settings.demoData as { industryKey: string }).industryKey;
    const historyGaps = await verifySampleOperatingHistory(orgId, industryKey);
    if (historyGaps.length) throw new SampleCompanyPreconditionError(`Sample operating history is incomplete: ${historyGaps.join("; ")}. Populate the named native workflows before certifying this master.`);
    const checkpoint = await runScenario(orgId, { at: new Date().toISOString() });
    if (!checkpoint.pass) {
      throw new SampleCompanyPreconditionError(`Demo accounting checks failed: ${checkpoint.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.detail}`).join("; ")}. Reconcile the named source records through their normal accounting workflows before preparing this industry again.`);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({
      counts: checkpoint.counts, cutoff: checkpoint.cutoff, trialBalance: checkpoint.trialBalance,
      controlTieOut: checkpoint.controlTieOut, inventoryTieOut: checkpoint.inventoryTieOut, checks: checkpoint.checks,
    })).digest("hex");

    const data = row.settings.demoData as Record<string, unknown>;
    const previous = data.accountingVerification as Record<string, unknown> | undefined;
    if (previous?.status === "passed" && previous.version === DEMO_DATA_VERSION && previous.fingerprint === fingerprint) return { fingerprint, checks: checkpoint.checks.length };
    const actor = (await db.execute<{ id: string }>(sql`
      select u.id from users u join role_assignments a on a.org_id=u.org_id and a.user_id=u.id
      join app_roles r on r.org_id=a.org_id and r.id=a.role_id
      where u.org_id=${orgId} and u.is_active and r.key='admin' order by u.created_at,u.id limit 1
    `)).rows[0];
    if (!actor) throw new SampleCompanyPreconditionError("The demo needs an active tenant administrator to record its accounting verification.");
    const verification = { version: DEMO_DATA_VERSION, status: "passed", fingerprint, verifiedAt: new Date().toISOString(), verifiedBy: actor.id, cutoff: checkpoint.cutoff, counts: checkpoint.counts, checks: checkpoint.checks.length };
    const settings = { ...row.settings, demoData: { ...data, accountingVerification: verification } };
    const updated = await db.execute(sql`update orgs set settings=${JSON.stringify(settings)}::jsonb,updated_by=${actor.id},updated_at=now() where id=${orgId} returning id`);
    if (updated.rows.length !== 1) throw new SampleCompanyPreconditionError("The master demo disappeared while recording accounting verification.");
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values(${orgId},'orgs',${orgId},'update',${actor.id},${JSON.stringify({reason:"Verify master demonstration accounting before making it available as a source",before:previous??null,after:verification})}::jsonb)`);
    return { fingerprint, checks: checkpoint.checks.length };
  }, { isolationLevel: "REPEATABLE READ" });
}
