import { normalizeDocumentReference as normalizeVendorReference } from "@openbooks/engine/records/document-reference-normalize";
import { add, cmp, neg, normalizeMoney, sum } from "@openbooks/engine/money/money";
import { computeLineTaxes, type TaxComponentConfig } from "@openbooks/engine/tax/tax";
import {
  buildDocumentCreateRequest,
  createdDocumentId,
} from "../../../../../components/document-drawer-save";
import { readAppActionResult } from "../../../../../lib/api-error";
import { resolveEnteredAmount } from "../../../../../lib/entry-amount";

/**
 * Batch bill entry: one row per vendor bill, saved one bill at a time through
 * the same create and lifecycle endpoints the bill drawer uses. Everything in
 * this module is pure (or takes its transport and storage as arguments) so the
 * money arithmetic, validation, duplicate detection, persistence and save loop
 * are tested without a browser.
 */

export const BATCH_BILL_KIND = "vendor_bill";

/**
 * Bills save one at a time, in row order, so their document numbers follow
 * the order they were keyed in, exactly like entering them one by one.
 */
export const BATCH_SAVE_CONCURRENCY = 1;

export type BatchRowOutcome = "" | "saved" | "posted" | "pending";

export interface BatchBillRow extends Record<string, unknown> {
  /** Client identity for the grid; never sent to the server. */
  key: string;
  /** Create key for this bill. Kept until the bill exists, so a retried save
   *  replays the same create instead of making a second bill. */
  idempotencyKey: string;
  partyId: string;
  referenceNumber: string;
  documentDate: string;
  dueDate: string;
  accountId: string;
  memo: string;
  amount: string;
  taxProfileId: string;
  /** The account and tax choice last filled from the vendor's defaults. A
   *  value still equal to it follows a vendor change; anything else is the
   *  clerk's own choice and is never overwritten. */
  defaultedAccountId: string;
  defaultedTaxProfileId: string;
  /** The vendor whose defaults were last applied to this row. */
  defaultsFor: string;
  documentId: string;
  documentNumber: string;
  /** The persisted bill total; finished rows never reinterpret historical tax rates. */
  savedTotal?: string;
  outcome: BatchRowOutcome;
  /** The server's refusal for this row's last save or post. */
  error: string;
  /** The refusal was an idempotency conflict: a bill may already exist under
   *  this row's create key with different details. */
  conflict: boolean;
}

function mintKey(): string {
  return globalThis.crypto.randomUUID();
}

export function blankBatchRow(documentDate = ""): BatchBillRow {
  return {
    key: mintKey(),
    idempotencyKey: mintKey(),
    partyId: "",
    referenceNumber: "",
    documentDate,
    dueDate: "",
    accountId: "",
    memo: "",
    amount: "",
    taxProfileId: "",
    defaultedAccountId: "",
    defaultedTaxProfileId: "",
    defaultsFor: "",
    documentId: "",
    documentNumber: "",
    savedTotal: "",
    outcome: "",
    error: "",
    conflict: false,
  };
}

/** A duplicated row is a new bill: fresh identity, fresh create key, no result. */
export function cloneBatchRow(row: BatchBillRow): BatchBillRow {
  return {
    ...row,
    key: mintKey(),
    idempotencyKey: mintKey(),
    documentId: "",
    documentNumber: "",
    savedTotal: "",
    outcome: "",
    error: "",
    conflict: false,
  };
}

/** A row the clerk has not typed anything into. The bill date alone does not
 *  count: every new row inherits one. */
export function isBlankBatchRow(row: BatchBillRow): boolean {
  return (
    !row.documentId &&
    [
      row.partyId,
      row.referenceNumber,
      row.dueDate,
      row.accountId,
      row.memo,
      row.amount,
      row.taxProfileId,
    ].every((value) => String(value ?? "").trim() === "")
  );
}

/** The bill exists on the server; its cells are read-only. */
export function isLockedBatchRow(row: BatchBillRow): boolean {
  return row.documentId !== "";
}

/** Saved (or posted, or submitted) with nothing left to retry. */
export function isFinishedBatchRow(row: BatchBillRow): boolean {
  return row.documentId !== "" && row.outcome !== "" && row.error === "";
}

/**
 * New rows take the bill date of the row above them (the first row takes
 * today), the way a clerk keys a stack of bills received on one day. Only
 * rows that did not exist before and arrived without a date are filled, so a
 * date the clerk cleared on an existing row stays cleared.
 */
