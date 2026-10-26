import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { fromUnits, mulRatio, neg, normalizeDecimal, roundDiv, toUnits } from "../money/money.ts";
import {
  intercompanyBalancingLegs,
  loadSubsidiaryContext,
  SubsidiaryError,
  validateSubsidiaryRestrictions,
  type SubLine,
} from "../organization/subsidiaries.ts";
import { loadIntercompanyPair } from "../organization/intercompany-accounts.ts";
import { postEntry, type PostEntryResult } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { InventoryError } from "../inventory/contracts.ts";
import { issueInventory } from "../inventory/movements.ts";
import { inventoryPostingEffectKey } from "../inventory/document-lines.ts";
import { postedReturnQuantity } from "../inventory/return-quantities.ts";
import type {
  CrossSubsidiaryFulfillmentHandler,
  CrossSubsidiaryIssueRequest,
  CrossSubsidiaryReturnRequest,
  CrossSubsidiaryVoidRequest,
} from "../inventory/cross-subsidiary.ts";
import { IntercompanyError } from "./errors.ts";
import {
  assertIntercompanyPeriodsOpen,
  intercompanyPostingBook,
  intercompanyPostingPeriod,
  postMirrorReversal,
  resolveSpotRates,
} from "./ledger-support.ts";
import { spotTranslation } from "./netting-math.ts";
import {
  transferPricingPolicyInEffect,
  transferUnitPrice,
  type TransferPricingPolicy,
} from "./transfer-pricing.ts";

/**
 * Cross-subsidiary fulfillment.
 *
 * When the selling entity's sales order ships from a warehouse another entity
 * owns, the owning (fulfilling) entity relieves its own stock at its own cost
 * — its cost layers, its cost of goods sold — and charges the selling entity
 * the transfer price of its transfer pricing policy. The cross-charge posts
 * the selling entity's cost of sales at the transfer price and the fulfilling
 * entity's intercompany revenue, both to the policy's eliminated accounts,
 * with the due-to/due-from legs of their pair: consolidated, the sale carries
 * the group's actual cost and the intercompany margin eliminates. Returns
 * restore the fulfilling entity's stock at the cost it left at and reverse
 * the cross-charge in proportion; reverse those returns before voiding the
 * shipment so its inventory and full cross-charge can be restored together.
 */

class FulfillmentRefusal extends InventoryError {}

function refuse(message: string): never {
  throw new FulfillmentRefusal(message);
}

function asInventoryRefusal<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if (error instanceof IntercompanyError || error instanceof SubsidiaryError)
      refuse(error.message);
    throw error;
  });
}

type ChargeRow = {
  id: string;
  fulfillment_document_id: string;
  fulfillment_line_id: string;
  selling_subsidiary_id: string;
  fulfilling_subsidiary_id: string;
  policy_id: string;
  item_id: string;
  stock_location_id: string;
  quantity: string;
  cost_amount: string;
  cost_currency: string;
  transfer_currency: string;
  transfer_unit_price: string;
  transfer_amount: string;
  entry_id: string;
  department_id: string | null;
  project_id: string | null;
};

async function chargeForMovement(
  runner: SqlExecutor,
  orgId: string,
  movementId: string,
): Promise<ChargeRow | null> {
  return (
    (
      await runner.execute<ChargeRow>(
        sql`
    select charge.id, charge.fulfillment_document_id, charge.fulfillment_line_id,
           charge.selling_subsidiary_id, charge.fulfilling_subsidiary_id, charge.policy_id,
           charge.item_id, charge.stock_location_id, charge.quantity::text as quantity,
           charge.cost_amount::text as cost_amount, charge.cost_currency, charge.transfer_currency,
           charge.transfer_unit_price::text as transfer_unit_price,
           charge.transfer_amount::text as transfer_amount, charge.entry_id,
           line.department_id, line.project_id
      from intercompany_fulfillment_charges charge
      left join document_lines line
        on line.org_id = charge.org_id and line.id = charge.fulfillment_line_id
     where charge.org_id = ${orgId} and charge.movement_id = ${movementId} and charge.kind = 'fulfillment'
     for update of charge`,
        "objects",
      )
    )[0] ?? null
  );
}

/**
 * Post a cross-charge: the selling entity's cost at the transfer price, the
 * fulfilling entity's intercompany revenue, and the pair's balancing legs.
 * `sign` is 1 for a charge and -1 for its return.
 */
