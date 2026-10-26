import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { add, cmp } from "../money/money.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import {
  ALL_EXPENSE_REPORTS,
  expenseAccessAllows,
  type ExpenseAccess,
} from "../records/expense-access.ts";
import {
  type AddressLookup,
  type CaptureEvidence,
  type CaptureIssue,
} from "./document-capture-azure.ts";
import {
  getDocumentCaptureRuntimeConfig,
  type DocumentCaptureRuntimeConfig,
} from "./ap-capture-config.ts";
import { loadCaptureSourceBlob } from "./capture-source.ts";
import { resolveVendorParty } from "./vendor-resolution.ts";
import {
  chooseAccountSuggestion,
  DEFAULT_RECEIPT_MODEL,
  draftExpenseLineFromReceipt,
  extractAzureReceipt,
  extractLlmReceipt,
  receiptDuplicateIssues,
  receiptMerchantKey,
  validateNormalizedReceipt,
  type NormalizedReceipt,
  type ReceiptDuplicateCandidate,
  type ReceiptLineDraft,
} from "./receipt-capture.ts";

/**
 * Expense receipt capture lifecycle:
 *
 *   extracting → extracted → confirmed
 *        ↓            ↓          ↓
 *      failed  →  discarded  ←───┘
 *
 * Upload attaches the receipt to its draft report and registers an
 * extracting capture in one transaction; extraction reads it through the
 * organization's document capture provider and records the reading, review
 * issues and draft line, fenced by its attempt number. Confirmation happens
 * only inside the report's line save, so a confirmed capture always names
 * the line the reviewer saved. Every write requires a draft expense report
 * the caller may edit.
 */

/** An extraction that has not finished within this window may be retried. */
export const RECEIPT_EXTRACTION_STALE_MS = 10 * 60_000;
const NOT_CONFIGURED = "Document capture is disabled or not configured under Platform → AI";

