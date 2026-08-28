import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, mulRate, neg, sum } from "./money.ts";
import {
  PayrollError,
  payrollSettings,
  payrollSubsidiaryOutsideScopeFilter,
  payrollSubsidiaryScopeFilter,
  type PayrollSubsidiaryScope,
} from "./payroll-run.ts";
import {
  intercompanyBalancingLegs,
  loadSubsidiaryContext,
  SubsidiaryError,
} from "./subsidiaries.ts";

/**
 * Pay-run payment: the GL settlement of net pay.
 *
 * The posted run left one open-item CREDIT per employee on the net-pay
 * payable. Recording payment posts a single journal — DR net-pay payable per
 * employee (party-tagged) / CR the chosen bank account — and links each debit
 * to its run credit through the universal `applications` model, so the
 * payable's open items settle exactly like AR/AP everywhere else. The run is
 * stamped paid_at / paid_entry_id (idempotence + the wizard's Paid state).
 *
 * The bank FILE (CPA-005/NACHA) is evidence for the bank; THIS is the books'
 * truth. They are deliberately independent: cheque shops record payment with
 * no file, EFT shops generate both.
 *
 * A MIXED population settles here exactly like a uniform one. The rail decides
 * how the money is instructed to leave, not what the books record: every
 * employee's net pay is relieved off the same payable against the same bank
 * account, because that is the account both the direct-deposit debit and the
 * cheques are drawn on. When employees belong to several legal entities, the
 * due-to/due-from legs make the cash-funded entry balance on each subsidiary's
 * books before the kernel's deferred balance check runs. The split is reported
 * (`eft` / `cheque` below, and on the funding panel) so a controller can see
 * what each rail costs, and each cheque's number rides its own settlement
 * line's memo so the bank reconciliation can match paper to ledger.
 */