async function postCrossCharge(
  runner: SqlExecutor,
  input: {
    orgId: string;
    actorId: string | null;
    policy: Pick<TransferPricingPolicy, "revenueAccountId" | "costAccountId">;
    sellingSubsidiaryId: string;
    fulfillingSubsidiaryId: string;
    currency: string;
    amount: string;
    date: string;
    entryNumber: string;
    memo: string;
    idempotencyKey: string;
    sourceDocumentId: string;
    departmentId: string | null;
    projectId: string | null;
  },
): Promise<string> {
  const ctx = await loadSubsidiaryContext(runner, input.orgId);
  const selling = ctx.byId.get(input.sellingSubsidiaryId);
  const fulfilling = ctx.byId.get(input.fulfillingSubsidiaryId);
  if (!selling || !fulfilling)
    refuse("a subsidiary of this cross-subsidiary shipment no longer exists");
  const rates = await asInventoryRefusal(() =>
    resolveSpotRates(runner, input.orgId, input.date, [
      { from: input.currency, to: selling.baseCurrency },
      { from: input.currency, to: fulfilling.baseCurrency },
    ]),
  );
  const sellingRate = normalizeDecimal(rates.get(`${input.currency}>${selling.baseCurrency}`)!, 10);
  const fulfillingRate = normalizeDecimal(
    rates.get(`${input.currency}>${fulfilling.baseCurrency}`)!,
    10,
  );
  const lines: (SubLine & { memo: string })[] = [
    {
      accountId: input.policy.costAccountId,
      subsidiaryId: input.sellingSubsidiaryId,
      amount: spotTranslation(input.amount, sellingRate),
      txnAmount: input.amount,
      currency: input.currency,
      fxRate: sellingRate,
      departmentId: input.departmentId,
      projectId: input.projectId,
      memo: input.memo,
    },
    {
      accountId: input.policy.revenueAccountId,
      subsidiaryId: input.fulfillingSubsidiaryId,
      amount: spotTranslation(neg(input.amount), fulfillingRate),
      txnAmount: neg(input.amount),
      currency: input.currency,
      fxRate: fulfillingRate,
      memo: input.memo,
    },
  ];
  const legs = await asInventoryRefusal(async () => {
    const built = await intercompanyBalancingLegs(runner, {
      orgId: input.orgId,
      ctx,
      originSubId: input.sellingSubsidiaryId,
      originFxRate: sellingRate,
      lines,
    });
    await validateSubsidiaryRestrictions(runner, {
      orgId: input.orgId,
      ctx,
      docSubsidiaryId: input.sellingSubsidiaryId,
      lines: [
        ...lines,
        ...built.map((leg) => ({
          accountId: leg.accountId,
          amount: leg.amount,
          subsidiaryId: leg.subsidiaryId,
        })),
      ],
    });
    return built;
  });
  const bookId = await asInventoryRefusal(() => intercompanyPostingBook(runner, input.orgId));
  const periodId = await asInventoryRefusal(() =>
    intercompanyPostingPeriod(runner, input.orgId, input.date, input.sellingSubsidiaryId),
  );
  await asInventoryRefusal(() =>
    assertIntercompanyPeriodsOpen(runner, {
      orgId: input.orgId,
      date: input.date,
      bookId,
      subsidiaryIds: [input.sellingSubsidiaryId, input.fulfillingSubsidiaryId],
      modules: [],
    }),
  );
  let posted: PostEntryResult;
  try {
    posted = await postEntry(runner, {
      orgId: input.orgId,
      bookId,
      subsidiaryId: input.sellingSubsidiaryId,
      entryNumber: input.entryNumber,
      postingDate: input.date,
      periodId,
      memo: input.memo,
      origin: "intercompany",
      sourceDocumentId: input.sourceDocumentId,
      custom: { intercompanyFulfillment: true },
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      lines: [
        ...lines.map((line) => ({
          accountId: line.accountId,
          subsidiaryId: line.subsidiaryId,
          amount: line.amount,
          currency: line.currency,
          txnAmount: line.txnAmount,
          fxRate: line.fxRate,
          departmentId: line.departmentId ?? null,
          projectId: line.projectId ?? null,
          memo: line.memo,
        })),
        ...legs.map((leg) => ({
          accountId: leg.accountId,
          subsidiaryId: leg.subsidiaryId,
          amount: leg.amount,
          currency: leg.currency,
          txnAmount: leg.txnAmount,
          fxRate: leg.fxRate,
          memo: leg.memo,
        })),
      ],
    });
  } catch (error) {
    if (error instanceof PostingError) refuse(error.message);
    throw error;
  }
  return posted.entryId;
}

