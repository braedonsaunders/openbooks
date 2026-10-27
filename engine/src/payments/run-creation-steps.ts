import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";

/**
 * Claim a scheduled occurrence before any run artifact is written. Returns the
 * occurrence this transaction now owns, or the committed run a concurrent
 * creator already linked to it.
 */
export async function claimScheduleOccurrence(
  orgId: string,
  occurrence: {
    scheduleId: string;
    occurrenceAt: Date;
    status: "draft_created" | "awaiting_submit";
  },
): Promise<{ occurrenceId: string } | { prior: { id: string; runNumber: string } }> {
  const claim = await db.execute<{ id: string }>(
    sql`
    insert into payment_schedule_occurrences (org_id, schedule_id, occurrence_at, status)
    values (${orgId}, ${occurrence.scheduleId}, ${occurrence.occurrenceAt}, ${occurrence.status})
    -- A repeated schedule occurrence adopts the committed payment run selected below.
    on conflict (org_id, schedule_id, occurrence_at) do nothing
    returning id
  `,
    "objects",
  );
  const claimedRow = claim[0];
  if (claimedRow) return { occurrenceId: claimedRow.id };
  const existing = (
    await db.execute<{ id: string; paymentRunId: string | null }>(
      sql`
    select id::text as id, payment_run_id::text as "paymentRunId"
      from payment_schedule_occurrences
     where org_id = ${orgId} and schedule_id = ${occurrence.scheduleId}
       and occurrence_at = ${occurrence.occurrenceAt}
     for update
  `,
      "objects",
    )
  )[0];
  if (!existing) {
    throw new PaymentError("payment schedule occurrence disappeared while being claimed");
  }
  if (existing.paymentRunId) {
    const prior = (
      await db.execute<{ id: string; runNumber: string }>(
        sql`
      select id::text as id, run_number as "runNumber"
        from payment_runs
       where id = ${existing.paymentRunId} and org_id = ${orgId}
    `,
        "objects",
      )
    )[0];
    if (!prior) throw new PaymentError("a claimed payment schedule occurrence names a missing run");
    return { prior };
  }
  // An unlinked occurrence (for example a raced empty tick): this
  // transaction now owns it and the caller links its run.
  return { occurrenceId: existing.id };
}

export type PaymentBankProfileRow = {
  id: string;
  bank_account_id: string;
  bank_subsidiary_id: string | null;
  subsidiary_id: string | null;
  currency: string;
  settings: Record<string, unknown>;
  rail: string;
  direction: string;
};

/**
 * The active bank profile with its active format and bank account. The
 * unlocked read only filters bill selection; the locked read after numbering is
 * authoritative.
 */
export async function readPaymentBankProfile(
  orgId: string,
  profileId: string,
  lock: boolean,
): Promise<PaymentBankProfileRow | undefined> {
  const rows = await db.execute<PaymentBankProfileRow>(
    sql`
      select p.id, p.bank_account_id, p.subsidiary_id, a.subsidiary_id as bank_subsidiary_id,
             p.currency, p.settings,
             f.rail, f.direction
        from payment_bank_profiles p
        join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id and f.is_active
        join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id
                          and a.type = 'asset_bank' and a.is_active and not a.is_summary
       where p.id = ${profileId} and p.org_id = ${orgId} and p.is_active
       ${lock ? sql`for update of p, a` : sql``}
    `,
    "objects",
  );
  return rows[0];
}

/**
 * Refuse a selection whose bills are not all payable here. The bills another
 * live run holds are named (bill + holding run number) instead of failing the
 * whole selection behind the generic guard, so the operator can see exactly
 * which selection to drop.
 */
export async function refuseUnselectableBills(orgId: string, missing: string[]): Promise<never> {
  const reserved = await db.execute<{ billId: string; billNumber: string; runNumber: string }>(
    sql`
    select distinct i.source_document_id as "billId", d.document_number as "billNumber", r.run_number as "runNumber"
      from payment_run_items i
      join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
      join documents d on d.id = i.source_document_id and d.org_id = i.org_id
     where i.org_id = ${orgId}
       and i.source_document_id = any(${`{${missing.join(",")}}`}::uuid[])
       and i.status = 'selected'
  `,
    "objects",
  );
  if (reserved.length > 0) {
    const pairs = reserved.map((row) => `${row.billNumber} (${row.runNumber})`);
    const rest = missing.length - new Set(reserved.map((row) => row.billId)).size;
    throw new PaymentError(
      `${pairs.join(", ")} ${pairs.length === 1 ? "is" : "are"} already selected in another live payment run` +
        (rest > 0
          ? "; other selected bills are held, closed, or do not match the profile currency and subsidiary"
          : ""),
    );
  }
  throw new PaymentError(
    "some selected bills are held, closed, already selected in another live payment run, or do not match the profile currency and subsidiary",
  );
}

/** The payment method a run takes from its bank profile's rail. */
export function paymentRunMethod(
  rail: string,
): "eft" | "ach" | "sepa" | "wire" | "cheque" | "positive_pay" | "custom" {
  return ["cpa005_credit", "rbc_std152_credit"].includes(rail)
    ? "eft"
    : rail === "nacha_credit"
      ? "ach"
      : rail === "sepa_credit"
        ? "sepa"
        : rail === "positive_pay"
          ? "positive_pay"
          : rail === "custom"
            ? "custom"
            : rail === "cheque"
              ? "cheque"
              : "wire";
}
