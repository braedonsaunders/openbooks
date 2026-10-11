import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { createDocument } from "./document-write.ts";
import type { DocumentEditInput } from "./document-input.ts";
import { controlDeps } from "./document-service.ts";
import { postDocument } from "./posting-document.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { runRecordFlows } from "../flows/run.ts";
import { isFeatureEnabled } from "../organization/feature-state.ts";

/**
 * Cashier-scoped bank drops ("Deposit cash to bank" from Cash Sales).
 *
 * A till drop moves counted till cash (Cash on Hand) into a configured bank
 * account as a native `transfer` document carrying the sale link and the
 * bank slip number, so the bookkeeper confirms and matches it in Banking
 * like any other transfer. The cashier never needs banking or GL grants:
 * this function runs the constrained native path — source limited to the
 * sale's own cash tender account, destination limited to the configured
 * deposit accounts, amount capped at the sale's undropped till cash — and
 * the route gates it behind `cash_sales.deposit`.
 */

/** A drop refusal with the HTTP status and operator remedy the route renders. */
export class CashDepositError extends Error {
  readonly name = "CashDepositError";

  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
    readonly remedy: string,
  ) {
    super(message);
  }
}

function depositError(message: string, status: 404 | 409 | 422, remedy: string): CashDepositError {
  return new CashDepositError(message, status, remedy);
}

export interface CashDepositInput {
  saleId: string;
  /** Decimal amount string in the sale's currency. */
  amount: string;
  /** Drop date (the bank slip's date), YYYY-MM-DD. */
  date: string;
  bankAccountId: string;
  /** Bank slip number, the control evidence for the bookkeeper's match. */
  slipNumber: string;
  /** Disambiguates when the sale tenders cash to several accounts. */
  sourceAccountId?: string | null;
}

export interface CashDepositResult {
  transferId: string;
  documentNumber: string;
  posted: boolean;
  entryId: string | null;
  /** Present when the drop recorded but the posting was refused or gated. */
  postRefusal?: string;
  pendingApproval?: boolean;
}

const SETTINGS_REMEDY = "Choose the deposit accounts in Company Settings → Cash sales till defaults, then record the drop again.";

/** One recorded till drop against a cash sale, for the sale's drop list. */
export interface CashDepositRow {
  transferId: string;
  documentNumber: string;
  dropDate: string;
  /** Decimal amount string in the sale's currency. */
  amount: string;
  status: string;
  slipNumber: string | null;
}

/**
 * List a cash sale's recorded till drops (voided drops stay listed: the
 * bookkeeper sees what was attempted, never a gap). Read-only — safe for
 * the sale's drop list alongside the deposit form. An unknown sale, a
 * non-sale, or a subsidiary-hidden sale refuses exactly like a drop
 * against it, so no sale of another scope leaks its drops.
 */
