import { lockLedgerSetupFence } from '../organization/ledger-setup-fence.ts';
import { normalizeJournalCurrencyLines } from "./journal-currency.ts";
import { assertWithholdingDepositCurrent } from "../contractor-withholding/deposits.ts";
import { assertWithholdingRemittanceCurrent, ContractorWithholdingError } from "../contractor-withholding/service.ts";
import { PlaceOfSupplyError } from '../tax/place-of-supply.ts';
import { assertCanadianGoodsTaxEvidence } from '../tax/goods-selection.ts'
import { assertCrossBorderSupplyEvidence } from '../tax/cross-border-posting.ts';
import { documentTaxDate, staleTaxRateLine } from '../tax/document-tax-date.ts';
import { CrossBorderTaxError } from '../tax/cross-border-place-of-supply.ts';
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { assertProviderReturnPosting } from "../payments-core/provider-return-posting.ts";
import { assertReceiptFundingPosting } from "../payments-core/receipt-funding.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { assertExpenseEmployee, assertExpenseSettlement } from "../records/expense-validation.ts";
import { assertGeneratedBillingPostable, BillingSourceIntegrityError } from "../projects/billing-source-integrity.ts";
import { PayrollError as PayrollRemittanceError } from "../money/payroll-error.ts";
import { isZero, toUnits } from "../money/money.ts";
import { parseMoney, sumMoney } from "../money/brands.ts";
import { postingLineHooks } from "../journal/posting-line-contributors.ts";
import type { ContributedLine, PostContributionResult } from "../journal/contributed-lines.ts";
import { assertDocumentMutationRefsOwned } from "../records/mutation-refs.ts";
import { consolidationSourceRefusal } from "../records/consolidation-source-policy.ts";
import { runRecordFlows } from "../flows/run.ts";

import { postingPreconditionHooks, type DocumentScriptContext } from "../journal/posting-preconditions.ts";

import { type KernelLine, type PostingDeps, PostingError, effectivePostingDate } from "../journal/posting-contracts.ts";
import { resolveMarketplaceClearingForDocument, validateTaxControlAccounts } from "./posting-tax-policy.ts";
import { RULES } from "./posting-rules.ts";
import { assertFinalKernelBalance, assertCreditMemoDirection, retainedKernelLines } from "../journal/posting-invariants.ts";
import { resolveDeferralAccounts, resolveTaxAccounts, resolveExpenseReceivableDeps, resolveOrgTaxAccounts, resolveTaxComponents, validateRequiredDimensions, resolveOpenItemAccounts } from "./posting-accounts.ts";
import { resolveCashPostingTenders, TenderRefusal } from "../sales/document-tenders.ts";
import { CashCloseoutError, resolveCashCloseoutForPosting } from "../sales/cash-closeout.ts";
import { resolveProviderTaxPlans, resolveShipToSnapshot } from "./posting-provider-tax.ts";
import { applySubsidiaries } from "./posting-subsidiaries.ts";
import { resolveInternalBillingPostingContext } from "./internal-billing-posting.ts";
import { documentControlChoice, resolveDocumentControlAccount } from "./posting-control-account.ts";
import { assertPartylessControlPolicy } from "./partyless-control-policy.ts";
import { withNoChargeUnitsAccount } from "./posting-no-charge.ts";

import { postingEffectSubsidiaryId } from "./posting-dispatch.ts";
import { AmortizationError } from "../amortization/errors.ts";
import { resolveAmortizationRouting, type AmortizationRouting } from "../amortization/source-posting.ts";
import type { PostDocumentOptions } from "../journal/posting-contracts.ts";
import { carryRefusalIdentity } from "./posting-refusal-identity.ts";
import { finalizePostingHeader } from "./posting-header.ts";