export class ReceiptCaptureRefusal extends Error {
  readonly name = "ReceiptCaptureRefusal";
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ReceiptReport = {
  id: string;
  status: string;
  currency: string;
  partyId: string | null;
  subsidiaryId: string | null;
  documentNumber: string | null;
};

type ReceiptReportInput = {
  orgId: string;
  documentId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  /** Whose reports the caller reaches; omitted for the organization's own background work. */
  access?: ExpenseAccess;
  forUpdate?: boolean;
};

/**
 * The expense report a receipt operation acts on, locked when `forUpdate`.
 * A missing, out-of-scope or other employee's report (under self-service
 * access) reads as not found; a report past draft refuses with the
 * correction remedy.
 */
export async function requireEditableReceiptReport(
  executor: SqlExecutor,
  input: ReceiptReportInput,
): Promise<ReceiptReport> {
  const report = await loadReceiptReport(executor, input);
  if (report.status !== "draft") {
    throw new ReceiptCaptureRefusal(
      422,
      "report_not_draft",
      `Receipts can be scanned only onto a draft expense report — this report is ${report.status.replace(/_/g, " ")}; recall it to draft or create a correcting report`,
    );
  }
  return report;
}

export async function loadReceiptReport(
  executor: SqlExecutor,
  input: ReceiptReportInput,
): Promise<ReceiptReport> {
  const row = (
    await executor.execute<ReceiptReport>(
      sql`
    select id, status, currency, party_id as "partyId", subsidiary_id as "subsidiaryId",
           document_number as "documentNumber"
      from documents
     where org_id = ${input.orgId} and id = ${input.documentId} and kind = 'expense_report'
     ${input.forUpdate ? sql`for update` : sql``}
  `,
      "objects",
    )
  )[0];
  if (
    !row ||
    !subsidiaryScopeAllows(input.allowedSubsidiaryIds, row.subsidiaryId) ||
    !expenseAccessAllows(input.access ?? ALL_EXPENSE_REPORTS, row.partyId)
  ) {
    throw new ReceiptCaptureRefusal(404, "not_found", "Expense report not found");
  }
  return row;
}

/** The provider, model and protocol a receipt is read with under a capture configuration. */
export function receiptReader(config: DocumentCaptureRuntimeConfig): {
  provider: string;
  model: string;
  apiVersion: string;
} {
  return config.provider === "llm_vision"
    ? { provider: config.provider, model: config.model, apiVersion: config.apiVersion }
    : { provider: config.provider, model: DEFAULT_RECEIPT_MODEL, apiVersion: config.apiVersion };
}

/** Register an uploaded receipt as an extracting capture on its report. */
export async function registerReceiptCapture(
  executor: SqlExecutor,
  input: {
    orgId: string;
    documentId: string;
    fileId: string;
    contentHash: string;
    originalFilename: string;
    actorId: string;
    reader: { provider: string; model: string; apiVersion: string };
  },
): Promise<{ id: string; attempt: number }> {
  const inserted = (
    await executor.execute<{ id: string; attempts: number }>(
      sql`
    insert into expense_receipt_captures
      (org_id, document_id, file_id, content_hash, original_filename, status, attempts,
       provider, model, api_version, created_by, updated_by)
    values (${input.orgId}, ${input.documentId}, ${input.fileId}, ${input.contentHash}, ${input.originalFilename},
            'extracting', 1, ${input.reader.provider}, ${input.reader.model},
            ${input.reader.apiVersion}, ${input.actorId}, ${input.actorId})
    returning id, attempts
  `,
      "objects",
    )
  )[0];
  if (!inserted) throw new Error("Receipt capture did not persist");
  return { id: inserted.id, attempt: Number(inserted.attempts) };
}

type ReviewContext = {
  orgId: string;
  captureId: string;
  contentHash: string;
  report: ReceiptReport;
  confidenceThreshold: string;
  today: string;
};

async function postableAccounts(orgId: string, ids: Array<string | null>): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Set();
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from accounts
     where org_id = ${orgId} and is_active and not is_summary
       and id in (${sql.join(
         wanted.map((id) => sql`${id}`),
         sql`, `,
       )})
  `,
    "objects",
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * The reviewer's suggested category: the employee's own most recent
 * confirmed account for this merchant, then the organization's, then the
 * matched vendor's default expense account.
 */
export async function suggestReceiptAccount(input: {
  orgId: string;
  merchantKey: string | null;
  employeePartyId: string | null;
  merchantPartyId: string | null;
}) {
  const employeeHistory =
    input.merchantKey && input.employeePartyId
      ? ((
          await db.execute<{ account_id: string }>(
            sql`
        select c.confirmed_account_id as account_id
          from expense_receipt_captures c
          join documents d on d.id = c.document_id and d.org_id = c.org_id
         where c.org_id = ${input.orgId} and c.status = 'confirmed'
           and c.merchant_key = ${input.merchantKey} and d.party_id = ${input.employeePartyId}
         order by c.confirmed_at desc
         limit 1
      `,
            "objects",
          )
        )[0]?.account_id ?? null)
      : null;
  const organizationHistory = input.merchantKey
    ? ((
        await db.execute<{ account_id: string }>(
          sql`
        select confirmed_account_id as account_id
          from expense_receipt_captures
         where org_id = ${input.orgId} and status = 'confirmed' and merchant_key = ${input.merchantKey}
         order by confirmed_at desc
         limit 1
      `,
          "objects",
        )
      )[0]?.account_id ?? null)
    : null;
  const vendorDefault = input.merchantPartyId
    ? ((
        await db.execute<{ account_id: string | null }>(
          sql`
        select default_expense_account_id as account_id from vendor_roles
         where org_id = ${input.orgId} and party_id = ${input.merchantPartyId} and is_active
      `,
          "objects",
        )
      )[0]?.account_id ?? null)
    : null;
  return chooseAccountSuggestion({
    employeeHistory,
    organizationHistory,
    vendorDefault,
    postableAccountIds: await postableAccounts(input.orgId, [
      employeeHistory,
      organizationHistory,
      vendorDefault,
    ]),
  });
}

/** Live captures of the same file, or of the same merchant, date and total, on any report. */
export async function findReceiptDuplicates(input: {
  orgId: string;
  captureId: string;
  documentId: string;
  contentHash: string;
  merchantKey: string | null;
  transactionDate: string | null;
  total: string | null;
}): Promise<ReceiptDuplicateCandidate[]> {
  const identity = input.merchantKey && input.transactionDate && input.total;
  const rows = await db.execute<{
    id: string;
    document_id: string;
    document_number: string | null;
    same_file: boolean;
  }>(
    sql`
    select c.id, c.document_id, d.document_number, (c.content_hash = ${input.contentHash}) as same_file
      from expense_receipt_captures c
      join documents d on d.id = c.document_id and d.org_id = c.org_id
     where c.org_id = ${input.orgId} and c.id <> ${input.captureId}
       and c.status in ('extracting', 'extracted', 'confirmed')
       and (
         c.content_hash = ${input.contentHash}
         ${
           identity
             ? sql`or (c.merchant_key = ${input.merchantKey} and c.transaction_date = ${input.transactionDate}::date
                     and c.total = ${input.total}::numeric)`
             : sql``
         }
       )
     order by c.created_at
     limit 10
  `,
    "objects",
  );
  return rows.map((row) => ({
    captureId: row.id,
    reason: row.same_file ? ("same_file" as const) : ("same_receipt" as const),
    documentId: row.document_id,
    documentNumber: row.document_number,
    sameReport: row.document_id === input.documentId,
  }));
}

/** Review issues and the draft line for one reading, in its report's context. */
export async function reviewReceiptReading(
  context: ReviewContext,
  receipt: NormalizedReceipt,
): Promise<{ issues: CaptureIssue[]; draft: ReceiptLineDraft; merchantKey: string | null }> {
  const issues = validateNormalizedReceipt(receipt, {
    confidenceThreshold: context.confidenceThreshold,
    today: context.today,
  });
  const merchantConfident =
    receipt.merchantName !== null &&
    receipt.confidence.merchantName !== null &&
    cmp(receipt.confidence.merchantName, context.confidenceThreshold) >= 0;
  const merchantPartyId = merchantConfident
    ? await resolveVendorParty(context.orgId, { name: receipt.merchantName })
    : null;
  const merchantKey = receiptMerchantKey(receipt.merchantName);
  const suggestedAccount = await suggestReceiptAccount({
    orgId: context.orgId,
    merchantKey,
    employeePartyId: context.report.partyId,
    merchantPartyId,
  });
  const draft = draftExpenseLineFromReceipt({
    receipt,
    confidenceThreshold: context.confidenceThreshold,
    reportCurrency: context.report.currency,
    merchantPartyId,
    suggestedAccount,
  });
  if (draft.currency.value !== null && draft.currencyMatchesReport === false) {
    issues.push({
      code: "foreign_currency",
      severity: "warning",
      field: "currency",
      actual: draft.currency.value,
      expected: context.report.currency,
      message:
        `This receipt is in ${draft.currency.value}; the line converts into ${context.report.currency} at the dated exchange rate ` +
        `for the receipt date, or at the ${context.report.currency} amount your card statement billed`,
    });
  }
  issues.push(
    ...receiptDuplicateIssues(
      await findReceiptDuplicates({
        orgId: context.orgId,
        captureId: context.captureId,
        documentId: context.report.id,
        contentHash: context.contentHash,
        merchantKey: draft.merchantName.value === null ? null : merchantKey,
        transactionDate: draft.transactionDate.value,
        total: draft.total.value,
      }),
    ),
  );
  return { issues, draft, merchantKey };
}

/**
 * Read one extracting capture through the configured provider and record
 * its reading, issues and draft. The attempt number fences every final
 * write, so a retried or recovered capture is never overwritten by an
 * older run. A provider, configuration or source failure is recorded as
 * the capture's failure with its message; the capture can be retried.
 */
export async function extractReceiptCapture(input: {
  orgId: string;
  captureId: string;
  attempt: number;
  actorId: string;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<void> {
  const capture = (
    await db.execute<{ document_id: string | null; file_id: string | null; content_hash: string }>(
      sql`
    select document_id, file_id, content_hash from expense_receipt_captures
     where org_id = ${input.orgId} and id = ${input.captureId}
       and status = 'extracting' and attempts = ${input.attempt}
  `,
      "objects",
    )
  )[0];
  if (!capture) return;
  try {
    if (!capture.document_id)
      throw new Error("The expense report for this receipt no longer exists");
    if (!capture.file_id) throw new Error("The receipt file is no longer in the file cabinet");
    const report = await loadReceiptReport(db, {
      orgId: input.orgId,
      documentId: capture.document_id,
      allowedSubsidiaryIds: null,
    });
    const settings = await getDocumentCaptureRuntimeConfig(input.orgId, input.lookup);
    if (!settings) throw new Error(NOT_CONFIGURED);
    const blob = await loadCaptureSourceBlob(input.orgId, capture.file_id);
    const reader = receiptReader(settings);
    const extracted =
      settings.provider === "llm_vision"
        ? await extractLlmReceipt({
            config: settings.llm,
            contentType: blob.contentType,
            bytes: blob.bytes,
            fetchImpl: input.fetchImpl,
            lookup: input.lookup,
          })
        : await extractAzureReceipt({
            endpoint: settings.endpoint,
            apiKey: settings.apiKey,
            contentType: blob.contentType,
            bytes: blob.bytes,
            fetchImpl: input.fetchImpl,
            lookup: input.lookup,
          });
    const review = await reviewReceiptReading(
      {
        orgId: input.orgId,
        captureId: input.captureId,
        contentHash: capture.content_hash,
        report,
        confidenceThreshold: settings.confidenceThreshold,
        today: await businessToday(input.orgId),
      },
      extracted.normalized,
    );
    const finalized = await db.execute<{ id: string }>(
      sql`
      update expense_receipt_captures
         set status = 'extracted',
             provider = ${reader.provider}, model = ${reader.model}, api_version = ${reader.apiVersion},
             normalized = ${JSON.stringify(extracted.normalized)}::jsonb,
             evidence = ${JSON.stringify(extracted.evidence satisfies CaptureEvidence[])}::jsonb,
             issues = ${JSON.stringify(review.issues)}::jsonb,
             draft = ${JSON.stringify(review.draft)}::jsonb,
             overall_confidence = ${extracted.overallConfidence}::numeric,
             merchant_key = ${review.draft.merchantName.value === null ? null : review.merchantKey},
             merchant_party_id = ${review.draft.merchantPartyId},
             transaction_date = ${review.draft.transactionDate.value}::date,
             currency = ${review.draft.currency.value},
             total = ${review.draft.total.value}::numeric,
             last_error = null,
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.captureId}
         and status = 'extracting' and attempts = ${input.attempt}
       returning id
    `,
      "objects",
    );
    if (!finalized[0]) {
      console.warn(
        `[receipt-capture] capture ${input.captureId}: attempt ${input.attempt} was superseded before it finished`,
      );
    }
  } catch (error) {
    const message =
      (error instanceof Error ? error.message : String(error)).trim().slice(0, 300) ||
      "Receipt extraction failed";
    await db.execute(sql`
      update expense_receipt_captures
         set status = 'failed', last_error = ${message}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.captureId}
         and status = 'extracting' and attempts = ${input.attempt}
    `);
  }
}

/**
 * Claim a failed capture, or an extraction that stopped without finishing,
 * for another attempt. Returns the new attempt number.
 */
export async function claimReceiptRetry(
  executor: SqlExecutor,
  input: { orgId: string; documentId: string; captureId: string; actorId: string; now?: Date },
): Promise<number> {
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - RECEIPT_EXTRACTION_STALE_MS,
  ).toISOString();
  const claimed = (
    await executor.execute<{ attempts: number }>(
      sql`
    update expense_receipt_captures
       set status = 'extracting', attempts = attempts + 1, last_error = null,
           updated_at = now(), updated_by = ${input.actorId}
     where org_id = ${input.orgId} and id = ${input.captureId} and document_id = ${input.documentId}
       and file_id is not null
       and (status = 'failed' or (status = 'extracting' and updated_at < ${cutoff}::timestamptz))
     returning attempts
  `,
      "objects",
    )
  )[0];
  if (!claimed) {
    await refuseUnknownCapture(executor, input);
    throw new ReceiptCaptureRefusal(
      409,
      "not_retryable",
      "Only a failed or interrupted receipt scan can be retried — reload the report to see its current state",
    );
  }
  return Number(claimed.attempts);
}

async function refuseUnknownCapture(
  executor: SqlExecutor,
  input: { orgId: string; documentId: string; captureId: string },
) {
  const exists = (
    await executor.execute(
      sql`
    select 1 from expense_receipt_captures
     where org_id = ${input.orgId} and id = ${input.captureId} and document_id = ${input.documentId}
  `,
      "objects",
    )
  )[0];
  if (!exists)
    throw new ReceiptCaptureRefusal(404, "not_found", "Receipt not found on this expense report");
}

/**
 * Discard a capture so it no longer drafts a line or warns as a duplicate.
 * A confirmed capture may be discarded while its report is a draft; the line
 * it confirmed is an ordinary line the reviewer edits or removes.
 */
export async function discardReceiptCapture(
  executor: SqlExecutor,
  input: { orgId: string; documentId: string; captureId: string; actorId: string; now?: Date },
): Promise<void> {
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - RECEIPT_EXTRACTION_STALE_MS,
  ).toISOString();
  const current = (
    await executor.execute<{ status: string }>(
      sql`
    select status from expense_receipt_captures
     where org_id = ${input.orgId} and id = ${input.captureId} and document_id = ${input.documentId}
     for update
  `,
      "objects",
    )
  )[0];
  if (!current)
    throw new ReceiptCaptureRefusal(404, "not_found", "Receipt not found on this expense report");
  const discarded = (
    await executor.execute<{ id: string }>(
      sql`
    update expense_receipt_captures
       set status = 'discarded', discarded_by = ${input.actorId}, discarded_at = now(),
           updated_at = now(), updated_by = ${input.actorId}
     where org_id = ${input.orgId} and id = ${input.captureId} and document_id = ${input.documentId}
       and (status in ('extracted', 'failed', 'confirmed')
            or (status = 'extracting' and updated_at < ${cutoff}::timestamptz))
     returning id
  `,
      "objects",
    )
  )[0];
  if (!discarded) {
    throw new ReceiptCaptureRefusal(
      409,
      "not_discardable",
      "This receipt is still being read or was already discarded — reload the report to see its current state",
    );
  }
  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'expense_receipt_captures', ${input.captureId}, 'update',
            ${JSON.stringify({ before: { status: current.status }, after: { status: "discarded" } })}::jsonb,
            ${input.actorId})
  `);
}

