import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../engine/src/platform/db.ts";
import { withSimClock } from "../engine/src/platform/clock.ts";
import { DB, setupHarness, withHarness } from "../engine/src/testing/hrm-harness.ts";
import { drainExportQueue, requestExport } from "../engine/src/hrm/documents/dsar.ts";
import { createRetentionRule } from "../engine/src/hrm/recruiting/retention.ts";
import { clearWorkerDuties, registerWorkerDuty, runWorkerDuties } from "../engine/src/scheduling/duties.ts";
import {
  runHrmOrganizationDuty,
  runRetentionDuty,
  runRecruitingRetentionDuty,
  runDsarDuty,
  runReminderDuty,
} from "./worker-entry.mts";

const spec = {
  features: ["hrm", "hrmDocuments", "hrmRecruiting"],
  users: [{ key: "hrId", partyKey: "partyId", name: "Scheduler Subject", handle: "hr_admin", link: true,
    permissions: ["hrm.documents.manage", "hrm.recruiting.manage"] }],
} as const;
const duties = [
  ["hrm-retention-tick", runRetentionDuty],
  ["hrm-candidate-retention", runRecruitingRetentionDuty],
  ["hrm-dsar-exports", runDsarDuty],
  ["hrm-document-reminders", runReminderDuty],
] as const;

