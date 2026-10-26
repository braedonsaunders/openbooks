"use client";

import { useIdentityState } from "@/lib/use-identity-state";

import {
  Table as SharedTable,
  TableHeader as SharedTableHeader,
  TableRow as SharedTableRow,
  TableHead as SharedTableHead,
  TableBody as SharedTableBody,
  TableCell as SharedTableCell,
} from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import { useMoney } from "@/components/money-provider";
import { MoneyInput } from "@/components/money-input";
import { initialDrawerMode, type DrawerMode } from "@/lib/drawer-mode";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";
import {
  Badge,
  Button,
  Drawer,
  FieldLabel,
  Input,
  Label,
  SearchSelect,
  Select,
  Textarea,
} from "@openbooks/ui";
import {
  storedExplicitFx,
  type ExplicitFxDraft,
} from "../../../components/document-drawer-fx-rate";
import { TransactionDrawer } from "../../../components/transaction-drawer";
import { DocTypeBadge, docTypeMeta } from "../../../components/doc-type-badge";
import { JournalEntryLink } from "../../../components/journal-entry-link";
import { PdfButton } from "../../../components/pdf-button";
import { SendButton } from "../../../components/send-button";
import { confirmDialog } from "../../../lib/confirm";
import { readApiErrorMessage } from "../../../lib/api-error";
import { currencyMinorUnits } from "../../../lib/iso-currencies";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { useAppAction } from "@/lib/use-app-action";
import { displayDocumentNumber } from "../../../lib/document-display";
import { HeaderFields } from "../../../components/transaction-form/header-fields";
import { FlowManualButtons } from "../../../components/flow-manual-buttons";
import { ApprovalActions } from "../../../components/approval-actions";
import { ApprovalHistory } from "../../../components/approval-history";
import { promptDialog } from "../../../lib/prompt";
import {
  StoredValueTendersSection,
  type CustomerCreditOption,
  type TenderDraft,
} from "./StoredValueTendersSection";
import { CreditApplicationsPanel } from "../../../components/credit-applications-panel";
import type { FormLayoutConfig, HeaderFieldPlacement } from "@openbooks/customization";
import {
  cmp,
  divRate,
  formatMoney,
  mulRate,
  normalizeMoney,
  sum,
} from "@openbooks/engine/money/money";
import { DateField } from "@/components/date-field";

/**
 * Shared payment/receipt flyout. side='ap' → vendor payment applying open
 * bills; side='ar' → customer receipt applying open invoices. Drafts
 * autosave; "Pay & post" / "Receive & post" is the explicit kernel action.
 */
type Opt = {
  id: string;
  display_name?: string;
  number?: string | null;
  name?: string;
  provider?: string | null;
};

export interface OpenItemClient {
  lineId: string;
  entryNumber: string;
  postingDate: string;
  dueDate: string | null;
  documentNumber: string | null;
  documentKind: string | null;
  referenceNumber: string | null;
  amount: string;
  applied: string;
  open: string;
  currency: string;
  transactionAmount: string;
  transactionApplied: string;
  transactionOpen: string;
  /** A live payment run that will pay this item; it is not payable here. */
  reservedByRun?: { runId: string; runNumber: string; runStatus: string } | null;
  /** The receivable/payable account the item sits on. One payment settles
   *  one account, so items on another account wait for their own payment. */
  accountId?: string;
  accountNumber?: string | null;
  accountName?: string;
}

interface AllocationClient {
  openLineId: string;
  sourceTransactionAmount: string;
  targetTransactionAmount: string;
  targetBaseAmount?: string;
  settlementRate: string;
  settlementRateSource: "same_currency" | "provider" | "manual" | "contractual" | "imported";
  settlementRateReference: string;
  settlementFxRateId?: string | null;
}

interface SettlementRateOption {
  id: string;
  toCurrency: string;
  rate: string;
  asOf: string;
  source: string;
}

/** One live application on the payment, with the target line/document join —
 *  column types per the `applications` table (all NOT NULL) plus the joins
 *  (target document columns are null when the target has no document). */
export interface PaymentAppliedRow {
  id: string;
  amount: string;
  source_amount: string;
  source_transaction_amount: string;
  source_transaction_currency: string;
  target_transaction_amount: string;
  target_transaction_currency: string;
  settlement_rate: string;
  settlement_rate_source: string;
  settlement_rate_reference: string;
  applied_on: string;
  target_entry_number: string;
  target_posting_date: string;
  target_due_date: string | null;
  target_amount: string;
  target_transaction_original: string;
  target_document_id: string | null;
  target_document_number: string | null;
  target_document_kind: string | null;
  target_reference_number: string | null;
}

export interface PaymentPayload {
  doc: Record<string, unknown>;
  bankAccountId: string | null;
  allocations: AllocationClient[];
  /** An enabled on_submit flow governs this kind: posting routes through
   *  approval instead of posting directly. Resolved by the loader so the
   *  drawer labels the primary action honestly. */
  governedByFlow?: boolean;
  /** Server-resolved payment duty and Banking feature for effect recovery. */
  canRetryPostingEffects?: boolean;
  /** Server-resolved payment duty: the viewer may apply this payment's unapplied cash to other open documents. */
  canApplyUnapplied?: boolean;
  /** Live applications as the loader hands them; narrowed to
   *  PaymentAppliedRow for rendering below. */
  applied: Record<string, unknown>[];
  withholdingEnabled?: boolean;
  withholdingAuthorisationRequired?: boolean;
  withholdingAuthorisationCurrency?: string | null;
}

/** The payment header: `documents` plus the loader's joins. Dates, uuids
 *  and numerics arrive from the driver as strings; left-join columns stay
 *  nullable. Column nullability per schema (documents / parties /
 *  journal_entries / accounts). */
export interface PaymentDoc extends Record<string, unknown> {
  id: string;
  kind: string;
  status: string;
  currency: string;
  total: string;
  document_number: string | null;
  party_id: string | null;
  party_name: string | null;
  document_date: string | null;
  reference_number: string | null;
  memo: string | null;
  updated_at: string;
  entry_id: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  posting_effect_status: string | null;
  posting_effect_updated_at: string | null;
}

function docText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The revision token a save response reports for the row it wrote, or null
 *  when the response carries none. */
function committedRevisionOf(data: unknown): string | null {
  const token = docText((data as { doc?: { updated_at?: unknown } } | null)?.doc?.updated_at);
  return token === null || token === "" ? null : token;
}

/** Narrow the engine loader's untyped document row to the header fields
 *  this drawer reads. Non-string values fall back to null (or '' for the
 *  NOT NULL columns); loader rows always carry strings here, so valid
 *  payloads pass through unchanged. */
export function asPaymentDoc(raw: Record<string, unknown>): PaymentDoc {
  return {
    ...raw,
    id: docText(raw.id) ?? "",
    kind: docText(raw.kind) ?? "",
    status: docText(raw.status) ?? "",
    currency: docText(raw.currency) ?? "",
    total: docText(raw.total) ?? "0",
    document_number: docText(raw.document_number),
    party_id: docText(raw.party_id),
    party_name: docText(raw.party_name),
    document_date: docText(raw.document_date),
    reference_number: docText(raw.reference_number),
    memo: docText(raw.memo),
    updated_at: docText(raw.updated_at) ?? "",
    entry_id: docText(raw.entry_id),
    bank_account_number: docText(raw.bank_account_number),
    bank_account_name: docText(raw.bank_account_name),
    posting_effect_status: docText(raw.posting_effect_status),
    posting_effect_updated_at: docText(raw.posting_effect_updated_at),
  };
}

/** Narrow one live-application row from the loader. All `applications`
 *  columns are NOT NULL (amounts/dates arrive as strings); the
 *  target-document columns are null when the target line has no document. */
export function asPaymentAppliedRow(raw: Record<string, unknown>): PaymentAppliedRow {
  const req = (value: unknown): string => docText(value) ?? "";
  return {
    ...raw,
    id: req(raw.id),
    amount: req(raw.amount),
    source_amount: req(raw.source_amount),
    source_transaction_amount: req(raw.source_transaction_amount),
    source_transaction_currency: req(raw.source_transaction_currency),
    target_transaction_amount: req(raw.target_transaction_amount),
    target_transaction_currency: req(raw.target_transaction_currency),
    settlement_rate: req(raw.settlement_rate),
    settlement_rate_source: req(raw.settlement_rate_source),
    settlement_rate_reference: req(raw.settlement_rate_reference),
    applied_on: req(raw.applied_on),
    target_entry_number: req(raw.target_entry_number),
    target_posting_date: req(raw.target_posting_date),
    target_due_date: docText(raw.target_due_date),
    target_amount: req(raw.target_amount),
    target_transaction_original: req(raw.target_transaction_original),
    target_document_id: docText(raw.target_document_id),
    target_document_number: docText(raw.target_document_number),
    target_document_kind: docText(raw.target_document_kind),
    target_reference_number: docText(raw.target_reference_number),
  };
}

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline"> = {
  posted: "success",
  approved: "success",
  pending_approval: "warning",
  draft: "secondary",
  voided: "outline",
};

// document kind enum → payments.drawer.kind.* message keys (fallback: 'entry').
const KIND_KEY: Record<string, string> = {
  vendor_bill: "vendorBill",
  customer_invoice: "customerInvoice",
  expense_report: "expenseReport",
  journal: "journal",
};

