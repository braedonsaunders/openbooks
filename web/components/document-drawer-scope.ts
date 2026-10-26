import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useIdentityState } from "@/lib/use-identity-state";
import { useMoney } from "@/components/money-provider";
import { initialDrawerMode, type DrawerMode } from "@/lib/drawer-mode";
import { useAppAction } from "@/lib/use-app-action";
import { documentDrawerHref } from "../lib/document-drawer-navigation";
import {
  mergeCloseoutPartsIntoTenders,
  parseCloseoutDraft,
  parseTenderDrafts,
} from "./cash-tenders-section";
import { cmp } from "@openbooks/engine/money/money";
import {
  EMPTY_BUILTIN_SEGMENTS,
  EMPTY_FACILITATORS,
  EMPTY_SEGMENTS,
  asDocumentDoc,
  lineText,
  type DocPayload,
  type LineRow,
} from "./document-drawer-types";
import { applyQtyPriceToRows, emptyLine, toRow } from "./document-drawer-lines";
import type { ExplicitFxDraft } from "./document-drawer-fx-rate";
import { persistedDocumentRevision, type PersistedDocumentSnapshot } from "./document-drawer-save";
import type { DocumentDrawerProps } from "./document-drawer-props";

/**
 * The drawer's record identity, header editor state, line rows, revision
 * fence and shared action path. Every later drawer hook reads this scope.
 */
