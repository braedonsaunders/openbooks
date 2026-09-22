import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrg } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { add, cmp, fromUnits, isZero, neg, sum, toUnits } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import { evaluateBillsForRelease, recordReleaseCheck } from "../compliance/compliance.ts";
import { captureTransactionAuditSnapshot, recordTransactionAudit } from "../records/transaction-audit.ts";
import { assertSubcontractPaymentCleared } from "../projects/subcontracts.ts";
import { PaymentError } from "./payment-errors.ts";
import { allocationsMatchApprovedSnapshot, canonicalSettlementRate, carryingAmountForSettlement, realizedFxControlAdjustment, validateAllocationInputs, validateSettlementEvidence, type AllocationInput, type SettlementRateSource } from "./settlement-policy.ts";
import { PAYMENT_KIND_SIDE, type CreditAllocationInput } from "./payment-contracts.ts";
import { paymentControlDeps, paymentBookId } from "./payment-accounts.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { validateCreditAllocations } from "./credit-allocation.ts";
import { isPaymentKind } from "./payment-documents.ts";
// ---------------------------------------------------------------------------
// Post + apply
// ---------------------------------------------------------------------------

type SettlementApplication = {
  fromLineId: string;
  toLineId: string;
  amount: string;
  sourceAmount: string;
  sourceTransactionAmount: string;
  sourceTransactionCurrency: string;
  targetTransactionAmount: string;
  targetTransactionCurrency: string;
  settlementRate: string;
  settlementRateSource: SettlementRateSource;
  settlementRateReference: string;
  settlementFxRateId: string | null;
  appliedOn: string;
  controlAdjustment: string;
};

