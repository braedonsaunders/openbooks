import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { appliedLegAmountExpr } from "../records/balance-due.ts";
import {
  CONTROL_ACCOUNT_ROLE_LABELS,
  loadControlAccountsForRoles,
  type ControlAccountRole,
  type OrgControlAccounts,
} from "../records/control-accounts.ts";
import { createDocument, DocumentCreateConflict } from "../ledger/document-write.ts";
import type { DocumentEditInput } from "../ledger/document-input.ts";
import { controlDeps } from "../ledger/document-service.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { runRecordFlows } from "../flows/run.ts";
import { subsidiaryFunctionalCurrency } from "../ledger/document-fx.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { carryingAmountForSettlement, rateMeasuringExactly } from "./settlement-policy.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { applyStandaloneCredits, creditSettlementState } from "./credit-settlement.ts";

/**
 * Governed invoice write-off: an uncollectible balance of a posted customer
 * invoice is cleared by a customer credit memo whose single line debits the
 * write-off account and whose AR leg settles the invoice's open item.
 *
 * Posting, from the operator's view:
 *   Dr allowance for doubtful accounts  (when that control is configured), else
 *   Dr bad debt expense                 (Company Settings → Control accounts)
 *   Cr accounts receivable              (the credit memo's open item)
 * followed by a standalone application of that credit to the invoice. No cash
 * moves, so the settlement lives in the applications ledger like every other
 * credit settlement.
 *
 * A foreign-currency invoice is written off in its own currency at the rate its
 * remaining receivable is carried at (its booked amount net of what has been
 * applied, never a revaluation, which is unrealized and reverses): the credit
 * memo records that rate as its explicit rate, so its receivable leg relieves
 * exactly the carrying amount it settles and the write-off expense is that
 * carrying amount, the same carrying-amount convention every application of a
 * credit uses. The receivable clears in both currencies with no exchange
 * difference left to realize.
 *
 * The credit memo is the native carrier: it reuses the customer credit posting
 * rule, numbering, audit, void and the credit-application ledger rather than
 * introducing a document kind. The ordinary customer credit memo drawer keeps
 * its income-account picker; the write-off action is the only UI path that
 * selects the write-off account.
 *
 * Atomicity: the credit creation, its approval release, its posting and the
 * application all run in one transaction, so a refusal at any step leaves no
 * credit memo and no settlement behind. The caller's Idempotency-Key is the
 * credit memo's document id (createDocument's replay contract) and the first
 * application's id (applyStandaloneCredits' replay contract), so a retried
 * request resolves to the write-off it already recorded.
 */

/** The account roles a write-off may debit, in precedence order. */
export type InvoiceWriteOffAccountRole = Extract<
  ControlAccountRole,
  "allowanceForDoubtfulAccounts" | "badDebtExpense"
>;

const MAX_REASON_LENGTH = 500;
const AMOUNT_PATTERN = /^\d+(\.\d{1,4})?$/;

/**
 * Pick the account a write-off debits. An allowance, when the organization
 * provisions one, is the contra-receivable the write-off draws down; otherwise
 * the write-off is recognized directly as bad debt expense. Refuses by name
 * when neither control is configured: a write-off with no debit account would
 * otherwise have nowhere to post.
 */
export function resolveInvoiceWriteOffAccount(mappings: OrgControlAccounts): {
  role: InvoiceWriteOffAccountRole;
  accountId: string;
} {
  const allowance = mappings.allowanceForDoubtfulAccounts;
  if (allowance) return { role: "allowanceForDoubtfulAccounts", accountId: allowance };
  const expense = mappings.badDebtExpense;
  if (expense) return { role: "badDebtExpense", accountId: expense };
  throw new PaymentError(
    `Invoice write-off has no account to debit: set ${CONTROL_ACCOUNT_ROLE_LABELS.badDebtExpense} ` +
      `(or ${CONTROL_ACCOUNT_ROLE_LABELS.allowanceForDoubtfulAccounts}) under Company Settings → ` +
      `Control accounts, then write off the invoice again`,
  );
}

/**
 * Exact, canonical write-off amount: a positive decimal with at most four
 * places (the ledger's stored precision), never a float. Returns the ledger's
 * canonical 4-place string so the same value is stored and compared.
 */
export function normalizeInvoiceWriteOffAmount(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!AMOUNT_PATTERN.test(text)) {
    throw new PaymentError(
      "Write-off amount must be a positive amount with at most four decimal places, such as 125.1250",
    );
  }
  const units = toUnits(text);
  if (units <= 0n) throw new PaymentError("Write-off amount must be greater than zero");
  return fromUnits(units);
}

