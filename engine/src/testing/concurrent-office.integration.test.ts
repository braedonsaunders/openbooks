import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./fixtures.ts";
import { postDocument } from "../ledger/posting-document.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const CHILD = fileURLToPath(new URL("./concurrent-office.child.mts", import.meta.url));

type ChildResult = { ok: boolean; result?: unknown; error?: string };

/**
 * Fork two fresh processes running the same scheduler entry point at once.
 * Separate processes mean separate pools, backends, and clocks — a shared
 * in-process pool cannot simulate replica contention.
 */
async function racePair(mode: string, orgId: string, arg: string): Promise<[ChildResult, ChildResult]> {
  const run = (): Promise<ChildResult> =>
    new Promise((resolve) => {
      const child = fork(CHILD, [mode, orgId, arg], {
        execArgv: [
          "--no-concurrent-sparkplug",
          "--no-concurrent-recompilation",
          "--import",
          "tsx",
          "--import",
          "./engine/src/testing/database-bypass.ts",
        ],
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let out = "";
      let err = "";
      let done = false;
      const finish = (value: ChildResult): void => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        resolve(value);
      };
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, error: "child timed out" });
      }, 120_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on("error", (error) => finish({ ok: false, error: error.message }));
      child.on("exit", (code) => {
        try {
          const last = out.trim().split("\n").pop() ?? "";
          finish(JSON.parse(last) as ChildResult);
        } catch {
          finish({ ok: false, error: `child exit ${code}; stdout: ${out.slice(-300)}; stderr: ${err.slice(-500)}` });
        }
      });
    });
  return Promise.all([run(), run()]);
}

test("two replicas racing one recurring occurrence post exactly one invoice", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Concurrent", "admin");
    await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb
      where org_id=${org.orgId} and key='admin'`);
    // The template carries today's business date for line-level tax math;
    // only the schedule's next_run_on sits in the past (see below).
    const templateId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, due_date, currency,
         subtotal, tax_total, total, party_id, created_by)
      values (${templateId}, ${org.orgId}, 'customer_invoice', 'draft', ${"TPL-" + templateId.slice(0, 8)},
              ${org.date}, ${org.date}, 'CAD', '100.00', '0.00', '100.00', ${org.customerId}, ${actorId})
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, description, quantity, unit, unit_price, amount, created_by)
      values (${org.orgId}, ${templateId}, 1, ${org.accounts.revenue}, 'Recurring service',
              '1', 'ea', '100.00', '100.00', ${actorId})
    `);
    // Scratch orgs live entirely inside July 2026 (org.date is fixed at
    // 2026-07-15), so the occurrence sits on 2026-07-10: covered by the open
    // period, but a date no other org can share — the org-spanning tick scan
    // only takes schedules due at the given asOf, so sibling fleet workers'
    // 07-15 schedules are never touched by these children.
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into recurring_schedules
        (id, org_id, template_document_id, cadence, next_run_on, auto_post, is_active, name, created_by)
      values (${scheduleId}, ${org.orgId}, ${templateId}, 'monthly', '2026-07-10', true, true, 'Concurrent fixture', ${actorId})
    `);
    const [first, second] = await racePair("recurring", org.orgId, "2026-07-10");
    assert.equal(first.ok, true, `child 1 failed: ${first.error}`);
    assert.equal(second.ok, true, `child 2 failed: ${second.error}`);
    const invoices = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents
       where org_id = ${org.orgId} and kind = 'customer_invoice' and status = 'posted'
    `)).rows[0]!.n;
    const entries = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId}
    `)).rows[0]!.n;
    const guards = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from recurring_occurrence_documents
       where org_id = ${org.orgId} and schedule_id = ${scheduleId}
    `)).rows[0]!.n;
    assert.equal(invoices, 1, "exactly one posted invoice across both replicas");
    assert.equal(entries, 1, "exactly one journal entry across both replicas");
    assert.equal(guards, 1, "exactly one occurrence guard row");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// Both gates are infrastructure, spelled as the env the runner provides so