async function fulfill(runner: SqlExecutor, request: CrossSubsidiaryIssueRequest): Promise<void> {
  const { orgId } = request;
  const pair = await loadIntercompanyPair(
    runner,
    orgId,
    request.sellingSubsidiaryId,
    request.fulfillingSubsidiaryId,
  );
  const names = await runner.execute<{ id: string; name: string }>(
    sql`
    select id, name from subsidiaries
     where org_id = ${orgId} and id in (${request.sellingSubsidiaryId}, ${request.fulfillingSubsidiaryId})`,
    "objects",
  );
  const nameOf = (id: string) => names.find((row) => row.id === id)?.name ?? id;
  if (!pair || !pair.isActive) {
    refuse(
      `the warehouse on line ${request.lineNumber} belongs to ${nameOf(request.fulfillingSubsidiaryId)}, and no active intercompany pair joins it with ${nameOf(request.sellingSubsidiaryId)}; configure one under Setup → Accounting → Intercompany pairs`,
    );
  }
  const policy = await transferPricingPolicyInEffect(runner, orgId, {
    sellerSubsidiaryId: request.fulfillingSubsidiaryId,
    buyerSubsidiaryId: request.sellingSubsidiaryId,
    date: request.date,
  });
  if (!policy) {
    refuse(
      `${nameOf(request.fulfillingSubsidiaryId)} has no transfer pricing policy for sales to ${nameOf(request.sellingSubsidiaryId)} on ${request.date}; add one under Setup → Accounting → Transfer pricing`,
    );
  }
  const item = (
    await runner.execute<{ label: string }>(
      sql`
    select coalesce(nullif(btrim(code), ''), name) as label from items where org_id = ${orgId} and id = ${request.itemId}`,
      "objects",
    )
  )[0];
  const document = (
    await runner.execute<{ document_number: string }>(
      sql`
    select document_number from documents where org_id = ${orgId} and id = ${request.fulfillmentDocumentId}`,
      "objects",
    )
  )[0];
  // The fulfilling entity relieves its own layers at its own cost; its
  // dimensions are its warehouse's, never the selling entity's.
  const issue = await issueInventory(orgId, request.actorId, {
    itemId: request.itemId,
    stockLocationId: request.stockLocationId,
    quantity: request.quantity,
    subsidiaryId: request.fulfillingSubsidiaryId,
    date: request.date,
    documentLineId: request.lineId,
    idempotencyKey: inventoryPostingEffectKey(request.lineId, "issue"),
    lotId: request.lotId,
    serialId: request.serialId,
    memo: `COGS (fulfilled for ${nameOf(request.sellingSubsidiaryId)})`,
    tx: runner,
  });
  const cost = fromUnits(-toUnits(issue.value));
  const ctx = await loadSubsidiaryContext(runner, orgId);
  const currency = ctx.byId.get(request.fulfillingSubsidiaryId)!.baseCurrency;
  let unitPrice: string;
  let amount: string;
  if (policy.method === "cost_plus") {
    // The markup applies to the cost actually relieved, at ledger precision.
    const markupUnits = toUnits(policy.markupPercent ?? "0");
    amount = fromUnits(roundDiv(toUnits(cost) * (1_000_000n + markupUnits), 1_000_000n));
    unitPrice = perUnit(amount, request.quantity);
  } else {
    unitPrice = await asInventoryRefusal(() =>
      transferUnitPrice(runner, orgId, policy, {
        itemId: request.itemId,
        itemLabel: item?.label ?? request.itemId,
        quantity: request.quantity,
        date: request.date,
        currency,
        unitCost: "0",
      }),
    );
    amount = extend(unitPrice, request.quantity);
  }
  if (toUnits(amount) <= 0n) {
    refuse(
      `the transfer price for ${item?.label ?? "this item"} on line ${request.lineNumber} is zero; review transfer pricing policy ${policy.code}`,
    );
  }
  const entryId = await postCrossCharge(runner, {
    orgId,
    actorId: request.actorId,
    policy,
    sellingSubsidiaryId: request.sellingSubsidiaryId,
    fulfillingSubsidiaryId: request.fulfillingSubsidiaryId,
    currency,
    amount,
    date: request.date,
    entryNumber: `${document?.document_number ?? "SHIP"}-IC${request.lineNumber}`,
    memo: `Intercompany fulfillment by ${nameOf(request.fulfillingSubsidiaryId)} — ${item?.label ?? request.itemId}`,
    idempotencyKey: `intercompany-fulfillment:${request.lineId}`,
    sourceDocumentId: request.fulfillmentDocumentId,
    departmentId: request.departmentId,
    projectId: request.projectId,
  });
  const inserted = await runner.execute<{ id: string }>(
    sql`
    insert into intercompany_fulfillment_charges
      (org_id, kind, fulfillment_document_id, fulfillment_line_id, selling_subsidiary_id, fulfilling_subsidiary_id,
       policy_id, item_id, stock_location_id, movement_id, quantity, cost_amount, cost_currency, transfer_currency,
       transfer_unit_price, transfer_amount, entry_id, charge_date, created_by)
    values (${orgId}, 'fulfillment', ${request.fulfillmentDocumentId}, ${request.lineId}, ${request.sellingSubsidiaryId},
            ${request.fulfillingSubsidiaryId}, ${policy.id}, ${request.itemId}, ${request.stockLocationId},
            ${issue.movementId}, ${request.quantity}, ${cost}, ${currency}, ${currency}, ${unitPrice}, ${amount},
            ${entryId}, ${request.date}, ${request.actorId})
    returning id`,
    "objects",
  );
  if (inserted.length !== 1) refuse("the cross-subsidiary charge could not be recorded");
}