/** Refuse a write-off larger than what the invoice still owes. */
export function assertInvoiceWriteOffWithinOpenBalance(
  amount: string,
  openBalance: string,
  invoiceNumber: string,
): void {
  if (toUnits(amount) > toUnits(openBalance)) {
    throw new PaymentError(
      `Write-off amount ${amount} is more than the open balance ${openBalance} on ${invoiceNumber}; ` +
        `enter ${openBalance} or less`,
    );
  }
}

/** A write-off date is a calendar date and cannot precede the invoice it clears. */
export function validateInvoiceWriteOffDate(
  date: unknown,
  invoiceNumber: string,
  invoiceDate: string,
): string {
  if (!isIsoCalendarDate(date))
    throw new PaymentError("Write-off date must be a calendar date (YYYY-MM-DD)");
  if (date < invoiceDate) {
    throw new PaymentError(
      `Write-off date ${date} is before invoice ${invoiceNumber} dated ${invoiceDate}; choose a date on or after the invoice date`,
    );
  }
  return date;
}

/** Every write-off states why the balance is uncollectible. */
export function normalizeInvoiceWriteOffReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length === 0) {
    throw new PaymentError("A write-off needs a reason: state why the balance is uncollectible");
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new PaymentError(`Write-off reason must be ${MAX_REASON_LENGTH} characters or fewer`);
  }
  return reason;
}

/**
 * A reused Idempotency-Key whose stored write-off differs from this request, or
 * a key owned by another tenant. The earlier write-off is never returned as though
 * it matched.
 */
export class InvoiceWriteOffConflictError extends PaymentError {
  constructor() {
    super(
      "this Idempotency-Key was already used for a different write-off; start a new write-off with a new key",
    );
    this.name = "InvoiceWriteOffConflictError";
  }
}

export interface InvoiceWriteOffInput {
  invoiceId: string;
  amount: unknown;
  date: unknown;
  reason: unknown;
  /** The caller's Idempotency-Key (a UUID): one key, one write-off. */
  idempotencyKey: string;
}

export interface InvoiceWriteOffResult {
  status: "written_off" | "replayed";
  creditMemoId: string;
  creditMemoNumber: string;
  amount: string;
  currency: string;
  accountId: string;
  applicationIds: string[];
}

interface InvoiceRow extends Record<string, unknown> {
  id: string;
  kind: string;
  status: string;
  documentNumber: string;
  partyId: string | null;
  subsidiaryId: string | null;
  currency: string;
  documentDate: string;
  entryId: string | null;
}

/**
 * Write off the open balance of a posted customer invoice, in one transaction.
 * The native credit permissions (ar.create, ar.post and ar.pay) and subsidiary
 * scope are pinned inside the command as well as checked by its callers.
 */
