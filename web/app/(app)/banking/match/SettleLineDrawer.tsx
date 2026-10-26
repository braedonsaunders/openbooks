"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { fromUnits, mulRate, sum, toUnits } from "@openbooks/engine/money/money";
import type { MatchReason, ProposalSettlement } from "@openbooks/engine/banking/match-scoring";
import {
  allocateOldestFirst,
  settlementOrder,
} from "@openbooks/engine/payments/statement-settlement";
import { sourceSettlingTarget } from "@openbooks/engine/payments/settlement-policy";
import {
  Button,
  Drawer,
  EmptyState,
  Input,
  Label,
  SearchSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
} from "@openbooks/ui";
import { useMoney } from "@/components/money-provider";
import { readApiErrorMessage } from "@/lib/api-error";
import { MatchReasonBadges } from "./MatchReasons";

interface CandidateDocument {
  openLineId: string;
  partyId: string;
  partyName: string | null;
  subsidiaryId: string | null;
  documentNumber: string | null;
  entryNumber: string;
  documentKind: string | null;
  dueDate: string | null;
  postingDate: string;
  /** Open balance in the document's own currency. */
  transactionOpen: string;
  currency: string;
  /** Line-currency cash that settles a document in another currency at its recorded rate; null until a rate exists. */
  lineEquivalent: string | null;
  settlementRate: { fxRateId: string; rate: string; asOf: string; source: string } | null;
  reasons: MatchReason[];
}

interface UnappliedCredit {
  documentNumber: string;
  documentKind: string | null;
  currency: string;
  open: string;
}

interface Proposal {
  openLineIds: string[];
  partyId: string;
  partyName: string | null;
  total: string;
  settlement: ProposalSettlement;
  applied: Record<string, string>;
  onAccount: string;
  reasons: MatchReason[];
}

interface ExchangeRateBasis {
  functionalCurrency: string;
  rate: string | null;
  rateDate: string;
  unavailable: string | null;
  manualRateAllowed: boolean;
}

interface Candidates {
  side: "ar" | "ap";
  amount: string;
  currency: string;
  proposals: Proposal[];
  documents: CandidateDocument[];
  exchangeRates: Record<string, ExchangeRateBasis>;
  unappliedCredits: Record<string, UnappliedCredit[]>;
  canWriteOff: boolean;
}

/** The settlement rate a review uses for a document in another currency: the recorded one, or one the operator states. */
interface RateDraft {
  manual: boolean;
  rate: string;
  source: string;
  reason: string;
}

/** The operator's settlement of the line: what each document receives, a write-off, and a manual rate. */
interface SettlementDraft {
  openLineIds: string[];
  applied: Record<string, string>;
  writeOff: boolean;
  writeOffReason: string;
  discountAccountId: string;
  manualRate: boolean;
  rate: string;
  rateSource: string;
  rateReason: string;
  /** Per document in another currency than the line. */
  settlementRates: Record<string, RateDraft>;
}

const AMOUNT_PATTERN = /^\d{1,13}(\.\d{1,4})?$/;
const RATE_PATTERN = /^\d{1,9}(\.\d{1,10})?$/;

/** The settlement rate in force for a document in another currency, or null when none is usable. */
function settlementRateOf(doc: CandidateDocument, draft: SettlementDraft): string | null {
  const stated = draft.settlementRates[doc.openLineId];
  if (stated?.manual) {
    const rate = stated.rate.trim();
    return RATE_PATTERN.test(rate) && !/^0+(\.0+)?$/.test(rate) ? rate : null;
  }
  return doc.settlementRate?.rate ?? null;
}

/** Whether a manually stated settlement rate carries the source and reason the evidence needs. */
function manualRateComplete(stated: RateDraft | undefined): boolean {
  return !stated?.manual || (stated.source.trim().length > 0 && stated.reason.trim().length >= 8);
}

/**
 * Exact settlement arithmetic for the review: per-document validity, the
 * applied total, cash on account and the write-off, all in the line's
 * currency. A document in another currency is open for the cash that settles
 * its balance at its settlement rate, and keeps, in its own currency, what
 * the cash does not settle.
 */