/** Post the payment, applications, realized FX, and links as one atomic unit. */
export async function postPaymentWithApplications(
  paymentDocId: string,
  allocations?: AllocationInput[],
  userId?: string,
  auditSource: "ui" | "api" | "mcp" | "assistant" | "flows" = "ui",
  options: { deferEffects?: boolean } = {},
): Promise<{ entryId: string }> {
  const [preflight] = await db.select().from(schema.documents).where(eq(schema.documents.id, paymentDocId));
  if (!preflight || !isPaymentKind(preflight.kind)) throw new PaymentError("payment document not found");

  const result = await withOrg(preflight.orgId, async () => {
    // Match the kernel's organization -> book lock order. Holding a shared
    // book/advisory lock before upgrading the organization lock can deadlock
    // with setup's feature fence followed by an exclusive book edit.
    await db.execute(sql`select id from orgs where id = ${preflight.orgId} for update`);
    // Serialize both the payment aggregate and every application endpoint.
    await db.execute(sql`select id from documents where id = ${paymentDocId} and org_id = ${preflight.orgId} for update`);
    const [doc] = await db.select().from(schema.documents).where(and(eq(schema.documents.id, paymentDocId), eq(schema.documents.orgId, preflight.orgId)));
    if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
    if (doc.status !== "approved") {
      throw new PaymentError(
        `${doc.documentNumber} is ${doc.status}; it must complete the approval submission lifecycle before posting`,
      );
    }
    if (!doc.partyId) throw new PaymentError("select a party before posting");
    const auditBefore = userId
      ? await captureTransactionAuditSnapshot(db, paymentDocId, doc.orgId)
      : null;
    if (doc.kind === "vendor_payment") {
      const hold = (await db.execute<{ hold_reason: string | null }>(sql`
        select hold_reason
          from vendor_roles
         where org_id = ${doc.orgId} and party_id = ${doc.partyId}
           and is_active and is_on_hold
         limit 1
      `));
      if (hold.rows[0]) {
        throw new PaymentError(
          `vendor is on payment hold${hold.rows[0].hold_reason ? ` — ${hold.rows[0].hold_reason}` : ""}`,
        );
      }
    }

    const custom = (doc.custom ?? {}) as {
      bankAccountId?: string;
      allocations?: AllocationInput[];
      creditAllocations?: CreditAllocationInput[];
      discountAmount?: string;
      controlAccountId?: string;
      onAccountAmount?: string;
    };
    const storedAllocations = custom.allocations ?? [];
    const allocs = allocations ?? storedAllocations;
    const creditAllocs = custom.creditAllocations ?? [];
    // A payment is the CASH frame: its total is the bank line by contract, so
    // a payment settling only credits would be a 0.00 receipt sitting in the
    // payments list, the collected/paid tiles, remittance advice and bank
    // matching. Credits that move no cash settle through applyStandaloneCredits
    // (engine/src/payments/credit-settlement.ts), which writes the same
    // `applications` ledger and no journal entry. Name that path rather than
    // asking for cash the operator does not have.
    if (allocs.length === 0 && creditAllocs.length > 0) {
      throw new PaymentError(
        "this payment applies credits but moves no cash — apply the credit directly from the credit memo instead of through a payment",
      );
    }
    if (allocs.length === 0) throw new PaymentError("select at least one open item to apply");
    validateAllocationInputs(allocs);
    if (
      allocations !== undefined &&
      !allocationsMatchApprovedSnapshot(allocations, storedAllocations)
    ) {
      throw new PaymentError(
        "payment allocations differ from the approved document; save the payment and complete approval before posting",
      );
    }

    const endpointIds = [...new Set([
      ...allocs.map((a) => a.openLineId),
      ...creditAllocs.flatMap((a) => [a.fromLineId, a.toLineId]),
    ])];
    await db.execute(sql`select id from journal_lines where id in ${endpointIds} and org_id = ${doc.orgId} order by id for update`);

    const side = PAYMENT_KIND_SIDE[doc.kind];
    const bookId = await paymentBookId(doc.orgId);
    await validateCreditAllocations(creditAllocs, allocs, {
      orgId: doc.orgId, partyId: doc.partyId, subsidiaryId: doc.subsidiaryId,
      bookId, side, controlAccountId: custom.controlAccountId ?? null,
    });
    const openItems = await openItemsForParty(doc.partyId, side, doc.orgId);
    const byLine = new Map(openItems.map((item) => [item.lineId, item]));
    for (const allocation of allocs) {
      const item = byLine.get(allocation.openLineId);
      if (!item) throw new PaymentError("an allocated item is no longer open for this party");
      if (doc.kind === "vendor_payment" && item.documentId) {
        // A joint-check instruction is intentionally incompatible with an
        // ordinary one-payee payment. The control must be released or handled
        // through a dedicated joint-check disbursement before cash can move.
        await assertSubcontractPaymentCleared(doc.orgId, item.documentId, allocation.targetTransactionAmount);
      }
      validateSettlementEvidence(allocation, doc.currency, item.currency);
      if (cmp(allocation.targetTransactionAmount, item.transactionOpen) > 0) {
        throw new PaymentError(`application exceeds ${item.documentNumber ?? item.entryNumber}'s open transaction balance`);
      }
    }
    const evidenceIds = [...new Set(allocs.map((a) => a.settlementFxRateId).filter((id): id is string => !!id))];
    if (evidenceIds.length) {
      const evidenceRows = (await db.execute<{ id: string; from_currency: string; to_currency: string; rate: string; as_of: string }>(sql`
        select id, from_currency, to_currency, rate, as_of::text as as_of
          from fx_rates
         where org_id = ${doc.orgId} and id in ${evidenceIds}
      `));
      const evidenceById = new Map(evidenceRows.rows.map((row) => [row.id, row]));
      for (const allocation of allocs) {
        if (!allocation.settlementFxRateId) continue;
        const evidence = evidenceById.get(allocation.settlementFxRateId);
        const targetCurrency = byLine.get(allocation.openLineId)!.currency;
        if (
          !evidence ||
          evidence.from_currency !== doc.currency ||
          evidence.to_currency !== targetCurrency ||
          canonicalSettlementRate(evidence.rate) !== canonicalSettlementRate(allocation.settlementRate) ||
          evidence.as_of > doc.documentDate
        ) {
          throw new PaymentError("settlement FX observation does not match the payment, open item, rate, and date");
        }
      }
    }

    const totalAlloc = sum(allocs.map((a) => a.sourceTransactionAmount));
    const discountAmount = custom.discountAmount ?? "0";
    const feeAmount = (custom as { feeAmount?: string }).feeAmount ?? "0";
    // Fail closed on a stored on-account remainder the draft boundary never
    // admitted: only a non-negative customer-receipt residual may widen the
    // receipt beyond its applications.
    const onAccountAmount = custom.onAccountAmount ?? "0";
    const onAccountUnits = toUnits(onAccountAmount);
    if (onAccountUnits < 0n) throw new PaymentError("on-account amount cannot be negative");
    if (onAccountUnits > 0n && doc.kind !== "customer_payment") throw new PaymentError("on-account residuals only apply to customer receipts");
    // Applications settle the invoice portion: cash + early-payment discount
    // (vendor side) − acceptance surcharge fee (customer side) = applications
    // + on-account remainder (a customer receipt may collect more than is
    // still open; the excess stays on the receipt as an AR credit).
    if (cmp(add(totalAlloc, onAccountAmount), fromUnits(toUnits(doc.total) + toUnits(discountAmount) - toUnits(feeAmount))) !== 0) {
      throw new PaymentError(`cash ${doc.total} plus discount ${discountAmount} less fee ${feeAmount} must equal applications ${totalAlloc} plus on-account ${onAccountAmount}`);
    }

    // Final compliance gate (mirrors the run-posting final gate): a
    // block_payment policy stops payment on EVERY path — evaluateBillRelease's
    // contract names pay-run creation, run readiness, and posting, and this
    // ad-hoc post is posting. Without it a compliance-blocked bill is payable
    // by skipping the run entirely. Vendor bills only: credits and non-bill
    // open items carry no release decision.
    if (doc.kind === "vendor_payment") {
      const targetDocIds = [...new Set(
        allocs
          .map((allocation) => byLine.get(allocation.openLineId)?.documentId)
          .filter((id): id is string => Boolean(id)),
      )];
      if (targetDocIds.length > 0) {
        const bills = (await db.execute<{
          documentId: string; documentNumber: string; partyId: string; vendorName: string;
          projectId: string | null; documentDate: string; amount: string; currency: string;
        }>(sql`
          select d.id as "documentId", d.document_number as "documentNumber", d.party_id as "partyId",
                 p.display_name as "vendorName", d.project_id as "projectId",
                 d.document_date::text as "documentDate", d.total::text as amount, d.currency
            from documents d
            join parties p on p.id = d.party_id and p.org_id = d.org_id
           where d.org_id = ${doc.orgId} and d.kind = 'vendor_bill'
             and d.id in (${sql.join(targetDocIds.map((id) => sql`${id}`), sql`, `)})`));
        if (bills.rows.length > 0) {
          const releaseDecisions = await evaluateBillsForRelease({
            orgId: doc.orgId,
            bills: bills.rows,
            asOf: await businessToday(doc.orgId),
          });
          const blockedBills = releaseDecisions.filter((decision) => decision.decision === "blocked");
          for (const decision of blockedBills) {
            await recordReleaseCheck({
              orgId: doc.orgId,
              partyId: decision.partyId,
              documentId: decision.documentId,
              stage: "manual",
              decision: "blocked",
              snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
              checkedBy: userId ?? null,
            });
          }
          if (blockedBills.length > 0) {
            throw new PaymentError(
              `subcontractor compliance blocks payment: ${blockedBills
                .map((d) => `${d.documentNumber} (${d.vendorName}) — ${d.reasons.join("; ")}`)
                .join(" | ")}`,
            );
          }
        }
      }
    }

    const deps = await paymentControlDeps(doc.orgId);
    let controlAccountId = custom.controlAccountId ?? (side === "ap" ? deps.control.ap : deps.control.ar);
    if (!custom.controlAccountId) {
      // Derive the control account from the allocation targets when they all
      // sit on ONE account that differs from the side default — e.g. employee
      // reimbursements settling expense reports on the configured
      // employee-payable control. The application writer already requires the
      // source and every target to share a control account, so deriving the
      // targets' account is the only way such a payment can post at all;
      // mixed-account allocations keep the default and fail loudly below.
      const targetAccounts = (await db.execute<{ account_id: string }>(sql`
        select distinct account_id from journal_lines where org_id = ${doc.orgId} and id in ${allocs.map((a) => a.openLineId)}
      `));
      const derived = targetAccounts.rows.length === 1 ? targetAccounts.rows[0]!.account_id : null;
      if (derived && derived !== controlAccountId) {
        controlAccountId = derived;
        // Persist the derived control so the posting rule (controlOverride)
        // and any later GL regeneration reproduce the same projection.
        await db.execute(sql`
          update documents
             set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{controlAccountId}', to_jsonb(${derived}::text), true)
           where id = ${doc.id} and org_id = ${doc.orgId}`);
        doc.custom = { ...(doc.custom as Record<string, unknown> ?? {}), controlAccountId: derived };
      }
    }
    const entryId = await postDocument(doc.id, deps, { deferEffects: true });
    const sourceResult = (await db.execute<{
      id: string; amount: string; currency: string; txn_amount: string; account_id: string;
      party_id: string | null; subsidiary_id: string; posting_date: string; period_id: string;
      book_id: string; functional_currency: string;
    }>(sql`
      select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id,
             jl.subsidiary_id, je.posting_date, je.period_id, je.book_id,
             s.base_currency as functional_currency
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join subsidiaries s on s.id = jl.subsidiary_id and s.org_id = jl.org_id
       where jl.entry_id = ${entryId} and jl.org_id = ${doc.orgId} and jl.account_id = ${controlAccountId}
       limit 1
    `));
    const source = sourceResult.rows[0];
    if (!source) throw new PaymentError("posted payment entry has no AP/AR control line");
    if (source.book_id !== bookId || source.party_id !== doc.partyId || source.subsidiary_id !== doc.subsidiaryId) {
      throw new PaymentError("posted payment source must preserve its party, subsidiary, and accounting book");
    }
    if (source.currency !== doc.currency || cmp(fromUnits(toUnits(source.txn_amount) < 0n ? -toUnits(source.txn_amount) : toUnits(source.txn_amount)), add(totalAlloc, onAccountAmount)) !== 0) {
      throw new PaymentError("payment control line does not cross-foot to the transaction-currency applications");
    }

    const targetsResult = (await db.execute<{
      id: string; amount: string; currency: string; txn_amount: string; account_id: string;
      party_id: string | null; subsidiary_id: string; book_id: string; open_base: string; open_transaction: string;
    }>(sql`
      select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id, jl.subsidiary_id, je.book_id,
             abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0) as open_base,
             abs(jl.txn_amount) - coalesce(sum(a.target_transaction_amount) filter (where a.unapplied_at is null), 0) as open_transaction
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
        left join applications a on a.to_line_id = jl.id and a.org_id = jl.org_id
       where jl.org_id = ${doc.orgId} and jl.id in ${allocs.map((a) => a.openLineId)}
       group by jl.id, je.book_id
    `));
    const targetById = new Map(targetsResult.rows.map((row) => [row.id, row]));

    let sourceBaseRemaining = fromUnits(toUnits(source.amount) < 0n ? -toUnits(source.amount) : toUnits(source.amount));
    // The source leg carries the applications plus any on-account remainder,
    // so the proportional base split must consume from that same wider pool —
    // otherwise the final application would absorb the remainder into its own
    // source leg and the on-account credit could never be spent.
    let sourceTransactionRemaining = add(totalAlloc, onAccountAmount);
    const applicationsToWrite: SettlementApplication[] = [];
    for (const allocation of allocs) {
      const target = targetById.get(allocation.openLineId);
      if (!target) throw new PaymentError("an application target disappeared while posting");
      if (target.account_id !== source.account_id || target.party_id !== source.party_id || target.subsidiary_id !== source.subsidiary_id || target.book_id !== source.book_id) {
        throw new PaymentError("applications must settle the same control account, party, subsidiary, and book as the payment");
      }
      const targetBase = carryingAmountForSettlement(target.open_base, target.open_transaction, allocation.targetTransactionAmount);
      if (allocation.targetBaseAmount !== undefined && cmp(allocation.targetBaseAmount, targetBase) !== 0) {
        throw new PaymentError(`saved target base amount ${allocation.targetBaseAmount} no longer matches carrying amount ${targetBase}`);
      }
      const sourceBase = carryingAmountForSettlement(sourceBaseRemaining, sourceTransactionRemaining, allocation.sourceTransactionAmount);
      const sourceSigned = cmp(source.amount, "0") > 0 ? sourceBase : neg(sourceBase);
      const targetSigned = cmp(target.amount, "0") > 0 ? targetBase : neg(targetBase);
      applicationsToWrite.push({
        fromLineId: source.id,
        toLineId: target.id,
        amount: targetBase,
        sourceAmount: sourceBase,
        sourceTransactionAmount: allocation.sourceTransactionAmount,
        sourceTransactionCurrency: doc.currency,
        targetTransactionAmount: allocation.targetTransactionAmount,
        targetTransactionCurrency: target.currency,
        settlementRate: allocation.settlementRate,
        settlementRateSource: allocation.settlementRateSource,
        settlementRateReference: allocation.settlementRateReference.trim(),
        settlementFxRateId: allocation.settlementFxRateId ?? null,
        appliedOn: source.posting_date,
        controlAdjustment: realizedFxControlAdjustment(sourceSigned, targetSigned),
      });
      sourceBaseRemaining = fromUnits(toUnits(sourceBaseRemaining) - toUnits(sourceBase));
      sourceTransactionRemaining = fromUnits(toUnits(sourceTransactionRemaining) - toUnits(allocation.sourceTransactionAmount));
    }

    const fxAdjustment = sum(applicationsToWrite.map((a) => a.controlAdjustment));
    let fxEntryId: string | null = null;
    if (!isZero(fxAdjustment)) {
      const gainLossAccountId = deps.control.fxRealizedGainLoss;
      if (!gainLossAccountId) {
        throw new PaymentError("realized FX gain/loss account is not configured");
      }
      const [fxEntry] = await db
        .insert(schema.journalEntries)
        .values({
          orgId: doc.orgId,
          bookId: source.book_id,
          subsidiaryId: source.subsidiary_id,
          entryNumber: `${doc.documentNumber}-FX`,
          postingDate: source.posting_date,
          periodId: source.period_id,
          memo: `Realized FX settlement — ${doc.documentNumber}`,
          status: "draft",
          sourceDocumentId: doc.id,
          origin: "fx_settlement",
          createdBy: userId ?? doc.createdBy,
        })
        .returning({ id: schema.journalEntries.id });
      fxEntryId = fxEntry!.id;
      await db.insert(schema.journalLines).values([
        {
          orgId: doc.orgId, entryId: fxEntryId!, lineNumber: 1, accountId: source.account_id,
          subsidiaryId: source.subsidiary_id, amount: fxAdjustment, currency: source.functional_currency,
          txnAmount: fxAdjustment, fxRate: "1", partyId: doc.partyId, isOpenItem: false,
          memo: `Realized FX settlement — ${doc.documentNumber}`,
        },
        {
          orgId: doc.orgId, entryId: fxEntryId!, lineNumber: 2, accountId: gainLossAccountId,
          subsidiaryId: source.subsidiary_id, amount: neg(fxAdjustment), currency: source.functional_currency,
          txnAmount: neg(fxAdjustment), fxRate: "1", isOpenItem: false,
          memo: `Realized FX settlement — ${doc.documentNumber}`,
        },
      ]);
      await db.update(schema.journalEntries).set({ status: "posted", postedAt: new Date(), postedBy: userId ?? doc.createdBy }).where(and(eq(schema.journalEntries.id, fxEntryId!), eq(schema.journalEntries.orgId, doc.orgId)));
    }

    // `controlAdjustment` clears in the FX entry above; the applications table
    // has no such column, so the insert lists the persisted fields explicitly.
    await db.insert(schema.applications).values(applicationsToWrite.map((a) => ({
      orgId: doc.orgId,
      fromLineId: a.fromLineId,
      toLineId: a.toLineId,
      amount: a.amount,
      sourceAmount: a.sourceAmount,
      sourceTransactionAmount: a.sourceTransactionAmount,
      sourceTransactionCurrency: a.sourceTransactionCurrency,
      targetTransactionAmount: a.targetTransactionAmount,
      targetTransactionCurrency: a.targetTransactionCurrency,
      settlementRate: a.settlementRate,
      settlementRateSource: a.settlementRateSource,
      settlementRateReference: a.settlementRateReference,
      settlementFxRateId: a.settlementFxRateId,
      appliedOn: a.appliedOn,
      fxGainLossEntryId: fxEntryId,
      createdBy: userId ?? doc.createdBy,
    })));

    if (creditAllocs.length > 0) {
      await db.insert(schema.applications).values(creditAllocs.map((application) => ({
        orgId: doc.orgId,
        fromLineId: application.fromLineId,
        toLineId: application.toLineId,
        amount: application.amount,
        sourceAmount: application.amount,
        sourceTransactionAmount: application.amount,
        sourceTransactionCurrency: source.functional_currency,
        targetTransactionAmount: application.amount,
        targetTransactionCurrency: source.functional_currency,
        settlementRate: "1",
        settlementRateSource: "same_currency" as const,
        settlementRateReference: "same transaction currency",
        appliedOn: source.posting_date,
        createdBy: userId ?? doc.createdBy,
      })));
    }

    const targetIds = [...allocs.map((a) => a.openLineId), ...creditAllocs.map((a) => a.toLineId)];
    const targets = (await db.execute<{ doc_id: string }>(sql`
      select distinct je.source_document_id as doc_id
        from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${doc.orgId} and jl.id in ${targetIds} and je.source_document_id is not null
    `));
    if (targets.rows.length > 0) {
      await db.insert(schema.documentLinks).values(targets.rows.map((target) => ({
        orgId: doc.orgId,
        fromDocumentId: doc.id,
        toDocumentId: target.doc_id,
        linkType: "pays" as const,
        createdBy: userId ?? doc.createdBy,
      })));
    }
    if (userId && auditBefore) {
      const auditAfter = await captureTransactionAuditSnapshot(db, paymentDocId, doc.orgId);
      if (!auditAfter) throw new PaymentError("payment disappeared while posting");
      await recordTransactionAudit(db, {
        orgId: doc.orgId,
        documentId: doc.id,
        action: "post",
        actorId: userId,
        source: auditSource,
        before: auditBefore,
        after: auditAfter,
      });
    }
    return { entryId };
  });

  if (!options.deferEffects) {
    await runPostDocumentEffects(paymentDocId, preflight.status);
  }
  return result;
}
