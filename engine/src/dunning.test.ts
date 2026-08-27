import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { renderTemplate, runDunning, selectDueStage, type DunningStage } from "./dunning.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const stage = (id: string, sequence: number, offsetDays: number): DunningStage => ({
  id,
  sequence,
  offsetDays,
  name: `stage ${sequence}`,
  subjectTemplate: "",
  bodyTemplate: "",
  escalate: false,
});

const ladder = [stage("a", 1, 0), stage("b", 2, 15), stage("c", 3, 30)];

test("selectDueStage fires the highest crossed stage that has not fired", () => {
  assert.equal(selectDueStage(ladder, 40, new Set(), 0)?.id, "c");
  assert.equal(selectDueStage(ladder, 20, new Set(), 0)?.id, "b");
  assert.equal(selectDueStage(ladder, 3, new Set(), 0)?.id, "a");
});

test("selectDueStage never re-sends a stage already in the log", () => {
  assert.equal(selectDueStage(ladder, 40, new Set(["c"]), 0)?.id, "b");
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b"]), 0)?.id, "a");
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b", "a"]), 0), null);
});

test("selectDueStage returns null before the first threshold", () => {
  const future = [stage("x", 1, 7)];
  assert.equal(selectDueStage(future, 3, new Set(), 0), null);
});

const courtesyLadder = [stage("pre", 1, -7), stage("due", 2, 0)];

test("selectDueStage fires a negative-offset stage on its exact configured pre-due day", () => {
  assert.equal(selectDueStage(courtesyLadder, -7, new Set(), 0)?.id, "pre");
  // Once crossed the rung stays due until it fires (fire-once semantics):
  // a missed tick must not lose the courtesy letter, only the exact -7 day
  // is the earliest it may ever appear.
  assert.equal(selectDueStage(courtesyLadder, -6, new Set(), 0)?.id, "pre");
  assert.equal(selectDueStage(courtesyLadder, -8, new Set(), 0), null);
});

test("selectDueStage lets grace delay post-due rungs but never courtesy rungs", () => {
  const postDue = [stage("a", 1, 0), stage("b", 2, 15)];
  assert.equal(selectDueStage(postDue, 1, new Set(), 2), null);
  assert.equal(selectDueStage(postDue, 2, new Set(), 2)?.id, "a");
  // Grace is "days after the due date before the ladder starts": it must not
  // hold back a rung anchored before the due date.
  assert.equal(selectDueStage(courtesyLadder, -7, new Set(), 30)?.id, "pre");
  // Grace is nonnegative by definition — a negative configured value is a
  // misconfiguration and must never pull a post-due rung before the due date.
  assert.equal(selectDueStage(postDue, -1, new Set(), -5), null);
  assert.equal(selectDueStage(postDue, 0, new Set(), -5)?.id, "a");
});

test("renderTemplate substitutes known tokens and blanks unknown ones", () => {
  assert.equal(
    renderTemplate("Hi {{party}}, invoice {{invoice}} is {{daysOverdue}} days late.", {
      party: "Acme",
      invoice: "INV-100",
      daysOverdue: 12,
    }),
    "Hi Acme, invoice INV-100 is 12 days late.",
  );
  assert.equal(renderTemplate("{{missing}} tail", {}), " tail");
});

