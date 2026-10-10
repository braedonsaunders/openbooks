import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { assertTemplateTokensKnown, runScheduleCatchUp, runScheduleNow } from "./recurring.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Catch-up runs bill, draft, or skip exactly the pending occurrences —
// never a silent bulk-post. These tests pin each choice, the end-date stop
// with deactivation, the closed-period failure with its retry, and the
// replay-instead-of-duplicate guarantee on retry.

async function seedSchedule(
  org: ScratchOrg,
  actorId: string,
  opts: {
    nextRunOn: string; endsOn?: string | null; autoPost?: boolean;
    maxOccurrences?: number | null; skippedRunOns?: string[]; name?: string;
  } = { nextRunOn: "2026-05-10" },
): Promise<{ scheduleId: string; templateId: string }> {
  await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb
    where org_id=${org.orgId} and key='admin'`);
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
  const scheduleId = randomUUID();
  const skippedLiteral = `{${(opts.skippedRunOns ?? []).map((date) => `"${date}"`).join(",")}}`;
  await db.execute(sql`
    insert into recurring_schedules
      (id, org_id, template_document_id, cadence, next_run_on, ends_on, max_occurrences, skipped_run_ons,
       auto_post, is_active, name, created_by)
    values (${scheduleId}, ${org.orgId}, ${templateId}, 'monthly', ${opts.nextRunOn},
            ${opts.endsOn ?? null}, ${opts.maxOccurrences ?? null}, ${skippedLiteral}::date[],
            ${opts.autoPost ?? true}, true, ${opts.name ?? "Catch-up fixture"}, ${actorId})
  `);
  return { scheduleId, templateId };
}

async function addPeriod(org: ScratchOrg, year: number, month: number): Promise<void> {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment, custom)
    select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id,
           ${year}, ${month}, ${`${year}-${mm}`}, ${`${year}-${mm}-01`}, ${`${year}-${mm}-${lastDay}`}, false,
           '{}'::jsonb
      from accounting_periods
     where id = ${org.periodId}
  `);
}

