import { eq, sql } from "drizzle-orm";
import { db, orgContext, schema, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { roundCurrencyMoney } from "../fx/currencies.ts";
import { cmp, divRate, fromUnits, isZero, toUnits } from "../money/money.ts";
import { evaluateBillsForRelease, recordReleaseCheck, type BillReleaseDecision } from "../compliance/compliance.ts";
import { assertSubcontractPaymentCleared } from "../projects/subcontracts.ts";
import { PaymentError } from "./payment-errors.ts";
import { sameCurrencyAllocation, type AllocationInput } from "./settlement-policy.ts";
import { type CreditAllocationInput } from "./payment-contracts.ts";
import { nextNumber, createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
// ---------------------------------------------------------------------------
// Payment runs
// ---------------------------------------------------------------------------

interface CreatePaymentRunOptions {
  orgId: string;
  /**
   * Null for scheduler-created runs: system provenance. The historical
   * schedule author must never be recorded as performing a future automated
   * selection, and an org UUID may never enter a user actor column.
   */
  createdBy: string | null;
  paymentBankProfileId: string;
  billDocumentIds: string[];
  scheduledFor?: string | null;
  sourceScheduleId?: string | null;
  selectionCriteria?: Record<string, unknown>;
  /**
   * Durable per-occurrence claim for scheduled runs. The occurrence row is
   * inserted (or adopted) inside the creation transaction BEFORE any run
   * artifacts are written, and linked to the run in the same transaction: a
   * crash can never lose the occurrence or strand an unlinked run, and a
   * concurrent creator of the same occurrence adopts the winner's run instead
   * of duplicating it.
   */
  sourceOccurrence?: {
    scheduleId: string;
    occurrenceAt: Date;
    /** Occurrence status once this run commits: terminal draft, or awaiting scheduled submission. */
    status: "draft_created" | "awaiting_submit";
  } | null;
}

/** The storage-enforced race when another live run claims the same open item. */
export function isPaymentRunSourceClaimConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === "payment_run_items_live_source") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

async function recordPaymentRunCreationChecks(
  opts: CreatePaymentRunOptions,
  decisions: BillReleaseDecision[],
): Promise<void> {
  for (const decision of decisions) {
    if (!decision.compliance.tracked && decision.reasons.length === 0) continue;
    await recordReleaseCheck({
      orgId: opts.orgId,
      partyId: decision.partyId,
      documentId: decision.documentId,
      stage: "run_created",
      decision: decision.decision,
      snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
      checkedBy: opts.createdBy,
    });
  }
}

/**
 * Create an EFT payment run from selected posted vendor bills: one draft
 * vendor_payment per vendor (allocating each bill's current open balance) and
 * one payment_instruction per vendor. Nothing posts until the explicit
 * post step; the CPA-005 file is generated from the instructions.
 */
export async function createPaymentRun(opts: CreatePaymentRunOptions): Promise<{ id: string; runNumber: string }> {
  // This command deliberately owns its transaction: on a rejected selection,
  // the draft artifacts roll back before compliance evidence is committed in
  // a separate transaction. Nesting would either erase that evidence with the
  // caller or try to write it through an already-aborted transaction.
  if (orgContext.getStore()?.txDb) {
    throw new PaymentError("payment run creation cannot be nested in another database transaction");
  }
  let releaseEvaluationCompleted = false;
  let evaluatedReleaseDecisions: BillReleaseDecision[] = [];
  try {
    return await withOrgTransaction(opts.orgId, () =>
      createPaymentRunWithinTransaction(opts, (decisions) => {
        releaseEvaluationCompleted = true;
        evaluatedReleaseDecisions = decisions;
      }));
  } catch (error) {
    // Compliance checks are evidence that the control ran, including when the
    // selection is blocked or a concurrent run wins the reservation. The run
    // transaction must roll back its draft artifacts, so freeze that evidence
    // in a fresh tenant transaction before returning the creation failure.
    if (releaseEvaluationCompleted) {
      await withOrgTransaction(opts.orgId, () =>
        recordPaymentRunCreationChecks(opts, evaluatedReleaseDecisions));
    }
    if (isPaymentRunSourceClaimConflict(error)) {
      throw new PaymentError(
        "a selected bill or credit is already reserved by another live payment run",
      );
    }
    throw error;
  }
}

async function createPaymentRunWithinTransaction(
  opts: CreatePaymentRunOptions,
  onReleaseEvaluated: (decisions: BillReleaseDecision[]) => void,
): Promise<{ id: string; runNumber: string }> {
  if (opts.billDocumentIds.length === 0) throw new PaymentError("select at least one bill to pay");

  // Durable occurrence claim, before any side effect: the ledger row and the
  // run artifacts below commit atomically in this transaction. Concurrent
  // creators of the same occurrence serialize on the unique index — the loser
  // waits at the insert, then either claims a rolled-back occurrence (the
  // winner aborted, so this insert wins) or adopts the winner's committed run.
  let occurrenceId: string | null = null;
  if (opts.sourceOccurrence) {
    const claim = (await db.execute<{ id: string }>(sql`
      insert into payment_schedule_occurrences (org_id, schedule_id, occurrence_at, status)
      values (${opts.orgId}, ${opts.sourceOccurrence.scheduleId}, ${opts.sourceOccurrence.occurrenceAt}, ${opts.sourceOccurrence.status})
      on conflict (org_id, schedule_id, occurrence_at) do nothing
      returning id
    `));
    const claimedRow = claim.rows[0];
    if (claimedRow) {
      occurrenceId = claimedRow.id;
    } else {
      const existing = (await db.execute<{ id: string; paymentRunId: string | null }>(sql`
        select id::text as id, payment_run_id::text as "paymentRunId"
          from payment_schedule_occurrences
         where org_id = ${opts.orgId} and schedule_id = ${opts.sourceOccurrence.scheduleId}
           and occurrence_at = ${opts.sourceOccurrence.occurrenceAt}
         for update
      `)).rows[0];
      if (!existing) {
        throw new PaymentError("payment schedule occurrence disappeared while being claimed");
      }
      if (existing.paymentRunId) {
        const prior = (await db.execute<{ id: string; runNumber: string }>(sql`
          select id::text as id, run_number as "runNumber"
            from payment_runs
           where id = ${existing.paymentRunId} and org_id = ${opts.orgId}
        `)).rows[0];
        if (!prior) throw new PaymentError("a claimed payment schedule occurrence names a missing run");
        return prior;
      }
      // An unlinked occurrence (for example a raced empty tick): this
      // transaction now owns it and links the run below.
      occurrenceId = existing.id;
    }
  }

  const profiles = (await db.execute<{
    id: string;
    bank_account_id: string;
    subsidiary_id: string | null;
    currency: string;
    require_run_approval: boolean;
    settings: Record<string, unknown>;
    rail: string;
    direction: string;
  }>(sql`
    select p.id, p.bank_account_id, p.subsidiary_id, p.currency, p.require_run_approval, p.settings,
           f.rail, f.direction
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id and f.is_active
      join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id
                        and a.type = 'asset_bank' and a.is_active and not a.is_summary
     where p.id = ${opts.paymentBankProfileId} and p.org_id = ${opts.orgId} and p.is_active
  `));
  const profile = profiles.rows[0];
  if (!profile) throw new PaymentError("payment bank profile was not found or is inactive");
  if (profile.direction === "debit") throw new PaymentError("a debit-only bank profile cannot pay vendor bills");
  const method = profile.rail === "cpa005_credit" ? "eft"
    : profile.rail === "nacha_credit" ? "ach"
    : profile.rail === "sepa_credit" ? "sepa"
    : profile.rail === "positive_pay" ? "positive_pay"
    : profile.rail === "custom" ? "custom"
    : profile.rail === "cheque" ? "cheque"
    : "wire";

  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, opts.orgId));
  if (!org) throw new PaymentError("org not found");

  // Selected bills → their open AP lines with current open balances.
  const bills = (await db.execute<{ document_id: string; document_number: string; document_kind: string; document_date: string; party_id: string; vendor: string; project_id: string | null; currency: string; fx_rate: string; subsidiary_id: string | null; control_account_id: string; open_line_id: string; open_base: string; open: string; discount_days: number | null; discount_percent: string | null }>(sql`
    select d.id as document_id, d.document_number, d.kind as document_kind, d.document_date, d.party_id, p.display_name as vendor,
           d.project_id, d.currency, d.fx_rate, d.subsidiary_id, jl.account_id as control_account_id,
           jl.id as open_line_id, abs(jl.amount) - coalesce(ap.applied, 0) as open_base,
           abs(jl.txn_amount) - coalesce(ap.transaction_applied, 0) as open,
           pt.discount_days, pt.discount_percent
      from documents d
      join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join vendor_roles vr on vr.party_id = d.party_id and vr.org_id = d.org_id
      left join payment_terms pt on pt.id = vr.payment_terms_id and pt.org_id = d.org_id and pt.is_active
      join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id and jl.is_open_item and jl.amount < 0
      left join lateral (
        select sum(a.amount) as applied, sum(a.target_transaction_amount) as transaction_applied from applications a
         where a.to_line_id = jl.id and a.org_id = ${opts.orgId} and a.unapplied_at is null
      ) ap on true
     where d.id in ${opts.billDocumentIds}
       and d.org_id = ${opts.orgId} and d.kind in ('vendor_bill', 'expense_report') and d.status = 'posted'
       and d.payment_hold_reason is null
       and d.currency = ${profile.currency}
       and (${profile.subsidiary_id}::uuid is null or d.subsidiary_id = ${profile.subsidiary_id})
       and not exists (
         select 1
           from payment_run_items selected
          where selected.org_id = d.org_id
            and selected.source_open_line_id = jl.id
            and selected.status = 'selected'
       )
  `));

  const found = new Set(bills.rows.map((b) => b.document_id));
  const missing = opts.billDocumentIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    // Name the bills held by another live run (bill + holding run number)
    // instead of failing the whole selection behind the generic guard
    // (F-t04-005): the operator can see exactly which selection to drop.
    const reserved = (await db.execute<{ billId: string; billNumber: string; runNumber: string }>(sql`
      select distinct i.source_document_id as "billId", d.document_number as "billNumber", r.run_number as "runNumber"
        from payment_run_items i
        join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
        join documents d on d.id = i.source_document_id and d.org_id = i.org_id
       where i.org_id = ${opts.orgId}
         and i.source_document_id = any(${`{${missing.join(',')}}`}::uuid[])
         and i.status = 'selected'
    `)).rows;
    if (reserved.length > 0) {
      const pairs = reserved.map((row) => `${row.billNumber} (${row.runNumber})`);
      const rest = missing.length - new Set(reserved.map((row) => row.billId)).size;
      throw new PaymentError(
        `${pairs.join(", ")} ${pairs.length === 1 ? "is" : "are"} already selected in another live payment run` +
        (rest > 0 ? "; other selected bills are held, closed, or do not match the profile currency and subsidiary" : ""),
      );
    }
    throw new PaymentError(
      "some selected bills are held, closed, already selected in another live payment run, or do not match the profile currency and subsidiary",
    );
  }
  const payable = bills.rows.filter((b) => cmp(b.open, "0") > 0);
  if (payable.length === 0) throw new PaymentError("all selected bills are already fully paid");

  // Apply subcontract holds and joint-check instructions before creating any
  // payment documents or instructions. A later control is caught again by the
  // final postPaymentWithApplications gate above.
  for (const bill of payable) {
    await assertSubcontractPaymentCleared(opts.orgId, bill.document_id, bill.open);
  }

  // --- subcontractor compliance -------------------------------------------
  // A bill whose vendor fails a blocking requirement (lapsed insurance, missing
  // lien waiver) never enters the run. Refusing the whole selection is
  // deliberate: silently dropping bills would leave the operator believing a
  // subcontractor had been paid. Every evaluated decision is frozen into
  // compliance_release_checks whether it cleared or not.
  const releaseDecisions = await evaluateBillsForRelease({
    orgId: opts.orgId,
    asOf: opts.scheduledFor ?? undefined,
    bills: payable.map((b) => ({
      documentId: b.document_id,
      documentNumber: b.document_number,
      partyId: b.party_id,
      vendorName: b.vendor,
      projectId: b.project_id,
      documentDate: b.document_date,
      amount: b.open,
      currency: b.currency,
    })),
  });
  onReleaseEvaluated(releaseDecisions);
  await recordPaymentRunCreationChecks(opts, releaseDecisions);
  const blockedBills = releaseDecisions.filter((d) => d.decision === "blocked");
  if (blockedBills.length > 0) {
    throw new PaymentError(
      `subcontractor compliance blocks payment: ${blockedBills
        .map((d) => `${d.documentNumber} (${d.vendorName}) — ${d.reasons.join("; ")}`)
        .join(" | ")}`,
    );
  }

  const byVendor = new Map<string, typeof payable>();
  for (const b of payable) {
    const groupKey = `${b.party_id}:${b.subsidiary_id ?? ""}:${b.control_account_id}:${b.fx_rate}`;
    const list = byVendor.get(groupKey) ?? [];
    list.push(b);
    byVendor.set(groupKey, list);
  }

  const runNumber = await nextNumber(opts.orgId, "payment_run", "RUN-");

  const run = (await db
    .insert(schema.paymentRuns)
    .values({
      orgId: opts.orgId,
      runNumber,
      bankAccountId: profile.bank_account_id,
      paymentBankProfileId: profile.id,
      subsidiaryId: profile.subsidiary_id,
      sourceScheduleId: opts.sourceScheduleId ?? null,
      method: method as "eft" | "ach" | "sepa" | "wire" | "cheque" | "positive_pay" | "custom",
      direction: "outbound",
      purpose: "vendor_payments",
      currency: profile.currency,
      selectionCriteria: opts.selectionCriteria ?? {},
      status: "draft",
      scheduledFor: opts.scheduledFor ?? null,
      createdBy: opts.createdBy,
    })
    .returning({ id: schema.paymentRuns.id, runNumber: schema.paymentRuns.runNumber }))[0]!;

  if (occurrenceId) {
    // Link the run to its occurrence inside the same transaction: the claim
    // and the run (with every payment and instruction below) commit or roll
    // back together, so the occurrence can never outlive an unlinked draft.
    await db.execute(sql`
      update payment_schedule_occurrences
         set payment_run_id = ${run.id}, status = ${opts.sourceOccurrence!.status},
             updated_at = now()
       where id = ${occurrenceId} and payment_run_id is null and org_id = ${opts.orgId}
    `);
  }

  const criteria = opts.selectionCriteria ?? {};
  const captureDiscounts = criteria.captureDiscounts !== false;
  const applyCredits = criteria.applyCredits !== false;
  const discountAccountId = typeof profile.settings?.discountAccountId === "string"
    ? profile.settings.discountAccountId
    : null;
  const paymentDate = opts.scheduledFor ?? await businessToday(opts.orgId);
  // Discount legs are currency money: round them to the bill currency's own
  // minor units (whole yen, whole fils), never whole cents by default — the
  // same roundCurrencyMoney project billing already applies. Resolved from
  // the tenant currencies table, like billing; an unknown currency refuses
  // the discount rather than posting sub-unit dust.
  const minorUnitsByCurrency = new Map<string, number>();
  const minorUnitsFor = async (currency: string): Promise<number> => {
    const cached = minorUnitsByCurrency.get(currency);
    if (cached !== undefined) return cached;
    const row = (await db.execute<{ minor_units: number }>(sql`
      select minor_units from currencies where code = ${currency}`)).rows[0];
    const minorUnits = row?.minor_units;
    if (minorUnits == null || !Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
      throw new PaymentError(`the ${currency} currency has unsupported minor-unit precision`);
    }
    minorUnitsByCurrency.set(currency, minorUnits);
    return minorUnits;
  };

  for (const vendorBills of byVendor.values()) {
    const first = vendorBills[0]!;
    const partyId = first.party_id;
    const availableCredits = applyCredits ? (await db.execute<{ document_id: string; open_line_id: string; open_base: string }>(sql`
      select d.id as document_id, jl.id as open_line_id,
             abs(jl.amount) - coalesce(ap.applied, 0) as open_base
        from documents d
        join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id and je.status = 'posted'
        join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id and jl.is_open_item and jl.amount > 0
        join subsidiaries credit_sub on credit_sub.id = jl.subsidiary_id and credit_sub.org_id = jl.org_id
        left join lateral (
          select sum(a.source_amount) as applied from applications a
           where a.from_line_id = jl.id and a.org_id = ${opts.orgId} and a.unapplied_at is null
        ) ap on true
       where d.org_id = ${opts.orgId} and d.party_id = ${partyId}
         and d.kind = 'vendor_credit' and d.status = 'posted'
         and d.currency = ${profile.currency} and jl.account_id = ${first.control_account_id}
         and jl.currency = credit_sub.base_currency
         and d.subsidiary_id is not distinct from ${first.subsidiary_id}::uuid
         and abs(jl.amount) - coalesce(ap.applied, 0) > 0
         and not exists (
           select 1
             from payment_run_items selected
            where selected.org_id = d.org_id
              and selected.source_open_line_id = jl.id
              and selected.status = 'selected'
         )
       order by d.document_date, d.document_number
    `)) : { rows: [] };
    const groupBase = vendorBills.reduce((n, b) => n + toUnits(b.open_base), 0n);
    const creditBase = availableCredits.rows.reduce((n, c) => n + toUnits(c.open_base), 0n);
    // A bank run must still move cash. If credits cover the entire group they
    // belong in a credit-application operation, not a zero-value bank file.
    const credits = creditBase > 0n && creditBase < groupBase ? availableCredits.rows : [];
    const creditRemaining = new Map(credits.map((c) => [c.open_line_id, toUnits(c.open_base)]));
    const creditAllocations: CreditAllocationInput[] = [];
    const billComposition: Array<{ bill: (typeof vendorBills)[number]; allocation: AllocationInput; creditAmount: string; discountAmount: string; paymentAmount: string }> = [];
    let discountTotal = 0n;

    for (const bill of vendorBills) {
      let remainingBase = toUnits(bill.open_base);
      let remainingTransaction = toUnits(bill.open);
      for (const credit of credits) {
        const left = creditRemaining.get(credit.open_line_id) ?? 0n;
        if (left <= 0n || remainingBase <= 0n) continue;
        const applied = left < remainingBase ? left : remainingBase;
        creditAllocations.push({
          fromLineId: credit.open_line_id,
          toLineId: bill.open_line_id,
          amount: fromUnits(applied),
          sourceDocumentId: credit.document_id,
        });
        creditRemaining.set(credit.open_line_id, left - applied);
        remainingBase -= applied;
        // This credit path only accepts functional-currency endpoints, so its
        // explicit source/target transaction amount equals the applied amount.
        remainingTransaction -= applied;
      }
      if (remainingBase <= 0n) continue;
      const remainingTxn = fromUnits(remainingTransaction);
      let discountTxn = "0";
      if (captureDiscounts && bill.discount_days != null && bill.discount_percent && cmp(bill.discount_percent, "0") > 0) {
        const deadline = new Date(`${bill.document_date}T00:00:00Z`);
        deadline.setUTCDate(deadline.getUTCDate() + bill.discount_days);
        if (paymentDate <= deadline.toISOString().slice(0, 10)) {
          const numerator = toUnits(remainingTxn) * toUnits(bill.discount_percent);
          const rawDiscount = (numerator + 500_000n) / 1_000_000n;
          discountTxn = roundCurrencyMoney(fromUnits(rawDiscount), await minorUnitsFor(bill.currency));
          if (!isZero(discountTxn) && !discountAccountId) {
            throw new PaymentError("an early-payment discount is available but the bank profile has no discount account");
          }
        }
      }
      const paymentAmount = fromUnits(toUnits(remainingTxn) - toUnits(discountTxn));
      if (cmp(paymentAmount, "0") <= 0) throw new PaymentError("discount leaves a non-positive payment amount");
      discountTotal += toUnits(discountTxn);
      billComposition.push({
        bill,
        allocation: sameCurrencyAllocation(bill.open_line_id, remainingTxn, fromUnits(remainingBase)),
        creditAmount: divRate(fromUnits(toUnits(bill.open_base) - remainingBase), bill.fx_rate),
        discountAmount: discountTxn,
        paymentAmount,
      });
    }
    const allocations = billComposition.map((c) => c.allocation);
    if (allocations.length === 0) continue;
    const total = fromUnits(allocations.reduce((n, a) => n + toUnits(a.sourceTransactionAmount), 0n) - discountTotal);

    const payment = await createPaymentDocument({
      orgId: opts.orgId,
      kind: "vendor_payment",
      createdBy: opts.createdBy,
      partyId,
      bankAccountId: profile.bank_account_id,
      // An order-converted bill carries no subsidiary (single-entity orders
      // never set one). Pass undefined so the payment inherits the payee's
      // subsidiary or the org root — the same books the bill's lines posted
      // to — instead of an explicit null whose empty scope matches no open
      // item and fails every such run with "not an open item for this party".
      subsidiaryId: first.subsidiary_id ?? undefined,
      currency: profile.currency,
      documentDate: paymentDate,
      fxRate: first.fx_rate,
      memo: `Payment run ${runNumber}`,
    });
    await updateDraftPayment(
      payment.id,
      {
        partyId,
        bankAccountId: profile.bank_account_id,
        allocations,
        creditAllocations,
        discountAmount: fromUnits(discountTotal),
        discountAccountId,
        controlAccountId: first.control_account_id,
      },
      opts.createdBy,
      opts.orgId,
    );

    // Latest approved, active bank account for the payee (may be none — the
    // file export blocks on it with a clear error, never silently).
    const payeeBank = (await db.execute<{ id: string }>(sql`
      select id from party_bank_accounts
       where party_id = ${partyId} and org_id = ${opts.orgId} and is_active and approved_at is not null
       order by approved_at desc, created_at desc limit 1
    `));

    const instruction = (await db.insert(schema.paymentInstructions).values({
      orgId: opts.orgId,
      paymentRunId: run.id,
      payeePartyId: partyId,
      payeeBankAccountId: payeeBank.rows[0]?.id ?? null,
      amount: total,
      currency: profile.currency,
      paymentDocumentId: payment.id,
      status: "pending",
      createdBy: opts.createdBy,
    }).returning({ id: schema.paymentInstructions.id }))[0]!;

    await db.insert(schema.paymentRunItems).values(billComposition.map(({ bill, creditAmount, discountAmount, paymentAmount }) => ({
      orgId: opts.orgId,
      paymentRunId: run.id,
      paymentInstructionId: instruction.id,
      sourceDocumentId: bill.document_id,
      sourceOpenLineId: bill.open_line_id,
      kind: (bill.document_kind === "expense_report" ? "expense" : "bill") as "expense" | "bill",
      grossAmount: bill.open,
      discountAmount,
      creditAmount,
      paymentAmount,
      currency: bill.currency,
      fxRate: bill.fx_rate,
      status: "selected" as const,
      createdBy: opts.createdBy,
    })));
    const creditsUsed = new Map<string, { sourceDocumentId: string; amount: bigint }>();
    for (const credit of creditAllocations) {
      const current = creditsUsed.get(credit.fromLineId);
      creditsUsed.set(credit.fromLineId, {
        sourceDocumentId: credit.sourceDocumentId,
        amount: (current?.amount ?? 0n) + toUnits(credit.amount),
      });
    }
    if (creditsUsed.size > 0) {
      await db.insert(schema.paymentRunItems).values([...creditsUsed].map(([sourceOpenLineId, used]) => ({
        orgId: opts.orgId,
        paymentRunId: run.id,
        paymentInstructionId: instruction.id,
        sourceDocumentId: used.sourceDocumentId,
        sourceOpenLineId,
        kind: "credit" as const,
        grossAmount: divRate(fromUnits(used.amount), first.fx_rate),
        discountAmount: "0",
        creditAmount: divRate(fromUnits(used.amount), first.fx_rate),
        paymentAmount: "0",
        currency: profile.currency,
        fxRate: first.fx_rate,
        status: "selected" as const,
        createdBy: opts.createdBy,
      })));
    }
  }

  await db.execute(sql`
    update payment_runs r set
      payment_count = x.payment_count,
      total_amount = x.total_amount,
      updated_at = now(), updated_by = ${opts.createdBy}
    from (
      select payment_run_id, count(*)::integer as payment_count, coalesce(sum(amount), 0) as total_amount
        from payment_instructions where org_id = ${opts.orgId} and payment_run_id = ${run.id} and status <> 'cancelled'
       group by payment_run_id
    ) x
    where r.id = x.payment_run_id and r.org_id = ${opts.orgId}
  `);
  await db.insert(schema.paymentEvents).values({
    orgId: opts.orgId,
    paymentRunId: run.id,
    eventType: "run_created",
    toStatus: "draft",
    details: {
      paymentBankProfileId: profile.id,
      sourceCount: payable.length,
      // Durable source marker: a scheduled run names its occurrence so the
      // automated selection is auditable without impersonating any user.
      ...(opts.sourceOccurrence
        ? {
            source: "payment_schedule",
            scheduleId: opts.sourceOccurrence.scheduleId,
            occurrenceAt: opts.sourceOccurrence.occurrenceAt.toISOString(),
          }
        : {}),
    },
    actorId: opts.createdBy,
  });

  return run;
}
