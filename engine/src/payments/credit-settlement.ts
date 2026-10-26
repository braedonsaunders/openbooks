import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { cmp, fromUnits, isZero, neg, sum, toUnits } from "../money/money.ts";
import { postEntry, markEntryReversed } from "../journal/post-entry.ts";
import { carryingAmountForSettlement, realizedFxControlAdjustment } from "./settlement-policy.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { CreditApplicationConflictError, PaymentError } from "../payments-core/payment-errors.ts";
import { paymentBookId, paymentControlDeps } from "./payment-accounts.ts";
import { validateCreditAllocations } from "./credit-allocation.ts";
import { assertNoForeignRunReservation } from "./payment-queries.ts";
import { type CreditAllocationInput, type OpenItemSide } from "./payment-contracts.ts";
import {
  ScopeNotFoundError,
  subsidiaryScopeAllows,
  subsidiaryVisibleFilter,
} from "../organization/subsidiary-scope.ts";

/**
 * Standalone credit settlement: applying a posted credit memo to a posted
 * invoice or bill when NO cash moves. A payment's unapplied cash — the
 * on-account credit a receipt kept, or a vendor payment's prepayment — is a
 * credit on the same control account and is applied the same way, later,
 * to the party's other open documents.
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

/**
 * Evidence reference of an application this path records from a payment's
 * unapplied cash. A payment's own posting-time applications carry their
 * allocation's evidence instead, so the release path can tell the two apart:
 * it releases these, and leaves the payment's cash applications to its void.
 */
export const UNAPPLIED_PAYMENT_APPLICATION_REFERENCE = "unapplied payment applied without cash";
const CREDIT_APPLICATION_REFERENCE = "credit applied without cash";
const PAYMENT_SOURCE_KINDS: ReadonlySet<string> = new Set(["customer_payment", "vendor_payment"]);

/** One credit memo line settling one invoice/bill line, in their shared transaction currency. */
export type CreditSettlementInput = CreditAllocationInput;