export function inheritBillDates(
  previous: readonly BatchBillRow[],
  next: BatchBillRow[],
  today: string,
): BatchBillRow[] {
  const known = new Set(previous.map((row) => row.key));
  let changed = false;
  let above = "";
  const result = next.map((row) => {
    let current = row;
    if (!known.has(row.key) && row.documentDate === "") {
      current = { ...row, documentDate: above || today };
      changed = true;
    }
    if (current.documentDate) above = current.documentDate;
    return current;
  });
  return changed ? result : next;
}

export function exactAmount(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  try {
    return normalizeMoney(text);
  } catch {
    return null;
  }
}

/** The bill's total: the amount plus the tax its tax choice computes (or the
 *  amount itself for tax-inclusive codes). Null when the amount is not exact. */
export type BatchTaxProfiles = ReadonlyMap<string, readonly TaxComponentConfig[]>;
export type BatchTaxSource = BatchTaxProfiles | ((row: BatchBillRow) => BatchTaxProfiles);

export function batchRowTotal(row: BatchBillRow, taxByProfile: BatchTaxSource): string | null {
  if (row.documentId && row.savedTotal) return exactAmount(row.savedTotal);
  const amount = exactAmount(row.amount);
  if (amount === null) return null;
  const profiles = typeof taxByProfile === "function" ? taxByProfile(row) : taxByProfile;
  const components = row.taxProfileId ? profiles.get(row.taxProfileId) : [];
  if (!components || (row.taxProfileId && components.length === 0)) return null;
  if (components.length === 0) return amount;
  try {
    return normalizeMoney(computeLineTaxes(amount, [...components]).total);
  } catch {
    return null;
  }
}

export interface BatchEntered {
  /** Bills in the batch: every row with content, saved or not. */
  count: number;
  /** Sum of the bills' totals; rows with no exact amount contribute nothing. */
  total: string;
}

export function batchEntered(
  rows: readonly BatchBillRow[],
  taxByProfile: BatchTaxSource,
): BatchEntered {
  const bills = rows.filter((row) => !isBlankBatchRow(row));
  const totals = bills
    .map((row) => batchRowTotal(row, taxByProfile))
    .filter((total): total is string => total !== null);
  return { count: bills.length, total: sum(totals) };
}

export interface ControlTotalsInput {
  count: string;
  total: string;
}

export interface ControlVariance {
  /** Entered minus control; null when no control count is set. */
  countDifference: number | null;
  /** Entered minus control as an exact amount; null when no control total is set. */
  totalDifference: string | null;
  countInvalid: boolean;
  totalInvalid: boolean;
  /** Every control that is set is valid and matches what was entered. */
  matched: boolean;
  /** At least one control is set. */
  active: boolean;
}

/**
 * Batch control totals: the number of bills and their total the clerk counted
 * from the paper stack before keying, compared with what was entered.
 */
export function controlVariance(
  control: ControlTotalsInput,
  entered: BatchEntered,
): ControlVariance {
  const countText = control.count.trim();
  const countInvalid = countText !== "" && !/^\d{1,6}$/.test(countText);
  const countDifference =
    countText === "" || countInvalid ? null : entered.count - Number(countText);

  const resolvedTotal = resolveEnteredAmount(control.total);
  const totalInvalid = resolvedTotal.kind === "invalid";
  const totalDifference =
    resolvedTotal.kind === "amount"
      ? add(normalizeMoney(entered.total), neg(normalizeMoney(resolvedTotal.value)))
      : null;

  const active = countText !== "" || resolvedTotal.kind !== "empty";
  const matched =
    !countInvalid &&
    !totalInvalid &&
    (countDifference === null || countDifference === 0) &&
    (totalDifference === null || cmp(totalDifference, "0") === 0);
  return { countDifference, totalDifference, countInvalid, totalInvalid, matched, active };
}

/**
 * Vendor invoice numbers compare after lower-casing and dropping everything
 * but letters and digits ("INV-0042" = "inv 0042"). The same rule the server
 * applies to stored bills, so a batch warning and a saved-bill warning agree.
 */
export { normalizeDocumentReference as normalizeVendorReference } from "@openbooks/engine/records/document-reference-normalize";

/** Rows that repeat another row's vendor and normalised invoice number:
 *  row key → the other rows' 1-based numbers. */