test("dunning defers mail through the durable outbox inside the sent-claim transaction", () => {
  const source = readFileSync(new URL("./dunning.ts", import.meta.url), "utf8");
  // A direct Redis enqueue commits outside Postgres: a rolled-back or crashed
  // tick left mail queued against a sent claim that never existed, and the
  // next tick fired the same rung again — the customer got the letter twice.
  // The rendered notice must instead ride this org's transaction through the
  // durable scheduler_outbox (enqueueFlowEmail), keyed by the rung identity so
  // replays collapse onto one row, and no direct queue call may remain.
  assert.match(source, /import \{ enqueueFlowEmail \} from "\.\/scheduler-outbox\.ts";/);
  assert.match(source, /enqueueFlowEmail\(\{/);
  assert.match(source, /occurrenceKey:\s*`dunning:\$\{doc\.id\}:\$\{stage\.id\}`/);
  assert.doesNotMatch(source, /@openbooks\/jobs/);
  assert.doesNotMatch(source, /\benqueueEmail\b/);
});

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/** Drizzle wraps driver errors, so match against the whole `cause` chain. */
function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/**
 * One posted invoice under one active policy. Defaults give a single stage at
 * offset 0 and a due date well before the dates the runner is invoked with;
 * the date-boundary tests override `dueDate`, `gracePeriodDays`, and `stages`
 * (negative offsets included) to pin exact calendar days. `email` nulls the
 * billing address when a test wants the skipped path. Returns the ids the
 * assertions key on.
 */
async function seedDunnableInvoice(
  org: ScratchOrg,
  opts: {
    documentNumber: string;
    email: string | null;
    dueDate?: string;
    gracePeriodDays?: number;
    stages?: { id: string; sequence: number; offsetDays: number; name: string }[];
  },
): Promise<{
  invoiceId: string;
  policyId: string;
  stageId: string;
  stageIds: string[];
  documentNumber: string;
}> {
  await db.execute(sql`
    update parties set email = ${opts.email} where id = ${org.customerId} and org_id = ${org.orgId}
  `);
  const policyId = randomUUID();
  await db.execute(sql`
    insert into dunning_policies (id, org_id, name, applies_to_kind, grace_period_days, min_balance)
    values (${policyId}, ${org.orgId}, 'Collections', 'customer_invoice', ${opts.gracePeriodDays ?? 0}, '0')
  `);
  const stages =
    opts.stages ?? [{ id: randomUUID(), sequence: 1, offsetDays: 0, name: "First reminder" }];
  for (const s of stages) {
    await db.execute(sql`
      insert into dunning_stages
        (id, org_id, policy_id, sequence, name, offset_days, subject_template, body_template)
      values (${s.id}, ${org.orgId}, ${policyId}, ${s.sequence}, ${s.name}, ${s.offsetDays},
              'Reminder: {{invoice}}',
              'Hi {{party}}, {{amount}} on {{invoice}} was due {{dueDate}} — {{daysOverdue}} days over. — {{orgName}}')
    `);
  }
  const userId = await createScratchUser(org.orgId, "Dunning Tester", "accountant");
  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', ${opts.documentNumber},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${opts.dueDate ?? "2026-06-01"},
            'CAD', '1', '100', '0', '100', ${userId})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')
  `);
  await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  return {
    invoiceId,
    policyId,
    stageId: stages[0]!.id,
    stageIds: stages.map((s) => s.id),
    documentNumber: opts.documentNumber,
  };
}

async function stagedNotice(invoiceId: string): Promise<{
  logRows: unknown[];
  outboxRows: { occurrenceKey: string; payload: Record<string, unknown> }[];
}> {
  const log = await db.execute(sql`
    select * from dunning_log where document_id = ${invoiceId}
  `);
  const outbox = await db.execute<{ occurrenceKey: string; payload: Record<string, unknown> }>(sql`
    select occurrence_key as "occurrenceKey", payload
      from scheduler_outbox
     where kind = 'flow_email' and occurrence_key like ${`dunning:${invoiceId}:%`}
  `);
  return { logRows: log.rows, outboxRows: outbox.rows };
}

test("a fired dunning stage commits its sent claim and its mail deferral together", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, stageId, documentNumber } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });

    const first = await runDunning("2026-07-10");
    assert.equal(first.sent, 1);
    assert.deepEqual(first.notices.map((n) => n.status), ["sent"]);

    // The claim and the deferred delivery are one committed pair: exactly one
    // append-only sent row AND exactly one flow_email outbox row for the rung,
    // carrying the same rendered letter. Nothing touched Redis on this path —
    // the suite runs with no broker reachable at all.
    const { logRows, outboxRows } = await stagedNotice(invoiceId);
    assert.equal(logRows.length, 1);
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0]!.occurrenceKey, `dunning:${invoiceId}:${stageId}`);
    const payload = outboxRows[0]!.payload as {
      to: string[]; subject: string; text: string; meta?: { category?: string };
    };
    assert.deepEqual(payload.to, ["billing@acme.test"]);
    assert.equal(payload.subject, `Reminder: ${documentNumber}`);
    assert.match(payload.text, /days over/);
    assert.equal(payload.meta?.category, "dunning");

    // The replayed tick is a no-op: the unique claim index plus the
    // deterministic occurrence key mean re-running never double-sends.
    const second = await runDunning("2026-07-11");
    assert.equal(second.sent, 0);
    const after = await stagedNotice(invoiceId);
    assert.equal(after.logRows.length, 1);
    assert.equal(after.outboxRows.length, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a failed claim write rolls the accepted mail job back with it and the retry delivers exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, stageId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });

    // Force storage to fail AFTER the deferral was accepted (the scheduler_outbox
    // row is already inserted) but BEFORE the transaction commits — the crash /
    // COMMIT-failure window the atomicity contract exists for. `invoiceId` is a
    // randomUUID generated above, so splicing it into the WHEN clause as a
    // literal through sql.raw is injection-safe; CREATE TRIGGER cannot take
    // bind parameters, so the plain sql template's placeholder form is off
    // limits here.
    try {
      await db.execute(sql`drop trigger if exists dun_claim_fault_trg on dunning_log`);
      await db.execute(sql`drop function if exists dun_claim_fault()`);
      await db.execute(sql`
        create function dun_claim_fault() returns trigger language plpgsql as $$
        begin raise exception 'injected dunning claim failure'; end $$;`);
      await db.execute(
        sql.raw(`
        create trigger dun_claim_fault_trg before insert on dunning_log
          for each row when (new.document_id = '${invoiceId}'::uuid)
          execute function dun_claim_fault()`),
      );

      await assert.rejects(() => runDunning("2026-07-10"), (error: unknown) =>
        errorChainMatches(error, /injected dunning claim failure/),
      );

      // The accepted job must not survive the rolled-back transaction: nothing
      // durable remains on either side of the pair.
      const wiped = await stagedNotice(invoiceId);
      assert.equal(wiped.outboxRows.length, 0, "queue acceptance must not outlive its transaction");
      assert.equal(wiped.logRows.length, 0);
    } finally {
      await db.execute(sql`drop trigger if exists dun_claim_fault_trg on dunning_log`);
      await db.execute(sql`drop function if exists dun_claim_fault()`);
    }

    // The next scheduler tick delivers exactly once: one delivered job and one
    // immutable sent claim — never a second copy of the letter.
    const retry = await runDunning("2026-07-10");
    assert.equal(retry.sent, 1);
    const paired = await stagedNotice(invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal(paired.outboxRows.length, 1);
    assert.equal(paired.outboxRows[0]!.occurrenceKey, `dunning:${invoiceId}:${stageId}`);

    // Immutable means immutable: the append-only guard rejects tampering with
    // the committed claim. The guard yields to the test harness's RLS bypass,
    // so the write must be attempted in a production-posture org transaction
    // (bypass off) to reach it at all.
    await assert.rejects(
      () =>
        withOrg(org.orgId, () =>
          db.execute(sql`update dunning_log set detail = 'tampered' where document_id = ${invoiceId}`),
        ),
      (error: unknown) => errorChainMatches(error, /append-only/),
    );
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("two concurrent ticks deliver one ladder rung exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, stageId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });

    // Two overlapping scheduler ticks race for the same rung. The advisory
    // xact lock serializes them, the loser's re-read sees the winner's
    // committed claim, and exactly one letter is staged.
    const ticks = await Promise.allSettled([
      runDunning("2026-07-10"),
      runDunning("2026-07-10"),
    ]);
    assert.deepEqual(ticks.map((t) => t.status), ["fulfilled", "fulfilled"]);
    const sentTotal = ticks.reduce(
      (total, t) => (t.status === "fulfilled" ? total + t.value.sent : total),
      0,
    );
    assert.equal(sentTotal, 1);

    const paired = await stagedNotice(invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal(paired.outboxRows.length, 1);
    assert.equal(paired.outboxRows[0]!.occurrenceKey, `dunning:${invoiceId}:${stageId}`);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an unsendable dunning notice leaves both sides of the pair empty and retries later", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: null,
    });

    const first = await runDunning("2026-07-10");
    assert.deepEqual(first.notices.map((n) => n.status), ["skipped"]);
    const empty = await stagedNotice(invoiceId);
    assert.equal(empty.logRows.length, 0, "no sent claim without a deliverable letter");
    assert.equal(empty.outboxRows.length, 0, "no queued mail without a deliverable letter");

    // The rung stays open: once the address exists, the next tick fires once.
    await db.execute(sql`
      update parties set email = 'billing@acme.test' where id = ${org.customerId} and org_id = ${org.orgId}
    `);
    const second = await runDunning("2026-07-10");
    assert.deepEqual(second.notices.map((n) => n.status), ["sent"]);
    const paired = await stagedNotice(invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal(paired.outboxRows.length, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a pre-due courtesy stage fires on its exact configured day and never before", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const courtesyId = randomUUID();
    const overdueId = randomUUID();
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
      dueDate: "2026-07-20",
      stages: [
        { id: courtesyId, sequence: 1, offsetDays: -7, name: "Courtesy reminder" },
        { id: overdueId, sequence: 2, offsetDays: 0, name: "First overdue" },
      ],
    });

    // The day before the configured pre-due day the invoice is not even in
    // the ladder's reach: nothing scanned, nothing staged.
    const premature = await runDunning("2026-07-12");
    assert.equal(premature.scanned, 0);
    assert.equal(premature.sent, 0);
    const before = await stagedNotice(invoiceId);
    assert.equal(before.logRows.length, 0);
    assert.equal(before.outboxRows.length, 0);

    // Exactly seven days before the due date the courtesy rung fires — once,
    // and never the overdue rung that has not been crossed yet.
    const onTime = await runDunning("2026-07-13");
    assert.equal(onTime.sent, 1);
    assert.deepEqual(onTime.notices.map((n) => n.stageId), [courtesyId]);
    const fired = await stagedNotice(invoiceId);
    assert.equal(fired.logRows.length, 1);
    assert.equal(fired.outboxRows.length, 1);
    assert.equal(fired.outboxRows[0]!.occurrenceKey, `dunning:${invoiceId}:${courtesyId}`);

    // Replay idempotency across adjacent days: neither the same tick nor the
    // next one (courtesy crossed-but-fired, overdue rung not yet due) sends
    // anything more.
    const replay = await runDunning("2026-07-13");
    assert.equal(replay.sent, 0);
    const nextDay = await runDunning("2026-07-14");
    assert.equal(nextDay.sent, 0);
    const settled = await stagedNotice(invoiceId);
    assert.equal(settled.logRows.length, 1);
    assert.equal(settled.outboxRows.length, 1);

    // The ladder continues into the overdue region on its own configured day:
    // with grace 0 the offset-0 rung fires exactly on the due date, without
    // re-touching the courtesy rung.
    const dueDay = await runDunning("2026-07-20");
    assert.equal(dueDay.sent, 1);
    assert.deepEqual(dueDay.notices.map((n) => n.stageId), [overdueId]);
    const both = await stagedNotice(invoiceId);
    assert.equal(both.logRows.length, 2);
    assert.equal(both.outboxRows.length, 2);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("the grace period delays the overdue ladder to its exact boundary day", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, stageId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
      dueDate: "2026-06-01",
      gracePeriodDays: 2,
    });

    // One day past due is inside the grace window: the invoice is scanned but
    // no rung has fired.
    const inGrace = await runDunning("2026-06-02");
    assert.equal(inGrace.scanned, 1);
    assert.equal(inGrace.sent, 0);
    assert.equal((await stagedNotice(invoiceId)).logRows.length, 0);

    // The boundary day itself — grace elapsed — fires the ladder's first rung.
    const atBoundary = await runDunning("2026-06-03");
    assert.equal(atBoundary.sent, 1);
    assert.deepEqual(atBoundary.notices.map((n) => n.stageId), [stageId]);
    assert.equal((await stagedNotice(invoiceId)).logRows.length, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a fully paid invoice never generates a reminder", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
      dueDate: "2026-06-01",
    });
    const actorId = await createScratchUser(org.orgId, "Payer", "accountant");

    // Settle the invoice in full the way the kernel does: a posted payment
    // entry whose open AR leg is applied against the invoice's open AR leg.
    const openLine = (
      await db.execute<{ id: string }>(sql`
        select jl.id from journal_lines jl
         join documents d on d.posted_entry_id = jl.entry_id
        where d.id = ${invoiceId} and jl.is_open_item
      `)
    ).rows[0]!.id;
    const settlementEntryId = randomUUID();
    const settlementLineId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, created_by, updated_by)
      values (${settlementEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
              'SETTLE-DUN-1', ${org.date}, ${org.periodId}, 'Payment', 'draft', 'manual',
              ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id,
         amount, currency, txn_amount, fx_rate, party_id, is_open_item)
      values
        (${settlementLineId}, ${org.orgId}, ${settlementEntryId}, 1,
         ${org.accounts.ar}, ${org.subsidiaryId}, '-100', 'CAD', '-100', '1',
           ${org.customerId}, true),
        (${randomUUID()}, ${org.orgId}, ${settlementEntryId}, 2,
         ${org.accounts.bank}, ${org.subsidiaryId}, '100', 'CAD', '100', '1',
           null, false)
    `);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_by = ${actorId}
       where id = ${settlementEntryId}
    `);
    await db.execute(sql`
      insert into applications
        (id, org_id, from_line_id, to_line_id, amount, source_amount,
         source_transaction_amount, source_transaction_currency,
         target_transaction_amount, target_transaction_currency,
         settlement_rate, settlement_rate_source, settlement_rate_reference,
         applied_on, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${settlementLineId}, ${openLine},
              '100', '100', '100', 'CAD', '100', 'CAD',
              1, 'same_currency', 'dunning-paid-test', ${org.date}, ${actorId}, ${actorId})
    `);

    // 39 days past due with a live ladder — and still nothing may fire.
    // `scanned` proves the exclusion comes from the paid balance, not from
    // the scan window.
    const run = await runDunning("2026-07-10");
    assert.equal(run.scanned, 1);
    assert.equal(run.sent, 0);
    const notice = await stagedNotice(invoiceId);
    assert.equal(notice.logRows.length, 0);
    assert.equal(notice.outboxRows.length, 0);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
