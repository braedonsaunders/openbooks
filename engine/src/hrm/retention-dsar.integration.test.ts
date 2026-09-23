import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HrmDocumentsError } from "./documents/errors.ts";
import { saveCategory } from "./documents/categories.ts";
import { generateDocument, sendDocument, signTokenDocument } from "./documents/documents.ts";
import { saveTemplate } from "./documents/templates.ts";
import {
  listRetentionActions,
  listSchedules,
  runRetentionTick,
  saveSchedule,
} from "./documents/retention.ts";
import { buildExport, downloadExport, listExports, requestExport } from "./documents/dsar.ts";

/**
 * HR-19 retention + DSAR DB coverage (integration partition): the
 * due/grace/legal-hold matrix, delete purging bytes while keeping the
 * row and events, anonymize clearing title and party, expiry of stale
 * sends, and the DSAR zip contents against a seeded person. Proofs are
 * read back from storage, never from service returns alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const FEATURES = ["hrm", "hrmDocuments", "hrmDocumentRetention", "hrmDataSubjectExport"];

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of FEATURES) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
}

async function setGraceDays(orgId: string, days: number): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{hrmDocuments,retentionGraceDays}',
                                ${String(days)}::jsonb, true)
     where id = ${orgId}
  `);
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

type Harness = { org: ScratchOrg; hrId: string; employeeId: string; partyId: string; employmentId: string };

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId);
  await setGraceDays(org.orgId, 0);
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${partyId}, ${org.orgId}, 'person', 'Rita Retention', 'rita@scratch.test', true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${org.orgId}, ${partyId}, ${org.subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${org.orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  const hrId = await createScratchUser(org.orgId, "HR Admin", "hr_admin");
  await db.execute(sql`update users set party_id = ${partyId} where id = ${hrId} and org_id = ${org.orgId}`);
  const employeeId = await createScratchUser(org.orgId, "Rita Retention", "employee_self");
  await db.execute(sql`update users set party_id = ${partyId} where id = ${employeeId} and org_id = ${org.orgId}`);
  await grantPermissions(org.orgId, hrId, ["hrm.documents.read", "hrm.documents.manage"]);
  await grantPermissions(org.orgId, employeeId, ["hrm.self.read"]);
  // The declared category vocabulary templates and schedules must name.
  for (const [key, label] of [["contract", "Contracts"], ["letter", "Letters"]] as const) {
    await saveCategory({ orgId: org.orgId, actorId: hrId, key, label });
  }
  return { org, hrId, employeeId, partyId, employmentId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function makeTemplate(h: Harness, category: string): Promise<string> {
  const tpl = await saveTemplate({
    orgId: h.org.orgId,
    actorId: h.hrId,
    name: `Template ${randomUUID().slice(0, 8)}`,
    categoryKey: category,
    bodyTemplate: "Hello {{employee_name}}.",
    mergeFields: ["employee_name"],
    requiresSignature: true,
    signerRoles: ["employee"],
    acknowledgmentOnly: false,
  });
  return tpl.id;
}

async function completeDocument(h: Harness, templateId: string, title: string): Promise<string> {
  const { document } = await generateDocument({
    orgId: h.org.orgId,
    actorId: h.hrId,
    templateId,
    employmentId: h.employmentId,
    partyId: h.partyId,
    title,
    today: "2026-09-21",
  });
  const sent = await sendDocument({ orgId: h.org.orgId, actorId: h.hrId, documentId: document.id });
  // The hr user and the subject share one party here, so the single
  // employee signature completes the document.
  await signTokenDocument({ token: sent.deliveries[0]!.token, name: "Rita Retention" });
  return document.id;
}

test("retention due, grace, legal hold, delete, and anonymize matrix", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const contractTpl = await makeTemplate(h, "contract");
    const letterTpl = await makeTemplate(h, "letter");
    await saveSchedule({
      orgId: h.org.orgId,
      actorId: h.hrId,
      categoryKey: "contract",
      retainYears: 0,
      fromEvent: "completion",
      action: "delete",
    });
    await saveSchedule({
      orgId: h.org.orgId,
      actorId: h.hrId,
      categoryKey: "letter",
      retainYears: 0,
      fromEvent: "completion",
      action: "anonymize",
    });
    const schedules = await listSchedules({ orgId: h.org.orgId, actorId: h.hrId });
    assert.equal(schedules.length, 2);
    // A second schedule for one category is refused as ambiguous deletion.
    await assert.rejects(
      saveSchedule({
        orgId: h.org.orgId,
        actorId: h.hrId,
        categoryKey: "contract",
        retainYears: 1,
        fromEvent: "completion",
        action: "delete",
      }),
      /already has a schedule/,
    );

    const deleteId = await completeDocument(h, contractTpl, "Deletable contract");
    const anonId = await completeDocument(h, letterTpl, "Anonymizable letter");
    const heldDoc = await generateDocument({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId: contractTpl,
      employmentId: h.employmentId,
      partyId: h.partyId,
      title: "Held contract",
      today: "2026-09-21",
    });
    const heldSent = await sendDocument({ orgId: h.org.orgId, actorId: h.hrId, documentId: heldDoc.document.id });
    await signTokenDocument({ token: heldSent.deliveries[0]!.token, name: "Rita Retention" });
    const { setLegalHold } = await import("./documents/documents.ts");
    await setLegalHold({ orgId: h.org.orgId, actorId: h.hrId, documentId: heldDoc.document.id, hold: true });

    // Signing stores the database's real completion time, independently of
    // the template's "today" date. A zero-year schedule is due on that
    // completion date; use the latest one so crossing midnight is safe.
    const clocks = (await db.execute<{ completed_on: string; retain_until: string }>(sql`
      select completed_at::date::text as completed_on, retain_until::text as retain_until
        from hrm_documents
       where org_id = ${h.org.orgId} and id in (${deleteId}, ${anonId}, ${heldDoc.document.id})
    `)).rows;
    assert.equal(clocks.length, 3);
    for (const clock of clocks) {
      assert.ok(clock.completed_on);
      assert.equal(clock.retain_until, clock.completed_on);
    }
    const tickDay = clocks.map((clock) => clock.completed_on).sort().at(-1)!;

    // Grace is 0, so one tick flags all three (retention_flagged events
    // + action rows) and executes the two unheld in the same pass: delete
    // purges bytes but keeps the row and events; anonymize clears title
    // and party. The held one blocks with its reason named.
    const first = await runRetentionTick(h.org.orgId, tickDay);
    assert.equal(first.flagged, 3);
    assert.equal(first.executed, 2);
    assert.equal(first.blocked, 1);
    const pending = await listRetentionActions({ orgId: h.org.orgId, actorId: h.hrId, pendingOnly: true });
    assert.equal(pending.length, 1);

    // A re-run is idempotent: nothing new to flag or execute, and the
    // held action stays open and blocked.
    const second = await runRetentionTick(h.org.orgId, tickDay);
    assert.equal(second.flagged, 0);
    assert.equal(second.executed, 0);
    assert.equal(second.blocked, 1);

    const deleted = (await db.execute<{ status: string; file_id: string }>(sql`
      select status, file_id from hrm_documents where id = ${deleteId}
    `)).rows[0]!;
    assert.equal(deleted.status, "deleted");
    const blobs = (await db.execute<{ n: string }>(sql`
      select count(*) as n from file_blobs
       where version_id in (select id from file_versions where file_id = ${deleted.file_id})
    `)).rows[0]!.n;
    assert.equal(blobs, "0");
    const eventsKept = (await db.execute<{ n: string }>(sql`
      select count(*) as n from hrm_document_events where document_id = ${deleteId}
    `)).rows[0]!.n;
    assert.ok(Number(eventsKept) >= 3);

    const anon = (await db.execute<{ title: string; party_id: string | null; file_id: string | null }>(sql`
      select title, party_id, file_id from hrm_documents where id = ${anonId}
    `)).rows[0]!;
    assert.equal(anon.title, "Anonymized document");
    assert.equal(anon.party_id, null);
    assert.equal(anon.file_id, null);

    const blocked = (await db.execute<{ blocked_reason: string }>(sql`
      select blocked_reason from hrm_retention_actions
       where document_id = ${heldDoc.document.id} and executed_at is null
    `)).rows[0]!;
    assert.match(blocked.blocked_reason, /legal hold/);
    const held = (await db.execute<{ status: string }>(sql`
      select status from hrm_documents where id = ${heldDoc.document.id}
    `)).rows[0]!;
    assert.equal(held.status, "signed");
  });
});

test("the tick expires stale sends", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const tpl = await makeTemplate(h, "contract");
    const { document } = await generateDocument({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId: tpl,
      employmentId: h.employmentId,
      partyId: h.partyId,
      title: "Expiring",
      today: "2026-09-21",
      expiresAt: "2026-09-20T00:00:00Z",
    });
    await sendDocument({ orgId: h.org.orgId, actorId: h.hrId, documentId: document.id });
    const tick = await runRetentionTick(h.org.orgId, "2026-09-21");
    assert.equal(tick.expired, 1);
    const row = (await db.execute<{ status: string }>(sql`
      select status from hrm_documents where id = ${document.id}
    `)).rows[0]!;
    assert.equal(row.status, "expired");
  });
});

test("DSAR zip contents against a seeded person", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    // Leave, time, a pay stub, and an HR document for the subject.
    const leaveType = randomUUID();
    await db.execute(sql`
      insert into hrm_leave_types (id, org_id, code, name) values (${leaveType}, ${h.org.orgId}, 'VAC', 'Vacation')
    `);
    await db.execute(sql`
      insert into hrm_leave_requests (org_id, employment_id, leave_type_id, starts_on, ends_on, hours, status, decided_by, decided_at, decision_reason)
      values (${h.org.orgId}, ${h.employmentId}, ${leaveType}, '2026-08-04'::date, '2026-08-08'::date, 40.00, 'approved', ${h.hrId}, now(), 'seeded decision')
    `);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status)
      values (${h.org.orgId}, ${h.partyId}, '2026-09-15'::date, '8.0000', 'approved')
    `);
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
      values (${scheduleId}, ${h.org.orgId}, 'Weekly', 'weekly', 52, '2026-01-01'::date)
    `);
    const runId = randomUUID();
    await db.execute(sql`
      insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date, currency, status, created_by, updated_by)
      values (${h.org.orgId}, ${runId}, 'pay_run', ${`PAY-${runId.slice(0, 8)}`}, ${h.org.subsidiaryId}, '2026-09-19'::date, 'USD', 'committed', ${h.hrId}, ${h.hrId})
    `);
    await db.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
      values (${runId}, ${h.org.orgId}, ${scheduleId}, '2026-09-13'::date, '2026-09-19'::date, '2026-09-19'::date, 2026, 'committed')
    `);
    await db.execute(sql`
      insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province, periods_per_year, pay_date, tax_year, currency_code, gross, net_pay)
      values (${h.org.orgId}, ${runId}, ${h.partyId}, 'TX', 52, '2026-09-19'::date, 2026, 'USD', '900.0000', '700.0000')
    `);
    const tpl = await makeTemplate(h, "contract");
    await completeDocument(h, tpl, "My contract");

    // The subject requests their own export with the self grant alone.
    const requested = await requestExport({ orgId: h.org.orgId, actorId: h.employeeId, partyId: h.partyId });
    assert.equal(requested.status, "queued");
    // A non-subject without manage is refused by name.
    const stranger = await createScratchUser(h.org.orgId, "Stranger", "stranger_self");
    await grantPermissions(h.org.orgId, stranger, ["hrm.self.read"]);
    await assert.rejects(
      requestExport({ orgId: h.org.orgId, actorId: stranger, partyId: h.partyId }),
      (e: unknown) => e instanceof HrmDocumentsError && e.code === "FORBIDDEN",
    );

    await buildExport(h.org.orgId, requested.id);
    const listed = await listExports({ orgId: h.org.orgId, actorId: h.hrId, partyId: h.partyId });
    assert.equal(listed[0]!.status, "ready");
    const scope = listed[0]!.scope as { module: string; status: string }[];
    for (const module of ["party", "employments", "leave", "time", "documents", "payroll"]) {
      assert.equal(scope.find((s) => s.module === module)?.status, "included", `${module} must be included`);
    }

    const { bytes } = await downloadExport({ orgId: h.org.orgId, actorId: h.employeeId, exportId: requested.id });
    const dir = mkdtempSync(join(tmpdir(), "hrm-dsar-"));
    const path = join(dir, "export.zip");
    writeFileSync(path, bytes);
    const listing = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
    assert.match(listing, /export\.json/);
    assert.match(listing, /documents\/.*\.pdf/);
    const raw = execFileSync("unzip", ["-p", path, "export.json"], { maxBuffer: 64 * 1024 * 1024 });
    const payload = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    assert.equal((payload.party as { id: string }).id, h.partyId);
    assert.ok(((payload.employments ?? []) as unknown[]).length >= 1);
    assert.ok(((payload.leaveRequests ?? []) as unknown[]).length >= 1);
    assert.ok(((payload.timeEntries ?? []) as unknown[]).length >= 1);
    assert.ok(((payload.payStubs ?? []) as unknown[]).length >= 1);
    assert.equal(((payload.payStubs ?? []) as { gross: string }[])[0]!.gross, "900.0000");
    assert.ok(((payload.documents ?? []) as unknown[]).length >= 1);
    // Download flips ready to delivered, read back from storage.
    const status = (await db.execute<{ status: string }>(sql`
      select status from hrm_data_subject_exports where id = ${requested.id}
    `)).rows[0]!;
    assert.equal(status.status, "delivered");
  });
});

test("DSAR exports paginate unbounded histories instead of truncating at 2000", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    // 2500 time entries: three keyset pages where the old
    // ORDER BY worked_on LIMIT 2000 silently dropped 500 rows while the
    // export still reported ready.
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status)
      select ${h.org.orgId}, ${h.partyId}, date '2020-01-01' + g, '8.0000', 'approved'
        from generate_series(0, 2499) g
    `);
    // 510 stubs sharing one pay run, one line each: two stub pages plus
    // chunked line fetches instead of one unbounded IN list.
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
      values (${scheduleId}, ${h.org.orgId}, 'Weekly', 'weekly', 52, '2026-01-01'::date)
    `);
    // One stub per (pay run, employee) — pay_stubs_run_employee — so the
    // 510 stubs need 510 runs, built in one statement.
    await db.execute(sql`
      with docs as (
        insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date, currency, status, created_by, updated_by)
        select ${h.org.orgId}, uuid_generate_v7(), 'pay_run', 'PAY-PG-' || g::text,
               ${h.org.subsidiaryId}, date '2020-01-01' + g, 'USD', 'committed', ${h.hrId}, ${h.hrId}
          from generate_series(0, 509) g
        returning id, document_date
      ),
      prs as (
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status)
        select id, ${h.org.orgId}, ${scheduleId}, document_date, document_date, document_date, 2020, 'committed'
          from docs
        returning document_id
      )
      insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province, periods_per_year, pay_date, tax_year, currency_code, gross, net_pay)
      select ${h.org.orgId}, document_id, ${h.partyId}, 'TX', 52,
             date '2020-01-01' + ((row_number() over () - 1)::int), 2020, 'USD', '900.0000', '700.0000'
        from prs
    `);
    await db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, kind, description, amount)
      select ${h.org.orgId}, s.id, 'earning', 'Seeded wage', '900.0000'
        from pay_stubs s
       where s.org_id = ${h.org.orgId} and s.employee_party_id = ${h.partyId}
    `);

    const requested = await requestExport({ orgId: h.org.orgId, actorId: h.employeeId, partyId: h.partyId });
    await buildExport(h.org.orgId, requested.id);
    const listed = await listExports({ orgId: h.org.orgId, actorId: h.hrId, partyId: h.partyId });
    assert.equal(listed[0]!.status, "ready");
    const scope = listed[0]!.scope as { module: string; status: string }[];
    assert.equal(scope.find((s) => s.module === "time")?.status, "included");
    assert.equal(scope.find((s) => s.module === "payroll")?.status, "included");

    const { bytes } = await downloadExport({ orgId: h.org.orgId, actorId: h.employeeId, exportId: requested.id });
    const dir = mkdtempSync(join(tmpdir(), "hrm-dsar-page-"));
    const path = join(dir, "export.zip");
    writeFileSync(path, bytes);
    const raw = execFileSync("unzip", ["-p", path, "export.json"], { maxBuffer: 128 * 1024 * 1024 });
    const payload = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    // Every row survives: nothing truncated, nothing duplicated.
    const timeEntries = (payload.timeEntries ?? []) as { id: string }[];
    assert.equal(timeEntries.length, 2500);
    assert.equal(new Set(timeEntries.map((e) => e.id)).size, 2500);
    const payStubs = (payload.payStubs ?? []) as { id: string }[];
    assert.equal(payStubs.length, 510);
    const payStubLines = (payload.payStubLines ?? []) as { stub_id: string }[];
    assert.equal(payStubLines.length, 510);
    assert.equal(new Set(payStubLines.map((l) => l.stub_id)).size, 510);
  });
});