function summarize(candidates: Candidates, docs: CandidateDocument[], draft: SettlementDraft) {
  const line = toUnits(candidates.amount);
  let applied = 0n;
  let shortfall = 0n;
  let invalid = false;
  let rateMissing = false;
  const rows = settlementOrder(
    docs.map((doc) => ({
      openLineId: doc.openLineId,
      open: doc.transactionOpen,
      dueDate: doc.dueDate,
      postingDate: doc.postingDate,
      label: doc.documentNumber ?? doc.entryNumber,
    })),
  ).map((ordered) => {
    const doc = docs.find((candidate) => candidate.openLineId === ordered.openLineId)!;
    const foreign = doc.currency !== candidates.currency;
    const rate = foreign ? settlementRateOf(doc, draft) : null;
    if (foreign && (rate === null || !manualRateComplete(draft.settlementRates[doc.openLineId])))
      rateMissing = true;
    const raw = (draft.applied[doc.openLineId] ?? "").trim();
    const units = AMOUNT_PATTERN.test(raw) ? toUnits(raw) : null;
    let open: bigint | null = toUnits(doc.transactionOpen);
    if (foreign) {
      try {
        open = rate ? toUnits(sourceSettlingTarget(doc.transactionOpen, rate).source) : null;
      } catch {
        open = null;
      }
    }
    const rowInvalid = units === null || open === null || units <= 0n || units > open;
    if (rowInvalid) invalid = true;
    else {
      applied += units;
      shortfall += open! - units;
    }
    // What the document still carries, in its own currency.
    const remaining = rowInvalid
      ? null
      : foreign
        ? toUnits(doc.transactionOpen) - toUnits(mulRate(fromUnits(units!), rate!))
        : open! - units!;
    // A write-off clears the rest: a receipt's invoice write-off states it
    // in the invoice's currency, and a bill payment's discount settles the
    // bill in full at its rate, leaving only what that rate cannot express.
    const remainingAfterWriteOff = rowInvalid
      ? null
      : foreign && candidates.side === "ap"
        ? toUnits(doc.transactionOpen) - toUnits(mulRate(fromUnits(open!), rate!))
        : 0n;
    return {
      doc,
      raw,
      foreign,
      rate,
      lineOpen: open,
      invalid: rowInvalid,
      remaining,
      remainingAfterWriteOff,
    };
  });
  const overApplied = applied > line;
  const onAccount = overApplied ? 0n : line - applied;
  return {
    rows,
    applied,
    onAccount,
    shortfall,
    invalid,
    rateMissing,
    overApplied,
    conflict: draft.writeOff && onAccount > 0n,
  };
}

type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "loaded"; candidates: Candidates };

/** Load the proposals for one line; refusals keep the server's reason and remedy. */
async function requestCandidates(
  lineId: string,
  reconciliationId: string,
  failureMessage: string,
  signal?: AbortSignal,
): Promise<LoadState> {
  try {
    const res = await fetch(
      `/api/banking/statement-lines/${lineId}/open-documents?reconciliationId=${encodeURIComponent(reconciliationId)}`,
      { signal },
    );
    if (!res.ok)
      return { status: "failed", message: await readApiErrorMessage(res, failureMessage) };
    return { status: "loaded", candidates: (await res.json()) as Candidates };
  } catch {
    return { status: "failed", message: failureMessage };
  }
}

export interface SettleLine {
  id: string;
  label: string;
}

/**
 * Open invoices or bills for one unmatched bank line, ranked with reasons,
 * and the one-step "Record payment and match". One drawer shell carries
 * loading, the proposals, refusals and retry; a refused record keeps its
 * reason inline until the next selection. Hosts mount it per line (keyed by
 * the line id), so every line starts from a fresh selection.
 */
