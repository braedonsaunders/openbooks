import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { priceLevelUnitPrice } from "@openbooks/engine/intercompany";
import {
  PosError,
  readPosReceipt,
  type PosAuthority,
  type PosPricingDeps,
} from "@openbooks/engine/pos";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "@openbooks/engine/delivery/email-config/module";
import {
  deriveEmailDeliveryKey,
  emailDeliveryBlockedParts,
  posReceiptEmail,
  sendVia,
} from "@openbooks/emails";
import { can, type Authz } from "./authz";
import { resolveItemPrice } from "./item-pricing";

/** Price sources that are specific to the customer and outrank a register's price level. */
const CUSTOMER_PRICE_SOURCES = new Set([
  "customer_item",
  "customer_family",
  "customer_level",
  "family_level",
]);

/**
 * The register's selling price, from the native price schedules: a price
 * agreed with the customer wins, then the register's price level, then the
 * base price level and the item's own price. Null means the item has no
 * price in the register's currency, which the register refuses by name.
 */
export const posPricing: PosPricingDeps = {
  async unitPrice(request) {
    const resolved = await resolveItemPrice({
      orgId: request.orgId,
      itemId: request.itemId,
      customerId: request.customerId,
      currency: request.currency,
      lineQuantity: request.quantity,
      onDate: request.date,
    });
    if (resolved && CUSTOMER_PRICE_SOURCES.has(resolved.source)) return resolved.unitPrice;
    if (request.priceLevelId) {
      const level = await priceLevelUnitPrice(db, request.orgId, {
        priceLevelId: request.priceLevelId,
        itemId: request.itemId,
        currency: request.currency,
        quantity: request.quantity,
        date: request.date,
      });
      if (level !== null) return level;
    }
    return resolved?.unitPrice ?? null;
  },
};

/** What the acting user may approve at the register. */
export function posAuthority(authz: Authz): PosAuthority {
  const override = can(authz, "pos.override");
  return { overridePrice: override, discount: override };
}

/** The request key a register write carries, or null when absent or malformed. */
export function posIdempotencyKey(request: Request): string | null {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key) ? key : null;
}

/** Bigint-safe JSON: ledger units travel as strings. */
export function posJson<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );
}

/**
 * Email a register receipt through the organization's configured email
 * delivery, logged like every other outbound document email. The recipient
 * defaults to the customer's email on file.
 */
export async function emailPosReceipt(input: {
  orgId: string;
  actorId: string;
  documentId: string;
  to: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ to: string }> {
  const receipt = await readPosReceipt(
    db,
    input.orgId,
    input.documentId,
    input.allowedSubsidiaryIds,
  );
  if (receipt.status !== "posted") {
    throw new PosError(
      `Receipt ${receipt.documentNumber} is ${receipt.status}.`,
      "refund_source_invalid",
      422,
      "Only a posted receipt can be emailed.",
    );
  }
  const party = (
    await db.execute<{ email: string | null; display_name: string | null; org_name: string }>(
      sql`
    select p.email, p.display_name, o.name as org_name
      from orgs o
      left join documents d on d.org_id = o.id and d.id = ${receipt.documentId}
      left join parties p on p.org_id = o.id and p.id = d.party_id
     where o.id = ${input.orgId}`,
      "objects",
    )
  )[0];
  const to = input.to?.trim() || party?.email?.trim() || "";
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new PosError(
      "No valid recipient email address.",
      "invalid_input",
      422,
      "Enter the customer's email address.",
    );
  }
  const delivery = await resolveOrgEmailTransportDetailed(input.orgId);
  if (delivery.state !== "ready") {
    const parts = emailDeliveryBlockedParts(delivery);
    throw new PosError(parts.summary, "invalid_input", 422, parts.remedy);
  }
  const body = posReceiptEmail({
    orgName: party?.org_name || "OpenBooks",
    recipientName: party?.display_name ?? null,
    receiptNumber: receipt.documentNumber,
    kind: receipt.kind === "cash_refund" ? "refund" : "sale",
    date: receipt.documentDate,
    currency: receipt.currency,
    lines: receipt.lines.map((line) => ({
      description: line.description ?? "",
      quantity: line.quantity ?? "1",
      amount: line.amount,
    })),
    subtotal: receipt.subtotal,
    tax: receipt.tax,
    total: receipt.total,
    tenders: receipt.tenders.map((tender) => ({
      label: tender.methodLabel,
      amount: tender.amount,
    })),
    change: receipt.kind === "cash_sale" && receipt.change !== "0.0000" ? receipt.change : null,
    header: receipt.register?.receiptHeader ?? null,
    footer: receipt.register?.receiptFooter ?? null,
  });
  const logId = await insertEmailLog({
    orgId: input.orgId,
    recipients: [to],
    subject: body.subject,
    status: "queued",
    categoryKey: "document",
    meta: { recordType: receipt.kind, recordId: receipt.documentId, event: "pos_receipt" },
    actor: { kind: "user", userId: input.actorId },
  });
  let uncertaintyRecorded = false;
  try {
    const outcome = await sendVia(
      delivery.transport,
      { to, subject: body.subject, html: body.html, text: body.text },
      {
        deliveryKey: deriveEmailDeliveryKey({ orgId: input.orgId, scope: `direct:${logId}`, to }),
      },
    );
    if (outcome.kind === "sent") await markEmailSent(input.orgId, logId, outcome.providerMessageId);
    else {
      uncertaintyRecorded = true;
      await markEmailUncertain(input.orgId, logId, outcome.reason);
      throw new Error(outcome.reason);
    }
  } catch (error) {
    if (!uncertaintyRecorded)
      await markEmailFailed(
        input.orgId,
        logId,
        error instanceof Error ? error.message : String(error),
      );
    throw error;
  }
  return { to };
}