// the skip checker can audit them: no database, or no redis to race on.
test("two replicas racing one dunning notice send exactly one", { skip: !DB || !(process.env.REDIS_URL ?? process.env.OPENBOOKS_REDIS_URL) }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`update parties set email = 'dunning-race@example.com' where id = ${org.customerId} and org_id = ${org.orgId}`);
    const policyId = randomUUID();
    await db.execute(sql`
      insert into dunning_policies (id, org_id, name, applies_to_kind, grace_period_days, min_balance)
      values (${policyId}, ${org.orgId}, 'Collections', 'customer_invoice', 0, '0')
    `);
    const stageId = randomUUID();
    await db.execute(sql`
      insert into dunning_stages (id, org_id, policy_id, sequence, name, offset_days, subject_template, body_template)
      values (${stageId}, ${org.orgId}, ${policyId}, 1, 'First reminder', 0,
              'Reminder: {{invoice}}', 'Hi {{party}}, {{amount}} on {{invoice}} was due {{dueDate}}.')
    `);
    const userId = await createScratchUser(org.orgId, "Dunning Race", "accountant");
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'RACE-001',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, '2026-06-01',
              'CAD', '1', '100', '0', '100', ${userId})
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')
    `);
    await db.execute(sql`update documents set status='approved' where id=${invoiceId} and org_id=${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    const [first, second] = await racePair("dunning", org.orgId, "2026-07-10");
    assert.equal(first.ok, true, `child 1 failed: ${first.error}`);
    assert.equal(second.ok, true, `child 2 failed: ${second.error}`);
    const notices = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from dunning_log
       where org_id = ${org.orgId} and document_id = ${invoiceId} and stage_id = ${stageId}
         and status = 'sent'
    `)).rows[0]!.n;
    assert.equal(notices, 1, "exactly one fired notice across both replicas");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("two replicas refreshing one sandbox leave exactly one consistent clone", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A manual double-click (or a manual refresh racing the scheduled one)
    // enqueues two refresh jobs with no dedupe id and no status claim, so
    // both workers run the full wipe+clone against the same sandbox org.
    const { createSandbox } = await import("../sandbox/lifecycle.ts");
    const created = await createSandbox({ productionOrgId: org.orgId, name: "Concurrent refresh", tier: "dev", masked: true });
    const prodDocs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${org.orgId}
    `)).rows[0]!.n;
    const [first, second] = await racePair("sandbox-refresh", org.orgId, created.sandboxId);
    const outcomes = [first.ok, second.ok];
    const row = (await db.execute<{ status: string; last_error: string | null }>(sql`
      select status, last_error from sandboxes where id = ${created.sandboxId}
    `)).rows[0]!;
    const cloneDocs = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${created.sandboxOrgId}
    `)).rows[0]!.n;
    assert.deepEqual(outcomes, [true, true], `both refreshes must succeed: ${first.error} / ${second.error}`);
    assert.equal(row.status, "ready");
    assert.equal(row.last_error, null);
    assert.equal(cloneDocs, prodDocs, "the clone must hold exactly one copy of production rows");
  } finally {
    const { deleteSandbox } = await import("../sandbox/lifecycle.ts");
    const leftovers = await db.execute<{ id: string }>(sql`select id from sandboxes where org_id != ${org.orgId} and production_org_id = ${org.orgId}`);
    for (const leftover of leftovers.rows) {
      await deleteSandbox(leftover.id).catch(() => undefined);
    }
    await dropScratchOrg(org.orgId);
  }
});

test("two replicas racing one scheduled report run render exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions
        (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'concurrent-race',
              'Concurrent race', '{}'::jsonb, null, null)
    `);
    const runId = randomUUID();
    await db.execute(sql`
      insert into report_runs
        (id, org_id, schedule_id, definition_id, trigger, status, scheduled_for,
         recipient_emails, next_attempt_at)
      values (${runId}, ${org.orgId}, null, ${definitionId}, 'scheduled', 'queued',
              ${new Date(Date.now() - 60_000)}, '["race@example.com"]'::jsonb, now())
    `);
    const [first, second] = await racePair("report", org.orgId, runId);
    assert.equal(first.ok, true, `child 1 failed: ${first.error}`);
    assert.equal(second.ok, true, `child 2 failed: ${second.error}`);
    const claimed = [first, second].filter(
      (r) => r.ok && typeof r.result === "object" && r.result !== null && !("skipped" in (r.result as Record<string, unknown>)),
    );
    assert.equal(claimed.length, 1, "exactly one replica claims the run");
    const artifacts = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from report_run_artifacts where org_id = ${org.orgId} and run_id = ${runId}
    `)).rows[0]!.n;
    assert.equal(artifacts, 1, "exactly one artifact set across both replicas");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
