import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { fromUnits, sum, toUnits } from "../money/money.ts";
import { assertPeriodModulesOpen } from "../close/period-policy.ts";
import { PaymentError } from "./payment-errors.ts";
import { paymentBookId } from "./payment-accounts.ts";
import { validateCreditAllocations } from "./credit-allocation.ts";
import { type CreditAllocationInput, type OpenItemSide } from "./payment-contracts.ts";

/**
 * Standalone credit settlement: applying a posted credit memo to a posted
 * invoice or bill when NO cash moves.
 *
 * Why this is not a payment document. A credit memo and the invoice it settles
 * already sit on the SAME control account, same party, same book: the credit
 * posted DR revenue / CR AR, the invoice posted DR AR / CR revenue. Netting
 * them extinguishes two open items and moves no money, so there is nothing for
 * a journal entry to say — the settlement lives entirely in `applications`,
 * which is the same ledger the cash path writes.
 *
 * Routing it through a zero-cash payment document instead would mint a
 * document whose `total` is the CASH frame by contract (see the header note in
 * payment-documents.ts): a phantom 0.00 receipt in the payments list, the
 * module-home collected/paid tiles, remittance advice and bank matching. The
 * cash readers would each have to learn to ignore it. A settlement that moves
 * no cash does not belong in the cash frame at all.
 *
 * Everything else is deliberately shared with the cash path rather than
 * reimplemented: `validateCreditAllocations` is the one credit validator, and
 * the deferred `app_check_open` constraint trigger remains the final authority
 * on over-application in both currency frames.
 */

/** One credit memo line settling one invoice/bill line, in base currency. */
export type CreditSettlementInput = CreditAllocationInput;

export interface CreditSettlementState {
  /** The credit's open-item line, or null when the credit is not posted. */
  lineId: string | null;
  /** Absolute original amount of the credit's control line. */
  amount: string;
  /** Sum of live settlements consuming it. */
  applied: string;
  /** amount − applied: what is still available to apply. */
  open: string;
  currency: string;
  settlements: {
    applicationId: string;
    documentId: string | null;
    documentNumber: string | null;
    documentKind: string | null;
    documentDate: string | null;
    amount: string;
    appliedOn: string;
  }[];
}

/**
 * What a posted credit memo has settled so far, and what is left to apply.
 *
 * The panel that applies and releases credits reads this, so its "remaining"
 * figure and the engine's open-balance check come from the same `applications`
 * rows rather than two independently drifting summaries.
 */
export async function creditSettlementState(
  orgId: string,
  documentId: string,
): Promise<CreditSettlementState | null> {
  const line = (await db.execute<{
    id: string; amount: string; currency: string; applied: string;
  }>(sql`
    select jl.id, abs(jl.amount)::text as amount, jl.currency,
           coalesce(ap.applied, 0)::numeric(19,4)::text as applied
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      left join lateral (
        select sum(a.source_amount) as applied
          from applications a
         where a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
     where jl.org_id = ${orgId} and je.source_document_id = ${documentId} and jl.is_open_item
     limit 1
  `)).rows[0];
  if (!line) return null;
  const settlements = (await db.execute<{
    application_id: string; document_id: string | null; document_number: string | null;
    document_kind: string | null; document_date: string | null; amount: string; applied_on: string;
  }>(sql`
    select a.id as application_id, settled.id as document_id,
           settled.document_number, settled.kind as document_kind,
           settled.document_date::text as document_date,
           a.amount::text as amount, a.applied_on::text as applied_on
      from applications a
      join journal_lines target on target.id = a.to_line_id and target.org_id = a.org_id
      join journal_entries target_entry
        on target_entry.id = target.entry_id and target_entry.org_id = a.org_id
      left join documents settled
        on settled.id = target_entry.source_document_id and settled.org_id = a.org_id
     where a.org_id = ${orgId} and a.from_line_id = ${line.id} and a.unapplied_at is null
     order by a.applied_on desc, a.created_at desc
  `)).rows;
  return {
    lineId: line.id,
    amount: line.amount,
    applied: line.applied,
    open: fromUnits(toUnits(line.amount) - toUnits(line.applied)),
    currency: line.currency,
    settlements: settlements.map((row) => ({
      applicationId: row.application_id,
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.document_kind,
      documentDate: row.document_date,
      amount: row.amount,
      appliedOn: row.applied_on,
    })),
  };
}

export interface CreditSettlementResult {
  /** Ids of the `applications` rows written, in input order. */
  applicationIds: string[];
  /** Total settled, base currency. */
  amount: string;
}

interface EndpointRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  subsidiary_id: string;
  book_id: string;
}

/**
 * Apply posted credits to posted open items with no cash leg.
 *
 * `appliedOn` is the settlement date: it dates the `applications` rows, so it
 * is what aging-as-of and statement readers see, and it is gated against the
 * period lock for the settled side exactly like a payment's posting date.
 */