export function SettleLineDrawer({
  line,
  reconciliationId,
  currency,
  discountAccounts = [],
  onClose,
  onRecorded,
}: {
  line: SettleLine;
  reconciliationId: string;
  currency: string;
  /** Posting accounts a bill payment may write a short-paid difference off to. */
  discountAccounts?: { id: string; label: string }[];
  onClose: () => void;
  onRecorded: () => void;
}) {
  const t = useTranslations("banking.match.settle");
  const tCommon = useTranslations("common");
  const tBanking = useTranslations("banking");
  const { money: formatMoney } = useMoney(currency);
  const money = (value: string) => formatMoney(value, { maximumFractionDigits: 4 });
  const moneyIn = (value: string, inCurrency: string) =>
    formatMoney(value, { currency: inCurrency, maximumFractionDigits: 4 });
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [view, setView] = useState<"proposals" | "documents" | "settle">("proposals");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<SettlementDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const lineId = line.id;

  const failureMessage = tBanking("errors.requestFailed");

  useEffect(() => {
    const controller = new AbortController();
    requestCandidates(lineId, reconciliationId, failureMessage, controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [lineId, reconciliationId, failureMessage]);

  function retry() {
    setState({ status: "loading" });
    void requestCandidates(lineId, reconciliationId, failureMessage).then(setState);
  }

  const candidates = state.status === "loaded" ? state.candidates : null;
  const documentsById = useMemo(
    () => new Map((candidates?.documents ?? []).map((doc) => [doc.openLineId, doc])),
    [candidates],
  );
  const selectedDocs = [...selected]
    .map((id) => documentsById.get(id))
    .filter((doc): doc is CandidateDocument => !!doc);
  // Selections are compared in the line's currency: a document in another
  // currency counts at its recorded settlement rate, and one without a rate
  // must be reviewed with a rate the operator states.
  const lineOpenOf = (doc: CandidateDocument) =>
    doc.currency === candidates?.currency ? doc.transactionOpen : doc.lineEquivalent;
  const selectedTotal = sum(selectedDocs.map((doc) => lineOpenOf(doc) ?? "0"));
  const selectionParties = new Set(selectedDocs.map((doc) => doc.partyId));
  const selectionSettles =
    candidates !== null &&
    selectedDocs.length > 0 &&
    selectionParties.size === 1 &&
    selectedDocs.every((doc) => lineOpenOf(doc) !== null) &&
    toUnits(selectedTotal) === toUnits(candidates.amount);

  /** Open the settlement review for a set of documents, with the cash applied oldest first unless a proposal states it. */
  function review(openLineIds: string[], applied?: Record<string, string>) {
    if (!candidates) return;
    const docs = openLineIds
      .map((id) => documentsById.get(id))
      .filter((doc): doc is CandidateDocument => !!doc);
    const allocation =
      applied ??
      allocateOldestFirst(
        candidates.amount,
        docs.map((doc) => ({
          openLineId: doc.openLineId,
          open: lineOpenOf(doc) ?? "0",
          dueDate: doc.dueDate,
          postingDate: doc.postingDate,
          label: doc.documentNumber ?? doc.entryNumber,
        })),
      );
    setRecordError(null);
    setDraft({
      openLineIds: docs.map((doc) => doc.openLineId),
      applied: Object.fromEntries(
        docs.map((doc) => [doc.openLineId, fromUnits(toUnits(allocation[doc.openLineId] ?? "0"))]),
      ),
      writeOff: false,
      writeOffReason: "",
      discountAccountId: "",
      manualRate: false,
      rate: "",
      rateSource: "",
      rateReason: "",
      settlementRates: Object.fromEntries(
        docs
          .filter((doc) => doc.currency !== candidates.currency)
          .map((doc) => [
            doc.openLineId,
            {
              manual: doc.settlementRate === null,
              rate: doc.settlementRate?.rate ?? "",
              source: "",
              reason: "",
            },
          ]),
      ),
    });
    setView("settle");
  }

  async function record(openLineIds: string[], settlement?: SettlementDraft) {
    if (!candidates) return;
    setBusy(true);
    setRecordError(null);
    try {
      const expectedOpen: Record<string, string> = {};
      for (const id of openLineIds) {
        const doc = documentsById.get(id);
        if (doc) expectedOpen[id] = doc.transactionOpen;
      }
      const res = await fetch(`/api/banking/statement-lines/${line.id}/record-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reconciliationId,
          openLineIds,
          expectedOpen,
          ...(settlement
            ? {
                applied: Object.fromEntries(
                  openLineIds.map((id) => [id, settlement.applied[id] ?? ""]),
                ),
                writeOff: settlement.writeOff
                  ? {
                      reason: settlement.writeOffReason.trim(),
                      ...(candidates.side === "ap"
                        ? { discountAccountId: settlement.discountAccountId || null }
                        : {}),
                    }
                  : null,
                exchangeRate: settlement.manualRate
                  ? {
                      rate: settlement.rate.trim(),
                      source: settlement.rateSource.trim(),
                      reason: settlement.rateReason.trim(),
                    }
                  : null,
                settlementRates:
                  Object.keys(settlement.settlementRates).length === 0
                    ? null
                    : Object.fromEntries(
                        Object.entries(settlement.settlementRates).map(([id, stated]) => {
                          const doc = documentsById.get(id);
                          return [
                            id,
                            stated.manual || !doc?.settlementRate
                              ? {
                                  rate: stated.rate.trim(),
                                  source: stated.source.trim(),
                                  reason: stated.reason.trim(),
                                }
                              : { fxRateId: doc.settlementRate.fxRateId },
                          ];
                        }),
                      ),
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const message = await readApiErrorMessage(res, tBanking("errors.requestFailed"));
        setRecordError(message);
        toast.error(message);
        return;
      }
      const result = (await res.json().catch(() => null)) as {
        documentNumber?: string;
        onAccount?: string;
        writeOffTotal?: string;
        effectsError?: string | null;
      } | null;
      toast.success(t("recordedToast", { number: result?.documentNumber ?? "" }));
      if (result?.onAccount && toUnits(result.onAccount) > 0n) {
        toast.info(
          candidates.side === "ar"
            ? t("settlement.onAccountCustomerToast", { amount: money(result.onAccount) })
            : t("settlement.onAccountVendorToast", { amount: money(result.onAccount) }),
        );
      }
      if (result?.writeOffTotal && toUnits(result.writeOffTotal) > 0n)
        toast.info(t("settlement.writtenOffToast", { amount: money(result.writeOffTotal) }));
      if (result?.effectsError) toast.error(t("effectsPending", { reason: result.effectsError }));
      onRecorded();
    } catch {
      const message = tBanking("errors.requestFailed");
      setRecordError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const docLabel = (doc: CandidateDocument) => doc.documentNumber ?? doc.entryNumber;
  const sideTitle = candidates?.side === "ap" ? t("titleBills") : t("titleInvoices");
  const draftDocs = draft
    ? draft.openLineIds
        .map((id) => documentsById.get(id))
        .filter((doc): doc is CandidateDocument => !!doc)
    : [];
  const summary = candidates && draft ? summarize(candidates, draftDocs, draft) : null;
  const draftSubsidiary = draftDocs[0]?.subsidiaryId ?? null;
  const fx =
    candidates && draftSubsidiary ? (candidates.exchangeRates[draftSubsidiary] ?? null) : null;
  // The native rate evidence: a positive rate (at most nine whole digits and
  // ten decimals), a named source and a reason of at least eight characters.
  const rateValid =
    !draft?.manualRate ||
    (RATE_PATTERN.test(draft.rate.trim()) &&
      !/^0+(\.0+)?$/.test(draft.rate.trim()) &&
      draft.rateSource.trim().length > 0 &&
      draft.rateReason.trim().length >= 8);
  const writeOffValid =
    !draft?.writeOff ||
    (draft.writeOffReason.trim().length > 0 &&
      (candidates?.side !== "ap" || draft.discountAccountId !== ""));
  const settlementReady =
    !!summary &&
    !summary.invalid &&
    !summary.rateMissing &&
    !summary.overApplied &&
    !summary.conflict &&
    rateValid &&
    writeOffValid &&
    (!fx || fx.rate !== null || !!draft?.manualRate) &&
    (!draft?.writeOff || summary.shortfall > 0n);
  /** A suggestion when the party already holds unapplied credit that could settle its documents without this line. */
  const unappliedNotice = (partyId: string | null) => {
    const credits = partyId ? (candidates?.unappliedCredits[partyId] ?? []) : [];
    if (credits.length === 0) return null;
    return (
      <p
        role="note"
        className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      >
        {t("settlement.unappliedCredit", {
          credits: credits
            .map((credit) => `${credit.documentNumber} ${moneyIn(credit.open, credit.currency)}`)
            .join(", "),
        })}
      </p>
    );
  };
  const updateDraft = (patch: Partial<SettlementDraft>) => {
    setRecordError(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const tabClass = (active: boolean) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
      active
        ? "bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200"
        : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
    );

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={candidates ? sideTitle : t("title")}
      description={
        candidates
          ? t("description", { line: line.label, amount: money(candidates.amount) })
          : line.label
      }
      subtabs={
        candidates ? (
          <div className="flex items-center gap-1 px-6 pb-2" role="tablist" aria-label={t("title")}>
            <button
              type="button"
              role="tab"
              aria-selected={view === "proposals"}
              className={tabClass(view === "proposals")}
              onClick={() => setView("proposals")}
            >
              {t("tabs.proposals")}{" "}
              <span className="ml-1 text-xs text-slate-400">{candidates.proposals.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "documents"}
              className={tabClass(view === "documents")}
              onClick={() => setView("documents")}
            >
              {t("tabs.documents")}{" "}
              <span className="ml-1 text-xs text-slate-400">{candidates.documents.length}</span>
            </button>
            {draft ? (
              <button
                type="button"
                role="tab"
                aria-selected={view === "settle"}
                className={tabClass(view === "settle")}
                onClick={() => setView("settle")}
              >
                {t("tabs.settlement")}
              </button>
            ) : null}
          </div>
        ) : undefined
      }
      headerActions={
        candidates && view === "documents" ? (
          selectionSettles ? (
            <Button disabled={busy} onClick={() => record([...selected])}>
              {busy ? tCommon("actions.saving") : t("recordAndMatch")}
            </Button>
          ) : (
            <Button
              disabled={busy || selectedDocs.length === 0 || selectionParties.size !== 1}
              onClick={() => review([...selected])}
            >
              {t("settlement.review")}
            </Button>
          )
        ) : candidates && view === "settle" && draft ? (
          <Button
            disabled={busy || !settlementReady}
            onClick={() => record(draft.openLineIds, draft)}
          >
            {busy ? tCommon("actions.saving") : t("recordAndMatch")}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {recordError ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          >
            {recordError}
          </p>
        ) : null}
        {state.status === "loading" ? (
          <p className="text-sm text-slate-500 dark:text-slate-400" role="status">
            {t("loading")}
          </p>
        ) : null}
        {state.status === "failed" ? (
          <div className="space-y-2">
            <p
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {state.message}
            </p>
            <Button variant="outline" onClick={retry}>
              <RotateCcw size={14} /> {t("retry")}
            </Button>
          </div>
        ) : null}
        {candidates && view === "proposals" ? (
          candidates.proposals.length === 0 ? (
            <EmptyState
              title={t("noProposalsTitle")}
              description={t("noProposalsDescription", { currency: candidates.currency })}
            />
          ) : (
            <>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t("proposalsHint")}</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.party")}</TableHead>
                    <TableHead>{t("columns.documents")}</TableHead>
                    <TableHead>{t("columns.why")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.proposals.map((proposal) => (
                    <TableRow key={proposal.openLineIds.join(",")}>
                      <TableCell className="max-w-[10rem]">
                        <div className="truncate">{proposal.partyName ?? "—"}</div>
                        {(candidates.unappliedCredits[proposal.partyId]?.length ?? 0) > 0 ? (
                          <div className="text-xs text-amber-700 dark:text-amber-300">
                            {t("settlement.hasUnappliedCredit")}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-[13px]">
                        {proposal.openLineIds.map((id) => {
                          const doc = documentsById.get(id);
                          return doc ? (
                            <div key={id}>
                              {docLabel(doc)}{" "}
                              <span className="text-slate-400">
                                {doc.currency === candidates.currency
                                  ? money(doc.transactionOpen)
                                  : moneyIn(doc.transactionOpen, doc.currency)}
                              </span>
                            </div>
                          ) : null;
                        })}
                      </TableCell>
                      <TableCell>
                        <MatchReasonBadges reasons={proposal.reasons} formatAmount={money} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {proposal.settlement === "exact" ? (
                          <span className="inline-flex gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => review(proposal.openLineIds, proposal.applied)}
                            >
                              {t("settlement.reviewShort")}
                            </Button>
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => record(proposal.openLineIds)}
                            >
                              {t("recordAndMatch")}
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => review(proposal.openLineIds, proposal.applied)}
                          >
                            {t("settlement.review")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )
        ) : null}
        {candidates && view === "documents" ? (
          candidates.documents.length === 0 ? (
            <EmptyState
              title={t("noDocumentsTitle")}
              description={t("noDocumentsDescription", { currency: candidates.currency })}
            />
          ) : (
            <>
              <p className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                {t("selectionSummary", {
                  selected: money(selectedTotal),
                  amount: money(candidates.amount),
                })}
                {selectionParties.size > 1 ? (
                  <span className="ml-2 text-amber-700 dark:text-amber-300">{t("oneParty")}</span>
                ) : null}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t("columns.document")}</TableHead>
                    <TableHead>{t("columns.party")}</TableHead>
                    <TableHead>{t("columns.due")}</TableHead>
                    <TableHead className="text-right">{t("columns.open")}</TableHead>
                    <TableHead>{t("columns.why")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.documents.map((doc) => {
                    const checked = selected.has(doc.openLineId);
                    const toggle = () => {
                      setRecordError(null);
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(doc.openLineId)) next.delete(doc.openLineId);
                        else next.add(doc.openLineId);
                        return next;
                      });
                    };
                    return (
                      <TableRow
                        key={doc.openLineId}
                        className={cn(checked && "bg-teal-50 dark:bg-teal-950/40")}
                      >
                        <TableCell className="w-8">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={toggle}
                            className="accent-teal-700"
                            aria-label={t("selectDocumentAria", {
                              document: docLabel(doc),
                              amount: money(doc.transactionOpen),
                            })}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-[13px]">{docLabel(doc)}</TableCell>
                        <TableCell className="max-w-[10rem] truncate">
                          {doc.partyName ?? "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{doc.dueDate ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {doc.currency === candidates.currency ? (
                            money(doc.transactionOpen)
                          ) : (
                            <>
                              <div>{moneyIn(doc.transactionOpen, doc.currency)}</div>
                              <div className="text-xs text-slate-500">
                                {doc.lineEquivalent
                                  ? t("settlement.lineEquivalent", {
                                      amount: money(doc.lineEquivalent),
                                    })
                                  : t("settlement.noSettlementRate")}
                              </div>
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          <MatchReasonBadges reasons={doc.reasons} formatAmount={money} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </>
          )
        ) : null}
        {candidates && view === "settle" && draft && summary ? (
          <div className="space-y-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">{t("settlement.hint")}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.document")}</TableHead>
                  <TableHead>{t("columns.due")}</TableHead>
                  <TableHead className="text-right">{t("columns.open")}</TableHead>
                  <TableHead className="w-36 text-right">{t("settlement.apply")}</TableHead>
                  <TableHead className="text-right">{t("settlement.remaining")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.rows.map((row) => (
                  <TableRow key={row.doc.openLineId}>
                    <TableCell className="font-mono text-[13px]">
                      {docLabel(row.doc)}
                      {row.foreign ? (
                        <SettlementRateEditor
                          from={candidates.currency}
                          to={row.doc.currency}
                          recorded={row.doc.settlementRate}
                          stated={draft.settlementRates[row.doc.openLineId]!}
                          onChange={(next) =>
                            updateDraft({
                              settlementRates: {
                                ...draft.settlementRates,
                                [row.doc.openLineId]: next,
                              },
                            })
                          }
                        />
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{row.doc.dueDate ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.foreign
                        ? moneyIn(row.doc.transactionOpen, row.doc.currency)
                        : money(row.doc.transactionOpen)}
                      {row.foreign && row.lineOpen !== null ? (
                        <div className="text-xs text-slate-500">
                          {t("settlement.lineEquivalent", {
                            amount: money(fromUnits(row.lineOpen)),
                          })}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        inputMode="decimal"
                        className={cn(
                          "h-8 text-right tabular-nums",
                          row.invalid && "border-red-400",
                        )}
                        aria-label={t("settlement.applyAria", { document: docLabel(row.doc) })}
                        aria-invalid={row.invalid}
                        value={row.raw}
                        onChange={(event) =>
                          updateDraft({
                            applied: { ...draft.applied, [row.doc.openLineId]: event.target.value },
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.remaining === null
                        ? "—"
                        : moneyIn(
                            fromUnits(
                              draft.writeOff ? (row.remainingAfterWriteOff ?? 0n) : row.remaining,
                            ),
                            row.doc.currency,
                          )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {summary.rateMissing ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {t("settlement.settlementRateMissing")}
              </p>
            ) : null}
            {summary.invalid ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {t("settlement.invalidAmount")}
              </p>
            ) : null}
            {unappliedNotice(draftDocs[0]?.partyId ?? null)}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">{t("settlement.lineAmount")}</dt>
                <dd>{money(candidates.amount)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t("settlement.appliedTotal")}</dt>
                <dd>{money(fromUnits(summary.applied))}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">
                  {candidates.side === "ar"
                    ? t("settlement.onAccountCustomer")
                    : t("settlement.onAccountVendor")}
                </dt>
                <dd>{money(fromUnits(summary.onAccount))}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t("settlement.writtenOff")}</dt>
                <dd>{money(fromUnits(draft.writeOff ? summary.shortfall : 0n))}</dd>
              </div>
            </dl>
            {summary.overApplied ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {t("settlement.overApplied", { amount: money(candidates.amount) })}
              </p>
            ) : null}
            {!summary.overApplied && summary.onAccount > 0n ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {candidates.side === "ar"
                  ? t("settlement.onAccountCustomerNote", {
                      amount: money(fromUnits(summary.onAccount)),
                    })
                  : t("settlement.onAccountVendorNote", {
                      amount: money(fromUnits(summary.onAccount)),
                    })}
              </p>
            ) : null}
            {summary.shortfall > 0n && candidates.canWriteOff ? (
              <div className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="accent-teal-700"
                    checked={draft.writeOff}
                    onChange={(event) => updateDraft({ writeOff: event.target.checked })}
                  />
                  {t("settlement.writeOffToggle", { amount: money(fromUnits(summary.shortfall)) })}
                </label>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {candidates.side === "ar"
                    ? t("settlement.writeOffCustomerHint")
                    : t("settlement.writeOffVendorHint")}
                </p>
                {draft.writeOff ? (
                  <div className="space-y-2">
                    {candidates.side === "ap" ? (
                      <div className="space-y-1">
                        <Label>{t("settlement.writeOffAccount")}</Label>
                        <SearchSelect
                          options={discountAccounts.map((account) => ({
                            value: account.id,
                            label: account.label,
                          }))}
                          value={draft.discountAccountId}
                          onChange={(value) => updateDraft({ discountAccountId: value ?? "" })}
                          placeholder={t("settlement.writeOffAccountPlaceholder")}
                        />
                      </div>
                    ) : null}
                    <div className="space-y-1">
                      <Label htmlFor="settle-write-off-reason">
                        {t("settlement.writeOffReason")}
                      </Label>
                      <Textarea
                        id="settle-write-off-reason"
                        rows={2}
                        maxLength={500}
                        value={draft.writeOffReason}
                        onChange={(event) => updateDraft({ writeOffReason: event.target.value })}
                      />
                    </div>
                    {summary.conflict ? (
                      <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                        {t("settlement.writeOffConflict")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {fx ? (
              <div className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <p className="text-sm font-medium">
                  {t("settlement.exchangeRateTitle", {
                    from: candidates.currency,
                    to: fx.functionalCurrency,
                  })}
                </p>
                {fx.rate !== null ? (
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("settlement.evidencedRate", { rate: fx.rate, date: fx.rateDate })}
                  </p>
                ) : (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    {fx.unavailable ?? t("settlement.noEvidencedRate")}
                  </p>
                )}
                {fx.manualRateAllowed ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-teal-700"
                      checked={draft.manualRate}
                      onChange={(event) => updateDraft({ manualRate: event.target.checked })}
                    />
                    {t("settlement.manualRateToggle")}
                  </label>
                ) : fx.rate === null ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t("settlement.manualRateUnavailable")}
                  </p>
                ) : null}
                {draft.manualRate ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="settle-rate">
                        {t("settlement.rate", {
                          from: candidates.currency,
                          to: fx.functionalCurrency,
                        })}
                      </Label>
                      <Input
                        id="settle-rate"
                        inputMode="decimal"
                        value={draft.rate}
                        onChange={(event) => updateDraft({ rate: event.target.value })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="settle-rate-source">{t("settlement.rateSource")}</Label>
                      <Input
                        id="settle-rate-source"
                        maxLength={120}
                        value={draft.rateSource}
                        onChange={(event) => updateDraft({ rateSource: event.target.value })}
                      />
                    </div>
                    <div className="space-y-1 sm:col-span-3">
                      <Label htmlFor="settle-rate-reason">{t("settlement.rateReason")}</Label>
                      <Input
                        id="settle-rate-reason"
                        maxLength={500}
                        value={draft.rateReason}
                        onChange={(event) => updateDraft({ rateReason: event.target.value })}
                      />
                    </div>
                    {!rateValid ? (
                      <p className="text-xs text-red-700 sm:col-span-3 dark:text-red-300">
                        {t("settlement.rateInvalid")}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {candidates ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("recordHint")}</p>
        ) : null}
      </div>
    </Drawer>
  );
}

/**
 * The settlement rate of one document in another currency than the line:
 * the organization's recorded rate (cited as provider evidence), or a rate
 * the operator states with its source and reason.
 */
function SettlementRateEditor({
  from,
  to,
  recorded,
  stated,
  onChange,
}: {
  from: string;
  to: string;
  recorded: CandidateDocument["settlementRate"];
  stated: RateDraft;
  onChange: (next: RateDraft) => void;
}) {
  const t = useTranslations("banking.match.settle.settlement");
  return (
    <div className="mt-1 space-y-1 font-sans text-xs text-slate-600 dark:text-slate-300">
      {recorded && !stated.manual ? (
        <p>
          {t("recordedSettlementRate", {
            from,
            to,
            rate: recorded.rate,
            source: recorded.source,
            date: recorded.asOf,
          })}
        </p>
      ) : null}
      {recorded ? (
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="accent-teal-700"
            checked={stated.manual}
            onChange={(event) =>
              onChange({
                ...stated,
                manual: event.target.checked,
                rate: event.target.checked ? stated.rate : recorded.rate,
              })
            }
          />
          {t("statedSettlementRateToggle")}
        </label>
      ) : null}
      {stated.manual ? (
        <div className="grid gap-1">
          <Input
            className="h-7 text-xs"
            inputMode="decimal"
            aria-label={t("settlementRate", { from, to })}
            placeholder={t("settlementRate", { from, to })}
            value={stated.rate}
            onChange={(event) => onChange({ ...stated, rate: event.target.value })}
          />
          <Input
            className="h-7 text-xs"
            maxLength={120}
            aria-label={t("rateSource")}
            placeholder={t("rateSource")}
            value={stated.source}
            onChange={(event) => onChange({ ...stated, source: event.target.value })}
          />
          <Input
            className="h-7 text-xs"
            maxLength={500}
            aria-label={t("rateReason")}
            placeholder={t("rateReason")}
            value={stated.reason}
            onChange={(event) => onChange({ ...stated, reason: event.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}