/** Amount (four decimals) per unit of quantity (eight decimals), at eight decimals. */
export function perUnit(amount: string, quantity: string): string {
  const quantityUnits = scaled(quantity, 8);
  if (quantityUnits <= 0n) return "0";
  const priceUnits = roundDiv(toUnits(amount) * 10n ** 12n, quantityUnits);
  const negative = priceUnits < 0n;
  const magnitude = negative ? -priceUnits : priceUnits;
  return `${negative ? "-" : ""}${magnitude / 100_000_000n}.${(magnitude % 100_000_000n).toString().padStart(8, "0")}`;
}

/** Unit price (eight decimals) × quantity (eight decimals), rounded to ledger precision. */
export function extend(unitPrice: string, quantity: string): string {
  return fromUnits(roundDiv(scaled(unitPrice, 8) * scaled(quantity, 8), 10n ** 12n));
}

function scaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^[-+]/, "").split(".");
  const units =
    BigInt(whole || "0") * 10n ** BigInt(scale) +
    BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  return negative ? -units : units;
}

async function returned(runner: SqlExecutor, request: CrossSubsidiaryReturnRequest): Promise<void> {
  const { orgId } = request;
  const charge = await chargeForMovement(runner, orgId, request.sourceIssueMovementId);
  if (!charge) refuse("the returned shipment has no cross-subsidiary charge to reverse");
  if (charge.selling_subsidiary_id !== request.sellingSubsidiaryId) {
    refuse("a cross-subsidiary shipment is returned through the entity that sold it");
  }
  // Prorate the transfer amount by cumulative returned quantity so several
  // partial returns reverse exactly the whole charge.
  const priorReturned = (
    await runner.execute<{ quantity: string }>(
      sql`
    select coalesce(sum(quantity), 0)::text as quantity from intercompany_fulfillment_charges
     where org_id = ${orgId} and kind = 'return' and reverses_charge_id = ${charge.id}`,
      "objects",
    )
  )[0]!.quantity;
  const shipped = scaled(charge.quantity, 8);
  const before = scaled(priorReturned, 8);
  const returningUnits = scaled(request.quantity, 8);
  if (before + returningUnits > shipped)
    refuse("the return exceeds the quantity this cross-subsidiary shipment delivered");
  const total = toUnits(charge.transfer_amount);
  const amount = fromUnits(
    roundDiv(total * (before + returningUnits), shipped) - roundDiv(total * before, shipped),
  );
  const costShare = mulRatio(charge.cost_amount, returningUnits, shipped);
  const document = (
    await runner.execute<{ document_number: string }>(
      sql`
    select document_number from documents where org_id = ${orgId} and id = ${request.creditDocumentId}`,
      "objects",
    )
  )[0];
  const policy = (
    await runner.execute<{ revenue_account_id: string; cost_account_id: string }>(
      sql`
    select revenue_account_id, cost_account_id from intercompany_transfer_pricing_policies
     where org_id = ${orgId} and id = ${charge.policy_id}`,
      "objects",
    )
  )[0];
  if (!policy) refuse("the transfer pricing policy of the returned shipment no longer exists");
  let entryId: string | null = null;
  if (toUnits(amount) > 0n) {
    entryId = await postCrossCharge(runner, {
      orgId,
      actorId: request.actorId,
      policy: {
        revenueAccountId: policy.revenue_account_id,
        costAccountId: policy.cost_account_id,
      },
      sellingSubsidiaryId: charge.selling_subsidiary_id,
      fulfillingSubsidiaryId: charge.fulfilling_subsidiary_id,
      currency: charge.transfer_currency,
      amount: neg(amount),
      date: request.date,
      entryNumber: `${document?.document_number ?? "CM"}-IC-${request.creditLineId.slice(0, 8)}`,
      memo: "Intercompany fulfillment return",
      idempotencyKey: `intercompany-fulfillment-return:${request.creditLineId}:${request.returnMovementId}`,
      sourceDocumentId: request.creditDocumentId,
      departmentId: charge.department_id,
      projectId: charge.project_id,
    });
  }
  if (!entryId) refuse("the returned quantity carries no transfer amount to reverse");
  const inserted = await runner.execute<{ id: string }>(
    sql`
    insert into intercompany_fulfillment_charges
      (org_id, kind, fulfillment_document_id, fulfillment_line_id, credit_document_id, reverses_charge_id,
       selling_subsidiary_id, fulfilling_subsidiary_id, policy_id, item_id, stock_location_id, movement_id,
       quantity, cost_amount, cost_currency, transfer_currency, transfer_unit_price, transfer_amount, entry_id,
       charge_date, created_by)
    values (${orgId}, 'return', ${charge.fulfillment_document_id}, ${charge.fulfillment_line_id},
            ${request.creditDocumentId}, ${charge.id}, ${charge.selling_subsidiary_id}, ${charge.fulfilling_subsidiary_id},
            ${charge.policy_id}, ${charge.item_id}, ${charge.stock_location_id}, ${request.returnMovementId},
            ${request.quantity}, ${costShare}, ${charge.cost_currency}, ${charge.transfer_currency},
            ${charge.transfer_unit_price}, ${amount}, ${entryId}, ${request.date}, ${request.actorId})
    returning id`,
    "objects",
  );
  if (inserted.length !== 1) refuse("the cross-subsidiary return could not be recorded");
}