export async function writeOffInvoice(
  orgId: string,
  userId: string,
  input: InvoiceWriteOffInput,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<InvoiceWriteOffResult> {
  const outcome = await withOrgTransaction(orgId, () =>
    writeOffInvoiceInTransaction(orgId, userId, input, allowedSubsidiaryIds),
  );
  await runInvoiceWriteOffFlows(orgId, userId, outcome);
  return outcome.result;
}

/** A write-off recorded inside the caller's transaction, with what its record flows need after commit. */
export interface InvoiceWriteOffOutcome {
  created: Awaited<ReturnType<typeof createDocument>>;
  result: InvoiceWriteOffResult;
}

/**
 * The write-off itself, inside the caller's open organization transaction, so
 * a caller that settles the same invoice with cash (bank matching) commits
 * the receipt and the write-off of its short-paid remainder as one unit. The
 * caller runs `runInvoiceWriteOffFlows` once that transaction commits.
 */
export async function writeOffInvoiceInTransaction(
  orgId: string,
  userId: string,
  input: InvoiceWriteOffInput,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<InvoiceWriteOffOutcome> {
  if (!isUuid(input.idempotencyKey)) {
    throw new PaymentError(
      "an Idempotency-Key with a UUID is required, so a retried write-off cannot post twice",
    );
  }
  const reason = normalizeInvoiceWriteOffReason(input.reason);
  const amount = normalizeInvoiceWriteOffAmount(input.amount);
  return withOrgTransaction(orgId, async () => {
    // The key lock createDocument takes for the same key. Taking it first makes
    // a concurrent retry wait for this write-off to commit, then observe the
    // posted credit and replay, instead of reading a stale open balance.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey}, 0))`,
    );

    const invoice = (
      await db.execute<InvoiceRow>(
        sql`
      select d.id, d.kind, d.status, d.document_number as "documentNumber",
             d.party_id as "partyId", d.subsidiary_id as "subsidiaryId",
             d.currency, d.document_date::text as "documentDate",
             d.posted_entry_id as "entryId"
        from documents d
       where d.org_id = ${orgId} and d.id = ${input.invoiceId}
       for update`,
        "objects",
      )
    )[0];
    if (
      !invoice ||
      (invoice.subsidiaryId !== null &&
        !subsidiaryScopeAllows(allowedSubsidiaryIds, invoice.subsidiaryId))
    ) {
      throw new ScopeNotFoundError();
    }
    for (const permission of ["ar.create", "ar.post", "ar.pay"]) {
      await lockActorCommandAuthority(db, orgId, userId, invoice.subsidiaryId, permission);
    }
    if (invoice.kind !== "customer_invoice") {
      throw new PaymentError("Only a customer invoice can be written off");
    }
    if (invoice.status !== "posted" || !invoice.entryId) {
      throw new PaymentError(
        `${invoice.documentNumber} is ${invoice.status}; only a posted invoice with an open balance can be written off`,
      );
    }
    if (!invoice.partyId) {
      throw new PaymentError(
        `${invoice.documentNumber} has no customer; a write-off settles a customer receivable`,
      );
    }
    if (!invoice.subsidiaryId) {
      throw new PaymentError(
        `${invoice.documentNumber} has no legal entity; a write-off must post to one`,
      );
    }
    const functionalCurrency = await subsidiaryFunctionalCurrency(db, orgId, invoice.subsidiaryId);
    if (!functionalCurrency) {
      throw new PaymentError(
        `${invoice.documentNumber}'s legal entity has no functional currency; set its base currency in Setup, then write off the invoice again`,
      );
    }
    const foreign = invoice.currency !== functionalCurrency;

    const openItems = await db.execute<{ id: string; amount: string; txnAmount: string }>(
      sql`
      select jl.id, abs(jl.amount)::text as amount, abs(jl.txn_amount)::text as "txnAmount"
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.id = ${invoice.entryId} and je.status = 'posted' -- Live entries only: only a current invoice open item authorizes a write-off.
         and jl.is_open_item
       order by jl.id
       for update of jl`,
      "objects",
    );
    if (openItems.length !== 1) {
      throw new PaymentError(
        `${invoice.documentNumber} has ${openItems.length} open items; an invoice write-off settles a single open item, so resolve the invoice's open items before writing it off`,
      );
    }
    const openLine = openItems[0]!;
    // The remaining receivable in both frames: what is still owed in the
    // invoice's currency, and the functional amount it is carried at.
    const applied = (
      await db.execute<{ applied: string; applied_txn: string }>(
        sql`
      select coalesce(sum(${appliedLegAmountExpr("a", sql`${openLine.id}`, "base")}), 0)::text as applied,
             coalesce(sum(${appliedLegAmountExpr("a", sql`${openLine.id}`, "transaction")}), 0)::text as applied_txn
        from applications a
       where a.org_id = ${orgId} and a.unapplied_at is null
         and (a.to_line_id = ${openLine.id} or a.from_line_id = ${openLine.id})`,
        "objects",
      )
    )[0]!;
    const openCarrying = fromUnits(toUnits(openLine.amount) - toUnits(applied.applied));
    const openBalance = fromUnits(toUnits(openLine.txnAmount) - toUnits(applied.applied_txn));

    // A key that already produced a credit memo is a replay: its amount was
    // checked against the balance when it first posted, and that balance is now
    // partly or wholly settled by the write-off itself.
    const date = validateInvoiceWriteOffDate(
      input.date,
      invoice.documentNumber,
      invoice.documentDate,
    );
    const priorCredit = (
      await db.execute<{ id: string }>(
        sql`
      select id from documents where org_id = ${orgId} and id = ${input.idempotencyKey}`,
        "objects",
      )
    )[0];
    if (!priorCredit) {
      assertInvoiceWriteOffWithinOpenBalance(amount, openBalance, invoice.documentNumber);
    }

    const account = resolveInvoiceWriteOffAccount(
      await loadControlAccountsForRoles(db, orgId, [
        "allowanceForDoubtfulAccounts",
        "badDebtExpense",
      ]),
    );

    // A foreign-currency invoice is written off in its own currency at the
    // rate its remaining receivable is carried at, so the credit relieves
    // exactly the carrying amount it settles and the write-off expense is
    // that carrying amount: derecognition at book value, with no exchange
    // difference to realize. (Settling at the write-off date's spot rate
    // would invent a realized gain or loss on a balance that was never
    // collected.) The rate is recorded as the credit memo's explicit rate
    // evidence, which posting re-validates like any recorded rate.
    let explicitFx: DocumentEditInput["explicitFx"] = undefined;
    if (foreign && !priorCredit) {
      if (!(await lockAndCheckOrgFeature(db, orgId, "multiCurrency"))) {
        throw new PaymentError(
          `${invoice.documentNumber} is in ${invoice.currency}; writing it off records the receivable's carrying rate, ` +
            `which needs Multi-currency — turn it on in Company Settings → Features, then write off the invoice again`,
        );
      }
      const carrying = carryingAmountForSettlement(openCarrying, openBalance, amount);
      explicitFx = {
        rate: rateMeasuringExactly(amount, carrying).rate,
        source: "Receivable carrying rate",
        reason: `The rate ${invoice.documentNumber}'s remaining receivable is carried at, so the write-off relieves its carrying amount`,
        fromCurrency: invoice.currency,
        toCurrency: functionalCurrency,
        rateDate: date,
      };
    }

    const body: DocumentEditInput = {
      partyId: invoice.partyId,
      subsidiaryId: invoice.subsidiaryId,
      // The credit is stated in the invoice's own currency.
      ...(foreign ? { currency: invoice.currency } : {}),
      ...(explicitFx ? { explicitFx } : {}),
      documentDate: date,
      referenceNumber: invoice.documentNumber,
      memo: `Write-off of ${invoice.documentNumber}: ${reason}`,
      lines: [
        {
          accountId: account.accountId,
          amount,
          description: `Write-off of ${invoice.documentNumber}`,
        },
      ],
    };
    let created: Awaited<ReturnType<typeof createDocument>>;
    try {
      created = await createDocument({
        orgId,
        userId,
        kind: "customer_credit",
        key: input.idempotencyKey,
        subsidiaryId: invoice.subsidiaryId,
        body,
        requestBody: {
          kind: "invoice_write_off",
          invoiceId: invoice.id,
          amount,
          date,
          reason,
        },
      });
    } catch (error) {
      if (error instanceof DocumentCreateConflict) throw new InvoiceWriteOffConflictError();
      throw error;
    }

    if (created.status === "created") {
      const submission = await submitAndReleaseIfUngated("customer_credit", created.id, userId);
      if (submission.flowError) {
        throw new PaymentError(
          `The write-off could not be released for approval: ${submission.flowError}. Correct the approval flow for customer credit memos, then write off the invoice again`,
        );
      }
      if (submission.gated) {
        throw new PaymentError(
          `Customer credit memos are gated by an approval flow, and a write-off must settle in one step. ` +
            `Remove or narrow that approval flow for customer credit memos, then write off ${invoice.documentNumber} again`,
        );
      }
      await postDocument(created.id, await controlDeps(orgId), {
        audit: { actorId: userId, source: "invoice_write_off" },
      });
    } else {
      const status = (
        await db.execute<{ status: string }>(
          sql`
        select status from documents where org_id = ${orgId} and id = ${created.id}`,
          "objects",
        )
      )[0]?.status;
      if (status !== "posted") {
        throw new PaymentError(
          `This write-off was already recorded as ${created.documentNumber} and is ${status ?? "missing"}; ` +
            `it cannot be applied again. Start a new write-off for the remaining balance`,
        );
      }
    }

    const credit = await creditSettlementState(orgId, created.id, allowedSubsidiaryIds);
    if (!credit?.lineId) {
      throw new PaymentError(
        `The write-off credit memo ${created.documentNumber} did not post an open item to settle`,
      );
    }
    const settled = await applyStandaloneCredits(
      orgId,
      userId,
      {
        partyId: invoice.partyId,
        side: "ar",
        appliedOn: date,
        credits: [
          {
            fromLineId: credit.lineId,
            toLineId: openLine.id,
            amount,
            sourceDocumentId: created.id,
          },
        ],
        idempotencyKey: input.idempotencyKey,
      },
      allowedSubsidiaryIds,
    );

    return {
      created,
      result: {
        status: created.status === "created" ? "written_off" : "replayed",
        creditMemoId: created.id,
        creditMemoNumber: created.documentNumber,
        amount,
        currency: invoice.currency,
        accountId: account.accountId,
        applicationIds: settled.applicationIds,
      } satisfies InvoiceWriteOffResult,
    };
  });
}

/**
 * Record flows fire only after the write-off commits (the createDocument
 * contract), and only for a write-off this request created.
 */
export async function runInvoiceWriteOffFlows(
  orgId: string,
  userId: string,
  outcome: InvoiceWriteOffOutcome,
): Promise<void> {
  if (outcome.created.status !== "created") return;
  await runRecordFlows({ kind: "on_create", source: "ui" }, "customer_credit", outcome.created.id, {
    orgId,
    userId,
  });
  if (outcome.created.deferredUpdate) {
    await runRecordFlows(outcome.created.deferredUpdate, "customer_credit", outcome.created.id, {
      orgId,
      userId,
    });
  }
}
