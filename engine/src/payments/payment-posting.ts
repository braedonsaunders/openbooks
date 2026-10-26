import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrg } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { add, cmp, fromUnits, isZero, neg, sum, toUnits } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import { evaluateBillsForRelease, recordReleaseCheck } from "../compliance/compliance.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import { assertSubcontractPaymentCleared } from "../projects/subcontracts.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { assertProviderReturnPosting } from "../payments-core/provider-return-posting.ts";
import {
  writePaymentApplications,
  type SettlementApplication,
} from "./payment-application-writes.ts";
import {
  allocationsMatchApprovedSnapshot,
  canonicalSettlementRate,
  carryingAmountForSettlement,
  realizedFxControlAdjustment,
  validateAllocationInputs,
  validateSettlementEvidence,
  type AllocationInput,
} from "./settlement-policy.ts";
import { PAYMENT_KIND_SIDE, type CreditAllocationInput } from "./payment-contracts.ts";
import { paymentControlDeps, paymentBookId } from "./payment-accounts.ts";
import { assertNoForeignRunReservation, openItemsForParty } from "./payment-queries.ts";
import { assertCreditSourcesExist, validateCreditAllocations } from "./credit-allocation.ts";
import { isPaymentKind } from "./payment-documents.ts";
import { redeemStoredValue } from "../stored-value/accounts.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { documentPostingPermission } from "../records/document-kind-permissions.ts";
import { expireStalePaymentLinkSessions } from "./payment-link-session-expiry.ts";
// ---------------------------------------------------------------------------
// Post + apply
// ---------------------------------------------------------------------------

async function assertPaymentRunComposition(
  runId: string,
  paymentDocId: string,
  allocations: AllocationInput[],
  creditAllocations: CreditAllocationInput[],
  discountAmount: string,
  withholdingAmount: string,
  orgId: string,
): Promise<void> {
  const rows = await db.execute<{
    source_open_line_id: string;
    source_document_id: string;
    kind: string;
    gross_amount: string;
    credit_amount: string;
    discount_amount: string;
    withholding_amount: string;
    credit_target_allocations: Array<{ toLineId: string; amount: string }> | null;
  }>(
    sql`
    select source_open_line_id, source_document_id, kind, gross_amount::text,
           credit_amount::text, discount_amount::text, withholding_amount::text, credit_target_allocations
      from payment_run_items
     where payment_run_id = ${runId} and payment_instruction_id = (
       select id from payment_instructions
        where payment_run_id = ${runId} and payment_document_id = ${paymentDocId}
          and org_id = ${orgId}
     ) and org_id = ${orgId} and status = 'selected'
     order by kind, source_open_line_id
     for update
  `,
    "objects",
  );
  // A bill the run settles wholly with credits is reserved by the run but
  // carries no cash allocation; its credits are checked with the credit items.
  const cashItems = rows.filter(
    (row) => row.kind !== "credit" && toUnits(row.gross_amount) - toUnits(row.credit_amount) !== 0n,
  );
  const creditItems = rows.filter((row) => row.kind === "credit");
  const actualCash = new Map(allocations.map((allocation) => [allocation.openLineId, allocation]));
  const expectedDiscount = cashItems.reduce(
    (total, row) => total + toUnits(row.discount_amount),
    0n,
  );
  const expectedWithholding = cashItems.reduce(
    (total, row) => total + toUnits(row.withholding_amount),
    0n,
  );
  let cashMatches = actualCash.size === cashItems.length;
  for (const item of cashItems) {
    const allocation = actualCash.get(item.source_open_line_id);
    if (!allocation) {
      cashMatches = false;
      continue;
    }
    const planned = fromUnits(toUnits(item.gross_amount) - toUnits(item.credit_amount));
    if (
      toUnits(allocation.sourceTransactionAmount) !== toUnits(planned) ||
      toUnits(allocation.targetTransactionAmount) !== toUnits(planned)
    )
      cashMatches = false;
  }
  const expectedCredits = creditItems.flatMap((item) => {
    if (!Array.isArray(item.credit_target_allocations)) return [];
    return item.credit_target_allocations.map((target) => ({
      fromLineId: item.source_open_line_id,
      toLineId: target.toLineId,
      amount: target.amount,
      sourceDocumentId: item.source_document_id,
    }));
  });
  const creditKey = (item: CreditAllocationInput) =>
    `${item.fromLineId}:${item.toLineId}:${toUnits(item.amount)}:${item.sourceDocumentId}`;
  const actualCreditKeys = creditAllocations.map(creditKey).sort();
  const expectedCreditKeys = expectedCredits.map(creditKey).sort();
  const creditMatches =
    creditItems.every((item) => Array.isArray(item.credit_target_allocations)) &&
    actualCreditKeys.length === expectedCreditKeys.length &&
    actualCreditKeys.every((key, index) => key === expectedCreditKeys[index]);
  if (
    !cashMatches ||
    !creditMatches ||
    toUnits(discountAmount) !== expectedDiscount ||
    toUnits(withholdingAmount) !== expectedWithholding
  ) {
    throw new PaymentError(
      "payment composition differs from the approved run items; release the run and re-plan before posting",
    );
  }
}