// documents.status enum → common.status.* message keys (fallback: raw value).
const STATUS_LABEL_KEY: Record<string, string> = {
  draft: "draft",
  pending_approval: "pendingApproval",
  approved: "approved",
  rejected: "rejected",
  posted: "posted",
  paid: "paid",
  partially_paid: "partiallyPaid",
  voided: "voided",
  reversed: "reversed",
  cancelled: "cancelled",
};

/** A new prefilled subject owns fresh draft state and a fresh idempotency key. */
export function PaymentDrawer(props: Parameters<typeof PaymentDrawerBody>[0]) {
  const doc = asPaymentDoc(props.payment.doc);
  const identity = props.createMode
    ? JSON.stringify([
        props.side,
        props.basePath,
        doc.party_id,
        doc.subsidiary_id,
        doc.currency,
        props.payment.allocations.map((allocation) => allocation.openLineId).sort(),
      ])
    : String(doc.id);
  return <PaymentDrawerBody key={identity} {...props} />;
}

function PaymentDrawerBody({
  payment,
  initialMode = "view",
  initialOpenItems,
  parties,
  bankAccounts,
  side,
  basePath,
  layout,
  createMode = false,
  closeHref,
  createTitle,
  storedValue,
}: {
  payment: PaymentPayload;
  initialMode?: DrawerMode;
  initialOpenItems: OpenItemClient[];
  parties: Opt[];
  bankAccounts: Opt[];
  side: "ap" | "ar";
  basePath: string;
  layout?: FormLayoutConfig;
  /** Unsaved-create: no persisted row exists. Cancel/close navigate away
   *  with zero writes; Save is the first write (one idempotent POST). */
  createMode?: boolean;
  /** List return URL — Cancel/close land here, and a successful Save opens
   *  the created payment over it. */
  closeHref?: string;
  /** Surface label for the unsaved title (no number exists yet). The section
   *  already translates it per surface — no new keys. */
  createTitle?: string;
  /** Stored-value tenders (AR receipts only, feature on): already-saved
   *  snapshots plus the customer's verified credit for the picker. Null =
   *  gated, so the section never renders without the read surface behind
   *  it. Fresh codes verify on save; echoes re-verify the same way. */
  storedValue?: {
    tenders: { accountId: string; codeLast4: string; amount: string }[];
    customerCredits: CustomerCreditOption[];
  } | null;
}) {
  const { money } = useMoney();
  const locale = useLocale();
  const t = useTranslations("payments.drawer");
  const tCommon = useTranslations("common");
  const tStoredValue = useTranslations("storedValue");
  const tWithholding = useTranslations("ap.withholding");
  const tPostingEffects = useTranslations("common.postingEffects");
  const router = useRouter();
  const doc = asPaymentDoc(payment.doc);
  const currency = `${doc.currency}`;
  const documentRevision = `${doc.updated_at}`;
  const [postingEffectStatus, setPostingEffectStatus] = useIdentityState(
    [doc.id, doc.posting_effect_status, doc.posting_effect_updated_at],
    doc.posting_effect_status,
  );
  const [postingEffectsQueued, setPostingEffectsQueued] = useIdentityState(
    [doc.id, doc.posting_effect_status, doc.posting_effect_updated_at],
    false,
  );
  const tFunding = useTranslations("processorReceipts");
  const tFx = useTranslations("documents.explicitFx");
  const [fundingRetry, setFundingRetry] = useState(0);
  const [fundingSubsidiaryId, setFundingSubsidiaryId] = useState(
    typeof doc.subsidiary_id === "string" ? doc.subsidiary_id : "",
  );
  const fundingSubsidiaries = (
    Array.isArray(doc.funding_subsidiaries) ? doc.funding_subsidiaries : []
  ) as { id: string; name: string; currency: string }[];
  const fundingLabel = side === "ar" ? tFunding("receiptAccount") : t("bankAccount");
  const fundingPlaceholder =
    side === "ar" ? tFunding("selectReceiptAccount") : t("selectBankAccountPlaceholder");
  const fundingOptionLabel = (account: Opt) =>
    `${account.number ?? ""} ${account.name ?? ""}${account.provider ? ` · ${account.provider}` : ""}`.trim();
  const applied = payment.applied.map(asPaymentAppliedRow);
  const isDraft = doc.status === "draft";
  // Existing records default to read-only; newly created drafts can explicitly
  // request edit mode. Only DRAFT payments
  // are editable (posting is terminal — applications become ledger state). Save
  // is EXPLICIT — one Save button, no per-field autosave.
  const canEditStatus = isDraft;
  const [mode, setMode] = useState<DrawerMode>(
    createMode ? "edit" : initialDrawerMode(initialMode, canEditStatus),
  );
  const editable = mode === "edit" && canEditStatus;
  const returnHref = closeHref ?? basePath;
  const requestIdRef = useRef<string | null>(null);
  const partyLabel = side === "ap" ? tCommon("labels.vendor") : tCommon("labels.customer");
  const kindLabel = (kind: string | null) => {
    const key = KIND_KEY[kind ?? ""];
    return key ? t(`kind.${key}`) : t("kind.entry");
  };
  const statusLabel = (status: string) => {
    const key = STATUS_LABEL_KEY[status];
    return key ? tCommon(`status.${key}`) : status.replace("_", " ");
  };

  const [partyId, setPartyId] = useState<string>(doc.party_id ?? "");
  const [bankAccountId, setBankAccountId] = useState<string>(payment.bankAccountId ?? "");
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? "");
  const [fundingAccounts, setFundingAccounts] = useIdentityState<Opt[]>(
    [
      editable,
      fundingSubsidiaryId,
      currency,
      documentDate,
      side,
      fundingRetry,
      locale,
      bankAccounts,
    ],
    editable ? [] : bankAccounts,
  );
  const [fundingError, setFundingError] = useIdentityState<string | null>(
    [
      editable,
      fundingSubsidiaryId,
      currency,
      documentDate,
      side,
      fundingRetry,
      locale,
      bankAccounts,
    ],
    null,
  );
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? "");
  const [memo, setMemo] = useState<string>(doc.memo ?? "");
  const custom =
    doc.custom && typeof doc.custom === "object" ? (doc.custom as Record<string, unknown>) : {};
  // What the customer paid (AR receipts). Auto-apply spreads it across open
  // items, and whatever the applications leave stays on the receipt as an
  // on-account credit: the amount typed is never silently dropped. A saved
  // receipt with an on-account residual reopens showing its full cash total.
  const savedOnAccount = typeof custom.onAccountAmount === "string" ? custom.onAccountAmount : "0";
  const [receivedAmount, setReceivedAmount] = useState<string>(
    side === "ar" && cmp(savedOnAccount, "0") > 0 && doc.total != null ? String(doc.total) : "",
  );
  const savedWithholdings = Array.isArray(custom.withholdings)
    ? (custom.withholdings as Array<{
        openLineId: string;
        billDocumentNumber: string;
        schemeCode: string;
        bandCode: string;
        ratePercent: string;
        base: string;
        deducted: string;
        materials: string;
        vat: string;
        uncollected: string;
        reporting?: { currency: string; deducted: string; base: string };
      }>)
    : [];
  const [withholdingAuthorisation, setWithholdingAuthorisation] = useState(
    typeof custom.withholdingAuthorisation === "string" ? custom.withholdingAuthorisation : "",
  );
  const [withholdingAuthorisedAmount, setWithholdingAuthorisedAmount] = useState(
    typeof custom.withholdingAuthorisedAmount === "string"
      ? custom.withholdingAuthorisedAmount
      : "",
  );
  const showWithholding =
    side === "ap" && (payment.withholdingEnabled === true || savedWithholdings.length > 0);
  const showAuthorisedAmount =
    showWithholding &&
    (payment.withholdingAuthorisationRequired === true ||
      typeof custom.withholdingAuthorisedAmount === "string" ||
      withholdingAuthorisation.trim() !== "");
  const savedWithholdingAmount =
    typeof custom.withholdingAmount === "string" ? custom.withholdingAmount : "0";

  const [openItems, setOpenItems] = useState<OpenItemClient[]>(initialOpenItems);
  const [loadingItems, setLoadingItems] = useState(false);
  const [allocs, setAllocs] = useState<Record<string, AllocationClient>>(() =>
    Object.fromEntries(payment.allocations.map((a) => [a.openLineId, a])),
  );
  // Stored-value tenders ride the same explicit Save as allocations: fresh
  // codes typed this session plus echoes of already-saved snapshots (the
  // code itself is shown once at issue, so echoes carry the account id).
  const initialTenderDrafts = (): TenderDraft[] =>
    (storedValue?.tenders ?? []).map((tender) => ({
      key: `saved-${tender.accountId}`,
      code: null,
      accountId: tender.accountId,
      codeLast4: tender.codeLast4,
      amount: tender.amount,
      available: null,
    }));
  const [tenderDrafts, setTenderDrafts] = useState<TenderDraft[]>(initialTenderDrafts);
  const showTenders = side === "ar" && storedValue != null;
  // A stable tender payload changes only with the draft: the dirty tracker
  // cannot keep detecting a new array and re-rendering an untouched receipt.
  const tenderPatch = useMemo(
    () =>
      showTenders
        ? tenderDrafts.map((draft) =>
            draft.code
              ? { code: draft.code, amount: draft.amount }
              : { accountId: draft.accountId ?? "", amount: draft.amount },
          )
        : null,
    [showTenders, tenderDrafts],
  );
  const settlementRateKey = `${currency}:${documentDate}:${side}:${openItems.map((item) => item.currency).join(",")}`;
  const [settlementRateResult, setSettlementRateResult] = useState<{
    key: string;
    rates: SettlementRateOption[];
  }>({ key: "", rates: [] });
  // Explicit settlement rate into the owning entity's functional currency:
  // undefined keeps the stored evidence, null clears it, a draft records a
  // replacement on the next Save with the exact pair and date shown.
  const [explicitFx, setExplicitFx] = useState<ExplicitFxDraft | null | undefined>(undefined);
  const [fxEditorOpen, setFxEditorOpen] = useState(false);
  const [fxRateInput, setFxRateInput] = useState("");
  const [fxSourceInput, setFxSourceInput] = useState("");
  const [fxReasonInput, setFxReasonInput] = useState("");
  const fxFunctional =
    fundingSubsidiaries.find((sub) => sub.id === fundingSubsidiaryId)?.currency ??
    (typeof doc.functional_currency === "string" ? doc.functional_currency : null);
  const storedFx = storedExplicitFx(doc.document_fx_rate_evidence);
  const shownFx = explicitFx === undefined ? storedFx : explicitFx;
  const showFx = fxFunctional !== null && (currency !== fxFunctional || storedFx !== null);
  const settlementRates =
    settlementRateResult.key === settlementRateKey ? settlementRateResult.rates : [];
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  // The last successful save: the revision it was fenced on and the revision
  // the row holds after it. The save response carries the committed token, so
  // Post chains directly on it; the refreshed record arriving later changes
  // documentRevision and retires this receipt. A save response without a token
  // keeps Post settling (disabled, with the reason shown) until the refreshed
  // record arrives, so Post never fires on the pre-save revision.
  const [saveReceipt, setSaveReceipt] = useIdentityState<{
    fencedRevision: string;
    committedRevision: string | null;
  } | null>([doc.id], null);
  const pendingCommit =
    saveReceipt !== null && documentRevision === saveReceipt.fencedRevision ? saveReceipt : null;
  const postRevision = pendingCommit?.committedRevision ?? documentRevision;
  const saveSettling = pendingCommit !== null && pendingCommit.committedRevision === null;
  // A refused save/post must stay visible past its toast: the
  // typed refusal pins as a record-level alert until the next action, and
  // busy always releases through the shared path's finally.
  const { busy, refusal, execute, clearRefusal } = useAppAction();

  // -- open items follow the selected party --------------------------------
  // Reset the allocations (and enter the loading state) when the party
  // selection changes, during render (same committed values, no extra
  // render). Keyed on the fetch inputs below.
  const [prevPartyKeys, setPrevPartyKeys] = useState(() => ({
    partyId,
    side,
    isDraft,
    fundingSubsidiaryId,
  }));
  if (
    prevPartyKeys.partyId !== partyId ||
    prevPartyKeys.side !== side ||
    prevPartyKeys.isDraft !== isDraft ||
    prevPartyKeys.fundingSubsidiaryId !== fundingSubsidiaryId
  ) {
    setPrevPartyKeys({ partyId, side, isDraft, fundingSubsidiaryId });
    if (isDraft) {
      setAllocs({});
      setOpenItems([]);
      setLoadingItems(Boolean(partyId && fundingSubsidiaryId));
    }
  }
  // Mount-skip mirror: the mount pass keeps the passed initialOpenItems; only
  // post-mount party changes fetch. (Ref write in an effect — no setState, so
  // no cascade and no extra dep subscription.)
  const partyFetchArmed = useRef(false);
  useEffect(() => {
    if (!isDraft) return;
    if (!partyFetchArmed.current) {
      partyFetchArmed.current = true;
      return;
    }
    if (!partyId || !fundingSubsidiaryId) return;
    let cancelled = false;
    fetch(
      `/api/payments/open-items?partyId=${partyId}&side=${side}&subsidiaryId=${fundingSubsidiaryId}`,
    )
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          toast.error(await readApiErrorMessage(res, t("toasts.loadOpenItemsFailed")));
          return;
        }
        const data = await res.json();
        if (!cancelled) setOpenItems(data.items ?? []);
      })
      .catch(() => {
        if (!cancelled) toast.error(t("toasts.loadOpenItemsFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoadingItems(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partyId, side, isDraft, fundingSubsidiaryId, t]);

  useEffect(() => {
    if (!editable || !fundingSubsidiaryId || !documentDate) return;
    const controller = new AbortController();
    const query = new URLSearchParams({
      kind: side === "ar" ? "customer_payment" : "vendor_payment",
      subsidiaryId: fundingSubsidiaryId,
      currency: currency,
      date: documentDate,
    });
    fetch(`/api/payments/funding-accounts?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const message = await readApiErrorMessage(response, tFunding("loadFailed"));
          if (!controller.signal.aborted) setFundingError(message);
          return;
        }
        const data = (await response.json()) as { accounts: Opt[] };
        if (!controller.signal.aborted) setFundingAccounts(data.accounts);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFundingError(tFunding("loadFailed"));
      });
    return () => controller.abort();
  }, [
    editable,
    fundingSubsidiaryId,
    currency,
    documentDate,
    side,
    fundingRetry,
    tFunding,
    setFundingError,
    setFundingAccounts,
  ]);

  // Results are scoped to the submitted inputs, so old evidence disappears
  // immediately on a date/currency/party-side change. Effect cleanup prevents
  // superseded requests from publishing their response.
  useEffect(() => {
    const key = settlementRateKey;
    const targets = [
      ...new Set(
        openItems.filter((item) => item.currency !== currency).map((item) => item.currency),
      ),
    ];
    if (!targets.length || !documentDate) return;
    let cancelled = false;
    const query = new URLSearchParams({
      side,
      from: currency,
      to: targets.join(","),
      date: documentDate,
    });
    fetch(`/api/payments/settlement-rates?${query}`)
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const data = await response.json();
        if (!cancelled) setSettlementRateResult({ key, rates: data.rates ?? [] });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currency, documentDate, openItems, side, settlementRateKey]);

  // useCallback: validAllocations below depends on this; a bare closure would be
  // a fresh identity every render and defeat that memo.
  const rowValid = useCallback(
    (item: OpenItemClient) => {
      const allocation = allocs[item.lineId];
      if (allocation === undefined) return true;
      try {
        const source = normalizeMoney(allocation.sourceTransactionAmount);
        const target = normalizeMoney(allocation.targetTransactionAmount);
        if (cmp(source, "0") <= 0 || cmp(target, "0") <= 0 || cmp(target, item.transactionOpen) > 0)
          return false;
        if (cmp(mulRate(source, allocation.settlementRate), target) !== 0) return false;
        if (!allocation.settlementRateReference.trim()) return false;
        if (item.currency === currency) {
          return (
            cmp(source, target) === 0 &&
            cmp(allocation.settlementRate, "1") === 0 &&
            allocation.settlementRateSource === "same_currency"
          );
        }
        return (
          allocation.settlementRateSource !== "same_currency" &&
          (allocation.settlementRateSource !== "provider" || !!allocation.settlementFxRateId)
        );
      } catch {
        return false;
      }
    },
    [allocs, currency],
  );
  const validAllocations = useMemo(
    () =>
      openItems
        .filter((i) => allocs[i.lineId] !== undefined && rowValid(i))
        .map((i) => {
          const allocation = allocs[i.lineId]!;
          return {
            ...allocation,
            sourceTransactionAmount: normalizeMoney(allocation.sourceTransactionAmount),
            targetTransactionAmount: normalizeMoney(allocation.targetTransactionAmount),
          };
        }),
    [allocs, openItems, rowValid],
  );
  const hasInvalidRow = openItems.some((i) => !rowValid(i));
  // A payment settles exactly one control account (the posting kernel and the
  // application ledger both refuse a mix), so once an item is selected, items
  // on any other receivable/payable account are held for a separate payment.
  const selectedAccountId =
    openItems.find((item) => allocs[item.lineId] !== undefined)?.accountId ?? null;
  const showsItemAccounts = new Set(openItems.map((item) => item.accountId ?? "")).size > 1;
  const otherAccount = (item: OpenItemClient): boolean =>
    selectedAccountId !== null &&
    item.accountId !== undefined &&
    item.accountId !== selectedAccountId;
  const displayedOpenItems = editable
    ? openItems
    : openItems.filter((item) => allocs[item.lineId] !== undefined);
  const appliedTotal = sum(
    validAllocations.map((allocation) => allocation.sourceTransactionAmount),
  );
  const received = (() => {
    if (side !== "ar" || receivedAmount.trim() === "") return null;
    try {
      return normalizeMoney(receivedAmount.trim());
    } catch {
      return null;
    }
  })();
  const receivedInvalid = side === "ar" && receivedAmount.trim() !== "" && received === null;
  // Received less than applied cannot post: the applications would claim
  // cash the bank never saw.
  const receivedShort = received !== null && cmp(received, appliedTotal) < 0;
  const onAccount =
    received !== null && cmp(received, appliedTotal) > 0
      ? `${sum([received, `-${appliedTotal}`])}`
      : "0";
  const total = sum([appliedTotal, onAccount]);

  // -- explicit save (no autosave) -----------------------------------------
  const payload = useMemo(
    () => ({
      expectedUpdatedAt: documentRevision,
      ...(createMode ? { subsidiaryId: fundingSubsidiaryId || null } : {}),
      partyId: partyId || null,
      bankAccountId: bankAccountId || null,
      documentDate: documentDate || undefined,
      referenceNumber,
      memo,
      allocations: validAllocations,
      ...(side === "ar" ? { onAccountAmount: onAccount } : {}),
      ...(showWithholding
        ? {
            withholdingAuthorisation: withholdingAuthorisation || null,
            withholdingAuthorisedAmount: withholdingAuthorisedAmount.trim() || null,
          }
        : {}),
      ...(tenderPatch !== null ? { storedValueTenders: tenderPatch } : {}),
      ...(explicitFx !== undefined ? { explicitFx } : {}),
    }),
    [
      partyId,
      bankAccountId,
      documentDate,
      referenceNumber,
      memo,
      validAllocations,
      onAccount,
      side,
      tenderPatch,
      documentRevision,
      showWithholding,
      withholdingAuthorisation,
      withholdingAuthorisedAmount,
      createMode,
      fundingSubsidiaryId,
      explicitFx,
    ],
  );
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render). `editable` is read
  // but deliberately NOT subscribed: the gate fires only when `payload`
  // changes identity, so merely entering edit mode with untouched fields never
  // marks the form dirty (same guarantee as the ref-mirrored gate this
  // replaces, without the effect-body setState).
  const [dirty, setDirty] = useState(false);
  const [prevPayload, setPrevPayload] = useState(payload);
  if (prevPayload !== payload) {
    setPrevPayload(payload);
    if (editable) setDirty(true);
  }

  // A dirty editor never closes silently: the X button (via beforeClose)
  // and Cancel both ask first, so typed work survives a stray click.
  async function confirmDiscard() {
    if (mode !== "edit" || !dirty) return true;
    return confirmDialog({
      message: tCommon("feedback.unsavedChanges"),
      confirmLabel: tCommon("confirm.discardChanges"),
      tone: "danger",
    });
  }

  async function cancelWithConfirm() {
    if (!(await confirmDiscard())) return;
    cancel();
  }

  /** Reset every field back to the loaded document (used by Cancel). */
  function resetForm() {
    const restoredParty = doc.party_id ?? "";
    setPartyId(restoredParty);
    setBankAccountId(payment.bankAccountId ?? "");
    setDocumentDate(doc.document_date ?? "");
    setReferenceNumber(doc.reference_number ?? "");
    setMemo(doc.memo ?? "");
    setWithholdingAuthorisation(
      typeof custom.withholdingAuthorisation === "string" ? custom.withholdingAuthorisation : "",
    );
    setWithholdingAuthorisedAmount(
      typeof custom.withholdingAuthorisedAmount === "string"
        ? custom.withholdingAuthorisedAmount
        : "",
    );
    setAllocs(Object.fromEntries(payment.allocations.map((a) => [a.openLineId, a])));
    setExplicitFx(undefined);
    setTenderDrafts(initialTenderDrafts());
    // Restoring the party must not trip the party-change reset on the next
    // render: sync its tracking and bring back the loaded open items, or the
    // wipe clears the restored applications and a later save deletes them.
    setPrevPartyKeys({ partyId: restoredParty, side, isDraft, fundingSubsidiaryId });
    setOpenItems(initialOpenItems);
    setLoadingItems(false);
  }

  /**
   * Unsaved-create Save: one idempotent POST carrying the whole payment —
   * kind (fixed by the entry surface), header, and applications. The key is
   * minted once per drawer session, so a double-click or a retried request
   * returns the same payment instead of a duplicate. Cancel/close before
   * this point wrote nothing — this is the first and only write, and the
   * PAY-/RCPT- number is allocated inside it.
   */
  async function saveNew() {
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    setSaveState("saving");
    // The create body carries the kind (fixed by the surface: vendor_payment
    // on /payments, customer_payment on /receipts), never the PATCH revision
    // token — there is no row to version against here.
    const createBody = {
      kind: side === "ap" ? "vendor_payment" : "customer_payment",
      partyId: partyId || null,
      bankAccountId: bankAccountId || null,
      subsidiaryId: fundingSubsidiaryId || undefined,
      currency: currency,
      documentDate: documentDate || undefined,
      referenceNumber,
      memo,
      allocations: validAllocations,
      ...(side === "ar" && cmp(onAccount, "0") > 0 ? { onAccountAmount: onAccount } : {}),
      ...(showWithholding
        ? {
            withholdingAuthorisation: withholdingAuthorisation || null,
            withholdingAuthorisedAmount: withholdingAuthorisedAmount.trim() || null,
          }
        : {}),
      ...(tenderPatch !== null ? { storedValueTenders: tenderPatch } : {}),
      ...(explicitFx !== undefined ? { explicitFx } : {}),
    };
    const ok = await execute(
      () =>
        fetchAction("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": requestIdRef.current! },
          body: JSON.stringify(createBody),
        }),
      {
        fallbackMessage: t("toasts.postFailed"),
        onOk: (data) => {
          const createdId = (data as { doc?: { id?: unknown } } | null)?.doc?.id;
          setSaveState("saved");
          setDirty(false);
          if (typeof createdId === "string" && createdId) {
            const separator = returnHref.includes("?") ? "&" : "?";
            router.replace(`${returnHref}${separator}payment=${createdId}` as never);
          } else {
            router.push(returnHref as never);
          }
          router.refresh();
        },
        onRefused: () => {
          // Stay in edit mode with the typed values intact: the form is
          // still dirty, nothing was persisted, the pin carries the reason.
          setSaveState("error");
        },
      },
    );
    if (ok) router.refresh();
  }

  async function save() {
    if (createMode) {
      await saveNew();
      return;
    }
    // The fence token this save carries; the save response reports the
    // revision the row now holds (see saveReceipt).
    const fencedRevision = payload.expectedUpdatedAt;
    setSaveState("saving");
    const ok = await execute(
      () =>
        fetchAction(`/api/payments/${doc.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      {
        fallbackMessage: t("toasts.postFailed"),
        onOk: (data) => {
          setSaveState("saved");
          setDirty(false);
          setSaveReceipt({ fencedRevision, committedRevision: committedRevisionOf(data) });
          setMode("view");
        },
        onRefused: () => {
          setSaveState("error");
          setSaveReceipt(null);
        },
      },
    );
    if (ok) router.refresh();
  }

  function cancel() {
    // Unsaved-create Cancel writes nothing: there is no persisted row to
    // restore, so leave the URL (and the database) exactly as found.
    if (createMode) {
      clearRefusal();
      router.push(returnHref as never);
      return;
    }
    resetForm();
    setDirty(false);
    setSaveState("saved");
    // Cancelling restores the loaded record, so its token is current again:
    // a save followed by Cancel must not hold Post disabled.
    setSaveReceipt(null);
    clearRefusal();
    setMode("view");
  }

  async function post() {
    // A non-JSON refusal body must not throw past the toast and wedge the
    // button busy (a 422 once posted with zero UI feedback from the
    // bare res.json() here): the shared read cannot throw, and the busy
    // reset lives in its finally.
    await execute(
      () =>
        fetchAction("/api/payments/post-with-applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Same revision evidence as the draft save: the route fences its
          // final allocation write on this token and 409s a stale drawer.
          body: JSON.stringify({
            documentId: doc.id,
            expectedUpdatedAt: postRevision,
            allocations: validAllocations,
            ...(showWithholding
              ? {
                  withholdingAuthorisation: withholdingAuthorisation || null,
                  withholdingAuthorisedAmount: withholdingAuthorisedAmount.trim() || null,
                }
              : {}),
          }),
        }),
      {
        fallbackMessage: t("toasts.postFailed"),
        onOk: (data) => {
          const pendingApproval =
            (data as { pendingApproval?: unknown } | null)?.pendingApproval === true;
          if (pendingApproval) toast.success(tCommon("actions.submitForApproval"));
          else toast.success(t("toasts.posted", { side }));
        },
      },
    );
    router.refresh();
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t("deleteConfirmTitle"),
        message: t("deleteConfirmBody"),
        confirmLabel: t("deleteConfirmAction"),
        tone: "danger",
      }))
    )
      return;
    await execute(() => fetchAction(`/api/payments/${doc.id}`, { method: "DELETE" }), {
      fallbackMessage: t("deleteFailed"),
      successMessage: t("deleted"),
      onOk: () => {
        router.push(basePath);
        router.refresh();
      },
    });
  }

  async function retryPostingEffects() {
    const reason = await promptDialog({
      title: tPostingEffects("retry"),
      label: tPostingEffects("reason"),
      placeholder: tPostingEffects("reasonHelp"),
    });
    if (reason === null) return;
    if (reason.trim().length < 10 || reason.trim().length > 1000) {
      toast.error(tPostingEffects("reasonHelp"));
      return;
    }
    await execute(
      () =>
        fetchAction(`/api/payments/${doc.id}/retry-effects`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }),
      {
        fallbackMessage: t("toasts.postFailed"),
        successMessage: tPostingEffects("queued"),
        onOk: (data) => {
          const updated = data as { payment?: { doc?: Record<string, unknown> } } | null;
          setPostingEffectStatus(
            docText(updated?.payment?.doc?.posting_effect_status) ?? "pending",
          );
          setPostingEffectsQueued(true);
          router.refresh();
        },
      },
    );
  }

  async function voidPayment() {
    const reason = await promptDialog({
      title: tCommon("amendment.voidTitle"),
      label: tCommon("amendment.reason"),
      placeholder: tCommon("amendment.voidPlaceholder"),
      confirmLabel: tCommon("actions.void"),
    });
    if (!reason) return;
    await execute(
      () =>
        fetchAction(`/api/documents/${doc.id}/void`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The void API fences on the exact revision like every other document
          // write: without it every void answers 409 and the button is dead.
          body: JSON.stringify({ reason, expectedUpdatedAt: documentRevision }),
        }),
      {
        fallbackMessage: t("toasts.postFailed"),
        onOk: (data) => {
          // The void answers 202 with a status string when it lands as
          // pending approval — the body carries the same status, so branch
          // on the data, never on the transport.
          const status = (data as { status?: unknown } | null)?.status;
          if (status === "pending_approval") toast.success(tCommon("actions.submitForApproval"));
          else toast.success(tCommon("status.voided"));
        },
      },
    );
    router.refresh();
  }

  function updateAllocation(lineId: string, patch: Partial<AllocationClient>) {
    setAllocs((previous) => ({
      ...previous,
      [lineId]: { ...previous[lineId]!, ...patch },
    }));
  }

  /**
   * Edit the applied (target) amount on a row. Same-currency lines settle
   * 1:1 — the cash frame (source) always equals the applied amount — so
   * typing a partial apply moves both and the row stays valid. Cross-currency
   * lines keep their own source, rate and evidence: only the operator's
   * cross-foot edit can change those, and rowValid governs the result.
   */
  function updateTargetAmount(item: OpenItemClient, value: string) {
    updateAllocation(
      item.lineId,
      item.currency === currency
        ? { targetTransactionAmount: value, sourceTransactionAmount: value }
        : { targetTransactionAmount: value },
    );
  }

  function toggle(item: OpenItemClient) {
    setAllocs((prev) => {
      const next = { ...prev };
      if (next[item.lineId] === undefined) {
        const targetAmount = normalizeMoney(item.transactionOpen);
        if (item.currency === currency) {
          next[item.lineId] = {
            openLineId: item.lineId,
            sourceTransactionAmount: targetAmount,
            targetTransactionAmount: targetAmount,
            settlementRate: "1",
            settlementRateSource: "same_currency",
            settlementRateReference: "same transaction currency",
          };
        } else {
          const evidence = settlementRates.find((rate) => rate.toCurrency === item.currency);
          next[item.lineId] = {
            openLineId: item.lineId,
            sourceTransactionAmount: evidence ? divRate(targetAmount, evidence.rate) : "",
            targetTransactionAmount: targetAmount,
            settlementRate: evidence?.rate ?? "",
            settlementRateSource: evidence ? "provider" : "manual",
            settlementRateReference: evidence ? `${evidence.source} · ${evidence.asOf}` : "",
            settlementFxRateId: evidence?.id ?? null,
          };
        }
      } else delete next[item.lineId];
      return next;
    });
  }

  // Automated cash application: ask the engine to spread the received amount
  // across the party's open items (reference → exact → FIFO) and fill the rows.
  async function autoApply() {
    if (!partyId) return;
    const sameCurrencyItems = openItems.filter(
      (item) => item.currency === currency && !item.reservedByRun,
    );
    // The suggestion seed is an exact decimal in the document currency, not
    // hard-coded 2dp: 3-decimal currencies (KWD, BHD) would otherwise
    // under-apply by the rounded tail.
    const amount =
      receivedAmount.trim() ||
      formatMoney(
        sum(sameCurrencyItems.map((item) => item.transactionOpen)),
        currencyMinorUnits(currency),
      );
    await execute(
      () =>
        fetchAction("/api/payments/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partyId,
            amount,
            side,
            currency: currency,
            reference: referenceNumber || null,
          }),
        }),
      {
        fallbackMessage: t("autoApplyFailed"),
        onOk: (data) => {
          const suggestion = data as {
            allocations?: AllocationClient[];
            strategy?: unknown;
          } | null;
          if (!suggestion?.allocations?.length) {
            toast.info(t("autoApplyNone"));
            return;
          }
          setAllocs(
            Object.fromEntries(
              suggestion.allocations.map((a: AllocationClient) => [a.openLineId, a]),
            ),
          );
          toast.success(
            t("autoApplyDone", {
              count: suggestion.allocations.length,
              strategy: t(`autoApplyStrategy.${String(suggestion.strategy)}`),
            }),
          );
        },
      },
    );
  }

  const field = "space-y-1.5";
  const soleSelectedBank =
    fundingAccounts.length === 1 && fundingAccounts[0]!.id === bankAccountId
      ? fundingAccounts[0]
      : null;
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const label = placement.labelOverride?.trim();
    switch (placement.key) {
      case "party_id":
        return (
          <>
            <FieldLabel fieldName={label || partyLabel}>
              {label || partyLabel}
              {isEditable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {isEditable ? (
              <SearchSelect
                options={parties.map((party) => ({
                  value: party.id,
                  label: party.display_name ?? "",
                }))}
                value={partyId}
                onChange={(value) => setPartyId(value ?? "")}
                placeholder={t("selectPartyPlaceholder", { side })}
              />
            ) : (
              <p className="text-sm">{doc.party_name}</p>
            )}
          </>
        );
      case "bank_account_id":
        return (
          <>
            <FieldLabel fieldName={label || fundingLabel}>
              {label || fundingLabel}
              {isEditable ? <span className="text-red-500"> *</span> : null}
            </FieldLabel>
            {isEditable && !soleSelectedBank ? (
              <SearchSelect
                options={fundingAccounts.map((account) => ({
                  value: account.id,
                  label: fundingOptionLabel(account),
                }))}
                value={bankAccountId}
                onChange={(value) => setBankAccountId(value ?? "")}
                placeholder={fundingPlaceholder}
              />
            ) : (
              <p className="text-sm">
                {soleSelectedBank
                  ? `${soleSelectedBank.number ?? ""} ${soleSelectedBank.name ?? ""}`.trim()
                  : `${doc.bank_account_number ?? ""} ${doc.bank_account_name ?? ""}`.trim() || "—"}
              </p>
            )}
          </>
        );
      case "document_date":
        return (
          <>
            <FieldLabel fieldName={label || tCommon("labels.date")}>
              {label || tCommon("labels.date")}
            </FieldLabel>
            {isEditable ? (
              <DateField value={documentDate} onChange={(value) => setDocumentDate(value)} />
            ) : (
              <p className="text-sm">{doc.document_date}</p>
            )}
          </>
        );
      case "reference_number":
        return (
          <>
            <FieldLabel fieldName={label || tCommon("labels.reference")}>
              {label || tCommon("labels.reference")}
            </FieldLabel>
            {isEditable ? (
              <Input
                value={referenceNumber}
                onChange={(event) => setReferenceNumber(event.target.value)}
                placeholder={t("referencePlaceholder")}
              />
            ) : (
              <p className="text-sm">{doc.reference_number ?? "—"}</p>
            )}
          </>
        );
      case "memo":
        return (
          <>
            <FieldLabel fieldName={label || tCommon("labels.memo")}>
              {label || tCommon("labels.memo")}
            </FieldLabel>
            {isEditable ? (
              <Input value={memo} onChange={(event) => setMemo(event.target.value)} />
            ) : (
              <p className="text-sm">{doc.memo ?? "—"}</p>
            )}
          </>
        );
      default:
        return null;
    }
  };
  const canPost =
    (isDraft || doc.status === "approved") &&
    !busy &&
    !saveSettling &&
    !hasInvalidRow &&
    !receivedInvalid &&
    !receivedShort &&
    !dirty &&
    !!partyId &&
    !!bankAccountId &&
    // A customer receipt may post on its on-account amount alone (an open AR
    // credit); a vendor payment must apply at least one bill.
    (validAllocations.length > 0 || cmp(onAccount, "0") > 0) &&
    cmp(total, "0") > 0;
  // Why Post cannot proceed, first blocker first. A disabled button alone
  // never explains itself (in the Actions menu it renders near-invisible),
  // so the primary action carries its reason as visible text beside it.
  // The settling state leads only when the save reported no committed
  // revision: Post then has no token it can prove, so it waits for the
  // refreshed record instead of firing on the pre-save revision.
  const postBlocker = saveSettling
    ? tCommon("actions.saving")
    : !partyId
      ? t("postBlocked.noParty", { side })
      : !bankAccountId
        ? side === "ar"
          ? tFunding("selectReceiptAccount")
          : t("postBlocked.noBankAccount", { side })
        : hasInvalidRow
          ? t("postBlocked.invalidRows")
          : receivedInvalid || receivedShort
            ? t("receivedShort")
            : validAllocations.length === 0 && cmp(onAccount, "0") <= 0
              ? t("postBlocked.noAllocations", { side })
              : cmp(total, "0") <= 0
                ? t("postBlocked.generic")
                : dirty
                  ? t("postBlocked.generic")
                  : null;
  const postLabel =
    payment.governedByFlow === true
      ? tCommon("actions.submitForApproval")
      : t("postAction", { side });

  return (
    <TransactionDrawer
      closeHref={returnHref}
      beforeClose={confirmDiscard}
      recordId={String(doc.id)}
      // Unsaved-create hides the evidence tabs: both panels read the
      // persisted row the drawer has not written yet, so mounting them
      // would only probe the API with an empty record id.
      showEvidenceTabs={!createMode}
      canEditAttachments={canEditStatus}
      panelClassName={
        docTypeMeta(String(doc.kind ?? (side === "ap" ? "vendor_payment" : "customer_payment")))
          .surfaceCls
      }
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge
            kind={String(doc.kind ?? (side === "ap" ? "vendor_payment" : "customer_payment"))}
          />
          <span className="font-mono">
            {displayDocumentNumber(doc.document_number, doc.reference_number) ||
              (createMode ? (createTitle ?? "") : "")}
          </span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? "secondary"}>
            {statusLabel(String(doc.status))}
          </Badge>
        </span>
      }
      description={
        mode === "edit" ? tCommon("feedback.editingHint") : (doc.party_name ?? undefined)
      }
      // Save is the primary header action in edit mode — burying it in the
      // Actions menu hid receipt/payment persistence from routine operators.
      // Post is primary the same way for drafts in view mode: a disabled
      // menu entry rendered near-invisible and hid posting from operators
      // whose draft missed a prerequisite.
      primaryAction={
        canEditStatus ? (
          mode === "edit" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                onClick={() => cancelWithConfirm()}
              >
                {tCommon("actions.cancel")}
              </Button>
              <Button
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                onClick={() => save()}
              >
                {busy ? tCommon("actions.saving") : tCommon("actions.save")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                onClick={() => setMode("edit")}
              >
                {tCommon("actions.edit")}
              </Button>
              {isDraft && !createMode ? (
                <Button
                  size="sm"
                  className="h-8 px-2.5 text-xs"
                  disabled={busy || !canPost}
                  title={postBlocker ?? undefined}
                  onClick={post}
                >
                  {busy ? tCommon("actions.posting") : postLabel}
                </Button>
              ) : null}
            </>
          )
        ) : doc.status === "posted" &&
          postingEffectStatus === "terminal_failed" &&
          payment.canRetryPostingEffects === true ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs"
            disabled={busy}
            onClick={retryPostingEffects}
          >
            {tPostingEffects("retry")}
          </Button>
        ) : null
      }
      actions={
        mode === "edit" ? null : (
          <>
            <PdfButton
              recordType={String(
                doc.kind ?? (side === "ap" ? "vendor_payment" : "customer_payment"),
              )}
              recordId={String(doc.id)}
            />
            <SendButton
              recordType={String(
                doc.kind ?? (side === "ap" ? "vendor_payment" : "customer_payment"),
              )}
              recordId={String(doc.id)}
            />
            <FlowManualButtons subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
            <ApprovalActions subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
            {doc.status === "approved" ? (
              <Button disabled={!canPost} onClick={post}>
                {busy ? tCommon("actions.posting") : t("postAction", { side })}
              </Button>
            ) : null}
            {doc.entry_id ? (
              <Button variant="outline" asChild>
                <JournalEntryLink entryId={doc.entry_id}>{t("viewGlImpact")}</JournalEntryLink>
              </Button>
            ) : null}
            {doc.status === "approved" || doc.status === "posted" ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={voidPayment}
                className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                {tCommon("actions.void")}
              </Button>
            ) : null}
            {doc.status === "draft" ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={remove}
                className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                {tCommon("actions.delete")}
              </Button>
            ) : null}
          </>
        )
      }
      // No approvals tab before the first Save: the history reads the
      // persisted row the drawer has not written yet.
      keepRecordTabsMounted={showTenders ? ["tenders"] : false}
      detailTabs={[
        ...(showWithholding
          ? [
              {
                key: "withholding",
                label: tWithholding("title"),
                content: (
                  <div className="space-y-4">
                    <div>
                      <Label>{tWithholding("authorisation")}</Label>
                      <Input
                        value={withholdingAuthorisation}
                        disabled={!editable}
                        maxLength={100}
                        onChange={(event) => setWithholdingAuthorisation(event.target.value)}
                      />
                      <p className="mt-1 text-sm text-muted-foreground">
                        {tWithholding("authorisationHelp")}
                      </p>
                    </div>
                    {showAuthorisedAmount ? (
                      <div>
                        <Label htmlFor="withholding-authorised-amount">
                          {tWithholding("authorisedAmount")}{" "}
                          {payment.withholdingAuthorisationCurrency
                            ? `(${payment.withholdingAuthorisationCurrency})`
                            : ""}
                        </Label>
                        <MoneyInput
                          id="withholding-authorised-amount"
                          field={tWithholding("authorisedAmount")}
                          value={withholdingAuthorisedAmount}
                          onChange={setWithholdingAuthorisedAmount}
                          disabled={!editable}
                          maxScale={4}
                          placeholder="0.0000"
                        />
                        <p className="mt-1 text-sm text-muted-foreground">
                          {tWithholding("authorisedAmountHelp")}
                        </p>
                      </div>
                    ) : null}
                    <p className="text-sm">{tWithholding("savedEvidence")}</p>
                    <dl className="grid grid-cols-2 gap-3">
                      <div>
                        <dt>{tWithholding("deducted")}</dt>
                        <dd>{money(savedWithholdingAmount, { currency: currency })}</dd>
                      </div>
                      <div>
                        <dt>{tWithholding("cash")}</dt>
                        <dd>{money(doc.total, { currency: currency })}</dd>
                      </div>
                    </dl>
                    <PagedTable
                      source="contractor_withholding_payment_deductions"
                      rows={savedWithholdings}
                      rowKey={(row) => row.openLineId}
                      empty={tWithholding("emptyPayees")}
                      columns={[
                        {
                          key: "bill",
                          header: tWithholding("bill"),
                          cell: (row) => row.billDocumentNumber,
                        },
                        {
                          key: "scheme",
                          header: tWithholding("scheme"),
                          cell: (row) => row.schemeCode,
                        },
                        {
                          key: "band",
                          header: tWithholding("band"),
                          cell: (row) => `${row.bandCode} · ${row.ratePercent}%`,
                        },
                        {
                          key: "base",
                          header: tWithholding("base"),
                          align: "right",
                          cell: (row) => money(row.base, { currency: currency }),
                        },
                        {
                          key: "deducted",
                          header: tWithholding("deducted"),
                          align: "right",
                          cell: (row) => (
                            <div>
                              {money(row.deducted, { currency: currency })}
                              {row.reporting && row.reporting.currency !== currency ? (
                                <div className="text-xs text-muted-foreground">
                                  {tWithholding("reportedDeduction")}:{" "}
                                  {money(row.reporting.deducted, {
                                    currency: row.reporting.currency,
                                  })}
                                </div>
                              ) : null}
                            </div>
                          ),
                        },
                      ]}
                    />
                  </div>
                ),
              },
            ]
          : []),
        ...(showTenders
          ? [
              {
                key: "tenders",
                label: tStoredValue("payment.tenderLabel"),
                content: (
                  <StoredValueTendersSection
                    currency={currency}
                    receiptTotal={total}
                    partyId={partyId || null}
                    drafts={tenderDrafts}
                    onChange={setTenderDrafts}
                    initialCredits={storedValue?.customerCredits ?? []}
                    disabled={!editable}
                  />
                ),
              },
            ]
          : []),
        ...(!createMode
          ? [
              {
                key: "approvals",
                label: tCommon("approvalFlow.historyTitle"),
                content: (
                  <ApprovalHistory
                    subjectKind={String(doc.kind)}
                    subjectId={String(doc.id)}
                    showEmptyState
                  />
                ),
              },
            ]
          : []),
      ]}
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              "text-xs " +
              (saveState === "error"
                ? "text-red-600 dark:text-red-400"
                : "text-slate-500 dark:text-slate-400")
            }
          >
            {mode === "edit"
              ? saveState === "saving"
                ? tCommon("actions.saving")
                : saveState === "error"
                  ? t("saveState.error")
                  : dirty
                    ? t("saveState.dirty")
                    : null
              : isDraft && !createMode && !busy && !canPost && postBlocker
                ? postBlocker
                : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {isDraft ? (
              t.rich("applyingSummary", {
                count: validAllocations.length,
                amount: money(total, { currency: currency }),
                total: (chunks) => (
                  <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>
                ),
              })
            ) : (
              <strong className="text-slate-900 dark:text-slate-100">
                {t("totalAmount", { amount: money(doc.total, { currency: currency }) })}
              </strong>
            )}
          </span>
        </div>
      }
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={refusal} fallbackMessage={t("toasts.postFailed")} />
        {postingEffectStatus === "terminal_failed" && docText(doc.posting_effect_error) ? (
          <p role="alert" className="text-sm text-red-600">
            {docText(doc.posting_effect_error)}
          </p>
        ) : null}
        {postingEffectsQueued ? (
          <p role="status" className="text-sm text-muted-foreground">
            {tPostingEffects("queued")}
          </p>
        ) : null}
        {fundingError && editable ? (
          <div role="alert" className="text-sm text-red-600">
            {fundingError}{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFundingRetry((value) => value + 1)}
            >
              {tCommon("actions.retry")}
            </Button>
          </div>
        ) : null}
        {createMode && fundingSubsidiaries.length > 1 ? (
          <div className={field}>
            <Label>{tFunding("legalEntity")}</Label>
            <Select
              value={fundingSubsidiaryId}
              onChange={(event) => {
                setFundingSubsidiaryId(event.target.value);
                setBankAccountId("");
                setAllocs({});
                setOpenItems([]);
              }}
            >
              <option value="">{tFunding("choose")}</option>
              {fundingSubsidiaries.map((sub) => (
                <option key={sub.id} value={sub.id}>
                  {sub.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {layout ? (
          <HeaderFields
            layout={layout}
            editable={editable}
            renderField={renderHeaderField}
            expandDetails={!createMode}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className={`${field} lg:col-span-2`}>
              <Label>
                {partyLabel}
                {editable ? <span className="text-red-500"> *</span> : null}
              </Label>
              {editable ? (
                <SearchSelect
                  options={parties.map((p) => ({ value: p.id, label: p.display_name ?? "" }))}
                  value={partyId}
                  onChange={(v) => setPartyId(v ?? "")}
                  placeholder={t("selectPartyPlaceholder", { side })}
                />
              ) : (
                <p className="text-sm">{doc.party_name}</p>
              )}
            </div>
            <div className={`${field} lg:col-span-2`}>
              <Label>
                {fundingLabel}
                {editable ? <span className="text-red-500"> *</span> : null}
              </Label>
              {editable ? (
                <SearchSelect
                  options={fundingAccounts.map((a) => ({
                    value: a.id,
                    label: fundingOptionLabel(a),
                  }))}
                  value={bankAccountId}
                  onChange={(v) => setBankAccountId(v ?? "")}
                  placeholder={fundingPlaceholder}
                />
              ) : (
                <p className="text-sm">
                  {`${doc.bank_account_number ?? ""} ${doc.bank_account_name ?? ""}`.trim() || "—"}
                </p>
              )}
            </div>
            <div className={field}>
              <Label>{tCommon("labels.date")}</Label>
              {editable ? (
                <DateField value={documentDate} onChange={(value) => setDocumentDate(value)} />
              ) : (
                <p className="text-sm">{doc.document_date}</p>
              )}
            </div>
            <div className={field}>
              <Label>{tCommon("labels.reference")}</Label>
              {editable ? (
                <Input
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder={t("referencePlaceholder")}
                />
              ) : (
                <p className="text-sm">{doc.reference_number ?? "—"}</p>
              )}
            </div>
            <div className={`${field} lg:col-span-2`}>
              <Label>{tCommon("labels.memo")}</Label>
              {editable ? (
                <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
              ) : (
                <p className="text-sm">{doc.memo ?? "—"}</p>
              )}
            </div>
          </div>
        )}

        {showFx && fxFunctional ? (
          <div className="space-y-1.5">
            <FieldLabel fieldName={tFx("label")}>{tFx("label")}</FieldLabel>
            {shownFx ? (
              <div className="text-sm">
                <p className="tabular-nums">
                  {tFx("conversion", {
                    from: shownFx.fromCurrency,
                    rate: shownFx.rate,
                    to: shownFx.toCurrency,
                    date: shownFx.rateDate,
                  })}
                  {explicitFx !== undefined ? (
                    <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                      {tFx("unsaved")}
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {tFx("sourceLine", { source: shownFx.source })}
                </p>
              </div>
            ) : (
              <p className="text-sm">
                {explicitFx === null
                  ? tFx("clearedUnsaved")
                  : tFx("marketRates", { from: currency, to: fxFunctional })}
              </p>
            )}
            {shownFx && shownFx.rateDate !== documentDate ? (
              <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
                {tFx(explicitFx === undefined ? "staleStored" : "stalePending", {
                  date: documentDate,
                })}
              </p>
            ) : null}
            {editable && isDraft ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFxRateInput(shownFx?.rate ?? "");
                    setFxSourceInput(shownFx?.source ?? "");
                    setFxReasonInput(explicitFx ? explicitFx.reason : "");
                    setFxEditorOpen(true);
                  }}
                >
                  {shownFx ? tFx("change") : tFx("record")}
                </Button>
                {shownFx ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setExplicitFx(storedFx ? null : undefined)}
                  >
                    {tFx("useMarketRates")}
                  </Button>
                ) : explicitFx === null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setExplicitFx(undefined)}
                  >
                    {tFx("keepRecorded")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Drawer
              open={fxEditorOpen}
              stacked
              size="sm"
              onClose={() => setFxEditorOpen(false)}
              title={tFx("editorTitle")}
              description={tFx("editorDescription", {
                from: currency,
                to: fxFunctional,
                date: documentDate,
              })}
              footer={
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setFxEditorOpen(false)}>
                    {tFx("cancel")}
                  </Button>
                  <Button
                    type="button"
                    disabled={!fxRateInput.trim() || !fxSourceInput.trim() || !fxReasonInput.trim()}
                    onClick={() => {
                      setExplicitFx({
                        rate: fxRateInput.trim(),
                        source: fxSourceInput.trim(),
                        reason: fxReasonInput.trim(),
                        fromCurrency: currency,
                        toCurrency: fxFunctional,
                        rateDate: documentDate,
                      });
                      setFxEditorOpen(false);
                    }}
                  >
                    {tFx("apply")}
                  </Button>
                </div>
              }
            >
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="payment-fx-rate">
                    {tFx("rate", { from: currency, to: fxFunctional })}
                  </Label>
                  <Input
                    id="payment-fx-rate"
                    inputMode="decimal"
                    value={fxRateInput}
                    onChange={(event) => setFxRateInput(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="payment-fx-source">{tFx("source")}</Label>
                  <Input
                    id="payment-fx-source"
                    maxLength={120}
                    value={fxSourceInput}
                    placeholder={tFx("sourcePlaceholder")}
                    onChange={(event) => setFxSourceInput(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="payment-fx-reason">{tFx("reason")}</Label>
                  <Textarea
                    id="payment-fx-reason"
                    maxLength={500}
                    rows={3}
                    value={fxReasonInput}
                    placeholder={tFx("reasonPlaceholder")}
                    onChange={(event) => setFxReasonInput(event.target.value)}
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">{tFx("appliedOnSave")}</p>
              </div>
            </Drawer>
          </div>
        ) : null}

        {isDraft ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t("openItems", { side })}</Label>
              {/* A customer receipt can be entered with no open invoice: the
                  whole amount then stays on account as a customer credit. */}
              {editable && partyId && (side === "ar" || openItems.length > 0) ? (
                <div className="flex items-center gap-2">
                  {side === "ar" ? (
                    <Input
                      inputMode="decimal"
                      value={receivedAmount}
                      onChange={(e) => setReceivedAmount(e.target.value)}
                      placeholder={t("amountReceived")}
                      aria-label={t("amountReceived")}
                      className="h-8 w-32 text-right tabular-nums"
                    />
                  ) : null}
                  {openItems.length > 0 ? (
                    <Button variant="outline" size="sm" disabled={busy} onClick={autoApply}>
                      <Wand2 size={14} /> {t("autoApply")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {!partyId ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {t("selectPartyHint", { side })}
              </p>
            ) : loadingItems ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                {t("loadingOpenItems")}
              </p>
            ) : displayedOpenItems.length === 0 ? (
              <p className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {t("noOpenItems", { side })}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <SharedTable className="w-full text-sm">
                  <SharedTableHeader>
                    <SharedTableRow className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      {editable ? (
                        <SharedTableHead
                          className="w-10 px-3 py-2"
                          aria-label={t("columns.apply")}
                        />
                      ) : null}
                      <SharedTableHead className="px-3 py-2">
                        {t("columns.document")}
                      </SharedTableHead>
                      <SharedTableHead className="px-3 py-2">{t("columns.due")}</SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right">
                        {t("columns.original")}
                      </SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right">
                        {t("columns.appliedToDate")}
                      </SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right">
                        {t("columns.open")}
                      </SharedTableHead>
                      <SharedTableHead className="min-w-56 px-3 py-2 text-right">
                        {t("columns.apply")}
                      </SharedTableHead>
                    </SharedTableRow>
                  </SharedTableHeader>
                  <SharedTableBody>
                    {displayedOpenItems.map((item) => {
                      const checked = allocs[item.lineId] !== undefined;
                      const invalid = !rowValid(item);
                      return (
                        <SharedTableRow
                          key={item.lineId}
                          className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                        >
                          {editable ? (
                            <SharedTableCell className="px-3 py-2">
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-teal-600"
                                checked={checked}
                                disabled={
                                  !checked && (Boolean(item.reservedByRun) || otherAccount(item))
                                }
                                onChange={() => toggle(item)}
                                aria-label={t("applyAriaLabel", {
                                  document: item.documentNumber ?? item.entryNumber,
                                })}
                              />
                            </SharedTableCell>
                          ) : null}
                          <SharedTableCell className="px-3 py-2">
                            <span className="font-mono text-[13px] font-semibold">
                              {item.documentNumber ?? item.entryNumber}
                            </span>
                            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                              {kindLabel(item.documentKind)}
                              {item.referenceNumber ? ` · ${item.referenceNumber}` : ""}
                            </span>
                            {item.reservedByRun ? (
                              <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400">
                                {t("reservedByRun", { runNumber: item.reservedByRun.runNumber })}
                              </span>
                            ) : null}
                            {showsItemAccounts && item.accountName ? (
                              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                                {t("openItemAccount", {
                                  account: `${item.accountNumber ? `${item.accountNumber} · ` : ""}${item.accountName}`,
                                })}
                              </span>
                            ) : null}
                            {editable && !checked && otherAccount(item) ? (
                              <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400">
                                {t("otherControlAccount")}
                              </span>
                            ) : null}
                          </SharedTableCell>
                          <SharedTableCell className="px-3 py-2 text-slate-600 dark:text-slate-300">
                            {item.dueDate ?? "—"}
                          </SharedTableCell>
                          <SharedTableCell className="px-3 py-2 text-right tabular-nums">
                            {money(item.transactionAmount, { currency: item.currency })}
                          </SharedTableCell>
                          <SharedTableCell className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                            {money(item.transactionApplied, { currency: item.currency })}
                          </SharedTableCell>
                          <SharedTableCell className="px-3 py-2 text-right font-medium tabular-nums">
                            {money(item.transactionOpen, { currency: item.currency })}
                          </SharedTableCell>
                          <SharedTableCell className="px-3 py-2">
                            {checked ? (
                              editable ? (
                                <div className="space-y-2">
                                  <div>
                                    <span className="mb-1 block text-[11px] text-slate-500">
                                      {t("targetAmount", { currency: item.currency })}
                                    </span>
                                    <Input
                                      inputMode="decimal"
                                      className={
                                        "h-8 text-right tabular-nums " +
                                        (invalid
                                          ? "border-red-400 focus-visible:ring-red-400 dark:border-red-600"
                                          : "")
                                      }
                                      value={allocs[item.lineId]!.targetTransactionAmount}
                                      onChange={(event) =>
                                        updateTargetAmount(item, event.target.value)
                                      }
                                      aria-invalid={invalid}
                                    />
                                  </div>
                                  {item.currency !== currency ? (
                                    <div className="space-y-2 rounded-md bg-slate-50 p-2 dark:bg-slate-900/60">
                                      <div>
                                        <span className="mb-1 block text-[11px] text-slate-500">
                                          {t("sourceAmount", { currency: currency })}
                                        </span>
                                        <Input
                                          inputMode="decimal"
                                          className="h-8 text-right tabular-nums"
                                          value={allocs[item.lineId]!.sourceTransactionAmount}
                                          onChange={(event) =>
                                            updateAllocation(item.lineId, {
                                              sourceTransactionAmount: event.target.value,
                                            })
                                          }
                                        />
                                      </div>
                                      <div>
                                        <span className="mb-1 block text-[11px] text-slate-500">
                                          {t("settlementRate", {
                                            target: item.currency,
                                            source: currency,
                                          })}
                                        </span>
                                        <Input
                                          inputMode="decimal"
                                          className="h-8 text-right tabular-nums"
                                          value={allocs[item.lineId]!.settlementRate}
                                          disabled={
                                            allocs[item.lineId]!.settlementRateSource === "provider"
                                          }
                                          onChange={(event) =>
                                            updateAllocation(item.lineId, {
                                              settlementRate: event.target.value,
                                            })
                                          }
                                        />
                                      </div>
                                      <select
                                        className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                                        value={allocs[item.lineId]!.settlementRateSource}
                                        onChange={(event) => {
                                          const source = event.target
                                            .value as AllocationClient["settlementRateSource"];
                                          if (source === "provider") {
                                            const evidence = settlementRates.find(
                                              (rate) => rate.toCurrency === item.currency,
                                            );
                                            updateAllocation(
                                              item.lineId,
                                              evidence
                                                ? {
                                                    settlementRateSource: "provider",
                                                    settlementRate: evidence.rate,
                                                    sourceTransactionAmount: divRate(
                                                      allocs[item.lineId]!.targetTransactionAmount,
                                                      evidence.rate,
                                                    ),
                                                    settlementRateReference: `${evidence.source} · ${evidence.asOf}`,
                                                    settlementFxRateId: evidence.id,
                                                  }
                                                : {
                                                    settlementRateSource: "manual",
                                                    settlementFxRateId: null,
                                                  },
                                            );
                                          } else {
                                            updateAllocation(item.lineId, {
                                              settlementRateSource: source,
                                              settlementFxRateId: null,
                                            });
                                          }
                                        }}
                                      >
                                        <option value="manual">{t("rateSource.manual")}</option>
                                        <option value="contractual">
                                          {t("rateSource.contractual")}
                                        </option>
                                        <option
                                          value="provider"
                                          disabled={
                                            !settlementRates.some(
                                              (rate) => rate.toCurrency === item.currency,
                                            )
                                          }
                                        >
                                          {t("rateSource.provider")}
                                        </option>
                                      </select>
                                      {allocs[item.lineId]!.settlementRateSource === "provider" ? (
                                        <select
                                          className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                                          value={allocs[item.lineId]!.settlementFxRateId ?? ""}
                                          onChange={(event) => {
                                            const evidence = settlementRates.find(
                                              (rate) => rate.id === event.target.value,
                                            );
                                            if (evidence)
                                              updateAllocation(item.lineId, {
                                                settlementRate: evidence.rate,
                                                sourceTransactionAmount: divRate(
                                                  allocs[item.lineId]!.targetTransactionAmount,
                                                  evidence.rate,
                                                ),
                                                settlementRateReference: `${evidence.source} · ${evidence.asOf}`,
                                                settlementFxRateId: evidence.id,
                                              });
                                          }}
                                        >
                                          {settlementRates
                                            .filter((rate) => rate.toCurrency === item.currency)
                                            .map((rate) => (
                                              <option key={rate.id} value={rate.id}>
                                                {rate.asOf} · {rate.rate} · {rate.source}
                                              </option>
                                            ))}
                                        </select>
                                      ) : (
                                        <Input
                                          className="h-8"
                                          value={allocs[item.lineId]!.settlementRateReference}
                                          placeholder={t("rateReferencePlaceholder")}
                                          onChange={(event) =>
                                            updateAllocation(item.lineId, {
                                              settlementRateReference: event.target.value,
                                            })
                                          }
                                        />
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="space-y-1 text-right tabular-nums">
                                  <div>
                                    {money(allocs[item.lineId]!.targetTransactionAmount || "0", {
                                      currency: item.currency,
                                    })}
                                  </div>
                                  {item.currency !== currency ? (
                                    <>
                                      <div className="text-xs text-slate-500 dark:text-slate-400">
                                        {money(
                                          allocs[item.lineId]!.sourceTransactionAmount || "0",
                                          { currency: currency },
                                        )}
                                      </div>
                                      <div className="text-xs text-slate-500 dark:text-slate-400">
                                        {allocs[item.lineId]!.settlementRate} ·{" "}
                                        {t(
                                          `rateSource.${allocs[item.lineId]!.settlementRateSource}`,
                                        )}
                                      </div>
                                      {allocs[item.lineId]!.settlementRateReference ? (
                                        <div className="text-xs text-slate-500 dark:text-slate-400">
                                          {allocs[item.lineId]!.settlementRateReference}
                                        </div>
                                      ) : null}
                                    </>
                                  ) : null}
                                </div>
                              )
                            ) : null}
                          </SharedTableCell>
                        </SharedTableRow>
                      );
                    })}
                  </SharedTableBody>
                </SharedTable>
              </div>
            )}
            {editable && hasInvalidRow ? (
              <p className="text-xs text-red-600 dark:text-red-400">{t("invalidAllocation")}</p>
            ) : null}
            {editable && (receivedInvalid || receivedShort) ? (
              <p className="text-xs text-red-600 dark:text-red-400">{t("receivedShort")}</p>
            ) : editable && cmp(onAccount, "0") > 0 ? (
              <p role="note" className="text-xs text-amber-700 dark:text-amber-300">
                {t("receivedOnAccount", { amount: onAccount, currency: currency })}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            <Label>{t("appliedTo")}</Label>
            {applied.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {doc.status === "voided" ? t("voidedNote") : t("noLiveApplications")}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
                <SharedTable className="w-full text-sm">
                  <SharedTableHeader>
                    <SharedTableRow className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                      <SharedTableHead className="px-3 py-2">
                        {t("columns.document")}
                      </SharedTableHead>
                      <SharedTableHead className="px-3 py-2">{t("columns.due")}</SharedTableHead>
                      <SharedTableHead className="px-3 py-2">
                        {t("columns.appliedOn")}
                      </SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right">
                        {t("columns.original")}
                      </SharedTableHead>
                      <SharedTableHead className="px-3 py-2 text-right">
                        {t("columns.applied")}
                      </SharedTableHead>
                      <SharedTableHead className="px-3 py-2">
                        {t("columns.rateEvidence")}
                      </SharedTableHead>
                    </SharedTableRow>
                  </SharedTableHeader>
                  <SharedTableBody>
                    {applied.map((a) => (
                      <SharedTableRow
                        key={a.id}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                      >
                        <SharedTableCell className="px-3 py-2">
                          <span className="font-mono text-[13px] font-semibold">
                            {a.target_document_number ?? a.target_entry_number}
                          </span>
                          <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                            {kindLabel(a.target_document_kind)}
                            {a.target_reference_number ? ` · ${a.target_reference_number}` : ""}
                          </span>
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-slate-600 dark:text-slate-300">
                          {a.target_due_date ?? "—"}
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-slate-600 dark:text-slate-300">
                          {a.applied_on}
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-right tabular-nums">
                          {money(a.target_transaction_original, {
                            currency: a.target_transaction_currency,
                          })}
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-right font-medium tabular-nums">
                          <div>
                            {money(a.target_transaction_amount, {
                              currency: a.target_transaction_currency,
                            })}
                          </div>
                          {a.source_transaction_currency !== a.target_transaction_currency ? (
                            <div className="text-xs font-normal text-slate-500">
                              {money(a.source_transaction_amount, {
                                currency: a.source_transaction_currency,
                              })}
                            </div>
                          ) : null}
                        </SharedTableCell>
                        <SharedTableCell className="px-3 py-2 text-xs text-slate-500">
                          <div className="font-mono">{a.settlement_rate}</div>
                          <div>{a.settlement_rate_reference}</div>
                        </SharedTableCell>
                      </SharedTableRow>
                    ))}
                  </SharedTableBody>
                </SharedTable>
              </div>
            )}
          </div>
        )}

        {/* Cash this payment moved beyond what it applied stays open for the
            party; it is applied to the party's other documents here, with no
            new cash, and released the same way. */}
        {!createMode && doc.status === "posted" && typeof doc.id === "string" ? (
          <CreditApplicationsPanel
            documentId={doc.id}
            side={side}
            partyId={typeof doc.party_id === "string" ? doc.party_id : null}
            canApply={payment.canApplyUnapplied === true}
            source="payment"
          />
        ) : null}
      </div>
    </TransactionDrawer>
  );
}