export async function listCashDeposits(
  orgId: string,
  saleId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<CashDepositRow[]> {
  return withOrg(orgId, async () => {
    const saleRows = (await db.execute<{ id: string; subsidiaryId: string | null; kind: string }>(sql`
      select id, subsidiary_id as "subsidiaryId", kind
        from documents
       where org_id = ${orgId} and id = ${saleId}`)).rows;
    const sale = saleRows[0];
    if (!sale || sale.kind !== "cash_sale") {
      throw depositError(
        "The bank drop names no cash sale in this organization.",
        404,
        "Reopen the cash sale and record the drop from it.",
      );
    }
    if (allowedSubsidiaryIds !== undefined &&
        allowedSubsidiaryIds !== null &&
        (sale.subsidiaryId === null || !allowedSubsidiaryIds.has(sale.subsidiaryId))) {
      throw depositError(
        "The bank drop names no cash sale in this organization.",
        404,
        "Reopen the cash sale and record the drop from it.",
      );
    }
    const rows = (await db.execute<CashDepositRow>(sql`
      select d.id as "transferId", d.document_number as "documentNumber",
             d.document_date::text as "dropDate",
             l.amount::text as amount, d.status,
             d.custom->'cashSaleDeposit'->>'slipNumber' as "slipNumber"
        from documents d
        join document_lines l on l.document_id = d.id and l.org_id = d.org_id and l.line_number = 1
       where d.org_id = ${orgId} and d.kind = 'transfer'
         and d.custom->'cashSaleDeposit'->>'saleId' = ${sale.id}
       order by d.document_date, d.document_number`)).rows;
    return rows;
  });
}

function parseDepositInput(input: CashDepositInput): {
  amountMinor: bigint;
  slip: string;
} {
  if (!isUuid(input.saleId)) {
    throw depositError(
      "The bank drop names no valid cash sale.",
      404,
      "Reopen the cash sale and record the drop from it.",
    );
  }
  let amountMinor: bigint;
  try {
    amountMinor = toUnits(input.amount);
  } catch {
    throw depositError(
      `Drop amount ${JSON.stringify(input.amount)} is not a valid amount.`,
      422,
      "Enter the drop as a decimal amount with at most four places.",
    );
  }
  if (amountMinor <= 0n) {
    throw depositError("Drop amount must be positive.", 422, "Enter the cash counted for this drop as a positive amount.");
  }
  if (!isIsoCalendarDate(input.date)) {
    throw depositError(
      `Drop date ${JSON.stringify(input.date)} is not a real calendar date.`,
      422,
      "Enter the drop date from the bank slip as YYYY-MM-DD.",
    );
  }
  if (!isUuid(input.bankAccountId)) {
    throw depositError(
      "The bank drop names no valid bank account.",
      422,
      "Pick the bank account the cash was dropped into.",
    );
  }
  const slip = typeof input.slipNumber === "string" ? input.slipNumber.trim() : "";
  if (slip.length === 0 || slip.length > 120) {
    throw depositError(
      "The bank drop needs its bank slip number.",
      422,
      "Enter the slip number from the deposit slip — the bookkeeper matches on it.",
    );
  }
  return { amountMinor, slip };
}

interface DropSale {
  id: string;
  documentNumber: string;
  subsidiaryId: string | null;
  currency: string;
}

/**
 * Record one till drop against a posted cash sale and post its transfer.
 * The transfer posts in the same constrained shape the Banking drawer
 * writes (destination carries the amount, source rides zero), so matching
 * and GL impact are identical. A refused posting still records the draft
 * drop with its slip — the result reports it instead of throwing, and the
 * bookkeeper posts it from Banking.
 */
export async function recordCashDeposit(
  orgId: string,
  actorId: string,
  input: CashDepositInput,
  options: { key?: string; allowedSubsidiaryIds?: ReadonlySet<string> | null },
): Promise<CashDepositResult> {
  const { amountMinor, slip } = parseDepositInput(input);
  return withOrg(orgId, async () => {
    const saleRows = (await db.execute<DropSale & { status: string; kind: string }>(sql`
      select id, document_number as "documentNumber", subsidiary_id as "subsidiaryId",
             currency, status, kind
        from documents
       where org_id = ${orgId} and id = ${input.saleId}
       for update`)).rows;
    const sale = saleRows[0];
    if (!sale || sale.kind !== "cash_sale") {
      throw depositError(
        "The bank drop names no cash sale in this organization.",
        404,
        "Reopen the cash sale and record the drop from it.",
      );
    }
    if (options.allowedSubsidiaryIds !== undefined &&
        options.allowedSubsidiaryIds !== null &&
        (sale.subsidiaryId === null || !options.allowedSubsidiaryIds.has(sale.subsidiaryId))) {
      throw depositError(
        "The bank drop names no cash sale in this organization.",
        404,
        "Reopen the cash sale and record the drop from it.",
      );
    }
    if (sale.status !== "posted") {
      throw depositError(
        `Cash sale ${sale.documentNumber} is ${sale.status} — only a posted sale's counted till can be dropped.`,
        422,
        "Post the cash sale first, then record the drop.",
      );
    }
    // The sale's own till cash, by tender account.
    const tenderRows = (await db.execute<{ accountId: string; minor: string }>(sql`
      select account_id as "accountId", sum(amount_minor)::text as minor
        from document_tenders
       where org_id = ${orgId} and document_id = ${sale.id} and kind = 'cash'
       group by account_id`)).rows;
    const cashTendered = tenderRows.reduce((sum, row) => sum + BigInt(row.minor), 0n);
    if (cashTendered <= 0n) {
      throw depositError(
        `Cash sale ${sale.documentNumber} has no cash tenders — drops move till cash.`,
        422,
        "Record the drop against a sale the till took cash on.",
      );
    }
    let sourceAccountId: string;
    if (input.sourceAccountId !== undefined && input.sourceAccountId !== null && input.sourceAccountId !== "") {
      if (!tenderRows.some((row) => row.accountId === input.sourceAccountId)) {
        throw depositError(
          "The drop names a cash account this sale never tendered to.",
          422,
          "Pick the till cash account from this sale's cash tenders.",
        );
      }
      sourceAccountId = input.sourceAccountId;
    } else if (tenderRows.length === 1) {
      sourceAccountId = tenderRows[0]!.accountId;
    } else {
      throw depositError(
        `Cash sale ${sale.documentNumber} tenders till cash to ${tenderRows.length} accounts — name the one this drop leaves.`,
        422,
        "Pick the till cash account this drop leaves.",
      );
    }
    // Lifetime cap: every non-voided drop already recorded against this
    // sale encumbers its till cash, posted or still awaiting the bookkeeper.
    const priorRows = (await db.execute<{ minor: string }>(sql`
      select coalesce(sum(round(l.amount * 10000)), 0)::bigint::text as minor
        from documents d
        join document_lines l on l.document_id = d.id and l.org_id = d.org_id and l.line_number = 1
       where d.org_id = ${orgId} and d.kind = 'transfer' and d.status <> 'voided'
         and d.custom->'cashSaleDeposit'->>'saleId' = ${sale.id}`)).rows;
    const priorMinor = BigInt(priorRows[0]?.minor ?? "0");
    const remaining = cashTendered - priorMinor;
    if (amountMinor > remaining) {
      throw depositError(
        `Drop ${fromUnits(amountMinor)} exceeds cash sale ${sale.documentNumber}'s undropped till cash ${fromUnits(remaining)}.`,
        422,
        remaining > 0n
          ? `Drop at most ${fromUnits(remaining)} — the rest of this sale's till already dropped.`
          : "This sale's till cash already dropped in full — record the next drop against its own sale.",
      );
    }
    // Destination fence: a configured deposit account, live and postable.
    // Unknown keys and non-id values never reach here — the settings writer
    // normalizes them — so a missing list means disabled, never open.
    const settings = (await db.execute<{ cashSales: unknown }>(sql`
      select settings->'cashSales' as "cashSales" from orgs where id = ${orgId}`)).rows[0]?.cashSales;
    const bag = (settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}) as Record<string, unknown>;
    const configured = Array.isArray(bag.depositAccountIds)
      ? [...new Set(bag.depositAccountIds.filter((id): id is string => typeof id === "string"))]
      : [];
    if (!configured.includes(input.bankAccountId)) {
      throw depositError(
        configured.length === 0
          ? "Till drops are not configured — no deposit account is set up for this organization."
          : "The drop names a bank account outside this organization's configured deposit accounts.",
        configured.length === 0 ? 409 : 422,
        SETTINGS_REMEDY,
      );
    }
    const bank = (await db.execute<{ type: string; is_active: boolean; is_summary: boolean }>(sql`
      select type, is_active, is_summary from accounts
       where org_id = ${orgId} and id = ${input.bankAccountId}::uuid`)).rows[0];
    if (!bank || !bank.is_active || bank.is_summary ||
        (bank.type !== "asset_bank" && bank.type !== "asset_current_other")) {
      throw depositError(
        "The drop's bank account is not a usable bank account in this organization.",
        422,
        SETTINGS_REMEDY,
      );
    }
    if (input.bankAccountId === sourceAccountId) {
      throw depositError(
        "The drop's bank account is the till cash account it leaves — a drop must move money.",
        422,
        "Pick the bank account the cash was dropped into.",
      );
    }
    return createAndPostDrop(orgId, actorId, {
      key: options.key,
      date: input.date,
      slip,
      memo: `Till drop — cash sale ${sale.documentNumber}, slip ${slip}`,
      currency: sale.currency,
      subsidiaryId: sale.subsidiaryId,
      custom: { cashSaleDeposit: { saleId: sale.id, slipNumber: slip } },
      bankAccountId: input.bankAccountId,
      sourceAccountId,
      amountMinor,
    });
  });
}

