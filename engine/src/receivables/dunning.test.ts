import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { daysBetween, isDunnableDocumentKind, renderTemplate, runDunning, runDunningForOrg, selectDueStage, type DunningStage } from "./dunning.ts";
import { markDunningClaimFailed, markDunningClaimSent } from "../delivery/email-config.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

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

test("a fired higher rung supersedes every lower rung; a failed send retries", () => {
  // 40 days late with stage 3 sent: nothing lower may ever send, on this or
  // any later tick — escalation never walks back down the ladder.
  assert.equal(selectDueStage(ladder, 40, new Set(["c"]), 0), null);
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b"]), 0), null);
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b", "a"]), 0), null);
  // A sent middle rung still lets a higher crossed rung fire…
  assert.equal(selectDueStage(ladder, 40, new Set(["b"]), 0)?.id, "c");
  assert.equal(selectDueStage(ladder, 20, new Set(["b"]), 0), null);
  // …and a crossed stage whose send FAILED leaves no sent row, so it is
  // simply unfired and retries instead of being skipped.
  assert.equal(selectDueStage(ladder, 40, new Set(), 0)?.id, "c");
});

test("selectDueStage returns null before the first threshold", () => {
  const future = [stage("x", 1, 7)];
  assert.equal(selectDueStage(future, 3, new Set(), 0), null);
});