async function settings(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const result = await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify(patch)}::jsonb
     where id = ${orgId} returning id
  `);
  assert.equal(result.rows.length, 1);
}

test("HR scans use each tenant's calendar and RLS scope, then restore the caller's scope", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async (west) => {
    await withHarness(() => setupHarness(spec), async (east) => {
      await settings(west.org.orgId, { timeZone: "America/Los_Angeles" });
      await settings(east.org.orgId, { timeZone: "Pacific/Auckland" });
      const days = new Map<string, string>();
      await withSimClock("2026-10-01T00:30:00Z", () => withOrgContext(west.org.orgId, async () => {
        await runHrmOrganizationDuty("calendar-check", "hrmDocuments", async (orgId, today) => {
          const visible = (await db.execute<{ id: string; role: string }>(sql`
            select id, current_user as role from orgs
             where id in (${west.org.orgId}, ${east.org.orgId})
          `)).rows;
          assert.deepEqual(visible.map((row) => row.id), [orgId]);
          assert.equal(visible[0]?.role, "openbooks_app");
          days.set(orgId, today);
        });
        assert.deepEqual((await db.execute<{ id: string }>(sql`
          select id from orgs where id in (${west.org.orgId}, ${east.org.orgId})
        `)).rows.map((row) => row.id), [west.org.orgId]);
      }));
      assert.equal(days.get(west.org.orgId), "2026-09-30");
      assert.equal(days.get(east.org.orgId), "2026-10-01");
      const attempted: string[] = [];
      await assert.rejects(runHrmOrganizationDuty("failure-isolation", "hrmDocuments", async (orgId) => {
        attempted.push(orgId);
        if (attempted.length === 1) throw new Error("required input is unavailable — restore the input before retrying");
      }), /required input is unavailable — restore the input before retrying/);
      assert.equal(attempted.length, 2, "a failure in the first tenant does not stop the next tenant");
      await settings(east.org.orgId, { features: { hrm: false, hrmDocuments: true, hrmRecruiting: true } });
      const seen: string[] = [];
      await runHrmOrganizationDuty("parent-check", "hrmDocuments", async (orgId) => { seen.push(orgId); });
      assert.ok(seen.includes(west.org.orgId));
      assert.ok(!seen.includes(east.org.orgId), "a stored-true child never overrides its disabled parent");
    });
  });
});

test("all four native HR duties work without an ambient tenant and persist their effects", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async (h) => {
    await settings(h.org.orgId, { timeZone: "America/Toronto" });
    const expiredId = randomUUID();
    const reminderId = randomUUID();
    await db.execute(sql`
      insert into hrm_documents (id, org_id, party_id, category_key, title, status, sent_at, expires_at)
      values (${expiredId}, ${h.org.orgId}, ${h.partyId}, 'contract', 'Expired contract', 'sent',
              now() - interval '10 days', now() - interval '1 day'),
             (${reminderId}, ${h.org.orgId}, ${h.partyId}, 'contract', 'Awaiting signature', 'sent',
              now() - interval '10 days', null)
    `);
    await db.execute(sql`
      insert into hrm_document_signers (org_id, document_id, ord, signer_party_id, role, token_hash)
      values (${h.org.orgId}, ${reminderId}, 0, ${h.partyId}, 'employee', ${randomUUID()})
    `);
    const rule = await createRetentionRule({ orgId: h.org.orgId, actorId: h.hrId,
      name: "Inactive prospect retention", basis: "inactivity", retainMonths: 12 });
    const requested = await requestExport({ orgId: h.org.orgId, actorId: h.hrId, partyId: h.partyId });
    clearWorkerDuties();
    try {
      for (const [key, run] of duties) registerWorkerDuty({ key, run });
      assert.deepEqual(await runWorkerDuties(), duties.map(([key]) => ({ key, ok: true })));
      assert.equal((await db.execute<{ status: string }>(sql`
        select status from hrm_documents where org_id = ${h.org.orgId} and id = ${expiredId}
      `)).rows[0]?.status, "expired");
      const run = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_retention_runs where org_id = ${h.org.orgId} and rule_id = ${rule.id}
      `)).rows[0]?.n;
      assert.equal(run, 1);
      const exported = (await db.execute<{ status: string; file_id: string | null; scope: { module: string; status: string; detail?: string }[] }>(sql`
        select status, file_id, scope from hrm_data_subject_exports where org_id = ${h.org.orgId} and id = ${requested.id}
      `)).rows[0];
      assert.equal(exported?.status, "incomplete", "the fixture's documents have no stored file bytes");
      assert.ok(exported.file_id);
      assert.equal(exported.scope.find((entry) => entry.module === "documents")?.status, "incomplete");
      assert.ok(!exported.scope.some((entry) => entry.status === "failed"), JSON.stringify(exported.scope));
      assert.equal((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from notifications
         where org_id = ${h.org.orgId} and user_id = ${h.hrId} and kind = 'hrm.document.reminder'
      `)).rows[0]?.n, 1);
      assert.equal((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_document_events
         where org_id = ${h.org.orgId} and document_id = ${reminderId} and kind = 'reminded'
      `)).rows[0]?.n, 1);
      assert.deepEqual(await runWorkerDuties(), duties.map(([key]) => ({ key, ok: true })));
      assert.equal((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_retention_runs where org_id = ${h.org.orgId} and rule_id = ${rule.id}
      `)).rows[0]?.n, 1, "same-day recruiting runs are durable and idempotent");
      assert.equal((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from hrm_document_events
         where org_id = ${h.org.orgId} and document_id = ${reminderId} and kind = 'reminded'
      `)).rows[0]?.n, 1, "a retry does not deliver another reminder");
    } finally {
      clearWorkerDuties();
    }
  });
});

test("invalid tenant calendars remain named refusals for every duty while healthy tenants continue", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async (bad) => {
    await withHarness(() => setupHarness(spec), async (healthy) => {
      await settings(bad.org.orgId, { timeZone: "Invalid/Business_Zone" });
      const documentId = randomUUID();
      await db.execute(sql`
        insert into hrm_documents (id, org_id, category_key, title, status, expires_at)
        values (${documentId}, ${healthy.org.orgId}, 'contract', 'Due expiry', 'sent', now() - interval '1 day')
      `);
      clearWorkerDuties();
      try {
        for (const [key, run] of duties) registerWorkerDuty({ key, run });
        let siblingRan = false;
        registerWorkerDuty({ key: "healthy-sibling", run: async () => { siblingRan = true; } });
        const summary = await runWorkerDuties();
        for (const [key] of duties) {
          const result = summary.find((item) => item.key === key)!;
          assert.equal(result.ok, false);
          assert.ok(result.error?.includes(bad.org.orgId), "the refusal identifies the affected organization");
          assert.match(result.error!, /Invalid\/Business_Zone.*Company Settings → Organization/);
        }
        assert.ok(siblingRan);
        assert.equal((await db.execute<{ status: string }>(sql`
          select status from hrm_documents where org_id = ${healthy.org.orgId} and id = ${documentId}
        `)).rows[0]?.status, "expired", "a bad organization cannot prevent another tenant's work");
      } finally {
        clearWorkerDuties();
      }
    });
  });
});