interface DropTransfer {
  key?: string;
  date: string;
  slip: string;
  memo: string;
  currency: string;
  subsidiaryId: string | null;
  custom: Record<string, unknown>;
  bankAccountId: string;
  sourceAccountId: string;
  amountMinor: bigint;
}

/**
 * Create a till drop's native transfer and post it. The transfer posts in
 * the same constrained shape the Banking drawer writes (destination carries
 * the amount, source rides zero), so matching and GL impact are identical.
 * A refused posting still records the draft drop with its slip — the result
 * reports it instead of throwing, and the bookkeeper posts it from Banking.
 */
async function createAndPostDrop(orgId: string, actorId: string, drop: DropTransfer): Promise<CashDepositResult> {
  const { slip, amountMinor, sourceAccountId } = drop;
  const key = drop.key && isUuid(drop.key) ? drop.key : randomUUID();
  // An explicit currency is a currency change the writer refuses without
  // multi-currency: name the drop's currency only when the feature is on
  // (the row default is the org base currency either way).
  const multiCurrency = await isFeatureEnabled(orgId, "multiCurrency");
  const body: DocumentEditInput = {
    documentDate: drop.date,
    referenceNumber: slip,
    memo: drop.memo,
    ...(multiCurrency ? { currency: drop.currency } : {}),
    subsidiaryId: drop.subsidiaryId,
    custom: drop.custom,
    lines: [
      { accountId: drop.bankAccountId, amount: fromUnits(amountMinor), description: `Till drop — slip ${slip}` },
      { accountId: sourceAccountId, amount: "0", description: null },
    ],
  };
  const created = await createDocument({
    orgId,
    userId: actorId,
    kind: "transfer",
    key,
    body,
    subsidiaryId: drop.subsidiaryId,
    requestBody: { kind: "transfer", ...body },
  });
  if (created.status !== "replayed") {
    await runRecordFlows({ kind: "on_create", source: "ui" }, "transfer", created.id, { orgId, userId: actorId });
    if (created.deferredUpdate) {
      await runRecordFlows(created.deferredUpdate, "transfer", created.id, { orgId, userId: actorId });
    }
  }
  if (created.status === "replayed") {
    const existing = (await db.execute<{ status: string; number: string; entry: string | null }>(sql`
      select status, document_number as number, posted_entry_id as entry
        from documents where org_id = ${orgId} and id = ${created.id}`)).rows[0];
    if (existing?.status === "posted") {
      return { transferId: created.id, documentNumber: existing.number, posted: true, entryId: existing.entry };
    }
    if (existing && existing.status !== "draft" && existing.status !== "approved") {
      throw depositError(
        `This drop was already recorded as ${existing.number} (${existing.status}).`,
        409,
        "Open the existing drop in Banking instead of recording it again.",
      );
    }
  }
  // Submit (auto-released when ungated) and post in one unit with the
  // sale lock held: a refused posting rolls back nothing recorded — the
  // draft drop stands with its slip for the bookkeeper.
  const outcome = await withOrgTransaction(orgId, async () => {
    const current = (await db.execute<{ status: string }>(sql`
      select status from documents where org_id = ${orgId} and id = ${created.id} for update`)).rows[0];
    if (!current) {
      throw depositError("The bank drop disappeared while recording.", 409, "Record the drop again.");
    }
    if (current.status === "posted") {
      return { kind: "posted" as const, entryId: null as string | null, previousStatus: "posted" as string };
    }
    if (current.status === "draft") {
      const submission = await submitAndReleaseIfUngated("transfer", created.id, actorId);
      if (submission.flowError) {
        throw depositError(
          `The bank drop could not be released: ${submission.flowError}`,
          422,
          "Release the drop from Banking, or ask an approver.",
        );
      }
      if (submission.gated || submission.approvalRequired) {
        return { kind: "pending" as const };
      }
    } else if (current.status !== "approved") {
      throw depositError(
        `The bank drop is ${current.status} and cannot post.`,
        409,
        "Open the drop in Banking to see its state.",
      );
    }
    try {
      const entryId = await postDocument(created.id, await controlDeps(orgId), {
        audit: { actorId, source: "ui" },
      });
      return { kind: "posted" as const, entryId, previousStatus: current.status };
    } catch (error) {
      if (error instanceof PostingError) {
        return { kind: "refused" as const, reason: error.message };
      }
      throw error;
    }
  });
  const numbered = (await db.execute<{ number: string; entry: string | null }>(sql`
    select document_number as number, posted_entry_id as entry
      from documents where org_id = ${orgId} and id = ${created.id}`)).rows[0]!;
  if (outcome.kind === "posted") {
    return { transferId: created.id, documentNumber: numbered.number, posted: true, entryId: outcome.entryId ?? numbered.entry };
  }
  if (outcome.kind === "pending") {
    return {
      transferId: created.id,
      documentNumber: numbered.number,
      posted: false,
      entryId: null,
      pendingApproval: true,
      postRefusal: "The drop is waiting on an approval flow — the bookkeeper releases it from Banking.",
    };
  }
  return {
    transferId: created.id,
    documentNumber: numbered.number,
    posted: false,
    entryId: null,
    postRefusal: outcome.reason,
  };
}

