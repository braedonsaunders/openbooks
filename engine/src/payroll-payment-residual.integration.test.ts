import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import { add, neg, sum } from "./money.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";
import { recordPayRunPayment } from "./payroll-payment.ts";
import { commitPayRun } from "./payroll-run.ts";
import { createPaymentDocument, postPaymentWithApplications, reversePaymentForReturn, sameCurrencyAllocation, updateDraftPayment } from "./payments.ts";
import { postDocument } from "./posting.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";

async function postedRun(mixed = false) {
  const fx = await seedAdoption();
  try {
    if (mixed) {
      for (const name of ["Already paid employee", "Unpaid employee"]) {
        const employeeId = randomUUID();
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active)
          values(${employeeId},${fx.orgId},'person',${name},true)`);
        await db.execute(sql`insert into employee_roles(org_id,party_id,hired_on,is_active,created_by,updated_by)
          select org_id,${employeeId},hired_on,is_active,created_by,updated_by from employee_roles
          where org_id=${fx.orgId} and party_id=${fx.employeeId}`);
        await db.execute(sql`insert into labor_cost_rates(org_id,employee_party_id,currency,rate,basis,effective_from,is_active,created_by,updated_by)
          select org_id,${employeeId},currency,rate,basis,effective_from,is_active,created_by,updated_by from labor_cost_rates
          where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
        await db.execute(sql`insert into employee_payroll_profiles(org_id,employee_party_id,pay_schedule_id,province,pay_basis,country,
          federal_claim_code,provincial_claim_code,vacation_percent,vacation_method,is_active,payment_method,created_by,updated_by)
          select org_id,${employeeId},pay_schedule_id,province,pay_basis,country,federal_claim_code,provincial_claim_code,
          vacation_percent,vacation_method,is_active,'cheque',created_by,updated_by from employee_payroll_profiles
          where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
        await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,costing_basis,created_by,updated_by)
          values(${fx.orgId},${employeeId},'2026-07-14',8,'approved',false,'unbilled','actual',${fx.actorId},${fx.actorId})`);
      }
      await db.execute(sql`update employee_payroll_profiles set payment_method='eft'
        where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
      await db.execute(sql`insert into party_bank_accounts(org_id,party_id,bank_name,country,currency,
        account_last_four,approval_status,is_active,created_by,updated_by)
        values(${fx.orgId},${fx.employeeId},'Test Bank','CA','CAD','1234','approved',true,${fx.actorId},${fx.actorId})`);
    }
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    const accounts = (await db.execute<{ id: string; type: string }>(sql`
      select id,type from accounts where org_id=${fx.orgId}`)).rows;
    const account = (type: string) => {
      const id = accounts.find((row) => row.type === type)?.id;
      assert.ok(id, `fixture account ${type}`);
      return id;
    };
    const bankAccountId = account("asset_bank");
    await db.execute(sql`update documents set status='approved' where org_id=${fx.orgId} and id=${input.documentId}`);
    await postDocument(input.documentId, {
      control: { ar: account("asset_receivable"), ap: account("liability_payable"), bank: bankAccountId },
    });
    const source = (await db.execute<{
      id: string; account_id: string; amount: string; txn_amount: string; fx_rate: string;
      currency: string; subsidiary_id: string; book_id: string; party_id: string;
    }>(sql`
      select jl.id,jl.account_id,jl.amount,jl.txn_amount,jl.fx_rate,jl.currency,jl.subsidiary_id,e.book_id,jl.party_id
      from documents d join journal_entries e on e.id=d.posted_entry_id and e.org_id=d.org_id
      join journal_lines jl on jl.entry_id=e.id and jl.org_id=e.org_id
      where d.org_id=${fx.orgId} and d.id=${input.documentId}
        and jl.party_id=${fx.employeeId} and jl.is_open_item and jl.amount<0`)).rows[0]!;
    assert.ok(source);
    return { ...fx, input, bankAccountId, source };
  } catch (error) {
    await dropScratchOrgReporting(fx.orgId);
    throw error;
  }
}

async function ordinaryPayment(fx: Awaited<ReturnType<typeof postedRun>>, amount: string, foreign = false) {
  return withOrgTransaction(fx.orgId, async () => {
    const payment = await createPaymentDocument({
      orgId: fx.orgId, createdBy: fx.actorId, kind: "vendor_payment", partyId: fx.employeeId,
      bankAccountId: fx.bankAccountId, subsidiaryId: fx.source.subsidiary_id,
      documentDate: "2026-07-21", currency: foreign ? "USD" : fx.source.currency,
      fxRate: foreign ? "1.3" : fx.source.fx_rate,
    });
    await updateDraftPayment(payment.id, {
      allocations: [foreign ? {
        openLineId: fx.source.id, sourceTransactionAmount: "40", targetTransactionAmount: amount,
        settlementRate: "1.25", settlementRateSource: "manual", settlementRateReference: "Agreed partial settlement",
      } : sameCurrencyAllocation(fx.source.id, amount)],
      controlAccountId: fx.source.account_id,
    }, fx.actorId, fx.orgId);
    const submission = await submitAndReleaseIfUngated("vendor_payment", payment.id, fx.actorId);
    assert.equal(submission.autoApproved, true);
    const posted = await postPaymentWithApplications(payment.id, undefined, fx.actorId, "ui", { deferEffects: true });
    return { ...posted, documentId: payment.id };
  });
}

test("payroll payment settles only the residual after an ordinary partial payment", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await postedRun();
  try {
    await ordinaryPayment(fx, "50");
    const prior = (await db.execute<{ amount: string; target_transaction_amount: string }>(sql`
      select amount,target_transaction_amount from applications
      where org_id=${fx.orgId} and to_line_id=${fx.source.id} and unapplied_at is null`)).rows;
    assert.deepEqual(prior, [{ amount: "50.0000", target_transaction_amount: "50.0000" }]);
    const payment = await recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId });
    assert.equal(payment.total, add(neg(fx.source.txn_amount), "-50"));
    const state = (await db.execute<{ applied: string; transaction_applied: string; balanced: boolean }>(sql`
      select sum(amount)::text as applied,sum(target_transaction_amount)::text as transaction_applied,
        (select sum(amount)=0 from journal_lines where org_id=${fx.orgId} and entry_id=${payment.entryId}) as balanced
      from applications where org_id=${fx.orgId} and to_line_id=${fx.source.id} and unapplied_at is null`)).rows[0]!;
    assert.deepEqual(state, { applied: neg(fx.source.amount), transaction_applied: neg(fx.source.txn_amount), balanced: true });
    await assert.rejects(() => recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId }), /already recorded as paid/);
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("payroll residual ignores controlled reversals of earlier payment applications", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await postedRun();
  try {
    const prior = await ordinaryPayment(fx, "50");
    await reversePaymentForReturn(prior.documentId, fx.orgId, "Payment returned by bank", fx.actorId, "2026-07-21");
    const reversed = (await db.execute<{ reversed: boolean }>(sql`
      select unapplied_at is not null as reversed from applications where org_id=${fx.orgId} and to_line_id=${fx.source.id}`)).rows;
    assert.deepEqual(reversed, [{ reversed: true }]);
    const payment = await recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId });
    assert.equal(payment.total, neg(fx.source.txn_amount));
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("payroll residual includes source-side credits created by the ordinary payment service", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await postedRun();
  try {
    // A receivable from the employee can be offset against their payroll
    // liability by the universal credit workpaper; no application is fabricated.
    const invoiceId = randomUUID();
    await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,
      document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
      values(${invoiceId},${fx.orgId},'customer_invoice','draft',${invoiceId},${fx.subsidiaryId},${fx.employeeId},
        '2026-07-21','CAD',1,100,0,100,${fx.actorId})`);
    const revenue = (await db.execute<{ id: string }>(sql`select id from accounts where org_id=${fx.orgId} and type='income' limit 1`)).rows[0]!;
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
      values(${fx.orgId},${invoiceId},1,${revenue.id},1,100,100,0,100)`);
    await db.execute(sql`update documents set status='approved' where org_id=${fx.orgId} and id=${invoiceId}`);
    const invoiceEntry = await postDocument(invoiceId, { control: { ar: fx.source.account_id, ap: fx.source.account_id, bank: fx.bankAccountId } });
    const target = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${fx.orgId}
      and entry_id=${invoiceEntry} and account_id=${fx.source.account_id} and amount>0`)).rows[0]!;
    await withOrgTransaction(fx.orgId, async () => {
      const receipt = await createPaymentDocument({ orgId: fx.orgId, createdBy: fx.actorId, kind: "customer_payment",
        partyId: fx.employeeId, bankAccountId: fx.bankAccountId, subsidiaryId: fx.subsidiaryId, documentDate: "2026-07-21", currency: "CAD" });
      await updateDraftPayment(receipt.id, {
        controlAccountId: fx.source.account_id,
        allocations: [sameCurrencyAllocation(target.id, "50")],
        creditAllocations: [{ fromLineId: fx.source.id, toLineId: target.id, amount: "50", sourceDocumentId: fx.input.documentId }],
      }, fx.actorId, fx.orgId);
      assert.equal((await submitAndReleaseIfUngated("customer_payment", receipt.id, fx.actorId)).autoApproved, true);
      await postPaymentWithApplications(receipt.id, undefined, fx.actorId, "ui", { deferEffects: true });
    });
    const prior = (await db.execute<{ source_amount: string; source_transaction_amount: string }>(sql`
      select source_amount,source_transaction_amount from applications where org_id=${fx.orgId} and from_line_id=${fx.source.id}`)).rows;
    assert.deepEqual(prior, [{ source_amount: "50.0000", source_transaction_amount: "50.0000" }]);
    const payment = await recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId });
    assert.equal(payment.total, add(neg(fx.source.txn_amount), "-50"));
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("payroll residual excludes fully settled employees, preserves rail splits, and serializes repeat calls", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await postedRun(true);
  try {
    const sources = (await db.execute<(typeof fx.source) & { display_name: string }>(sql`
      select jl.*,e.book_id,p.display_name from journal_lines jl
      join journal_entries e on e.id=jl.entry_id and e.org_id=jl.org_id
      join parties p on p.id=jl.party_id and p.org_id=jl.org_id
      where jl.org_id=${fx.orgId} and e.source_document_id=${fx.input.documentId}
        and jl.is_open_item and jl.amount<0`)).rows;
    assert.equal(sources.length, 3);
    const settled = sources.find(row => row.display_name === "Already paid employee")!;
    const unpaid = sources.find(row => row.display_name === "Unpaid employee")!;
    await ordinaryPayment(fx, "50");
    await ordinaryPayment({ ...fx, employeeId: settled.party_id, source: settled }, neg(settled.txn_amount));
    const results = await Promise.allSettled([
      recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId }),
      recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId }),
    ]);
    const success = results.filter(result => result.status === "fulfilled");
    assert.equal(success.length, 1);
    const rejected = results.find(result => result.status === "rejected")!;
    assert.match(String(rejected.reason), /already recorded as paid/);
    const payment = success[0]!.value;
    assert.equal(payment.total, sum([neg(fx.source.txn_amount), "-50", neg(unpaid.txn_amount)]));
    assert.equal(payment.eft, add(neg(fx.source.txn_amount), "-50"));
    assert.equal(payment.cheque, neg(unpaid.txn_amount));
    const targets = (await db.execute<{ to_line_id: string }>(sql`
      select a.to_line_id from applications a join journal_lines jl on jl.id=a.from_line_id and jl.org_id=a.org_id
      where a.org_id=${fx.orgId} and jl.entry_id=${payment.entryId}`)).rows.map(row => row.to_line_id);
    assert.deepEqual(targets.sort(), [fx.source.id, unpaid.id].sort());
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("payroll residual uses the target carrying and transaction amounts after a foreign-currency payment", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await postedRun();
  try {
    await ordinaryPayment(fx, "50", true);
    const prior = (await db.execute<{ source_amount: string; amount: string; source_transaction_amount: string; target_transaction_amount: string }>(sql`
      select source_amount,amount,source_transaction_amount,target_transaction_amount from applications
      where org_id=${fx.orgId} and to_line_id=${fx.source.id} and unapplied_at is null`)).rows[0]!;
    assert.deepEqual(prior, { source_amount: "52.0000", amount: "50.0000", source_transaction_amount: "40.0000", target_transaction_amount: "50.0000" });
    const payment = await recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId });
    assert.equal(payment.total, add(neg(fx.source.txn_amount), "-50"));
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("an already settled payroll run refuses new cash and does not invent a paid entry", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await postedRun();
  try {
    await ordinaryPayment(fx, neg(fx.source.txn_amount));
    await assert.rejects(() => recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId }), /nothing to pay.*already settled/);
    const state = (await db.execute<{ paid_at: string | null; paid_entry_id: string | null; entries: number; applications: number }>(sql`
      select paid_at,paid_entry_id,
        (select count(*)::int from journal_entries where org_id=${fx.orgId}) as entries,
        (select count(*)::int from applications where org_id=${fx.orgId}) as applications
      from pay_runs where org_id=${fx.orgId} and document_id=${fx.input.documentId}`)).rows[0]!;
    assert.deepEqual(state, { paid_at: null, paid_entry_id: null, entries: 2, applications: 1 });
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("payroll reads applications committed while waiting for the liability lock", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await postedRun();
  let release!: () => void;
  let ready!: (pid: number) => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const partial = withOrgTransaction(fx.orgId, async () => {
    await ordinaryPayment(fx, "50");
    const pid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
    ready(pid);
    await hold;
  });
  let payroll: ReturnType<typeof recordPayRunPayment> | undefined;
  try {
    const pid = await Promise.race([locked, partial.then(() => { throw new Error("payment did not hold its lock"); })]);
    payroll = recordPayRunPayment({ ...fx.input, bankAccountId: fx.bankAccountId });
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (await db.execute<{ waiting: boolean }>(sql`
        select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as waiting`)).rows[0]!.waiting;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "payroll must wait for the ordinary payment's endpoint lock");
    release();
    await partial;
    const payment = await payroll;
    assert.equal(payment.total, add(neg(fx.source.txn_amount), "-50"));
  } finally {
    release();
    await Promise.allSettled([partial, ...(payroll ? [payroll] : [])]);
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("payroll rejects a mismatched liability at storage without creating cash or paid state", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedAdoption();
  try {
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    const bank = (await db.execute<{ id: string }>(sql`select id from accounts where org_id=${fx.orgId} and type='asset_bank'`)).rows[0]!.id;
    // Attempt a manual projection of a CAD run with a USD net-pay line at par.
    // The document balance guard must reject the link and roll back the entire
    // posting transaction, before this mismatch can reach payroll settlement.
    // Keep all constraints enabled and never rewrite posted evidence.
    let attemptedEntryId: string | undefined;
    await assert.rejects(db.transaction(async tx => {
      const entry = (await tx.execute<{ id: string }>(sql`
        insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,source_document_id,created_by,updated_by)
        select d.org_id,b.id,d.subsidiary_id,${`LEGACY-${input.documentId}`},r.pay_date,p.id,'draft','payroll',d.id,${fx.actorId},${fx.actorId}
        from documents d join pay_runs r on r.document_id=d.id and r.org_id=d.org_id
        join accounting_books b on b.org_id=d.org_id and b.is_primary
        join accounting_periods p on p.org_id=d.org_id and not p.is_adjustment and r.pay_date between p.starts_on and p.ends_on
        where d.org_id=${fx.orgId} and d.id=${input.documentId} returning id`)).rows[0]!.id;
      attemptedEntryId = entry;
      await tx.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,is_open_item)
        select dl.org_id,${entry},dl.line_number,dl.account_id,coalesce(dl.subsidiary_id,d.subsidiary_id),dl.amount,
          case when dl.party_id is not null and dl.amount<0 then 'USD' else 'CAD' end,
          dl.amount,1,dl.party_id,dl.party_id is not null and dl.amount<0
        from document_lines dl join documents d on d.id=dl.document_id and d.org_id=dl.org_id
        where dl.org_id=${fx.orgId} and dl.document_id=${input.documentId}`);
      await tx.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${fx.actorId}
        where org_id=${fx.orgId} and id=${entry}`);
      await tx.execute(sql`update documents set status='approved' where org_id=${fx.orgId} and id=${input.documentId}`);
      await tx.execute(sql`update documents set status='posted',posted_entry_id=${entry},
        posting_period_id=(select period_id from journal_entries where org_id=${fx.orgId} and id=${entry})
        where org_id=${fx.orgId} and id=${input.documentId}`);
    }), (error: unknown) => {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      assert.ok(attemptedEntryId);
      assert.equal(cause?.code, "23514");
      assert.equal(cause?.message,
        `document open-item currency mismatch: org ${fx.orgId}, posted entry ${attemptedEntryId}, expected currency CAD`);
      return true;
    });
    await assert.rejects(() => recordPayRunPayment({ ...input, bankAccountId: bank }), /post the pay run before recording its payment/);
    const state = (await db.execute<{
      paid_at: string | null; paid_entry_id: string | null; run_status: string;
      document_status: string; posted_entry_id: string | null; currency: string;
      entries: number; lines: number; applications: number;
    }>(sql`
      select r.paid_at,r.paid_entry_id,r.run_status,d.status as document_status,d.posted_entry_id,d.currency,
        (select count(*)::int from journal_entries where org_id=${fx.orgId}) as entries,
        (select count(*)::int from journal_lines where org_id=${fx.orgId}) as lines,
        (select count(*)::int from applications where org_id=${fx.orgId}) as applications
      from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
      where r.org_id=${fx.orgId} and r.document_id=${input.documentId}`)).rows[0]!;
    assert.deepEqual(state, {
      paid_at: null, paid_entry_id: null, run_status: "committed",
      document_status: "draft", posted_entry_id: null, currency: "CAD",
      entries: 0, lines: 0, applications: 0,
    });
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
