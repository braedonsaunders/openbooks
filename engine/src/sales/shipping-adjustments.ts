import { sql } from "drizzle-orm";
import { businessTodayInTx } from "../platform/business-date.ts";
import { type SqlExecutor } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { decimalToMinorUnits, minorUnitsToLedger } from "../connectors/shipping.ts";
import { postProjectGlEntryWithinTransaction } from "../journal/origin-entry.ts";
import {
  assertShippingFeature,
  loadShippingAccount,
  ShippingRefusal,
  type Scope,
  type Tx,
} from "./shipping-accounts.ts";
import { loadSettings } from "./shipping-rate-shopping.ts";
import {
  markChannelEconomicsDirty,
  minorUnitsFor,
  requireFunctionalCurrency,
  requirePostingAccounts,
  writeLabelAudit,
} from "./shipping-label-accounting.ts";

export interface BillingAdjustmentInput {
  providerAdjustmentId: string;
  providerShipmentId: string;
  kind: string;
  /** Exact decimal string; positive = extra charge, negative = credit. */
  amount: string;
  currency: string;
  reason?: string | null;
  occurredAt?: string | null;
}

const ADJUSTMENT_KINDS = new Set([
  "weight_correction",
  "dimension_correction",
  "address_correction",
  "fuel",
  "duplicate",
  "other",
]);

/**
 * Import aggregator billing adjustments (weight/dimension corrections and
 * the like) against the label they correct. Replaying an import converges:
 * the provider identity is unique, so a repeated delivery skips instead of
 * double-booking.
 */
export async function importBillingAdjustments(
  tx: Tx,
  orgId: string,
  actorId: string,
  accountId: string,
  items: BillingAdjustmentInput[],
  allowedSubsidiaryIds: Scope,
): Promise<{ imported: number; skipped: number }> {
  await assertShippingFeature(tx, orgId);
  const account = await loadShippingAccount(tx, orgId, accountId);
  let imported = 0;
  let skipped = 0;
  for (const item of items) {
    const identity = item.providerAdjustmentId.trim();
    if (!identity) {
      throw new ShippingRefusal(
        "A billing adjustment is missing its provider id",
        "invalid_input",
        422,
      );
    }
    if (!ADJUSTMENT_KINDS.has(item.kind)) {
      throw new ShippingRefusal(
        `Unknown billing adjustment kind ${item.kind}`,
        "invalid_input",
        422,
        "Use one of weight_correction, dimension_correction, address_correction, fuel, duplicate, or other",
      );
    }
    const minorUnits = await minorUnitsFor(tx, item.currency);
    const amountMinor = decimalToMinorUnits(item.amount, minorUnits);
    if (amountMinor === 0n) {
      throw new ShippingRefusal(
        `Billing adjustment ${identity} carries a zero amount`,
        "invalid_input",
        422,
        "Drop zero-amount adjustments from the import",
      );
    }
    if (item.occurredAt != null && !/^\d{4}-\d{2}-\d{2}/.test(item.occurredAt)) {
      throw new ShippingRefusal(
        `Billing adjustment ${identity} has an invalid date`,
        "invalid_input",
        422,
      );
    }
    const label = (
      await tx.execute<{ id: string }>(
        sql`
      select l.id from shipment_labels l
      join documents d on d.org_id = l.org_id and d.id = l.shipment_document_id and d.kind = 'shipment'
       where l.org_id = ${orgId} and l.account_id = ${account.id}
         and l.provider_shipment_id = ${item.providerShipmentId}
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       limit 1 for share of l, d`,
        "objects",
      )
    )[0];
    if (!label) {
      throw new ShippingRefusal(
        `Billing adjustment ${identity} references an unknown label`,
        "adjustment_unknown",
        422,
        "Buy the label in OpenBooks first, or correct the shipment reference in the import",
      );
    }
    // Justified: the provider identity is the import's idempotency key, so a
    // replayed billing file converges on the first write instead of failing.
    const written = await tx.execute<{ id: string }>(
      sql`
      insert into shipping_adjustments
        (org_id, label_id, provider_adjustment_id, kind, amount_minor, currency,
         reason, status, occurred_at, created_by, updated_by)
      values (${orgId}, ${label.id}, ${identity}, ${item.kind}, ${amountMinor.toString()}, ${item.currency},
              ${item.reason ?? null}, 'pending', ${item.occurredAt ?? null}, ${actorId}, ${actorId})
      -- A repeated provider adjustment retains its first recorded evidence and is counted as skipped below.
      on conflict (org_id, provider_adjustment_id) do nothing
      returning id`,
      "objects",
    );
    if (written.length === 0) {
      skipped += 1;
    } else {
      imported += 1;
      await writeLabelAudit(tx, orgId, actorId, label.id, "update", {
        mode: "shipping_adjustment_import",
        adjustmentId: written[0]!.id,
        providerAdjustmentId: identity,
        kind: item.kind,
        amountMinor: amountMinor.toString(),
        currency: item.currency,
      });
    }
  }
  return { imported, skipped };
}

/**
 * Post one imported adjustment against its label: extra charges DR expense /
 * CR payable, credits mirrored. The adjustment id is the entry's stable
 * identity, so reposting converges instead of doubling.
 */