export interface TillDropInput {
  /** The till's cash account the counted cash leaves. */
  tillAccountId: string;
  /** Decimal amount string in the till's currency. */
  amount: string;
  /** Drop date (the bank slip's date), YYYY-MM-DD. */
  date: string;
  bankAccountId: string;
  slipNumber: string;
  /** Required when the organization books through more than one legal entity. */
  subsidiaryId?: string | null;
  /** Required when the drop exceeds the till's undropped cash for its window. */
  reason?: string | null;
}

/**
 * A till's reconciliation window ending on a drop date: the cash its sales
 * tendered since the till's previous drop, against everything dropped in
 * the same span. Drops legitimately precede the sales being recorded, so a
 * difference is information for the close-out, never a refusal.
 */
export interface TillDropWindow {
  tillAccountId: string;
  /** Exclusive start: the till's previous drop date, or null for its first drop. */
  after: string | null;
  /** Inclusive end: the drop date. */
  through: string;
  salesCount: number;
  /** Cash tendered to the till in the window (sales minus refunds). */
  tendered: string;
  /** Cash dropped from the till in the window, every non-voided drop. */
  dropped: string;
  /** dropped − tendered: positive means more left the till than its sales took in. */
  difference: string;
}

/** Non-voided drops leaving one till: sale-linked drops and dated till drops alike. */
function tillDropsSql(orgId: string, tillAccountId: string) {
  return sql`
    select d.id, d.document_date, l.amount
      from documents d
      join document_lines l on l.document_id = d.id and l.org_id = d.org_id and l.line_number = 1
      join document_lines src on src.document_id = d.id and src.org_id = d.org_id and src.line_number = 2
     where d.org_id = ${orgId} and d.kind = 'transfer' and d.status <> 'voided'
       and (d.custom ? 'cashSaleDeposit' or d.custom ? 'tillDrop')
       and src.account_id = ${tillAccountId}::uuid`;
}