export type ReceiptLineConfirmation = {
  captureId: string;
  /** Zero-based index of the saved line in the submitted lines. */
  lineIndex: number;
  transactionDate: string;
  merchantName: string;
  merchantPartyId: string | null;
};

export type ConfirmedLineFacts = {
  accountId: string;
  /** Report-currency amounts as saved. */
  amount: string;
  taxAmount: string;
  /** The line's original currency and amounts when it was spent in another currency. */
  originalCurrency: string | null;
  originalAmount: string | null;
  originalTaxAmount: string | null;
};

/**
 * Confirm receipt captures against the lines saved in the same transaction.
 * Each capture must be an unconfirmed reading on this report and each line
 * can carry one receipt. The line's currency must be the currency the
 * receipt was read in: a receipt in another currency than the report backs
 * a foreign-currency line in that currency. The confirmation records the
 * reviewer's merchant and date, the saved line's account and amounts, and
 * the receipt's own currency and total for duplicate detection.
 */
export async function confirmReceiptLines(
  executor: SqlExecutor,
  input: {
    orgId: string;
    documentId: string;
    reportCurrency: string;
    actorId: string;
    lines: readonly ConfirmedLineFacts[];
    confirmations: readonly ReceiptLineConfirmation[];
  },
): Promise<void> {
  if (input.confirmations.length === 0) return;
  const seenCaptures = new Set<string>();
  const seenLines = new Set<number>();
  for (const confirmation of input.confirmations) {
    const lineLabel = `Receipt line ${confirmation.lineIndex + 1}`;
    if (
      !Number.isInteger(confirmation.lineIndex) ||
      confirmation.lineIndex < 0 ||
      confirmation.lineIndex >= input.lines.length
    ) {
      throw new ReceiptCaptureRefusal(
        422,
        "receipt_line_missing",
        `${lineLabel} is not among the saved lines — add the receipt line again and save`,
      );
    }
    if (seenCaptures.has(confirmation.captureId)) {
      throw new ReceiptCaptureRefusal(
        422,
        "receipt_repeated",
        "A receipt can confirm only one line — remove the repeated receipt line and save",
      );
    }
    if (seenLines.has(confirmation.lineIndex)) {
      throw new ReceiptCaptureRefusal(
        422,
        "line_repeated",
        `${lineLabel} carries two receipts — keep one receipt per line and save`,
      );
    }
    seenCaptures.add(confirmation.captureId);
    seenLines.add(confirmation.lineIndex);
    if (!isIsoCalendarDate(confirmation.transactionDate)) {
      throw new ReceiptCaptureRefusal(
        422,
        "invalid_transaction_date",
        `${lineLabel}: enter the receipt's transaction date as YYYY-MM-DD`,
      );
    }
    const merchant = confirmation.merchantName.trim();
    if (merchant.length === 0 || merchant.length > 200) {
      throw new ReceiptCaptureRefusal(
        422,
        "invalid_merchant",
        `${lineLabel}: enter the merchant name shown on the receipt (at most 200 characters)`,
      );
    }
  }

  const ids = [...seenCaptures];
  const captures = new Map(
    (
      await executor.execute<{
        id: string;
        status: string;
        currency_readings: string[] | null;
        original_filename: string;
      }>(
        sql`
    select id, status, original_filename,
           coalesce(array(select jsonb_array_elements_text(normalized->'currencyReadings')), '{}') as currency_readings
      from expense_receipt_captures
     where org_id = ${input.orgId} and document_id = ${input.documentId}
       and id in (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
     for update
  `,
        "objects",
      )
    ).map((row) => [row.id, row]),
  );

  const vendorIds = [
    ...new Set(
      input.confirmations.map((c) => c.merchantPartyId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const vendors = vendorIds.length
    ? new Set(
        (
          await executor.execute<{ id: string }>(
            sql`
        select p.id from parties p
          join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
         where p.org_id = ${input.orgId} and p.is_active
           and p.id in (${sql.join(
             vendorIds.map((id) => sql`${id}`),
             sql`, `,
           )})
      `,
            "objects",
          )
        ).map((row) => row.id),
      )
    : new Set<string>();

  for (const confirmation of input.confirmations) {
    const capture = captures.get(confirmation.captureId);
    if (!capture)
      throw new ReceiptCaptureRefusal(404, "not_found", "Receipt not found on this expense report");
    if (capture.status !== "extracted") {
      throw new ReceiptCaptureRefusal(
        409,
        "receipt_not_open",
        `Receipt ${capture.original_filename} is ${capture.status} and cannot confirm a line — reload the report and add the line again`,
      );
    }
    const line = input.lines[confirmation.lineIndex]!;
    const lineCurrency = line.originalCurrency ?? input.reportCurrency;
    const otherReadings = (capture.currency_readings ?? []).filter((code) => code !== lineCurrency);
    if (otherReadings.length > 0) {
      throw new ReceiptCaptureRefusal(
        422,
        "currency_mismatch",
        `Receipt ${capture.original_filename} is in ${otherReadings.join(", ")} but its line is in ${lineCurrency} — ` +
          `enter the line in ${otherReadings[0]} so it converts into ${input.reportCurrency}, then save`,
      );
    }
    if (confirmation.merchantPartyId && !vendors.has(confirmation.merchantPartyId)) {
      throw new ReceiptCaptureRefusal(
        404,
        "vendor_not_found",
        "The matched vendor was not found among active vendors — clear the vendor match and save",
      );
    }
    const merchantName = confirmation.merchantName.trim();
    // The receipt's own total identifies it for duplicate detection: the
    // original amounts for a foreign-currency line, the saved amounts otherwise.
    const receiptTotal =
      line.originalCurrency !== null && line.originalAmount !== null
        ? add(line.originalAmount, line.originalTaxAmount ?? "0")
        : add(line.amount, line.taxAmount);
    const confirmed = await executor.execute<{ id: string }>(
      sql`
      update expense_receipt_captures
         set status = 'confirmed',
             confirmed_line_number = ${confirmation.lineIndex + 1},
             confirmed_account_id = ${line.accountId},
             confirmed_amount = ${line.amount}::numeric,
             confirmed_tax_amount = ${line.taxAmount}::numeric,
             confirmed_merchant_name = ${merchantName},
             merchant_key = ${receiptMerchantKey(merchantName)},
             merchant_party_id = ${confirmation.merchantPartyId},
             transaction_date = ${confirmation.transactionDate}::date,
             currency = ${lineCurrency},
             total = ${receiptTotal}::numeric,
             confirmed_by = ${input.actorId}, confirmed_at = now(),
             updated_by = ${input.actorId}, updated_at = now()
       where org_id = ${input.orgId} and id = ${confirmation.captureId}
         and document_id = ${input.documentId} and status = 'extracted'
       returning id
    `,
      "objects",
    );
    if (!confirmed[0])
      throw new Error(`receipt capture ${confirmation.captureId} could not be confirmed`);
    await executor.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'expense_receipt_captures', ${confirmation.captureId}, 'update',
              ${JSON.stringify({
                before: { status: "extracted" },
                after: {
                  status: "confirmed",
                  documentId: input.documentId,
                  lineNumber: confirmation.lineIndex + 1,
                  accountId: line.accountId,
                  amount: line.amount,
                  taxAmount: line.taxAmount,
                  currency: lineCurrency,
                  ...(line.originalCurrency !== null
                    ? {
                        originalAmount: line.originalAmount,
                        originalTaxAmount: line.originalTaxAmount,
                      }
                    : {}),
                  merchantName,
                  merchantPartyId: confirmation.merchantPartyId,
                  transactionDate: confirmation.transactionDate,
                },
              })}::jsonb,
              ${input.actorId})
    `);
  }
}

export type ReceiptCaptureView = {
  id: string;
  documentId: string;
  fileId: string | null;
  contentType: string | null;
  originalFilename: string;
  status: "extracting" | "extracted" | "failed" | "confirmed" | "discarded";
  /** An extraction that stopped without finishing; it may be retried. */
  interrupted: boolean;
  attempts: number;
  lastError: string | null;
  overallConfidence: string | null;
  normalized: NormalizedReceipt | null;
  issues: CaptureIssue[];
  draft: ReceiptLineDraft | null;
  merchantPartyName: string | null;
  confirmed: {
    lineNumber: number;
    accountId: string;
    amount: string;
    taxAmount: string | null;
    merchantName: string;
    transactionDate: string;
    at: string;
  } | null;
  createdAt: string;
};

/**
 * Duplicate warnings name the other report they match. A self-service reader
 * sees that name only for their own reports; a match on another employee's
 * report still warns, without disclosing which report it is.
 */
async function redactForeignDuplicates(
  orgId: string,
  access: ExpenseAccess,
  views: ReceiptCaptureView[],
): Promise<ReceiptCaptureView[]> {
  if (access.scope === "all") return views;
  const named = [
    ...new Set(
      views
        .flatMap((view) => view.issues)
        .filter((issue) => issue.code === "possible_duplicate" && issue.detail)
        .map((issue) => issue.detail!),
    ),
  ];
  if (named.length === 0) return views;
  const own =
    access.partyId === null
      ? new Set<string>()
      : new Set(
          (
            await db.execute<{ number: string | null; id: string }>(
              sql`
    select document_number as number, id::text as id from documents
     where org_id = ${orgId} and kind = 'expense_report' and party_id = ${access.partyId}
       and (document_number in (${sql.join(
         named.map((value) => sql`${value}`),
         sql`, `,
       )})
            or id::text in (${sql.join(
              named.map((value) => sql`${value}`),
              sql`, `,
            )}))
  `,
              "objects",
            )
          ).flatMap((row) => [row.id, ...(row.number ? [row.number] : [])]),
        );
  return views.map((view) => ({
    ...view,
    issues: view.issues.map((issue) =>
      issue.code !== "possible_duplicate" || !issue.detail || own.has(issue.detail)
        ? issue
        : {
            code: issue.code,
            severity: issue.severity,
            ...(issue.cause ? { cause: issue.cause } : {}),
            message:
              "A receipt like this one is already on another employee's expense report — discard it unless this is a separate expense",
          },
    ),
  }));
}

/** Every non-discarded capture on one report, oldest first. */
export async function listReceiptCaptures(
  orgId: string,
  documentId: string,
  now = new Date(),
  access: ExpenseAccess = ALL_EXPENSE_REPORTS,
): Promise<ReceiptCaptureView[]> {
  const cutoff = new Date(now.getTime() - RECEIPT_EXTRACTION_STALE_MS).toISOString();
  const rows = await db.execute<{
    id: string;
    document_id: string;
    file_id: string | null;
    content_type: string | null;
    original_filename: string;
    status: ReceiptCaptureView["status"];
    interrupted: boolean;
    attempts: number;
    last_error: string | null;
    overall_confidence: string | null;
    normalized: NormalizedReceipt | null;
    issues: CaptureIssue[] | null;
    draft: ReceiptLineDraft | null;
    merchant_party_name: string | null;
    confirmed_line_number: number | null;
    confirmed_account_id: string | null;
    confirmed_amount: string | null;
    confirmed_tax_amount: string | null;
    confirmed_merchant_name: string | null;
    transaction_date: string | null;
    confirmed_at: string | null;
    created_at: string;
  }>(
    sql`
    select c.id, c.document_id, c.file_id, f.content_type, c.original_filename, c.status,
           (c.status = 'extracting' and c.updated_at < ${cutoff}::timestamptz) as interrupted,
           c.attempts, c.last_error, c.overall_confidence::text, c.normalized, c.issues, c.draft,
           p.display_name as merchant_party_name, c.confirmed_line_number, c.confirmed_account_id,
           c.confirmed_amount::text, c.confirmed_tax_amount::text, c.confirmed_merchant_name,
           c.transaction_date::text, c.confirmed_at::text, c.created_at::text
      from expense_receipt_captures c
      left join files f on f.id = c.file_id and f.org_id = c.org_id
      left join parties p on p.id = c.merchant_party_id and p.org_id = c.org_id
     where c.org_id = ${orgId} and c.document_id = ${documentId} and c.status <> 'discarded'
     order by c.created_at, c.id
  `,
    "objects",
  );
  return redactForeignDuplicates(
    orgId,
    access,
    rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      fileId: row.file_id,
      contentType: row.content_type,
      originalFilename: row.original_filename,
      status: row.status,
      interrupted: row.interrupted,
      attempts: Number(row.attempts),
      lastError: row.last_error,
      overallConfidence: row.overall_confidence,
      normalized: row.normalized,
      issues: row.issues ?? [],
      draft: row.draft,
      merchantPartyName: row.merchant_party_name,
      confirmed:
        row.status === "confirmed" && row.confirmed_line_number !== null
          ? {
              lineNumber: Number(row.confirmed_line_number),
              accountId: row.confirmed_account_id!,
              amount: row.confirmed_amount!,
              taxAmount: row.confirmed_tax_amount,
              merchantName: row.confirmed_merchant_name!,
              transactionDate: row.transaction_date!,
              at: row.confirmed_at!,
            }
          : null,
      createdAt: row.created_at,
    })),
  );
}
