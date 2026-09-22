import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { assertExpenseEmployee, assertExpenseSettlement } from "../records/expense-validation.ts";
import { assertGeneratedBillingPostable, BillingSourceIntegrityError } from "../projects/billing-source-integrity.ts";
import { isZero, sum } from "../money/money.ts";
import { mergeBeforePostCustomMutation, resolveScriptUser, runCustomGlLineScripts, runTriggerScripts, type ScriptContext } from "../scripting/scripting.ts";
import type { ContributedLine } from "../allocations/types.ts";
import { assertContributorBalance, collectPostContributions, PostAllocationError, type PostContributionResult } from "../allocations/post.ts";
import { postDriverResolver } from "../allocations/report-runner.ts";
import { assertDocumentMutationRefsOwned } from "../records/mutation-refs.ts";
import { runRecordFlows } from "../flows/run.ts";

import { assertBillReceiptsPostable, resolveBillInventoryAccounts } from "../inventory/documents-purchasing.ts";
import { assertInvoiceIssuesPostable } from "../inventory/documents-sales.ts";
import { assertVendorCreditInventoryReturnsPostable, resolveVendorCreditInventoryAccounts } from "../inventory/documents-vendor-credits.ts";
import { assertCustomerCreditInventoryReturnsPostable } from "../inventory/documents-customer-credits.ts";

import { assertBillPostingAllowed, ComplianceError } from "../compliance/compliance.ts";

import { type KernelLine, type PostingDeps, PostingError } from "./posting-contracts.ts";
import { validateTaxControlAccounts } from "./posting-tax-policy.ts";
import { RULES } from "./posting-rules.ts";
import { assertFinalKernelBalance, assertCreditMemoDirection } from "./posting-invariants.ts";
import { resolveDeferralAccounts, resolveTaxAccounts, resolveExpenseReceivableDeps, resolveOrgTaxAccounts, resolveTaxComponents, validateRequiredDimensions, resolveOpenItemAccounts } from "./posting-accounts.ts";
import { resolveProviderTaxPlans } from "./posting-provider-tax.ts";
import { applySubsidiaries } from "./posting-subsidiaries.ts";

import { postingEffectSubsidiaryId } from "./posting-dispatch.ts";
import type { PostDocumentOptions } from "./posting-contracts.ts";

