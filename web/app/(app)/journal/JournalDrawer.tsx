"use client";

import { amortizationLineColumns } from "@/components/transaction-form/amortization-columns";
import {
  HistoricalTranslationPanel,
  type HistoricalTranslationSourceOption,
} from "./HistoricalTranslationPanel";

import {
  CLEAR_SEGMENT,
  INHERIT_SEGMENT,
  segmentCellValue,
  segmentAssignmentsFromCells,
} from "@/lib/segment-assignments";

import { useMoney } from "@/components/money-provider";
import { initialDrawerMode, type DrawerMode } from "@/lib/drawer-mode";
import { isDocumentRevisionToken } from "@/lib/api/registry-data";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type FocusEvent } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { formatCivilDate } from "../../../lib/format";
import { toast } from "sonner";
import { ActionError } from "@braedonsaunders/appkit-errors";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { fetchAppAction } from "@/lib/api-error";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { PeriodClosedRefusal } from "@/components/period-closed-refusal";
import { useAppAction } from "@/lib/use-app-action";
import { Badge, Button, Input, Label, SearchSelect } from "@openbooks/ui";
import { LineGrid, type LineGridColumn } from "../../../components/line-grid";
import { TransactionDrawer } from "../../../components/transaction-drawer";
import {
  CustomFieldInputs,
  customFieldColumns,
  type CustomFieldDefClient,
} from "../../../components/custom-field-inputs";
import type { CustomFieldViewer } from "@openbooks/customization";
import { CustomFieldInput } from "../../../components/custom-field-input";
import { HeaderFields } from "../../../components/transaction-form/header-fields";
import { DocTypeBadge, docTypeMeta } from "../../../components/doc-type-badge";
import { JournalEntryLink } from "../../../components/journal-entry-link";
import { PdfButton } from "../../../components/pdf-button";
import { confirmDialog } from "../../../lib/confirm";
import { promptDialog } from "../../../lib/prompt";
import { promptVoidReversalPeriod } from "../../../lib/void-reversal-period";
import {
  formatJournalAmount,
  journalAmountUnits,
  journalLineUnits,
} from "../../../lib/journal-amounts";
import {
  DOCUMENT_CHANGED_AFTER_OPEN,
  buildDocumentSaveRequest,
  executeDocumentSave,
  loadDraftDocumentSnapshot,
  reconcileCanonicalDraftRead,
  type FencedSaveResult,
  type PersistedDocumentSnapshot,
} from "../../../components/document-drawer";
import { FlowManualButtons } from "../../../components/flow-manual-buttons";
import { JournalBookField, type JournalBookOption } from "./JournalBookField";
import { ApprovalActions } from "../../../components/approval-actions";
import { ApprovalHistory } from "../../../components/approval-history";
import {
  customFieldDefKey,
  isCustomFieldKey,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
} from "@openbooks/customization";
import { DateField } from "@/components/date-field";
import { FormShortcuts } from "@/components/shortcuts/form-shortcuts";
type Opt = {
  id: string;
  display_name?: string;
  number?: string;
  name?: string;
};
interface SubsidiaryOpt {
  id: string;
  name: string;
  /** Root = 0; used to indent the picker like a tree. */
  depth: number;
  /** The entity's functional currency; a journal in any other currency is foreign. */
  baseCurrency?: string;
}
interface SegmentOpt {
  key: string;
  name: string;
  showOnHeader: boolean;
  showOnLines: boolean;
  values: { id: string; code: string | null; name: string }[];
}
interface LineRow extends Record<string, unknown> {
  accountId: string;
  description: string;
  partyId: string;
  departmentId: string;
  projectId: string;
  subsidiaryId: string;
  debit: string;
  credit: string;
  /** Side the drawer filled with a suggested balancing amount, while untouched. */
  autoBalance?: AmountSide;
  /** The suggested amount; any edit to that side makes it the operator's own value. */
  autoBalanceValue?: string;
}
type AmountSide = "debit" | "credit";
/** Where the operator lands after a successful save. */
type SaveThen = "view" | "new" | "close";
interface JournalPayload {
  doc: Record<string, unknown>;
  lines: Record<string, unknown>[];
}

/** The journal header: `documents` plus the loader's joins. Dates, uuids
 *  and numerics arrive from the driver as strings; nullable columns and
 *  left-join columns stay nullable. Column nullability per schema. */
export interface JournalDoc extends Record<string, unknown> {
  id: string;
  status: string;
  currency: string;
  subsidiary_id: string | null;
  reference_number: string | null;
  party_id: string | null;
  party_name: string | null;
  memo: string | null;
  document_date: string | null;
  updated_at: string;
  entry_id: string | null;
  /** Set while a requested void waits for approval; the journal stays posted. */
  void_requested_at: string | null;
  /** Posting-effects state; a terminal failure blocks Void until it is retried. */
  posting_effect_status: string | null;
  document_number: string | null;
  custom: Record<string, unknown>;
  extra_dims: Record<string, string | null>;
}

/** Narrow the engine loader's untyped document row to the header fields
 *  this drawer reads. Loader rows always carry strings (or string maps for
 *  custom/extra_dims) here, so valid payloads pass through unchanged. */
export function asJournalDoc(raw: Record<string, unknown>): JournalDoc {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    ...raw,
    id: text(raw.id) ?? "",
    status: text(raw.status) ?? "",
    currency: text(raw.currency) ?? "",
    subsidiary_id: text(raw.subsidiary_id),
    reference_number: text(raw.reference_number),
    party_id: text(raw.party_id),
    party_name: text(raw.party_name),
    memo: text(raw.memo),
    void_requested_at: text(raw.void_requested_at),
    posting_effect_status: text(raw.posting_effect_status),
    document_date: text(raw.document_date),
    updated_at: text(raw.updated_at) ?? "",
    entry_id: text(raw.entry_id),
    document_number: text(raw.document_number),
    custom: isLineMap(raw.custom) ? raw.custom : {},
    extra_dims: isLineMap(raw.extra_dims)
      ? Object.fromEntries(
          Object.entries(raw.extra_dims).filter(
            (entry): entry is [string, string | null] =>
              entry[1] === null || typeof entry[1] === "string",
          ),
        )
      : {},
  };
}
// Stable identity for the omitted-`segments` default. A `= []` default would
// hand the `payload` memo below a fresh array on every render, and the
// render-time dirty tracker keys on that memo's identity — an ever-churning
// identity re-renders forever ("Too many re-renders" on mount).
const EMPTY_SEGMENTS: SegmentOpt[] = [];

const STATUS_VARIANT: Record<string, "success" | "secondary" | "warning" | "outline"> = {
  posted: "success",
  approved: "success",
  pending_approval: "warning",
  draft: "secondary",
  voided: "outline",
};

// documents.status enum → common.status.* key (unknown values render verbatim).
const STATUS_KEYS: Record<string, string> = {
  draft: "draft",
  approved: "approved",
  pending_approval: "pendingApproval",
  posted: "posted",
  voided: "voided",
  reversed: "reversed",
};

const emptyLine = (): LineRow => ({
  accountId: "",
  description: "",
  partyId: "",
  departmentId: "",
  projectId: "",
  subsidiaryId: "",
  amortizationTemplateId: "",
  amortizationStartOn: "",
  amortizationEndOn: "",
  debit: "",
  credit: "",
});

/** A single journal grid cell carries user content when it is anything but blank. */
function isBlankJournalCell(value: unknown): boolean {
  if (value === "" || value == null || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/**
 * The only journal rows the save payload may drop: truly blank placeholder
 * rows with no user-entered content in ANY field. An amount side counts as
 * empty when it is blank or an exact zero leg — a zero leg carries no
 * financial meaning and the server refuses (rather than books) one, so
 * dropping a leg that is genuinely empty or zero keeps the intentional
 * existing behavior. Every other row rides to the server, which names the
 * line and refuses what cannot book (a missing account, a zero amount).
 * Dropping a contentful account-less row here used to book a journal the
 * operator never reviewed (OM-09b).
 */
export function isBlankJournalLine(row: Record<string, unknown>): boolean {
  for (const key of [
    "accountId",
    "description",
    "partyId",
    "departmentId",
    "projectId",
    "subsidiaryId",
    "amortizationTemplateId",
    "amortizationStartOn",
    "amortizationEndOn",
    "journalCurrency",
    "journalFxRate",
    "statisticalQuantity",
    "unit",
    "eliminate",
  ]) {
    if (!isBlankJournalCell(row[key])) return false;
  }
  for (const key of ["debit", "credit"]) {
    const value = row[key];
    if (value === "" || value == null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (journalAmountUnits(value) === 0n) continue;
    return false;
  }
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("seg_") && (value === INHERIT_SEGMENT || value === CLEAR_SEGMENT)) continue;
    if ((key.startsWith("cf_") || key.startsWith("seg_")) && !isBlankJournalCell(value))
      return false;
  }
  return true;
}

/**
 * First grid row carrying user content but no account. The line number is
 * the visible grid position (index + 1): blank placeholders are normally
 * trailing, so this is also the number the server refusal will cite for
 * the same row. Null when every contentful row names an account.
 */
export function findMissingJournalAccountLine(
  rows: readonly Record<string, unknown>[],
): { index: number; lineNumber: number } | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!isBlankJournalLine(row) && String(row.accountId ?? "").trim() === "") {
      return { index: i, lineNumber: i + 1 };
    }
  }
  return null;
}

type BalanceableRow = Record<string, unknown> & {
  autoBalance?: AmountSide;
  autoBalanceValue?: string;
};

