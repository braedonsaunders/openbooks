"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { dateLabel } from "@/lib/format";
import {
  Badge,
  Button,
  Card,
  ContextMenu,
  useContextMenu,
  DisclosureSection,
  Drawer,
  Input,
  Label,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openbooks/ui";
import { PagedTable } from "../../../../components/paged-table";
import { Switch } from "@/components/switch";
import { useMoney } from "../../../../components/money-provider";
import { useBusinessToday } from "../../../../components/business-date-provider";
import { promptDialog } from "@/lib/prompt";
import { useAppAction } from "@/lib/use-app-action";
import { DateField } from "@/components/date-field";
import { JournalEntryLink } from "@/components/journal-entry-link";

const SETTLEMENT_PROVIDERS = [
  "stripe",
  "adyen",
  "gocardless",
  "recurly",
  "chargebee",
  "shopify_payments",
  "paypal",
  "square",
] as const;
const IMPORT_PROVIDERS = [
  "stripe",
  "recurly",
  "chargebee",
  "shopify_payments",
  "paypal",
  "square",
] as const;
const SETTLEMENT_STATUSES = ["draft", "posted", "void"] as const;

type SettlementProvider = (typeof SETTLEMENT_PROVIDERS)[number];
type ImportProvider = (typeof IMPORT_PROVIDERS)[number];
type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * Record-drawer address for a settlement line's document: invoices open the
 * invoice drawer, receipts open the receipt drawer, provider-only lines
 * have no record and stay plain text.
 */
export function settlementDocumentHref(line: {
  documentId: string | null;
  documentKind: string | null;
  documentNumber: string | null;
}): string | null {
  if (!line.documentId || !line.documentNumber) return null;
  if (line.documentKind === "customer_payment")
    return `/receipts?payment=${encodeURIComponent(line.documentId)}`;
  if (line.documentKind === "customer_invoice")
    return `/ar/invoices?doc=${encodeURIComponent(line.documentId)}`;
  if (line.documentKind === "cash_sale")
    return `/cash-sales?doc=${encodeURIComponent(line.documentId)}`;
  return null;
}

/** Line kinds that carry order evidence and accept a document or journal link. Mirrors the engine matchable set. */
const EVIDENCE_LINE_KINDS = new Set(["charge", "refund", "dispute", "dispute_reversal"]);

export interface PspSettlementRow {
  id: string;
  provider: SettlementProvider;
  providerLabel: string;
  externalRef: string;
  settlementDate: string;
  currency: string;
  netAmount: string;
  /** Formatted FX gain/loss, or null when the payout needed no conversion. */
  fxAmount: string | null;
  /** Preformatted dispute badge ("Disputes $45.00"), or null when quiet. */
  disputeBadge: string | null;
  sourceCurrency: string | null;
  statusLabel: string;
  status: "draft" | "posted" | "void";
}

export interface PspSubsidiaryOption {
  id: string;
  name: string;
  baseCurrency: string;
}

/** Chart account offered by the import form's house pickers. The label is
 *  preformatted (`number · name`); the stored value stays the UUID. */
export interface PspAccountOption {
  id: string;
  label: string;
}

const STATUS_MESSAGE: Record<SettlementStatus, "draft" | "posted" | "voided"> = {
  draft: "draft",
  posted: "posted",
  void: "voided",
};

interface SettlementBatch {
  id: string;
  provider: SettlementProvider;
  externalRef: string;
  settlementDate: string;
  currency: string;
  netAmount: string;
  grossAmount: string;
  refundAmount: string;
  disputeAmount: string;
  adjustmentAmount: string;
  fxAmount: string;
  sourceCurrency: string | null;
  status: SettlementStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact zero test for numeric(19,4) totals, which arrive as "0.0000" rather
 *  than "0". Only zero compares — magnitudes format through money(). */
function isZeroAmount(value: string): boolean {
  return Number(value) === 0;
}

function isSettlementBatch(value: unknown): value is SettlementBatch {
  if (!value || typeof value !== "object") return false;
  const batch = value as Record<string, unknown>;
  return (
    typeof batch.id === "string" &&
    SETTLEMENT_PROVIDERS.includes(batch.provider as SettlementProvider) &&
    typeof batch.externalRef === "string" &&
    typeof batch.settlementDate === "string" &&
    typeof batch.currency === "string" &&
    typeof batch.netAmount === "string" &&
    typeof batch.grossAmount === "string" &&
    typeof batch.refundAmount === "string" &&
    typeof batch.disputeAmount === "string" &&
    typeof batch.adjustmentAmount === "string" &&
    typeof batch.fxAmount === "string" &&
    (batch.sourceCurrency === null || typeof batch.sourceCurrency === "string") &&
    SETTLEMENT_STATUSES.includes(batch.status as SettlementStatus)
  );
}

interface SettlementDetailLine {
  id: string | null;
  lineNumber: number;
  kind: string;
  externalRef: string | null;
  description: string | null;
  amount: string;
  currency: string | null;
  documentId: string | null;
  documentKind: string | null;
  documentNumber: string | null;
  journalEntryId: string | null;
  journalEntryNumber: string | null;
}

interface SettlementDetail {
  batch: {
    id: string;
    provider: string;
    externalRef: string;
    status: string;
    currency: string;
    sourceCurrency: string | null;
    conversionRate: string | null;
    conversionRateSource: string | null;
    payoutRate: string | null;
    payoutRateSource: string | null;
    grossAmount: string;
    feeAmount: string;
    refundAmount: string;
    disputeAmount: string;
    adjustmentAmount: string;
    fxAmount: string;
    netAmount: string;
    settlementDate: string;
    bankAccountId: string | null;
    bankAccountLabel: string;
    feeAccountId: string | null;
    feeAccountLabel: string;
    clearingAccountId: string | null;
    clearingAccountLabel: string;
    disputeAccountId: string | null;
    disputeAccountLabel: string;
    fxAccountId: string | null;
    fxAccountLabel: string;
    postingEntityId: string | null;
    postingEntityName: string | null;
    postingBookId: string | null;
    postingBookName: string | null;
    postingBasis: "current" | "recorded";
  };
  lines: SettlementDetailLine[];
}

function isSettlementDetail(value: unknown): value is SettlementDetail {
  if (!isRecord(value)) return false;
  const { batch, lines } = value;
  if (!isRecord(batch) || !Array.isArray(lines)) return false;
  const amounts = [
    "grossAmount",
    "feeAmount",
    "refundAmount",
    "disputeAmount",
    "adjustmentAmount",
    "fxAmount",
    "netAmount",
  ];
  if (
    typeof batch.id !== "string" ||
    typeof batch.externalRef !== "string" ||
    typeof batch.currency !== "string" ||
    typeof batch.settlementDate !== "string" ||
    !SETTLEMENT_STATUSES.includes(batch.status as SettlementStatus) ||
    !amounts.every((key) => typeof batch[key] === "string") ||
    ![
      "bankAccountId",
      "feeAccountId",
      "clearingAccountId",
      "disputeAccountId",
      "fxAccountId",
      "postingEntityId",
      "postingEntityName",
      "postingBookId",
      "postingBookName",
    ].every((key) => batch[key] === null || typeof batch[key] === "string") ||
    ![
      "bankAccountLabel",
      "feeAccountLabel",
      "clearingAccountLabel",
      "disputeAccountLabel",
      "fxAccountLabel",
    ].every((key) => typeof batch[key] === "string") ||
    !["current", "recorded"].includes(String(batch.postingBasis))
  ) {
    return false;
  }
  return lines.every(
    (line) =>
      isRecord(line) &&
      typeof line.lineNumber === "number" &&
      typeof line.kind === "string" &&
      typeof line.amount === "string",
  );
}

function isSubsidiaryOption(value: unknown): value is PspSubsidiaryOption {
  if (!value || typeof value !== "object") return false;
  const option = value as Record<string, unknown>;
  return (
    typeof option.id === "string" &&
    typeof option.name === "string" &&
    typeof option.baseCurrency === "string"
  );
}

async function fetchSettlements(
  signal?: AbortSignal,
): Promise<{ batches: SettlementBatch[]; subsidiaries: PspSubsidiaryOption[] } | null> {
  try {
    const response = await fetch("/api/psp/settlements", { signal });
    if (!response.ok) return null;
    const data = (await response.json()) as { batches?: unknown; subsidiaries?: unknown };
    if (!Array.isArray(data.batches) || !data.batches.every(isSettlementBatch)) return null;
    const subsidiaries = Array.isArray(data.subsidiaries)
      ? data.subsidiaries.filter(isSubsidiaryOption)
      : [];
    return { batches: data.batches, subsidiaries };
  } catch {
    return null;
  }
}

async function fetchSettlementDetail(
  batchId: string,
  signal?: AbortSignal,
): Promise<SettlementDetail | null> {
  try {
    const response = await fetch(`/api/psp/settlements?batchId=${encodeURIComponent(batchId)}`, {
      signal,
    });
    // The refusal names the cause (unknown batch, closed scope); parsing the
    // body first would turn it into a JSON error about nothing.
    if (!response.ok) return null;
    const data = (await response.json()) as unknown;
    return isSettlementDetail(data) ? data : null;
  } catch {
    return null;
  }
}

// Mutations resolve to the server's typed reason on refusal: the previous
// shape discarded the error body, so every 422 read as a generic
// "could not import/post" with the real message only in the network log
// The pinned alert below shows the reason until the next action.
async function requestSettlement<T>(
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string | null }> {
  try {
    const response = await fetch("/api/psp/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (!response.ok) {
      const message = (data as { error?: unknown } | null)?.error;
      return { ok: false, error: typeof message === "string" && message ? message : null };
    }
    return { ok: true, data: (data ?? {}) as T };
  } catch {
    return { ok: false, error: null };
  }
}

/** Import, posting and reversal share one settlement state and native detail drawer. */
export interface PspProviderPullConfig {
  provider: string;
  displayName: string;
  pullEnabled: boolean;
}

export function PspSettlementsWorkspace({
  canReconcile,
  canSetup,
  strings,
  initialRows,
  initialSubsidiaries,
  initialAccounts,
  initialConfigs,
}: {
  /** Loader-resolved banking.reconcile grant: without it the import form
   *  and the post/reverse buttons stay hidden, since every one of those
   *  mutations POSTs with banking.reconcile (F1T-9). */
  canReconcile: boolean;
  strings: {
    acceptanceNote: string;
    acceptanceLink: string;
    importTitle: string;
    providerLabel: string;
    externalRef: string;
    settlementDate: string;
    bankAccountId: string;
    bankAccountHint: string;
    feeAccountId: string;
    feeAccountHint: string;
    clearingAccountId: string;
    clearingAccountHint: string;
    subsidiaryLabel: string;
    noneLabel: string;
    payloadShapeHint: string;
    genericPayloadHint: string;
    accountPlaceholder: string;
    uploadPayload: string;
    invalidStripePayload: string;
    invalidGenericPayload: string;
    importDraft: string;
    recentBatches: string;
    reversalDate: string;
    reversalReason: string;
    reversalPlaceholder: string;
    colProvider: string;
    colNet: string;
    colFx: string;
    filterProviderLabel: string;
    filterAllProviders: string;
    reviewLinkLabel: string;
    reviewsHref: string;
    reviewPending: string | null;
    reverse: string;
    empty: string;
    referenceLabel: string;
    dateLabel: string;
    statusLabel: string;
    postLabel: string;
    loadingLabel: string;
    loadFailedLabel: string;
    retryLabel: string;
  };
  initialRows: PspSettlementRow[] | null;
  initialSubsidiaries?: PspSubsidiaryOption[] | null;
  /** Loader-resolved postable chart accounts for the house pickers. The
   *  stored import value stays the UUID — only the affordance changes. */
  initialAccounts?: PspAccountOption[] | null;
  /** Scheduled-pull toggles for the provider configs, loader-resolved for
   *  unrestricted callers. Flipping one POSTs saveConfig with
   *  admin.setup.manage, so the section stays hidden without canSetup. */
  canSetup?: boolean;
  initialConfigs?: PspProviderPullConfig[] | null;
}) {
  const reversalDateId = useId();
  const reversalReasonId = useId();
  const t = useTranslations("banking.pspSettlements");
  const { runExclusive } = useAppAction();
  // Client-fetched rows (native path, and spec-path reloads after a mutation)
  // format through the same hooks the native page has always used.
  const common = useTranslations("common");
  const locale = useLocale();
  const { money } = useMoney();
  const today = useBusinessToday();
  const [batches, setBatches] = useState<SettlementBatch[]>([]);
  const [subsidiaries, setSubsidiaries] = useState<PspSubsidiaryOption[]>(
    initialSubsidiaries ?? [],
  );
  // House picker options arrive loader-resolved (both render paths); the
  // list reloads batches/subsidiaries after mutations but the chart snapshot
  // stays — a newly created account is validated by name at import.
  const [accounts] = useState<PspAccountOption[]>(initialAccounts ?? []);
  const [provider, setProvider] = useState<ImportProvider>("stripe");
  const [providerFilter, setProviderFilter] = useState<"all" | SettlementProvider>("all");
  const [externalRef, setExternalRef] = useState("");
  const [settlementDate, setSettlementDate] = useState(today);
  const [payload, setPayload] = useState("[]");
  const [bankAccountId, setBankAccountId] = useState("");
  const [feeAccountId, setFeeAccountId] = useState("");
  const [clearingAccountId, setClearingAccountId] = useState("");
  const [subsidiaryId, setSubsidiaryId] = useState("");
  const [fxSourceCurrency, setFxSourceCurrency] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxRateSource, setFxRateSource] = useState("");
  const [fxPayoutRate, setFxPayoutRate] = useState("");
  const [fxPayoutRateSource, setFxPayoutRateSource] = useState("");
  const [reversalDate, setReversalDate] = useState(today);
  const [reversalReason, setReversalReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const recordMenu = useContextMenu();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(initialRows === null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Settlement detail drawer: one shell across loading, content, refusal and
  // retry. The shell stays mounted while a batch is selected; only its body
  // changes, so focus and scroll lock survive resolution and retry.
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SettlementDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [postingBatchId, setPostingBatchId] = useState<string | null>(null);
  // Line-evidence panel: the matchable line under edit. Mutations reload the
  // open detail; totals-changing ones reload the batch list too.
  const [evidenceLineNumber, setEvidenceLineNumber] = useState<number | null>(null);
  // Scheduled-pull toggles (configure depth): the scheduler pulls each
  // enabled provider on the psp_payout_pull scan; the toggle is the only
  // writer of pullEnabled outside the config API.
  const [pullConfigs, setPullConfigs] = useState<PspProviderPullConfig[]>(initialConfigs ?? []);
  const [pullSaving, setPullSaving] = useState<string | null>(null);

  const flipPull = async (provider: string, next: boolean) => {
    setPullSaving(provider);
    const result = await requestSettlement<{ ok: boolean }>({
      action: "saveConfig",
      provider,
      pullEnabled: next,
    });
    setPullSaving(null);
    if (!result.ok) {
      setErr(result.error ?? t("pullFailed"));
      return;
    }
    setPullConfigs((configs) =>
      configs.map((config) =>
        config.provider === provider ? { ...config, pullEnabled: next } : config,
      ),
    );
    setMsg(t("pullSaved"));
  };

  // Adopt provided rows by leaving the loading state, during render (same
  // committed value, no extra render). Transition-based so a manual reload
  // (which sets loading itself) is untouched.
  const [prevInitialRows, setPrevInitialRows] = useState(initialRows);
  if (prevInitialRows !== initialRows) {
    setPrevInitialRows(initialRows);
    if (initialRows !== null) setLoading(false);
  }

  useEffect(() => {
    if (initialRows !== null) return;
    const controller = new AbortController();
    void fetchSettlements(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      if (loaded === null) {
        setLoadFailed(true);
      } else {
        setBatches(loaded.batches);
        setSubsidiaries(loaded.subsidiaries);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [initialRows]);

  // The open and retry handlers reset the detail state; the effect only
  // resolves the fetch, so no synchronous set-state lives in the effect.
  const openSettlementDetail = (batchId: string) => {
    if (postingBatchId !== null) return;
    setErr(null);
    setMsg(null);
    setDetail(null);
    setDetailFailed(false);
    setDetailLoading(true);
    setEvidenceLineNumber(null);
    setReversing(false);
    setReversalReason("");
    recordMenu.close();
    setSelectedBatchId(batchId);
  };

  useEffect(() => {
    if (selectedBatchId === null) return;
    const controller = new AbortController();
    void fetchSettlementDetail(selectedBatchId, controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      if (loaded === null) {
        setDetailFailed(true);
      } else {
        setDetail(loaded);
      }
      setDetailLoading(false);
    });
    return () => controller.abort();
  }, [selectedBatchId]);

  const load = async () => {
    setLoading(true);
    setLoadFailed(false);
    const loaded = await fetchSettlements();
    if (loaded === null) {
      setLoadFailed(true);
    } else {
      setBatches(loaded.batches);
      setSubsidiaries(loaded.subsidiaries);
      // A subsidiary the picker offered can leave scope between loads; never
      // hold a selection the list no longer contains.
      if (subsidiaryId && !loaded.subsidiaries.some((s) => s.id === subsidiaryId)) {
        setSubsidiaryId("");
      }
    }
    setLoading(false);
  };

  // Multi-entity orgs must name the posting entity before the draft exists:
  // an unnamed draft used to strand at Post with a refusal that blamed the
  // accounts the import already carried. Single-entity orgs get
  // no options and post to the root like every other document.
  const needsSubsidiaryChoice = subsidiaries.length > 0;

  // Pasted-or-uploaded payloads fail fast on shape, before the POST. Each
  // provider settles a different envelope: Stripe a JSON array of balance
  // transactions, Shopify one object with payout and transactions, PayPal an
  // export object or raw CSV text, Square one object with payout and entries.
  // The server re-validates authoritatively.
  function payloadShapeError(parsed: unknown, isCsv: boolean): string | null {
    if (provider === "stripe") {
      return Array.isArray(parsed) ? null : strings.invalidStripePayload;
    }
    if (provider === "shopify_payments") {
      return isRecord(parsed) &&
        isRecord(parsed.payout) &&
        Array.isArray(parsed.transactions) &&
        parsed.transactions.length > 0
        ? null
        : t("invalidShopifyPayload");
    }
    if (provider === "square") {
      return isRecord(parsed) &&
        isRecord(parsed.payout) &&
        Array.isArray(parsed.entries) &&
        parsed.entries.length > 0
        ? null
        : t("invalidSquarePayload");
    }
    if (provider === "paypal") {
      if (isCsv) return null;
      return isRecord(parsed) &&
        Array.isArray(parsed.transactions) &&
        parsed.transactions.length > 0
        ? null
        : strings.invalidGenericPayload;
    }
    return isRecord(parsed) ? null : strings.invalidGenericPayload;
  }

  // Foreign-currency evidence is all-or-nothing per rate: a payout currency
  // without its provider rate (or the reverse) would post at an assumed
  // conversion. The refusal names the missing fields; the server names its
  // own when the evidence arrives incomplete another way.
  function fxEvidenceError(): string | null {
    const trio = [fxSourceCurrency.trim(), fxRate.trim(), fxRateSource.trim()];
    const trioSet = trio.filter((value) => value !== "");
    if (trioSet.length > 0 && trioSet.length < 3) return t("fxIncomplete");
    const pair = [fxPayoutRate.trim(), fxPayoutRateSource.trim()].filter((value) => value !== "");
    if (pair.length === 1) return t("fxIncomplete");
    return null;
  }

  const importBatch = async () => {
    setErr(null);
    setMsg(null);
    const fxError = fxEvidenceError();
    if (fxError) {
      setErr(fxError);
      return;
    }
    let parsed: unknown = null;
    let isCsv = false;
    const text = payload.trim();
    if (provider === "paypal" && !(text.startsWith("{") || text.startsWith("["))) {
      // PayPal settlement reports paste as CSV, not JSON: no parse, the
      // report text is the evidence.
      isCsv = true;
    } else {
      try {
        parsed = JSON.parse(payload);
      } catch {
        setErr(t("invalidJson"));
        return;
      }
    }
    const shapeError = payloadShapeError(parsed, isCsv);
    if (shapeError) {
      setErr(shapeError);
      return;
    }
    const body: Record<string, unknown> = {
      action: "import",
      provider,
      externalRef,
      settlementDate,
      bankAccountId: bankAccountId || undefined,
      feeAccountId: feeAccountId || undefined,
      clearingAccountId: clearingAccountId || undefined,
      subsidiaryId: subsidiaryId || undefined,
    };
    if (provider === "stripe") {
      body.transactions = parsed;
      body.payoutId = externalRef;
    } else if (provider === "shopify_payments" && isRecord(parsed)) {
      body.payout = parsed.payout;
      body.transactions = parsed.transactions;
    } else if (provider === "square" && isRecord(parsed)) {
      body.payout = parsed.payout;
      body.entries = parsed.entries;
    } else if (provider === "paypal") {
      if (isCsv) {
        body.csv = payload;
      } else if (isRecord(parsed)) {
        // The Transaction Search export nests rows under several keys across
        // API versions; item-level `transaction_info` wins when present.
        const rows = Array.isArray(parsed.transactions)
          ? parsed.transactions
          : Array.isArray(parsed.transaction_details)
            ? parsed.transaction_details
            : [];
        body.payload = {
          transactions: (rows as unknown[]).map((row) =>
            isRecord(row) && "transaction_info" in row ? row : { transaction_info: row },
          ),
        };
      }
    } else {
      body.payload = parsed;
    }
    if (fxSourceCurrency.trim() !== "") {
      body.fx = {
        sourceCurrency: fxSourceCurrency.trim(),
        rate: fxRate.trim(),
        rateSource: fxRateSource.trim(),
        payoutRate: fxPayoutRate.trim() || undefined,
        payoutRateSource: fxPayoutRateSource.trim() || undefined,
      };
    }
    const d = await requestSettlement<{ batchId?: string }>(body);
    if (!d.ok || typeof d.data.batchId !== "string") {
      setErr(!d.ok && d.error ? d.error : t("importFailed"));
      return;
    }
    setMsg(t("importedToast", { id: d.data.batchId }));
    void load();
  };

  const post = runExclusive(async (batchId: string) => {
    setErr(null);
    setMsg(null);
    if (postingBatchId !== null) return;
    setPostingBatchId(batchId);
    try {
      const d = await requestSettlement<{ entryId?: string }>({ action: "post", batchId });
      if (!d.ok || typeof d.data.entryId !== "string") {
        setErr(!d.ok && d.error ? d.error : t("postFailed"));
        return;
      }
      setMsg(t("postedToast", { id: d.data.entryId }));
      await reloadDetail(true);
    } finally {
      setPostingBatchId(null);
    }
  });

  const reverse = async (batchId: string) => {
    setErr(null);
    if (reversalReason.trim().length < 5) {
      setErr(t("reasonTooShort"));
      return;
    }
    const d = await requestSettlement<{ entryId?: string }>({
      action: "reverse",
      batchId,
      reversalDate,
      reason: reversalReason,
    });
    if (!d.ok || typeof d.data.entryId !== "string") {
      setErr(!d.ok && d.error ? d.error : t("reversalFailed"));
      return;
    }
    setMsg(t("reversedToast", { id: d.data.entryId }));
    setReversalReason("");
    setReversing(false);
    await reloadDetail(true);
  };

  // Deleting an unposted draft frees its provider reference for a corrected
  // reimport. The reason is mandatory and audited; posted history refuses
  // and unwinds only through reversal.
  const removeDraft = async (batchId: string) => {
    setErr(null);
    setMsg(null);
    const reason = await promptDialog({
      title: t("deleteDraftTitle"),
      label: t("deleteDraftReason"),
      confirmLabel: t("deleteDraft"),
      cancelLabel: common("actions.cancel"),
    });
    if (reason === null) return;
    const d = await requestSettlement<{ batchId?: string }>({
      action: "deleteDraft",
      batchId,
      reason,
    });
    if (!d.ok || typeof d.data.batchId !== "string") {
      setErr(!d.ok && d.error ? d.error : t("reversalFailed"));
      return;
    }
    setMsg(t("deletedToast"));
    if (selectedBatchId === batchId) {
      setSelectedBatchId(null);
      setDetail(null);
      setEvidenceLineNumber(null);
    }
    void load();
  };

  const reloadDetail = async (reloadList: boolean) => {
    if (selectedBatchId) {
      const loaded = await fetchSettlementDetail(selectedBatchId);
      setDetail(loaded);
      setDetailFailed(loaded === null);
    }
    if (reloadList) void load();
  };

  const settlementDateLabel = (value: string) => dateLabel(new Date(`${value}T12:00:00Z`), locale);
  const providerLabel = (value: SettlementProvider) => t(`providers.${value}`);
  const statusLabel = (value: SettlementStatus) => common(`status.${STATUS_MESSAGE[value]}`);

  const listed: {
    id: string;
    provider: SettlementProvider;
    providerName: string;
    externalRef: string;
    date: string;
    net: string;
    fx: string | null;
    disputeBadge: string | null;
    status: string;
    rawStatus: SettlementStatus;
  }[] =
    loading || loadFailed
      ? []
      : initialRows !== null && batches.length === 0
        ? initialRows.map((b) => ({
            id: b.id,
            provider: b.provider,
            providerName: b.providerLabel,
            externalRef: b.externalRef,
            date: b.settlementDate,
            net: b.netAmount,
            fx: b.fxAmount,
            disputeBadge: b.disputeBadge,
            status: b.statusLabel,
            rawStatus: b.status,
          }))
        : batches.map((b) => ({
            id: b.id,
            provider: b.provider,
            providerName: providerLabel(b.provider),
            externalRef: b.externalRef,
            date: settlementDateLabel(b.settlementDate),
            net: money(b.netAmount, { currency: b.currency }),
            fx: isZeroAmount(b.fxAmount) ? null : money(b.fxAmount, { currency: b.currency }),
            disputeBadge: isZeroAmount(b.disputeAmount)
              ? null
              : t("disputeBadge", { amount: money(b.disputeAmount, { currency: b.currency }) }),
            status: statusLabel(b.status),
            rawStatus: b.status,
          }));
  const visible =
    providerFilter === "all" ? listed : listed.filter((b) => b.provider === providerFilter);

  const payloadLabel =
    provider === "stripe"
      ? t("stripePayloadLabel")
      : provider === "shopify_payments"
        ? t("shopifyPayloadLabel")
        : provider === "paypal"
          ? t("paypalPayloadLabel")
          : provider === "square"
            ? t("squarePayloadLabel")
            : t("genericPayloadLabel");
  const payloadHint =
    provider === "stripe"
      ? strings.payloadShapeHint
      : provider === "shopify_payments"
        ? t("shopifyPayloadHint")
        : provider === "paypal"
          ? t("paypalPayloadHint")
          : provider === "square"
            ? t("squarePayloadHint")
            : strings.genericPayloadHint;
  const fxSummary =
    fxSourceCurrency.trim() !== "" && fxRate.trim() !== ""
      ? `${fxSourceCurrency.trim()} @ ${fxRate.trim()}`
      : t("fxNone");
  // Half-entered evidence must not hide behind the collapsed section: the
  // disclosure forces itself open while the trio is incomplete.
  const fxForceOpen = fxEvidenceError() !== null;

  return (
    <>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {strings.acceptanceNote}{" "}
        <Link
          href="/admin/setup/payment-providers"
          className="text-teal-700 hover:underline dark:text-teal-300"
        >
          {strings.acceptanceLink}
        </Link>
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        <Link
          href={strings.reviewsHref}
          className="text-teal-700 hover:underline dark:text-teal-300"
        >
          {strings.reviewLinkLabel}
        </Link>
        {strings.reviewPending ? <span className="ml-2">{strings.reviewPending}</span> : null}
      </p>
      {err && (
        <p role="alert" className="text-sm text-red-600">
          {err}
        </p>
      )}
      {msg && (
        <p aria-live="polite" className="text-sm text-teal-700 dark:text-teal-300">
          {msg}
        </p>
      )}

      {canReconcile && (
        <Card className="space-y-3 p-4">
          <h3 className="text-sm font-semibold">{strings.importTitle}</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="psp-provider">{strings.providerLabel}</Label>
              <Select
                id="psp-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value as ImportProvider)}
              >
                {IMPORT_PROVIDERS.map((key) => (
                  <option key={key} value={key}>
                    {t(`providers.${key}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="psp-external-ref">{strings.externalRef}</Label>
              <Input
                id="psp-external-ref"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="psp-settlement-date">{strings.settlementDate}</Label>
              <DateField
                id="psp-settlement-date"
                value={settlementDate}
                onChange={(value) => setSettlementDate(value)}
              />
            </div>
            <div>
              <Label htmlFor="psp-bank-account">{strings.bankAccountId}</Label>
              <SearchSelect
                id="psp-bank-account"
                options={accounts.map((a) => ({ value: a.id, label: a.label }))}
                value={bankAccountId}
                onChange={(v) => setBankAccountId(v ?? "")}
                placeholder={strings.accountPlaceholder}
                clearable
                emptyLabel={strings.noneLabel}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {strings.bankAccountHint}
              </p>
            </div>
            <div>
              <Label htmlFor="psp-fee-account">{strings.feeAccountId}</Label>
              <SearchSelect
                id="psp-fee-account"
                options={accounts.map((a) => ({ value: a.id, label: a.label }))}
                value={feeAccountId}
                onChange={(v) => setFeeAccountId(v ?? "")}
                placeholder={strings.accountPlaceholder}
                clearable
                emptyLabel={strings.noneLabel}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {strings.feeAccountHint}
              </p>
            </div>
            <div>
              <Label htmlFor="psp-clearing-account">{strings.clearingAccountId}</Label>
              <SearchSelect
                id="psp-clearing-account"
                options={accounts.map((a) => ({ value: a.id, label: a.label }))}
                value={clearingAccountId}
                onChange={(v) => setClearingAccountId(v ?? "")}
                placeholder={strings.accountPlaceholder}
                clearable
                emptyLabel={strings.noneLabel}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {strings.clearingAccountHint}
              </p>
            </div>
            {needsSubsidiaryChoice && (
              <div>
                <Label htmlFor="psp-subsidiary">{strings.subsidiaryLabel}</Label>
                <Select
                  id="psp-subsidiary"
                  value={subsidiaryId}
                  onChange={(e) => setSubsidiaryId(e.target.value)}
                >
                  <option value="">{strings.noneLabel}</option>
                  {subsidiaries.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.baseCurrency})
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
          <DisclosureSection title={t("fxTitle")} summary={fxSummary} forceOpen={fxForceOpen}>
            <div className="grid gap-3 pt-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="psp-fx-currency">{t("fxSourceCurrency")}</Label>
                <Input
                  id="psp-fx-currency"
                  value={fxSourceCurrency}
                  onChange={(e) => setFxSourceCurrency(e.target.value.toUpperCase())}
                  placeholder="EUR"
                  maxLength={3}
                />
              </div>
              <div>
                <Label htmlFor="psp-fx-rate">{t("fxRate")}</Label>
                <Input
                  id="psp-fx-rate"
                  value={fxRate}
                  onChange={(e) => setFxRate(e.target.value)}
                  placeholder="1.0842"
                  inputMode="decimal"
                />
              </div>
              <div>
                <Label htmlFor="psp-fx-rate-source">{t("fxRateSource")}</Label>
                <Input
                  id="psp-fx-rate-source"
                  value={fxRateSource}
                  onChange={(e) => setFxRateSource(e.target.value)}
                  placeholder={t("fxRateHint")}
                />
              </div>
              <div>
                <Label htmlFor="psp-fx-payout-rate">{t("fxPayoutRate")}</Label>
                <Input
                  id="psp-fx-payout-rate"
                  value={fxPayoutRate}
                  onChange={(e) => setFxPayoutRate(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="psp-fx-payout-rate-source">{t("fxPayoutRateSource")}</Label>
                <Input
                  id="psp-fx-payout-rate-source"
                  value={fxPayoutRateSource}
                  onChange={(e) => setFxPayoutRateSource(e.target.value)}
                />
              </div>
            </div>
          </DisclosureSection>
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="psp-payload">{payloadLabel}</Label>
              <label className="cursor-pointer text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
                {provider === "paypal" ? t("csvUpload") : strings.uploadPayload}
                <input
                  type="file"
                  accept={
                    provider === "paypal"
                      ? ".csv,.json,application/json,text/csv"
                      : "application/json,.json"
                  }
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text().then((text) => setPayload(text));
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <textarea
              id="psp-payload"
              className="mt-1 min-h-32 w-full rounded border p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{payloadHint}</p>
          </div>
          <Button
            size="sm"
            disabled={!externalRef || (needsSubsidiaryChoice && !subsidiaryId)}
            onClick={() => void importBatch()}
          >
            {strings.importDraft}
          </Button>
        </Card>
      )}

      {canSetup && pullConfigs.length > 0 && (
        <DisclosureSection title={t("pullTitle")} summary={t("pullSummary")} forceOpen={false}>
          <ul className="space-y-2 pt-1">
            {pullConfigs.map((config) => (
              <li key={config.provider} className="flex items-center gap-2 text-sm">
                <Switch
                  on={config.pullEnabled}
                  disabled={pullSaving !== null}
                  onToggle={() => void flipPull(config.provider, !config.pullEnabled)}
                  label={config.displayName}
                />
                <span className="font-medium">{config.displayName}</span>
                <span className="text-slate-500 dark:text-slate-400">{t("pullHint")}</span>
              </li>
            ))}
          </ul>
        </DisclosureSection>
      )}

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-sm font-semibold">{strings.recentBatches}</h3>
          <div className="flex items-center gap-2">
            <Label htmlFor="psp-provider-filter">{strings.filterProviderLabel}</Label>
            <Select
              id="psp-provider-filter"
              name="psp-provider-filter"
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value as "all" | SettlementProvider)}
            >
              <option value="all">{strings.filterAllProviders}</option>
              {SETTLEMENT_PROVIDERS.map((key) => (
                <option key={key} value={key}>
                  {t(`providers.${key}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {loading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{strings.loadingLabel}</p>
        ) : loadFailed ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <p>{strings.loadFailedLabel}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
              {strings.retryLabel}
            </Button>
          </div>
        ) : (
          <PagedTable
            source="banking_psp_settlement_batches"
            rows={visible}
            rowKey={(row) => row.id}
            searchable
            empty={strings.empty}
            columns={[
              {
                key: "provider",
                header: strings.colProvider,
                cell: (b) => b.providerName,
                search: (b) => b.providerName,
              },
              {
                key: "reference",
                header: strings.referenceLabel,
                cell: (b) => (
                  <button
                    type="button"
                    className="font-mono text-xs text-teal-700 hover:underline dark:text-teal-300"
                    onClick={() => openSettlementDetail(b.id)}
                  >
                    {b.externalRef}
                  </button>
                ),
                search: (b) => b.externalRef,
              },
              {
                key: "date",
                header: strings.dateLabel,
                cell: (b) => b.date,
                search: (b) => b.date,
              },
              {
                key: "net",
                header: strings.colNet,
                align: "right",
                className: "tabular-nums",
                cell: (b) => b.net,
                search: (b) => b.net,
              },
              {
                key: "fx",
                header: strings.colFx,
                align: "right",
                className: "tabular-nums",
                cell: (b) => b.fx ?? "—",
                search: (b) => b.fx ?? "",
              },
              {
                key: "status",
                header: strings.statusLabel,
                cell: (b) => (
                  <span className="inline-flex flex-col items-start gap-1">
                    {b.status}
                    {b.disputeBadge ? <Badge variant="warning">{b.disputeBadge}</Badge> : null}
                  </span>
                ),
                search: (b) => `${b.status} ${b.disputeBadge ?? ""}`,
              },
            ]}
          />
        )}
      </Card>

      <Drawer
        open={selectedBatchId !== null}
        onClose={() => {
          if (postingBatchId === null) setSelectedBatchId(null);
        }}
        size="lg"
        headerActions={
          detail && !detailLoading && !detailFailed && canReconcile ? (
            <div className="flex items-center gap-2">
              {detail.batch.status === "draft" ? (
                <Button
                  disabled={postingBatchId !== null}
                  onClick={() => void post(detail.batch.id)}
                >
                  {postingBatchId === detail.batch.id ? strings.loadingLabel : strings.postLabel}
                </Button>
              ) : null}
              {detail.batch.status === "draft" || detail.batch.status === "posted" ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-haspopup="menu"
                  aria-expanded={recordMenu.open}
                  onClick={(event) => recordMenu.openBelow(event.currentTarget)}
                >
                  {common("labels.actions")}
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
        title={detail ? t("detailTitle", { ref: detail.batch.externalRef }) : strings.recentBatches}
      >
        {detailLoading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{strings.loadingLabel}</p>
        ) : detailFailed || !detail ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <p>{strings.loadFailedLabel}</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => {
                // Same batch, so the selection effect would not re-run: retry
                // fetches directly under the still-mounted shell.
                if (!selectedBatchId) return;
                const id = selectedBatchId;
                setDetailFailed(false);
                setDetailLoading(true);
                void fetchSettlementDetail(id).then((loaded) => {
                  if (loaded === null) {
                    setDetailFailed(true);
                  } else {
                    setDetail(loaded);
                  }
                  setDetailLoading(false);
                });
              }}
            >
              {strings.retryLabel}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {err ? (
              <p role="alert" className="text-sm text-red-600">
                {err}
              </p>
            ) : null}
            {msg ? (
              <p aria-live="polite" className="text-sm text-teal-700 dark:text-teal-300">
                {msg}
              </p>
            ) : null}
            <ContextMenu
              open={recordMenu.open}
              position={recordMenu.position}
              onClose={recordMenu.close}
              items={
                canReconcile
                  ? detail.batch.status === "draft"
                    ? [
                        {
                          key: "delete",
                          label: t("deleteDraft"),
                          danger: true,
                          disabled: postingBatchId !== null,
                          onSelect: () => void removeDraft(detail.batch.id),
                        },
                      ]
                    : detail.batch.status === "posted"
                      ? [
                          {
                            key: "reverse",
                            label: strings.reverse,
                            disabled: postingBatchId !== null,
                            onSelect: () => setReversing(true),
                          },
                        ]
                      : []
                  : []
              }
            />
            {reversing && canReconcile && detail.batch.status === "posted" ? (
              <div className="space-y-3 rounded-md border p-3">
                <div className="mb-4 grid gap-3 sm:grid-cols-[12rem_1fr]">
                  <div>
                    <Label htmlFor={reversalDateId}>{strings.reversalDate}</Label>
                    <DateField
                      id={reversalDateId}
                      value={reversalDate}
                      onChange={(value) => setReversalDate(value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor={reversalReasonId}>{strings.reversalReason}</Label>
                    <Input
                      id={reversalReasonId}
                      value={reversalReason}
                      onChange={(e) => setReversalReason(e.target.value)}
                      placeholder={strings.reversalPlaceholder}
                      maxLength={500}
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setReversing(false)}>
                    {common("actions.cancel")}
                  </Button>
                  <Button
                    disabled={reversalReason.trim().length < 5}
                    onClick={() => void reverse(detail.batch.id)}
                  >
                    {strings.reverse}
                  </Button>
                </div>
              </div>
            ) : null}
            <SettlementDetailBody
              detail={detail}
              money={money}
              t={t}
              common={common}
              canReconcile={canReconcile}
              onEvidence={(line) => setEvidenceLineNumber(line.lineNumber)}
            />
            {canReconcile ? (
              <BatchJournalPanel
                batchId={detail.batch.id}
                batchStatus={detail.batch.status}
                t={t}
                onChanged={reloadDetail}
              />
            ) : null}
            {(() => {
              const line =
                evidenceLineNumber === null
                  ? undefined
                  : detail.lines.find((item) => item.lineNumber === evidenceLineNumber);
              return line ? (
                <LineEvidencePanel
                  batchId={detail.batch.id}
                  batchStatus={detail.batch.status}
                  line={line}
                  t={t}
                  common={common}
                  onChanged={reloadDetail}
                  onClose={() => setEvidenceLineNumber(null)}
                />
              ) : null;
            })()}
          </div>
        )}
      </Drawer>
    </>
  );
}

interface EvidenceDocOption {
  id: string;
  kind: string;
  documentNumber: string;
  total: string;
  currency: string;
  documentDate: string;
}

interface EvidenceEntryOption {
  id: string;
  entryNumber: string;
  postingDate: string;
}

function isEvidenceDocOption(value: unknown): value is EvidenceDocOption {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.documentNumber === "string"
  );
}

function isEvidenceEntryOption(value: unknown): value is EvidenceEntryOption {
  return isRecord(value) && typeof value.id === "string" && typeof value.entryNumber === "string";
}

/**
 * Matching evidence for one settlement line: link the posted sales document
 * the line settles, or mark the line as recognised by the posted journal
 * entry that books the sale. Both are audited matching evidence — the money
 * stays exactly as posted — and both satisfy the period-close payout gate.
 */
function LineEvidencePanel({
  batchId,
  batchStatus,
  line,
  t,
  common,
  onChanged,
  onClose,
}: {
  batchId: string;
  batchStatus: string;
  line: SettlementDetailLine;
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
  onChanged: (reloadList: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [docQuery, setDocQuery] = useState("");
  const [docResults, setDocResults] = useState<EvidenceDocOption[]>([]);
  const [docSearched, setDocSearched] = useState(false);
  const [entryQuery, setEntryQuery] = useState("");
  const [entryResults, setEntryResults] = useState<EvidenceEntryOption[]>([]);
  const [entrySearched, setEntrySearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (kind: "doc" | "entry") => {
    const query = (kind === "doc" ? docQuery : entryQuery).trim();
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      const param = kind === "doc" ? "resolveDoc" : "resolveEntry";
      const response = await fetch(`/api/psp/settlements?${param}=${encodeURIComponent(query)}`);
      if (!response.ok) {
        setError(t("evidenceFailed"));
        return;
      }
      const data = (await response.json()) as unknown;
      if (kind === "doc") {
        const docs = (data as { documents?: unknown }).documents;
        setDocResults(Array.isArray(docs) ? docs.filter(isEvidenceDocOption) : []);
        setDocSearched(true);
      } else {
        const entries = (data as { entries?: unknown }).entries;
        setEntryResults(Array.isArray(entries) ? entries.filter(isEvidenceEntryOption) : []);
        setEntrySearched(true);
      }
    } catch {
      setError(t("evidenceFailed"));
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (body: Record<string, unknown>, reloadList: boolean) => {
    if (!line.id) return;
    setBusy(true);
    setError(null);
    const result = await requestSettlement({ ...body, batchId, lineId: line.id });
    if (!result.ok) {
      setError(result.error ?? t("evidenceFailed"));
    } else {
      await onChanged(reloadList);
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          {t("evidenceTitle")} · {line.externalRef ?? `#${line.lineNumber}`}
        </h4>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {common("actions.close")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-52 flex-1"
          value={docQuery}
          onChange={(e) => setDocQuery(e.target.value)}
          placeholder={t("evidenceSearchDocs")}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !docQuery.trim()}
          onClick={() => void search("doc")}
        >
          {common("actions.search")}
        </Button>
      </div>
      {docResults.length > 0 ? (
        <ul className="space-y-1">
          {docResults.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-mono">
                {doc.documentNumber} · {doc.total} {doc.currency}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void mutate({ action: "link", documentId: doc.id }, false)}
              >
                {t("evidenceLink")}
              </Button>
            </li>
          ))}
        </ul>
      ) : docSearched ? (
        <p className="text-sm text-slate-500">{t("evidenceNoResults")}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-52 flex-1"
          value={entryQuery}
          onChange={(e) => setEntryQuery(e.target.value)}
          placeholder={t("evidenceSearchJournals")}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !entryQuery.trim()}
          onClick={() => void search("entry")}
        >
          {common("actions.search")}
        </Button>
      </div>
      {entryResults.length > 0 ? (
        <ul className="space-y-1">
          {entryResults.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span className="font-mono">{entry.entryNumber}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void mutate({ action: "markJournal", journalEntryId: entry.id }, false)
                }
              >
                {t("evidenceMarkJournal")}
              </Button>
            </li>
          ))}
        </ul>
      ) : entrySearched ? (
        <p className="text-sm text-slate-500">{t("evidenceNoResults")}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {line.documentId ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void mutate({ action: "unlink" }, false)}
          >
            {t("evidenceUnlink")}
          </Button>
        ) : null}
        {line.journalEntryId ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void mutate({ action: "unmarkJournal" }, false)}
          >
            {t("evidenceUnmarkJournal")}
          </Button>
        ) : null}
        {batchStatus === "draft" && !line.documentId && !line.journalEntryId ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void mutate({ action: "markAdjustment" }, true)}
          >
            {t("evidenceMarkAdjustment")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface BatchJournalCandidate {
  id: string;
  number: string;
  postingDate: string;
  revenueTotal: string;
}

interface BatchJournalSuggestion {
  chargeTotal: string;
  currency: string;
  excludedOtherCurrencyLines: number;
  candidates: BatchJournalCandidate[];
}

function isBatchJournalCandidate(value: unknown): value is BatchJournalCandidate {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.number === "string" &&
    typeof value.postingDate === "string" &&
    typeof value.revenueTotal === "string"
  );
}

/**
 * Batch-level sales recognition for a posted payout: one journal evidences
 * every unmatched charge line, so a high-volume December clears in one
 * audited action instead of hundreds. The suggestion proposes the posted
 * journal whose revenue lines total exactly the batch's charges — the
 * operator confirms per candidate, and the reversal lifts only batch-set
 * markers until the payout period closes.
 */
function BatchJournalPanel({
  batchId,
  batchStatus,
  t,
  onChanged,
}: {
  batchId: string;
  batchStatus: string;
  t: ReturnType<typeof useTranslations>;
  onChanged: (reloadList: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<BatchJournalSuggestion | null>(null);
  const [searched, setSearched] = useState(false);

  if (batchStatus !== "posted") return null;

  const suggest = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/psp/settlements?suggestJournal=${encodeURIComponent(batchId)}`,
      );
      // Check the status before parsing: the refusal names the cause, and
      // parsing an error body first turns it into a JSON error about nothing.
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(
          typeof data?.error === "string" && data.error ? data.error : t("batchJournalFailed"),
        );
        return;
      }
      const data = (await response.json().catch(() => null)) as {
        chargeTotal?: unknown;
        currency?: unknown;
        excludedOtherCurrencyLines?: unknown;
        candidates?: unknown;
      } | null;
      if (!data || typeof data.chargeTotal !== "string" || !Array.isArray(data.candidates)) {
        setError(t("batchJournalFailed"));
        return;
      }
      setSuggestion({
        chargeTotal: data.chargeTotal,
        currency: typeof data.currency === "string" ? data.currency : "",
        excludedOtherCurrencyLines:
          typeof data.excludedOtherCurrencyLines === "number" ? data.excludedOtherCurrencyLines : 0,
        candidates: data.candidates.filter(isBatchJournalCandidate),
      });
      setSearched(true);
    } catch {
      setError(t("batchJournalFailed"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (journalEntryId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await requestSettlement<{
      marked?: unknown;
      skippedLinked?: unknown;
      skippedMarked?: unknown;
      journalEntryNumber?: unknown;
    }>({
      action: "markBatchJournal",
      batchId,
      journalEntryId,
    });
    if (!result.ok) {
      setError(result.error ?? t("batchJournalFailed"));
    } else {
      const marked = typeof result.data.marked === "number" ? result.data.marked : 0;
      const skipped =
        (typeof result.data.skippedLinked === "number" ? result.data.skippedLinked : 0) +
        (typeof result.data.skippedMarked === "number" ? result.data.skippedMarked : 0);
      const number =
        typeof result.data.journalEntryNumber === "string" ? result.data.journalEntryNumber : "";
      setNotice(t("batchJournalMarked", { marked, total: marked + skipped, number }));
      setSuggestion(null);
      setSearched(false);
      await onChanged(false);
    }
    setBusy(false);
  };

  const reverse = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await requestSettlement<{ cleared?: unknown }>({
      action: "unmarkBatchJournal",
      batchId,
    });
    if (!result.ok) {
      // No batch recognition, or a closed payout period: the refusal names
      // the cause and stays pinned until the next action.
      setError(result.error ?? t("batchJournalFailed"));
    } else {
      setSuggestion(null);
      setSearched(false);
      await onChanged(false);
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t("batchJournalTitle")}</h4>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void reverse()}>
            {t("batchJournalReverse")}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void suggest()}>
            {t("batchJournalSuggest")}
          </Button>
        </div>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("batchJournalHint")}</p>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
      {suggestion ? (
        suggestion.candidates.length > 0 ? (
          <ul className="space-y-1">
            {suggestion.candidates.map((candidate) => (
              <li
                key={candidate.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="font-mono">
                  {candidate.number} · {candidate.revenueTotal} {suggestion.currency} ·{" "}
                  {candidate.postingDate}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void confirm(candidate.id)}
                >
                  {t("batchJournalConfirm")}
                </Button>
              </li>
            ))}
          </ul>
        ) : searched ? (
          <p className="text-sm text-slate-500">{t("batchJournalNoCandidates")}</p>
        ) : null
      ) : null}
    </div>
  );
}

function SettlementDetailBody({
  detail,
  money,
  t,
  common,
  canReconcile,
  onEvidence,
}: {
  detail: SettlementDetail;
  money: (value: string, options?: { currency?: string }) => string;
  t: ReturnType<typeof useTranslations>;
  common: ReturnType<typeof useTranslations>;
  canReconcile: boolean;
  onEvidence: (line: SettlementDetailLine) => void;
}) {
  const { batch, lines } = detail;
  const locale = useLocale();
  const currency = batch.currency;
  const totals: [string, string][] = [
    [t("detailGross"), money(batch.grossAmount, { currency })],
    [t("detailFees"), money(batch.feeAmount, { currency })],
    [t("detailRefunds"), money(batch.refundAmount, { currency })],
    [t("detailDisputes"), money(batch.disputeAmount, { currency })],
    [t("detailAdjustments"), money(batch.adjustmentAmount, { currency })],
    [t("detailFx"), money(batch.fxAmount, { currency })],
    [t("detailNet"), money(batch.netAmount, { currency })],
  ];
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h4 className="text-sm font-semibold">{t("postingConfiguration")}</h4>
        <p className="text-xs text-muted-foreground">
          {t(
            batch.postingBasis === "current"
              ? "postingConfigurationCurrent"
              : "postingConfigurationRecorded",
          )}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {(
            [
              [common("labels.subsidiary"), batch.postingEntityName],
              [t("postingBook"), batch.postingBookName],
              [
                t("settlementDate"),
                dateLabel(new Date(`${batch.settlementDate}T12:00:00Z`), locale),
              ],
              [t("postingCurrency"), batch.currency],
              [t("postingBankAccount"), batch.bankAccountLabel],
              [t("feeAccountId"), batch.feeAccountLabel],
              [t("clearingAccountId"), batch.clearingAccountLabel],
              ...(batch.disputeAccountId
                ? [[t("postingDisputeAccount"), batch.disputeAccountLabel]]
                : []),
              ...(batch.fxAccountId ? [[t("postingFxAccount"), batch.fxAccountLabel]] : []),
            ] as [string, string | null][]
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd>{value || t("postingNotConfigured")}</dd>
            </div>
          ))}
        </dl>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        {totals.map(([label, value], index) => (
          <div key={label} className={index === totals.length - 1 ? "font-semibold" : undefined}>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {batch.sourceCurrency ? (
        <div className="space-y-1 text-sm">
          <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {t("detailRateEvidence")}
          </h4>
          <p className="tabular-nums">
            {batch.sourceCurrency}
            {batch.conversionRate ? ` @ ${batch.conversionRate}` : ""}
            {batch.conversionRateSource ? ` · ${batch.conversionRateSource}` : ""}
          </p>
          {batch.payoutRate ? (
            <p className="tabular-nums">
              {t("detailPayoutRate", { rate: batch.payoutRate })}
              {batch.payoutRateSource ? ` · ${batch.payoutRateSource}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
          {t("detailLines")}
        </h4>
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detailEmptyLines")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("detailLineType")}</TableHead>
                <TableHead>{t("detailLineRef")}</TableHead>
                <TableHead>{t("detailLineDescription")}</TableHead>
                <TableHead className="text-right">{t("detailLineAmount")}</TableHead>
                <TableHead>{t("detailLineDocument")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => (
                <TableRow key={line.lineNumber}>
                  <TableCell>{t(`lineKinds.${line.kind}`)}</TableCell>
                  <TableCell className="font-mono text-xs">{line.externalRef ?? "—"}</TableCell>
                  <TableCell>{line.description ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(line.amount, { currency: line.currency ?? currency })}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {(() => {
                        // A line recognised by journal points at the posted
                        // entry, not a document: the Document cell stays a
                        // working link for journal-booked sales too.
                        if (line.journalEntryId && line.journalEntryNumber) {
                          return (
                            <JournalEntryLink
                              entryId={line.journalEntryId}
                              className="text-teal-700 hover:underline dark:text-teal-300"
                            >
                              {line.journalEntryNumber}
                            </JournalEntryLink>
                          );
                        }
                        const href = settlementDocumentHref(line);
                        const label = line.journalEntryNumber ?? line.documentNumber ?? "—";
                        return href ? (
                          <Link
                            href={href}
                            className="text-teal-700 hover:underline dark:text-teal-300"
                          >
                            {label}
                          </Link>
                        ) : (
                          label
                        );
                      })()}
                      {canReconcile && EVIDENCE_LINE_KINDS.has(line.kind) ? (
                        <Button size="sm" variant="ghost" onClick={() => onEvidence(line)}>
                          {t("lineEvidence")}
                        </Button>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {common("labels.status")}:{" "}
        {common(
          `status.${STATUS_MESSAGE[(SETTLEMENT_STATUSES as readonly string[]).includes(batch.status) ? (batch.status as SettlementStatus) : "draft"]}`,
        )}
      </p>
    </div>
  );
}