export async function applyStandaloneCredits(
  orgId: string,
  userId: string | null,
  input: {
    partyId: string;
    side: OpenItemSide;
    appliedOn: string;
    credits: CreditSettlementInput[];
  },
): Promise<CreditSettlementResult> {
  if (input.credits.length === 0) {
    throw new PaymentError(
      "select at least one credit to apply; a settlement with no credits would record nothing",
    );
  }
  return withOrgTransaction(orgId, async () => {
    const bookId = await paymentBookId(orgId);
    // Derive the control account from the endpoints instead of defaulting to
    // the org's AP/AR control. A credit raised against a non-default control
    // account (a financing sub-account, or a mirrored source system with
    // several AR accounts) is exactly the case `controlOverride` exists for on
    // the cash path; defaulting here would refuse it as "wrong control
    // account". validateCreditAllocations then holds every endpoint to the
    // account derived here, so deriving it cannot widen the check.
    const endpointIds = [
      ...new Set(input.credits.flatMap((credit) => [credit.fromLineId, credit.toLineId])),
    ];
    const endpoints = (await db.execute<EndpointRow>(sql`
      select jl.id, jl.account_id, jl.subsidiary_id, je.book_id
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and jl.id in ${endpointIds}
    `)).rows;
    if (endpoints.length !== endpointIds.length) {
      throw new PaymentError(
        "a credit or open item in this settlement no longer exists; reload the credits and reselect",
      );
    }
    const accounts = new Set(endpoints.map((row) => row.account_id));
    if (accounts.size !== 1) {
      throw new PaymentError(
        "every credit and open item in one settlement must sit on the same control account; settle each control account separately",
      );
    }
    const subsidiaries = new Set(endpoints.map((row) => row.subsidiary_id));
    if (subsidiaries.size !== 1) {
      throw new PaymentError(
        "every credit and open item in one settlement must belong to the same legal entity; settle each legal entity separately",
      );
    }
    const controlAccountId = [...accounts][0]!;
    const subsidiaryId = [...subsidiaries][0]!;

    // The one credit validator. It locks the endpoint lines FOR UPDATE, so two
    // concurrent settlements of the same credit serialize here and the second
    // sees the first's committed application in its open-balance check.
    await validateCreditAllocations(input.credits, [], {
      orgId,
      partyId: input.partyId,
      subsidiaryId,
      bookId,
      side: input.side,
      controlAccountId,
    });

    // A settlement dated into a closed period would silently move an aged
    // balance behind a lock the close already signed off on.
    const period = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${orgId} and is_adjustment = false
         and starts_on <= ${input.appliedOn} and ends_on >= ${input.appliedOn}
       limit 1
    `)).rows[0];
    if (!period) {
      throw new PaymentError(
        `no accounting period covers ${input.appliedOn}; open the period from Accounting → Periods or settle on a date inside an existing period`,
      );
    }
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId: period.id,
      bookId,
      subsidiaryIds: [subsidiaryId],
      modules: [input.side],
    });

    const applicationIds: string[] = [];
    for (const credit of input.credits) {
      // Same-currency by construction: validateCreditAllocations refuses any
      // endpoint whose transaction currency differs from its base currency, so
      // both frames carry the same amount at rate 1 and no realized FX arises.
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into applications
          (org_id, from_line_id, to_line_id, amount, source_amount,
           source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference,
           applied_on, created_by, updated_by)
        select ${orgId}, ${credit.fromLineId}, ${credit.toLineId}, ${credit.amount},
               ${credit.amount}, ${credit.amount}, jl.currency,
               ${credit.amount}, jl.currency,
               '1', 'same_currency', 'credit applied without cash',
               ${input.appliedOn}, ${userId}, ${userId}
          from journal_lines jl
         where jl.id = ${credit.fromLineId} and jl.org_id = ${orgId}
        returning id
      `)).rows[0];
      // A write that matches zero rows is a failure, not a success.
      if (!inserted) {
        throw new PaymentError(
          "the credit line disappeared while its settlement was being recorded; retry the application",
        );
      }
      applicationIds.push(inserted.id);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${orgId}, 'applications', ${inserted.id}, 'insert',
                ${JSON.stringify({
                  mode: "credit_applied_without_cash",
                  source: "payments.credit-settlement",
                  before: null,
                  after: {
                    fromLineId: credit.fromLineId,
                    toLineId: credit.toLineId,
                    sourceDocumentId: credit.sourceDocumentId,
                    amount: credit.amount,
                    appliedOn: input.appliedOn,
                    side: input.side,
                  },
                })}::jsonb,
                ${userId}, 'payments.credit-settlement')
      `);
    }
    return { applicationIds, amount: sum(input.credits.map((credit) => credit.amount)) };
  });
}

interface LiveApplicationRow extends Record<string, unknown> {
  id: string;
  amount: string;
  applied_on: string;
  from_line_id: string;
  to_line_id: string;
  from_document_kind: string | null;
  from_document_number: string | null;
  to_document_number: string | null;
  to_entry_number: string;
  subsidiary_id: string;
  book_id: string;
}

/**
 * Release a live credit settlement, reopening both balances.
 *
 * This is the arm behind the void refusal "unapply them before voiding": until
 * it existed, an operator told to unapply had no action that did so, and the
 * only real path was voiding the settling document.
 *
 * It releases CREDIT settlements only. A cash application's evidence belongs to
 * its payment — releasing it here would leave the payment claiming a settlement
 * that no longer exists — so those are refused by name, pointing at the void
 * that does own them.
 */
export async function unapplyCreditSettlement(
  orgId: string,
  userId: string | null,
  applicationId: string,
): Promise<{ amount: string }> {
  return withOrgTransaction(orgId, async () => {
    const application = (await db.execute<LiveApplicationRow>(sql`
      select a.id, a.amount, a.applied_on::text as applied_on,
             a.from_line_id, a.to_line_id,
             from_document.kind as from_document_kind,
             from_document.document_number as from_document_number,
             to_document.document_number as to_document_number,
             to_entry.entry_number as to_entry_number,
             from_line.subsidiary_id, from_entry.book_id
        from applications a
        join journal_lines from_line
          on from_line.id = a.from_line_id and from_line.org_id = a.org_id
        join journal_entries from_entry
          on from_entry.id = from_line.entry_id and from_entry.org_id = a.org_id
        left join documents from_document
          on from_document.id = from_entry.source_document_id and from_document.org_id = a.org_id
        join journal_lines to_line
          on to_line.id = a.to_line_id and to_line.org_id = a.org_id
        join journal_entries to_entry
          on to_entry.id = to_line.entry_id and to_entry.org_id = a.org_id
        left join documents to_document
          on to_document.id = to_entry.source_document_id and to_document.org_id = a.org_id
       where a.org_id = ${orgId} and a.id = ${applicationId} and a.unapplied_at is null
       for update of a
    `)).rows[0];
    if (!application) {
      throw new PaymentError(
        "this settlement is not live; it was already released or never existed",
      );
    }
    if (
      application.from_document_kind !== "customer_credit" &&
      application.from_document_kind !== "vendor_credit"
    ) {
      throw new PaymentError(
        `${application.from_document_number ?? "this settlement"} is a cash application, not a credit; void the payment to release what it settled`,
      );
    }
    // The settled side follows from the credit's kind, not from the sign of a
    // line: a customer credit settles AR, a vendor credit settles AP.
    const side: OpenItemSide =
      application.from_document_kind === "customer_credit" ? "ar" : "ap";
    // A credit the cash path recorded carries its evidence on that payment's
    // stored creditAllocations. Releasing it here would leave the payment — and
    // the remittance advice printed from it — claiming a credit the bill was no
    // longer reduced by. jsonb containment matches the stored element by its
    // endpoints regardless of the other keys beside them.
    const carrier = (await db.execute<{ document_number: string }>(sql`
      select document_number from documents
       where org_id = ${orgId}
         and kind in ('customer_payment', 'vendor_payment')
         and status <> 'void'
         and custom -> 'creditAllocations' @> ${JSON.stringify([
           { fromLineId: application.from_line_id, toLineId: application.to_line_id },
         ])}::jsonb
       limit 1
    `)).rows[0];
    if (carrier) {
      throw new PaymentError(
        `this credit was applied by payment ${carrier.document_number}; void that payment to release it`,
      );
    }

    // Reopening a balance behind a closed period is the same event as settling
    // into one, and is gated the same way.
    const period = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${orgId} and is_adjustment = false
         and starts_on <= ${application.applied_on} and ends_on >= ${application.applied_on}
       limit 1
    `)).rows[0];
    if (!period) {
      throw new PaymentError(
        `no accounting period covers this settlement's date ${application.applied_on}; it cannot be released until that period exists`,
      );
    }
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId: period.id,
      bookId: application.book_id,
      subsidiaryIds: [application.subsidiary_id],
      modules: [side],
    });

    const released = (await db.execute<{ id: string }>(sql`
      update applications
         set unapplied_at = now(), updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId} and id = ${applicationId} and unapplied_at is null
      returning id
    `)).rows[0];
    // The row was locked above, so losing it here means a concurrent release
    // committed first; reporting {ok} would claim this actor's release.
    if (!released) {
      throw new PaymentError(
        "this settlement was released by another action before this one completed",
      );
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'applications', ${applicationId}, 'delete',
              ${JSON.stringify({
                mode: "credit_settlement_released",
                source: "payments.credit-settlement",
                before: {
                  fromLineId: application.from_line_id,
                  toLineId: application.to_line_id,
                  amount: application.amount,
                  appliedOn: application.applied_on,
                  creditDocument: application.from_document_number,
                  settledDocument:
                    application.to_document_number ?? application.to_entry_number,
                },
                after: null,
              })}::jsonb,
              ${userId}, 'payments.credit-settlement')
    `);
    return { amount: application.amount };
  });
}