export async function recordPayRunPayment(input: {
  orgId: string;
  actorId: string;
  documentId: string;
  bankAccountId: string;
  /** Settlement date; defaults to the run's pay date. */
  paidOn?: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ entryId: string; total: string; eft: string; cheque: string }> {
  const { orgId, actorId, documentId } = input;
  const settings = await payrollSettings(orgId, input.allowedSubsidiaryIds);
  const netPayable = settings.netPayAccountId;
  if (!netPayable) {
    throw new PayrollError("payroll setup incomplete: net pay payable account is not configured");
  }

  return await db.transaction(async (tx) => {
    const runRows = (await tx.execute<Record<string, string | null>>(sql`
      select r.run_status, r.paid_at, r.pay_date, d.status as doc_status, d.posted_entry_id,
             d.document_number, d.subsidiary_id, d.currency, e.book_id
       from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
       for update of r
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (run.paid_at) throw new PayrollError("this pay run is already recorded as paid");
    if (run.doc_status !== "posted" || !run.posted_entry_id) {
      throw new PayrollError("post the pay run before recording its payment");
    }

    // A calculated run may predate the caller's restriction (or have been
    // calculated by an unrestricted administrator). Never let a restricted
    // caller settle only the visible part of a mixed-entity run: that would
    // mutate an authorized run while leaving its hidden employee liabilities
    // behind. Treat the whole run as opaque when any open net-pay item is out
    // of scope, including an orphaned party row.
    if (input.allowedSubsidiaryIds != null) {
      const hidden = (await tx.execute<{ id: string }>(sql`
        select jl.id
          from journal_lines jl
          left join parties p on p.id = jl.party_id and p.org_id = jl.org_id
         where jl.org_id = ${orgId} and jl.entry_id = ${run.posted_entry_id}
           and jl.account_id = ${netPayable} and jl.is_open_item and jl.party_id is not null
           and jl.amount < 0
           and (p.id is null or ${payrollSubsidiaryOutsideScopeFilter(
             sql`p.subsidiary_id`, input.allowedSubsidiaryIds,
           )})
         limit 1
      `));
      if (hidden.rows[0]) throw new PayrollError("pay run not found");
    }

    const bank = (await tx.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${orgId} and id = ${input.bankAccountId}
        and type = 'asset_bank' and is_active
    `));
    if (!bank.rows[0]) throw new PayrollError("choose an active bank account");

    // The run's per-employee net-pay open items (credits on the payable).
    const openItems = (await tx.execute<{
      id: string; party_id: string; amount: string; txn_amount: string;
      fx_rate: string; subsidiary_id: string; currency: string;
    }>(sql`
      select jl.id, jl.party_id, jl.amount, jl.txn_amount, jl.fx_rate,
             jl.subsidiary_id, jl.currency
        from journal_lines jl
        join parties p on p.id = jl.party_id and p.org_id = jl.org_id
       where jl.org_id = ${orgId} and jl.entry_id = ${run.posted_entry_id}
         and jl.account_id = ${netPayable} and jl.is_open_item and jl.party_id is not null
         and jl.amount < 0
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
       order by jl.line_number
       for update
    `));
    if (openItems.rows.length === 0) {
      throw new PayrollError("the posted run has no open net-pay items (already settled?)");
    }

    // How each employee is actually paid, so the settlement line can carry the
    // cheque number and the caller can report the rail split. An open item with
    // no stub (a hand-built run) simply carries no rail annotation.
    const railRows = (await tx.execute<{ employee_party_id: string; payment_method: string | null; cheque_number: string | null }>(sql`
      select s.employee_party_id, s.payment_method, s.cheque_number
        from pay_stubs s
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
    `));
    const rail = new Map(railRows.rows.map((row) => [row.employee_party_id, row]));

    const paidOn = input.paidOn ?? run.pay_date!;
    const period = (await tx.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${orgId} and is_adjustment = false
         and starts_on <= ${paidOn} and ends_on >= ${paidOn}
       limit 1
    `));
    if (!period.rows[0]) throw new PayrollError(`no accounting period covers ${paidOn}`);

    const originSubId = run.subsidiary_id;
    const runCurrency = run.currency;
    if (!originSubId || !runCurrency) {
      throw new PayrollError("the posted pay run has no originating subsidiary or currency");
    }
    const subsidiaries = await loadSubsidiaryContext(tx, orgId);
    const origin = subsidiaries.byId.get(originSubId);
    if (!origin) throw new PayrollError("the posted pay run's subsidiary is missing or inactive");

    // Pay-run documents are denominated in their originating subsidiary's
    // functional currency. Keep the lookup defensive for hand-built/legacy
    // runs whose header currency was changed after posting.
    let originFxRate = "1";
    if (origin.baseCurrency !== runCurrency) {
      const fx = (await tx.execute<{ rate: string }>(sql`
        select rate::text from (
          select rate, as_of from fx_rates
           where org_id = ${orgId} and from_currency = ${runCurrency}
             and to_currency = ${origin.baseCurrency} and rate_type = 'spot'
             and as_of <= ${paidOn}
          union all
          select (1 / rate)::numeric(19,10) as rate, as_of from fx_rates
           where org_id = ${orgId} and from_currency = ${origin.baseCurrency}
             and to_currency = ${runCurrency} and rate_type = 'spot'
             and as_of <= ${paidOn}
        ) candidates order by as_of desc limit 1`));
      originFxRate = fx.rows[0]?.rate ?? "";
      if (!originFxRate) {
        throw new PayrollError(
          `no spot rate for ${runCurrency}→${origin.baseCurrency} on or before ${paidOn}`,
        );
      }
    }

    const entryNumber = `PAYD-${run.document_number}-${randomUUID().slice(0, 6)}`;
    const entry = (await tx.execute<{ id: string }>(sql`
      insert into journal_entries (org_id, book_id, subsidiary_id, entry_number, posting_date,
                                   period_id, memo, status, origin, source_document_id,
                                   created_by, updated_by)
      values (${orgId}, ${run.book_id}, ${run.subsidiary_id}, ${entryNumber}, ${paidOn},
              ${period.rows[0].id}, ${`Net pay ${run.document_number}`}, 'draft', 'payroll',
              ${documentId}, ${actorId}, ${actorId})
      returning id
    `));
    const entryId = entry.rows[0]!.id;

    let lineNumber = 1;
    // `txn_amount` is the pay-run currency (the currency the bank actually
    // leaves). `amount` is each employee subsidiary's functional amount, so it
    // cannot be summed across entities when their base currencies differ.
    const total = sum(openItems.rows.map((item) => neg(item.txn_amount)));
    if (cmp(total, "0") <= 0) throw new PayrollError("nothing to pay");
    const bankAmount = neg(mulRate(total, originFxRate));
    const settlementLines = openItems.rows.map((item) => ({
      accountId: netPayable,
      amount: neg(item.amount),
      txnAmount: neg(item.txn_amount),
      currency: item.currency,
      fxRate: item.fx_rate,
      subsidiaryId: item.subsidiary_id,
    }));
    settlementLines.push({
      accountId: input.bankAccountId,
      amount: bankAmount,
      txnAmount: neg(total),
      currency: runCurrency,
      fxRate: originFxRate,
      subsidiaryId: originSubId,
    });
    let intercompanyLegs: Awaited<ReturnType<typeof intercompanyBalancingLegs>>;
    try {
      intercompanyLegs = await intercompanyBalancingLegs(tx, {
        orgId,
        ctx: subsidiaries,
        originSubId,
        originFxRate,
        lines: settlementLines,
      });
    } catch (error) {
      if (error instanceof SubsidiaryError) throw new PayrollError(error.message);
      throw error;
    }

    const settlements: {
      fromLineId: string; toLineId: string; amount: string;
      txnAmount: string; currency: string;
    }[] = [];
    let eft = "0";
    let cheque = "0";
    for (const item of openItems.rows) {
      const debit = neg(item.amount); // positive
      const txnDebit = neg(item.txn_amount);
      const paid = rail.get(item.party_id);
      if (paid?.payment_method === "cheque") cheque = add(cheque, txnDebit);
      else if (paid?.payment_method === "eft") eft = add(eft, txnDebit);
      const memo = paid?.cheque_number
        ? `Net pay ${run.document_number} · cheque ${paid.cheque_number}`
        : `Net pay ${run.document_number}`;
      const line = (await tx.execute<{ id: string }>(sql`
        insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id,
                                   amount, currency, txn_amount, fx_rate, party_id, is_open_item, memo)
        values (${orgId}, ${entryId}, ${lineNumber++}, ${netPayable}, ${item.subsidiary_id},
                ${debit}, ${item.currency}, ${txnDebit}, ${item.fx_rate}, ${item.party_id}, true,
                ${memo})
        returning id
      `));
      settlements.push({
        fromLineId: line.rows[0]!.id,
        toLineId: item.id,
        amount: debit,
        txnAmount: txnDebit,
        currency: item.currency,
      });
    }
    await tx.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id,
                                 amount, currency, txn_amount, fx_rate, is_open_item, memo)
      values (${orgId}, ${entryId}, ${lineNumber++}, ${input.bankAccountId}, ${run.subsidiary_id},
              ${bankAmount}, ${runCurrency}, ${neg(total)}, ${originFxRate}, false,
              ${`Net pay ${run.document_number}`})
    `);
    for (const leg of intercompanyLegs) {
      await tx.execute(sql`
        insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id,
                                   amount, currency, txn_amount, fx_rate, is_open_item, memo)
        values (${orgId}, ${entryId}, ${lineNumber++}, ${leg.accountId}, ${leg.subsidiaryId},
                ${leg.amount}, ${leg.currency}, ${leg.txnAmount}, ${leg.fxRate}, false,
                ${leg.memo})
      `);
    }
    if (intercompanyLegs.length > 0) {
      await tx.execute(sql`
        update journal_entries set origin = 'intercompany', updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${entryId}
      `);
    }

    // The kernel requires both entries posted before applications connect them.
    await tx.execute(sql`
      update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${entryId}
    `);
    for (const settlement of settlements) {
      await tx.execute(sql`
        insert into applications (org_id, from_line_id, to_line_id, amount, source_amount,
                                  source_transaction_amount, source_transaction_currency,
                                  target_transaction_amount, target_transaction_currency,
                                  settlement_rate, settlement_rate_source, settlement_rate_reference,
                                  applied_on, created_by, updated_by)
        values (${orgId}, ${settlement.fromLineId}, ${settlement.toLineId}, ${settlement.amount},
                ${settlement.amount}, ${settlement.txnAmount}, ${settlement.currency},
                ${settlement.txnAmount}, ${settlement.currency},
                1, 'same_currency', ${`Pay run ${run.document_number} settlement`},
                ${paidOn}, ${actorId}, ${actorId})
      `);
    }
    await tx.execute(sql`
      update pay_runs set paid_at = now(), paid_entry_id = ${entryId},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    return { entryId, total, eft, cheque };
  });
}