/** Resolve inputs and automation before opening the accounting transaction. */
export async function prepareDocumentPosting(documentId: string, deps: PostingDeps, options: PostDocumentOptions) {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  if (doc.status === "posted")
    throw new PostingError(`document ${doc.documentNumber} already posted`);
  if (doc.status === "voided")
    throw new PostingError(`document ${doc.documentNumber} is voided`);
  if (doc.status !== "approved") {
    throw new PostingError(
      `document ${doc.documentNumber} is ${doc.status}; it must complete the approval submission lifecycle before posting`,
    );
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
  if (doc.kind === "customer_invoice" && !deps.deferralAccountByLine) {
    deps = {
      ...deps,
      deferralAccountByLine: await resolveDeferralAccounts(db, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "vendor_bill" && !deps.inventoryAssetByLine) {
    deps = {
      ...deps,
      inventoryAssetByLine: await resolveBillInventoryAccounts(
        db,
        doc.orgId,
        doc.id,
      ),
    };
  }
  if (doc.kind === "vendor_bill" && !deps.migration) {
    try {
      await assertBillReceiptsPostable(db, doc.orgId, doc.id);
    } catch (error) {
      if (error instanceof PostingError) throw error;
      throw new PostingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (doc.kind === "customer_invoice" && !deps.migration) {
    try {
      await assertInvoiceIssuesPostable(db, doc.orgId, doc.id);
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
      inventoryReturnOffsetByLine: await resolveVendorCreditInventoryAccounts(
        db,
        doc.orgId,
        doc.id,
      ),
    };
  }
  if (doc.kind === "vendor_credit" && !deps.migration) {
    try {
      await assertVendorCreditInventoryReturnsPostable(
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

  if (doc.kind === "customer_credit" && !deps.migration) {
    // Same backstop as the vendor leg: a return whose evidence cannot be
    // satisfied must fail BEFORE the journal commits, not inside the
    // post-commit effects drain where the credit is already posted and the
    // stock silently never comes back.
    try {
      await assertCustomerCreditInventoryReturnsPostable(
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

  try {
    await assertGeneratedBillingPostable(db, doc.orgId, documentId, { document: doc, lines });
  } catch (error) {
    if (error instanceof BillingSourceIntegrityError) throw new PostingError(error.message);
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
  const scriptUser = await resolveScriptUser(doc.orgId, options.audit?.actorId ?? null, { required: false });
  const scriptCtx: ScriptContext = {
    trigger: "before_post",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    ...(scriptUser ? { user: scriptUser } : {}),
  };

  // -- user scripts: before_post (veto / mutate) --------------------------
  const outcomes = options.suppressAutomation
    ? []
    : await runTriggerScripts("before_post", scriptCtx, doc.id);
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
        merged.custom = mergeBeforePostCustomMutation(
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
    ? { runs: [], gatesCreated: 0, failed: false }
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

  // Revalidate the effective header after scripts/flows, including legacy
  // approved reports that never passed the current submission boundary.
  try {
    await assertExpenseEmployee(db, effectiveDoc);
    await assertExpenseSettlement(db, effectiveDoc);
  } catch (error) {
    throw new PostingError((error as Error).message);
  }

  // -- build + validate kernel lines --------------------------------------
  const kernelLines = rule(effectiveDoc, postingLines, deps).filter(
    (l) => !isZero(l.amount),
  );
  if (kernelLines.length < 2)
    throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(kernelLines.map((l) => l.amount));
  if (!isZero(total)) {
    throw new PostingError(
      `posting rule for ${doc.kind} does not balance (sum=${total})`,
    );
  }

  // -- allocation kernel: post-mode RULE contributions (A5) ----------------
  // Rules in effect on the posting date contribute dimensional-attribution /
  // reclass legs to the transaction's own entry. Each contributor's set must
  // balance per subsidiary on its own; the union then flows through
  // applySubsidiaries / assertFinalKernelBalance / validateRequiredDimensions
  // unchanged. Migration replay and automation-suppressed runs never
  // contribute; a closed gate contributes nothing.
  let postContrib: PostContributionResult = { lines: [], reportOnly: [] };
  try {
    postContrib = await collectPostContributions(
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
        driverResolver: postDriverResolver,
        actorId: options.audit?.actorId ?? null,
      },
      { postingDate: effectiveDoc.postingDate ?? effectiveDoc.documentDate },
    );
  } catch (error) {
    if (error instanceof PostAllocationError) throw new PostingError(error.message);
    throw error;
  }
  assertContributorBalance(postContrib.lines);
  const primaryContrib = postContrib.lines.filter((l) => l.bookId === undefined);
  // applySubsidiaries stamps in order and appends intercompany legs after,
  // so stamped[i] corresponds to unionLines[i] below for the contributor
  // stamps and lineage mapping at insert time.
  const unionLines: (KernelLine & {
    contributorKind?: string | null;
    contributorRef?: string | null;
  })[] = [...kernelLines, ...primaryContrib];

  // -- allocation kernel: custom_gl_lines user scripts (A6) -----------------
  // Scripts observe the kernel read-only (kernel lines plus the rule
  // contributions above) and return extra balanced lines. A refusal throws
  // before the posting transaction opens, so a refused script set leaves no
  // partial write behind. Suppressed for replay/migration like automation.
  let customGlLines: ContributedLine[] = [];
  if (!options.suppressAutomation && !deps.migration) {
    try {
      customGlLines = await runCustomGlLineScripts({
        orgId: doc.orgId,
        document: effectiveDoc as unknown as Record<string, unknown>,
        documentLines: postingLines as unknown as Record<string, unknown>[],
        kernelLines: unionLines as unknown as Record<string, unknown>[],
        actorId: options.audit?.actorId ?? null,
        targetId: doc.id,
      });
    } catch (error) {
      if (error instanceof PostingError) throw error;
      throw new PostingError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // -- open-item lines must carry a subledger party (AR/AP faithfulness) ----
  // Every source system (source platform line "Name", source platform line Entity) puts a
  // customer/vendor on each AR/AP line, and both enforce AR⇒customer, AP⇒vendor.
  // An open-item leg with no party can't age or net by entity — the exact defect
  // that let party-less month-end journals corrupt the subledger↔GL tie-out.
  // Fail loudly rather than post a party-less receivable/payable.
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
    try {
      await assertBillPostingAllowed({
        orgId: doc.orgId,
        partyId: effectiveDoc.partyId,
        projectId: effectiveDoc.projectId ?? null,
        documentNumber: effectiveDoc.documentNumber,
        asOf: effectiveDoc.postingDate ?? effectiveDoc.documentDate,
      });
    } catch (error) {
      if (error instanceof ComplianceError)
        throw new PostingError(error.message);
      throw error;
    }
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
    `));
    if (hold.rows[0]) {
      throw new PostingError(
        `customer is on credit hold${hold.rows[0].hold_reason ? ` — ${hold.rows[0].hold_reason}` : ""}`,
      );
    }
  }

  // -- subsidiaries: stamp, intercompany-balance, validate restrictions ----
  const subApplied = await applySubsidiaries(db, effectiveDoc, unionLines);
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
    const translated = await applySubsidiaries(db, effectiveDoc, customGlLines);
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

  const postingDate = effectiveDoc.postingDate ?? effectiveDoc.documentDate;
  return { documentId, deps, doc, postingLines, effectiveDoc, kernelLines, postContrib, primaryContrib, unionLines, subApplied, scriptLines, postingDate };
}