async function documentsByIds(orgId: string, ids: string[]): Promise<{ id: string; date: string; status: string }[]> {
  if (ids.length === 0) return [];
  return (await db.execute<{ id: string; date: string; status: string }>(sql`
    select id, document_date::text as "date", status from documents
     where org_id = ${orgId} and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)).rows;
}

async function generatedInvoiceCount(orgId: string, templateId: string): Promise<number> {
  return Number((await db.execute<{ n: string }>(sql`
    select count(*)::text as n from documents
     where org_id = ${orgId} and kind = 'customer_invoice' and id <> ${templateId}`)).rows[0]?.n ?? 0);
}

async function scheduleRunCount(orgId: string, scheduleId: string): Promise<number> {
  return Number((await db.execute<{ n: string }>(sql`
    select run_count::text as n from recurring_schedules where id = ${scheduleId} and org_id = ${orgId}`)).rows[0]?.n ?? 0);
}

async function scheduleState(orgId: string, scheduleId: string): Promise<{ nextRunOn: string; isActive: boolean }> {
  const row = (await db.execute<{ nextRunOn: string; isActive: boolean }>(sql`
    select next_run_on::text as "nextRunOn", is_active as "isActive"
      from recurring_schedules where id = ${scheduleId} and org_id = ${orgId}`)).rows[0]!;
  return { nextRunOn: row.nextRunOn, isActive: row.isActive };
}

async function catchUpAuditCount(orgId: string, scheduleId: string): Promise<number> {
  return Number((await db.execute<{ n: string }>(sql`
    select count(*)::text as n from audit_log
     where org_id = ${orgId} and table_name = 'recurring_schedules' and row_id = ${scheduleId}
       and action = 'update' and changes->>'mode' = 'catch_up'`)).rows[0]?.n ?? 0);
}

const AS_OF = "2026-07-15";

test("post-all posts each missed period on its own date", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId } = await seedSchedule(org, actorId);

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => [row.date, row.status]), [
      ["2026-05-10", "posted"],
      ["2026-06-10", "posted"],
      ["2026-07-10", "posted"],
    ]);
    const docs = await documentsByIds(org.orgId, outcome.results.map((row) => row.documentId!));
    assert.deepEqual(docs.map((doc) => doc.date).sort(), ["2026-05-10", "2026-06-10", "2026-07-10"]);
    assert.ok(docs.every((doc) => doc.status === "posted"));
    assert.deepEqual(await scheduleState(org.orgId, scheduleId), { nextRunOn: "2026-08-10", isActive: true });
    assert.equal(await catchUpAuditCount(org.orgId, scheduleId), 1, "the choice is audited");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drafts creates every missed period unposted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId } = await seedSchedule(org, actorId);

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "drafts", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "caught_up");
    assert.ok(outcome.results.every((row) => row.status === "draft"));
    const docs = await documentsByIds(org.orgId, outcome.results.map((row) => row.documentId!));
    assert.ok(docs.every((doc) => doc.status === "draft"), "draft choice never posts");
    assert.deepEqual((await scheduleState(org.orgId, scheduleId)).nextRunOn, "2026-08-10");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("skip advances past missed periods without generating and retries idle", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    const { scheduleId, templateId } = await seedSchedule(org, actorId);

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "skip", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => row.status), ["skipped", "skipped", "skipped"]);
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 0, "skip generates nothing");
    assert.deepEqual((await scheduleState(org.orgId, scheduleId)).nextRunOn, "2026-08-10");

    const retry = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "skip", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });
    assert.deepEqual(retry.results, [], "a retry with nothing pending is a no-op");
    assert.equal(retry.stopped, "caught_up");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("the end date stops generation and deactivates the schedule", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId } = await seedSchedule(org, actorId, { nextRunOn: "2026-05-10", endsOn: "2026-06-10" });

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "reached_end");
    assert.deepEqual(outcome.results.map((row) => [row.date, row.status]), [
      ["2026-05-10", "posted"],
      ["2026-06-10", "posted"],
    ]);
    assert.deepEqual(await scheduleState(org.orgId, scheduleId), { nextRunOn: "2026-07-10", isActive: false });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("retrying a completed catch-up replays instead of duplicating", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId, templateId } = await seedSchedule(org, actorId);

    const first = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });
    const second = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.deepEqual(second.results, [], "nothing pending, nothing generated");
    assert.equal(second.stopped, "caught_up");
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), first.results.length, "no duplicate documents");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a rewound cursor replays the committed document instead of duplicating", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    const { scheduleId, templateId } = await seedSchedule(org, actorId, { nextRunOn: "2026-05-10" });
    const first = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: "2026-05-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(first.results.length, 1);
    // Rewind the cursor without touching the billed occurrence: the retry
    // must replay the committed document, not cut a second one.
    await db.execute(sql`update recurring_schedules set next_run_on = '2026-05-10' where id = ${scheduleId} and org_id = ${org.orgId}`);
    const second = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: "2026-05-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.deepEqual(second.results.map((row) => row.status), ["replayed"]);
    assert.equal(second.results[0]?.documentId, first.results[0]?.documentId, "the same document replays");
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 1, "no duplicate document");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a closed occurrence period stops the run and the retry completes it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId, templateId } = await seedSchedule(org, actorId);
    const juneId = (await db.execute<{ id: string }>(sql`
      select p.id from accounting_periods p
        join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       and fc.is_default and fc.is_active
       where p.org_id = ${org.orgId} and not p.is_adjustment
         and p.starts_on <= '2026-06-10' and p.ends_on >= '2026-06-10'`)).rows[0]!.id;
    await setPeriodLockState({
      orgId: org.orgId, periodId: juneId, bookId: org.bookId,
      module: "gl", state: "soft_closed", actorId, reason: "catch-up failure regression",
    });

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "failed");
    assert.match(outcome.error ?? "", /closed/);
    assert.deepEqual(outcome.results.map((row) => [row.date, row.status]), [["2026-05-10", "posted"]]);
    assert.deepEqual((await scheduleState(org.orgId, scheduleId)).nextRunOn, "2026-06-10");

    await setPeriodLockState({
      orgId: org.orgId, periodId: juneId, bookId: org.bookId,
      module: "gl", state: "open", actorId, reason: "catch-up failure regression",
    });
    const retry = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(retry.stopped, "caught_up");
    assert.deepEqual(retry.results.map((row) => row.date), ["2026-06-10", "2026-07-10"]);
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 3, "no duplicate for the completed period");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("catch-up over three periods resolves three distinct descriptions", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Token controller", "admin");
    await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb
      where org_id=${org.orgId} and key='admin'`);
    await addPeriod(org, 2026, 1);
    await addPeriod(org, 2026, 2);
    await addPeriod(org, 2026, 3);
    const templateId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, due_date, currency,
         subtotal, tax_total, total, party_id, memo, created_by)
      values (${templateId}, ${org.orgId}, 'customer_invoice', 'draft', ${"TPL-" + templateId.slice(0, 8)},
              ${org.date}, ${org.date}, 'CAD', '100.00', '0.00', '100.00', ${org.customerId},
              'Season {period}', ${actorId})
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, description, quantity, unit, unit_price, amount, created_by)
      values (${org.orgId}, ${templateId}, 1, ${org.accounts.revenue}, 'Snow contract {month} instalment {n} of {total}',
              '1', 'ea', '100.00', '100.00', ${actorId})
    `);
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into recurring_schedules
        (id, org_id, template_document_id, cadence, next_run_on, ends_on, auto_post, is_active, name, created_by)
      values (${scheduleId}, ${org.orgId}, ${templateId}, 'monthly', '2026-01-10', '2026-03-10',
              true, true, 'Token fixture', ${actorId})
    `);

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: "2026-03-15", actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "reached_end");
    const docs = (await db.execute<{ description: string; memo: string | null; date: string }>(sql`
      select l.description, d.memo, d.document_date::text as "date"
        from recurring_occurrence_documents g
        join documents d on d.id = g.document_id and d.org_id = g.org_id
        join document_lines l on l.document_id = d.id and l.org_id = d.org_id
       where g.org_id = ${org.orgId} and g.schedule_id = ${scheduleId}
       order by d.document_date`)).rows;
    assert.deepEqual(docs.map((doc) => doc.description), [
      "Snow contract January instalment 1 of 3",
      "Snow contract February instalment 2 of 3",
      "Snow contract March instalment 3 of 3",
    ]);
    assert.deepEqual(docs.map((doc) => doc.memo), ["Season 2026-01", "Season 2026-02", "Season 2026-03"]);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("an unknown period token refuses at save with its name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Token controller", "admin");
    const templateId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, document_date, currency,
         subtotal, tax_total, total, party_id, created_by)
      values (${templateId}, ${org.orgId}, 'customer_invoice', 'draft', ${"TPL-" + templateId.slice(0, 8)},
              ${org.date}, 'CAD', '100.00', '0.00', '100.00', ${org.customerId}, ${actorId})
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, created_by)
      values (${org.orgId}, ${templateId}, 1, ${org.accounts.revenue}, 'Snow contract {seson}', '1', '100.00', '100.00', ${actorId})
    `);
    await assert.rejects(
      assertTemplateTokensKnown(db, org.orgId, templateId),
      (error: unknown) =>
        error instanceof Error &&
        /unknown period token \{seson\}/.test(error.message) &&
        /\{period\}/.test(error.message),
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("selected generates only the ticked periods and skips the rest", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId, templateId } = await seedSchedule(org, actorId);

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "selected", selectedDates: ["2026-05-10", "2026-07-10"], asOf: AS_OF,
      actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => [row.date, row.status]), [
      ["2026-05-10", "posted"],
      ["2026-06-10", "skipped"],
      ["2026-07-10", "posted"],
    ]);
    const docs = await documentsByIds(org.orgId, outcome.results.filter((row) => row.documentId).map((row) => row.documentId!));
    assert.deepEqual(docs.map((doc) => doc.date).sort(), ["2026-05-10", "2026-07-10"]);
    assert.equal(await scheduleRunCount(org.orgId, scheduleId), 2, "unticked periods consume no count");
    assert.deepEqual((await scheduleState(org.orgId, scheduleId)).nextRunOn, "2026-08-10");
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 2);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("selected drafts the ticked periods when post is false", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId } = await seedSchedule(org, actorId);

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "selected", selectedDates: ["2026-06-10"], postSelected: false, asOf: AS_OF,
      actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => [row.date, row.status]), [
      ["2026-05-10", "skipped"],
      ["2026-06-10", "draft"],
      ["2026-07-10", "skipped"],
    ]);
    const docs = await documentsByIds(org.orgId, outcome.results.filter((row) => row.documentId).map((row) => row.documentId!));
    assert.ok(docs.every((doc) => doc.status === "draft"), "draft-selected never posts");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("selected refuses dates outside the preview by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    const { scheduleId, templateId } = await seedSchedule(org, actorId);
    const run = (input: Parameters<typeof runScheduleCatchUp>[2]) =>
      runScheduleCatchUp(org.orgId, scheduleId, { asOf: AS_OF, actorId, allowedSubsidiaryIds: null, ...input });
    await assert.rejects(
      run({ mode: "selected", selectedDates: [] }),
      /selected catch-up needs at least one period date/,
    );
    await assert.rejects(
      run({ mode: "selected", selectedDates: ["2026-04-10"] }),
      /selected catch-up date 2026-04-10 is not a pending occurrence/,
    );
    await assert.rejects(
      run({ mode: "post_all", selectedDates: ["2026-05-10"] }),
      /selected dates apply only to the selected catch-up choice/,
    );
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 0, "refusals generate nothing");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("the occurrence limit stops generation and deactivates the schedule", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId, templateId } = await seedSchedule(org, actorId, { nextRunOn: "2026-05-10", maxOccurrences: 2 });

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "reached_limit");
    assert.deepEqual(outcome.results.map((row) => [row.date, row.status]), [
      ["2026-05-10", "posted"],
      ["2026-06-10", "posted"],
    ]);
    assert.deepEqual(await scheduleState(org.orgId, scheduleId), { nextRunOn: "2026-07-10", isActive: false });
    assert.equal(await scheduleRunCount(org.orgId, scheduleId), 2);

    // A capped schedule rests inactive exactly like an ended one: a further
    // run refuses as paused, and nothing more generates.
    await assert.rejects(
      runScheduleCatchUp(org.orgId, scheduleId, {
        mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
      }),
      /paused — resume it to catch up/,
    );
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 2);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("standing seasonal skips drain without generating", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId, templateId } = await seedSchedule(org, actorId, {
      nextRunOn: "2026-05-10", skippedRunOns: ["2026-06-10"],
    });

    const outcome = await runScheduleCatchUp(org.orgId, scheduleId, {
      mode: "post_all", asOf: AS_OF, actorId, allowedSubsidiaryIds: null,
    });

    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => [row.date, row.status]), [
      ["2026-05-10", "posted"],
      ["2026-06-10", "skipped"],
      ["2026-07-10", "posted"],
    ]);
    assert.equal(await scheduleRunCount(org.orgId, scheduleId), 2, "the skipped season consumes no count");
    assert.deepEqual((await scheduleState(org.orgId, scheduleId)).nextRunOn, "2026-08-10");
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 2);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("run now on a paused schedule refuses by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    const { scheduleId, templateId } = await seedSchedule(org, actorId, { nextRunOn: "2026-05-10" });
    await db.execute(sql`update recurring_schedules set is_active = false where id = ${scheduleId} and org_id = ${org.orgId}`);

    await assert.rejects(
      runScheduleNow(org.orgId, scheduleId, actorId, AS_OF),
      (error: unknown) =>
        error instanceof Error &&
        /paused — resume the schedule first/.test(error.message) &&
        /Catch-up fixture/.test(error.message),
    );
    assert.equal(await scheduleRunCount(org.orgId, scheduleId), 0, "a refused run advances no counter");
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 0, "a refused run creates no document");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("run now creates one document and a double-click replays it without a second count", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, 2026, 5);
    await addPeriod(org, 2026, 6);
    const { scheduleId, templateId } = await seedSchedule(org, actorId, { nextRunOn: "2026-05-10" });

    const first = await runScheduleNow(org.orgId, scheduleId, actorId, AS_OF);
    const second = await runScheduleNow(org.orgId, scheduleId, actorId, AS_OF);

    assert.equal(second.documentId, first.documentId, "the double-click replays the first document");
    assert.equal(await scheduleRunCount(org.orgId, scheduleId), 1, "the replay advances no second count");
    assert.equal(await generatedInvoiceCount(org.orgId, templateId), 1, "exactly one document exists");
    assert.deepEqual((await scheduleState(org.orgId, scheduleId)).nextRunOn, "2026-05-10", "a manual run never moves the cadence");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
