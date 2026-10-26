import "server-only";
import {
  documentRevisionCounterSql,
  isDocumentRevisionToken,
} from "@openbooks/engine/records/revision";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { nextDocumentNumber, persistLineTaxComponents } from "./bills.ts";
import {
  ORDER_KINDS,
  PURCHASE_RECEIPT_KIND,
  SALES_FULFILLMENT_KIND,
  type OrderKind,
  CONVERSION_TARGETS,
} from "./order-kinds";
import { promoteCrmAccount } from "@openbooks/engine/crm/crm";
import { add, mulRatio, neg, sum } from "@openbooks/engine/money/money";
import { lineRequiresReceipt } from "@openbooks/engine/records/stock-receipt";
import {
  billableRemainderQuantityUnits,
  fromQuantityUnits,
  remainingOrderLine,
  toQuantityUnits,
} from "./order-cycle-math";
import { isFeatureEnabled } from "./features";
import {
  InventoryError,
  InventoryOwnershipError,
  UnitConversionError,
} from "@openbooks/engine/inventory/contracts/module";
import { issueSalesOrder } from "@openbooks/engine/sales/sales-orders";
import { orderedNetOfCancelledSql } from "@openbooks/engine/records/order-line-remainders";
import {
  receivedNotBilledMissingMessage,
  resolveReceivedNotBilledAccount,
} from "@openbooks/engine/records/control-accounts";
import { WORK_PERIOD_DOCUMENT_KINDS } from "@openbooks/engine/records/work-period";
import {
  ConversionError,
  type ConversionWithheldLine,
  type ConvertResult,
  INVENTORY_ITEM_KINDS,
  ITEM_MISSING_RNB_ACCOUNT,
  ORDER_CONVERSION_NOTHING_BILLABLE,
  ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE,
  displayQuantity,
} from "./order-cycle-shared";
import { fulfillSalesOrderRemainder } from "./order-cycle-fulfill";
import { receivePurchaseOrderRemainder } from "./order-cycle-receive";

import type { OrderConvertLineRow, OrderSourceRow } from "./order-cycle-convert-source";
export { conversionWouldCopyInventoryKinds } from "./order-cycle-convert-source";

/**
 * Convert an order document into `targetKind`, pulling forward each line's
 * remaining (quantity − quantity_cancelled − quantity_billed). Records a document_links edge and
 * advances quantity_billed on the source lines. Runs in one transaction.
 */