test("a retention refusal survives the org claim and reaches scheduler health with its remedy", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async (h) => {
    await settings(h.org.orgId, { hrmDocuments: { retentionGraceDays: -1 } });
    clearWorkerDuties();
    try {
      registerWorkerDuty({ key: "hrm-retention-tick", run: runRetentionDuty });
      const [failed] = await runWorkerDuties();
      assert.equal(failed?.ok, false);
      assert.ok(failed.error?.includes(h.org.orgId));
      assert.match(failed.error!, /retentionGraceDays is misconfigured.*set whole days at zero or above/);
      await settings(h.org.orgId, { hrmDocuments: { retentionGraceDays: 0 } });
      assert.deepEqual(await runWorkerDuties(), [{ key: "hrm-retention-tick", ok: true }],
        "a refusal releases the pinned advisory lock and the tenant can recover on the next tick");
    } finally {
      clearWorkerDuties();
    }
  });
});

test("failed subject-access builds retain refusal evidence, continue the queue, and refuse success", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async (h) => {
    const first = await requestExport({ orgId: h.org.orgId, actorId: h.hrId, partyId: h.partyId });
    const second = await requestExport({ orgId: h.org.orgId, actorId: h.hrId, partyId: h.partyId });
    // A feature disable after requests were queued must still fence the
    // native build; its refusal reaches both the requester and scheduler.
    await settings(h.org.orgId, { features: { hrm: true, hrmDocuments: false, hrmRecruiting: true } });
    await assert.rejects(drainExportQueue(h.org.orgId), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.message.includes(first.id));
      assert.ok(error.message.includes(second.id));
      assert.match(error.message, /Company Settings/);
      return true;
    });
    const failed = (await db.execute<{ status: string; error: string; file_id: string | null }>(sql`
      select status, error, file_id from hrm_data_subject_exports
       where org_id = ${h.org.orgId} and id in (${first.id}, ${second.id})
    `)).rows;
    assert.equal(failed.length, 2);
    for (const row of failed) {
      assert.equal(row.status, "failed");
      assert.equal(row.file_id, null);
      assert.match(row.error, /Company Settings/);
    }
  });
});

test("a zero-row recruiting run refuses with its rule and remedy while the next rule still runs", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(spec), async (h) => {
    const blocked = await createRetentionRule({ orgId: h.org.orgId, actorId: h.hrId,
      name: "Unavailable run evidence", basis: "inactivity", retainMonths: 12 });
    const healthy = await createRetentionRule({ orgId: h.org.orgId, actorId: h.hrId,
      name: "Independent retention obligation", basis: "inactivity", retainMonths: 12 });
    assert.ok(blocked.id < healthy.id, "the failing rule is evaluated first");
    await db.execute(sql`
      create function hrm_scheduler_test_refuse_run() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from hrm_retention_rules where id = new.rule_id and name = 'Unavailable run evidence') then
          return null;
        end if;
        return new;
      end $$
    `);
    try {
      await db.execute(sql`
        create trigger hrm_scheduler_test_refuse_run before insert on hrm_retention_runs
        for each row execute function hrm_scheduler_test_refuse_run()
      `);
      await assert.rejects(runRecruitingRetentionDuty(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.message.includes(h.org.orgId));
        assert.ok(error.message.includes(blocked.id));
        assert.match(error.message, /retention run was not recorded.*no row was written; retry the request/);
        return true;
      });
      const runs = (await db.execute<{ rule_id: string }>(sql`
        select rule_id from hrm_retention_runs where org_id = ${h.org.orgId}
      `)).rows;
      assert.deepEqual(runs.map((row) => row.rule_id), [healthy.id]);
    } finally {
      await db.execute(sql`drop trigger if exists hrm_scheduler_test_refuse_run on hrm_retention_runs`);
      await db.execute(sql`drop function hrm_scheduler_test_refuse_run()`);
    }
  });
});