export async function postBillingAdjustment(
  tx: Tx,
  orgId: string,
  actorId: string,
  adjustmentId: string,
  allowedSubsidiaryIds: Scope,
): Promise<{ adjustmentId: string; entryId: string }> {
  await assertShippingFeature(tx, orgId);
  const adjustment = (
    await tx.execute<{
      id: string;
      label_id: string;
      kind: string;
      amount_minor: string;
      currency: string;
      status: string;
      entry_id: string | null;
      shipment_id: string;
      order_id: string | null;
      subsidiary_id: string;
    }>(
      sql`
    select a.id, a.label_id, a.kind, a.amount_minor::text, a.currency, a.status, a.entry_id,
           l.shipment_document_id as shipment_id, l.order_document_id as order_id, d.subsidiary_id
      from shipping_adjustments a
      join shipment_labels l on l.id = a.label_id and l.org_id = a.org_id
      join documents d on d.id = l.shipment_document_id and d.org_id = a.org_id and d.kind = 'shipment'
     where a.org_id = ${orgId} and a.id = ${adjustmentId}
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
     for update of a, l, d`,
      "objects",
    )
  )[0];
  if (!adjustment) throw new ShippingRefusal("Billing adjustment not found", "not_found", 404);
  if (adjustment.entry_id) return { adjustmentId: adjustment.id, entryId: adjustment.entry_id };
  if (adjustment.status !== "pending") {
    throw new ShippingRefusal(
      `That adjustment is ${adjustment.status}`,
      "invalid_input",
      409,
      "Only a pending adjustment can be posted",
    );
  }
  const settings = await loadSettings(tx, orgId);
  const { expenseAccountId, payableAccountId } = await requirePostingAccounts(tx, orgId, settings);
  await requireFunctionalCurrency(tx, orgId, adjustment.subsidiary_id, adjustment.currency);
  const minorUnits = await minorUnitsFor(tx, adjustment.currency);
  const amount = minorUnitsToLedger(BigInt(adjustment.amount_minor), minorUnits);
  const extra = amount.startsWith("-");
  const unsigned = extra ? amount.slice(1) : amount;
  const entryId = await postProjectGlEntryWithinTransaction(tx, {
    orgId,
    actorId,
    origin: "shipping_adjustment",
    entryNumber: `SHPA-${adjustment.id.slice(0, 8)}`,
    postingDate: await businessTodayInTx(tx, orgId),
    memo: `Carrier ${adjustment.kind.replace(/_/g, " ")} for label ${adjustment.label_id.slice(0, 8)}`,
    subsidiaryId: adjustment.subsidiary_id,
    currency: adjustment.currency,
    sourceDocumentId: adjustment.shipment_id,
    custom: {
      adjustmentId: adjustment.id,
      labelId: adjustment.label_id,
      orderId: adjustment.order_id,
    },
    idempotencyKey: `shipping-adjustment:${adjustment.id}`,
    lines: [
      {
        accountId: extra ? payableAccountId : expenseAccountId,
        amount: extra ? unsigned : amount,
        memo: `Carrier adjustment ${adjustment.kind}`,
      },
      {
        accountId: extra ? expenseAccountId : payableAccountId,
        amount: `-${extra ? unsigned : amount}`,
        memo: `Carrier adjustment ${adjustment.kind}`,
      },
    ],
  });
  if (!entryId) throw new Error("billing adjustment was not posted");
  // A zero-row update is a failure: the adjustment is locked above.
  const flipped = await tx.execute<{ id: string }>(
    sql`
    update shipping_adjustments
       set status = 'posted', entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${adjustment.id} and status = 'pending' returning id`,
    "objects",
  );
  if (flipped.length === 0) throw new Error("billing adjustment was not marked posted");
  await writeLabelAudit(tx, orgId, actorId, adjustment.label_id, "update", {
    mode: "shipping_adjustment_post",
    adjustmentId: adjustment.id,
    entryId,
  });
  await markChannelEconomicsDirty(
    tx,
    orgId,
    adjustment.order_id,
    "carrier billing adjustment posted",
  );
  return { adjustmentId: adjustment.id, entryId };
}

// --- Address validation ---------------------------------------------------------

/**
 * Validate the shipment's ship-to address against the provider and return
 * suggestions. A suggestion is never applied silently — the operator keeps
 * the address they entered until they choose otherwise.
 */

export interface CarrierAdjustmentRow {
  carrier: string;
  kind: string;
  adjustments: number;
  amountMinor: string;
  currency: string;
}

/**
 * Carrier billing adjustments by carrier and reason, over live ledger lines
 * only (posted, not reversed), on the primary posting book — the first
 * version of the carrier invoice audit.
 */
export async function listAdjustmentsByCarrier(
  runner: SqlExecutor,
  orgId: string,
  input: { from: string; to: string },
): Promise<CarrierAdjustmentRow[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
    throw new ShippingRefusal("Report dates must be YYYY-MM-DD", "invalid_input", 422);
  }
  const book = (
    await runner.execute<{ id: string }>(
      sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1`,
      "objects",
    )
  )[0];
  if (!book) throw new ShippingRefusal("No active primary posting book", "invalid_input", 422);
  const rows = await runner.execute<{
    carrier: string;
    kind: string;
    adjustments: string;
    amount_minor: string;
    currency: string;
  }>(
    sql`
    select l.carrier, a.kind, count(*)::text as adjustments,
           coalesce(sum(a.amount_minor), 0)::text as amount_minor, a.currency
      from shipping_adjustments a
      join shipment_labels l on l.id = a.label_id and l.org_id = a.org_id
      join journal_entries je on je.id = a.entry_id and je.org_id = a.org_id
     where a.org_id = ${orgId} and a.status = 'posted'
       and je.book_id = ${book.id}
       -- Live entries only: reversed adjustment journals are excluded from this current total.
       and je.status = 'posted'
       and je.posting_date >= ${input.from}::date and je.posting_date <= ${input.to}::date
     group by l.carrier, a.kind, a.currency
     order by l.carrier, a.kind`,
    "objects",
  );
  return rows.map((row) => ({
    carrier: row.carrier,
    kind: row.kind,
    adjustments: Number(row.adjustments),
    amountMinor: row.amount_minor,
    currency: row.currency,
  }));
}