/** Post the payment, applications, realized FX, and links as one atomic unit. */
export async function postPaymentWithApplications(
  paymentDocId: string,
  allocations?: AllocationInput[],
  userId?: string,
  auditSource: "ui" | "api" | "mcp" | "assistant" | "flows" = "ui",
  options: { deferEffects?: boolean; runClaim?: { runId: string; token: string } } = {},
): Promise<{ entryId: string }> {
  const [preflight] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, paymentDocId));
  if (!preflight || !isPaymentKind(preflight.kind))
    throw new PaymentError("payment document not found");
  assertProviderReturnPosting(preflight);

  let affectedInvoicesAfterCommit: string[] = [];
  const result = await withOrg(preflight.orgId, async () => {
    // Claims are locked before the payment row, matching run posting's
    // run → instruction → document order. This also prevents a direct caller
    // from holding the organization fence while waiting on a run poster.
    const liveClaims = await db.execute<{
      run_id: string;
      claim_token: string | null;
      run_status: string;
      instruction_id: string;
      instruction_status: string;
    }>(
      sql`
      select run.id as run_id, run.posting_claim_token as claim_token, run.status as run_status,
             instruction.id as instruction_id, instruction.status as instruction_status
        from payment_instructions instruction
        join payment_runs run on run.id = instruction.payment_run_id and run.org_id = instruction.org_id
       where instruction.payment_document_id = ${paymentDocId}
         and instruction.org_id = ${preflight.orgId}
         and instruction.status in ('pending', 'approved', 'generated')
         and run.status in ('draft', 'pending_approval', 'approved', 'processing',
                            'generated', 'delivered', 'partially_failed', 'confirmed', 'settled', 'returned')
       order by run.id, instruction.id
       for update of run, instruction
    `,
      "objects",
    );
    if (options.runClaim) {
      const authorized =
        liveClaims.length === 1 &&
        liveClaims[0]!.run_id === options.runClaim.runId &&
        liveClaims[0]!.claim_token === options.runClaim.token &&
        liveClaims[0]!.run_status === "processing" &&
        liveClaims[0]!.instruction_status === "pending";
      if (!authorized) throw new PaymentError("payment run posting claim is no longer live");
    } else if (liveClaims.length > 0) {
      throw new PaymentError("payment is claimed by a payment run; post it through that run");
    }
    // Organization before book lock order: a setup reassignment holds the org
    // row FOR SHARE across its edit, so wait on it here — before the fence
    // and any book lock — or the kernel's book lock below can deadlock the
    // setup's book fence. FOR NO KEY UPDATE conflicts with that FOR SHARE
    // while staying compatible with concurrent posts' FK checks.
    await db.execute(sql`select id from orgs where id = ${preflight.orgId} for no key update`);
    // Acquire the shared ledger-setup side before touching GL; the kernel takes
    // the same side and the payment row remains the per-document mutex.
    await lockLedgerSetupFence(db, preflight.orgId, "shared");
    const beforeLock = (preflight.custom ?? {}) as {
      allocations?: AllocationInput[];
      creditAllocations?: CreditAllocationInput[];
    };
    const beforeCash = allocations ?? beforeLock.allocations ?? [];
    const beforeCredits = beforeLock.creditAllocations ?? [];
    const discoveredEndpoints = [
      ...new Set([
        ...beforeCash.map((allocation) => allocation.openLineId),
        ...beforeCredits.flatMap((allocation) => [allocation.fromLineId, allocation.toLineId]),
      ]),
    ];
    // Name a broken credit source claim before the evidence lock: a credit
    // whose from-line does not exist can never satisfy the source-document
    // match, and the lock below would otherwise fail it first with a generic
    // retry that hides the remedy — the same refusal the draft gate returns
    // for the same workpapers.
    if (beforeCredits.length > 0) {
      await assertCreditSourcesExist(preflight.orgId, beforeCredits);
    }
    // Application triggers update invoice open balances. Lock every source
    // document, entry and line (and the payment document) in the shared order.
    const retained = (
      await db.execute<{ posted_entry_id: string | null }>(
        sql`select posted_entry_id from documents
      where org_id = ${preflight.orgId} and id = ${paymentDocId}`,
        "objects",
      )
    )[0];
    await lockApplicationEvidence(
      db,
      preflight.orgId,
      discoveredEndpoints,
      [paymentDocId],
      retained?.posted_entry_id ? [retained.posted_entry_id] : [],
    );
    const [doc] = await db
      .select()
      .from(schema.documents)
      .where(
        and(eq(schema.documents.id, paymentDocId), eq(schema.documents.orgId, preflight.orgId)),
      );
    if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
    assertProviderReturnPosting(doc);
    if (doc.status === "posted") {
      const snapshot = (doc.custom ?? {}) as {
        allocations?: AllocationInput[];
        creditAllocations?: CreditAllocationInput[];
        discountAmount?: string;
        withholdingAmount?: string;
        providerReturn?: unknown;
      };
      // Replay resolves immutable accounting; it cannot re-price an approved
      // payment, re-apply its open items, or turn a caller's body into a change.
      if (allocations !== undefined) {
        validateAllocationInputs(allocations);
        if (!allocationsMatchApprovedSnapshot(allocations, snapshot.allocations ?? [])) {
          throw new PaymentError(
            "payment allocations differ from the posted document; use a governed correction instead of replaying changed settlement evidence",
          );
        }
      }
      if (options.runClaim) {
        await assertPaymentRunComposition(
          options.runClaim.runId,
          doc.id,
          snapshot.allocations ?? [],
          snapshot.creditAllocations ?? [],
          snapshot.discountAmount ?? "0",
          snapshot.withholdingAmount ?? "0",
          doc.orgId,
        );
      } else if (snapshot.providerReturn === undefined) {
        const permission = documentPostingPermission(doc.kind);
        if (!userId || !permission)
          throw new PaymentError("Payment posting replay requires an authorized posting actor.");
        await lockActorCommandAuthority(db, doc.orgId, userId, doc.subsidiaryId, permission);
      }
      // Every replay authority shares the same feature boundary. The org
      // mutex above already precedes book and accounting-evidence locks.
      if (!(await lockAndCheckOrgFeature(db, doc.orgId, "banking"))) {
        throw new PaymentError(
          "Enable Banking in Company Settings → Features before replaying payment posting effects.",
        );
      }
      if (!doc.postedEntryId || doc.postedEntryId !== retained?.posted_entry_id) {
        throw new PaymentError(
          "The posted payment's retained journal identity is unavailable; reconcile its native accounting before replaying.",
        );
      }
      const entry = (
        await db.execute<{ id: string }>(
          sql`select id from journal_entries
        where org_id = ${doc.orgId} and id = ${doc.postedEntryId} and source_document_id = ${doc.id}
          and status = 'posted' -- Live entries only: payment effect replay requires its current unreversed journal.
        `,
          "objects",
        )
      )[0];
      if (!entry)
        throw new PaymentError(
          "The posted payment's retained journal is not posted for this receipt; reconcile its native accounting before replaying.",
        );
      return { entryId: entry.id };
    }
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
      const hold = await db.execute<{ hold_reason: string | null }>(
        sql`
        select hold_reason
          from vendor_roles
         where org_id = ${doc.orgId} and party_id = ${doc.partyId}
           and is_active and is_on_hold
         limit 1
      `,
        "objects",
      );
      if (hold[0]) {
        throw new PaymentError(
          `vendor is on payment hold${hold[0].hold_reason ? ` — ${hold[0].hold_reason}` : ""}`,
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
    const currentEndpoints = [
      ...new Set([
        ...(custom.allocations ?? []).map((allocation) => allocation.openLineId),
        ...creditAllocs.flatMap((allocation) => [allocation.fromLineId, allocation.toLineId]),
      ]),
    ].sort();
    const discoveredStoredEndpoints = [
      ...new Set([
        ...(beforeLock.allocations ?? []).map((allocation) => allocation.openLineId),
        ...beforeCredits.flatMap((allocation) => [allocation.fromLineId, allocation.toLineId]),
      ]),
    ].sort();
    if (JSON.stringify(currentEndpoints) !== JSON.stringify(discoveredStoredEndpoints)) {
      throw new PaymentError(
        "payment application endpoints changed while posting; retry the operation",
      );
    }
    if (options.runClaim) {
      await assertPaymentRunComposition(
        options.runClaim.runId,
        paymentDocId,
        allocs,
        creditAllocs,
        custom.discountAmount ?? "0",
        typeof (custom as { withholdingAmount?: unknown }).withholdingAmount === "string"
          ? (custom as { withholdingAmount: string }).withholdingAmount
          : "0",
        preflight.orgId,
      );
    }
    // An item a payment run has reserved is paid by that run — its file may
    // already be at the bank — so settling it from any other payment pays it
    // twice. The run's own payment is the only one that may settle it.
    await assertNoForeignRunReservation(
      preflight.orgId,
      [...currentEndpoints, ...allocs.map((allocation) => allocation.openLineId)],
      paymentDocId,
    );
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
    // A payment may post with no applications when it carries an on-account
    // amount: the whole receipt then lands as an open AR credit, the whole
    // vendor payment as an open AP prepayment. Anything else with no
    // applications records nothing and is refused.
    if (allocs.length === 0 && toUnits(custom.onAccountAmount ?? "0") <= 0n) {
      throw new PaymentError(
        doc.kind === "customer_payment"
          ? "select at least one open item to apply, or enter the amount received so the receipt posts as an on-account credit"
          : "select at least one open item to apply, or enter the amount paid so the payment posts as a vendor prepayment",
      );
    }
    validateAllocationInputs(allocs);
    if (
      allocations !== undefined &&
      !allocationsMatchApprovedSnapshot(allocations, storedAllocations)
    ) {
      throw new PaymentError(
        "payment allocations differ from the approved document; save the payment and complete approval before posting",
      );
    }

    const side = PAYMENT_KIND_SIDE[doc.kind];
    const bookId = await paymentBookId(doc.orgId);
    await validateCreditAllocations(creditAllocs, allocs, {
      orgId: doc.orgId,
      partyId: doc.partyId,
      subsidiaryId: doc.subsidiaryId,
      bookId,
      side,
      controlAccountId: custom.controlAccountId ?? null,
    });
    const openItems = await openItemsForParty(doc.partyId, side, doc.orgId);
    const byLine = new Map(openItems.map((item) => [item.lineId, item]));
    const affectedInvoiceIds =
      side === "ar"
        ? [
            ...new Set(
              allocs.flatMap((allocation) => {
                const documentId = byLine.get(allocation.openLineId)?.documentId;
                return documentId ? [documentId] : [];
              }),
            ),
          ]
        : [];
    affectedInvoicesAfterCommit = affectedInvoiceIds;
    for (const allocation of allocs) {
      const item = byLine.get(allocation.openLineId);
      if (!item) throw new PaymentError("an allocated item is no longer open for this party");
      if (doc.kind === "vendor_payment" && item.documentId) {
        // A joint-check instruction is intentionally incompatible with an
        // ordinary one-payee payment. The control must be released or handled
        // through a dedicated joint-check disbursement before cash can move.
        await assertSubcontractPaymentCleared(
          doc.orgId,
          item.documentId,
          allocation.targetTransactionAmount,
        );
      }
      validateSettlementEvidence(allocation, doc.currency, item.currency);
      if (cmp(allocation.targetTransactionAmount, item.transactionOpen) > 0) {
        throw new PaymentError(
          `application exceeds ${item.documentNumber ?? item.entryNumber}'s open transaction balance`,
        );
      }
    }
    const evidenceIds = [
      ...new Set(allocs.map((a) => a.settlementFxRateId).filter((id): id is string => !!id)),
    ];
    if (evidenceIds.length) {
      const evidenceRows = await db.execute<{
        id: string;
        from_currency: string;
        to_currency: string;
        rate: string;
        as_of: string;
      }>(
        sql`
        select id, from_currency, to_currency, rate, as_of::text as as_of
          from fx_rates
         where org_id = ${doc.orgId} and id in ${evidenceIds}
      `,
        "objects",
      );
      const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
      for (const allocation of allocs) {
        if (!allocation.settlementFxRateId) continue;
        const evidence = evidenceById.get(allocation.settlementFxRateId);
        const targetCurrency = byLine.get(allocation.openLineId)!.currency;
        if (
          !evidence ||
          evidence.from_currency !== doc.currency ||
          evidence.to_currency !== targetCurrency ||
          canonicalSettlementRate(evidence.rate) !==
            canonicalSettlementRate(allocation.settlementRate) ||
          evidence.as_of > doc.documentDate
        ) {
          throw new PaymentError(
            "settlement FX observation does not match the payment, open item, rate, and date",
          );
        }
      }
    }

    const totalAlloc = sum(allocs.map((a) => a.sourceTransactionAmount));
    const discountAmount = custom.discountAmount ?? "0";
    const feeAmount = (custom as { feeAmount?: string }).feeAmount ?? "0";
    // Fail closed on a stored on-account remainder the draft boundary never
    // admitted: only a non-negative residual may widen the payment beyond
    // its applications.
    const onAccountAmount = custom.onAccountAmount ?? "0";
    const onAccountUnits = toUnits(onAccountAmount);
    if (onAccountUnits < 0n) throw new PaymentError("on-account amount cannot be negative");
    // Applications settle the invoice portion: cash + early-payment discount
    // (vendor side) − acceptance surcharge fee (customer side) = applications
    // + on-account remainder (a payment may move more than is still open;
    // the excess stays on the payment as an AR credit or AP prepayment).
    // Contractor withholding is the vendor side's second settlement leg:
    // the payable is relieved by cash, discount and the tax deducted.
    const withholdingAmount =
      typeof (custom as { withholdingAmount?: unknown }).withholdingAmount === "string"
        ? (custom as { withholdingAmount: string }).withholdingAmount
        : "0";
    if (toUnits(withholdingAmount) < 0n)
      throw new PaymentError("withholding amount cannot be negative");
    if (!isZero(withholdingAmount) && doc.kind !== "vendor_payment")
      throw new PaymentError("withholding only applies to vendor payments");
    if (
      cmp(
        add(totalAlloc, onAccountAmount),
        fromUnits(
          toUnits(doc.total) +
            toUnits(discountAmount) +
            toUnits(withholdingAmount) -
            toUnits(feeAmount),
        ),
      ) !== 0
    ) {
      throw new PaymentError(
        `cash ${doc.total} plus discount ${discountAmount} plus withholding ${withholdingAmount} less fee ${feeAmount} must equal applications ${totalAlloc} plus on-account ${onAccountAmount}`,
      );
    }

    // Final compliance gate (mirrors the run-posting final gate): a
    // block_payment policy stops payment on EVERY path — evaluateBillRelease's
    // contract names pay-run creation, run readiness, and posting, and this
    // ad-hoc post is posting. Without it a compliance-blocked bill is payable
    // by skipping the run entirely. Vendor bills only: credits and non-bill
    // open items carry no release decision.
    if (doc.kind === "vendor_payment") {
      const targetDocIds = [
        ...new Set(
          allocs
            .map((allocation) => byLine.get(allocation.openLineId)?.documentId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (targetDocIds.length > 0) {
        const bills = await db.execute<{
          documentId: string;
          documentNumber: string;
          partyId: string;
          vendorName: string;
          projectId: string | null;
          documentDate: string;
          amount: string;
          currency: string;
        }>(
          sql`
          select d.id as "documentId", d.document_number as "documentNumber", d.party_id as "partyId",
                 p.display_name as "vendorName", d.project_id as "projectId",
                 d.document_date::text as "documentDate", d.total::text as amount, d.currency
            from documents d
            join parties p on p.id = d.party_id and p.org_id = d.org_id
           where d.org_id = ${doc.orgId} and d.kind = 'vendor_bill'
             and d.id in (${sql.join(
               targetDocIds.map((id) => sql`${id}`),
               sql`, `,
             )})`,
          "objects",
        );
        if (bills.length > 0) {
          const releaseDecisions = await evaluateBillsForRelease({
            orgId: doc.orgId,
            bills,
            asOf: await businessToday(doc.orgId),
          });
          const blockedBills = releaseDecisions.filter(
            (decision) => decision.decision === "blocked",
          );
          for (const decision of blockedBills) {
            await recordReleaseCheck({
              orgId: doc.orgId,
              partyId: decision.partyId,
              documentId: decision.documentId,
              stage: "manual",
              decision: "blocked",
              snapshot: {
                compliance: decision.compliance,
                lienWaiver: decision.lienWaiver,
                reasons: decision.reasons,
              },
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
    let controlAccountId =
      custom.controlAccountId ?? (side === "ap" ? deps.control.ap : deps.control.ar);
    if (!custom.controlAccountId) {
      // Derive the control account from the allocation targets when they all
      // sit on ONE account that differs from the side default — e.g. employee
      // reimbursements settling expense reports on the configured
      // employee-payable control. The application writer already requires the
      // source and every target to share a control account, so deriving the
      // targets' account is the only way such a payment can post at all;
      // mixed-account allocations keep the default and fail loudly below.
      // An on-account receipt has no targets: the default control stands.
      const targetAccounts =
        allocs.length === 0
          ? []
          : await db.execute<{ account_id: string }>(
              sql`
            select distinct account_id from journal_lines where org_id = ${doc.orgId} and id in ${allocs.map((a) => a.openLineId)}
          `,
              "objects",
            );
      const derived = targetAccounts.length === 1 ? targetAccounts[0]!.account_id : null;
      if (derived && derived !== controlAccountId) {
        controlAccountId = derived;
        // Persist the derived control so the posting rule (controlOverride)
        // and any later GL regeneration reproduce the same projection.
        await db.execute(sql`
          update documents
             set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{controlAccountId}', to_jsonb(${derived}::text), true)
           where id = ${doc.id} and org_id = ${doc.orgId}`);
        doc.custom = {
          ...((doc.custom as Record<string, unknown>) ?? {}),
          controlAccountId: derived,
        };
      }
    }
    const entryId = await postDocument(doc.id, deps, {
      deferEffects: true,
      audit: { actorId: userId ?? null, source: auditSource },
    });
    if (doc.kind === "customer_payment") {
      // Stored-value tenders: the journal already debited the liability per
      // line above. Move the subledger now that the entry exists, in this
      // same unit — a refusal rolls the journal back with it. Accounts lock
      // in id order so concurrent split-tender receipts cannot deadlock.
      const tenders = (
        (custom as { storedValueTenders?: Array<{ accountId: string; amount: string }> })
          .storedValueTenders ?? []
      )
        .map((tender, index) => ({ ...tender, index }))
        .sort((a, b) =>
          a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : a.index - b.index,
        );
      for (const tender of tenders) {
        await redeemStoredValue({
          orgId: doc.orgId,
          accountId: tender.accountId,
          // Posting-commit step on the already-gated receipt: explicit null
          // is the unrestricted grant named outright; same-entity is refused by name.
          allowedSubsidiaryIds: null,
          amountMinor: toUnits(tender.amount),
          documentId: doc.id,
          journalEntryId: entryId,
          idempotencyKey: `sv-pay:${doc.id}:${tender.index}`,
          actorId: userId ?? null,
        });
      }
    }
    const sourceResult = await db.execute<{
      id: string;
      amount: string;
      currency: string;
      txn_amount: string;
      account_id: string;
      party_id: string | null;
      subsidiary_id: string;
      posting_date: string;
      period_id: string;
      book_id: string;
      functional_currency: string;
    }>(
      sql`
      select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id,
             jl.subsidiary_id, je.posting_date, je.period_id, je.book_id,
             s.base_currency as functional_currency
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join subsidiaries s on s.id = jl.subsidiary_id and s.org_id = jl.org_id
       where jl.entry_id = ${entryId} and jl.org_id = ${doc.orgId} and jl.account_id = ${controlAccountId}
       limit 1
    `,
      "objects",
    );
    const source = sourceResult[0];
    if (!source) throw new PaymentError("posted payment entry has no AP/AR control line");
    if (
      source.book_id !== bookId ||
      source.party_id !== doc.partyId ||
      source.subsidiary_id !== doc.subsidiaryId
    ) {
      throw new PaymentError(
        "posted payment source must preserve its party, subsidiary, and accounting book",
      );
    }
    if (
      source.currency !== doc.currency ||
      cmp(
        fromUnits(
          toUnits(source.txn_amount) < 0n
            ? -toUnits(source.txn_amount)
            : toUnits(source.txn_amount),
        ),
        add(totalAlloc, onAccountAmount),
      ) !== 0
    ) {
      throw new PaymentError(
        "payment control line does not cross-foot to the transaction-currency applications",
      );
    }

    // An on-account receipt settles no targets, so there is nothing to read.
    const targetsResult =
      allocs.length === 0
        ? []
        : await db.execute<{
            id: string;
            amount: string;
            currency: string;
            txn_amount: string;
            account_id: string;
            party_id: string | null;
            subsidiary_id: string;
            book_id: string;
            open_base: string;
            open_transaction: string;
          }>(
            sql`
          select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id, jl.subsidiary_id, je.book_id,
                 abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0) as open_base,
                 abs(jl.txn_amount) - coalesce(sum(a.target_transaction_amount) filter (where a.unapplied_at is null), 0) as open_transaction
            from journal_lines jl
            -- Live entries only: a reversed entry no longer carries a settleable open item.
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
            left join applications a on a.to_line_id = jl.id and a.org_id = jl.org_id
           where jl.org_id = ${doc.orgId} and jl.id in ${allocs.map((a) => a.openLineId)}
           group by jl.id, je.book_id
        `,
            "objects",
          );
    const targetById = new Map(targetsResult.map((row) => [row.id, row]));

    let sourceBaseRemaining = fromUnits(
      toUnits(source.amount) < 0n ? -toUnits(source.amount) : toUnits(source.amount),
    );
    // The source leg carries the applications plus any on-account remainder,
    // so the proportional base split must consume from that same wider pool —
    // otherwise the final application would absorb the remainder into its own
    // source leg and the on-account credit could never be spent.
    let sourceTransactionRemaining = add(totalAlloc, onAccountAmount);
    const applicationsToWrite: SettlementApplication[] = [];
    for (const allocation of allocs) {
      const target = targetById.get(allocation.openLineId);
      if (!target) throw new PaymentError("an application target disappeared while posting");
      if (
        target.account_id !== source.account_id ||
        target.party_id !== source.party_id ||
        target.subsidiary_id !== source.subsidiary_id ||
        target.book_id !== source.book_id
      ) {
        throw new PaymentError(
          "applications must settle the same control account, party, subsidiary, and book as the payment; " +
            "settle open items on different receivable or payable accounts in separate payments",
        );
      }
      const targetBase = carryingAmountForSettlement(
        target.open_base,
        target.open_transaction,
        allocation.targetTransactionAmount,
      );
      if (
        allocation.targetBaseAmount !== undefined &&
        cmp(allocation.targetBaseAmount, targetBase) !== 0
      ) {
        throw new PaymentError(
          `saved target base amount ${allocation.targetBaseAmount} no longer matches carrying amount ${targetBase}`,
        );
      }
      const sourceBase = carryingAmountForSettlement(
        sourceBaseRemaining,
        sourceTransactionRemaining,
        allocation.sourceTransactionAmount,
      );
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
      sourceTransactionRemaining = fromUnits(
        toUnits(sourceTransactionRemaining) - toUnits(allocation.sourceTransactionAmount),
      );
    }

    await writePaymentApplications({
      orgId: doc.orgId,
      sourceDocumentId: doc.id,
      documentNumber: doc.documentNumber,
      bookId: source.book_id,
      subsidiaryId: source.subsidiary_id,
      controlAccountId: source.account_id,
      partyId: doc.partyId,
      functionalCurrency: source.functional_currency,
      postingDate: source.posting_date,
      periodId: source.period_id,
      actorId: userId ?? doc.createdBy,
      gainLossAccountId: deps.control.fxRealizedGainLoss,
      applications: applicationsToWrite,
    });

    if (creditAllocs.length > 0) {
      await db.insert(schema.applications).values(
        creditAllocs.map((application) => ({
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
        })),
      );
    }

    const targetIds = [...allocs.map((a) => a.openLineId), ...creditAllocs.map((a) => a.toLineId)];
    const targets =
      targetIds.length === 0
        ? ([] as { doc_id: string }[])
        : await db.execute<{ doc_id: string }>(
            sql`
          select distinct je.source_document_id as doc_id
            from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           where jl.org_id = ${doc.orgId} and jl.id in ${targetIds} and je.source_document_id is not null
        `,
            "objects",
          );
    if (targets.length > 0) {
      await db.insert(schema.documentLinks).values(
        targets.map((target) => ({
          orgId: doc.orgId,
          fromDocumentId: doc.id,
          toDocumentId: target.doc_id,
          linkType: "pays" as const,
          createdBy: userId ?? doc.createdBy,
        })),
      );
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

  await expireStalePaymentLinkSessions(preflight.orgId, affectedInvoicesAfterCommit);

  if (!options.deferEffects) {
    await runPostDocumentEffects(paymentDocId, preflight.status);
  }
  return result;
}