/** The reconciliation window a drop on `date` closes for one till. */
export async function readTillDropWindow(
  orgId: string,
  tillAccountId: string,
  date: string,
): Promise<TillDropWindow> {
  if (!isUuid(tillAccountId) || !isIsoCalendarDate(date)) {
    throw depositError("The till drop names no valid till account or date.", 422, "Pick the till and the drop date from the bank slip.");
  }
  return withOrg(orgId, async () => {
    const after = (await db.execute<{ date: string | null }>(sql`
      select max(drop.document_date)::text as date
        from (${tillDropsSql(orgId, tillAccountId)}) drop
       where drop.document_date < ${date}::date`)).rows[0]?.date ?? null;
    const tendered = (await db.execute<{ minor: string; sales: number }>(sql`
      select coalesce(sum(case when d.kind = 'cash_refund' then -t.amount_minor else t.amount_minor end), 0)::text as minor,
             count(distinct d.id) filter (where d.kind = 'cash_sale')::int as sales
        from document_tenders t
        join documents d on d.id = t.document_id and d.org_id = t.org_id
       where t.org_id = ${orgId} and t.kind = 'cash' and t.account_id = ${tillAccountId}::uuid
         and d.kind in ('cash_sale', 'cash_refund') and d.status <> 'voided'
         and d.document_date <= ${date}::date
         ${after ? sql`and d.document_date > ${after}::date` : sql``}`)).rows[0]!;
    const dropped = (await db.execute<{ minor: string }>(sql`
      select coalesce(sum(round(drop.amount * 10000)), 0)::bigint::text as minor
        from (${tillDropsSql(orgId, tillAccountId)}) drop
       where drop.document_date <= ${date}::date
         ${after ? sql`and drop.document_date > ${after}::date` : sql``}`)).rows[0]!;
    const tenderedMinor = BigInt(tendered.minor);
    const droppedMinor = BigInt(dropped.minor);
    return {
      tillAccountId,
      after,
      through: date,
      salesCount: tendered.sales,
      tendered: fromUnits(tenderedMinor),
      dropped: fromUnits(droppedMinor),
      difference: fromUnits(droppedMinor - tenderedMinor),
    };
  });
}

/**
 * Record a till drop by till and date — cash leaves the till before the
 * back office posts the sales it came from. The source is fenced to a till
 * cash account (the configured default cash account, or an account cash
 * sales tender cash to), the destination to the configured deposit
 * accounts. The sales reconcile against the drop's window when the
 * operator closes out the till; a drop above the window's undropped cash
 * needs a reason, because it declares cash the recorded sales do not yet
 * explain.
 */