export function inBatchDuplicates(rows: readonly BatchBillRow[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (isBlankBatchRow(row) || !row.partyId) return;
    const reference = normalizeVendorReference(row.referenceNumber);
    if (reference === null) return;
    const key = `${row.partyId}|${reference}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  const result = new Map<string, number[]>();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      result.set(
        rows[index]!.key,
        indexes.filter((other) => other !== index).map((other) => other + 1),
      );
    }
  }
  return result;
}

export type BatchRowIssue =
  "vendor" | "billDate" | "amountMissing" | "amountInvalid" | "amountNotPositive" | "account";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What keeps a row from being saved. The server re-validates everything;
 *  these are the refusals a row can be checked for before any write. */
export function batchRowIssues(row: BatchBillRow): BatchRowIssue[] {
  if (isBlankBatchRow(row) || isLockedBatchRow(row)) return [];
  const issues: BatchRowIssue[] = [];
  if (!row.partyId) issues.push("vendor");
  if (!ISO_DATE.test(row.documentDate)) issues.push("billDate");
  const amountText = String(row.amount ?? "").trim();
  const amount = exactAmount(amountText);
  if (amountText === "") issues.push("amountMissing");
  else if (amount === null) issues.push("amountInvalid");
  else if (cmp(amount, "0") <= 0) issues.push("amountNotPositive");
  if (!row.accountId) issues.push("account");
  return issues;
}

/**
 * The create body for one row: the same shape the bill drawer saves for a
 * one-line, amount-only bill. A blank due date is left out so the server
 * derives it from the vendor's terms.
 */
export function batchRowPayload(
  row: BatchBillRow,
  options: { hasTax: boolean; subsidiaryId?: string | null },
): Record<string, unknown> {
  const amount = exactAmount(row.amount);
  const memo = row.memo.trim();
  const reference = row.referenceNumber.trim();
  const tax = options.hasTax ? row.taxProfileId : "";
  return {
    partyId: row.partyId || null,
    documentDate: row.documentDate || undefined,
    ...(row.dueDate ? { dueDate: row.dueDate } : {}),
    referenceNumber: reference || null,
    memo: memo || null,
    ...(options.subsidiaryId ? { subsidiaryId: options.subsidiaryId } : {}),
    lines: [
      {
        accountId: row.accountId || null,
        description: memo || null,
        quantity: null,
        unitPrice: null,
        amount: amount ?? String(row.amount ?? ""),
        taxCodeId: tax.startsWith("code:") ? tax.slice(5) : null,
        taxGroupId: tax.startsWith("group:") ? tax.slice(6) : null,
        taxOverridden: false,
        taxAmount: null,
      },
    ],
  };
}

export interface BatchSaveCopy {
  /** Shown when a refusal names nothing usable. */
  fallback: string;
  /** Shown when the server could not be reached. */
  unavailable: string;
  /** Shown when the create key was already used for a different bill. */
  conflict: string;
  totalChanged?: string;
}

export interface BatchRowResult {
  documentId: string;
  documentNumber: string;
  /** The persisted bill total; finished rows never reinterpret historical tax rates. */
  savedTotal?: string;
  outcome: BatchRowOutcome;
  error: string;
  conflict: boolean;
}

type Transport = (input: string, init?: RequestInit) => Promise<Response>;

async function call(
  transport: Transport,
  path: string,
  init: RequestInit,
  copy: BatchSaveCopy,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string; code: string | null }> {
  let response: Response;
  try {
    response = await transport(path, init);
  } catch {
    return { ok: false, message: copy.unavailable, code: null };
  }
  const result = await readAppActionResult(response, {
    fallback: copy.fallback,
    unavailable: copy.unavailable,
  });
  if (result.ok) return { ok: true, data: result.data };
  return {
    ok: false,
    message: result.error.serverMessage ?? copy.fallback,
    code: result.error.code ?? null,
  };
}

/**
 * Save one row as a bill, and optionally submit and post it.
 *
 * - The create runs only while the row has no bill, with the row's create
 *   key, so a retry after a lost response replays instead of duplicating.
 * - The native post command submits and posts atomically; an approval Flow
 *   holds the bill pending approval without posting around it.
 * - A refused submit or post keeps the bill (saved as a draft) and its
 *   refusal; retrying resumes from the lifecycle step, never re-creates.
 */
export async function saveBatchRow(
  row: BatchBillRow,
  options: {
    post: boolean;
    hasTax: boolean;
    subsidiaryId?: string | null;
    expectedTotal?: string | null;
    currency?: string;
    transport: Transport;
    copy: BatchSaveCopy;
  },
): Promise<BatchRowResult> {
  let documentId = row.documentId;
  let documentNumber = row.documentNumber;
  let outcome: BatchRowOutcome = row.outcome;
  let savedTotal = row.savedTotal;
  const persisted = () => (savedTotal ? { savedTotal } : {});
  if (!documentId) {
    const request = buildDocumentCreateRequest(
      BATCH_BILL_KIND,
      {
        ...batchRowPayload(row, { hasTax: options.hasTax, subsidiaryId: options.subsidiaryId }),
        ...(options.currency ? { currency: options.currency } : {}),
      },
      row.idempotencyKey,
    );
    const created = await call(
      options.transport,
      request.path,
      {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
      },
      options.copy,
    );
    if (!created.ok) {
      const conflict = created.code === "document_create_conflict";
      return {
        documentId: "",
        documentNumber: "",
        outcome: "",
        error: conflict ? options.copy.conflict : created.message,
        conflict,
      };
    }
    const id = createdDocumentId(created.data);
    if (!id)
      return {
        documentId: "",
        documentNumber: "",
        outcome: "",
        error: options.copy.fallback,
        conflict: false,
      };
    documentId = id;
    const number = (created.data as { doc?: { document_number?: unknown } } | null)?.doc
      ?.document_number;
    documentNumber = typeof number === "string" ? number : "";
    outcome = "saved";
    savedTotal =
      exactAmount((created.data as { doc?: { total?: unknown } } | null)?.doc?.total) ?? undefined;
  }
  if (
    options.expectedTotal !== undefined &&
    (!savedTotal || options.expectedTotal === null || cmp(savedTotal, options.expectedTotal) !== 0)
  ) {
    return {
      documentId,
      documentNumber,
      outcome: "saved",
      ...persisted(),
      error: options.copy.totalChanged ?? options.copy.fallback,
      conflict: false,
    };
  }
  if (!options.post || outcome === "posted" || outcome === "pending") {
    return { documentId, documentNumber, outcome, ...persisted(), error: "", conflict: false };
  }
  const act = (action: "post") =>
    call(
      options.transport,
      "/api/documents/actions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, documentId }),
      },
      options.copy,
    );
  const posted = await act("post");
  if (!posted.ok)
    return {
      documentId,
      documentNumber,
      outcome: "saved",
      ...persisted(),
      error: posted.message,
      conflict: false,
    };
  const held = (posted.data as { pendingApproval?: unknown } | null)?.pendingApproval === true;
  return {
    documentId,
    documentNumber,
    outcome: held ? "pending" : "posted",
    ...persisted(),
    error: "",
    conflict: false,
  };
}

/** Run `worker` over `items` with at most `concurrency` in flight, reporting
 *  each result as it settles. A worker that throws is reported as its error. */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  options: { concurrency: number; onSettled?: (item: T, result: R, done: number) => void },
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(options.concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        const result = await worker(items[index]!);
        results[index] = result;
        done += 1;
        options.onSettled?.(items[index]!, result, done);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

/** Effective tax components for the bill date, from the native document resolver. */
export async function fetchBatchTaxProfiles(
  transport: Transport,
  documentDate: string,
): Promise<BatchTaxProfiles | null> {
  const query = new URLSearchParams({ kind: BATCH_BILL_KIND, documentDate, include: "tax" });
  try {
    const response = await transport(`/api/documents/defaults?${query}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      taxes?: {
        codes?: Record<string, TaxComponentConfig[]>;
        groups?: Record<string, TaxComponentConfig[]>;
      };
    };
    if (!body.taxes?.codes || !body.taxes.groups) return null;
    return new Map([
      ...Object.entries(body.taxes.codes).map(
        ([id, components]) => [`code:${id}`, components] as const,
      ),
      ...Object.entries(body.taxes.groups).map(
        ([id, components]) => [`group:${id}`, components] as const,
      ),
    ]);
  } catch {
    return null;
  }
}

