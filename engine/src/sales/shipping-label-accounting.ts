import { sql } from "drizzle-orm";
import { businessTodayInTx } from "../platform/business-date.ts";
import { type SqlExecutor } from "../platform/db.ts";
import { postProjectGlEntryWithinTransaction } from "../journal/origin-entry.ts";
import { minorUnitsToLedger } from "../connectors/shipping.ts";
import { ShippingRefusal, type Tx } from "./shipping-accounts.ts";
import { type ShippingSettings } from "./shipping-rate-shopping.ts";

/** Posting accounts must exist BEFORE the provider is charged, never after. */
export async function requirePostingAccounts(
  tx: SqlExecutor,
  orgId: string,
  settings: ShippingSettings,
): Promise<{ expenseAccountId: string; payableAccountId: string }> {
  if (!settings.shippingExpenseAccountId || !settings.carrierPayableAccountId) {
    throw new ShippingRefusal(
      "Shipping cost accounts are not configured",
      "invalid_input",
      422,
      "Choose the shipping expense and carrier payable accounts in Setup → Shipping",
    );
  }
  const found = await tx.execute<{ id: string }>(
    sql`
    select id from accounts
     where org_id = ${orgId} and id in (${settings.shippingExpenseAccountId}, ${settings.carrierPayableAccountId})
       and is_active for share`,
    "objects",
  );
  if (found.length !== 2) {
    throw new ShippingRefusal(
      "A shipping cost account is missing or inactive",
      "invalid_input",
      422,
      "Choose active shipping expense and carrier payable accounts in Setup → Shipping",
    );
  }
  return {
    expenseAccountId: settings.shippingExpenseAccountId,
    payableAccountId: settings.carrierPayableAccountId,
  };
}

// --- Rate shopping ----------------------------------------------------------

/**
 * Mark the channel order behind a label cost for margin restatement. The
 * commerce module owns the restatement queue and this module cannot import
 * it (commerce already depends on sales, so the edge would cycle), hence
 * the direct insert. A label for a non-channel document matches zero rows
 * by design, and a retried mark collides on (org, order) with the first
 * mark winning — both benign, so neither is a failure.
 */
export async function markChannelEconomicsDirty(
  tx: SqlExecutor,
  orgId: string,
  orderDocumentId: string | null,
  reason: string,
): Promise<void> {
  if (!orderDocumentId) return;
  await tx.execute(sql`
    insert into channel_order_economics_pending (org_id, order_id, reason)
    select ${orgId}, o.id, ${reason}
      from channel_orders o
     where o.org_id = ${orgId} and o.posting_document_id = ${orderDocumentId}
    -- An existing order mark already requires a full margin restatement including shipping costs.
    on conflict (org_id, order_id) do nothing`);
}

export async function writeLabelAudit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  labelId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'shipment_labels', ${labelId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`,
    "objects",
  );
  if (written.length === 0) throw new Error("shipping label change was not audited");
}

/** Tenant minor-unit precision; an unknown currency refuses instead of posting dust. */
export async function minorUnitsFor(tx: SqlExecutor, currency: string): Promise<number> {
  const row = (
    await tx.execute<{ minor_units: number }>(
      sql`
    select minor_units from currencies where code = ${currency}`,
      "objects",
    )
  )[0];
  const minorUnits = row?.minor_units;
  if (minorUnits == null || !Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new ShippingRefusal(
      `The ${currency} currency has unsupported minor-unit precision`,
      "currency_unsupported",
      422,
      "Buy the label in a supported billing currency",
    );
  }
  return minorUnits;
}

/** The subsidiary's booking currency must match the rate currency — no silent FX. */
export async function requireFunctionalCurrency(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  rateCurrency: string,
): Promise<string> {
  const row = (
    await tx.execute<{ base_currency: string | null }>(
      sql`
    select nullif(trim(base_currency), '') as base_currency from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId}`,
      "objects",
    )
  )[0];
  const functional = row?.base_currency;
  if (!functional) {
    throw new ShippingRefusal(
      "The shipment subsidiary has no functional currency",
      "invalid_input",
      422,
    );
  }
  if (functional !== rateCurrency) {
    throw new ShippingRefusal(
      `The ${rateCurrency} label cannot post to ${functional} books without a conversion`,
      "currency_unsupported",
      422,
      "Buy the label in the booking currency, or enable multi-currency conversion first",
    );
  }
  return functional;
}

interface LabelCostInput {
  labelId: string;
  shipmentId: string;
  documentNumber: string;
  orderId: string | null;
  subsidiaryId: string;
  expenseAccountId: string;
  payableAccountId: string;
  rateMinor: bigint;
  currency: string;
  minorUnits: number;
  isReturn: boolean;
}

/**
 * Post one label's carrier cost: DR shipping expense, CR carrier payable,
 * sourced to the shipment with the label and the order in the entry refs so
 * order margin reads it. The entry number derives from the label id, and the
 * idempotency key from the label too, so resuming an interrupted buy
 * converges instead of double-posting.
 */
export async function postLabelCost(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: LabelCostInput,
): Promise<string> {
  // A crashed buy resumes here instead of double-posting: the label row is
  // the serialization point, and the entry number is stable per label.
  const resumed = (
    await tx.execute<{ cost_entry_id: string | null }>(
      sql`
    select cost_entry_id from shipment_labels
     where org_id = ${orgId} and id = ${input.labelId} for update`,
      "objects",
    )
  )[0];
  if (!resumed) throw new Error("shipping label disappeared while its cost was being posted");
  if (resumed.cost_entry_id) return resumed.cost_entry_id;
  const carrier = input.isReturn ? "return " : "";
  const ledgerAmount = minorUnitsToLedger(input.rateMinor, input.minorUnits);
  const entryId = await postProjectGlEntryWithinTransaction(tx, {
    orgId,
    actorId,
    origin: "shipping_label",
    entryNumber: `SHPC-${input.documentNumber}-${input.labelId.slice(0, 8)}`,
    postingDate: await businessTodayInTx(tx, orgId),
    memo: `Carrier ${carrier}label for ${input.documentNumber}`,
    subsidiaryId: input.subsidiaryId,
    currency: input.currency,
    sourceDocumentId: input.shipmentId,
    custom: { labelId: input.labelId, shipmentId: input.shipmentId, orderId: input.orderId },
    idempotencyKey: `shipping-label-cost:${input.labelId}`,
    lines: [
      {
        accountId: input.expenseAccountId,
        amount: ledgerAmount,
        memo: `Carrier cost for ${input.documentNumber}`,
      },
      {
        accountId: input.payableAccountId,
        amount: ledgerAmount.startsWith("-") ? ledgerAmount.slice(1) : `-${ledgerAmount}`,
        memo: `Carrier payable for ${input.documentNumber}`,
      },
    ],
  });
  if (!entryId) throw new Error("shipping label cost was not posted");
  // A zero-row update is a failure, never a success: the label row is
  // locked above, so no row means it was deleted mid-flight.
  const linked = await tx.execute<{ id: string }>(
    sql`
    update shipment_labels set cost_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${input.labelId} and cost_entry_id is null returning id`,
    "objects",
  );
  if (linked.length === 0) {
    const winner = (
      await tx.execute<{ cost_entry_id: string | null }>(
        sql`
      select cost_entry_id from shipment_labels where org_id = ${orgId} and id = ${input.labelId}`,
        "objects",
      )
    )[0];
    if (winner?.cost_entry_id) return winner.cost_entry_id;
    throw new Error("shipping label cost was not linked");
  }
  return entryId;
}

// --- Label void -------------------------------------------------------------
