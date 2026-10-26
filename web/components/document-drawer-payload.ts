import { useEffect, useMemo, useState } from "react";
import { segmentAssignmentsFromCells } from "../lib/segment-assignments";
import { asDocumentDoc, type DocPayload } from "./document-drawer-types";
import {
  drawerTaxInputAmount,
  emptyLine,
  isBlankDrawerLine,
  positiveAmount,
  returnCellPayload,
  toRow,
} from "./document-drawer-lines";
import {
  findCurrencyMismatchedAccount,
  reconcilePersistedDocumentSnapshot,
  savePayloadFingerprint,
  type CurrencyMismatchedAccount,
} from "./document-drawer-save";
import type { DocumentDrawerEntryScope } from "./document-drawer-entry";

/**
 * The save payload, unsaved-edit tracking against the persisted snapshot,
 * form rehydration, and the up-front settlement-currency proof.
 */
export function useDocumentDrawerPayload(scope: DocumentDrawerEntryScope) {
  const {
    doc,
    payload,
    withholdingSchemes,
    isTransfer,
    isCreate,
    editable,
    config,
    t,
    refuse,
    accounts,
    bankAccounts,
    cardAccounts,
    segments,
    lineDefs,
    rows,
    setRows,
    transfer,
    setTransfer,
    transferFromPayload,
    partyId,
    setPartyId,
    paymentCardId,
    setPaymentCardId,
    documentDate,
    setDocumentDate,
    dueDate,
    setDueDate,
    dueOverridden,
    setDueOverridden,
    referenceNumber,
    setReferenceNumber,
    memo,
    setMemo,
    postingDate,
    setPostingDate,
    departmentId,
    setDepartmentId,
    projectIdHeader,
    setProjectIdHeader,
    locationId,
    setLocationId,
    classId,
    setClassId,
    subsidiaryId,
    setSubsidiaryId,
    multiSub,
    isPosted,
    offersCurrency,
    currency,
    setCurrency,
    setCurrencyChosen,
    expectedPayDate,
    setExpectedPayDate,
    carriesWorkDates,
    workCompletedOn,
    setWorkCompletedOn,
    explicitFx,
    setExplicitFx,
    paymentHoldReason,
    setPaymentHoldReason,
    internalNotes,
    setInternalNotes,
    billingMethod,
    setBillingMethod,
    isFinalInvoice,
    setIsFinalInvoice,
    customValues,
    setCustomValues,
    initialCustomValues,
    extraDims,
    setExtraDims,
    setTotals,
    taxByProfile,
    marketplaceColumn,
    returnSourceColumn,
    returnSources,
    persistedPropRevision,
    persistedBaseline,
    seenPersistedRevisions,
    setDocumentRevision,
    setMode,
    rehydrationEpoch,
    setRehydrationEpoch,
  } = scope;
  const generatedAuthority = Boolean(
    doc.custom?.withholdingDeposit || doc.custom?.withholdingRemittance,
  );
  // Contractor-withholding line classification renders only behind a native
  // registration: an active withholding enrollment covering the bill's scope,
  // resolved by the loader. A company with no registration never sees the
  // treatment and direct-materials columns or their scheme guidance.
  const showWithholdingLines = generatedAuthority || (withholdingSchemes?.length ?? 0) > 0;
  const payload_ = useMemo(() => {
    if (isTransfer) {
      return {
        paymentCardId: null,
        partyId: null,
        documentDate: documentDate || undefined,
        dueDate: null,
        referenceNumber: null,
        memo,
        // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
        subsidiaryId: multiSub ? subsidiaryId || null : undefined,
        extraDims,
        custom: customValues,
        // Kernel contract: the amount rides ONLY the destination line; the
        // source line names its account and carries zero — the same shape
        // every native importer emits. Two full-amount legs post 2x.
        lines:
          transfer && transfer.toAccount && transfer.fromAccount && positiveAmount(transfer.amount)
            ? [
                { accountId: transfer.toAccount, amount: transfer.amount, description: null },
                { accountId: transfer.fromAccount, amount: "0", description: null },
              ]
            : [],
      };
    }
    return {
      partyId: partyId || null,
      paymentCardId: config.fundingSource === "card" ? paymentCardId || null : null,
      documentDate: documentDate || undefined,
      // An unsaved document with no chosen due date lets the server derive
      // it from the party's terms; an explicit clear stays null.
      dueDate:
        config.hasDueDate || generatedAuthority
          ? dueDate || (isCreate && !dueOverridden ? undefined : null)
          : null,
      referenceNumber: config.hasReference ? referenceNumber : null,
      memo,
      // Full-schema header built-ins (persisted only when the form exposes them,
      // but harmless to always send — the API updates the columns directly).
      postingDate: postingDate || null,
      departmentId: departmentId || null,
      projectId: projectIdHeader || null,
      locationId: locationId || null,
      classId: classId || null,
      extraDims,
      // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
      subsidiaryId: multiSub ? subsidiaryId || null : undefined,
      expectedPayDate: expectedPayDate || null,
      // The currency rides only where the drawer offers it: a new document
      // always names it, a saved draft only when the choice changed, so an
      // untouched save never re-asserts the stored currency.
      ...(offersCurrency && !isPosted && (isCreate || currency !== doc.currency)
        ? { currency }
        : {}),
      ...(carriesWorkDates ? { workCompletedOn: workCompletedOn || null } : {}),
      // Only an unsaved rate change rides; absent keeps the stored rate.
      ...(explicitFx !== undefined ? { explicitFx } : {}),
      paymentHoldReason: paymentHoldReason || null,
      internalNotes: internalNotes || null,
      billingMethod: billingMethod || null,
      isFinalInvoice,
      custom: customValues,
      ...(config.kind === "project_charge"
        ? {}
        : {
            // Every contentful row rides — including one missing its
            // account — so the server names the line and refuses instead
            // of the drawer silently booking a smaller total (OM-09).
            // Only blank placeholders are dropped.
            lines: rows
              .filter((r) => !isBlankDrawerLine(r))
              .map((r) => ({
                // Server provenance match needs the identity; native custom
                // is never sent (the server re-attaches its locked rows).
                lineId: r.lineId || null,
                accountId: r.accountId,
                itemId: r.itemId || null,
                description: r.description,
                quantity: r.quantity !== "" ? r.quantity : null,
                unit: r.unit || null,
                unitPrice: r.unitPrice !== "" ? r.unitPrice : null,
                // Inclusive-tax rows are displayed from their persisted net
                // amount, but the edit API accepts the original gross input.
                // Keep an untouched row round-tripping without changing its
                // tax treatment; an edited amount is detected by the helper.
                amount: config.hasTax
                  ? drawerTaxInputAmount(r, taxByProfile.get(r.taxProfileId) ?? [])
                  : r.amount,
                taxCodeId:
                  config.hasTax && r.taxProfileId.startsWith("code:")
                    ? r.taxProfileId.slice(5)
                    : null,
                taxGroupId:
                  config.hasTax && r.taxProfileId.startsWith("group:")
                    ? r.taxProfileId.slice(6)
                    : null,
                withholdingTreatment:
                  config.kind === "vendor_bill" || generatedAuthority
                    ? r.withholdingTreatment || null
                    : null,
                withholdingMaterialsCost:
                  config.kind === "vendor_bill" || generatedAuthority
                    ? r.withholdingMaterialsCost || null
                    : null,
                taxOverridden: config.hasTax ? r.taxOverridden : false,
                taxAmount: config.hasTax && r.taxOverridden ? r.taxAmount : null,
                // Marketplace collection rides only on sales kinds that offer
                // the column; other kinds never send it, so the server gate
                // for them stays a pure backstop.
                ...(marketplaceColumn
                  ? { marketplaceFacilitator: r.marketplaceFacilitator || null }
                  : {}),
                departmentId: r.departmentId || null,
                projectId: r.projectId || null,
                locationId: r.locationId || null,
                classId: r.classId || null,
                ...(carriesWorkDates
                  ? { workFrom: r.workFrom || null, workTo: r.workTo || null }
                  : {}),
                stockLocationId: r.stockLocationId || null,
                // A deferred bill line keeps its template and service window
                // whether or not the columns show: lines are replaced on save.
                ...(config.kind === "vendor_bill"
                  ? {
                      amortizationTemplateId: r.amortizationTemplateId || null,
                      amortizationStartOn: r.amortizationTemplateId
                        ? r.amortizationStartOn || null
                        : null,
                      amortizationEndOn: r.amortizationTemplateId
                        ? r.amortizationEndOn || null
                        : null,
                    }
                  : {}),
                // Tri-state, and only on kinds that can return stock: absent
                // preserves the stored selection, null clears it, an object
                // replaces it (see returnCellPayload for the cell's wire
                // meaning, including the allowance sentinel).
                ...(returnSourceColumn
                  ? returnCellPayload(r.returnSourceMovementId, returnSources)
                  : {}),
                // Entry-mode distribution staging for A4's save path: a
                // blank key is skipped server-side; the lock rides as the
                // tri-state's explicit edge (absent would mean "stored").
                distributionKey: r.distributionKey || null,
                distributionLocked: r.distributionLocked,
                extraDims: segmentAssignmentsFromCells(
                  r,
                  segments.map((segment) => segment.key),
                ),
                custom: Object.fromEntries(
                  lineDefs
                    .map((d) => [d.key, r[`cf_${d.key}`]])
                    .filter(([, v]) => v !== "" && v != null),
                ),
              })),
          }),
    };
  }, [
    generatedAuthority,
    isTransfer,
    transfer,
    partyId,
    paymentCardId,
    documentDate,
    dueDate,
    dueOverridden,
    isCreate,
    referenceNumber,
    memo,
    postingDate,
    departmentId,
    projectIdHeader,
    locationId,
    classId,
    subsidiaryId,
    multiSub,
    offersCurrency,
    isPosted,
    currency,
    doc.currency,
    expectedPayDate,
    carriesWorkDates,
    workCompletedOn,
    explicitFx,
    paymentHoldReason,
    internalNotes,
    billingMethod,
    isFinalInvoice,
    customValues,
    extraDims,
    rows,
    lineDefs,
    segments,
    config,
    taxByProfile,
    returnSourceColumn,
    returnSources,
    marketplaceColumn,
  ]);

  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    // Unsaved create has no persisted snapshot to reconcile against — the
    // blank seed never changes under the editor, and Save navigates away.
    if (isCreate) return;
    const incoming = {
      documentId: String(doc.id),
      revision: persistedPropRevision,
      payload,
    };
    const previousDocumentId = persistedBaseline.current.documentId;
    const previouslySeen = new Set(seenPersistedRevisions.current);
    const decision = reconcilePersistedDocumentSnapshot(
      persistedBaseline.current,
      incoming,
      dirty,
      previouslySeen,
    );
    if (previousDocumentId !== incoming.documentId) {
      seenPersistedRevisions.current = new Set([persistedPropRevision]);
    } else if (decision.rehydrate) {
      seenPersistedRevisions.current.add(persistedPropRevision);
    }
    if (decision.rehydrate) {
      persistedBaseline.current = decision.snapshot;
      resetForm(decision.snapshot.payload);
      setDocumentRevision(decision.snapshot.revision);
      // An accepted server revision replaces the entire clean edit snapshot; rejected or dirty revisions never reach this branch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDirty(false);
      setMode("view");
    }
    // The payload is inseparable from its revision. A changed payload with an
    // unchanged revision is an invalid server contract and is not adopted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, persistedPropRevision, dirty]);
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render). resetForm always
  // advances the rehydration epoch — even when the incoming values are
  // identical and payload_ therefore does not change — so the epoch change
  // itself bounds the suppression to that render and the next real user edit
  // can never be ignored.
  const [prevPayload, setPrevPayload] = useState(payload_);
  const [prevRehydrationEpoch, setPrevRehydrationEpoch] = useState(rehydrationEpoch);
  if (prevPayload !== payload_ || prevRehydrationEpoch !== rehydrationEpoch) {
    const rehydrating = prevRehydrationEpoch !== rehydrationEpoch;
    // Mount-time panel settling rebuilds the save payload with identical
    // content (a fetch resolving into state mints fresh object identities):
    // identity alone would read as user edits and prompt on close with
    // nothing to discard. Only a content change marks the editor dirty.
    const contentChanged =
      !rehydrating && savePayloadFingerprint(prevPayload) !== savePayloadFingerprint(payload_);
    setPrevPayload(payload_);
    setPrevRehydrationEpoch(rehydrationEpoch);
    if (!rehydrating && editable && contentChanged) setDirty(true);
  }

  function resetForm(source: DocPayload) {
    setRehydrationEpoch((epoch) => epoch + 1);
    const sourceDoc = asDocumentDoc(source.doc);
    setPartyId(sourceDoc.party_id ?? "");
    setPaymentCardId(sourceDoc.payment_card_id ?? "");
    setDocumentDate(sourceDoc.document_date ?? "");
    setDueDate(sourceDoc.due_date ?? "");
    setDueOverridden(Boolean(sourceDoc.due_date));
    setReferenceNumber(sourceDoc.reference_number ?? "");
    setMemo(sourceDoc.memo ?? "");
    setPostingDate(sourceDoc.posting_date ?? "");
    setDepartmentId(sourceDoc.department_id ?? "");
    setProjectIdHeader(sourceDoc.project_id ?? "");
    setLocationId(sourceDoc.location_id ?? "");
    setClassId(sourceDoc.class_id ?? "");
    setSubsidiaryId(sourceDoc.subsidiary_id ?? "");
    setCurrency(String(sourceDoc.currency ?? ""));
    setCurrencyChosen(false);
    setExpectedPayDate(sourceDoc.expected_pay_date ?? "");
    setWorkCompletedOn(sourceDoc.work_completed_on ?? "");
    setExplicitFx(undefined);
    setPaymentHoldReason(sourceDoc.payment_hold_reason ?? "");
    setInternalNotes(sourceDoc.internal_notes ?? "");
    setBillingMethod(sourceDoc.billing_method ?? "");
    setIsFinalInvoice(sourceDoc.is_final_invoice === true);
    setCustomValues(
      initialCustomValues(sourceDoc.custom, (source as { tenders?: unknown }).tenders),
    );
    setExtraDims(sourceDoc.extra_dims ?? {});
    setTransfer(transferFromPayload(source));
    setRows(
      source.lines.length > 0
        ? source.lines.map((l) => toRow(l, lineDefs, segments))
        : [emptyLine()],
    );
    setTotals({
      subtotal: sourceDoc.subtotal,
      taxTotal: sourceDoc.tax_total,
      total: sourceDoc.total,
    });
  }

  const accountName = (id: unknown): string => {
    if (!id) return "—";
    const a =
      [...(cardAccounts ?? []), ...(bankAccounts ?? accounts)].find((x) => x.id === id) ??
      accounts.find((x) => x.id === id);
    return a ? `${a.number ?? ""} ${a.name ?? ""}`.trim() : String(id);
  };
  // Settlement-currency restrictions keyed by account, across every picker
  // list the form can reference.
  const currencyRestrictionById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const a of [...(cardAccounts ?? []), ...(bankAccounts ?? accounts), ...accounts]) {
      if (!map.has(a.id)) map.set(a.id, a.currency_restriction ?? null);
    }
    return map;
  }, [accounts, bankAccounts, cardAccounts]);
  // Collect the accounts this save would actually insert (zero legs never
  // reach the ledger — the kernel drops them before the trigger runs) and
  // prove each one against the document currency.
  const currencyMismatch = (): CurrencyMismatchedAccount | null => {
    const lines = (payload_ as { lines?: { accountId?: unknown; amount?: unknown }[] }).lines ?? [];
    const refs = lines
      .filter((l) => typeof l.amount === "string" && l.amount !== "" && Number(l.amount) !== 0)
      .map((l) => ({ accountId: l.accountId, label: accountName(l.accountId) }));
    const override = customValues.controlAccountId;
    if (typeof override === "string" && override) {
      refs.push({ accountId: override, label: accountName(override) });
    }
    return findCurrencyMismatchedAccount(currency, refs, currencyRestrictionById);
  };
  const blockCurrencyMismatch = (): boolean => {
    const mismatch = currencyMismatch();
    if (!mismatch) return false;
    const message = t("drawer.currencyMismatch", {
      account: mismatch.label,
      allowed: mismatch.allowed,
      actual: currency,
    });
    // A refusal the operator can trigger stays on the record, not only in
    // a toast: the typed reason pins as an alert until the next action.
    refuse(message, t("toasts.actionFailed"));
    return true;
  };

  return {
    generatedAuthority,
    showWithholdingLines,
    payload_,
    dirty,
    setDirty,
    resetForm,
    accountName,
    blockCurrencyMismatch,
  };
}

export type DocumentDrawerPayloadScope = DocumentDrawerEntryScope &
  ReturnType<typeof useDocumentDrawerPayload>;