export async function convertOrder(
  orgId: string,
  userId: string,
  sourceId: string,
  targetKind: string,
  options: { creditOverrideReason?: string; expectedUpdatedAt?: string } = {},
): Promise<ConvertResult> {
  if (!(await isFeatureEnabled(orgId, "orders")))
    throw new ConversionError("Orders feature is disabled");
  return withOrgTransaction(orgId, async () =>
    db.transaction(async (tx) => {
      if (options.expectedUpdatedAt !== undefined) {
        const source = (
          await tx.execute<{ revision: string }>(
            sql`
        select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents
         where id = ${sourceId} and org_id = ${orgId} for update
      `,
            "objects",
          )
        )[0];
        if (!source) throw new ConversionError("Order not found", 404);
        if (
          !isDocumentRevisionToken(options.expectedUpdatedAt) ||
          options.expectedUpdatedAt !== source.revision
        ) {
          throw new ConversionError(
            "this order changed after you opened it; reload and review the latest revision",
            409,
          );
        }
      }
      // Physical movements refuse with the engine's InventoryError (short
      // stock, unwarehoused lines, cross-entity attempts). Those are
      // operator-actionable business refusals, not server faults: wrap them
      // as ConversionErrors so the convert route answers 422/403 with the
      // message the picker needs, the way assign-warehouse already does.
      try {
        if (targetKind === SALES_FULFILLMENT_KIND) {
          return await fulfillSalesOrderRemainder(orgId, userId, sourceId);
        }
        if (targetKind === PURCHASE_RECEIPT_KIND) {
          return await receivePurchaseOrderRemainder(orgId, userId, sourceId);
        }
      } catch (error) {
        if (error instanceof ConversionError) throw error;
        if (error instanceof InventoryOwnershipError) throw new ConversionError(error.message, 403);
        // A missing unit conversion keeps its code and item identity so the
        // drawer links the refusal to the item's costing section.
        if (error instanceof UnitConversionError) {
          throw new ConversionError(error.message, error.status, error.code, error.details);
        }
        if (error instanceof InventoryError) throw new ConversionError(error.message, 422);
        throw error;
      }
      const src = await tx.execute<OrderSourceRow>(
        sql`
      select id, kind, status, party_id, currency, fx_rate, document_date, due_date,
             subsidiary_id, department_id, project_id, location_id, class_id, extra_dims, memo, billing_method,
             work_completed_on::text as work_completed_on
        from documents where id = ${sourceId} and org_id = ${orgId} for update
    `,
        "objects",
      );
      const doc = src[0];
      if (!doc) throw new ConversionError("Order not found");
      if (!ORDER_KINDS.includes(doc.kind as OrderKind))
        throw new ConversionError("Not an order document");
      if (
        (
          await tx.execute(
            sql`select id from subscription_renewal_occurrences where org_id=${orgId} and document_id=${sourceId} and occurrence='document' limit 1`,
            "objects",
          )
        )[0]
      ) {
        throw new ConversionError(
          "Accept this renewal from the subscription in Collections; subscription billing generates its invoices and prevents duplicate order billing",
        );
      }
      // Only an issued order converts. The switch is exhaustive so a status
      // added later (pending_approval today) refuses closed instead of
      // converting an order that was never issued.
      switch (doc.status) {
        case "approved":
          break;
        case "draft":
          throw new ConversionError("Issue the order before converting it");
        case "voided":
          throw new ConversionError("This order is voided");
        default:
          throw new ConversionError(
            `Only an issued order can be converted — this order is ${doc.status}`,
          );
      }

      const target = (CONVERSION_TARGETS[doc.kind as OrderKind] || []).find(
        (t) => t.kind === targetKind,
      );
      if (!target) throw new ConversionError(`Cannot convert a ${doc.kind} into ${targetKind}`);

      const lines = await tx.execute<OrderConvertLineRow>(
        sql`
      select dl.id, dl.line_number, dl.item_id, dl.account_id, dl.description, dl.quantity, dl.unit,
             dl.unit_price, dl.amount, dl.tax_code_id, dl.tax_group_id, dl.tax_amount, dl.marketplace_facilitator,
             dl.department_id, dl.project_id, dl.location_id, dl.class_id, dl.extra_dims,
             dl.stock_location_id, dl.is_billable, dl.quantity_billed, dl.quantity_fulfilled,
             dl.quantity_cancelled, dl.price_basis,
             dl.work_from::text as work_from, dl.work_to::text as work_to,
             i.kind as item_kind, i.income_account_id as item_income_account_id, i.name as item_name,
             exists (
               select 1 from item_inventory_profiles profile
                where profile.item_id = dl.item_id and profile.org_id = dl.org_id
             ) as has_inventory_profile
        from document_lines dl left join items i on i.id = dl.item_id and i.org_id = dl.org_id
       where dl.document_id = ${sourceId} and dl.org_id = ${orgId}
       order by dl.line_number
       for update of dl
    `,
        "objects",
      );
      // A sales-side line with no account inherits the item's income account so
      // the converted document stays postable (converted SO lines
      // carried null accounts and their invoices could never post). An explicit
      // line account always wins; the purchase side is untouched.
      const salesSide = doc.kind !== "purchase_order";
      const convertedAccountOf = (l: {
        account_id: unknown;
        item_income_account_id: unknown;
      }): string | null => {
        if (typeof l.account_id === "string" && l.account_id.length > 0) return l.account_id;
        if (
          salesSide &&
          typeof l.item_income_account_id === "string" &&
          l.item_income_account_id.length > 0
        ) {
          return l.item_income_account_id;
        }
        return null;
      };

      // Remaining (un-pulled) quantity per line.
      const remaining = lines
        .map((line) => ({
          line,
          remainder: remainingOrderLine({
            quantity: String(line.quantity),
            quantityBilled: String(line.quantity_billed),
            quantityCancelled: String(line.quantity_cancelled),
            unitPrice: String(line.unit_price),
            taxAmount: String(line.tax_amount),
          }),
        }))
        .filter(
          (
            row,
          ): row is {
            line: OrderConvertLineRow;
            remainder: NonNullable<ReturnType<typeof remainingOrderLine>>;
          } => row.remainder !== null,
        );
      if (remaining.length === 0)
        throw new ConversionError("Every line is already fully converted");
      const lineLabel =
        doc.kind === "purchase_order"
          ? "Purchase-order line"
          : doc.kind === "sales_order"
            ? "Sales-order line"
            : "Estimate line";
      const itemLabelOf = (line: OrderConvertLineRow) =>
        line.item_name ? ` (${line.item_name})` : "";
      const isInventoryKind = (line: OrderConvertLineRow) =>
        line.item_id != null && INVENTORY_ITEM_KINDS.has(String(line.item_kind));
      // Source lines stay. Turning Inventory off must refuse a conversion of an
      // order that still carries open inventory / assembly / kit lines: they
      // could neither be copied nor ever be received or shipped to bill later.
      const openInventoryLine = remaining.find((row) => isInventoryKind(row.line));
      if (openInventoryLine && !(await isFeatureEnabled(orgId, "inventory"))) {
        throw new ConversionError(
          `Inventory is disabled: ${lineLabel.toLowerCase()} ${openInventoryLine.line.line_number}${itemLabelOf(openInventoryLine.line)} is an open inventory line — enable Inventory under Company Settings → Features, then convert again`,
        );
      }
      // A billing document carrying an inventory item with no costing profile
      // can never post (posting refuses it), and on a purchase or sales order
      // the line can never be received or shipped, so receipt-governed billing
      // could never reach it. Refuse by line, the way the goods receipt and
      // fulfillment do, instead of converting the other lines without it.
      const billingTarget = target.kind === "vendor_bill" || target.kind === "customer_invoice";
      const uncosted = billingTarget
        ? remaining.find((row) => isInventoryKind(row.line) && !row.line.has_inventory_profile)
        : undefined;
      if (uncosted) {
        const movement =
          doc.kind === "purchase_order"
            ? "received or billed"
            : doc.kind === "sales_order"
              ? "shipped or invoiced"
              : "invoiced";
        const nextStep =
          doc.kind === "purchase_order"
            ? "receive the line, then convert to a bill again"
            : doc.kind === "sales_order"
              ? "fulfill the line, then convert to an invoice again"
              : "then convert again";
        throw new ConversionError(
          `${lineLabel} ${uncosted.line.line_number}${itemLabelOf(uncosted.line)} is an inventory item without a costing profile, so it cannot be ${movement} — add a costing profile to the item, ${nextStep}`,
          422,
          ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE,
          {
            lineNumber: uncosted.line.line_number,
            itemId: uncosted.line.item_id,
            itemName: uncosted.line.item_name,
          },
        );
      }
      // One shared physical-quantity ceiling for both billing legs. A purchase
      // order bills received-and-unbilled stock; a sales order bills shipped-and-
      // unbilled stock. Service/non-stock lines remain two-way matched. Every
      // open line is classified: carried (in full or in part) or withheld, and
      // every withheld quantity is reported with its amount — a conversion
      // never reduces a payable or receivable without saying so.
      const fulfillmentGovernedBilling =
        (doc.kind === "purchase_order" && target.kind === "vendor_bill") ||
        (doc.kind === "sales_order" && target.kind === "customer_invoice");
      const covered: Array<{
        line: OrderConvertLineRow;
        remainder: NonNullable<ReturnType<typeof remainingOrderLine>>;
        units: bigint;
        amount: string;
        taxAmount: string;
      }> = [];
      const withheld: ConversionWithheldLine[] = [];
      for (const row of remaining) {
        const remainderUnits = toQuantityUnits(row.remainder.quantity);
        const units = fulfillmentGovernedBilling
          ? billableRemainderQuantityUnits({
              orderedQuantity: String(row.line.quantity),
              billedQuantity: String(row.line.quantity_billed),
              cancelledQuantity: String(row.line.quantity_cancelled),
              fulfilledQuantity: String(row.line.quantity_fulfilled),
              requiresReceipt:
                row.line.item_id != null && lineRequiresReceipt(row.line.item_kind ?? null),
            })
          : remainderUnits;
        const amount =
          units > 0n ? mulRatio(row.remainder.amount, units, remainderUnits) : "0.0000";
        const taxAmount =
          units > 0n ? mulRatio(row.remainder.taxAmount, units, remainderUnits) : "0.0000";
        if (units > 0n) covered.push({ ...row, units, amount, taxAmount });
        if (units < remainderUnits) {
          withheld.push({
            lineNumber: row.line.line_number,
            sourceLineId: row.line.id,
            itemId: row.line.item_id,
            itemName: row.line.item_name,
            description: row.line.description,
            unit: row.line.unit,
            orderedQuantity: fromQuantityUnits(toQuantityUnits(String(row.line.quantity))),
            cancelledQuantity: fromQuantityUnits(
              toQuantityUnits(String(row.line.quantity_cancelled)),
            ),
            fulfilledQuantity: fromQuantityUnits(
              toQuantityUnits(String(row.line.quantity_fulfilled)),
            ),
            previouslyBilledQuantity: fromQuantityUnits(
              toQuantityUnits(String(row.line.quantity_billed)),
            ),
            convertedQuantity: fromQuantityUnits(units),
            withheldQuantity: fromQuantityUnits(remainderUnits - units),
            withheldAmount: add(row.remainder.amount, neg(amount)),
            withheldTaxAmount: add(row.remainder.taxAmount, neg(taxAmount)),
            reason: doc.kind === "purchase_order" ? "awaiting_receipt" : "awaiting_shipment",
          });
        }
      }
      if (covered.length === 0) {
        const first = withheld[0]!;
        const purchase = doc.kind === "purchase_order";
        const others =
          withheld.length > 1
            ? `, and ${withheld.length - 1} more open line${withheld.length > 2 ? "s" : ""}`
            : "";
        throw new ConversionError(
          `${purchase ? "Received" : "Shipped"} quantities do not cover any line yet: ${lineLabel.toLowerCase()} ${first.lineNumber}${first.itemName ? ` (${first.itemName})` : ""} has ${displayQuantity(toQuantityUnits(first.withheldQuantity))} open to bill and ${displayQuantity(toQuantityUnits(first.fulfilledQuantity))} ${purchase ? "received" : "shipped"}${others} — ${
            purchase
              ? "record the goods receipt (Convert to Goods receipt), then convert to a bill"
              : "fulfill the order (Convert to Fulfillment), then convert to an invoice"
          }`,
          422,
          ORDER_CONVERSION_NOTHING_BILLABLE,
          { withheldLines: withheld },
        );
      }
      // Source lines stay. Turning Equipment off must refuse a conversion that
      // would copy equipment_charge onto the new document.
      if (!(await isFeatureEnabled(orgId, "equipment"))) {
        const itemIds = [
          ...new Set(
            covered
              .map((row) => row.line.item_id as string | null)
              .filter((itemId): itemId is string => Boolean(itemId)),
          ),
        ];
        for (const itemId of itemIds) {
          const item = await tx.execute<{ kind: string }>(
            sql`
          select kind from items where id = ${itemId} and org_id = ${orgId}`,
            "objects",
          );
          if (item[0] && item[0].kind === "equipment_charge") {
            throw new ConversionError(
              "Equipment is disabled: this conversion would copy equipment charges onto the new document — enable Equipment under Company Settings → Features, then convert again",
            );
          }
        }
      }

      const documentNumber = await nextDocumentNumber(
        orgId,
        target.kind,
        target.prefix,
        doc.subsidiary_id,
      );
      const isOrder = ORDER_KINDS.includes(target.kind as OrderKind);
      // A quote→sales-order conversion crosses the same authoritative issuance
      // boundary as the sales-order drawer below, so it starts draft and is
      // issued only after the customer credit decision. Other downstream orders
      // retain their established issued status; posting documents start draft.
      const targetStatus = target.kind === "sales_order" ? "draft" : isOrder ? "approved" : "draft";
      // Keep the source commercial date. A UTC "today" here both shifted the
      // cutoff for orgs behind UTC and dropped the order's own date.
      const documentDate = String(doc.document_date);

      const convertedAmounts: string[] = [];
      const convertedTaxes: string[] = [];
      // Work dates follow the order onto a document that also bills work.
      const carriesWorkDates = WORK_PERIOD_DOCUMENT_KINDS.has(target.kind);
      const withheldTotal = sum(
        withheld.flatMap((line) => [line.withheldAmount, line.withheldTaxAmount]),
      );
      // The new document records what it does not carry, so the shortfall is
      // visible on the document itself as well as on the order's open remainder.
      const targetCustom =
        withheld.length > 0
          ? {
              conversionShortfall: {
                sourceDocumentId: sourceId,
                withheldTotal,
                withheldLines: withheld,
              },
            }
          : {};
      const created = (
        await tx.execute<{ id: string }>(
          sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, due_date,
                             currency, fx_rate, status, subsidiary_id, department_id, project_id, location_id,
                             class_id, extra_dims, billing_method, memo, subtotal, tax_total, total, work_completed_on, custom, created_by)
      values (${orgId}, ${target.kind}, ${documentNumber}, ${doc.party_id},
              ${documentDate}, ${doc.due_date}, ${doc.currency},
              ${doc.fx_rate}, ${targetStatus}, ${doc.subsidiary_id}, ${doc.department_id}, ${doc.project_id},
              ${doc.location_id}, ${doc.class_id}, ${JSON.stringify(doc.extra_dims ?? {})}::jsonb, ${doc.billing_method}, ${doc.memo},
              '0', '0', '0', ${carriesWorkDates ? (doc.work_completed_on ?? null) : null}, ${JSON.stringify(targetCustom)}::jsonb, ${userId})
      returning id
    `,
          "objects",
        )
      )[0]!;
      const newId = created.id;

      // Migration 0034 makes approved document lines immutable. Advancing
      // quantity_billed is operational reconciliation state, rather than an
      // edit to the approved commercial source. The source header is already
      // locked for this transaction, so briefly reopen it while the conversion
      // advances its covered lines, then restore the approved status before the
      // transaction can become visible to another caller. Any failure rolls the
      // entire conversion (including this temporary status window) back.
      const reopenSourceForLineAdvances = doc.status === "approved";
      if (reopenSourceForLineAdvances) {
        const reopened = (
          await tx.execute<{ id: string }>(
            sql`
        update documents
           set status = 'draft', updated_by = ${userId}
         where id = ${sourceId} and org_id = ${orgId} and status = 'approved'
        returning id
      `,
            "objects",
          )
        )[0];
        if (!reopened) throw new ConversionError("Order changed while it was being converted", 409);
      }

      // A vendor bill drawn from received stock clears received-not-billed when
      // it posts, for matched lines whatever account the line carries (see
      // resolveBillInventoryAccounts). The converted line therefore carries that
      // clearing account, so the draft shows where its value actually lands
      // instead of the order line's inventory asset account. The account must
      // pass the same subsidiary scope the bill save applies to its accounts,
      // or the saved draft would be refused. Resolved once per item.
      const receivedStockAccounts = new Map<string, string>();
      if (doc.kind === "purchase_order" && target.kind === "vendor_bill") {
        for (const { line } of covered) {
          if (line.item_id == null || !lineRequiresReceipt(line.item_kind ?? null)) continue;
          if (receivedStockAccounts.has(line.item_id)) continue;
          const itemLabel = line.item_name ? ` (${line.item_name})` : "";
          const resolved = await resolveReceivedNotBilledAccount(tx, orgId, line.item_id);
          if (!resolved) {
            throw new ConversionError(
              `Purchase-order line ${line.line_number}${itemLabel} cannot be billed: ${receivedNotBilledMissingMessage(line.item_name ?? `item ${line.item_id}`)}`,
              422,
              ITEM_MISSING_RNB_ACCOUNT,
              { lineNumber: line.line_number, itemId: line.item_id, itemName: line.item_name },
            );
          }
          const visible = (
            await tx.execute<{ id: string }>(
              sql`
          select id from accounts
           where id = ${resolved.accountId} and org_id = ${orgId}
             and (subsidiary_id is null or subsidiary_id = ${doc.subsidiary_id}::uuid)
        `,
              "objects",
            )
          )[0];
          if (!visible) {
            throw new ConversionError(
              `Purchase-order line ${line.line_number}${itemLabel} cannot be billed: its received-not-billed account is not available to this order's subsidiary — set the item's costing profile or the company Received not billed account to an account of this subsidiary, then convert again`,
              422,
            );
          }
          receivedStockAccounts.set(line.item_id, resolved.accountId);
        }
      }
      const billedAccountOf = (l: OrderConvertLineRow): string | null =>
        (l.item_id != null ? receivedStockAccounts.get(l.item_id) : undefined) ??
        convertedAccountOf(l);

      let lineNo = 1;
      for (const r of covered) {
        const l = r.line;
        const { amount, taxAmount } = r;
        convertedAmounts.push(amount);
        convertedTaxes.push(taxAmount);
        // The exact billed-quantity advance for this line (see the guarded
        // quantity_billed update below). A void or draft-delete of this child
        // restores precisely this cover to the source line — without it the
        // billed remainder strands and the source can never be re-converted.
        const coveredQty = fromQuantityUnits(r.units);
        const inserted = await tx.execute<{ id: string }>(
          sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, description,
              quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_amount, marketplace_facilitator, department_id, project_id,
              location_id, class_id, extra_dims, stock_location_id, is_billable, custom, created_by, price_basis,
              work_from, work_to)
        values (${orgId}, ${newId}, ${lineNo}, ${l.item_id}, ${billedAccountOf(l)}, ${l.description},
              ${coveredQty}, ${l.unit}, ${l.unit_price}, ${amount},
              ${l.tax_code_id}, ${l.tax_group_id}, ${taxAmount}, ${l.marketplace_facilitator}, ${l.department_id}, ${l.project_id},
              ${l.location_id}, ${l.class_id}, ${JSON.stringify(l.extra_dims ?? {})}::jsonb, ${l.stock_location_id}, ${l.is_billable},
              ${JSON.stringify({
                // A bill line drawn from a purchase-order line keeps that
                // provenance: bill posting uses it to clear received-not-billed
                // for stock a goods receipt already brought in, instead of
                // receiving the stock a second time.
                ...(doc.kind === "purchase_order" && target.kind === "vendor_bill"
                  ? { purchaseOrderLineId: l.id }
                  : {}),
                convertedFrom: { documentId: sourceId, lineId: l.id, quantity: coveredQty },
              })}::jsonb, ${userId}, ${l.price_basis == null ? null : JSON.stringify(l.price_basis)}::jsonb,
              ${carriesWorkDates ? (l.work_from ?? null) : null}, ${carriesWorkDates ? (l.work_to ?? null) : null})
        returning id
      `,
          "objects",
        );
        const newLineId = inserted[0]!.id;
        const originalQty = toQuantityUnits(String(l.quantity));
        if (originalQty !== 0n && (l.tax_code_id || l.tax_group_id)) {
          const components = await tx.execute<{
            tax_code_id: string;
            sequence: number;
            rate_percent: string;
            taxable_amount: string;
            tax_amount: string;
            recoverable_amount: string;
            nonrecoverable_amount: string;
            calculation_type: "standard" | "withholding" | "reverse_charge";
            price_includes_tax: boolean;
            compound_on_previous: boolean;
            rounding_scale: number;
            collected_account_id: string | null;
            paid_account_id: string | null;
            withholding_account_id: string | null;
            overridden: boolean;
          }>(
            sql`
          select tax_code_id, sequence, rate_percent, taxable_amount, tax_amount,
                 recoverable_amount, nonrecoverable_amount, calculation_type,
                 price_includes_tax, compound_on_previous, rounding_scale,
                 collected_account_id, paid_account_id, withholding_account_id, overridden
            from document_line_tax_components
           where document_line_id = ${l.id} and org_id = ${orgId}
           order by sequence
        `,
            "objects",
          );
          if (components.length === 0) {
            throw new ConversionError(
              `line ${l.line_number} has a tax profile but no calculation evidence — reopen the order and save it so tax can be recalculated`,
            );
          }
          await persistLineTaxComponents(tx, {
            orgId,
            documentLineId: newLineId,
            actorId: userId,
            components: components.map((c) => {
              const tax = mulRatio(String(c.tax_amount), r.units, originalQty);
              const recoverable = mulRatio(String(c.recoverable_amount), r.units, originalQty);
              return {
                taxCodeId: c.tax_code_id,
                sequence: c.sequence,
                ratePercent: String(c.rate_percent),
                taxableAmount: mulRatio(String(c.taxable_amount), r.units, originalQty),
                taxAmount: tax,
                recoverableAmount: recoverable,
                // Keep the recovery crossfoot: scale tax and recoverable, then
                // residual is nonrecoverable so rounding cannot break the check.
                nonrecoverableAmount: add(tax, neg(recoverable)),
                calculationType: c.calculation_type,
                priceIncludesTax: c.price_includes_tax,
                compoundOnPrevious: c.compound_on_previous,
                roundingScale: c.rounding_scale,
                collectedAccountId: c.collected_account_id,
                paidAccountId: c.paid_account_id,
                withholdingAccountId: c.withholding_account_id,
                overridden: c.overridden,
              };
            }),
          });
        }
        // Advance billed qty on the source line. The advance is guarded by the
        // same ceiling the remainder was computed from, so a concurrent channel
        // that consumed the cover makes THIS conversion fail whole (the row
        // lock already serializes; the predicate documents and enforces it).
        // Only fulfillment-governed sources cap billing by received or shipped quantity.
        const receiptRequired =
          fulfillmentGovernedBilling &&
          l.item_id != null &&
          lineRequiresReceipt(l.item_kind ?? null);
        const advanced = (
          await tx.execute<{ id: string }>(
            sql`
        update document_lines set quantity_billed = quantity_billed + ${coveredQty}, updated_by = ${userId}
         where id = ${l.id} and org_id = ${orgId}
           and quantity_billed + ${coveredQty} <= ${orderedNetOfCancelledSql("document_lines")}
           ${receiptRequired ? sql`and quantity_billed + ${coveredQty} <= quantity_fulfilled` : sql``}
        returning id
      `,
            "objects",
          )
        )[0];
        if (!advanced)
          throw new ConversionError(
            `Line ${l.line_number} changed while it was being converted`,
            409,
          );
        lineNo++;
      }

      if (reopenSourceForLineAdvances) {
        const restored = (
          await tx.execute<{ id: string }>(
            sql`
        update documents
           set status = 'approved', updated_by = ${userId}
         where id = ${sourceId} and org_id = ${orgId} and status = 'draft'
        returning id
      `,
            "objects",
          )
        )[0];
        if (!restored) throw new ConversionError("Order changed while it was being converted", 409);
      }

      const totalsWritten = (
        await tx.execute<{ id: string }>(
          sql`
      update documents set subtotal = ${sum(convertedAmounts)}, tax_total = ${sum(convertedTaxes)},
             total = ${add(sum(convertedAmounts), sum(convertedTaxes))}, updated_by = ${userId}
      where id = ${newId} and org_id = ${orgId}
      returning id
    `,
          "objects",
        )
      )[0];
      if (!totalsWritten)
        throw new ConversionError("The converted document could not be totalled", 409);

      // Every conversion is audited with what it carried and what it withheld,
      // so the difference between the order's open total and the new
      // document's total is always explained by the evidence.
      await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${orgId}, 'documents', ${newId}, 'insert',
        ${JSON.stringify({
          mode: "order_converted",
          sourceDocumentId: sourceId,
          sourceKind: doc.kind,
          targetKind: target.kind,
          convertedSubtotal: sum(convertedAmounts),
          convertedTaxTotal: sum(convertedTaxes),
          convertedLines: covered.map((row) => ({
            lineNumber: row.line.line_number,
            sourceLineId: row.line.id,
            quantity: fromQuantityUnits(row.units),
            amount: row.amount,
            taxAmount: row.taxAmount,
          })),
          withheldTotal,
          withheldLines: withheld,
        })}::jsonb,
        ${userId}
      )
    `);

      await tx.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by)
      values (${orgId}, ${sourceId}, ${newId}, ${target.link}, ${userId})
    `);

      if (target.kind === "sales_order") {
        const revision = (
          await tx.execute<{ updated_at: string }>(
            sql`
        select ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at from documents where id = ${newId} and org_id = ${orgId}
      `,
            "objects",
          )
        )[0]!.updated_at;
        const issuance = await issueSalesOrder({
          orgId,
          salesOrderId: newId,
          actorId: userId,
          expectedUpdatedAt: revision,
          creditOverrideReason: options.creditOverrideReason,
        });
        // A refused routing throws: the submission already wrote its
        // before_submit script effects, and answering from inside this
        // conversion transaction would commit them alongside the refusal.
        // The ConversionError maps to the same 422 after the rollback, so the
        // refused issue never strands a converted order with committed effects.
        if (issuance.submission.flowError) {
          throw new ConversionError(
            `approval could not be routed: ${issuance.submission.flowError}`,
          );
        }
      }

      const opportunityLink = await tx.execute<{ opportunity_id: string }>(
        sql`
      select opportunity_id from crm_opportunity_documents
       where document_id = ${sourceId} and org_id = ${orgId}
    `,
        "objects",
      );
      if (opportunityLink[0]) {
        await tx.execute(sql`
        insert into crm_opportunity_documents (org_id, opportunity_id, document_id, created_by, updated_by)
        values (${orgId}, ${opportunityLink[0].opportunity_id}, ${newId}, ${userId}, ${userId})
        `);
      }
      if (
        doc.party_id &&
        ["sales_order", "customer_invoice", "customer_credit", "customer_payment"].includes(
          target.kind,
        )
      ) {
        const promotion = await promoteCrmAccount(tx, {
          orgId,
          partyId: doc.party_id,
          actorId: userId,
          toStage: "customer",
          sourceKind: target.kind,
          sourceId: newId,
        });
        // Conversion into an order or AR document makes the party a customer:
        // core AR state the hold and limit checks depend on, with CRM on or off.
        if (!promotion.customerRoleActive) {
          throw new Error("customer role was not established while converting the order");
        }
      }

      return {
        id: newId,
        documentNumber,
        kind: target.kind,
        ...(withheld.length > 0 ? { withheldLines: withheld, withheldTotal } : {}),
      };
    }),
  );
}
