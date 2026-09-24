import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { seedAdoption, calculatedRun } from "./filing-test-fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { requestDocumentVoid, type DocumentVoidResult } from "../ledger/document-void.ts";
import { createRetroPayRun, proposeRetroPay } from "./retro-store.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedPostedSource() {
  const fx = await seedAdoption();
  const { input } = await calculatedRun(fx);
  await commitPayRun(input);
  const accounts = (
    await db.execute<{ id: string; type: string }>(sql`
      select id, type from accounts where org_id = ${fx.orgId}`)
  ).rows;
  const account = (type: string) => {
    const id = accounts.find((row) => row.type === type)?.id;
    assert.ok(id, `fixture account ${type}`);
    return id;
  };
  const control = {
    ar: account("asset_receivable"),
    ap: account("liability_payable"),
    bank: account("asset_bank"),
  };
  await db.execute(sql`update documents set status = 'approved'
    where org_id = ${fx.orgId} and id = ${input.documentId}`);
  await postDocument(input.documentId, { control });
  return { fx, input, control };
}

async function backdateRaise(fx: { orgId: string; employeeId: string; actorId: string }) {
  await db.execute(sql`
    update labor_cost_rates set effective_to = '2026-06-30', updated_at = now()
     where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}
       and effective_from = '2020-01-01'`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, 'CAD', '33', 'hour', '2026-07-01', true,
            ${fx.actorId}, ${fx.actorId})`);
}

async function seedSourceAndCommittedTopUp() {
  const seeded = await seedPostedSource();
  const { fx } = seeded;
  await backdateRaise(fx);
  const proposal = await proposeRetroPay({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    payDate: "2026-08-20",
    allowedSubsidiaryIds: null,
  });
  assert.equal(
    proposal.periods.filter((p) => p.outcome === "payable").length,
    1,
    "one payable retro period",
  );
  assert.equal(proposal.payableTotal, "24.0000", "8 h x $3.00");
  const retro = await createRetroPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    payDate: "2026-08-20",
    allowedSubsidiaryIds: null,
  });
  assert.deepEqual((await calculatePayRun({
    orgId: fx.orgId,
    documentId: retro.documentId,
    actorId: fx.actorId,
  })).errors, []);
  await commitPayRun({ orgId: fx.orgId, documentId: retro.documentId, actorId: fx.actorId });
  return { ...seeded, retro };
}

async function committedSettledTotal(orgId: string, sourceDocumentId: string) {
  return (await db.execute<{ settled: string | null }>(sql`
    select sum(a.amount)::text as settled
      from payroll_retro_allocations a
      join payroll_retro_settlements st on st.id = a.settlement_id and st.org_id = a.org_id
      join pay_runs rr on rr.document_id = st.retro_pay_run_document_id
        and rr.org_id = st.org_id
     where st.org_id = ${orgId}
       and st.source_pay_run_document_id = ${sourceDocumentId}
       and rr.run_status = 'committed'`)).rows[0]?.settled ?? null;
}

test(
  "voiding a source run with a committed retro settlement is refused and changes nothing",
  { skip: !DB },
  async () => {
    const { fx, input, retro } = await seedSourceAndCommittedTopUp();
    try {
      const retroNumber = (await db.execute<{ document_number: string }>(sql`
        select document_number from documents
         where org_id = ${fx.orgId} and id = ${retro.documentId}`)).rows[0]!.document_number;
      const orgCounts = async () => (await db.execute<{ entries: string; audit: string }>(sql`
        select (select count(*)::text from journal_entries where org_id = ${fx.orgId}) as entries,
               (select count(*)::text from audit_log where org_id = ${fx.orgId}) as audit`)).rows[0]!;
      const before = await orgCounts();
      await assert.rejects(
        requestDocumentVoid({
          orgId: fx.orgId,
          documentId: input.documentId,
          actorId: fx.actorId,
          reason: "reissue this period in the correct batch",
          reversalDate: "2026-07-31",
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return message.includes("settled by committed retro pay run")
            && message.includes(retroNumber)
            && message.includes("void the retro run first");
        },
        "the refusal names the dependent retro run and its remedy",
      );
      const state = (await db.execute<{
        source_status: string; void_requested_at: string | null;
        source_run: string; retro_run: string; settled: string | null;
      }>(sql`
        select (select status from documents
                 where org_id = ${fx.orgId} and id = ${input.documentId}) as source_status,
               (select void_requested_at::text from documents
                 where org_id = ${fx.orgId} and id = ${input.documentId}) as void_requested_at,
               (select run_status from pay_runs
                 where org_id = ${fx.orgId} and document_id = ${input.documentId}) as source_run,
               (select run_status from pay_runs
                 where org_id = ${fx.orgId} and document_id = ${retro.documentId}) as retro_run,
               (select sum(a.amount)::text from payroll_retro_allocations a
                  join payroll_retro_settlements st on st.id = a.settlement_id and st.org_id = a.org_id
                  join pay_runs rr on rr.document_id = st.retro_pay_run_document_id
                    and rr.org_id = st.org_id
                 where st.org_id = ${fx.orgId}
                   and st.source_pay_run_document_id = ${input.documentId}
                   and rr.run_status = 'committed') as settled`)).rows[0]!;
      assert.deepEqual(await orgCounts(), before, "the refused void writes no journal or audit rows");
      assert.equal(state.source_status, "posted", "the source stays posted");
      assert.equal(state.void_requested_at, null, "no void claim survives the refusal");
      assert.equal(state.source_run, "committed", "the source stays committed");
      assert.equal(state.retro_run, "committed", "the top-up stays committed");
      assert.equal(state.settled, "24.0000", "its $24.00 still counts as settled");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a draft retro settlement does not block the source void",
  { skip: !DB },
  async () => {
    const { fx, input } = await seedPostedSource();
    try {
      await backdateRaise(fx);
      const retro = await createRetroPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        payDate: "2026-08-20",
        allowedSubsidiaryIds: null,
      });
      await requestDocumentVoid({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        reason: "reissue this period in the correct batch",
        reversalDate: "2026-07-31",
      });
      const state = (await db.execute<{ source_run: string; retro_run: string }>(sql`
        select (select run_status from pay_runs
                 where org_id = ${fx.orgId} and document_id = ${input.documentId}) as source_run,
               (select run_status from pay_runs
                 where org_id = ${fx.orgId} and document_id = ${retro.documentId}) as retro_run`)).rows[0]!;
      assert.equal(state.source_run, "voided", "the source voids");
      assert.equal(state.retro_run, "draft", "the uncommitted retro is untouched");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a source void waits for an in-flight retro commit and then refuses",
  { skip: !DB },
  async () => {
    const { fx, input } = await seedPostedSource();
    let releaseHolder!: () => void;
    let holder: Promise<unknown> | null = null;
    let voiding: Promise<DocumentVoidResult> | null = null;
    let voidingAsserted = false;
    try {
      await backdateRaise(fx);
      const retro = await createRetroPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        payDate: "2026-08-20",
        allowedSubsidiaryIds: null,
      });
      assert.deepEqual((await calculatePayRun({
        orgId: fx.orgId,
        documentId: retro.documentId,
        actorId: fx.actorId,
      })).errors, []);

      // A real in-flight commitPayRun, held uncommitted in this outer
      // transaction: its effects are in and its opening pay_runs row lock is
      // held, but nothing is visible until release. The void below must block
      // on that row and read the flip, not slip past it.
      const releaseGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      let lockResolve!: () => void;
      let lockReject!: (error: unknown) => void;
      const lockReady = new Promise<void>((resolve, reject) => {
        lockResolve = resolve;
        lockReject = reject;
      });
      holder = withOrgTransaction(fx.orgId, async () => {
        try {
          await commitPayRun({ orgId: fx.orgId, documentId: retro.documentId, actorId: fx.actorId });
        } catch (error) {
          lockReject(error);
          throw error;
        }
        lockResolve();
        await releaseGate;
      });
      await lockReady;
      voiding = requestDocumentVoid({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        reason: "reissue this period in the correct batch",
        reversalDate: "2026-07-31",
      });
      // Explicit gate, not a sleep: the void is only released once a backend
      // is observed blocked inside the guard query itself.
      for (let attempt = 0; ; attempt += 1) {
        const blocked = (await db.execute<{ blocked: boolean }>(sql`
          select exists (
            select 1 from pg_stat_activity
             where state = 'active' and wait_event_type = 'Lock'
               and position('for update of rr' in query) > 0
          ) as blocked`)).rows[0]?.blocked;
        if (blocked) break;
        if (attempt >= 600) throw new Error("source void did not reach the retro guard");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseHolder();
      assert.ok(voiding, "the void is in flight before release");
      await assert.rejects(
        voiding,
        /settled by committed retro pay run.*void the retro run first/,
        "the void waits out the commit and then refuses on its outcome",
      );
      voidingAsserted = true;
      await holder;
      const state = (await db.execute<{ source_status: string; source_run: string }>(sql`
        select (select status from documents
                 where org_id = ${fx.orgId} and id = ${input.documentId}) as source_status,
               (select run_status from pay_runs
                 where org_id = ${fx.orgId} and document_id = ${input.documentId}) as source_run`)).rows[0]!;
      assert.equal(state.source_status, "posted", "the source stays posted");
      assert.equal(state.source_run, "committed", "the source stays committed");
    } finally {
      releaseHolder?.();
      let holderError: unknown = null;
      let holderOk = holder === null;
      if (holder) {
        try {
          await holder;
          holderOk = true;
        } catch (error) {
          holderError = error;
        }
      }
      try {
        if (holderOk && voiding && !voidingAsserted) {
          await assert.rejects(voiding, /settled by committed retro pay run/);
        } else if (voiding) {
          // The commit premise broke, so the void's outcome asserts nothing;
          // consume it so teardown never leaves a dangling promise.
          await voiding.then(() => undefined, () => undefined);
        }
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
      if (!holderOk) throw holderError;
    }
  },
);

test(
  "voiding the retro run first unblocks the source void and the replacement pays exactly once",
  { skip: !DB },
  async () => {
    const { fx, input, control, retro } = await seedSourceAndCommittedTopUp();
    try {
      await db.execute(sql`update documents set status = 'approved'
        where org_id = ${fx.orgId} and id = ${retro.documentId}`);
      await requestDocumentVoid({
        orgId: fx.orgId,
        documentId: retro.documentId,
        actorId: fx.actorId,
        reason: "source period is being reissued",
        reversalDate: "2026-07-31",
      });
      assert.equal(
        (await db.execute<{ run_status: string }>(sql`
          select run_status from pay_runs
           where org_id = ${fx.orgId} and document_id = ${retro.documentId}`)).rows[0]!.run_status,
        "voided",
        "the retro top-up is retired",
      );
      assert.equal(
        await committedSettledTotal(fx.orgId, input.documentId),
        null,
        "no committed settlement counts against the source once the retro is voided",
      );
      await requestDocumentVoid({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: fx.actorId,
        reason: "reissue this period in the correct batch",
        reversalDate: "2026-07-31",
      });
      const replacement = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
        payDate: "2026-07-21",
      });
      const calculated = await calculatePayRun({
        orgId: fx.orgId,
        documentId: replacement.documentId,
        actorId: fx.actorId,
      });
      assert.deepEqual(calculated.errors, []);
      assert.equal(calculated.gross, "264.0000", "8 h x $33.00 full corrected base");
      await commitPayRun({ orgId: fx.orgId, documentId: replacement.documentId, actorId: fx.actorId });
      await db.execute(sql`update documents set status = 'approved'
        where org_id = ${fx.orgId} and id = ${replacement.documentId}`);
      await postDocument(replacement.documentId, { control });
      const paid = (await db.execute<{ total: string }>(sql`
        select sum(s.gross)::text as total from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${fx.orgId} and s.employee_party_id = ${fx.employeeId}
           and r.run_status = 'committed'`)).rows[0]!;
      assert.equal(paid.total, "264.0000", "$264.00 corrected base with no stranded top-up on top");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