/** Resolve inputs and automation before opening the accounting transaction. */
export async function prepareDocumentPosting(documentId: string, deps: PostingDeps, options: PostDocumentOptions) {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  try { assertProviderReturnPosting(doc); }
  catch (error) { if (error instanceof PaymentError) throw new PostingError(error.message); throw error; }
  // One configuration snapshot covers account routing, allocation and the
  // obligations/accruals that commit with this document's journal.
  await lockLedgerSetupFence(db,doc.orgId,'shared');
  await db.execute(sql`select id from orgs where id=${doc.orgId} for share`);
  await db.execute(sql`select i.id from items i where i.org_id=${doc.orgId} and i.id in
    (select item_id from document_lines where org_id=${doc.orgId} and document_id=${documentId}) order by i.id for share`);
  await db.execute(sql`select r.id from recognition_rules r where r.org_id=${doc.orgId} and r.id in
    (select i.recognition_rule_id from items i join document_lines l on l.item_id=i.id and l.org_id=i.org_id where l.org_id=${doc.orgId} and l.document_id=${documentId}) order by r.id for share`);
  const consolidationRefusal = await consolidationSourceRefusal(db, doc.orgId, documentId);
  if (consolidationRefusal) throw new PostingError(consolidationRefusal);
  if (doc.status === "posted")
    throw new PostingError(`document ${doc.documentNumber} already posted`);
  if (doc.status === "voided")
    throw new PostingError(`document ${doc.documentNumber} is voided`);
  if (doc.status !== "approved") {
    throw new PostingError(
      `document ${doc.documentNumber} is ${doc.status}; it must complete the approval submission lifecycle before posting`,
    );
  }
  try {await assertCanadianGoodsTaxEvidence(db,doc.orgId,doc.id)} catch(error) {if(error instanceof PlaceOfSupplyError)throw new PostingError(error.message);throw error}
  try {await assertCrossBorderSupplyEvidence(db,doc.orgId,doc.id)} catch(error) {if(error instanceof CrossBorderTaxError)throw new PostingError(error.message);throw error}
  // A credit correcting an earlier supply is taxed at that supply's rates. Its
  // correction can be recorded after its lines were priced, so posting holds
  // the calculated tax to the corrected document's date.
  const taxDate = await documentTaxDate(db, doc.orgId, doc.id, doc.documentDate);
  if (taxDate !== doc.documentDate) {
    const stale = await staleTaxRateLine(db, doc.orgId, doc.id, taxDate);
    if (stale) {
      throw new PostingError(
        `line ${stale.line_number} carries ${stale.code} at ${stale.stored}%, but ${stale.effective === null ? "no rate is" : `${stale.effective}% is`} in effect on ${taxDate}, the date of the document this credit corrects — save the credit's lines so their tax is recalculated at that date`,
      );
    }
  }
  assertCreditMemoDirection(doc, deps.migration);
  if (
    (doc.kind === "journal" ||
      doc.kind === "deposit" ||
      doc.kind === "expense_report" ||
      doc.kind === "check") &&
    !deps.openItemAccountIds
  ) {
    deps = {
      ...deps,
      openItemAccountIds: await resolveOpenItemAccounts(db, doc.orgId),
    };
  }
  deps = await resolveExpenseReceivableDeps(db, doc, deps);
  if (!deps.taxCollectedByCode && doc.kind !== "journal") {
    const tax = await resolveTaxAccounts(db, doc.orgId);
    const fallback = await resolveOrgTaxAccounts(db, doc.orgId);
    deps = {
      ...deps,
      control: {
        ...deps.control,
        taxCollected: deps.control.taxCollected ?? fallback.taxCollected,
        taxPaid: deps.control.taxPaid ?? fallback.taxPaid,
      },
      taxCollectedByCode: tax.collected,
      taxPaidByCode: tax.paid,
    };
  }
  if (
    doc.kind !== "journal" &&
    (!deps.control.taxCollected || !deps.control.taxPaid)
  ) {
    const fallback = await resolveOrgTaxAccounts(db, doc.orgId);
    deps = {
      ...deps,
      control: {
        ...deps.control,
        taxCollected: deps.control.taxCollected ?? fallback.taxCollected,
        taxPaid: deps.control.taxPaid ?? fallback.taxPaid,
      },
    };
  }
  if (!deps.taxComponentsByLine && doc.kind !== "journal") {
    deps = {
      ...deps,
      taxComponentsByLine: await resolveTaxComponents(db, doc.id, doc.orgId),
    };
  }
  deps = await resolveMarketplaceClearingForDocument(db, doc, deps);
  deps = { ...deps, agencyByLine: await postingLineHooks.require("inventory").agencyByLine(db, doc.orgId, doc.id) };
  if ((doc.kind === "customer_invoice" || doc.kind === "cash_sale") && !deps.deferralAccountByLine) {
    deps = {
      ...deps,
      deferralAccountByLine: await resolveDeferralAccounts(db, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "customer_invoice" && !deps.storedValueLiabilityByLine) {
    deps = {
      ...deps,
      storedValueLiabilityByLine: await postingLineHooks.require("stored-value").liabilityByLine(db, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "customer_credit" && !deps.storeCreditLiabilityAccountId) {
    const custom = (doc.custom ?? {}) as { storeCreditProgramId?: unknown };
    if (typeof custom.storeCreditProgramId === "string" && custom.storeCreditProgramId) {
      deps = {
        ...deps,
        storeCreditLiabilityAccountId: await postingLineHooks.require("stored-value").storeCreditLiability(db, doc.orgId, custom.storeCreditProgramId),
      };
    }
  }
  if ((doc.kind === "cash_sale" || doc.kind === "cash_refund") && !deps.cashTenders) {
    try {
      deps = {
        ...deps,
        cashTenders: await resolveCashPostingTenders(db, doc.orgId, doc.id, {
          kind: doc.kind,
          documentNumber: doc.documentNumber,
          kindLabel: doc.kind === "cash_sale" ? "cash sale" : "cash refund",
          partyId: doc.partyId,
          custom: doc.custom,
        }, { validateRefundLoads: true }),
      };
    } catch (error) {
      if (error instanceof TenderRefusal) throw new PostingError(error.message);
      throw error;
    }
  }
  deps = await withNoChargeUnitsAccount(db, doc, deps);
  // Daily close-out (cash_sale only): tips, processor fees and the counted
  // over/short from documents.custom.closeout, with its control accounts
  // resolved. A close-out on a refund refuses at the write boundary; this
  // backstop catches bags written around it (or before the fence existed).
  if (doc.kind === "cash_refund" && (doc.custom as Record<string, unknown> | null)?.closeout !== undefined) {
    throw new PostingError(
      `cash refund ${doc.documentNumber} carries a close-out — record tips, fees and over/short on the cash sale`,
    );
  }
  if (doc.kind === "cash_sale" && deps.cashCloseout === undefined) {
    try {
      deps = {
        ...deps,
        cashCloseout: await resolveCashCloseoutForPosting(
          db,
          doc.orgId,
          doc.custom,
          (deps.cashTenders ?? []).map((tender) => ({
            kind: tender.kind,
            amountMinor: toUnits(tender.amount),
          })),
        ),
      };
    } catch (error) {
      // PostingError carries no remedy field: the named Setup remedy rides
      // in the message so the operator sees it beside the refusal.
      if (error instanceof CashCloseoutError) throw new PostingError(`${error.message} ${error.remedy}`);
      throw error;
    }
  }
  if (doc.kind === "vendor_bill" && !deps.migration) {
    // A hand-coded line for received stock is matched to its order inside
    // this same posting unit — before the journal maps its debit — so it
    // clears received-not-billed instead of receiving the stock again.
    const inventory = postingPreconditionHooks.require("inventory");
    try {
      await inventory.matchBillLinesToOrders(db, doc.orgId, doc.id, options.audit?.actorId ?? null);
    } catch (error) {
      if (error instanceof PostingError) throw error;
      throw carryRefusalIdentity(
        new PostingError(error instanceof Error ? error.message : String(error)),
        error,
      );
    }
  }
  if (doc.kind === "vendor_bill" && !deps.inventoryAssetByLine) {
    deps = {
      ...deps,
      inventoryAssetByLine: await postingLineHooks.require("inventory").billInventoryAccounts(
        db,
        doc.orgId,
        doc.id,
      ),
    };
  }
  if (doc.kind === "vendor_bill" && !deps.migration) {
    const inventory = postingPreconditionHooks.require("inventory");
    try {
      await inventory.assertBillReceiptsPostable(db, doc.orgId, doc.id);
    } catch (error) {
      if (error instanceof PostingError) throw error;
      throw carryRefusalIdentity(
        new PostingError(error instanceof Error ? error.message : String(error)),
        error,
      );
    }
  }
  if ((doc.kind === "customer_invoice" || doc.kind === "cash_sale") && !deps.migration) {
    const inventory = postingPreconditionHooks.require("inventory");
    try {
      await inventory.assertInvoiceIssuesPostable(db, doc.orgId, doc.id);
    } catch (error) {
      if (error instanceof PostingError) throw error;
      throw new PostingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (
    doc.kind === "vendor_credit" &&
    !deps.migration &&
    !deps.inventoryReturnOffsetByLine
  ) {
    deps = {
      ...deps,
      inventoryReturnOffsetByLine: await postingLineHooks.require("inventory").vendorCreditReturnAccounts(
        db,
        doc.orgId,
        doc.id,
      ),
    };
  }
  if (doc.kind === "vendor_credit" && !deps.migration) {
    const inventory = postingPreconditionHooks.require("inventory");
    try {
      await inventory.assertVendorCreditReturnsPostable(
        db,
        doc.orgId,
        doc.id,
        doc.partyId,
        await postingEffectSubsidiaryId(doc.orgId, doc.subsidiaryId),
      );
    } catch (error) {
      if (error instanceof PostingError) throw error;
      throw new PostingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if ((doc.kind === "customer_credit" || doc.kind === "cash_refund") && !deps.migration) {
    // Same backstop as the vendor leg: a return whose evidence cannot be
    // satisfied must fail BEFORE the journal commits, not inside the
    // post-commit effects drain where the credit is already posted and the
    // stock silently never comes back.
    const inventory = postingPreconditionHooks.require("inventory");
    try {
      await inventory.assertCustomerCreditReturnsPostable(
        db,
        doc.orgId,
        doc.id,
        doc.partyId,
        await postingEffectSubsidiaryId(doc.orgId, doc.subsidiaryId),
      );
    } catch (error) {
      if (error instanceof PostingError) throw error;
      throw new PostingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(and(eq(schema.documentLines.documentId, documentId), eq(schema.documentLines.orgId, doc.orgId)))
    .orderBy(asc(schema.documentLines.lineNumber));

  if (!deps.migration) {
    try { await assertReceiptFundingPosting(db, doc, options.audit?.actorId ?? null, lines.map(line => line.accountId)); }
    catch (error) { if (error instanceof PaymentError) throw new PostingError(error.message); throw error; }
  }

  if (doc.kind === "internal_billing" && !deps.internalBilling) {
    deps = {
      ...deps,
      internalBilling: await resolveInternalBillingPostingContext(db, doc, lines, { enforceFeatures: !deps.migration }),
    };
  }

  try {
    await assertGeneratedBillingPostable(db, doc.orgId, documentId, { document: doc, lines });
  } catch (error) {
    if (error instanceof BillingSourceIntegrityError) throw new PostingError(error.message);
    throw error;
  }

  // A remittance bill posts its source entity's books in its stamped
  // currency: reconcile it against live payroll here (fail fast, before FX
  // translation or flow evidence) and repeat under lock at commit, exactly
  // like the generated-billing guard above. Non-remittance documents return
  // from the check itself.
  try {
    await postingPreconditionHooks.require("payroll").assertRemittanceBillCurrent(doc.orgId, documentId, db);
    try { await assertWithholdingRemittanceCurrent(db, doc.orgId, documentId, { document: doc, lines }); await assertWithholdingDepositCurrent(db, doc.orgId, documentId, { document: doc, lines }); }
    catch (error) { if (error instanceof ContractorWithholdingError) throw new PostingError(error.remedy ? `${error.message} ${error.remedy}` : error.message); throw error; }
  } catch (error) {
    if (error instanceof PayrollRemittanceError) throw new PostingError(error.message);
    throw error;
  }

  // Fail closed before before_post scripts/flows can emit downstream evidence.
  // The tax component snapshot and the resolved org fallback are the only
  // authoritative destinations; AP/AR are never silently substituted.
  validateTaxControlAccounts(doc, lines, deps);

  const rule = RULES[doc.kind];
  if (!rule)
    throw new PostingError(`no posting rule for document kind "${doc.kind}"`);

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await db
      .select()
      .from(schema.paymentCards)
      .where(and(eq(schema.paymentCards.id, doc.paymentCardId), eq(schema.paymentCards.orgId, doc.orgId)));
    if (card)
      deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }

  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, doc.orgId));
  if (!org) throw new PostingError("organization not found");
  // Resolve authoritative external tax before scripts, flows, period checks,
  // or the posting transaction can write anything. A provider outage therefore
  // fails closed with no document/journal effects. Existing line-linked quotes
  // are replayed byte-for-byte, so a retry never depends on a changed endpoint.
  const providerPlans = await resolveProviderTaxPlans(doc, lines, deps);
  const postingLines = lines;
  if (providerPlans.length > 0) {
    const providerComponents = new Map(deps.taxComponentsByLine ?? []);
    for (const plan of providerPlans) providerComponents.set(plan.line.id, plan.components);
    deps = { ...deps, taxComponentsByLine: providerComponents };
  }
  const scripts = postingPreconditionHooks.require("scripting");
  const scriptUser = await scripts.resolveUser(doc.orgId, options.audit?.actorId ?? null);
  const scriptCtx: DocumentScriptContext = {
    trigger: "before_post",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    ...(scriptUser ? { user: scriptUser } : {}),
  };

  // -- user scripts: before_post (veto / mutate) --------------------------
  const outcomes = options.suppressAutomation
    ? []
    : await scripts.runTrigger("before_post", scriptCtx, doc.id);
  const bad = outcomes.find((o) => o.status !== "ok");
  if (bad) {
    throw new PostingError(
      bad.status === "aborted"
        ? `posting vetoed by script "${bad.name}": ${bad.abortReason}`
        : `script "${bad.name}" ${bad.status}: ${bad.abortReason ?? ""}`,
    );
  }
  let effectiveDoc = doc;
  const mutations = outcomes.reduce<Record<string, unknown>>((merged, outcome) => {
    for (const [key, value] of Object.entries(outcome.set ?? {})) {
      if (key === "custom") {
        // custom is a JSON blob, so Object.assign would replace the complete
        // document and could erase or replace posting controls between
        // approval and the kernel. Merge only non-financial keys and preserve
        // every existing protected value from the approved document.
        merged.custom = scripts.mergeBeforePostCustomMutation(
          merged.custom ?? doc.custom,
          value,
        );
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }, {});
  if (Object.keys(mutations).length > 0) {
    // Same fence as the submit path: before_post script mutations write
    // around applyDocumentEdit, so shapes and org ownership are proven here.
    await assertDocumentMutationRefsOwned(
      doc.orgId,
      doc.kind,
      Object.entries(mutations).map(([field, value]) => ({ field, value })),
    );
    const [updated] = await db
      .update(schema.documents)
      .set(mutations)
      .where(and(eq(schema.documents.id, doc.id), eq(schema.documents.orgId, doc.orgId)))
      .returning();
    effectiveDoc = updated!;
  }

  // -- flows: before_post (automation only, never a veto) ------------------
  // A before_post flow may set_field whitelisted headers; re-read the
  // document so its projection reflects them.
  const beforePostFlows = options.suppressAutomation
    ? { runs: [], gatesCreated: 0, failed: false, error: null }
    : await runRecordFlows(
        { kind: "before_post" },
        doc.kind,
        doc.id,
        {
          orgId: doc.orgId,
        },
      );
  if (beforePostFlows.gatesCreated > 0 || beforePostFlows.failed) {
    const runIds = beforePostFlows.runs.map((run) => run.runId);
    if (runIds.length > 0) {
      await db
        .update(schema.flowGates)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            inArray(schema.flowGates.runId, runIds),
            eq(schema.flowGates.orgId, doc.orgId),
            inArray(schema.flowGates.status, ["pending", "escalated"]),
          ),
        );
      await db
        .update(schema.flowRuns)
        .set({
          status: "failed",
          error: beforePostFlows.failed
            ? "before-post automation failed"
            : "approval gates must be configured on on_submit",
          finishedAt: new Date(),
        })
        .where(and(inArray(schema.flowRuns.id, runIds), eq(schema.flowRuns.orgId, doc.orgId)));
    }
    throw new PostingError(
      beforePostFlows.failed
        ? "a before-post flow failed; posting stopped"
        : "before-post approval gates are not a posting release — configure approval gates on on_submit",
    );
  }
  if (beforePostFlows.runs.length > 0) {
    const [refreshed] = await db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.id, doc.id), eq(schema.documents.orgId, doc.orgId)));
    if (refreshed) effectiveDoc = refreshed;
  }

  const changedPostingControl = scripts.beforePostCustomControlsChanged(doc.custom, effectiveDoc.custom);
  if (changedPostingControl) throw new PostingError(changedPostingControl);

  // Revalidate the effective header after scripts/flows, including legacy
  // approved reports that never passed the current submission boundary.
  try {
    await assertExpenseEmployee(db, effectiveDoc);
    await assertExpenseSettlement(db, effectiveDoc);
  } catch (error) {
    throw new PostingError((error as Error).message);
  }

  const finalHeader = await finalizePostingHeader(effectiveDoc, deps.migration === true);
  effectiveDoc = finalHeader.header;
  const dueDateFromTerms = finalHeader.dueDateFromTerms;

  // -- receivable/payable control account ---------------------------------
  // A party document posts its open item to the document's own choice, else
  // the party's default, else the organization control account. The resolved
  // account is validated here (active, posting, the side's account type, the
  // document's legal entity) and stamped on the document by the posting flip,
  // so every later consumer of the open item — and any regeneration — reads
  // the account the entry actually carries. Historical replay reproduces the
  // source's own account selection and is never re-resolved.
  let controlAccountStamp: string | null = null;
  const storeCreditMemo = effectiveDoc.kind === "customer_credit" && !!deps.storeCreditLiabilityAccountId;
  if (!deps.migration && !storeCreditMemo) {
    const resolved = await resolveDocumentControlAccount(db, effectiveDoc, deps.control);
    if (resolved) {
      controlAccountStamp = resolved.accountId;
      if (documentControlChoice(effectiveDoc.custom) !== resolved.accountId) {
        effectiveDoc = {
          ...effectiveDoc,
          custom: { ...((effectiveDoc.custom ?? {}) as Record<string, unknown>), controlAccountId: resolved.accountId },
        };
      }
    }
  }

  // -- expense amortization -------------------------------------------------
  // Lines naming an amortization template debit the template's deferral
  // account; commit creates their schedules from the posted legs. Resolved
  // on the final header, so the template version follows the posting date.
  let amortizationRouting: Map<string, AmortizationRouting> = new Map();
  if (!deps.amortizationByLine) {
    try {
      amortizationRouting = await resolveAmortizationRouting(
        db,
        { orgId: doc.orgId, kind: doc.kind, transactionDate: effectivePostingDate(effectiveDoc) },
        postingLines,
        { inventoryLineIds: new Set([...(deps.inventoryAssetByLine?.keys() ?? []), ...(deps.agencyByLine?.keys() ?? [])]) },
      );
    } catch (error) {
      if (error instanceof AmortizationError) {
        throw carryRefusalIdentity(new PostingError(`${error.message} ${error.remedy}`), error);
      }
      throw error;
    }
    if (amortizationRouting.size > 0) deps = { ...deps, amortizationByLine: amortizationRouting };
  }

  // -- build + validate kernel lines --------------------------------------
  if (!deps.migration) {
    try { await assertReceiptFundingPosting(db, effectiveDoc, options.audit?.actorId ?? null, postingLines.map(line => line.accountId)); }
    catch (error) { if (error instanceof PaymentError) throw new PostingError(error.message); throw error; }
  }
  const kernelLines = retainedKernelLines(
    await normalizeJournalCurrencyLines(db,effectiveDoc,rule(effectiveDoc, postingLines, deps)),
    effectiveDoc.journalMode === "statistical",
  );
  const total = sumMoney(kernelLines.map((l) => l.balanceTxnAmount ?? l.amount));
  if (!isZero(total)) {
    throw new PostingError(
      `posting rule for ${doc.kind} does not balance (sum=${total})`,
    );
  }

  // -- direct receivable/payable postings ---------------------------------
  // A manual journal or deposit line on a receivable/payable account with no
  // customer or vendor bypasses the sub-ledger. The organization's policy
  // decides whether that posts with a warning or is refused here, before any
  // automation or ledger write. Historical replay reproduces the source.
  if (!deps.migration) await assertPartylessControlPolicy(db, effectiveDoc, kernelLines);

  // -- allocation kernel: post-mode RULE contributions --------------------
  // Rules in effect on the posting date contribute dimensional-attribution /
  // reclass legs to the transaction's own entry. Each contributor's set must
  // balance per subsidiary on its own; the union then flows through
  // applySubsidiaries / assertFinalKernelBalance / validateRequiredDimensions
  // unchanged. Migration replay and automation-suppressed runs never
  // contribute; a closed gate contributes nothing.
  const allocations = postingLineHooks.require("allocations");
  const postContrib: PostContributionResult = await allocations.collectPostContributions(
    db,
    {
      id: effectiveDoc.id,
      orgId: effectiveDoc.orgId,
      kind: effectiveDoc.kind,
      postingDate: effectiveDoc.postingDate,
      documentDate: effectiveDoc.documentDate,
      currency: effectiveDoc.currency,
      subsidiaryId: effectiveDoc.subsidiaryId,
    },
    kernelLines,
    {
      migration: deps.migration,
      suppressAutomation: options.suppressAutomation,
      actorId: options.audit?.actorId ?? null,
    },
    effectivePostingDate(effectiveDoc),
  );
  allocations.assertContributorBalance(postContrib.lines);
  const primaryContrib = postContrib.lines.filter((l) => l.bookId === undefined);
  // applySubsidiaries stamps in order and appends intercompany legs after,
  // so stamped[i] corresponds to unionLines[i] below for the contributor
  // stamps and lineage mapping at insert time.
  // Cross-module intake: contributor lines carry the frozen allocations
  // shape, so the kernel parses amounts once here (fail closed) instead of
  // asserting a brand across the freeze boundary.
  const unionLines: (KernelLine & {
    contributorKind?: string | null;
    contributorRef?: string | null;
  })[] = [
    ...kernelLines,
    ...primaryContrib.map((l) => ({ ...l, amount: parseMoney(l.amount) })),
  ];

  // -- allocation kernel: custom_gl_lines user scripts ---------------------
  // Scripts observe the kernel read-only (kernel lines plus the rule
  // contributions above) and return extra balanced lines. A refusal throws
  // inside the posting transaction, so a refused script set rolls every
  // document/ledger mutation back; the completed-run evidence is carried on
  // the refusal for out-of-band re-record by the coordinator. Suppressed for
  // replay/migration like automation.
  let customGlLines: ContributedLine[] = [];
  if (!options.suppressAutomation && !deps.migration) {
    const lineScripts = postingLineHooks.require("scripting");
    try {
      customGlLines = await lineScripts.runCustomGlLines({
        orgId: doc.orgId,
        document: effectiveDoc as unknown as Record<string, unknown>,
        documentLines: postingLines as unknown as Record<string, unknown>[],
        kernelLines: unionLines as unknown as Record<string, unknown>[],
        actorId: options.audit?.actorId ?? null,
        targetId: doc.id,
      });
    } catch (error) {
      // A refused script set arrives as a PostingError carrying the
      // completed-run evidence; its message is preserved verbatim — callers
      // match on it.
      if (error instanceof PostingError) throw error;
      throw new PostingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // -- open-item lines must carry a subledger party (AR/AP faithfulness) ----
  // Every AR/AP line carries its customer/vendor (AR⇒customer, AP⇒vendor).
  // An open-item leg with no party can't age or net by entity and would break
  // the subledger↔GL tie-out, so fail loudly rather than post a party-less
  // receivable/payable.
  const orphanOpenItem = kernelLines.find((l) => l.isOpenItem && !l.partyId);
  if (orphanOpenItem) {
    throw new PostingError(
      `open-item line on account ${orphanOpenItem.accountId} has no party — every AR/AP line must carry its customer/vendor (line entity)`,
    );
  }

  // -- subcontractor compliance: block_bill requirements -------------------
  // A vendor bill for a subcontractor whose insurance/licence has lapsed under a
  // `block_bill` policy cannot be recorded at all. Enforced here, in the kernel,
  // so no import, script, or API route can route around it. Migration posts are
  // exempt: historical books are reproduced as they were, not re-adjudicated.
  if (
    !deps.migration &&
    effectiveDoc.partyId &&
    (effectiveDoc.kind === "vendor_bill" ||
      effectiveDoc.kind === "expense_report")
  ) {
    await postingPreconditionHooks.require("compliance").assertBillPostingAllowed({
      orgId: doc.orgId,
      partyId: effectiveDoc.partyId,
      projectId: effectiveDoc.projectId ?? null,
      documentNumber: effectiveDoc.documentNumber,
      asOf: effectivePostingDate(effectiveDoc),
    });
  }

  if (
    !deps.migration &&
    effectiveDoc.partyId &&
    effectiveDoc.kind === "customer_invoice"
  ) {
    const hold = (await db.execute<{ hold_reason: string | null }>(sql`
      select hold_reason
        from customer_roles
       where org_id = ${effectiveDoc.orgId} and party_id = ${effectiveDoc.partyId}
         and is_active and is_on_hold
       limit 1
    `, "objects"));
    if (hold[0]) {
      throw new PostingError(
        `customer is on credit hold${hold[0].hold_reason ? ` — ${hold[0].hold_reason}` : ""}; release the hold on the customer section of the party record before posting`,
      );
    }
  }

  // -- subsidiaries: stamp, intercompany-balance, validate restrictions ----
  // A book-specific journal is measured in its target book's basis.
  const postingBookId = doc.kind === "journal" ? doc.accountingBookId ?? null : null;
  const subApplied = await applySubsidiaries(db, effectiveDoc, unionLines, { bookId: postingBookId, regeneration: false });
  assertFinalKernelBalance(subApplied.lines);
  // Script contributions translate through the same subsidiary/FX kernel
  // (defaults, spot rates, restriction checks). The host proved they balance
  // per subsidiary among themselves, so this adds no intercompany legs — the
  // length check below proves the set survived unchanged.
  let scriptLines: (KernelLine & {
    subsidiaryId: string;
    currency: string;
    txnAmount: string;
    fxRate: string;
    contributorKind: "script";
    contributorRef: string;
  })[] = [];
  if (customGlLines.length > 0) {
    const translated = await applySubsidiaries(
      db,
      effectiveDoc,
      customGlLines.map((l) => ({ ...l, amount: parseMoney(l.amount) })),
      { bookId: postingBookId, regeneration: false, withholdingCarrying: false },
    );
    if (translated.lines.length !== customGlLines.length) {
      throw new PostingError(
        "custom_gl_lines contributions did not survive subsidiary application unchanged",
      );
    }
    // No open-item legs from scripts: contributed lines carry no party, and a
    // party-less leg on a receivable/payable account would post GL history
    // the subledger can never tie to.
    const openItemAccountIds =
      deps.openItemAccountIds ?? (await resolveOpenItemAccounts(db, doc.orgId));
    const openItemLine = translated.lines.find((l) =>
      openItemAccountIds.has(l.accountId),
    );
    if (openItemLine) {
      throw new PostingError(
        `custom_gl_lines cannot post to open-item account ${openItemLine.accountId} (contributed lines carry no party)`,
      );
    }
    scriptLines = translated.lines.map((l, i) => ({
      ...l,
      contributorKind: "script" as const,
      contributorRef: customGlLines[i]!.contributorRef,
    }));
  }
  await validateRequiredDimensions(db, doc.orgId, [
    ...subApplied.lines,
    ...scriptLines,
  ]);
  assertFinalKernelBalance([...subApplied.lines, ...scriptLines]);

  // -- ship-to destination snapshot (0265) ------------------------------------
  // Freeze the sale's destination jurisdiction from the EFFECTIVE document
  // (post-scripts/flows party) so the nexus ledger attributes the sale to
  // where it was taxed/posted, forever. Migration replay stamps nothing:
  // live addresses are not posting-time evidence for history.
  const shipToSnapshot = deps.migration
    ? null
    : await resolveShipToSnapshot(effectiveDoc, postingLines);

  const postingDate = effectivePostingDate(effectiveDoc);
  return { documentId, deps, doc, postingLines, effectiveDoc, kernelLines, postContrib, primaryContrib, unionLines, subApplied, scriptLines, postingDate, shipToSnapshot, controlAccountStamp, dueDateFromTerms, amortizationRouting };
}
