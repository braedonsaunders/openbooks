import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { assertPackedUnit } from "./handling-unit-state.ts";
import { reverseProjectGlEntryWithinTransaction } from "../journal/origin-entry.ts";
import { decimalToMinorUnits } from "../connectors/shipping.ts";
import {
  assertShippingFeature,
  adapterFor,
  loadShippingAccount,
  ShippingRefusal,
  type Scope,
  type Tx,
} from "./shipping-accounts.ts";
import { findQuotedRate, loadSettings, lockShipmentForRating } from "./shipping-rate-shopping.ts";
import {
  markChannelEconomicsDirty,
  minorUnitsFor,
  postLabelCost,
  requireFunctionalCurrency,
  requirePostingAccounts,
  writeLabelAudit,
} from "./shipping-label-accounting.ts";
import { storeLabelPdf } from "./shipping-label-documents.ts";

export interface BoughtShippingLabel {
  id: string;
  shipmentId: string;
  documentNumber: string;
  orderId: string | null;
  carrier: string;
  service: string;
  trackingNumber: string | null;
  amountMinor: bigint;
  currency: string;
  costEntryId: string | null;
  duplicate: boolean;
}

/**
 * Mark the channel order behind a label cost for margin restatement. The
 * commerce module owns the restatement queue and this module cannot import
 * it (commerce already depends on sales, so the edge would cycle), hence
 * the direct insert. A label for a non-channel document matches zero rows
 * by design, and a retried mark collides on (org, order) with the first
 * mark winning — both benign, so neither is a failure.
 */

export interface BuyLabelInput {
  shipmentId: string;
  handlingUnitId?: string;
  providerRateId: string;
  accountId?: string | null;
  direction?: "outbound" | "return";
  allowedSubsidiaryIds: Scope;
  transport?: typeof fetch;
  baseUrl?: string;
}

/**
 * Buy a quoted label: idempotent per shipment and rate, costed to the
 * shipping expense account against the carrier payable, sourced to the
 * shipment with the order in the entry refs for later margin reads.
 * Posting accounts and booking currency are verified BEFORE the provider is
 * charged, so a bought label can never strand without its cost journal.
 */
