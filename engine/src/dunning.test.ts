import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
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
  assert.equal(selectDueStage(ladder, 40, new Set())?.id, "c");
  assert.equal(selectDueStage(ladder, 20, new Set())?.id, "b");
  assert.equal(selectDueStage(ladder, 3, new Set())?.id, "a");
});

test("selectDueStage never re-sends a stage already in the log", () => {
  assert.equal(selectDueStage(ladder, 40, new Set(["c"]))?.id, "b");
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b"]))?.id, "a");
  assert.equal(selectDueStage(ladder, 40, new Set(["c", "b", "a"])), null);
});

test("selectDueStage returns null before the first threshold", () => {
  const future = [stage("x", 1, 7)];
  assert.equal(selectDueStage(future, 3, new Set()), null);
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

/**
 * One overdue posted invoice under one active policy with a single stage at
 * offset 0. `email` nulls the billing address when a test wants the skipped
 * path. Returns the ids the assertions key on.
 */
async function seedOverdueInvoice(
  org: ScratchOrg,
  opts: { documentNumber: string; email: string | null },
): Promise<{ invoiceId: string; policyId: string; stageId: string; documentNumber: string }> {
  await db.execute(sql`
    update parties set email = ${opts.email} where id = ${org.customerId} and org_id = ${org.orgId}
  `);
  const policyId = randomUUID();
  await db.execute(sql`
    insert into dunning_policies (id, org_id, name, applies_to_kind, grace_period_days, min_balance)
    values (${policyId}, ${org.orgId}, 'Collections', 'customer_invoice', 0, '0')
  `);
  const stageId = randomUUID();
  await db.execute(sql`
    insert into dunning_stages
      (id, org_id, policy_id, sequence, name, offset_days, subject_template, body_template)
    values (${stageId}, ${org.orgId}, ${policyId}, 1, 'First reminder', 0,
            'Reminder: {{invoice}}',
            'Hi {{party}}, {{amount}} on {{invoice}} was due {{dueDate}} — {{daysOverdue}} days over. — {{orgName}}')
  `);
  const userId = await createScratchUser(org.orgId, "Dunning Tester", "accountant");
  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', ${opts.documentNumber},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, '2026-06-01', 'CAD', '1',
            '100', '0', '100', ${userId})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')
  `);
  await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  return { invoiceId, policyId, stageId, documentNumber: opts.documentNumber };
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
    const { invoiceId, stageId, documentNumber } = await seedOverdueInvoice(org, {
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

test("an unsendable dunning notice leaves both sides of the pair empty and retries later", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { invoiceId } = await seedOverdueInvoice(org, {
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