export async function recordTillDrop(
  orgId: string,
  actorId: string,
  input: TillDropInput,
  options: { key?: string; allowedSubsidiaryIds?: ReadonlySet<string> | null },
): Promise<CashDepositResult & { window: TillDropWindow }> {
  const { amountMinor, slip } = parseDepositInput({ ...input, saleId: input.tillAccountId });
  if (!isUuid(input.tillAccountId)) {
    throw depositError("The till drop names no valid till account.", 422, "Pick the till the cash was counted from.");
  }
  return withOrg(orgId, async () => {
    const settings = (await db.execute<{ cashSales: unknown; currency: string }>(sql`
      select settings->'cashSales' as "cashSales", base_currency as currency from orgs where id = ${orgId}`)).rows[0];
    const bag = (settings?.cashSales && typeof settings.cashSales === "object" && !Array.isArray(settings.cashSales)
      ? settings.cashSales : {}) as Record<string, unknown>;
    const tillAccounts = new Set<string>([
      ...(typeof bag.defaultCashAccountId === "string" ? [bag.defaultCashAccountId] : []),
      ...(await db.execute<{ id: string }>(sql`
        select distinct t.account_id as id from document_tenders t
          join documents d on d.id = t.document_id and d.org_id = t.org_id
         where t.org_id = ${orgId} and t.kind = 'cash' and d.kind in ('cash_sale', 'cash_refund')`)).rows.map((row) => row.id),
    ]);
    if (!tillAccounts.has(input.tillAccountId)) {
      throw depositError(
        "The till drop names an account no till takes cash into.",
        422,
        "Pick the till cash account set as the default cash account in Company Settings → Cash sales till defaults, or one your cash sales tender cash to.",
      );
    }
    const configured = Array.isArray(bag.depositAccountIds)
      ? [...new Set(bag.depositAccountIds.filter((id): id is string => typeof id === "string"))]
      : [];
    if (!configured.includes(input.bankAccountId)) {
      throw depositError(
        configured.length === 0
          ? "Till drops are not configured — no deposit account is set up for this organization."
          : "The drop names a bank account outside this organization's configured deposit accounts.",
        configured.length === 0 ? 409 : 422,
        SETTINGS_REMEDY,
      );
    }
    if (input.bankAccountId === input.tillAccountId) {
      throw depositError(
        "The drop's bank account is the till cash account it leaves — a drop must move money.",
        422,
        "Pick the bank account the cash was dropped into.",
      );
    }
    const subsidiaries = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id`)).rows.map((row) => row.id);
    const subsidiaryId = input.subsidiaryId ?? (subsidiaries.length === 1 ? subsidiaries[0]! : null);
    if (!subsidiaryId || !subsidiaries.includes(subsidiaryId) ||
        (options.allowedSubsidiaryIds && !options.allowedSubsidiaryIds.has(subsidiaryId))) {
      throw depositError(
        "The till drop needs the legal entity the till belongs to.",
        422,
        "Choose the entity whose till the cash was counted from.",
      );
    }
    // Serialize drops per till so two cashiers cannot both read the same
    // undropped balance.
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`till-drop:${orgId}:${input.tillAccountId}`}))`);
    const window = await readTillDropWindow(orgId, input.tillAccountId, input.date);
    const undropped = toUnits(window.tendered) - toUnits(window.dropped);
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (amountMinor > undropped && (reason.length < 5 || reason.length > 500)) {
      throw depositError(
        `Drop ${fromUnits(amountMinor)} is more than the till's recorded undropped cash ${fromUnits(undropped > 0n ? undropped : 0n)} since ${window.after ?? "its first sale"}.`,
        422,
        "Enter a reason for the count (for example, sales not yet recorded), between 5 and 500 characters.",
      );
    }
    const result = await createAndPostDrop(orgId, actorId, {
      key: options.key,
      date: input.date,
      slip,
      memo: `Till drop — slip ${slip}`,
      currency: settings?.currency ?? "",
      subsidiaryId,
      custom: { tillDrop: { tillAccountId: input.tillAccountId, dropDate: input.date, slipNumber: slip, ...(reason ? { reason } : {}) } },
      bankAccountId: input.bankAccountId,
      sourceAccountId: input.tillAccountId,
      amountMinor,
    });
    return { ...result, window: await readTillDropWindow(orgId, input.tillAccountId, input.date) };
  });
}