export async function buyShipmentLabel(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: BuyLabelInput,
): Promise<BoughtShippingLabel> {
  await assertShippingFeature(tx, orgId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"shipping-buy:" + orgId + ":" + input.shipmentId}, 0))`,
  );
  const shipment = await lockShipmentForRating(
    tx,
    orgId,
    input.shipmentId,
    input.allowedSubsidiaryIds,
  );
  await lockActorCommandAuthority(tx, orgId, actorId, shipment.subsidiaryId, "shipping.manage");
  if (!input.handlingUnitId)
    throw new ShippingRefusal(
      "Select a packed handling unit before buying its label",
      "invalid_input",
      422,
      "Confirm carton contents in Packing first",
    );
  const unit = await assertPackedUnit(tx, orgId, shipment.id, input.handlingUnitId);
  const account = await loadShippingAccount(tx, orgId, input.accountId);
  const adapter = adapterFor(account.provider);
  const settings = await loadSettings(tx, orgId);
  const { expenseAccountId, payableAccountId } = await requirePostingAccounts(tx, orgId, settings);

  const existing = (
    await tx.execute<{
      id: string;
      carrier: string;
      service: string;
      tracking_number: string | null;
      rate_minor: string;
      rate_currency: string;
      cost_entry_id: string | null;
    }>(
      sql`
    select id, carrier, service, tracking_number, rate_minor::text, rate_currency, cost_entry_id
      from shipment_labels
     where org_id = ${orgId} and shipment_document_id = ${shipment.id}
       and handling_unit_id=${unit.id} and direction=${input.direction ?? "outbound"} and status = 'purchased'
     limit 1 for share`,
      "objects",
    )
  )[0];
  if (existing?.cost_entry_id) {
    return {
      id: existing.id,
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      orderId: shipment.orderId,
      carrier: existing.carrier,
      service: existing.service,
      trackingNumber: existing.tracking_number,
      amountMinor: BigInt(existing.rate_minor),
      currency: existing.rate_currency,
      costEntryId: existing.cost_entry_id,
      duplicate: true,
    };
  }
  if (existing) {
    // The provider already charged this rate but the cost never posted
    // (interrupted buy): resume posting instead of charging twice.
    const resumedEntryId = await postLabelCost(tx, orgId, actorId, {
      labelId: existing.id,
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      orderId: shipment.orderId,
      subsidiaryId: shipment.subsidiaryId,
      expenseAccountId,
      payableAccountId,
      rateMinor: BigInt(existing.rate_minor),
      currency: existing.rate_currency,
      minorUnits: await minorUnitsFor(tx, existing.rate_currency),
      isReturn: input.direction === "return",
    });
    await markChannelEconomicsDirty(tx, orgId, shipment.orderId, "shipping label cost posted");
    return {
      id: existing.id,
      shipmentId: shipment.id,
      documentNumber: shipment.documentNumber,
      orderId: shipment.orderId,
      carrier: existing.carrier,
      service: existing.service,
      trackingNumber: existing.tracking_number,
      amountMinor: BigInt(existing.rate_minor),
      currency: existing.rate_currency,
      costEntryId: resumedEntryId,
      duplicate: true,
    };
  }

  const quoted = await findQuotedRate(tx, orgId, shipment.id, account.id, input.providerRateId, {
    ...unit,
    direction: input.direction ?? "outbound",
  });
  await requireFunctionalCurrency(tx, orgId, shipment.subsidiaryId, quoted.currency);
  const minorUnits = await minorUnitsFor(tx, quoted.currency);
  let bought;
  try {
    bought = await adapter.buyLabel(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      quoted.providerShipmentId,
      input.providerRateId,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(
        `${account.name} label purchase failed: ${error.message}`,
        "provider_failed",
        422,
        error.message,
      );
    }
    throw error;
  }
  const rateMinor = decimalToMinorUnits(bought.amount, minorUnits);
  const labelId = (
    await tx.execute<{ id: string }>(
      sql`
    insert into shipment_labels
      (org_id, shipment_document_id, order_document_id, account_id, provider,
       provider_shipment_id, provider_rate_id, provider_label_id, carrier, service,
       rate_minor, rate_currency, label_url, tracking_number, tracking_status,
       status, purchased_at, created_by, updated_by,handling_unit_id,handling_unit_version,direction)
    values (${orgId}, ${shipment.id}, ${shipment.orderId}, ${account.id}, ${account.provider},
            ${bought.providerShipmentId}, ${input.providerRateId}, ${bought.providerLabelId},
            ${bought.carrier}, ${bought.service}, ${rateMinor.toString()}, ${bought.currency},
            ${bought.labelUrl}, ${bought.trackingNumber},
            ${bought.trackingNumber ? "pre_transit" : "unknown"},
            'purchased', now(), ${actorId}, ${actorId},${unit.id},${unit.content_version}::bigint,${input.direction ?? "outbound"})
    returning id`,
      "objects",
    )
  )[0]?.id;
  if (!labelId) throw new Error("shipping label was not recorded");

  let labelFileId: string | null = null;
  if (bought.labelUrl) {
    labelFileId = await storeLabelPdf(
      tx,
      orgId,
      actorId,
      labelId,
      shipment.documentNumber,
      bought.labelUrl,
      input.transport,
    );
    if (labelFileId) {
      const patched = await tx.execute<{ id: string }>(
        sql`
        update shipment_labels set label_file_id = ${labelFileId}, updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${labelId} returning id`,
        "objects",
      );
      if (patched.length === 0) throw new Error("shipping label file was not linked");
    }
  }

  // The native carriers registry stays the single home of carrier identity:
  // buying a hub label files the provider's carrier and service there (never
  // a second registry), so fulfillment_documents keeps its carrier invariant
  // (a service always rides a carrier row) and manual shipment screens read
  // hub labels without a special case.
  const carrierCode = bought.carrier.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!carrierCode) {
    throw new ShippingRefusal(
      `${account.name} returned a label with an unusable carrier name`,
      "provider_failed",
      422,
      "Buy the label again from another rate",
    );
  }
  const carrierRow = (
    await tx.execute<{ id: string }>(
      sql`
    insert into carriers (org_id, code, name, services, is_active, created_by, updated_by)
    values (${orgId}, ${carrierCode}, ${bought.carrier}, ARRAY[${bought.service}]::text[], true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
       set name = excluded.name,
           services = (select array_agg(distinct service order by service)
                         from unnest(carriers.services || excluded.services) as service),
           updated_at = now(), updated_by = ${actorId}
    returning id`,
      "objects",
    )
  )[0];
  if (!carrierRow) throw new Error("carrier row was not filed for the shipping label");
  // The first outbound unit supplies the shipment summary; every unit keeps its own label and tracking history.
  const primaryOutbound =
    input.direction !== "return" &&
    !(
      await tx.execute(
        sql`
    select id from shipment_labels where org_id=${orgId} and shipment_document_id=${shipment.id}
      and id<>${labelId} and status='purchased' and (direction='outbound' or direction is null) limit 1`,
        "objects",
      )
    ).length;
  const stamped = await tx.execute<{ id: string }>(
    sql`
    update fulfillment_documents
       set carrier_id = case when ${primaryOutbound} then ${carrierRow.id}::uuid else carrier_id end,
           carrier_service = case when ${primaryOutbound} then ${bought.service} else carrier_service end,
           tracking_number = case when ${primaryOutbound} then ${bought.trackingNumber} else tracking_number end,
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${shipment.id} and stage = 'open'
    returning document_id`,
    "objects",
  );
  if (stamped.length === 0) {
    throw new ShippingRefusal(
      `${shipment.documentNumber} changed while its label was being bought`,
      "changed_concurrently",
      409,
      "Reload the shipment and try again",
    );
  }

  if (bought.currency !== quoted.currency) {
    throw new ShippingRefusal(
      `${account.name} charged ${bought.currency} for a ${quoted.currency} rate`,
      "provider_failed",
      422,
      "Void the label with the carrier, then buy it again from fresh rates",
    );
  }
  const entryId = await postLabelCost(tx, orgId, actorId, {
    labelId,
    shipmentId: shipment.id,
    documentNumber: shipment.documentNumber,
    orderId: shipment.orderId,
    subsidiaryId: shipment.subsidiaryId,
    expenseAccountId,
    payableAccountId,
    rateMinor,
    currency: bought.currency,
    minorUnits,
    isReturn: input.direction === "return",
  });

  await writeLabelAudit(tx, orgId, actorId, labelId, "insert", {
    mode: "shipping_label_buy",
    shipmentId: shipment.id,
    handlingUnitId: unit.id,
    handlingUnitVersion: unit.content_version,
    direction: input.direction ?? "outbound",
    orderId: shipment.orderId,
    provider: account.provider,
    providerShipmentId: bought.providerShipmentId,
    providerRateId: input.providerRateId,
    carrier: bought.carrier,
    service: bought.service,
    amountMinor: rateMinor.toString(),
    currency: bought.currency,
    trackingNumber: bought.trackingNumber,
    costEntryId: entryId,
  });
  await markChannelEconomicsDirty(tx, orgId, shipment.orderId, "shipping label purchased");
  return {
    id: labelId,
    shipmentId: shipment.id,
    documentNumber: shipment.documentNumber,
    orderId: shipment.orderId,
    carrier: bought.carrier,
    service: bought.service,
    trackingNumber: bought.trackingNumber,
    amountMinor: rateMinor,
    currency: bought.currency,
    costEntryId: entryId,
    duplicate: false,
  };
}

export interface VoidLabelInput {
  labelId: string;
  reason: string;
  allowedSubsidiaryIds?: Scope;
  transport?: typeof fetch;
  baseUrl?: string;
}

/**
 * Void a purchased label: the provider refund is requested first, then the
 * label flips to voided and its cost journal reverses. Posted history stays
 * immutable — the void is a reversal, never an edit.
 */
export async function voidShipmentLabel(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: VoidLabelInput,
): Promise<{ labelId: string; reversalEntryId: string | null }> {
  await assertShippingFeature(tx, orgId);
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new ShippingRefusal(
      "Give a void reason between 5 and 500 characters",
      "invalid_input",
      422,
    );
  }
  const label = (
    await tx.execute<{
      id: string;
      shipment_document_id: string;
      order_document_id: string | null;
      account_id: string;
      provider: string;
      provider_shipment_id: string;
      provider_label_id: string | null;
      status: string;
      tracking_number: string | null;
      cost_entry_id: string | null;
      subsidiary_id: string;
    }>(
      sql`
    select l.id, l.shipment_document_id, l.order_document_id, l.account_id, l.provider, l.provider_shipment_id,
           l.provider_label_id, l.status, l.tracking_number, l.cost_entry_id, d.subsidiary_id
      from shipment_labels l
      join documents d on d.id = l.shipment_document_id and d.org_id = l.org_id
     where l.org_id = ${orgId} and l.id = ${input.labelId} for update of l`,
      "objects",
    )
  )[0];
  if (!label) throw new ShippingRefusal("Shipping label not found", "not_found", 404);
  if (input.allowedSubsidiaryIds && !input.allowedSubsidiaryIds.has(label.subsidiary_id)) {
    throw new ShippingRefusal("Shipping label not found", "not_found", 404);
  }
  if (label.status !== "purchased") {
    throw new ShippingRefusal(
      `That label is already ${label.status}`,
      "label_not_voidable",
      409,
      "Only a purchased label can be voided",
    );
  }
  const account = await loadShippingAccount(tx, orgId, label.account_id);
  const adapter = adapterFor(account.provider);
  let voided: { accepted: boolean; rawStatus: string };
  try {
    voided = await adapter.voidLabel(
      { apiKey: account.apiKey, baseUrl: input.baseUrl, transport: input.transport },
      { providerShipmentId: label.provider_shipment_id, providerLabelId: label.provider_label_id },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "CarrierError") {
      throw new ShippingRefusal(
        `${account.name} label refund failed: ${error.message}`,
        "provider_failed",
        422,
        error.message,
      );
    }
    throw error;
  }
  if (!voided.accepted) {
    throw new ShippingRefusal(
      `${account.name} refused the refund (provider status ${voided.rawStatus}) — the parcel may already be moving`,
      "label_not_voidable",
      409,
      "Leave the label purchased and record the charge as a carrier billing adjustment instead",
    );
  }
  const flipped = await tx.execute<{ id: string }>(
    sql`
    update shipment_labels
       set status = 'voided', voided_at = now(), updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${label.id} and status = 'purchased' returning id`,
    "objects",
  );
  if (flipped.length === 0) {
    throw new ShippingRefusal(
      "That label changed while it was being voided",
      "changed_concurrently",
      409,
      "Reload and try again",
    );
  }
  let reversalEntryId: string | null = null;
  if (label.cost_entry_id) {
    const reversal = await reverseProjectGlEntryWithinTransaction(
      tx,
      orgId,
      actorId,
      label.cost_entry_id,
      `Label voided: ${reason}`,
    );
    if (reversal.status === "missing")
      throw new Error("shipping label cost entry is missing and cannot reverse");
    reversalEntryId = reversal.reversalId;
  }
  await writeLabelAudit(tx, orgId, actorId, label.id, "update", {
    mode: "shipping_label_void",
    reason,
    providerStatus: voided.rawStatus,
    reversedEntryId: label.cost_entry_id,
    reversalEntryId,
  });
  await markChannelEconomicsDirty(tx, orgId, label.order_document_id, "shipping label voided");
  return { labelId: label.id, reversalEntryId };
}

// --- Tracking -----------------------------------------------------------------

export interface BulkCandidate {
  shipmentId: string;
  handlingUnitId: string;
  handlingUnitCode: string;
  documentNumber: string;
  customerName: string | null;
  promisedDate: string | null;
  labelCount: number;
}
/** Only confirmed cartons without an outbound label enter bulk label buying. */
export async function listBulkCandidates(
  runner: SqlExecutor,
  orgId: string,
  scope: Scope,
): Promise<BulkCandidate[]> {
  await assertShippingFeature(runner, orgId);
  return await runner.execute<BulkCandidate & Record<string, unknown>>(
    sql`
    select doc.id as "shipmentId",unit.id as "handlingUnitId",unit.code as "handlingUnitCode",
      doc.document_number as "documentNumber",party.display_name as "customerName",doc.due_date::text as "promisedDate",0 as "labelCount"
    from handling_units unit join documents doc on doc.org_id=unit.org_id and doc.id=unit.shipment_document_id
    join fulfillment_documents fd on fd.org_id=doc.org_id and fd.document_id=doc.id
    left join parties party on party.org_id=doc.org_id and party.id=doc.party_id
    where unit.org_id=${orgId} and unit.status='packed' and doc.kind='shipment' and doc.status='draft' and fd.stage='open'
      ${scope === null ? sql`` : sql`and doc.subsidiary_id=any(${[...scope]}::uuid[])`}
      and not exists(select 1 from shipment_labels label where label.org_id=unit.org_id and label.handling_unit_id=unit.id
        and label.direction='outbound' and label.status='purchased')
    order by doc.document_number,unit.code,unit.id limit 500`,
    "objects",
  );
}

// --- Drawer and download reads --------------------------------------------------