async function voided(runner: SqlExecutor, request: CrossSubsidiaryVoidRequest): Promise<void> {
  const charge = await chargeForMovement(runner, request.orgId, request.issueMovementId);
  if (!charge) return;
  const returned = await postedReturnQuantity(runner, request.orgId, {
    returnKind: "receipt",
    evidenceKey: "sourceIssueMovementId",
    sourceMovementId: request.issueMovementId,
  });
  if (toUnits(returned) > 0n) {
    refuse(
      "this shipment has customer-credit returns; reverse those credits before voiding the shipment",
    );
  }
  const liveReturnCharge = (
    await runner.execute<{ id: string }>(
      sql`
    select returned.id
      from intercompany_fulfillment_charges returned
      join journal_entries entry on entry.org_id = returned.org_id and entry.id = returned.entry_id
     where returned.org_id = ${request.orgId} and returned.kind = 'return'
       and returned.reverses_charge_id = ${charge.id} and entry.status = 'posted' -- Live entries only: a reversed return charge no longer authorizes blocking shipment void.
     limit 1`,
      "objects",
    )
  )[0];
  if (liveReturnCharge) {
    refuse(
      "this cross-subsidiary shipment has a live customer-credit charge return; reverse that credit before voiding the shipment",
    );
  }
  const status = (
    await runner.execute<{ status: string; entry_number: string; book_id: string }>(
      sql`
    select status, entry_number, book_id from journal_entries where org_id = ${request.orgId} and id = ${charge.entry_id}`,
      "objects",
    )
  )[0];
  if (!status || status.status !== "posted") return;
  const periodId = await asInventoryRefusal(() =>
    intercompanyPostingPeriod(
      runner,
      request.orgId,
      request.reversalDate,
      charge.selling_subsidiary_id,
    ),
  );
  await asInventoryRefusal(() =>
    assertIntercompanyPeriodsOpen(runner, {
      orgId: request.orgId,
      date: request.reversalDate,
      bookId: status.book_id,
      subsidiaryIds: [charge.selling_subsidiary_id, charge.fulfilling_subsidiary_id],
      modules: [],
    }),
  );
  await asInventoryRefusal(() =>
    postMirrorReversal(runner, {
      orgId: request.orgId,
      entryId: charge.entry_id,
      entryNumber: `${status.entry_number}-VOID`,
      postingDate: request.reversalDate,
      periodId,
      memo: `Void of intercompany fulfillment: ${request.reason}`,
      actorId: request.actorId,
      idempotencyKey: `intercompany-fulfillment-void:${charge.id}`,
      custom: { intercompanyFulfillment: true, reversal: true },
      closeModules: [],
    }),
  );
}

/** The handler inventory calls for lines shipped from another entity's stock. */
export const crossSubsidiaryFulfillmentHandlerImpl: CrossSubsidiaryFulfillmentHandler = {
  fulfill,
  returned,
  voided,
};