export interface CreditSettlementState {
  /** The credit's open-item line, or null when the credit is not posted. */
  lineId: string | null;
  /** Absolute original amount of the credit's control line, in its transaction currency. */
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
 * What a posted credit memo — or a payment's unapplied cash — has settled so
 * far, and what is left to apply. For a payment, the remaining figure is the
 * cash it moved beyond everything it applied, and the settlements are the
 * later applications of that cash.
 *
 * The panel that applies and releases credits reads this, so its "remaining"
 * figure and the engine's open-balance check come from the same `applications`
 * rows rather than two independently drifting summaries.
 */
export async function creditSettlementState(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<CreditSettlementState | null> {
  return withOrgTransaction(orgId, async () => {
    const line = (
      await db.execute<{
        id: string;
        amount: string;
        currency: string;
        applied: string;
        kind: string;
      }>(
        sql`
    select jl.id, abs(jl.txn_amount)::text as amount, jl.currency, source_document.kind,
           coalesce(ap.applied, 0)::numeric(19,4)::text as applied
      from journal_lines jl
      -- Live entries only: a voided credit has nothing left to apply.
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      join documents source_document on source_document.id = je.source_document_id and source_document.org_id = je.org_id
      left join lateral (
        select sum(a.source_transaction_amount) as applied
          from applications a
         where a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
     where jl.org_id = ${orgId} and je.source_document_id = ${documentId} and jl.is_open_item
       ${subsidiaryVisibleFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     limit 1
  `,
        "objects",
      )
    )[0];
    if (!line) return null;
    const settlements = await db.execute<{
      application_id: string;
      document_id: string | null;
      document_number: string | null;
      document_kind: string | null;
      document_date: string | null;
      amount: string;
      applied_on: string;
    }>(
      sql`
    select a.id as application_id, settled.id as document_id,
           settled.document_number, settled.kind as document_kind,
           settled.document_date::text as document_date,
           a.source_transaction_amount::text as amount, a.applied_on::text as applied_on
      from applications a
      join journal_lines target on target.id = a.to_line_id and target.org_id = a.org_id
      join journal_entries target_entry
        on target_entry.id = target.entry_id and target_entry.org_id = a.org_id
      left join documents settled
        on settled.id = target_entry.source_document_id and settled.org_id = a.org_id
     where a.org_id = ${orgId} and a.from_line_id = ${line.id} and a.unapplied_at is null
       -- A payment's own cash applications are its record, not settlements of its unapplied cash.
       ${PAYMENT_SOURCE_KINDS.has(line.kind) ? sql`and a.settlement_rate_reference = ${UNAPPLIED_PAYMENT_APPLICATION_REFERENCE}` : sql``}
       ${subsidiaryVisibleFilter(sql`settled.subsidiary_id`, allowedSubsidiaryIds)}
     order by a.applied_on desc, a.created_at desc
  `,
      "objects",
    );
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
  });
}

export interface CreditSettlementResult {
  /** Ids of the `applications` rows written, in input order. */
  applicationIds: string[];
  /** Total settled, in the credits' transaction currency. */
  amount: string;
}

interface EndpointRow extends Record<string, unknown> {
  id: string;
  document_kind: string | null;
  account_id: string;
  subsidiary_id: string;
  book_id: string;
  document_subsidiary_id: string | null;
  posting_date: string;
  entry_number: string;
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
    /** The caller's Idempotency-Key: one key, one settlement. */
    idempotencyKey: string;
  },
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<CreditSettlementResult> {
  if (input.credits.length === 0) {
    throw new PaymentError(
      "select at least one credit to apply; a settlement with no credits would record nothing",
    );
  }
  return withOrgTransaction(orgId, async () => {
    // One key, one settlement. The advisory lock is org-scoped so a cross-org
    // key collision cannot serialize unrelated tenants, and it is held to the
    // transaction: a concurrent identical submit waits here and then replays
    // the first result instead of writing a second settlement beside it.
    // The deferred app_check_open trigger only stops a retry that overdraws
    // the credit — a partial application duplicated silently, which is why
    // the key, not the trigger, is the fence.
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`credit-application:${orgId}:${input.idempotencyKey}`}, 0)
      )
    `);
    const endpointIds = [
      ...new Set(input.credits.flatMap((credit) => [credit.fromLineId, credit.toLineId])),
    ];
    const endpoints = await db.execute<EndpointRow>(
      sql`
      select jl.id, jl.account_id, jl.subsidiary_id, je.book_id,
             endpoint_document.kind as document_kind,
             endpoint_document.subsidiary_id as document_subsidiary_id,
             je.posting_date::text as posting_date,
             coalesce(endpoint_document.document_number, je.entry_number) as entry_number
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        left join documents endpoint_document on endpoint_document.id = je.source_document_id and endpoint_document.org_id = je.org_id
       where jl.org_id = ${orgId} and jl.id in ${endpointIds}
       order by jl.id
       for update of jl
    `,
      "objects",
    );
    if (endpoints.length !== endpointIds.length) {
      throw new PaymentError(
        "a credit or open item in this settlement no longer exists; reload the credits and reselect",
      );
    }
    if (
      endpoints.some(
        (row) =>
          !subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id) ||
          (row.document_subsidiary_id !== null &&
            !subsidiaryScopeAllows(allowedSubsidiaryIds, row.document_subsidiary_id)),
      )
    ) {
      throw new ScopeNotFoundError();
    }
    // The request-controlled image a retry must equal under canonical JSON.
    // Results are excluded: a genuine retry replays them, never compares.
    // This follows web/lib/api/idempotency.ts's claimSetupCreate contract —
    // the first application row's id IS the key, so a retry resolves to the
    // same settlement; the engine cannot import the web helper, so the claim
    // is spelled out here against the same audit-image convention (match on
    // the insert audit row, request_id = key).
    const matchImage = {
      partyId: input.partyId,
      side: input.side,
      appliedOn: input.appliedOn,
      credits: input.credits.map((credit) => ({
        fromLineId: credit.fromLineId,
        toLineId: credit.toLineId,
        amount: credit.amount,
        sourceDocumentId: credit.sourceDocumentId,
      })),
    };
    // The claim reads ACROSS organizations through the sanctioned bypass
    // context: under RLS the ambient org filter hides another tenant's
    // application row, so without this the foreign-key detection never fires
    // and the collision surfaces later as a raw primary-key violation — a
    // correct refusal arriving as an internal error instead of the named
    // 409. The row is never returned to the caller; only its org_id is.
    // bypass: cross-org-by-design — an idempotency key owned by another organization must be seen to be refused by name.
    const priorOwner = await withBypassContext(
      async () =>
        (
          await db.execute<{ org_id: string }>(
            sql`
        select org_id from applications where id = ${input.idempotencyKey}
      `,
            "objects",
          )
        )[0]?.org_id,
    );
    if (priorOwner !== undefined) {
      if (priorOwner !== orgId) throw new CreditApplicationConflictError("foreign-key");
      const prior = (
        await db.execute<{ match: unknown; result: unknown }>(
          sql`
          select changes->'match' as match, (changes->'after'->'result') as result
            from audit_log
           where org_id = ${orgId} and table_name = 'applications'
             and row_id = ${input.idempotencyKey} and request_id = ${input.idempotencyKey}
             and action = 'insert'
           order by at asc
           limit 1
        `,
          "objects",
        )
      )[0];
      if (
        !prior ||
        !prior.match ||
        typeof prior.match !== "object" ||
        canonicalJson(prior.match) !== canonicalJson(matchImage) ||
        !prior.result ||
        typeof prior.result !== "object" ||
        !Array.isArray((prior.result as CreditSettlementResult).applicationIds)
      ) {
        throw new CreditApplicationConflictError("changed-payload");
      }
      return prior.result as CreditSettlementResult;
    }
    // A settlement cannot predate the balances it settles: applying a credit
    // before it or its open item was posted would age and report a
    // settlement that did not yet exist.
    const latest = endpoints.reduce((later, row) =>
      row.posting_date > later.posting_date ? row : later,
    );
    if (input.appliedOn < latest.posting_date) {
      throw new PaymentError(
        `${latest.entry_number} was posted on ${latest.posting_date}; apply this credit on or after that date`,
      );
    }
    const bookId = await paymentBookId(orgId);
    // Derive the control account from the endpoints instead of defaulting to
    // the org's AP/AR control. A credit raised against a non-default control
    // account (a financing sub-account, or a mirrored source system with
    // several AR accounts) is exactly the case `controlOverride` exists for on
    // the cash path; defaulting here would refuse it as "wrong control
    // account". validateCreditAllocations then holds every endpoint to the
    // account derived here, so deriving it cannot widen the check.
    const accounts = new Set(endpoints.map((row) => row.account_id));
    if (accounts.size !== 1) {
      throw new PaymentError(
        "every credit and open item in one settlement must sit on the same control account; a posted credit keeps the account it posted to, " +
          "so choose the bill's or invoice's account on the credit before it posts (a vendor credit opened from its bill carries that account)",
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
      foreignCurrency: true,
      admitUnappliedPayments: true,
    });
    // A credit or open item a payment run has reserved is that run's to
    // settle; applying it here would let the run pay the same item again.
    await assertNoForeignRunReservation(
      orgId,
      input.credits.flatMap((credit) => [credit.fromLineId, credit.toLineId]),
      null,
    );

    // A settlement dated into a closed period would silently move an aged
    // balance behind a lock the close already signed off on.
    // Ordinary posting gate: shared covering-period resolver (default
    // calendar, regular periods, deterministic).
    const period = await resolveCoveringPeriod(db, orgId, input.appliedOn);
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

    // Each side is relieved at its carrying amount for the transaction amount
    // applied. In the functional currency the two are equal; a foreign-
    // currency credit and open item booked at different rates realize the
    // difference, posted per application so a release reverses exactly it.
    const balances = new Map(
      (
        await db.execute<{
          id: string;
          amount: string;
          currency: string;
          base_currency: string;
          open_base: string;
          open_txn: string;
        }>(
          sql`
      select jl.id, jl.amount::text as amount, jl.currency, s.base_currency,
             (abs(jl.amount) - coalesce(sum(a.source_amount) filter (where a.from_line_id = jl.id), 0)
                             - coalesce(sum(a.amount) filter (where a.to_line_id = jl.id), 0))::text as open_base,
             (abs(jl.txn_amount) - coalesce(sum(a.source_transaction_amount) filter (where a.from_line_id = jl.id), 0)
                                 - coalesce(sum(a.target_transaction_amount) filter (where a.to_line_id = jl.id), 0))::text as open_txn
        from journal_lines jl
        join subsidiaries s on s.id = jl.subsidiary_id and s.org_id = jl.org_id
        left join applications a
          on a.org_id = jl.org_id and a.unapplied_at is null and (a.from_line_id = jl.id or a.to_line_id = jl.id)
       where jl.org_id = ${orgId} and jl.id in ${endpointIds}
       group by jl.id, s.base_currency
    `,
          "objects",
        )
      ).map((row) => [row.id, { ...row }]),
    );
    let gainLossAccountId: string | null | undefined;

    const applicationIds: string[] = [];
    for (const [index, credit] of input.credits.entries()) {
      // The first application row's id IS the idempotency key — the
      // claimSetupCreate convention — so a retry resolves to this settlement.
      const applicationId = index === 0 ? input.idempotencyKey : randomUUID();
      const source = balances.get(credit.fromLineId)!;
      const target = balances.get(credit.toLineId)!;
      const fromPayment = PAYMENT_SOURCE_KINDS.has(
        endpoints.find((row) => row.id === credit.fromLineId)?.document_kind ?? "",
      );
      const reference = fromPayment
        ? UNAPPLIED_PAYMENT_APPLICATION_REFERENCE
        : CREDIT_APPLICATION_REFERENCE;
      const sourceBase = carryingAmountForSettlement(
        source.open_base,
        source.open_txn,
        credit.amount,
      );
      const targetBase = carryingAmountForSettlement(
        target.open_base,
        target.open_txn,
        credit.amount,
      );
      source.open_base = fromUnits(toUnits(source.open_base) - toUnits(sourceBase));
      source.open_txn = fromUnits(toUnits(source.open_txn) - toUnits(credit.amount));
      target.open_base = fromUnits(toUnits(target.open_base) - toUnits(targetBase));
      target.open_txn = fromUnits(toUnits(target.open_txn) - toUnits(credit.amount));
      const adjustment = realizedFxControlAdjustment(
        cmp(source.amount, "0") > 0 ? sourceBase : neg(sourceBase),
        cmp(target.amount, "0") > 0 ? targetBase : neg(targetBase),
      );
      let fxEntryId: string | null = null;
      if (!isZero(adjustment)) {
        gainLossAccountId ??= (await paymentControlDeps(orgId)).control.fxRealizedGainLoss ?? null;
        if (!gainLossAccountId) {
          throw new PaymentError(
            "applying this foreign-currency credit realizes an FX gain or loss; choose the Realized FX gain/loss account under Company Settings → Control accounts, then apply it again",
          );
        }
        const memo = "Realized FX on a credit applied without cash";
        fxEntryId = (
          await postEntry(db, {
            orgId,
            bookId,
            subsidiaryId,
            entryNumber: `CREDIT-FX-${applicationId}`,
            postingDate: input.appliedOn,
            periodId: period.id,
            memo,
            sourceDocumentId: credit.sourceDocumentId,
            origin: "fx_settlement",
            actorId: userId,
            currency: source.base_currency,
            idempotencyKey: `credit-application-fx:${applicationId}`,
            lines: [
              { accountId: controlAccountId, amount: adjustment, partyId: input.partyId, memo },
              { accountId: gainLossAccountId, amount: neg(adjustment), memo },
            ],
          })
        ).entryId;
      }
      const inserted = (
        await db.execute<{ id: string }>(
          sql`
        insert into applications
          (id, org_id, from_line_id, to_line_id, amount, source_amount,
           source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference,
           applied_on, fx_gain_loss_entry_id, created_by, updated_by)
        select ${applicationId}, ${orgId}, ${credit.fromLineId}, ${credit.toLineId}, ${targetBase},
               ${sourceBase}, ${credit.amount}, jl.currency,
               ${credit.amount}, jl.currency,
               '1', 'same_currency', ${reference},
               ${input.appliedOn}, ${fxEntryId}, ${userId}, ${userId}
          from journal_lines jl
         where jl.id = ${credit.fromLineId} and jl.org_id = ${orgId}
         returning id
      `,
          "objects",
        )
      )[0];
      // A write that matches zero rows is a failure, not a success.
      if (!inserted) {
        throw new PaymentError(
          "the credit line disappeared while its settlement was being recorded; retry the application",
        );
      }
      applicationIds.push(inserted.id);
      // The key row's insert audit is written after the loop, where the full
      // settlement result is known — it carries the retry's replay image.
      if (index === 0) continue;
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
                    sourceCarryingAmount: sourceBase,
                    targetCarryingAmount: targetBase,
                    realizedFxEntryId: fxEntryId,
                    appliedOn: input.appliedOn,
                    side: input.side,
                    fromUnappliedPayment: fromPayment,
                  },
                })}::jsonb,
                ${userId}, ${input.idempotencyKey})
      `);
    }
    // The key row's insert audit carries the replay image: `match` is the
    // request-controlled subset a retry must equal under canonical JSON, and
    // `after.result` is exactly what the retry returns — the same contract
    // as setup creates' audit images, so the retry resolves to the settlement
    // it already wrote instead of a second one beside it.
    const settlementAmount = sum(input.credits.map((credit) => credit.amount));
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'applications', ${input.idempotencyKey}, 'insert',
              ${JSON.stringify({
                mode: "credit_applied_without_cash",
                source: "payments.credit-settlement",
                before: null,
                match: matchImage,
                after: {
                  fromLineId: input.credits[0]!.fromLineId,
                  toLineId: input.credits[0]!.toLineId,
                  sourceDocumentId: input.credits[0]!.sourceDocumentId,
                  amount: input.credits[0]!.amount,
                  appliedOn: input.appliedOn,
                  side: input.side,
                  fromUnappliedPayment: PAYMENT_SOURCE_KINDS.has(
                    endpoints.find((row) => row.id === input.credits[0]!.fromLineId)
                      ?.document_kind ?? "",
                  ),
                  result: { applicationIds, amount: settlementAmount },
                },
              })}::jsonb,
              ${userId}, ${input.idempotencyKey})
    `);
    return { applicationIds, amount: settlementAmount };
  });
}

interface LiveApplicationRow extends Record<string, unknown> {
  id: string;
  settlement_rate_reference: string;
  amount: string;
  source_transaction_amount: string;
  fx_gain_loss_entry_id: string | null;
  applied_on: string;
  from_line_id: string;
  to_line_id: string;
  from_document_kind: string | null;
  from_document_number: string | null;
  to_document_number: string | null;
  to_entry_number: string;
  subsidiary_id: string;
  book_id: string;
  from_document_subsidiary_id: string | null;
  to_document_subsidiary_id: string | null;
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
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ amount: string }> {
  return withOrgTransaction(orgId, async () => {
    const application = (
      await db.execute<LiveApplicationRow>(
        sql`
      select a.id, a.amount, a.source_transaction_amount::text as source_transaction_amount,
             a.applied_on::text as applied_on, a.fx_gain_loss_entry_id,
             a.settlement_rate_reference,
             a.from_line_id, a.to_line_id,
             from_document.kind as from_document_kind,
             from_document.document_number as from_document_number,
             to_document.document_number as to_document_number,
             to_entry.entry_number as to_entry_number,
             from_line.subsidiary_id, from_entry.book_id,
             from_document.subsidiary_id as from_document_subsidiary_id,
             to_document.subsidiary_id as to_document_subsidiary_id
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
       for update of a, from_line, to_line
    `,
        "objects",
      )
    )[0];
    if (!application) {
      throw new PaymentError(
        "this settlement is not live; it was already released or never existed",
      );
    }
    if (
      !subsidiaryScopeAllows(
        allowedSubsidiaryIds,
        application.from_document_subsidiary_id ?? application.subsidiary_id,
      ) ||
      !subsidiaryScopeAllows(
        allowedSubsidiaryIds,
        application.to_document_subsidiary_id ?? application.subsidiary_id,
      )
    ) {
      throw new ScopeNotFoundError();
    }
    // A payment's unapplied cash applied later through this path is released
    // like a credit; the payment's own posting-time cash applications belong
    // to the payment and are released only by its void.
    const unappliedPayment =
      PAYMENT_SOURCE_KINDS.has(application.from_document_kind ?? "") &&
      application.settlement_rate_reference === UNAPPLIED_PAYMENT_APPLICATION_REFERENCE;
    if (
      application.from_document_kind !== "customer_credit" &&
      application.from_document_kind !== "vendor_credit" &&
      !unappliedPayment
    ) {
      throw new PaymentError(
        `${application.from_document_number ?? "this settlement"} is a cash application, not a credit; void the payment to release what it settled`,
      );
    }
    // The settled side follows from the source's kind, not from the sign of a
    // line: a customer credit or receipt settles AR, a vendor credit or
    // payment settles AP.
    const side: OpenItemSide =
      application.from_document_kind === "customer_credit" ||
      application.from_document_kind === "customer_payment"
        ? "ar"
        : "ap";
    // A credit the cash path recorded carries its evidence on that payment's
    // stored creditAllocations. Releasing it here would leave the payment — and
    // the remittance advice printed from it — claiming a credit the bill was no
    // longer reduced by. jsonb containment matches the stored element by its
    // endpoints regardless of the other keys beside them.
    const carrier = (
      await db.execute<{ document_number: string }>(
        sql`
      select document_number from documents
       where org_id = ${orgId}
         and kind in ('customer_payment', 'vendor_payment')
         and status <> 'voided'
         and custom -> 'creditAllocations' @> ${JSON.stringify([
           { fromLineId: application.from_line_id, toLineId: application.to_line_id },
         ])}::jsonb
       limit 1
    `,
        "objects",
      )
    )[0];
    if (carrier) {
      throw new PaymentError(
        `this credit was applied by payment ${carrier.document_number}; void that payment to release it`,
      );
    }

    // Reopening a balance behind a closed period is the same event as settling
    // into one, and is gated the same way.
    const period = await resolveCoveringPeriod(db, orgId, application.applied_on);
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

    const released = (
      await db.execute<{ id: string }>(
        sql`
      update applications
         set unapplied_at = now(), updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId} and id = ${applicationId} and unapplied_at is null
      returning id
    `,
        "objects",
      )
    )[0];
    // The row was locked above, so losing it here means a concurrent release
    // committed first; reporting {ok} would claim this actor's release.
    if (!released) {
      throw new PaymentError(
        "this settlement was released by another action before this one completed",
      );
    }
    // A foreign-currency credit realized FX for exactly this application;
    // releasing it reverses that entry on the settlement's own date, the
    // period the gate above held open.
    if (application.fx_gain_loss_entry_id) {
      // The realized FX entry is stated in the functional currency its lines
      // carry; the entry header has no currency of its own.
      const fx = (
        await db.execute<{
          entry_number: string;
          status: string;
          book_id: string;
          subsidiary_id: string;
          currency: string;
          source_document_id: string | null;
        }>(
          sql`
        select e.entry_number, e.status, e.book_id, e.subsidiary_id, e.source_document_id,
               (select min(l.currency) from journal_lines l where l.org_id = e.org_id and l.entry_id = e.id) as currency
          from journal_entries e
         where e.org_id = ${orgId} and e.id = ${application.fx_gain_loss_entry_id}
         for update of e`,
          "objects",
        )
      )[0];
      if (!fx || fx.status !== "posted") {
        throw new PaymentError(
          "this settlement's realized FX entry is no longer posted; it cannot be released",
        );
      }
      const lines = await db.execute<{
        account_id: string;
        amount: string;
        party_id: string | null;
        memo: string | null;
      }>(
        sql`
        select account_id, amount::text as amount, party_id, memo
          from journal_lines
         where org_id = ${orgId} and entry_id = ${application.fx_gain_loss_entry_id}
         order by line_number`,
        "objects",
      );
      await postEntry(db, {
        orgId,
        bookId: fx.book_id,
        subsidiaryId: fx.subsidiary_id,
        entryNumber: `${fx.entry_number}-R`,
        postingDate: application.applied_on,
        periodId: period.id,
        memo: "Reversal of realized FX on a released credit application",
        sourceDocumentId: fx.source_document_id,
        origin: "fx_settlement",
        reversesEntryId: application.fx_gain_loss_entry_id,
        actorId: userId,
        currency: fx.currency,
        lines: lines.map((line) => ({
          accountId: line.account_id,
          amount: neg(line.amount),
          ...(line.party_id ? { partyId: line.party_id } : {}),
          memo: line.memo ?? undefined,
        })),
      });
      await markEntryReversed(db, {
        orgId,
        entryId: application.fx_gain_loss_entry_id,
        actorId: userId,
      });
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
                  amount: application.source_transaction_amount,
                  targetCarryingAmount: application.amount,
                  appliedOn: application.applied_on,
                  creditDocument: application.from_document_number,
                  settledDocument: application.to_document_number ?? application.to_entry_number,
                },
                after: null,
              })}::jsonb,
              ${userId}, 'payments.credit-settlement')
    `);
    return { amount: application.source_transaction_amount };
  });
}