test("overdue days cross 0099/0100 and select the due rung, not silence", () => {
  // daysBetween used Date.UTC, which maps years 0-99 onto 1900-1999: a due
  // date of 0099-12-25 read as ~-694,000 days overdue, so no rung's threshold
  // was crossed and the invoice went quiet instead of escalating.
  assert.equal(daysBetween("0099-12-25", "0100-01-07"), 13);
  const overdue = daysBetween("0099-12-25", "0100-01-07");
  assert.equal(selectDueStage(ladder, overdue, new Set(), 0)?.id, "a");
  assert.equal(selectDueStage(courtesyLadder, overdue, new Set(), 0)?.id, "due");
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

test("dunning defers mail through the durable outbox inside the staged-claim transaction", () => {
  const source = readFileSync(new URL("./dunning.ts", import.meta.url), "utf8");
  // A direct Redis enqueue commits outside Postgres: a rolled-back or crashed
  // tick left mail queued against a staged claim that never existed, and the
  // next tick fired the same rung again — the customer got the letter twice.
  // The rendered notice must instead ride this org's transaction through the
  // durable scheduler_outbox (enqueueFlowEmail), keyed by the round identity
  // so replays collapse onto one row, and no direct queue call may remain.
  assert.match(source, /import \{ enqueueFlowEmail, SCHEDULER_OUTBOX_RETRY_HORIZON_MS \} from "\.\.\/scheduling\/outbox\.ts";/);
  assert.match(source, /enqueueFlowEmail\(\{/);
  // Fresh claims defer under the rung's base identity…
  assert.match(source, /let occurrenceKey = `dunning:\$\{doc\.id\}:\$\{stage\.id\}`/);
  // …every re-arm rotates the key with its own re-arm time, so a retry never
  // collapses onto a dead outbox row and reports delivery without sending…
  assert.match(source, /occurrenceKey = `dunning:\$\{doc\.id\}:\$\{stage\.id\}:\$\{/);
  // …the claim id rides in the outbox meta for the worker's verdict…
  assert.match(source, /dunningLogId: claimId/);
  // …and the runner never settles a claim to sent: queueing is not delivery.
  assert.doesNotMatch(source, /settleClaim\("sent"/);
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
 * billing address when a test wants the suppressed path. Returns the ids the
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
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${opts.documentNumber},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${opts.dueDate ?? "2026-06-01"},
            'CAD', '1', '100', '0', '100', ${userId})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')
  `);
  await db.execute(sql`
    update documents
       set status = 'approved', updated_at = now()
     where id = ${invoiceId} and org_id = ${org.orgId}
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

/**
 * Durable email evidence for a dunning claim, as the email worker would have
 * left it: one email_log row per delivery identity, each carrying the claim
 * id in its meta. `status` is the row verdict and `attempts` its lineage.
 */
async function seedDunningEmailEvidence(
  org: ScratchOrg,
  claimId: string,
  rows: { key: string; status: string; attempts: { attempt: number; outcome: string; detail: string }[] }[],
): Promise<void> {
  for (const row of rows) {
    // Delivery keys honor the email_log format guard (obem_<40-hex>, one
    // distinct identity per delivery) exactly as the worker derives them.
    const deliveryKey = `obem_${createHash("sha256").update(row.key).digest("hex").slice(0, 40)}`;
    await db.execute(sql`
      insert into email_log (org_id, delivery_key, provider, recipients, recipient_primary,
                             subject, status, category_key, meta)
      values (${org.orgId}, ${deliveryKey}, 'test', '["billing@acme.test"]'::jsonb, 'billing@acme.test',
              'Reminder', ${row.status}, 'dunning',
              ${JSON.stringify({
                category: "dunning",
                dunningLogId: claimId,
                attempts: row.attempts.map((a) => ({ ...a, at: new Date().toISOString() })),
              })}::jsonb)
    `);
  }
}

async function dunningClaim(invoiceId: string): Promise<{ id: string; status: string; detail: string | null }> {
  const row = (
    await db.execute<{ id: string; status: string; detail: string | null }>(sql`
      select id, status, detail from dunning_log where document_id = ${invoiceId}
    `)
  ).rows[0]!;
  return { id: row.id, status: row.status, detail: row.detail };
}

async function ageDunningClaim(claimId: string): Promise<void> {
  await db.execute(sql`
    update dunning_log set updated_at = now() - interval '24 hours' where id = ${claimId}
  `);
}

test("a fired dunning stage commits its staged claim and its mail deferral together", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, stageId, documentNumber } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });

    const first = await runDunning("2026-07-10");
    assert.equal(first.sent, 1);
    assert.deepEqual(first.notices.map((n) => n.status), ["staged"]);

    // The claim and the deferred delivery are one committed pair: exactly one
    // staged claim row AND exactly one flow_email outbox row for the rung,
    // carrying the same rendered letter. Queueing is not delivery, so the
    // claim stays staged for the email worker's verdict. Nothing touched
    // Redis on this path — the suite runs with no broker reachable at all.
    const { logRows, outboxRows } = await stagedNotice(invoiceId);
    assert.equal(logRows.length, 1);
    assert.equal((logRows[0] as { status: string }).status, "staged");
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

    // The next scheduler tick defers exactly once: one staged claim and one
    // outbox letter — never a second copy of the letter.
    const retry = await runDunning("2026-07-10");
    assert.equal(retry.sent, 1);
    const paired = await stagedNotice(invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal(paired.outboxRows.length, 1);
    assert.equal(paired.outboxRows[0]!.occurrenceKey, `dunning:${invoiceId}:${stageId}`);

    // Committed means committed: the lifecycle guard rejects tampering with
    // the staged claim — even a detail-only write that leaves the status
    // untouched. Only the email worker's verdict transitions may move it.
    // The guard yields to the test harness's RLS bypass, so the write must
    // be attempted in a production-posture org transaction (bypass off) to
    // reach it at all.
    await assert.rejects(
      () =>
        withOrg(org.orgId, () =>
          db.execute(sql`update dunning_log set detail = 'tampered' where document_id = ${invoiceId}`),
        ),
      (error: unknown) => errorChainMatches(error, /transition staged to staged is refused/),
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

test("an unsendable dunning notice leaves suppressed evidence and retries once healed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: null,
    });

    // No billing email: the attempt is suppressed, never silent — one
    // suppressed claim names the cause, and nothing is queued.
    const first = await runDunning("2026-07-10");
    assert.deepEqual(first.notices.map((n) => n.status), ["suppressed"]);
    const suppressed = await stagedNotice(invoiceId);
    assert.equal(suppressed.logRows.length, 1);
    assert.equal((suppressed.logRows[0] as { status: string }).status, "suppressed");
    assert.equal(
      (suppressed.logRows[0] as { detail: string }).detail,
      "no billing email on the customer record",
    );
    assert.equal(suppressed.outboxRows.length, 0, "no queued mail without a deliverable letter");

    // The rung stays open: once the address exists, the next tick re-arms
    // the suppressed claim and delivers — still exactly one row and one
    // letter for the rung, with the healed address on the evidence.
    await db.execute(sql`
      update parties set email = 'billing@acme.test' where id = ${org.customerId} and org_id = ${org.orgId}
    `);
    const second = await runDunning("2026-07-10");
    assert.deepEqual(second.notices.map((n) => n.status), ["staged"]);
    const paired = await stagedNotice(invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal((paired.logRows[0] as { status: string }).status, "staged");
    assert.equal((paired.logRows[0] as { to_email: string }).to_email, "billing@acme.test");
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

test("only dunnable receivable kinds may be configured as a policy target", () => {
  assert.equal(isDunnableDocumentKind("customer_invoice"), true);
  for (const kind of ["vendor_bill", "vendor_credit", "customer_credit", "journal_entry", "", "CUSTOMER_INVOICE"]) {
    assert.equal(isDunnableDocumentKind(kind), false, kind);
  }
});

test("a policy pointed at a payable kind never duns the vendor", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // The column is bare text; a policy row aimed at vendor bills must be
    // ignored by the runner (fail closed), not turned into vendor mail.
    await db.execute(sql`
      update parties set email = 'ap@supplier.test' where id = ${org.vendorId} and org_id = ${org.orgId}
    `);
    const policyId = randomUUID();
    await db.execute(sql`
      insert into dunning_policies (id, org_id, name, applies_to_kind, grace_period_days, min_balance)
      values (${policyId}, ${org.orgId}, 'Mis-targeted', 'vendor_bill', 0, '0')
    `);
    await db.execute(sql`
      insert into dunning_stages
        (id, org_id, policy_id, sequence, name, offset_days, subject_template, body_template)
      values (${randomUUID()}, ${org.orgId}, ${policyId}, 1, 'First reminder', 0,
              'Reminder: {{invoice}}', 'Hi {{party}}, {{amount}} on {{invoice}} was due {{dueDate}}.')
    `);
    const userId = await createScratchUser(org.orgId, "Dunning Tester", "accountant");
    const billId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-${randomUUID().slice(0, 8)}`},
              ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, '2026-06-01',
              'CAD', '1', '100', '0', '100', ${userId})
    `);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '100', '100', '0', '0')
    `);
    await db.execute(sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
    await postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

    const run = await runDunning("2026-07-10");
    assert.equal(run.sent, 0);
    assert.equal(run.scanned, 0, "a non-dunnable policy must not scan documents at all");
    const notice = await stagedNotice(billId);
    assert.equal(notice.logRows.length, 0);
    assert.equal(notice.outboxRows.length, 0);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

/** One ladder per scenario, each in its own org: policies scan every invoice
 * of their kind, so two ladders sharing an org would dun each other's
 * invoices instead of isolating the rung under test. */
function threeRungLadder() {
  return [1, 2, 3].map((sequence) => ({
    id: randomUUID(),
    sequence,
    offsetDays: [0, 15, 30][sequence - 1]!,
    name: `Stage ${sequence}`,
  }));
}

test("a 40-days-late invoice sends the top rung once and later ticks send nothing lower", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const stages = threeRungLadder();
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
      dueDate: "2026-06-01",
      stages,
    });
    const [s1, s2, s3] = stages.map((s) => s.id);

    // Tick 1, 40 days late: the top rung fires once — not the lower rungs.
    const first = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(first.sent, 1);
    assert.deepEqual(first.notices.map((n) => n.stageId), [s3]);
    let staged = await stagedNotice(invoiceId);
    assert.equal(staged.logRows.length, 1);
    assert.equal(staged.outboxRows.length, 1);

    // Later ticks send nothing lower: the fired top rung supersedes rungs 1-2.
    const second = await runDunningForOrg(org.orgId, "2026-07-12");
    assert.equal(second.sent, 0);
    assert.deepEqual(second.notices, []);
    const third = await runDunningForOrg(org.orgId, "2026-07-13");
    assert.equal(third.sent, 0);
    assert.deepEqual(third.notices, []);
    staged = await stagedNotice(invoiceId);
    assert.equal(staged.logRows.length, 1);
    assert.equal(staged.outboxRows.length, 1);
    assert.ok(s1 && s2, "lower rungs stay unrecorded");
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a failed top-rung send retries the same rung once healed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A misconfigured reply-to fails payload validation before any SQL runs,
    // so the send fails gracefully with a failed (never sent) claim row and
    // a clean transaction — then healing the reply-to lets the next tick
    // re-arm that claim and deliver exactly once.
    const stages = threeRungLadder();
    const seeded = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
      dueDate: "2026-06-01",
      stages,
    });
    const s3 = stages[2]!.id;
    await db.execute(sql`
      update dunning_policies set reply_to = 'not-an-address'
       where id = ${seeded.policyId} and org_id = ${org.orgId}
    `);
    const failed = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(failed.sent, 0);
    assert.equal(failed.failed, 1);
    assert.deepEqual(failed.notices.map((n) => [n.documentId, n.stageId, n.status]), [[seeded.invoiceId, s3, "failed"]]);
    const witnessed = await stagedNotice(seeded.invoiceId);
    assert.equal(witnessed.logRows.length, 1);
    assert.equal((witnessed.logRows[0] as { status: string }).status, "failed");
    assert.ok(
      (witnessed.logRows[0] as { detail: string }).detail?.length > 0,
      "a failed send names its cause on the evidence row",
    );
    assert.equal(witnessed.outboxRows.length, 0);
    await db.execute(sql`
      update dunning_policies set reply_to = null
       where id = ${seeded.policyId} and org_id = ${org.orgId}
    `);
    const retried = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(retried.sent, 1);
    assert.deepEqual(retried.notices.map((n) => n.stageId), [s3]);
    assert.deepEqual(retried.notices.map((n) => n.status), ["staged"]);
    const paired = await stagedNotice(seeded.invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal((paired.logRows[0] as { status: string }).status, "staged");
    assert.equal(paired.outboxRows.length, 1);
    const retryKey = paired.outboxRows[0]!.occurrenceKey;
    assert.ok(
      retryKey.startsWith(`dunning:${seeded.invoiceId}:${s3}:`),
      `re-armed retry must rotate the occurrence key, got ${retryKey}`,
    );
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("the fired set counts only sent delivery rows", () => {
  const source = readFileSync(new URL("./dunning.ts", import.meta.url), "utf8");
  // selectDueStage's fired set must admit successful sends and nothing else:
  // a crossed stage whose send failed — or was suppressed for want of a
  // billing email — leaves no sent row, so it stays eligible and retries.
  // Failed and suppressed delivery rows must never enter this set.
  assert.match(
    source,
    /select stage_id as "stageId" from dunning_log\s+where document_id = \$\{doc\.id\} and org_id = \$\{orgId\} and status = 'sent'/,
  );
});

test("the dunning log guard enforces the delivery state machine", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const seeded = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
      dueDate: "2026-06-01",
    });
    // Every write below runs in a production-posture org transaction
    // (bypass off) so the guard — not the harness bypass — arbitrates.
    // Each claim takes its own stage slot: one row per (document, stage).
    const openClaim = async (status: string): Promise<string> =>
      (
        await withOrg(org.orgId, () =>
          db.execute<{ id: string }>(sql`
            insert into dunning_log (org_id, document_id, policy_id, stage_id, status)
            values (${org.orgId}, ${seeded.invoiceId}, ${seeded.policyId}, ${randomUUID()}, ${status})
            returning id
          `),
        )
      ).rows[0]!.id;
    const move = (id: string, status: string) =>
      withOrg(org.orgId, () =>
        db.execute(sql`update dunning_log set status = ${status} where id = ${id} and org_id = ${org.orgId}`),
      );

    // The send attempt settles a staged claim to each outcome…
    for (const outcome of ["sent", "failed", "suppressed"]) {
      await move(await openClaim("staged"), outcome);
    }
    // …the runner re-arms failed and suppressed claims for retry…
    await move(await openClaim("failed"), "staged");
    await move(await openClaim("suppressed"), "staged");

    // …and everything else is refused by name. Sent rows are terminal, even
    // for a detail-only write that leaves the status untouched…
    const sentId = await openClaim("staged");
    await move(sentId, "sent");
    await assert.rejects(
      () => move(sentId, "failed"),
      (error: unknown) => errorChainMatches(error, /terminal delivery evidence/),
    );
    await assert.rejects(
      () =>
        withOrg(org.orgId, () =>
          db.execute(sql`update dunning_log set detail = 'tampered' where id = ${sentId}`),
        ),
      (error: unknown) => errorChainMatches(error, /terminal delivery evidence/),
    );
    // …settled skipped history never re-arms…
    await assert.rejects(
      async () => move(await openClaim("skipped"), "staged"),
      (error: unknown) => errorChainMatches(error, /terminal delivery evidence/),
    );
    // …a failed claim cannot jump to sent without re-arming first…
    await assert.rejects(
      async () => move(await openClaim("failed"), "sent"),
      (error: unknown) => errorChainMatches(error, /transition failed to sent is refused/),
    );
    // …a suppressed claim cannot fail without a fresh staged attempt…
    await assert.rejects(
      async () => move(await openClaim("suppressed"), "failed"),
      (error: unknown) => errorChainMatches(error, /transition suppressed to failed is refused/),
    );
    // …and rows are never deleted.
    await assert.rejects(
      () =>
        withOrg(org.orgId, () =>
          db.execute(sql`delete from dunning_log where id = ${sentId} and org_id = ${org.orgId}`),
        ),
      (error: unknown) => errorChainMatches(error, /DELETE is refused/),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a staged claim blocks a second enqueue for the same rung", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, policyId, stageId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
      dueDate: "2026-06-01",
    });
    // A rival tick claimed the due rung and has not settled yet: this tick
    // must neither enqueue a second letter nor touch the rival's claim.
    await db.execute(sql`
      insert into dunning_log (org_id, document_id, policy_id, stage_id, status)
      values (${org.orgId}, ${invoiceId}, ${policyId}, ${stageId}, 'staged')
    `);
    const run = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(run.sent, 0);
    assert.deepEqual(run.notices, []);
    const { logRows, outboxRows } = await stagedNotice(invoiceId);
    assert.equal(logRows.length, 1);
    assert.equal((logRows[0] as { status: string }).status, "staged");
    assert.equal(outboxRows.length, 0, "no second letter while a claim is in flight");
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("the runner leaves the claim staged and stamps its id in the outbox meta", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, stageId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });

    // Queueing is not delivery: the tick stages the claim and defers the
    // letter, and the provider verdict arrives later through the email
    // worker. Counting this tick's letter as sent would retire the rung
    // before the provider ever saw it.
    const first = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(first.sent, 1);
    assert.deepEqual(first.notices.map((n) => n.status), ["staged"]);

    const claims = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from dunning_log where document_id = ${invoiceId}
    `)).rows;
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.status, "staged");

    // The worker settles the claim from the outbox payload, so the payload
    // must carry the claim it belongs to.
    const { outboxRows } = await stagedNotice(invoiceId);
    assert.equal(outboxRows.length, 1);
    const meta = (outboxRows[0]!.payload as { meta?: Record<string, string> }).meta ?? {};
    assert.equal(meta.category, "dunning");
    assert.equal(meta.dunningLogId, claims[0]!.id);
    assert.equal(outboxRows[0]!.occurrenceKey, `dunning:${invoiceId}:${stageId}`);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("two ticks while a claim is staged enqueue exactly one letter", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });

    // The first tick stages the claim; the second must see the live staged
    // row and enqueue nothing — the single deferred letter is still awaiting
    // its provider verdict.
    const first = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(first.sent, 1);
    const second = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(second.sent, 0);
    assert.deepEqual(second.notices, []);

    const { logRows, outboxRows } = await stagedNotice(invoiceId);
    assert.equal(logRows.length, 1);
    assert.equal((logRows[0] as { status: string }).status, "staged");
    assert.equal(outboxRows.length, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a failed rung re-arms onto a new occurrence key", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const seeded = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await db.execute(sql`
      update dunning_policies set reply_to = 'not-an-address'
       where id = ${seeded.policyId} and org_id = ${org.orgId}
    `);
    const failed = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(failed.failed, 1);
    assert.equal((await stagedNotice(seeded.invoiceId)).outboxRows.length, 0);

    // Healing the cause re-arms the failed claim — but the retry must defer
    // under a FRESH occurrence key. Reusing the rung's base key would
    // collapse onto a dead outbox row (or a live one from an earlier round)
    // and report delivery without sending anything.
    await db.execute(sql`
      update dunning_policies set reply_to = null
       where id = ${seeded.policyId} and org_id = ${org.orgId}
    `);
    const retried = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(retried.sent, 1);
    const paired = await stagedNotice(seeded.invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal((paired.logRows[0] as { status: string }).status, "staged");
    assert.equal(paired.outboxRows.length, 1);
    const key = paired.outboxRows[0]!.occurrenceKey;
    assert.ok(key.startsWith(`dunning:${seeded.invoiceId}:${seeded.stageId}:`), `retry must rotate the key, got ${key}`);
    assert.notEqual(key, `dunning:${seeded.invoiceId}:${seeded.stageId}`);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an abandoned staged claim is re-armed by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId, stageId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await runDunningForOrg(org.orgId, "2026-07-10");
    const base = `dunning:${invoiceId}:${stageId}`;

    // The deferred letter's outbox row died without the worker ever settling
    // the claim (crashed drain, exhausted retries): the staged row is older
    // than any outbox retry horizon, so it must not block the rung forever.
    await db.execute(sql`
      update dunning_log set updated_at = now() - interval '24 hours'
       where document_id = ${invoiceId} and stage_id = ${stageId}
    `);
    const reaquired = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(reaquired.sent, 1);

    const { logRows, outboxRows } = await stagedNotice(invoiceId);
    assert.equal(logRows.length, 1);
    assert.equal((logRows[0] as { status: string }).status, "staged");
    assert.match((logRows[0] as { detail: string }).detail ?? "", /abandon/i);
    assert.equal(outboxRows.length, 2);
    const keys = outboxRows.map((r) => r.occurrenceKey).sort();
    assert.equal(keys[0], base);
    assert.ok(keys[1]!.startsWith(`${base}:`), `re-arm must rotate the key, got ${keys[1]}`);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an accepted letter with a lost claim-settle is reconciled sent, never re-sent", { skip: !DB }, async () => {
  // Defect path A end to end: the provider accepted the letter and the
  // worker recorded the acceptance in email_log, but the staged→sent claim
  // write was lost (and the worker's retries exhausted the same way), so
  // the claim sits staged past the outbox retry horizon. The next tick must
  // settle it sent from the delivery evidence — exactly one letter ever
  // deferred, never a second send under a fresh identity.
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await runDunningForOrg(org.orgId, "2026-07-10");
    const claim = await dunningClaim(invoiceId);
    assert.equal(claim.status, "staged");

    await seedDunningEmailEvidence(org, claim.id, [
      {
        key: `test-dunning-accept:${claim.id}`,
        status: "sent",
        attempts: [{ attempt: 1, outcome: "sent", detail: "provider-1" }],
      },
    ]);
    await ageDunningClaim(claim.id);

    const second = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(second.sent, 0);
    assert.equal(second.failed, 0);
    const { logRows, outboxRows } = await stagedNotice(invoiceId);
    assert.equal(outboxRows.length, 1, "the accepted letter must never defer a second time");
    assert.equal(logRows.length, 1);
    assert.equal((await dunningClaim(invoiceId)).status, "sent");
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await db.execute(sql`delete from email_log where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an uncertain delivery past the horizon is held staged, never re-sent", { skip: !DB }, async () => {
  // The provider may already have accepted the first letter — its outcome
  // is unresolved — so re-arming would risk a duplicate collections letter,
  // which is worse than a delayed one. The claim stays staged with the
  // reconciliation need named on it, and no second letter defers.
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await runDunningForOrg(org.orgId, "2026-07-10");
    const claim = await dunningClaim(invoiceId);

    await seedDunningEmailEvidence(org, claim.id, [
      {
        key: `test-dunning-uncertain:${claim.id}`,
        status: "uncertain",
        attempts: [{ attempt: 1, outcome: "uncertain", detail: "acceptance state unresolved: provider timeout" }],
      },
    ]);
    await ageDunningClaim(claim.id);

    const second = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(second.sent, 0);
    assert.equal(second.failed, 0);
    const { logRows, outboxRows } = await stagedNotice(invoiceId);
    assert.equal(outboxRows.length, 1, "an unresolved letter must never defer a second time");
    assert.equal(logRows.length, 1);
    const held = await dunningClaim(invoiceId);
    assert.equal(held.status, "staged");
    assert.match(held.detail ?? "", /reconciliation/);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await db.execute(sql`delete from email_log where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("an acceptance under an older occurrence key settles the claim", { skip: !DB }, async () => {
  // The claim re-armed once (its first delivery definitively failed), then
  // the retry's letter was accepted but that settle was lost. The evidence
  // read must span every occurrence key the claim ever used: the older
  // key's failure must not shadow the newer key's acceptance, and no third
  // letter may defer.
  const org = await createScratchOrg();
  try {
    const seeded = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await runDunningForOrg(org.orgId, "2026-07-10");
    const claim = await dunningClaim(seeded.invoiceId);

    await seedDunningEmailEvidence(org, claim.id, [
      {
        key: `test-dunning-old-fail:${claim.id}`,
        status: "failed",
        attempts: [{ attempt: 1, outcome: "notSent", detail: "550 mailbox unavailable" }],
      },
    ]);
    await db.execute(sql`
      update dunning_log set status = 'failed', detail = '550 mailbox unavailable'
       where id = ${claim.id} and org_id = ${org.orgId}
    `);
    const retried = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(retried.sent, 1);
    assert.equal((await stagedNotice(seeded.invoiceId)).outboxRows.length, 2);

    await seedDunningEmailEvidence(org, claim.id, [
      {
        key: `test-dunning-new-accept:${claim.id}`,
        status: "sent",
        attempts: [{ attempt: 1, outcome: "sent", detail: "provider-2" }],
      },
    ]);
    await ageDunningClaim(claim.id);

    const third = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(third.sent, 0);
    const { logRows, outboxRows } = await stagedNotice(seeded.invoiceId);
    assert.equal(outboxRows.length, 2, "the accepted retry must never defer a third letter");
    assert.equal(logRows.length, 1);
    assert.equal((await dunningClaim(seeded.invoiceId)).status, "sent");
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await db.execute(sql`delete from email_log where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a claim whose deliveries all definitively failed still re-arms", { skip: !DB }, async () => {
  // The evidence gate must keep the existing retry behaviour: a letter the
  // provider definitively rejected (with the failure recorded in email_log,
  // as the worker leaves it) re-arms past the horizon and sends once more.
  const org = await createScratchOrg();
  try {
    const seeded = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await runDunningForOrg(org.orgId, "2026-07-10");
    const claim = await dunningClaim(seeded.invoiceId);

    await seedDunningEmailEvidence(org, claim.id, [
      {
        key: `test-dunning-fail:${claim.id}`,
        status: "failed",
        attempts: [{ attempt: 1, outcome: "notSent", detail: "550 mailbox unavailable" }],
      },
    ]);
    await db.execute(sql`
      update dunning_log set status = 'failed', detail = '550 mailbox unavailable'
       where id = ${claim.id} and org_id = ${org.orgId}
    `);
    await ageDunningClaim(claim.id);

    const retried = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(retried.sent, 1);
    const { logRows, outboxRows } = await stagedNotice(seeded.invoiceId);
    assert.equal(logRows.length, 1);
    assert.equal((logRows[0] as { status: string }).status, "staged");
    assert.equal(outboxRows.length, 2);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await db.execute(sql`delete from email_log where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("provider acceptance settles a staged claim to sent and retires the rung", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await runDunningForOrg(org.orgId, "2026-07-10");
    const claimId = (
      await db.execute<{ id: string }>(sql`
        select id from dunning_log where document_id = ${invoiceId}
      `)
    ).rows[0]!.id;

    // The email worker's acceptance is the only writer that may move a
    // staged claim to sent — the runner never does.
    assert.equal(await markDunningClaimSent(org.orgId, claimId), true);
    const settled = (
      await db.execute<{ status: string }>(sql`
        select status from dunning_log where id = ${claimId}
      `)
    ).rows[0]!;
    assert.equal(settled.status, "sent");

    // Replayed acceptance is success, not a failure: crash-gap worker
    // retries reconcile onto the same verdict.
    assert.equal(await markDunningClaimSent(org.orgId, claimId), true);

    // The rung is retired: the fired set counts only sent rows, so no later
    // tick re-fires it.
    const again = await runDunningForOrg(org.orgId, "2026-07-11");
    assert.equal(again.sent, 0);
    assert.deepEqual(again.notices, []);
    assert.equal((await stagedNotice(invoiceId)).outboxRows.length, 1);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("provider rejection settles a staged claim to failed and the next tick retries", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const seeded = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    await runDunningForOrg(org.orgId, "2026-07-10");
    const first = await stagedNotice(seeded.invoiceId);
    const claimId = (first.logRows[0] as { id: string }).id;
    const firstKey = first.outboxRows[0]!.occurrenceKey;

    // The worker records the provider's rejection on the claim — the detail
    // names what the provider said, and the rung stays out of the fired set.
    assert.equal(await markDunningClaimFailed(org.orgId, claimId, "550 mailbox unavailable"), true);
    const rejected = (
      await db.execute<{ status: string; detail: string }>(sql`
        select status, detail from dunning_log where id = ${claimId}
      `)
    ).rows[0]!;
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.detail, "550 mailbox unavailable");

    // The settle is staged-only and idempotent: terminal rows never move,
    // and unknown rows are reported, never silently accepted.
    assert.equal(await markDunningClaimFailed(org.orgId, claimId), true);
    assert.equal(await markDunningClaimSent(org.orgId, claimId), false);
    assert.equal(await markDunningClaimSent(org.orgId, randomUUID()), false);
    assert.equal(await markDunningClaimFailed(org.orgId, randomUUID(), "nope"), false);

    // The next tick re-arms the failed claim onto a fresh occurrence key —
    // the dead round's outbox row is never mistaken for delivery.
    const retried = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(retried.sent, 1);
    const paired = await stagedNotice(seeded.invoiceId);
    assert.equal(paired.logRows.length, 1);
    assert.equal((paired.logRows[0] as { status: string }).status, "staged");
    assert.equal(paired.outboxRows.length, 2);
    const keys = paired.outboxRows.map((r) => r.occurrenceKey);
    assert.ok(keys.includes(firstKey));
    const retryKey = keys.find((k) => k !== firstKey)!;
    assert.ok(retryKey.startsWith(`${firstKey}:`), `retry must rotate the key, got ${retryKey}`);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("a dunning reminder escapes party-controlled values in its HTML part", { skip: !DB }, async () => {
  // Template vars (party name, document number) are free-text rows an
  // insider — or a tainted import — controls. The text part carries them
  // raw, but the HTML part must escape them: otherwise a customer name like
  // the one below ships arbitrary markup to the customer's inbox from the
  // org's own authenticated mail domain.
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      update parties set display_name = '<img src=x onerror=alert(1)>'
       where id = ${org.customerId} and org_id = ${org.orgId}
    `);
    const { invoiceId } = await seedDunnableInvoice(org, {
      documentNumber: `DUN-${randomUUID().slice(0, 8)}`,
      email: "billing@acme.test",
    });
    const run = await runDunningForOrg(org.orgId, "2026-07-10");
    assert.equal(run.sent, 1);
    const { outboxRows } = await stagedNotice(invoiceId);
    assert.equal(outboxRows.length, 1);
    const payload = outboxRows[0]!.payload as { html: string; text: string };
    assert.doesNotMatch(payload.html, /<img src=x onerror/);
    assert.match(payload.html, /&lt;img/);
    assert.match(payload.text, /<img src=x onerror/);
  } finally {
    await db.execute(sql`delete from scheduler_outbox where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