// -- vendor defaults and duplicate checks ------------------------------------

export interface VendorDefaults {
  /** The due date the vendor's terms give for the bill date, if any. */
  termsDueDate: string | null;
  accountId: string | null;
  taxCodeId: string | null;
  /** A tax group the vendor's history settles on; never set with `taxCodeId`. */
  taxGroupId: string | null;
}

/** The vendor's default account and tax code and its terms-derived due date,
 *  from the same resolver the bill drawer and the create path use. */
export async function fetchVendorDefaults(
  transport: Transport,
  partyId: string,
  documentDate: string,
): Promise<VendorDefaults | null> {
  const query = new URLSearchParams({ kind: BATCH_BILL_KIND, partyId, include: "party" });
  if (ISO_DATE.test(documentDate)) query.set("documentDate", documentDate);
  let response: Response;
  try {
    response = await transport(`/api/documents/defaults?${query.toString()}`, {
      headers: { accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as {
    terms?: { dueDate?: unknown } | null;
    party?: {
      line?: { accountId?: unknown; taxCodeId?: unknown; taxGroupId?: unknown } | null;
    } | null;
  } | null;
  if (!body) return null;
  const line = body.party?.line;
  return {
    termsDueDate: typeof body.terms?.dueDate === "string" ? body.terms.dueDate : null,
    accountId: typeof line?.accountId === "string" ? line.accountId : null,
    taxCodeId: typeof line?.taxCodeId === "string" ? line.taxCodeId : null,
    taxGroupId: typeof line?.taxGroupId === "string" ? line.taxGroupId : null,
  };
}

/**
 * Fill a row from its vendor's defaults. An account or tax choice is filled
 * only while it is blank or still the previous vendor's default; a value the
 * clerk chose is kept. A default outside the page's choices is not applied.
 */
export function applyVendorDefaults(
  row: BatchBillRow,
  defaults: VendorDefaults,
  context: {
    accountIds: ReadonlySet<string>;
    taxProfileValues: ReadonlySet<string>;
    hasTax: boolean;
  },
): BatchBillRow {
  const next: BatchBillRow = { ...row, defaultsFor: row.partyId };
  const followsAccount = row.accountId === "" || row.accountId === row.defaultedAccountId;
  if (followsAccount) {
    const account =
      defaults.accountId && context.accountIds.has(defaults.accountId) ? defaults.accountId : "";
    next.accountId = account;
    next.defaultedAccountId = account;
  }
  if (context.hasTax) {
    const followsTax = row.taxProfileId === "" || row.taxProfileId === row.defaultedTaxProfileId;
    if (followsTax) {
      const value = defaults.taxCodeId
        ? `code:${defaults.taxCodeId}`
        : defaults.taxGroupId
          ? `group:${defaults.taxGroupId}`
          : "";
      const tax = value && context.taxProfileValues.has(value) ? value : "";
      next.taxProfileId = tax;
      next.defaultedTaxProfileId = tax;
    }
  }
  return next;
}

export interface ServerDuplicate {
  id: string;
  documentNumber: string | null;
  documentDate: string | null;
  total: string | null;
  status: string | null;
  referenceNumber: string | null;
}

/** Bills already on file for this vendor and invoice number (a warning, never
 *  a refusal). Null when the check could not run. */
export async function fetchVendorDuplicates(
  transport: Transport,
  partyId: string,
  referenceNumber: string,
): Promise<ServerDuplicate[] | null> {
  const query = new URLSearchParams({ kind: BATCH_BILL_KIND, partyId, referenceNumber });
  let response: Response;
  try {
    response = await transport(`/api/documents/duplicates?${query.toString()}`, {
      headers: { accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { duplicates?: unknown } | null;
  if (!Array.isArray(body?.duplicates)) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return body.duplicates.flatMap((entry) => {
    const record = entry as Record<string, unknown> | null;
    if (!record || typeof record.id !== "string") return [];
    return [
      {
        id: record.id,
        documentNumber: text(record.documentNumber),
        documentDate: text(record.documentDate),
        total: text(record.total),
        status: text(record.status),
        referenceNumber: text(record.referenceNumber),
      },
    ];
  });
}

// -- unsaved batch persistence -----------------------------------------------

export interface BatchDraft {
  rows: BatchBillRow[];
  controlCount: string;
  controlTotal: string;
  subsidiaryId: string;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const DRAFT_VERSION = 1;

export function batchDraftKey(orgId: string, userId: string): string {
  return `openbooks:batch-bills:v${DRAFT_VERSION}:${orgId}:${userId}`;
}

/** Work that would be lost on leaving: a row with content and no bill yet, or
 *  a saved bill whose submit or post was refused. */
export function hasUnsavedWork(rows: readonly BatchBillRow[]): boolean {
  return rows.some((row) => !isBlankBatchRow(row) && !isFinishedBatchRow(row));
}

const ROW_TEXT_FIELDS = [
  "key",
  "idempotencyKey",
  "partyId",
  "referenceNumber",
  "documentDate",
  "dueDate",
  "accountId",
  "memo",
  "amount",
  "taxProfileId",
  "defaultedAccountId",
  "defaultedTaxProfileId",
  "defaultsFor",
  "documentId",
  "documentNumber",
  "savedTotal",
  "error",
] as const;
const OUTCOMES: readonly BatchRowOutcome[] = ["", "saved", "posted", "pending"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function restoreRow(value: unknown): BatchBillRow | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const row = blankBatchRow();
  for (const field of ROW_TEXT_FIELDS) {
    const text = source[field];
    if (text !== undefined && typeof text !== "string") return null;
    if (typeof text === "string") (row as Record<string, unknown>)[field] = text;
  }
  // The create key decides whether a retry replays or creates: a row whose
  // key cannot be read back exactly is not restored as unsaved work.
  if (!UUID.test(row.idempotencyKey) || row.key === "") return null;
  const outcome = source.outcome;
  if (outcome !== undefined && !OUTCOMES.includes(outcome as BatchRowOutcome)) return null;
  row.outcome = (outcome as BatchRowOutcome | undefined) ?? "";
  row.conflict = source.conflict === true;
  return row;
}

export function serializeBatchDraft(draft: BatchDraft): string {
  return JSON.stringify({ version: DRAFT_VERSION, ...draft });
}

/** The stored batch, or null when there is none worth restoring. Malformed
 *  rows are dropped; a stored batch from another format version is ignored. */
export function parseBatchDraft(text: string | null): BatchDraft | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const source = parsed as Record<string, unknown> | null;
  if (!source || source.version !== DRAFT_VERSION || !Array.isArray(source.rows)) return null;
  const rows = source.rows.map(restoreRow).filter((row): row is BatchBillRow => row !== null);
  if (!hasUnsavedWork(rows)) return null;
  const text_ = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    rows,
    controlCount: text_(source.controlCount),
    controlTotal: text_(source.controlTotal),
    subsidiaryId: text_(source.subsidiaryId),
  };
}

/** Keep the batch while it has unsaved work; forget it once every bill saved.
 *  Returns false when the browser refused to store it. */
export function writeBatchDraft(storage: DraftStorage, key: string, draft: BatchDraft): boolean {
  try {
    if (hasUnsavedWork(draft.rows)) storage.setItem(key, serializeBatchDraft(draft));
    else storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function readBatchDraft(storage: DraftStorage, key: string): BatchDraft | null {
  try {
    return parseBatchDraft(storage.getItem(key));
  } catch {
    return null;
  }
}

/**
 * Remove finished rows. Control totals that are set shrink by the removed
 * bills, so the rows still on screen keep balancing against what remains of
 * the paper stack; with nothing left they clear.
 */
export function clearFinishedRows(
  rows: readonly BatchBillRow[],
  control: ControlTotalsInput,
  taxByProfile: BatchTaxSource,
  today: string,
): { rows: BatchBillRow[]; control: ControlTotalsInput } {
  const finished = rows.filter(isFinishedBatchRow);
  const remaining = rows.filter((row) => !isFinishedBatchRow(row) && !isBlankBatchRow(row));
  if (remaining.length === 0) {
    const lastDate = [...rows].reverse().find((row) => row.documentDate)?.documentDate ?? today;
    return { rows: [blankBatchRow(lastDate)], control: { count: "", total: "" } };
  }
  const removed = batchEntered(finished, taxByProfile);
  const countText = control.count.trim();
  const count = /^\d{1,6}$/.test(countText)
    ? String(Math.max(0, Number(countText) - removed.count))
    : control.count;
  const resolved = resolveEnteredAmount(control.total);
  const total =
    resolved.kind === "amount"
      ? add(normalizeMoney(resolved.value), neg(removed.total))
      : control.total;
  return {
    rows: rows.filter((row) => !isFinishedBatchRow(row)),
    control: { count, total },
  };
}