export function useDocumentDrawerScope(props: DocumentDrawerProps) {
  const {
    payload,
    config,
    basePath,
    relatedNavigation,
    segments = EMPTY_SEGMENTS,
    builtinSegments = EMPTY_BUILTIN_SEGMENTS,
    lineDefs,
    canCreate,
    canPost,
    createMode = false,
    initialMode = "view",
    tenderAccounts,
    depositAccounts,
    marketplaceFacilitators = EMPTY_FACILITATORS,
    currencyOptions,
    parties,
  } = props;
  const { money } = useMoney();
  const t = useTranslations(config.i18n);
  const tCommon = useTranslations("common");
  const tWithholdingLine = useTranslations("documents.withholdingLine");
  const tAmortization = useTranslations("amortization.billLine");
  const tSales = useTranslations("salesOrders");
  const tPostingEffects = useTranslations("common.postingEffects");
  const tReturns = useTranslations("returns");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const doc = asDocumentDoc(payload.doc);
  const hrefForDocument = (targetId: string, form?: string) =>
    documentDrawerHref({
      pathname,
      query: searchParams.toString(),
      basePath,
      currentId: String(doc.id),
      targetId,
      kind: config.kind,
      related: relatedNavigation,
      form,
    });
  const isDraft = doc.status === "draft";
  const isPosted = doc.status === "posted";
  const isTransfer = config.kind === "transfer";
  const isCashKind = config.kind === "cash_sale" || config.kind === "cash_refund";
  const tenderAccountOptions = (tenderAccounts ?? []).map((a) => ({
    value: a.id,
    label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
  }));
  // Till-drop destinations mirror the tender account labels.
  const depositAccountOptions = (depositAccounts ?? []).map((a) => ({
    value: a.id,
    label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
  }));

  const canEditStatus =
    (doc.status === "draft" && canCreate) || (doc.status === "posted" && canCreate && canPost);
  // Existing records default to read-only. A creation flow may request edit
  // mode, but status and permission checks remain authoritative. An unsaved
  // create always opens editing its blank payload (never a persisted state).
  const isCreate = createMode === true;
  const [mode, setMode] = useState<DrawerMode>(
    isCreate ? "edit" : initialDrawerMode(initialMode, canEditStatus),
  );
  // Stable per drawer session (remounted per `new:<kind>` upstream): a
  // retried first Save replays against this key instead of duplicating.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const editable = mode === "edit" && canEditStatus;
  // Posted open-item docs that carry a balance resolve to open/paid from the
  // applications ledger (invoices). Credits post open items too but their
  // "applied" flows the opposite direction, so they show their raw status.
  const displayStatus =
    isPosted && config.showsBalance
      ? cmp(String(doc.balance_due ?? "0"), "0") > 0
        ? "open"
        : "paid"
      : doc.status;

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? "");
  const [paymentCardId, setPaymentCardId] = useState<string>(doc.payment_card_id ?? "");
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? "");
  const [dueDate, setDueDate] = useState<string>(doc.due_date ?? "");
  // A saved due date is the operator's until the terms resolve to the same
  // date; a blank one follows the party's payment terms.
  const [dueOverridden, setDueOverridden] = useState<boolean>(Boolean(doc.due_date));
  const [lastDerivedDue, setLastDerivedDue] = useState<string | null>(null);
  // Display name shown beside the due date when neither the party nor the
  // company default names payment terms (null hides the hint).
  const [noTermsHint, setNoTermsHint] = useIdentityState<string | null>(
    [partyId, documentDate],
    null,
  );
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? "");
  const [memo, setMemo] = useState<string>(doc.memo ?? "");
  // Full-schema header built-ins (off by default; shown when a form enables them).
  const [postingDate, setPostingDate] = useState<string>(doc.posting_date ?? "");
  const [departmentId, setDepartmentId] = useState<string>(doc.department_id ?? "");
  const [projectIdHeader, setProjectIdHeader] = useState<string>(doc.project_id ?? "");
  const [locationId, setLocationId] = useState<string>(doc.location_id ?? "");
  const [classId, setClassId] = useState<string>(doc.class_id ?? "");
  const [subsidiaryId, setSubsidiaryId] = useState<string>(doc.subsidiary_id ?? "");
  // The document currency, offered only where the loader passed currency
  // options. A new document opened for a party starts in that party's role
  // currency; choosing a currency explicitly stops party changes from
  // replacing it.
  const offersCurrency = (currencyOptions?.length ?? 0) > 0;
  const partyRoleCurrency = (id: string | null | undefined): string | null => {
    const code = (parties ?? []).find((party) => party.id === id)?.currency;
    return code && (currencyOptions ?? []).some((option) => option.value === code) ? code : null;
  };
  const [currency, setCurrency] = useState<string>(
    () =>
      (offersCurrency && isCreate ? partyRoleCurrency(doc.party_id) : null) ??
      String(doc.currency ?? ""),
  );
  const [currencyChosen, setCurrencyChosen] = useState(false);
  const [expectedPayDate, setExpectedPayDate] = useState<string>(doc.expected_pay_date ?? "");
  // Customer billing kinds carry when the invoiced work was completed and
  // each line's work period; generated invoices arrive with them stamped.
  const carriesWorkDates = config.kind === "customer_invoice" || config.kind === "customer_credit";
  const [workCompletedOn, setWorkCompletedOn] = useState<string>(doc.work_completed_on ?? "");
  // Unsaved explicit exchange rate change: undefined keeps the stored rate.
  const [explicitFx, setExplicitFx] = useState<ExplicitFxDraft | null | undefined>(undefined);
  const [paymentHoldReason, setPaymentHoldReason] = useState<string>(doc.payment_hold_reason ?? "");
  const [internalNotes, setInternalNotes] = useState<string>(doc.internal_notes ?? "");
  const [billingMethod, setBillingMethod] = useState<string>(doc.billing_method ?? "");
  const [isFinalInvoice, setIsFinalInvoice] = useState<boolean>(doc.is_final_invoice === true);
  // Tenders arrive from the table (payload.tenders), never from custom:
  // the server consumes submitted custom.tenders into document_tenders and
  // never persists the key, so the editor seeds from the table rows first
  // (refund prefill and in-progress drafts still ride custom). The seed
  // helper is shared with resetForm below: after a save the returned
  // document carries no custom.tenders, so both entry points must reseed
  // from the payload table, or edited-then-saved tenders read back empty.
  const initialCustomValues = (
    docCustom: Record<string, unknown> | null,
    payloadTenders: unknown,
  ): Record<string, unknown> => {
    // The table owns tenders and custom owns the close-out: fold the stored
    // parts back into the drafts by position, so tips, fees and the balance
    // survive a reload instead of blanking and wiping on the next save. The
    // close-out reseeds as its draft shape only (over/short and server):
    // totals and parts derive from the tenders on save, so resending the
    // stored ones would refuse a legitimate tip removal against stale
    // arithmetic.
    const storedCloseout = (docCustom as Record<string, unknown> | null)?.closeout;
    return {
      ...(docCustom ?? {}),
      tenders: mergeCloseoutPartsIntoTenders(
        payloadTenders ?? (docCustom as Record<string, unknown> | null)?.tenders ?? [],
        storedCloseout,
      ),
      ...(storedCloseout !== undefined && storedCloseout !== null
        ? { closeout: parseCloseoutDraft(storedCloseout) }
        : {}),
    };
  };
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(() =>
    initialCustomValues(doc.custom, (payload as { tenders?: unknown }).tenders),
  );
  // The drop source offers only this sale's cash tender accounts
  // (distinct); a single till account needs no choice — the endpoint
  // defaults to it.
  const cashSourceOptions = (() => {
    const seen = new Map<string, string>();
    for (const draft of parseTenderDrafts(customValues.tenders)) {
      if (draft.kind !== "cash" || !draft.accountId || seen.has(draft.accountId)) continue;
      seen.set(
        draft.accountId,
        tenderAccountOptions.find((o) => o.value === draft.accountId)?.label ?? draft.accountId,
      );
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  })();

  // The till window this unposted sale closes, when a drop has closed it
  // and this is its last sale: the close-out offers the window's
  // dropped-minus-tendered difference as over/short for the operator.
  const tillWindowSaleId =
    config.kind === "cash_sale" && !isCreate && !isPosted && doc.status !== "voided"
      ? String(doc.id)
      : null;
  const [tillSuggestion, setTillSuggestion] = useIdentityState<{
    difference: string;
    after: string | null;
    through: string;
    tillAccountId: string;
  } | null>([tillWindowSaleId], null);

  useEffect(() => {
    if (!tillWindowSaleId) return;
    let live = true;
    fetch(`/api/cash-sales/${tillWindowSaleId}/till-window`, {
      headers: { accept: "application/json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live) return;
        const till = (
          body as {
            till?: {
              lastSale?: boolean;
              window?: {
                difference: string;
                after: string | null;
                through: string;
                tillAccountId: string;
              };
            } | null;
          } | null
        )?.till;
        setTillSuggestion(till?.lastSale && till.window ? till.window : null);
      })
      .catch(() => {
        if (live) setTillSuggestion(null);
      });
    return () => {
      live = false;
    };
  }, [tillWindowSaleId, setTillSuggestion]);

  const resolveStoredValueCode = useCallback(async (code: string) => {
    const response = await fetch(`/api/stored-value/lookup?code=${encodeURIComponent(code)}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      accountId?: string;
      balance?: string;
      currency?: string;
      status?: string;
      last4?: string;
    };
    if (typeof body.accountId !== "string" || typeof body.balance !== "string") return null;
    return {
      accountId: body.accountId,
      balance: body.balance,
      currency: typeof body.currency === "string" ? body.currency : "",
      status: typeof body.status === "string" ? body.status : "",
      last4: typeof body.last4 === "string" ? body.last4 : "",
    };
  }, []);
  const [extraDims, setExtraDims] = useState<Record<string, string | null>>(doc.extra_dims ?? {});

  // -- transfer: dedicated to/from + amount state ---------------------------
  const transferFromPayload = (
    source: DocPayload,
  ): { toAccount: string; fromAccount: string; amount: string } | null =>
    isTransfer
      ? {
          toAccount: lineText(source.lines[0]?.account_id),
          fromAccount: lineText(source.lines[1]?.account_id),
          amount: source.lines[0]?.amount != null ? String(source.lines[0].amount) : "",
        }
      : null;
  const initialTransfer = transferFromPayload(payload);
  const [transfer, setTransfer] = useState(initialTransfer);

  const [rows, setRows] = useState<LineRow[]>(
    payload.lines.length > 0
      ? payload.lines.map((l) => toRow(l, lineDefs, segments))
      : [emptyLine()],
  );
  // Grid edits flow through here so a quantity/unit-price change
  // re-derives the line amount (blank/manual-divergent amounts are kept).
  const handleGridRowsChange = useCallback((next: LineRow[]) => {
    setRows((prev) => applyQtyPriceToRows(prev, next));
  }, []);
  const [totals, setTotals] = useState({
    subtotal: doc.subtotal,
    taxTotal: doc.tax_total,
    total: doc.total,
  });
  // No persisted row exists in create mode, so there is no revision token to
  // pin: the revision-coupled effects below are disarmed there instead.
  const persistedPropRevision = isCreate ? "" : persistedDocumentRevision(doc.updated_at);
  const [documentRevision, setDocumentRevision] = useState(persistedPropRevision);
  const seenPersistedRevisions = useRef(new Set([persistedPropRevision]));
  const persistedBaseline = useRef<PersistedDocumentSnapshot<DocPayload>>({
    documentId: String(doc.id),
    revision: persistedPropRevision,
    payload,
  });
  const [rehydrationEpoch, setRehydrationEpoch] = useState(0);
  // 'error' is a refusal of the entered values; 'unavailable' is a server or
  // connection failure, which leaves the values exactly as entered.
  const [saveState, setSaveState] = useState<
    "saved" | "saving" | "dirty" | "error" | "unavailable"
  >("saved");
  // A refused submit/post that only fires a transient toast reads as
  // "nothing happened" once it dismisses: the
  // typed refusal also persists as a record-level alert, cleared on the
  // next action. Saves, lifecycle actions, deletes, voids and form
  // preference writes all run on the shared action path, whose busy flag
  // always releases through its own finally.
  const { busy, refusal, execute, refuse, runExclusive } = useAppAction();
  // Warnings a successful post reports (a deposit line on a receivable or
  // payable account with no party, accepted under the "warn" policy). They
  // pin beside the record until the next lifecycle action.
  const [postWarnings, setPostWarnings] = useState<string[]>([]);
  // Matching a hand-coded bill to its purchase order: the dialog links
  // stocked lines the drawer created without provenance. The banner shows
  // while unmatched lines still have open order lines to match (an early
  // warning, before posting refuses) or right after posting refused for
  // exactly that — both offer the same dialog.
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchHint, setMatchHint] = useState(false);
  const [matchRefused, setMatchRefused] = useState(false);
  // An unsaved create has no bill to match: probing with its blank id hits
  // a 404 against the match route, so matching stays with persisted bills
  // whose edit grant the role holds.
  const canMatchBill =
    config.kind === "vendor_bill" &&
    !isCreate &&
    (doc.status === "draft" || doc.status === "approved") &&
    canCreate;
  useEffect(() => {
    if (!canMatchBill || matchOpen) return;
    let cancelled = false;
    async function probe() {
      try {
        const res = await fetch(`/api/documents/${doc.id}/bill-match`);
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          lines?: { matched?: unknown; candidates?: unknown[] }[];
        } | null;
        if (cancelled || !data || !Array.isArray(data.lines)) return;
        setMatchHint(
          data.lines.some(
            (line) => !line.matched && Array.isArray(line.candidates) && line.candidates.length > 0,
          ),
        );
      } catch {
        // The probe is advisory: a failed read hides the banner, never the bill.
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, [canMatchBill, doc.id, documentRevision, matchOpen]);

  return {
    ...props,
    segments,
    builtinSegments,
    createMode,
    initialMode,
    marketplaceFacilitators,
    money,
    t,
    tCommon,
    tWithholdingLine,
    tAmortization,
    tSales,
    tPostingEffects,
    tReturns,
    router,
    pathname,
    searchParams,
    doc,
    hrefForDocument,
    isDraft,
    isPosted,
    isTransfer,
    isCashKind,
    tenderAccountOptions,
    depositAccountOptions,
    canEditStatus,
    isCreate,
    mode,
    setMode,
    idempotencyKey,
    editable,
    displayStatus,
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
    lastDerivedDue,
    setLastDerivedDue,
    noTermsHint,
    setNoTermsHint,
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
    offersCurrency,
    partyRoleCurrency,
    currency,
    setCurrency,
    currencyChosen,
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
    initialCustomValues,
    customValues,
    setCustomValues,
    cashSourceOptions,
    tillSuggestion,
    resolveStoredValueCode,
    extraDims,
    setExtraDims,
    transferFromPayload,
    transfer,
    setTransfer,
    rows,
    setRows,
    handleGridRowsChange,
    totals,
    setTotals,
    persistedPropRevision,
    documentRevision,
    setDocumentRevision,
    seenPersistedRevisions,
    persistedBaseline,
    rehydrationEpoch,
    setRehydrationEpoch,
    saveState,
    setSaveState,
    busy,
    refusal,
    execute,
    refuse,
    runExclusive,
    postWarnings,
    setPostWarnings,
    matchOpen,
    setMatchOpen,
    matchHint,
    matchRefused,
    setMatchRefused,
    canMatchBill,
  };
}

export type DocumentDrawerScope = ReturnType<typeof useDocumentDrawerScope>;