function blankAmount(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

/** Two amount texts name the same exact figure ("100.00" and "100.0000" do). */
function sameAmount(a: unknown, b: unknown): boolean {
  if (blankAmount(a) || blankAmount(b)) return blankAmount(a) && blankAmount(b);
  const left = journalAmountUnits(a);
  return left !== null && left === journalAmountUnits(b);
}

/** An amount as an operator would type it: ledger-scale zeroes past the cents dropped. */
function entryText(amount: string): string {
  const match = /^(-?\d+)\.(\d{2})(\d*)$/.exec(amount);
  if (!match) return amount;
  const extra = match[3]!.replace(/0+$/, "");
  return `${match[1]}.${match[2]}${extra}`;
}

/** The row still holds the balancing amount the drawer suggested on `side`. */
function holdsSuggestion(row: BalanceableRow, side: AmountSide): boolean {
  return (
    row.autoBalance === side &&
    row.autoBalanceValue != null &&
    sameAmount(row[side], row.autoBalanceValue)
  );
}

/** True while the row's amount is still the balancing amount the drawer suggested and nobody edited it. */
export function isUntouchedBalanceSuggestion(row: BalanceableRow): boolean {
  const side = row.autoBalance;
  if (side !== "debit" && side !== "credit") return false;
  if (!holdsSuggestion(row, side)) return false;
  const other: AmountSide = side === "debit" ? "credit" : "debit";
  return blankAmount(row[other]);
}

/**
 * The amount and side that bring the entry level once placed on row
 * `index`, computed from every other row in exact numeric(19,4) units. Null
 * when the other rows already balance or any of them carries an amount that
 * does not parse: a suggestion is never derived from unreadable input.
 */
export function balancingLeg(
  rows: readonly Record<string, unknown>[],
  index: number,
): { side: AmountSide; amount: string } | null {
  let total = 0n;
  for (let i = 0; i < rows.length; i++) {
    if (i === index) continue;
    const signed = journalLineUnits(rows[i]!.debit, rows[i]!.credit);
    if (signed === null) return null;
    total += signed;
  }
  if (total === 0n) return null;
  return total > 0n
    ? { side: "credit", amount: formatJournalAmount(total) }
    : { side: "debit", amount: formatJournalAmount(-total) };
}

/**
 * Pre-enter the balancing amount on a line without amounts. A row whose
 * debit and credit are both empty (its account and description may already
 * be chosen) or that still holds an untouched suggestion is filled, so an
 * amount the operator typed is never replaced.
 * The suggestion is an ordinary amount: it posts like a typed one, and
 * editing it makes it the operator's own. Returns `rows` unchanged when
 * there is nothing to suggest.
 */
export function suggestBalancingLine<Row extends BalanceableRow>(
  rows: Row[],
  index: number,
): Row[] {
  const row = rows[index];
  if (!row) return rows;
  const untouched = isUntouchedBalanceSuggestion(row);
  if (!untouched && !(blankAmount(row.debit) && blankAmount(row.credit))) return rows;
  const leg = balancingLeg(rows, index);
  if (!leg) {
    if (!untouched) return rows;
    // The rest of the entry balances now: a stale suggestion would unbalance it.
    return rows.map((r, i) =>
      i === index
        ? { ...r, debit: "", credit: "", autoBalance: undefined, autoBalanceValue: undefined }
        : r,
    );
  }
  if (untouched && row.autoBalance === leg.side && sameAmount(row[leg.side], leg.amount))
    return rows;
  return rows.map((r, i) =>
    i === index
      ? {
          ...r,
          debit: leg.side === "debit" ? leg.amount : "",
          credit: leg.side === "credit" ? leg.amount : "",
          autoBalance: leg.side,
          autoBalanceValue: leg.amount,
        }
      : r,
  );
}

/**
 * The explicit Balance action: put the remaining difference on row `index`,
 * replacing that row's own amount. Clears the row's amount when the other
 * rows already balance; leaves the rows unchanged when any other amount is
 * unreadable.
 */
export function balanceLineAt<Row extends BalanceableRow>(rows: Row[], index: number): Row[] {
  const row = rows[index];
  if (!row) return rows;
  for (let i = 0; i < rows.length; i++) {
    if (i !== index && journalLineUnits(rows[i]!.debit, rows[i]!.credit) === null) return rows;
  }
  const leg = balancingLeg(rows, index);
  return rows.map((r, i) =>
    i === index
      ? {
          ...r,
          debit: leg?.side === "debit" ? leg.amount : "",
          credit: leg?.side === "credit" ? leg.amount : "",
          autoBalance: undefined,
          autoBalanceValue: undefined,
        }
      : r,
  );
}

/**
 * Whether the optional header settings hold anything but their defaults:
 * the "More options" disclosure opens for these so a stored value is never
 * hidden behind a closed section.
 */
export function journalOptionsAreNonDefault(input: {
  journalMode: string;
  currency: string;
  defaultCurrency: string | null;
  fxRate: string;
  reverseOn: string;
  partyId: string;
  accountingBookId: string;
}): boolean {
  if (input.journalMode !== "monetary") return true;
  if (
    input.currency.trim() !== "" &&
    input.defaultCurrency &&
    input.currency.trim().toUpperCase() !== input.defaultCurrency.toUpperCase()
  )
    return true;
  const rate = input.fxRate.trim();
  if (rate !== "" && !/^\+?0*1(\.0*)?$/.test(rate)) return true;
  return input.reverseOn !== "" || input.partyId !== "" || input.accountingBookId !== "";
}

/** The unsaved-create URL for a fresh journal, carrying the entry date forward when one is set. */
export function freshJournalHref(returnHref: string, entryDate: string): string {
  const separator = returnHref.includes("?") ? "&" : "?";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(entryDate) ? `&entryDate=${entryDate}` : "";
  return `${returnHref}${separator}entryNew=1&mode=edit${date}`;
}

/** Line text columns are uuids/text-or-null. */
function lineText(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function isLineMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toRow(
  l: Record<string, unknown>,
  lineDefs: CustomFieldDefClient[],
  segments: SegmentOpt[],
): LineRow {
  // Exact parse at the ledger's numeric(19,4) scale — a float round-trip here
  // would snap 4-decimal lines to cents and silently drop sub-cent legs.
  const units = journalAmountUnits(l.amount) ?? 0n;
  const row: LineRow = {
    accountId: lineText(l.account_id),
    description: lineText(l.description),
    partyId: lineText(l.party_id),
    departmentId: lineText(l.department_id),
    projectId: lineText(l.project_id),
    subsidiaryId: lineText(l.subsidiary_id),
    amortizationTemplateId: lineText(l.amortization_template_id),
    amortizationStartOn: lineText(l.amortization_start_on),
    amortizationEndOn: lineText(l.amortization_end_on),
    functionalCurrency: lineText(l.functional_currency),
    journalCurrency: lineText(l.journal_currency),
    journalFxRate: lineText(l.journal_fx_rate),
    statisticalQuantity: l.unit ? lineText(l.quantity) : "",
    unit: lineText(l.unit),
    eliminate: l.journal_eliminate ? "true" : "",
    debit: units > 0n ? formatJournalAmount(units) : "",
    credit: units < 0n ? formatJournalAmount(-units) : "",
  };
  const custom = isLineMap(l.custom) ? l.custom : null;
  const extraDims = isLineMap(l.extra_dims) ? l.extra_dims : null;
  for (const def of lineDefs) row[`cf_${def.key}`] = custom?.[def.key] ?? "";
  for (const segment of segments)
    row[`seg_${segment.key}`] = segmentCellValue(extraDims, segment.key);
  return row;
}

/**
 * True when revision token `a` is strictly older than `b`. Counter tokens
 * (revision_seq, decimal text) compare numerically; timestamp tokens are
 * fixed-width ISO text, so they compare chronologically as text. A server
 * snapshot read before a post committed carries an older token and must not
 * overwrite the post's own result.
 */
export function revisionIsOlder(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b);
  return a < b;
}

export type JournalDraftSaveInput = {
  documentId: string;
  revision: string;
  payload: Record<string, unknown>;
  fallbackMessage: string;
  transport?: typeof fetch;
};

/**
 * One revision-fenced manual-journal save — the exact routine the drawer's
 * Save button executes. The editor's exact revision rides as expectedUpdatedAt
 * (the PATCH route refuses anything else), a success hands back the refreshed
 * token from the save response, and a stale token surfaces as an explicit
 * conflict for the caller's reload flow.
 */
export async function saveJournalDraft(
  input: JournalDraftSaveInput,
): Promise<FencedSaveResult<JournalPayload>> {
  const outcome = await executeDocumentSave(
    buildDocumentSaveRequest(input.documentId, input.revision, input.payload, false, undefined, {
      basePath: "/api/journals",
    }),
    input.fallbackMessage,
    input.transport ?? fetch,
  );
  if (!outcome.ok) {
    return outcome.isConflict
      ? { status: "conflict", message: outcome.message }
      : { status: "error", message: outcome.message };
  }
  return { status: "saved", saved: outcome.data as JournalPayload, revision: outcome.revision };
}

type JournalDrawerProps = Omit<Parameters<typeof JournalDrawerBody>[0], "onStartFresh">;

/**
 * Each journal owns its editor state and revision baseline. An unsaved
 * create that saves (or posts) and starts the next journal keeps the same
 * URL shape, so the editor remounts here with a fresh idempotency key, blank
 * lines and the entry date carried forward.
 */
export function JournalDrawer(props: JournalDrawerProps) {
  const [fresh, setFresh] = useState<{ generation: number; date: string } | null>(null);
  if (fresh && !props.createMode) setFresh(null);
  const journal =
    fresh && props.createMode
      ? {
          ...props.journal,
          doc: {
            ...props.journal.doc,
            document_date: fresh.date || props.journal.doc.document_date,
          },
        }
      : props.journal;
  return (
    <JournalDrawerBody
      key={`${props.ledgerSnapshot ? "ledger" : "document"}:${String(props.journal.doc.id)}:${fresh?.generation ?? 0}`}
      {...props}
      journal={journal}
      onStartFresh={(date) =>
        setFresh((current) => ({ generation: (current?.generation ?? 0) + 1, date }))
      }
    />
  );
}

function JournalDrawerBody({
  journal,
  initialMode = "view",
  parties,
  accounts,
  departments,
  projects,
  subsidiaries,
  books,
  canPostBookSpecific = false,
  amortizationTemplates,
  segments = EMPTY_SEGMENTS,
  headerDefs,
  lineDefs,
  customFieldViewer,
  layout,
  createMode = false,
  ledgerSnapshot = false,
  ledgerDescription,
  ledgerTotals,
  onLedgerRefresh,
  sourceDocument = true,
  currentEntryId,
  canPost,
  historicalTranslationSources,
  closeHref,
  canCreate = false,
  onStartFresh,
}: {
  journal: JournalPayload;
  initialMode?: DrawerMode;
  parties: Opt[];
  accounts: Opt[];
  departments: Opt[];
  projects: Opt[];
  /** The org's subsidiaries (depth-first tree order). Only passed in
   *  multi-subsidiary orgs — empty/undefined renders NO subsidiary UI. */
  subsidiaries?: SubsidiaryOpt[];
  /** Active posting books; passed only when Multi-book accounting is on. */
  books?: JournalBookOption[];
  /** Whether the viewer may choose a book-specific target. */
  canPostBookSpecific?: boolean;
  amortizationTemplates?: { id: string; label: string }[];
  segments?: SegmentOpt[];
  headerDefs: CustomFieldDefClient[];
  /** The viewer's custom-field visibility from the server; omitted shows only open fields. */
  customFieldViewer?: CustomFieldViewer | null;
  lineDefs: CustomFieldDefClient[];
  layout?: FormLayoutConfig;
  /** Unsaved-create: no persisted row exists. Cancel/close navigate away
   *  with zero writes; Save is the first write (one idempotent POST). */
  createMode?: boolean;
  /** Immutable posted ledger lines, rather than editable document lines. */
  ledgerSnapshot?: boolean;
  ledgerDescription?: string;
  ledgerTotals?: { currency: string; debit: string; credit: string }[];
  onLedgerRefresh?: () => void;
  /** Standalone and historical entries have no current document actions. */
  sourceDocument?: boolean;
  /** Historical generations link to the current journal without offering mutations against old evidence. */
  currentEntryId?: string;
  /**
   * Holds gl.post — the permission every document mutation (save,
   * post, delete, void) requires server-side. Without it the drawer is
   * read-only: no Edit, Save, Post, Delete or Void is offered, because
   * each would only meet the server's refusal.
   */
  canPost: boolean;
  historicalTranslationSources?: HistoricalTranslationSourceOption[];
  /** List return URL — Cancel/close land here, and a successful Save opens
   *  the created journal over it. */
  closeHref?: string;
  /**
   * The viewer may open a new unsaved journal (gl.post with at least one
   * subsidiary in scope). Save & new and Post & new are offered only then.
   */
  canCreate?: boolean;
  /** Restart an unsaved create in place, keeping the given entry date. */
  onStartFresh: (entryDate: string) => void;
}) {
  const { money, currency: orgCurrency } = useMoney();
  const t = useTranslations("journal.drawer");
  const tHistorical = useTranslations("journal.historicalTranslation");
  const tNew = useTranslations("journal.newButton");
  const tAmortization = useTranslations("amortization.billLine");
  const tc = useTranslations("common");
  const tEntry = useTranslations("entry");
  const locale = useLocale();
  const router = useRouter();
  const propsDoc = asJournalDoc(journal.doc);
  // The header's status must not rest on the server props alone: a list
  // refresh that started before a Post committed can deliver the pre-post
  // draft after the Post's own result. The drawer keeps the newest snapshot
  // it observed (a post's canonical read, or the post response) and yields
  // to the props only once they carry a newer revision.
  const [liveDoc, setLiveDoc] = useState<JournalDoc | null>(null);
  const doc =
    liveDoc && !revisionIsOlder(liveDoc.updated_at, propsDoc.updated_at) ? liveDoc : propsDoc;
  const isDraft = doc.status === "draft";
  // A requested void waits on approval while the journal stays posted: the
  // drawer names that state and holds Void until the approval is decided.
  const voidAwaitingApproval = doc.void_requested_at != null;
  // Existing records default to read-only; newly created drafts can explicitly
  // request edit mode. Only draft journals are editable. Once a journal enters
  // approval or posts, its accounting evidence is preserved; use the controlled
  // correction/void workflows for changes. Voided journals are read-only. Save
  // is EXPLICIT — no autosave.
  const canEditStatus = !ledgerSnapshot && doc.status === "draft";
  const [mode, setMode] = useState<DrawerMode>(
    // Without gl.post there is no edit mode to enter: every mutation the
    // mode would offer (save, post, delete, void) meets the server's
    // refusal, so the drawer opens read-only instead of stranding the
    // reader in an unsavable editor (createMode always carries gl.post —
    // the loader opens it only with the permission).
    createMode ? "edit" : initialDrawerMode(initialMode, canEditStatus && canPost),
  );
  const editable = mode === "edit" && canEditStatus;
  const returnHref = closeHref ?? "/journal";
  const requestIdRef = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** The grid line the operator last worked in: the target of the Balance action. */
  const focusedRowRef = useRef<number | null>(null);
  /** A suggestion being entered through the focused amount cell. */
  const pendingSuggestion = useRef<{ index: number; side: AmountSide; row: LineRow } | null>(null);

  const [journalMode, setJournalMode] = useState<string>(String(doc.journal_mode ?? "monetary"));
  const [currency, setCurrency] = useState<string>(doc.currency);
  const [fxRate, setFxRate] = useState<string>(String(doc.fx_rate ?? "1"));
  const [reverseOn, setReverseOn] = useState<string>(String(doc.journal_reverse_on ?? ""));
  const [partyId, setPartyId] = useState<string>(doc.party_id ?? "");
  const [documentDate, setDocumentDate] = useState<string>(doc.document_date ?? "");
  const [referenceNumber, setReferenceNumber] = useState<string>(doc.reference_number ?? "");
  const [memo, setMemo] = useState<string>(doc.memo ?? "");
  const [subsidiaryId, setSubsidiaryId] = useState<string>(doc.subsidiary_id ?? "");
  const bookUi = (books?.length ?? 0) > 1;
  const [accountingBookId, setAccountingBookId] = useState<string>(
    typeof journal.doc.accounting_book_id === "string" ? journal.doc.accounting_book_id : "",
  );
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(doc.custom ?? {});
  const [extraDims, setExtraDims] = useState<Record<string, string | null>>(doc.extra_dims ?? {});
  const [rows, setRows] = useState<LineRow[]>(
    journal.lines.length > 0
      ? journal.lines.map((l) => toRow(l, lineDefs, segments))
      : [emptyLine(), emptyLine()],
  );
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  // Saves, posts, deletes and voids run on the shared action path: a
  // refusal pins until the next action AND toasts,
  // and busy always releases through the package's finally.
  const { busy, refusal, execute, clearRefusal, refuse } = useAppAction();
  const saveRunning = useRef(false);
  const postFromKeyboardRunning = useRef(false);
  // A posted-with-warnings post pins here: the entry IS posted,
  // but its party-less control legs sit outside every subledger, so the
  // drawer keeps saying so until the next action (same rule as refusals).
  const [postWarnings, setPostWarnings] = useState<string[]>([]);

  // -- subsidiaries (multi-subsidiary orgs only; empty/undefined = no UI) ----
  // The header subsidiary is the journal's home entity; the OPTIONAL per-line
  // subsidiary override is the intercompany surface — the posting engine
  // auto-balances cross-subsidiary lines via due-to/due-from pairs.
  const multiSub = (subsidiaries?.length ?? 0) > 0;
  const subsidiaryOpts = useMemo(
    () =>
      (subsidiaries ?? []).map((s) => ({ value: s.id, label: "\u2003".repeat(s.depth) + s.name })),
    [subsidiaries],
  );
  const rootSubsidiaryName = subsidiaries?.[0]?.name ?? "—";
  const subsidiaryName = (id: unknown): string =>
    id ? ((subsidiaries ?? []).find((s) => s.id === id)?.name ?? "—") : rootSubsidiaryName;

  /**
   * Each row carries exactly one side: entering one clears the other. An
   * edited suggestion becomes the operator's own amount. A blank line the
   * grid appends (Enter on the last line, Add line) arrives pre-entered with
   * the amount that balances the entry, so a two-line journal is one
   * account pick and Enter away from level.
   */
  function handleRowsChange(next: LineRow[]) {
    const previous = new Set(rows);
    // The appended line is the one new, entirely blank row (rows the grid
    // re-created to fold in a pending edit carry that edit).
    const appended =
      next.length === rows.length + 1
        ? next.flatMap((row, index) =>
            !previous.has(row) &&
            isBlankJournalLine(row) &&
            blankAmount(row.debit) &&
            blankAmount(row.credit)
              ? [index]
              : [],
          )
        : [];
    const entering = pendingSuggestion.current;
    let settled = next.map((r, i) => {
      // The drawer's own suggestion arriving through the focused cell keeps
      // its suggestion marker.
      if (
        entering &&
        entering.index === i &&
        sameAmount(r[entering.side], entering.row[entering.side])
      )
        return entering.row;
      const prev = rows[i];
      let row = r;
      if (prev) {
        if (r.debit !== prev.debit && r.debit !== "") row = { ...r, credit: "" };
        else if (r.credit !== prev.credit && r.credit !== "") row = { ...r, debit: "" };
      }
      if (row.autoBalance && !holdsSuggestion(row, row.autoBalance)) {
        row = { ...row, autoBalance: undefined, autoBalanceValue: undefined };
      }
      return row;
    });
    if (appended.length === 1 && !statistical && !ledgerSnapshot)
      settled = suggestBalancingLine(settled, appended[0]!);
    setRows(settled);
  }

  // Exact bigint totals at 4dp scale. Unparseable input fails closed: it never
  // counts as zero, and both saving and posting are blocked while it stands.
  const { debits, credits, diff, hasInvalidAmounts } = useMemo(() => {
    let d = 0n;
    let c = 0n;
    let invalid = false;
    for (const r of rows) {
      const du = journalAmountUnits(r.debit);
      const cu = journalAmountUnits(r.credit);
      if (du === null || cu === null) {
        invalid = true;
        continue;
      }
      d += du;
      c += cu;
    }
    return { debits: d, credits: c, diff: d - c, hasInvalidAmounts: invalid };
  }, [rows]);
  const statistical = journalMode === "statistical";
  const mixedCurrencies = rows.some(
    (row) => row.journalCurrency && row.journalCurrency !== currency,
  );
  const statisticalReady =
    rows.some((row) => !isBlankJournalLine(row)) &&
    rows
      .filter((row) => !isBlankJournalLine(row))
      .every(
        (row) =>
          !!row.accountId &&
          !!String(row.unit ?? "").trim() &&
          (journalAmountUnits(row.statisticalQuantity) ?? 0n) !== 0n,
      );
  const balanced = statistical
    ? statisticalReady
    : !hasInvalidAmounts && debits > 0n && (mixedCurrencies || diff === 0n);

  // -- explicit save (no autosave) -----------------------------------------
  const payload = useMemo(
    () => ({
      journalMode,
      currency,
      fxRate: fxRate || undefined,
      journalReverseOn: reverseOn || null,
      partyId: partyId || null,
      documentDate: documentDate || undefined,
      referenceNumber,
      memo,
      // Only sent in multi-subsidiary orgs (undefined drops out of the JSON body).
      subsidiaryId: multiSub ? subsidiaryId || null : undefined,
      // Only sent when Multi-book accounting offers a choice.
      accountingBookId: bookUi && canPostBookSpecific ? accountingBookId || null : undefined,
      extraDims,
      custom: customValues,
      // Every contentful row rides — including one missing its account —
      // so the server names the line and refuses instead of the drawer
      // silently booking a smaller journal (OM-09b). Only blank
      // placeholders (no content in any field, amount sides empty or an
      // exact zero leg) are dropped.
      lines: rows.flatMap((r) => {
        if (isBlankJournalLine(r)) return [];
        const signed = journalLineUnits(r.debit, r.credit);
        if (signed === null) return [];
        return [
          {
            accountId: r.accountId,
            amortizationTemplateId: r.amortizationTemplateId || null,
            amortizationStartOn: r.amortizationTemplateId ? r.amortizationStartOn || null : null,
            amortizationEndOn: r.amortizationTemplateId ? r.amortizationEndOn || null : null,
            description: r.description,
            currency: r.journalCurrency || null,
            fxRate: r.journalFxRate || null,
            quantity: statistical ? String(r.statisticalQuantity ?? "") : "1",
            unit: statistical ? String(r.unit ?? "") : null,
            eliminate: r.eliminate === "true",
            amount: statistical ? "0" : formatJournalAmount(signed), // signed: + debit / − credit
            partyId: r.partyId || null,
            departmentId: r.departmentId || null,
            projectId: r.projectId || null,
            // Intercompany line override (multi-subsidiary orgs only).
            subsidiaryId: multiSub ? r.subsidiaryId || null : undefined,
            extraDims: segmentAssignmentsFromCells(
              r,
              segments.map((segment) => segment.key),
            ),
            custom: Object.fromEntries(
              lineDefs
                .map((d) => [d.key, r[`cf_${d.key}`]])
                .filter(([, v]) => v !== "" && v != null),
            ),
          },
        ];
      }),
    }),
    [
      journalMode,
      currency,
      fxRate,
      reverseOn,
      statistical,
      partyId,
      documentDate,
      referenceNumber,
      memo,
      subsidiaryId,
      multiSub,
      accountingBookId,
      bookUi,
      canPostBookSpecific,
      customValues,
      extraDims,
      rows,
      lineDefs,
      segments,
    ],
  );
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render). `editable` is read
  // but deliberately NOT subscribed: the gate fires only when `payload`
  // changes identity, so merely entering edit mode with untouched fields never
  // marks the form dirty (same guarantee as the ref-mirrored gate this
  // replaces, without the effect-body setState).
  const [dirty, setDirty] = useState(false);
  const [historicalTranslationDirty, setHistoricalTranslationDirty] = useState(false);
  const [resetVersion, setResetVersion] = useState(0);
  const [observedResetVersion, setObservedResetVersion] = useState(0);
  const [prevPayload, setPrevPayload] = useState(payload);
  if (prevPayload !== payload) {
    setPrevPayload(payload);
    if (editable && observedResetVersion === resetVersion) setDirty(true);
  }
  if (observedResetVersion !== resetVersion) setObservedResetVersion(resetVersion);

  // A dirty editor never closes silently: the X button (via beforeClose)
  // and Cancel both ask first, so typed work survives a stray click.
  async function confirmDiscard() {
    if (!historicalTranslationDirty && (mode !== "edit" || !dirty)) return true;
    return confirmDialog({
      message: tc("feedback.unsavedChanges"),
      confirmLabel: tc("confirm.discardChanges"),
      tone: "danger",
    });
  }

  async function cancelWithConfirm() {
    if (!(await confirmDiscard())) return;
    cancel();
  }

  // -- optimistic-concurrency fence -----------------------------------------
  // The journal PATCH route refuses any write without an exact revision token.
  // The loader and API return the exact revision counter. Legacy payloads
  // without one stay fenced until the canonical read supplies it.
  const initialRevision = isDocumentRevisionToken(doc.updated_at) ? doc.updated_at : null;
  const [documentRevision, setDocumentRevisionState] = useState<string | null>(initialRevision);
  const documentRevisionRef = useRef<string | null>(initialRevision);
  const seenPersistedRevisions = useRef(new Set<string>());
  const draftBaseline = useRef<PersistedDocumentSnapshot<JournalPayload>>({
    documentId: String(doc.id),
    revision: initialRevision ?? "",
    payload: journal,
  });
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  function setDocumentRevision(revision: string | null) {
    documentRevisionRef.current = revision;
    setDocumentRevisionState(revision);
  }

  /** Reset every field back to an explicit persisted payload (used by Cancel). */
  function resetForm(source: JournalPayload) {
    setResetVersion((version) => version + 1);
    setDirty(false);
    const sourceDoc = asJournalDoc(source.doc);
    setJournalMode(String(sourceDoc.journal_mode ?? "monetary"));
    setCurrency(sourceDoc.currency);
    setFxRate(String(sourceDoc.fx_rate ?? "1"));
    setReverseOn(String(sourceDoc.journal_reverse_on ?? ""));
    setAccountingBookId(String(sourceDoc.accounting_book_id ?? ""));
    setPartyId(sourceDoc.party_id ?? "");
    setDocumentDate(sourceDoc.document_date ?? "");
    setReferenceNumber(sourceDoc.reference_number ?? "");
    setMemo(sourceDoc.memo ?? "");
    setSubsidiaryId(sourceDoc.subsidiary_id ?? "");
    setCustomValues(sourceDoc.custom ?? {});
    setExtraDims(sourceDoc.extra_dims ?? {});
    setRows(
      source.lines.length > 0
        ? source.lines.map((l) => toRow(l, lineDefs, segments))
        : [emptyLine(), emptyLine()],
    );
  }

  /** Adopt a reloaded snapshot as the editor's baseline (drops edits). */
  function adoptReload(incoming: PersistedDocumentSnapshot<JournalPayload>) {
    draftBaseline.current = incoming;
    seenPersistedRevisions.current.add(incoming.revision);
    resetForm(incoming.payload);
    setDocumentRevision(incoming.revision);
    setDirty(false);
    setSaveState("saved");
    setMode("view");
  }

  /** Apply one canonical read: adopt when clean, pin the newer exact token
   *  under dirty-but-unchanged content, reload-and-review when content moved. */
  function applyCanonicalRead(
    incoming: PersistedDocumentSnapshot<JournalPayload>,
    notifyOnConflict = true,
  ) {
    const decision = reconcileCanonicalDraftRead({
      current: draftBaseline.current,
      incoming,
      isDirty: dirtyRef.current,
    });
    if (decision.action === "adopt") {
      draftBaseline.current = decision.snapshot;
      seenPersistedRevisions.current.add(decision.snapshot.revision);
      resetForm(decision.snapshot.payload);
      setDocumentRevision(decision.snapshot.revision);
    } else if (decision.action === "pin") {
      seenPersistedRevisions.current.add(decision.revision);
      draftBaseline.current = { ...draftBaseline.current, revision: decision.revision };
      setDocumentRevision(decision.revision);
    } else {
      // Dropping stale edits beats blessing them with the newer token — that
      // would recreate the silent last-write-wins this fence exists to stop.
      adoptReload(decision.snapshot);
      if (notifyOnConflict) toast.error(DOCUMENT_CHANGED_AFTER_OPEN);
    }
  }

  // Effect-only bridge: the mount fetch must rerun on doc change, not on
  // every render (applyCanonicalRead closes over per-render props like
  // lineDefs), while save/void paths keep calling the plain function from
  // their event handlers.
  const applyCanonicalReadOnMount = useEffectEvent(
    (incoming: PersistedDocumentSnapshot<JournalPayload>) => applyCanonicalRead(incoming),
  );

  async function refreshFromServer(
    notifyOnConflict = true,
  ): Promise<PersistedDocumentSnapshot<JournalPayload>> {
    const incoming = await loadDraftDocumentSnapshot(`/api/journals/${doc.id}`, t("postFailed"));
    if (ledgerSnapshot) {
      // Refresh the document fence without replacing immutable ledger lines
      // with the source document's editable transaction-currency lines.
      setDocumentRevision(incoming.revision);
      return incoming;
    }
    applyCanonicalRead(incoming, notifyOnConflict);
    return incoming;
  }

  useEffect(() => {
    // Unsaved-create has no persisted row to read: there is no revision to
    // pin and nothing to reconcile. Skipped entirely — zero reads that could
    // 404, zero writes by construction.
    if (createMode || ledgerSnapshot) return;
    let active = true;
    loadDraftDocumentSnapshot(`/api/journals/${doc.id}`, t("postFailed"))
      .then((incoming) => {
        if (active) applyCanonicalReadOnMount(incoming);
      })
      .catch(() => {
        // Saves stay fenced off until a canonical read lands; the next save
        // attempt retries it.
      });
    return () => {
      active = false;
    };
  }, [doc.id, t, createMode, ledgerSnapshot]);

  /**
   * Unsaved-create Save: one idempotent POST carrying the whole journal —
   * header plus lines. The key is minted once per drawer session, so a
   * double-click or a retried request returns the same journal instead of a
   * duplicate. Cancel/close before this point wrote nothing — this is the
   * first and only write, and the JE- number is allocated inside it.
   */
  // A contentful row without an account can never book: the server names
  // the line and refuses. Refuse up front with the grid line named and keep
  // every entered row in place — dropping the row here used to book a
  // journal the operator never reviewed (OM-09b).
  const refuseMissingAccount = (): boolean => {
    const missingAccount = findMissingJournalAccountLine(rows);
    if (!missingAccount) return false;
    refuse(t("lineMissingAccount", { line: missingAccount.lineNumber }), t("postFailed"));
    setSaveState("error");
    return true;
  };

  // Unparseable amounts never reach the payload builder as a smaller
  // journal: Save refuses while any amount is unreadable, whichever path
  // (button or keyboard) asked for it.
  const refuseInvalidAmounts = (): boolean => {
    if (!hasInvalidAmounts) return false;
    refuse(t("invalidAmounts"), t("postFailed"));
    setSaveState("error");
    return true;
  };

  /** Open the next unsaved journal on the same entry date. */
  function startNextJournal(entryDate: string) {
    const href = freshJournalHref(returnHref, entryDate);
    if (createMode) {
      // Same URL shape: remount the editor in place instead of relying on
      // a navigation that would keep this session's state and key.
      onStartFresh(entryDate);
      router.replace(href as never);
    } else {
      router.push(href as never);
    }
  }

  async function saveNew(then: SaveThen) {
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    if (refuseMissingAccount() || refuseInvalidAmounts()) return;
    const entryDate = documentDate;
    setSaveState("saving");
    const ok = await execute(
      async () => {
        const result = await fetchAppAction(
          "/api/journals",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": requestIdRef.current!,
            },
            body: JSON.stringify(payload),
          },
          { fallback: t("postFailed") },
        );
        if (!result.ok) return result;
        // A success that names no entry is not a saved journal: refuse and keep
        // the form. The idempotency key is retained, so a retry replays the same
        // journal instead of creating a second one.
        const createdId = (result.data as { doc?: { id?: unknown } } | null)?.doc?.id;
        if (typeof createdId !== "string" || createdId === "") {
          return {
            ok: false,
            error: new ActionError({ kind: "refused", serverMessage: t("createUnconfirmed") }),
          };
        }
        return result;
      },
      {
        fallbackMessage: t("postFailed"),
        onOk: (data) => {
          const created = (data as { doc: { id: string; document_number?: unknown } }).doc;
          setSaveState("saved");
          setDirty(false);
          if (then === "new" || then === "close") {
            // The created journal is not on screen: name it.
            toast.success(
              t("savedNumbered", {
                number: typeof created.document_number === "string" ? created.document_number : "",
              }),
            );
            if (then === "new") startNextJournal(entryDate);
            else router.push(returnHref as never);
          } else {
            const separator = returnHref.includes("?") ? "&" : "?";
            router.replace(`${returnHref}${separator}entry=${created.id}` as never);
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

  /**
   * Explicit save. `then` names where the operator goes next: stay on the
   * saved journal, open a fresh one on the same date, or close the drawer.
   * Guarded against re-entry so a held shortcut cannot send the write twice.
   */
  // One run at a time: a second press while the first is still saving or
  // posting is ignored rather than sending the same write twice.
  async function save(then: SaveThen = "view") {
    if (saveRunning.current) return;
    saveRunning.current = true;
    try {
      if (createMode) {
        await saveNew(then);
        return;
      }
      if (refuseMissingAccount() || refuseInvalidAmounts()) return;
      const entryDate = documentDate;
      setSaveState("saving");
      if (documentRevisionRef.current == null) await refreshFromServer(false).catch(() => {});
      const revision = documentRevisionRef.current;
      if (revision == null) {
        setSaveState("error");
        refuse(null, t("postFailed"));
        return;
      }
      const ok = await execute(
        async () => {
          const outcome = await saveJournalDraft({
            documentId: String(doc.id),
            revision,
            payload,
            fallbackMessage: t("postFailed"),
          });
          // saveJournalDraft reports messages, not wire statuses: the saved
          // branch is exact (the journals PATCH answers 200), the refusal
          // branches carry the routing in their kind instead.
          if (outcome.status === "saved") return { ok: true, status: 200, data: outcome } as const;
          if (outcome.status === "conflict") {
            await refreshFromServer(false).catch(() => {});
            return {
              ok: false,
              error: new ActionError({ kind: "conflict", serverMessage: outcome.message }),
            };
          }
          // saveJournalDraft reports messages, not statuses: every non-conflict
          // failure classifies as a domain refusal. The message always renders
          // either way; only log-worthy routing differs.
          return {
            ok: false,
            error: new ActionError({ kind: "refused", serverMessage: outcome.message }),
          };
        },
        {
          fallbackMessage: t("postFailed"),
          onOk: (outcome) => {
            const savedJournal = outcome.saved;
            draftBaseline.current = {
              documentId: String(savedJournal.doc.id),
              revision: outcome.revision,
              payload: savedJournal,
            };
            seenPersistedRevisions.current.add(outcome.revision);
            resetForm(savedJournal);
            setDocumentRevision(outcome.revision);
            setSaveState("saved");
            setDirty(false);
            setMode("view");
            if (then === "new") startNextJournal(entryDate);
            else if (then === "close") router.push(returnHref as never);
          },
          onRefused: () => {
            setSaveState("error");
          },
        },
      );
      if (ok) router.refresh();
    } finally {
      saveRunning.current = false;
    }
  }

  function cancel() {
    // Unsaved-create Cancel writes nothing: there is no persisted row to
    // restore, so leave the URL (and the database) exactly as found.
    if (createMode) {
      clearRefusal();
      router.push(returnHref as never);
      return;
    }
    resetForm(draftBaseline.current.payload);
    setDirty(false);
    setSaveState("saved");
    clearRefusal();
    setMode("view");
  }

  /** The post action's answer: approval routing plus any posted-with-warnings advisories. */
  type PostResponse = {
    pendingApproval?: boolean;
    warnings?: (
      | {
          code: "partyless_control_lines";
          accounts: { accountNumber: string | null; accountName: string }[];
        }
      | {
          code: "budgetary_control_advisory";
          overages: {
            scenarioName: string;
            accountNumber: string;
            accountName: string;
            fundCode: string;
            fundName: string;
            subsidiaryName: string;
            departmentName: string | null;
            projectName: string | null;
            locationName: string | null;
            className: string | null;
            extraDims: Record<string, unknown>;
            available: string;
            amountOver: string;
          }[];
        }
      | { code: string }
    )[];
  };

  /** Operator copy for every advisory a successful post reported. */
  function postWarningMessages(posted: PostResponse): string[] {
    const pinned: string[] = [];
    const partyless = (posted.warnings ?? []).find((w) => w.code === "partyless_control_lines");
    if (partyless && "accounts" in partyless && partyless.accounts.length > 0) {
      pinned.push(
        t("partylessControlWarning", {
          accounts: partyless.accounts
            .map((a) => `${a.accountNumber ?? ""} ${a.accountName}`.trim())
            .join(", "),
        }),
      );
    }
    // Advisory budgetary-control overages post legitimately: the entry
    // IS posted, and each overage pins here with its remedy instead of
    // accepting the journal silently. Hard control still refuses
    // pre-commit and never reaches this response.
    const advisory = (posted.warnings ?? []).find((w) => w.code === "budgetary_control_advisory");
    if (advisory && "overages" in advisory) {
      for (const overage of advisory.overages) {
        // Every applicable named dimension stays visible: names that
        // do not apply are omitted rather than rendered blank.
        const dimensionNames = [
          overage.departmentName,
          overage.projectName,
          overage.locationName,
          overage.className,
          ...Object.keys(overage.extraDims ?? {})
            .filter(
              (key) =>
                key !== "fund" &&
                ["string", "number", "boolean"].includes(
                  typeof (overage.extraDims as Record<string, unknown>)[key],
                ),
            )
            .sort()
            .map((key) => `${key}: ${String((overage.extraDims as Record<string, unknown>)[key])}`),
        ].filter((name): name is string => !!name);
        pinned.push(
          `${t("budgetaryControlWarning", {
            scenario: overage.scenarioName,
            account: `${overage.accountNumber} ${overage.accountName}`.trim(),
            fund: `${overage.fundCode} ${overage.fundName}`.trim(),
            subsidiary: overage.subsidiaryName,
            dimensions: dimensionNames.length > 0 ? ` (${dimensionNames.join(" · ")})` : "",
            available: overage.available,
            amountOver: overage.amountOver,
          })} ${t("budgetaryControlRemedy")}`,
        );
      }
    }
    return pinned;
  }

  /** The one post request: the journal action route with the exact revision fence. */
  function requestPost(documentId: string, expectedUpdatedAt: string) {
    return fetchAppAction(
      "/api/journals/actions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "post", documentId, expectedUpdatedAt }),
      },
      { fallback: t("postFailed") },
    );
  }

  async function post() {
    setPostWarnings([]);
    // Post fences on the revision this editor holds: the token the last save
    // returned (or a canonical read). A post that cannot name its revision
    // refuses rather than posting an unfenced draft.
    if (documentRevisionRef.current == null) await refreshFromServer(false).catch(() => {});
    const postRevision = documentRevisionRef.current;
    if (postRevision == null) {
      refuse(null, t("postFailed"));
      return;
    }
    const ok = await execute(() => requestPost(String(doc.id), postRevision), {
      fallbackMessage: t("postFailed"),
      onOk: async (data) => {
        const posted = data as PostResponse;
        // Posting commits a new documents.revision_seq (migration 0167 bumps it
        // on EVERY update): re-pin the canonical token now, or the next fenced
        // write in this session (void) 409s on the pre-post revision. The
        // header adopts the post's own result, so a list refresh that predates
        // the commit cannot show the journal as still a draft.
        const readBack = await refreshFromServer(false).catch(() => null);
        setLiveDoc(
          readBack
            ? asJournalDoc(readBack.payload.doc)
            : {
                ...doc,
                status: posted.pendingApproval ? "pending_approval" : "posted",
                updated_at: postRevision,
              },
        );
        if (posted.pendingApproval) toast.success(tc("actions.submitForApproval"));
        else toast.success(t("postedToast"));
        setPostWarnings(postWarningMessages(posted));
      },
    });
    if (ok) router.refresh();
  }

  // Keyboard posting is offered wherever Post is: a draft (or approved)
  // source journal the viewer may post, plus the unsaved create and the
  // draft editor, which persist first through their ordinary save. Post &
  // new also needs the right to open the next journal.
  const canKeyboardPost =
    canPost &&
    sourceDocument &&
    !ledgerSnapshot &&
    (createMode || isDraft || doc.status === "approved");
  const canPostAndNew = canKeyboardPost && canCreate;

  /**
   * Post this journal from the keyboard and, for `then === 'new'`, open the
   * next one on the same date — the heads-down batch path. Unsaved work
   * persists first through the same create or fenced save the Save button
   * runs; the post then runs the journal post action with the revision
   * that write returned, so every
   * refusal (period, balance, permissions, approval routing) applies
   * unchanged. When a Flow routes the journal for approval the server
   * submits it instead of posting, and the toast says so. A refusal keeps
   * the operator on this journal (saved as a draft when the create already
   * committed). A post that reports advisories stays on the posted journal
   * so they are read, not skipped.
   */
  // One run at a time: a second press while the first is still saving or
  // posting is ignored rather than sending the same write twice.
  async function postFromKeyboard(then: "new" | "stay") {
    if (postFromKeyboardRunning.current) return;
    postFromKeyboardRunning.current = true;
    try {
      if (!(then === "new" ? canPostAndNew : canKeyboardPost)) return;
      if (refuseInvalidAmounts()) return;
      if (editable && refuseMissingAccount()) return;
      if (!balanced) {
        refuse(
          statistical
            ? t("statisticalIncomplete")
            : diff !== 0n && !mixedCurrencies
              ? t("outOfBalance", { amount: money(formatJournalAmount(diff < 0n ? -diff : diff)) })
              : t("postNeedsAmounts"),
          t("postFailed"),
        );
        return;
      }
      setPostWarnings([]);
      const entryDate = documentDate;
      const progress: {
        createdId: string | null;
        saved: { journal: JournalPayload; revision: string } | null;
        documentId: string;
        revision: string | null;
      } = {
        createdId: null,
        saved: null,
        documentId: String(doc.id),
        revision: documentRevisionRef.current,
      };
      let posted: PostResponse | null = null;
      const persistsFirst = createMode || (editable && dirty);
      setSaveState("saving");
      const ok = await execute(
        async () => {
          if (createMode) {
            if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
            const created = await fetchAppAction(
              "/api/journals",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": requestIdRef.current,
                },
                body: JSON.stringify(payload),
              },
              { fallback: t("postFailed") },
            );
            if (!created.ok) return created;
            const createdDoc = (
              created.data as { doc?: { id?: unknown; updated_at?: unknown } } | null
            )?.doc;
            if (typeof createdDoc?.id !== "string" || createdDoc.id === "") {
              return {
                ok: false,
                error: new ActionError({ kind: "refused", serverMessage: t("createUnconfirmed") }),
              };
            }
            progress.createdId = createdDoc.id;
            progress.documentId = createdDoc.id;
            progress.revision = isDocumentRevisionToken(createdDoc.updated_at)
              ? createdDoc.updated_at
              : null;
            if (progress.revision == null) {
              const readBack = await loadDraftDocumentSnapshot(
                `/api/journals/${createdDoc.id}`,
                t("postFailed"),
              ).catch(() => null);
              progress.revision = readBack?.revision ?? null;
            }
          } else if (editable && dirty) {
            if (progress.revision == null) {
              await refreshFromServer(false).catch(() => {});
              progress.revision = documentRevisionRef.current;
            }
            if (progress.revision == null)
              return {
                ok: false,
                error: new ActionError({ kind: "refused", serverMessage: t("postFailed") }),
              };
            const outcome = await saveJournalDraft({
              documentId: progress.documentId,
              revision: progress.revision,
              payload,
              fallbackMessage: t("postFailed"),
            });
            if (outcome.status === "conflict") {
              await refreshFromServer(false).catch(() => {});
              return {
                ok: false,
                error: new ActionError({ kind: "conflict", serverMessage: outcome.message }),
              };
            }
            if (outcome.status !== "saved") {
              return {
                ok: false,
                error: new ActionError({ kind: "refused", serverMessage: outcome.message }),
              };
            }
            progress.saved = { journal: outcome.saved, revision: outcome.revision };
            progress.revision = outcome.revision;
          } else if (progress.revision == null) {
            await refreshFromServer(false).catch(() => {});
            progress.revision = documentRevisionRef.current;
          }
          if (progress.revision == null) {
            return {
              ok: false,
              error: new ActionError({ kind: "refused", serverMessage: t("postFailed") }),
            };
          }
          return requestPost(progress.documentId, progress.revision);
        },
        {
          fallbackMessage: t("postFailed"),
          onOk: (data) => {
            posted = data as PostResponse;
          },
        },
      );
      const saved = progress.saved;
      if (saved) {
        // The edits committed even if the post did not: adopt them as the baseline.
        draftBaseline.current = {
          documentId: String(saved.journal.doc.id),
          revision: saved.revision,
          payload: saved.journal,
        };
        seenPersistedRevisions.current.add(saved.revision);
        resetForm(saved.journal);
        setDocumentRevision(saved.revision);
        setDirty(false);
        setMode("view");
      }
      // Only a write that failed leaves the editor in its error state; a
      // refused post of a saved journal leaves the save itself standing.
      setSaveState(ok || saved || progress.createdId || !persistsFirst ? "saved" : "error");
      const answer = posted as PostResponse | null;
      if (!ok || !answer) {
        if (progress.createdId) {
          // The create committed and the post refused: open the saved draft so
          // the refusal can be resolved there; the refusal toast names why.
          setDirty(false);
          toast.warning(t("savedNotPosted"));
          const separator = returnHref.includes("?") ? "&" : "?";
          router.replace(`${returnHref}${separator}entry=${progress.createdId}` as never);
        }
        router.refresh();
        return;
      }
      const warnings = postWarningMessages(answer);
      setDirty(false);
      if (then === "new" && warnings.length === 0) {
        toast.success(answer.pendingApproval ? t("submittedAndNew") : t("postedAndNew"));
        startNextJournal(entryDate);
        router.refresh();
        return;
      }
      // Stay on the posted (or submitted) journal; advisories stay readable.
      toast.success(answer.pendingApproval ? t("submitted") : t("postedToast"));
      if (progress.createdId) {
        for (const warning of warnings) toast.warning(warning);
        const separator = returnHref.includes("?") ? "&" : "?";
        router.replace(`${returnHref}${separator}entry=${progress.createdId}` as never);
      } else {
        const readBack = await refreshFromServer(false).catch(() => null);
        if (readBack) setLiveDoc(asJournalDoc(readBack.payload.doc));
        setPostWarnings(warnings);
      }
      router.refresh();
    } finally {
      postFromKeyboardRunning.current = false;
    }
  }
  const postShortcuts = {
    postAndNew: canPostAndNew ? () => void postFromKeyboard("new") : undefined,
    post: canKeyboardPost ? () => void postFromKeyboard("stay") : undefined,
  };

  async function remove() {
    if (
      !(await confirmDialog({
        title: t("deleteTitle"),
        message: t("deleteDraftBody"),
        confirmLabel: tc("actions.delete"),
        tone: "danger",
      }))
    )
      return;
    await execute(
      async () => {
        // The delete API fences on the exact revision like every other
        // document write: without it the delete is refused and the button is
        // dead. The token is the editor's canonical revision.
        if (documentRevisionRef.current == null) await refreshFromServer(false).catch(() => {});
        const deleteRevision = documentRevisionRef.current;
        if (deleteRevision == null)
          return { ok: false, error: new ActionError({ kind: "refused" }) };
        return fetchAppAction(
          `/api/journals/${doc.id}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedUpdatedAt: deleteRevision }),
          },
          { fallback: t("deleteFailed") },
        );
      },
      {
        fallbackMessage: t("deleteFailed"),
        successMessage: t("deleted"),
        onOk: () => {
          router.push("/journal");
          router.refresh();
        },
      },
    );
  }

  // A terminal posting-effect failure blocks Void until the effect is replayed
  // with a review reason. The same governed action the document drawer uses.
  async function retryPostingEffects() {
    const reason = await promptDialog({
      title: tc("postingEffects.retry"),
      label: tc("postingEffects.reason"),
      placeholder: tc("postingEffects.reasonHelp"),
    });
    if (reason === null) return;
    if (reason.trim().length < 10 || reason.trim().length > 1000) {
      refuse(tc("postingEffects.reasonHelp"), t("postFailed"));
      return;
    }
    await execute(
      () =>
        fetchAppAction(
          "/api/documents/actions",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "retry-effects", documentId: doc.id, reason }),
          },
          { fallback: t("postFailed") },
        ),
      {
        fallbackMessage: t("postFailed"),
        successMessage: tc("postingEffects.queued"),
        onOk: () => {
          onLedgerRefresh?.();
          router.refresh();
        },
      },
    );
  }

  async function voidJournal() {
    const reason = await promptDialog({
      title: tc("amendment.voidTitle"),
      label: tc("amendment.reason"),
      placeholder: tc("amendment.voidPlaceholder"),
      confirmLabel: tc("actions.void"),
    });
    if (!reason) return;
    const reversal = await promptVoidReversalPeriod(doc.id, {
      title: tc("amendment.voidReversalPeriodTitle"),
      dateLabel: tc("amendment.voidReversalDateLabel"),
      summaryOriginal: tc("amendment.voidReversalSummaryOriginal"),
      summaryReversal: tc("amendment.voidReversalSummaryReversal"),
      fiscalYear: tc("amendment.voidReversalFiscalYear"),
      fallbackNotice: tc("amendment.voidReversalFallbackNotice"),
      closedNotice: tc("amendment.voidReversalClosedNotice"),
      label: tc("amendment.voidReversalPeriodLabel"),
      regularOption: tc("amendment.voidReversalPeriodRegular"),
      confirm: tc("actions.void"),
      cancel: tc("confirm.cancel"),
    });
    if (reversal.cancelled) return;
    await execute(
      async () => {
        // The void API fences on the exact revision like every other document
        // write: without it every void answers 409 and the button is dead. The
        // token is the editor's canonical revision (never the lossy RSC Date).
        // The void lookup above returned the revision it priced the reversal
        // against; it is the token when the editor holds none (a posted
        // journal opened read-only never loaded one).
        if (documentRevisionRef.current == null && reversal.revision == null)
          await refreshFromServer(false).catch(() => {});
        const voidRevision = documentRevisionRef.current ?? reversal.revision;
        if (voidRevision == null) {
          return {
            ok: false,
            error: new ActionError({
              kind: "refused",
              serverMessage: t("voidRevisionUnavailable"),
            }),
          };
        }
        const result = await fetchAppAction(
          `/api/documents/${doc.id}/void`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reason,
              expectedUpdatedAt: voidRevision,
              ...(reversal.reversalDate ? { reversalDate: reversal.reversalDate } : {}),
              ...(reversal.reversalPeriodId ? { reversalPeriodId: reversal.reversalPeriodId } : {}),
            }),
          },
          { fallback: t("postFailed") },
        );
        if (!result.ok && result.error.code === "stale-revision") {
          // A stale revision means the re-pin raced a concurrent write:
          // reload the canonical revision and say so in translated copy.
          // The server sentence leaks the revision-token mechanism, and the
          // recovery (reload) already happened here, so the message must
          // describe what happened, not quote the refusal.
          await refreshFromServer(false).catch(() => {});
          return {
            ok: false,
            error: new ActionError({
              kind: "conflict",
              code: "stale-revision",
              serverMessage: t("voidStaleRevision"),
            }),
          };
        }
        return result;
      },
      {
        fallbackMessage: t("postFailed"),
        onOk: (data) => {
          const status = (data as { status?: unknown } | null)?.status;
          if (status === "pending_approval") toast.success(tc("actions.submitForApproval"));
          else toast.success(tc("status.voided"));
          onLedgerRefresh?.();
        },
      },
    );
    router.refresh();
  }

  // -- grid columns ----------------------------------------------------------
  const columns = useMemo<LineGridColumn<LineRow>[]>(() => {
    const builtIn: Record<string, LineGridColumn<LineRow>> = {
      account_id: {
        key: "accountId",
        label: tc("labels.account"),
        width: "minmax(200px,2fr)",
        type: "search-select",
        required: true,
        options: accounts.map((a) => ({
          value: a.id,
          label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
        })),
        placeholder: t("accountPlaceholder"),
      },
      description: {
        key: "description",
        label: tc("labels.description"),
        width: "minmax(160px,1.6fr)",
        type: "text",
      },
      // Line-level entity: the customer/vendor/employee this leg belongs to.
      // Required on AR/AP legs — the kernel refuses a party-less open-item
      // line; projects stay a sibling
      // column, exactly like the party/project kernel dimensions.
      party_id: {
        key: "partyId",
        label: tc("labels.party"),
        width: "minmax(150px,1.2fr)",
        type: "search-select",
        options: parties.map((p) => ({ value: p.id, label: p.display_name ?? p.name ?? "" })),
        placeholder: "—",
      },
      department_id: {
        key: "departmentId",
        label: tc("labels.department"),
        width: "140px",
        type: "select",
        options: [
          { value: "", label: "—" },
          ...departments.map((d) => ({ value: d.id, label: d.name ?? "" })),
        ],
      },
      project_id: {
        key: "projectId",
        label: tc("labels.project"),
        width: "minmax(150px,1.2fr)",
        type: "search-select",
        options: projects.map((p) => ({ value: p.id, label: p.name ?? "" })),
        placeholder: "—",
      },
      // Optional per-line subsidiary override — the intercompany journal
      // surface ('' = the header's subsidiary; posting auto-balances
      // cross-subsidiary lines via due-to/due-from pairs).
      ...(multiSub
        ? {
            subsidiary_id: {
              key: "subsidiaryId",
              label: tc("labels.subsidiary"),
              width: "150px",
              type: "select",
              options: [{ value: "", label: "—" }, ...subsidiaryOpts],
            } satisfies LineGridColumn<LineRow>,
          }
        : {}),
      debit: {
        key: "debit",
        label: t("columns.debit"),
        width: "120px",
        type: "amount",
        align: "right",
        render: ledgerSnapshot
          ? (row) =>
              row.debit ? money(row.debit, { currency: String(row.functionalCurrency) }) : ""
          : undefined,
      },
      credit: {
        key: "credit",
        label: t("columns.credit"),
        width: "120px",
        type: "amount",
        align: "right",
        render: ledgerSnapshot
          ? (row) =>
              row.credit ? money(row.credit, { currency: String(row.functionalCurrency) }) : ""
          : undefined,
      },
    };
    const custom = new Map(
      customFieldColumns<LineRow>(lineDefs).map((column) => [column.key, column]),
    );
    const segmentColumns: LineGridColumn<LineRow>[] = segments
      .filter((segment) => segment.showOnLines)
      .map((segment) => ({
        key: `seg_${segment.key}`,
        label: segment.name,
        width: "150px",
        type: "search-select",
        options: [
          { value: INHERIT_SEGMENT, label: tc("labels.inheritHeader") },
          { value: CLEAR_SEGMENT, label: tc("labels.noDimensionValue") },
          ...segment.values.map((value) => ({
            value: value.id,
            label: `${value.code ? `${value.code} · ` : ""}${value.name}`,
          })),
        ],
        placeholder: "—",
      }));
    const instructionColumns: LineGridColumn<LineRow>[] = statistical
      ? [
          {
            key: "statisticalQuantity",
            label: t("instructions.quantity"),
            width: "120px",
            type: "decimal",
            decimalScale: 4,
            required: true,
          },
          {
            key: "unit",
            label: t("instructions.unit"),
            width: "120px",
            type: "text",
            required: true,
          },
        ]
      : [
          {
            key: "journalCurrency",
            label: t("instructions.lineCurrency"),
            width: "110px",
            type: "text",
            secondary: true,
          },
          {
            key: "journalFxRate",
            label: t("instructions.lineRate"),
            width: "130px",
            type: "decimal",
            decimalScale: 10,
            secondary: true,
          },
          ...(multiSub
            ? [
                {
                  key: "eliminate",
                  label: t("instructions.eliminate"),
                  width: "110px",
                  type: "select" as const,
                  secondary: true,
                  options: [
                    { value: "", label: t("instructions.keep") },
                    { value: "true", label: t("instructions.eliminate") },
                  ],
                },
              ]
            : []),
        ];
    if (statistical) {
      delete builtIn.debit;
      delete builtIn.credit;
    }
    const prepaidColumns =
      ledgerSnapshot || statistical
        ? []
        : amortizationLineColumns<LineRow>(amortizationTemplates, tAmortization);
    if (!layout)
      return [
        ...Object.values(builtIn),
        ...instructionColumns,
        ...segmentColumns,
        ...prepaidColumns,
        ...custom.values(),
      ];
    const configured = layout.lines.columns.flatMap((placement) => {
      if (!placement.visible) return [];
      const base = isCustomFieldKey(placement.key)
        ? custom.get(placement.key)
        : builtIn[placement.key];
      if (!base) return [];
      return [
        {
          ...base,
          width: placement.width ?? base.width,
          label: placement.labelOverride?.trim() || base.label,
        },
      ];
    });
    return [...configured, ...instructionColumns, ...segmentColumns, ...prepaidColumns];
  }, [
    statistical,
    accounts,
    departments,
    projects,
    parties,
    multiSub,
    subsidiaryOpts,
    lineDefs,
    segments,
    layout,
    t,
    tc,
    ledgerSnapshot,
    money,
    amortizationTemplates,
    tAmortization,
  ]);

  // -- auto-balance ------------------------------------------------------------
  // The grid addresses cells by their position among its visible columns.
  // Secondary (detail) columns can be hidden, so a position is trusted only
  // while no secondary column precedes it; otherwise the suggestion is skipped.
  const amountColumnIndex = (key: AmountSide): number => {
    const index = columns.findIndex((column) => column.key === key);
    if (index < 0 || columns.slice(0, index).some((column) => column.secondary)) return -1;
    return index;
  };
  const amountInput = (rowIndex: number, side: AmountSide): HTMLInputElement | null => {
    const column = amountColumnIndex(side);
    if (column < 0) return null;
    return (
      gridRef.current?.querySelector<HTMLInputElement>(
        `[data-lg-row="${rowIndex}"][data-lg-col="${column}"] input`,
      ) ?? null
    );
  };
  /** Select a suggested amount once it renders, so typing replaces it. */
  const selectAmountWhenFocused = (rowIndex: number, side: AmountSide) => {
    requestAnimationFrame(() => {
      const input = amountInput(rowIndex, side);
      if (input && document.activeElement === input) input.select();
    });
  };
  const autoBalanceActive = editable && !statistical && !ledgerSnapshot;

  function handleGridFocus(event: FocusEvent<HTMLDivElement>) {
    const cell = (event.target as HTMLElement).closest?.("[data-lg-row]");
    if (!cell || !gridRef.current?.contains(cell)) return;
    const rowIndex = Number(cell.getAttribute("data-lg-row"));
    if (!Number.isInteger(rowIndex)) return;
    focusedRowRef.current = rowIndex;
    if (!autoBalanceActive) return;
    const column = Number(cell.getAttribute("data-lg-col"));
    const side: AmountSide | null =
      column === amountColumnIndex("debit")
        ? "debit"
        : column === amountColumnIndex("credit")
          ? "credit"
          : null;
    if (!side) return;
    // Entering the amounts of a blank line while the entry is out of
    // balance pre-enters the difference on the side that levels it.
    const next = suggestBalancingLine(rows, rowIndex);
    const row = next[rowIndex];
    if (!row) return;
    if (next === rows) {
      if (holdsSuggestion(row, side)) selectAmountWhenFocused(rowIndex, side);
      return;
    }
    if (sameAmount(row[side], rows[rowIndex]?.[side])) {
      setRows(next);
      return;
    }
    // The focused cell holds its own editing text while it has focus, so the
    // suggestion for this very cell is entered through it, exactly like
    // typing, and then selected so the next keystroke replaces it.
    if ((event.target as HTMLElement).tagName !== "INPUT") return;
    const field = event.target as HTMLInputElement;
    requestAnimationFrame(() => {
      if (document.activeElement !== field) return;
      const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
      const EventCtor = field.ownerDocument.defaultView?.Event ?? Event;
      if (!setValue) return;
      pendingSuggestion.current = { index: rowIndex, side, row };
      try {
        setValue.call(field, entryText(row[side]));
        field.dispatchEvent(new EventCtor("input", { bubbles: true }));
      } finally {
        pendingSuggestion.current = null;
      }
      field.select();
    });
  }

  /** Put the remaining difference on the line the operator last worked in. */
  function balanceFocusedLine() {
    // A cell that still has focus holds its own editing text; let it settle
    // first so the balanced amount is what the line shows afterwards.
    const active = document.activeElement as HTMLElement | null;
    if (active && gridRef.current?.contains(active)) active.blur();
    let index = focusedRowRef.current ?? -1;
    let base = rows;
    if (index < 0 || index >= rows.length) {
      index = rows.findIndex(
        (row) => isBlankJournalLine(row) && blankAmount(row.debit) && blankAmount(row.credit),
      );
    }
    if (index < 0) {
      base = [...rows, emptyLine()];
      index = base.length - 1;
    }
    const next = balanceLineAt(base, index);
    setRows(next);
    focusedRowRef.current = index;
    const row = next[index];
    const side: AmountSide | null = row?.debit ? "debit" : row?.credit ? "credit" : null;
    if (!side) return;
    requestAnimationFrame(() => {
      const input = amountInput(index, side);
      if (!input) return;
      input.focus();
      input.select();
    });
  }
  const canBalanceLine = autoBalanceActive && !mixedCurrencies && !hasInvalidAmounts && diff !== 0n;

  // -- more options --------------------------------------------------------------
  // Date, Reference and Memo lead the header; mode, currency, rate,
  // auto-reverse, party and book sit in one disclosure that opens by itself
  // whenever any of them holds a non-default value.
  const partyPlacement = layout?.header.groups
    .flatMap((group) => group.fields)
    .find((placement) => placement.key === "party_id");
  const showParty = layout ? Boolean(partyPlacement?.visible) : true;
  const partyLabel = partyPlacement?.labelOverride?.trim() || tc("labels.party");
  const mainLayout = useMemo<FormLayoutConfig | undefined>(
    () =>
      layout
        ? {
            ...layout,
            header: {
              ...layout.header,
              groups: layout.header.groups.map((group) => ({
                ...group,
                fields: group.fields.filter((placement) => placement.key !== "party_id"),
              })),
            },
          }
        : undefined,
    [layout],
  );
  const homeSubsidiary =
    (subsidiaries ?? []).find((option) => option.id === (subsidiaryId || doc.subsidiary_id)) ??
    subsidiaries?.[0];
  const optionsNonDefault =
    journalOptionsAreNonDefault({
      journalMode,
      currency,
      defaultCurrency: homeSubsidiary?.baseCurrency ?? orgCurrency,
      fxRate,
      reverseOn,
      partyId: showParty ? partyId : "",
      accountingBookId: bookUi ? accountingBookId : "",
    }) ||
    (editable && showParty && partyPlacement?.required === true);
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(optionsNonDefault);
  const [observedNonDefault, setObservedNonDefault] = useState(optionsNonDefault);
  if (observedNonDefault !== optionsNonDefault) {
    setObservedNonDefault(optionsNonDefault);
    if (optionsNonDefault) setMoreOptionsOpen(true);
  }

  const field = "space-y-1.5";
  const headerDefByKey = new Map(headerDefs.map((def) => [def.key, def]));
  const renderHeaderField = (placement: HeaderFieldPlacement, isEditable: boolean) => {
    const override = placement.labelOverride?.trim();
    if (isCustomFieldKey(placement.key)) {
      const def = headerDefByKey.get(customFieldDefKey(placement.key));
      return def ? (
        <CustomFieldInput
          def={{
            ...def,
            label: override || def.label,
            isRequired: placement.required ?? def.isRequired,
          }}
          value={customValues[def.key]}
          onChange={(value) => setCustomValues((current) => ({ ...current, [def.key]: value }))}
          readOnly={!isEditable}
        />
      ) : null;
    }
    switch (placement.key) {
      case "document_date":
        return (
          <>
            <Label>
              {override || tc("labels.date")}
              {isEditable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {isEditable ? (
              <DateField
                data-autofocus=""
                value={documentDate}
                onChange={(value) => setDocumentDate(value)}
              />
            ) : (
              <p className="text-sm">
                {doc.document_date ? formatCivilDate(doc.document_date, locale) : "—"}
              </p>
            )}
          </>
        );
      case "party_id":
        return (
          <>
            <Label>{override || tc("labels.party")}</Label>
            {isEditable ? (
              <SearchSelect
                options={parties.map((party) => ({
                  value: party.id,
                  label: party.display_name ?? "",
                }))}
                value={partyId}
                onChange={(value) => setPartyId(value ?? "")}
                placeholder={t("noParty")}
                clearable
                emptyLabel={t("noParty")}
              />
            ) : (
              <p className="text-sm">{doc.party_name ?? "—"}</p>
            )}
          </>
        );
      case "reference_number":
        return (
          <>
            <Label>{override || t("referenceNumber")}</Label>
            {isEditable ? (
              <>
                <Input
                  value={referenceNumber}
                  onChange={(event) => setReferenceNumber(event.target.value)}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t("referenceNumberHint")}
                </p>
              </>
            ) : (
              <p className="text-sm">{doc.reference_number ?? "—"}</p>
            )}
          </>
        );
      case "subsidiary_id":
        if (!multiSub) return null;
        return (
          <>
            <Label>{override || tc("labels.subsidiary")}</Label>
            {isEditable && doc.status !== "posted" ? (
              <SearchSelect
                options={subsidiaryOpts}
                value={subsidiaryId}
                onChange={(value) => setSubsidiaryId(value ?? "")}
                clearable
                emptyLabel={rootSubsidiaryName}
                placeholder={rootSubsidiaryName}
              />
            ) : (
              <p className="text-sm">{subsidiaryName(subsidiaryId || doc.subsidiary_id)}</p>
            )}
          </>
        );
      case "memo":
        return (
          <>
            <Label>{override || tc("labels.memo")}</Label>
            {isEditable ? (
              <>
                <Input value={memo} onChange={(event) => setMemo(event.target.value)} />
                <p className="text-xs text-slate-500 dark:text-slate-400">{t("memoHint")}</p>
              </>
            ) : (
              <p className="text-sm">{doc.memo ?? "—"}</p>
            )}
          </>
        );
      default:
        return null;
    }
  };

  return (
    <TransactionDrawer
      closeHref={returnHref}
      beforeClose={confirmDiscard}
      recordId={String(doc.id)}
      // Unsaved-create hides the evidence tabs: both panels read the
      // persisted row the drawer has not written yet, so mounting them
      // would only probe the API with an empty record id.
      showEvidenceTabs={!createMode && sourceDocument}
      keepRecordTabsMounted={Boolean(historicalTranslationSources?.length)}
      detailTabs={
        historicalTranslationSources?.length
          ? [
              {
                key: "historical-translation",
                label: tHistorical("tab"),
                content: (
                  <HistoricalTranslationPanel
                    sources={historicalTranslationSources}
                    onDirtyChange={setHistoricalTranslationDirty}
                  />
                ),
              },
            ]
          : undefined
      }
      canEditAttachments
      // Detach 409s on posted records (evidence is retained), so posted
      // journals hide Remove and name the retention; uploading stays on.
      canRemoveAttachments={doc.status !== "posted"}
      panelClassName={docTypeMeta("journal").surfaceCls}
      title={
        <span className="flex items-center gap-2.5">
          <DocTypeBadge kind="journal" />
          <span className="font-mono">
            {doc.document_number ?? (createMode ? tNew("label") : null)}
          </span>
          <Badge variant={STATUS_VARIANT[doc.status] ?? "secondary"}>
            {STATUS_KEYS[doc.status]
              ? tc(`status.${STATUS_KEYS[doc.status]}`)
              : String(doc.status).replace("_", " ")}
          </Badge>
        </span>
      }
      description={
        mode === "edit"
          ? tc("feedback.editingHint")
          : (ledgerDescription ?? doc.party_name ?? undefined)
      }
      primaryAction={
        canEditStatus && canPost ? (
          mode === "edit" ? (
            <>
              <FormShortcuts
                enabled={!busy}
                actions={{
                  save: () => void save(),
                  saveAndNew: canCreate ? () => void save("new") : undefined,
                  saveAndClose: () => void save("close"),
                  ...postShortcuts,
                }}
              />
              <Button
                size="sm"
                variant={canPostAndNew ? "outline" : "default"}
                className="h-8 px-2.5 text-xs"
                disabled={busy || hasInvalidAmounts}
                onClick={() => void save()}
              >
                {busy ? tc("actions.saving") : tc("actions.save")}
              </Button>
              {canCreate ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2.5 text-xs"
                  disabled={busy || hasInvalidAmounts}
                  onClick={() => void save("new")}
                >
                  {t("saveAndNew")}
                </Button>
              ) : null}
              {canPostAndNew ? (
                <Button
                  size="sm"
                  className="h-8 px-2.5 text-xs"
                  disabled={busy || hasInvalidAmounts || !balanced}
                  title={tEntry("buttons.postAndNewHint")}
                  onClick={() => void postFromKeyboard("new")}
                >
                  {tEntry("buttons.postAndNew")}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                onClick={cancelWithConfirm}
              >
                {tc("actions.cancel")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={busy}
              onClick={() => setMode("edit")}
            >
              {tc("actions.edit")}
            </Button>
          )
        ) : sourceDocument && canPost && (doc.status === "approved" || doc.status === "posted") ? (
          <>
            {doc.status === "posted" && doc.posting_effect_status === "terminal_failed" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs"
                disabled={busy}
                onClick={retryPostingEffects}
              >
                {tc("postingEffects.retry")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5 text-xs text-red-600 dark:text-red-400"
              disabled={busy || voidAwaitingApproval}
              onClick={voidJournal}
            >
              {tc("actions.void")}
            </Button>
          </>
        ) : currentEntryId ? (
          <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" asChild>
            <JournalEntryLink entryId={currentEntryId}>{t("viewCurrentJournal")}</JournalEntryLink>
          </Button>
        ) : null
      }
      actions={
        sourceDocument && mode !== "edit" ? (
          <>
            <PdfButton recordType="journal" recordId={String(doc.id)} />
            <FlowManualButtons subjectKind="journal" subjectId={String(doc.id)} />
            <ApprovalActions subjectKind="journal" subjectId={String(doc.id)} />
            {!ledgerSnapshot && canPost && (isDraft || doc.status === "approved") ? (
              // Post waits while a save settles and until the editor holds a
              // revision to fence on; the label says why it is not yet live.
              <Button
                disabled={
                  busy || saveState === "saving" || documentRevision == null || !balanced || dirty
                }
                onClick={post}
              >
                {saveState === "saving" ? tc("actions.saving") : tc("actions.post")}
              </Button>
            ) : null}
            {doc.entry_id && !ledgerSnapshot ? (
              <Button variant="outline" asChild>
                <JournalEntryLink entryId={doc.entry_id}>{t("viewGlImpact")}</JournalEntryLink>
              </Button>
            ) : null}
            {canPost && doc.status === "draft" ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={remove}
                className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                {tc("actions.delete")}
              </Button>
            ) : null}
          </>
        ) : null
      }
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
                ? tc("actions.saving")
                : saveState === "error"
                  ? t("saveFailedRetry")
                  : dirty
                    ? t("unsavedChanges")
                    : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {statistical
              ? t("instructions.statistical")
              : ledgerTotals
                ? ledgerTotals.map((total) => (
                    <span key={total.currency} className="block">
                      {total.currency} ·{" "}
                      {t.rich("totals", {
                        debits: money(total.debit, { currency: total.currency }),
                        credits: money(total.credit, { currency: total.currency }),
                        strong: (chunks) => <strong>{chunks}</strong>,
                      })}
                    </span>
                  ))
                : t.rich("totals", {
                    debits: money(formatJournalAmount(debits)),
                    credits: money(formatJournalAmount(credits)),
                    strong: (chunks) => (
                      <strong className="text-slate-900 dark:text-slate-100">{chunks}</strong>
                    ),
                  })}
          </span>
          {canBalanceLine ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              title={t("balanceLineHint")}
              onClick={balanceFocusedLine}
            >
              {t("balanceLine")}
            </Button>
          ) : null}
          {isDraft ? (
            !statistical && !mixedCurrencies && diff !== 0n ? (
              <Badge variant="destructive">
                {t("outOfBalance", {
                  amount: money(formatJournalAmount(diff < 0n ? -diff : diff)),
                })}
              </Badge>
            ) : balanced && !mixedCurrencies ? (
              <Badge variant="success">{t("balanced")}</Badge>
            ) : null
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 p-1">
        {mode !== "edit" && (canKeyboardPost || canPostAndNew) ? (
          // Reading a postable draft: Ctrl+Enter posts it and opens the next
          // journal, Ctrl+Shift+Enter posts it in place.
          <FormShortcuts enabled={!busy && saveState !== "saving"} actions={postShortcuts} />
        ) : null}
        {voidAwaitingApproval ? (
          <p
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
          >
            {t("voidAwaitingApproval")}
          </p>
        ) : null}
        <ActionAlert error={refusal} fallbackMessage={t("postFailed")} />
        <PeriodClosedRefusal error={refusal} />
        {doc.reversal_instruction_status ? (
          <div className="rounded-md border p-3 text-sm space-y-2">
            <p>
              {t("instructions.reversalStatus", {
                status: String(doc.reversal_instruction_status),
                date: reverseOn,
              })}
            </p>
            {doc.reversal_instruction_error ? (
              <p role="alert">{String(doc.reversal_instruction_error)}</p>
            ) : null}
            {doc.automatic_reversal_entry_id ? (
              <JournalEntryLink entryId={String(doc.automatic_reversal_entry_id)}>
                {t("instructions.viewReversal")}
              </JournalEntryLink>
            ) : null}
            {canPost && doc.reversal_instruction_status === "blocked" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  await execute(
                    async () => {
                      const result = await fetchAppAction(
                        "/api/journals/reversals",
                        {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "run_due" }),
                        },
                        { fallback: t("postFailed") },
                      );
                      if (!result.ok) return result;
                      const parsed = z
                        .object({
                          reversed: z.number().int().nonnegative(),
                          blocked: z.array(
                            z.object({ id: uuidString(), message: z.string().min(1) }),
                          ),
                        })
                        .safeParse(result.data);
                      if (!parsed.success)
                        return {
                          ok: false,
                          error: new ActionError({
                            kind: "unexpected",
                            serverMessage: t("postFailed"),
                          }),
                        };
                      if (parsed.data.blocked.length)
                        return {
                          ok: false,
                          error: new ActionError({
                            kind: "refused",
                            serverMessage: parsed.data.blocked.map((row) => row.message).join("; "),
                          }),
                        };
                      return { ...result, data: parsed.data };
                    },
                    {
                      fallbackMessage: t("postFailed"),
                      onOk: () => router.refresh(),
                      onRefused: () => router.refresh(),
                    },
                  );
                }}
              >
                {t("instructions.retryReversals")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {postWarnings.map((warning, index) => (
          <p
            key={index}
            role="alert"
            className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
          >
            {warning}
          </p>
        ))}
        {mainLayout ? (
          <HeaderFields layout={mainLayout} editable={editable} renderField={renderHeaderField} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={field}>
                <Label>
                  {tc("labels.date")}
                  {editable ? <span className="text-red-500"> *</span> : null}
                </Label>
                {editable ? (
                  <DateField
                    data-autofocus=""
                    value={documentDate}
                    onChange={(value) => setDocumentDate(value)}
                  />
                ) : (
                  <p className="text-sm">
                    {doc.document_date ? formatCivilDate(doc.document_date, locale) : "—"}
                  </p>
                )}
              </div>
              <div className={field}>
                <Label>{t("referenceNumber")}</Label>
                {editable ? (
                  <>
                    <Input
                      value={referenceNumber}
                      onChange={(e) => setReferenceNumber(e.target.value)}
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t("referenceNumberHint")}
                    </p>
                  </>
                ) : (
                  <p className="text-sm">{doc.reference_number ?? "—"}</p>
                )}
              </div>
              <div className={`${field} lg:col-span-2`}>
                <Label>{tc("labels.memo")}</Label>
                {editable ? (
                  <>
                    <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t("memoHint")}</p>
                  </>
                ) : (
                  <p className="text-sm">{doc.memo ?? "—"}</p>
                )}
              </div>
              {multiSub ? (
                // Locked (read-only) once posted — the subsidiary shapes the GL
                // and intercompany balancing.
                <div className={field}>
                  <Label>{tc("labels.subsidiary")}</Label>
                  {editable && doc.status !== "posted" ? (
                    <SearchSelect
                      options={subsidiaryOpts}
                      value={subsidiaryId}
                      onChange={(v) => setSubsidiaryId(v ?? "")}
                      clearable
                      emptyLabel={rootSubsidiaryName}
                      placeholder={rootSubsidiaryName}
                    />
                  ) : (
                    <p className="text-sm">{subsidiaryName(subsidiaryId || doc.subsidiary_id)}</p>
                  )}
                </div>
              ) : null}
            </div>

            <CustomFieldInputs
              defs={headerDefs}
              values={customValues}
              onChange={setCustomValues}
              readOnly={!editable}
              viewer={customFieldViewer}
            />
          </>
        )}

        <details
          open={moreOptionsOpen}
          onToggle={(event) => setMoreOptionsOpen(event.currentTarget.open)}
          className="space-y-3"
          data-journal-more-options=""
        >
          <summary className="cursor-pointer text-sm font-medium text-slate-600 dark:text-slate-300">
            {t("moreOptions")}
          </summary>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className={field}>
              <Label>{t("instructions.mode")}</Label>
              {editable ? (
                <SearchSelect
                  value={journalMode}
                  onChange={setJournalMode}
                  options={["monetary", "statistical", "currency_adjustment"].map((value) => ({
                    value,
                    label: t(`instructions.${value}`),
                  }))}
                />
              ) : (
                <p className="text-sm">{t(`instructions.${journalMode}`)}</p>
              )}
            </div>
            {!statistical ? (
              <>
                <div className={field}>
                  <Label>{t("instructions.currency")}</Label>
                  {editable ? (
                    <Input
                      value={currency}
                      maxLength={3}
                      onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                    />
                  ) : (
                    <p className="text-sm">{currency}</p>
                  )}
                </div>
                <div className={field}>
                  <Label>{t("instructions.rate")}</Label>
                  {editable ? (
                    <Input
                      value={fxRate}
                      inputMode="decimal"
                      onChange={(event) => setFxRate(event.target.value)}
                    />
                  ) : (
                    <p className="text-sm">{fxRate}</p>
                  )}
                </div>
              </>
            ) : null}
            <div className={field}>
              <Label>{t("instructions.reverseOn")}</Label>
              {editable ? (
                <DateField value={reverseOn} onChange={(value) => setReverseOn(value)} />
              ) : (
                <p className="text-sm">{reverseOn || "—"}</p>
              )}
            </div>
            {showParty ? (
              <div className={`${field} lg:col-span-2`}>
                <Label>{partyLabel}</Label>
                {editable ? (
                  <SearchSelect
                    options={parties.map((p) => ({ value: p.id, label: p.display_name ?? "" }))}
                    value={partyId}
                    onChange={(v) => setPartyId(v ?? "")}
                    placeholder={t("noParty")}
                    clearable
                    emptyLabel={t("noParty")}
                  />
                ) : (
                  <p className="text-sm">{doc.party_name ?? "—"}</p>
                )}
              </div>
            ) : null}
          </div>
          {bookUi ? (
            <JournalBookField
              books={books!}
              value={accountingBookId}
              onChange={setAccountingBookId}
              editable={editable && canPostBookSpecific}
            />
          ) : null}
        </details>
        {mixedCurrencies ? (
          <p className="text-xs text-slate-500">{t("instructions.serverBalance")}</p>
        ) : null}

        {segments.some((segment) => segment.showOnHeader) ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {segments
              .filter((segment) => segment.showOnHeader)
              .map((segment) => {
                const selected = extraDims[segment.key] ?? "";
                return (
                  <div className={field} key={segment.key}>
                    <Label>{segment.name}</Label>
                    {editable ? (
                      <SearchSelect
                        options={segment.values.map((value) => ({
                          value: value.id,
                          label: `${value.code ? `${value.code} · ` : ""}${value.name}`,
                        }))}
                        value={selected}
                        onChange={(value) =>
                          setExtraDims((current) => ({ ...current, [segment.key]: value || null }))
                        }
                        placeholder="—"
                      />
                    ) : (
                      <p className="text-sm">
                        {segment.values.find((value) => value.id === selected)?.name ?? "—"}
                      </p>
                    )}
                  </div>
                );
              })}
          </div>
        ) : null}

        <div ref={gridRef} className="space-y-2" onFocus={handleGridFocus}>
          <Label>{tc("labels.lines")}</Label>
          <LineGrid<LineRow>
            columns={columns}
            rows={rows}
            onRowsChange={handleRowsChange}
            emptyRow={emptyLine}
            readOnly={!editable}
            minRows={2}
            formatAmount={(value) => money(value, { currency: doc.currency })}
          />
        </div>

        {mode === "view" && sourceDocument ? (
          <ApprovalHistory subjectKind="journal" subjectId={String(doc.id)} />
        ) : null}
      </div>
    </TransactionDrawer>
  );
}
