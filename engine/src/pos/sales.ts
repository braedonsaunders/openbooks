import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { cmp, fromUnits, toUnits } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { businessToday } from "../platform/business-date.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import {
  createDocument,
  DocumentCreateConflict,
  precomputeDocumentTotalsForCreate,
} from "../ledger/document-write.ts";
import { resolveDocumentLineDefaults } from "../ledger/document-defaults.ts";
import { controlDeps } from "../ledger/document-service.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import type { DocumentEditInput, DocumentLineInput } from "../ledger/document-input.ts";
import { hashStoredValueCode, normalizeStoredValueCode } from "../stored-value/codes.ts";
import {
  parsePosAmount,
  parsePosQuantity,
  parsePosUnitPrice,
  priceCart,
  proratedReturnUnits,
  type PosDiscount,
} from "./cart.ts";
import { posRefusal } from "./errors.ts";
import {
  acceptedTenderKinds,
  loadRegisterForUse,
  type PosRegister,
  type PosTenderKind,
} from "./registers.ts";
import {
  assertRegisterFeature,
  assertSessionOpen,
  lockSession,
  type PosSessionRow,
} from "./sessions.ts";

/**
 * Register sales and refunds. Every sale is a native `cash_sale` and every
 * refund a native `cash_refund`, created through the shared document writer
 * (validation, tax, numbering, audit) and posted through the posting kernel
 * (journal, inventory relief and return, stored-value redemption), so the
 * register never prices, taxes or posts anything the back office would not.
 *
 * Exactly once: the client's request key becomes the document id. Creation,
 * submission, posting and the register transaction row commit in ONE
 * transaction, so a refusal anywhere leaves nothing behind, and a retried
 * request with the same key returns the sale it already recorded instead of
 * creating a second one. Reusing a key for a different cart is refused.
 */

const STOCKED_KINDS = new Set(["inventory", "assembly", "kit"]);
const UNSELLABLE_KINDS = new Map<string, string>([
  ["gift_card", "Issue gift cards from Stored value; the register redeems them as a tender."],
  ["discount", "Apply a line or order discount in the cart instead of a discount item."],
  ["absence", "Absence items are payroll items and cannot be sold."],
  ["labor", "Labor items are billed from projects and timesheets, not sold at the register."],
]);

export interface PosSaleLineInput {
  itemId: string;
  quantity: string;
  /** A unit price different from the resolved price is an override. */
  unitPrice?: string | null;
  discount?: PosDiscount | null;
}

export interface PosPaymentInput {
  kind: PosTenderKind;
  /** Amount applied (card, stored value, other; refund cash). */
  amount?: string | null;
  /** Cash handed over on a sale; the change is derived. */
  tendered?: string | null;
  reference?: string | null;
  /** Gift card or store credit code (stored value). */
  code?: string | null;
  label?: string | null;
}

export interface PosPricingRequest {
  orgId: string;
  itemId: string;
  customerId: string | null;
  currency: string;
  quantity: string;
  date: string;
  priceLevelId: string | null;
}

/** The selling-price resolver, supplied by the application from the native price schedules. */
export interface PosPricingDeps {
  unitPrice(request: PosPricingRequest): Promise<string | null>;
}

export interface PosAuthority {
  overridePrice: boolean;
  discount: boolean;
}

export interface PosQuoteLine {
  itemId: string;
  code: string | null;
  name: string;
  quantity: string;
  listUnitPrice: string | null;
  unitPrice: string;
  priceOverridden: boolean;
  gross: string;
  lineDiscount: string;
  orderDiscount: string;
  net: string;
  tax: string;
  total: string;
}

export interface PosQuote {
  currency: string;
  currencyDecimals: number;
  customerId: string | null;
  lines: PosQuoteLine[];
  gross: string;
  discount: string;
  subtotal: string;
  tax: string;
  total: string;
}

interface BuiltCart {
  quote: PosQuote;
  documentLines: DocumentLineInput[];
  totalUnits: bigint;
  evidence: Array<{
    lineNumber: number;
    listUnitPrice: string | null;
    priceOverridden: boolean;
    lineDiscount: string;
    orderDiscount: string;
    discount: PosDiscount | null;
  }>;
}

type ItemRow = { id: string; code: string | null; name: string; kind: string; is_active: boolean };

function refuseNotPermitted(kind: "price" | "discount", label: string): never {
  if (kind === "price") {
    throw posRefusal(
      `${label} changes the price, which needs the price override permission.`,
      "price_override_not_permitted",
      422,
      "Ask a manager with the register override permission to approve the price, or sell at the listed price.",
    );
  }
  throw posRefusal(
    `${label} carries a discount, which needs the register override permission.`,
    "discount_not_permitted",
    422,
    "Ask a manager with the register override permission to apply the discount, or remove it.",
  );
}

/**
 * Price a cart through the native services: the selling price from the
 * price schedules (customer, register price level, base), the income
 * account and tax code from the item and customer defaults, exact discount
 * proration, and the tax the document writer will compute. The quote and
 * the sale use this same function, so what the cashier sees is what posts.
 */
export async function buildPosCart(
  runner: SqlExecutor,
  orgId: string,
  register: PosRegister,
  input: {
    customerId: string | null;
    lines: PosSaleLineInput[];
    orderDiscount?: PosDiscount | null;
    documentDate: string;
  },
  authority: PosAuthority,
  pricing: PosPricingDeps,
): Promise<BuiltCart> {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw posRefusal("The cart is empty.", "invalid_input", 422, "Scan or pick at least one item.");
  }
  if (input.lines.length > 200) {
    throw posRefusal(
      "The cart has more than 200 lines.",
      "invalid_input",
      422,
      "Split the sale into two receipts.",
    );
  }
  const customerId = input.customerId ?? register.defaultCustomerId;
  if (customerId) {
    if (!isUuid(customerId))
      throw posRefusal(
        "Choose a valid customer.",
        "invalid_input",
        422,
        "Look the customer up again, or sell to the walk-in customer.",
      );
    const customer = (
      await runner.execute<{ party_id: string }>(
        sql`
      select party_id from customer_roles where org_id = ${orgId} and party_id = ${customerId} and is_active`,
        "objects",
      )
    )[0];
    if (!customer)
      throw posRefusal(
        "That customer is not an active customer.",
        "invalid_input",
        422,
        "Look the customer up again, or sell to the walk-in customer.",
      );
  }
  const itemIds = [...new Set(input.lines.map((line) => line.itemId))];
  if (itemIds.some((id) => !isUuid(id))) {
    throw posRefusal(
      "A cart line names an item that does not exist.",
      "item_not_found",
      404,
      "Scan or pick the item again.",
    );
  }
  const items = new Map(
    (
      await runner.execute<ItemRow>(
        sql`
    select id, code, name, kind, is_active from items
     where org_id = ${orgId} and id in (${sql.join(
       itemIds.map((id) => sql`${id}`),
       sql`, `,
     )})`,
        "objects",
      )
    ).map((row) => [row.id, row]),
  );
  const resolvedPrices: Array<{ list: string | null; unitPrice: string; overridden: boolean }> = [];
  for (const [index, line] of input.lines.entries()) {
    const label = `Line ${index + 1}`;
    const item = items.get(line.itemId);
    if (!item || !item.is_active) {
      throw posRefusal(
        `${label} names an item that does not exist or is inactive.`,
        "item_not_found",
        404,
        "Scan or pick the item again.",
      );
    }
    const unsellable = UNSELLABLE_KINDS.get(item.kind);
    if (unsellable)
      throw posRefusal(
        `${item.name} cannot be sold at the register.`,
        "invalid_input",
        422,
        unsellable,
      );
    const quantity = parsePosQuantity(line.quantity, label);
    const list = await pricing.unitPrice({
      orgId,
      itemId: item.id,
      customerId,
      currency: register.currency,
      quantity,
      date: input.documentDate,
      priceLevelId: register.priceLevelId,
    });
    const supplied =
      line.unitPrice === undefined || line.unitPrice === null || line.unitPrice === ""
        ? null
        : parsePosUnitPrice(line.unitPrice, label);
    if (supplied === null && list === null) {
      throw posRefusal(
        `${item.name} has no selling price in ${register.currency}.`,
        "item_unpriced",
        422,
        "Set the item's price in Items, or enter the price with the register override permission.",
      );
    }
    const overridden = supplied !== null && (list === null || cmp(supplied, list) !== 0);
    if (overridden && !authority.overridePrice)
      refuseNotPermitted("price", `${label} (${item.name})`);
    if (line.discount && !authority.discount)
      refuseNotPermitted("discount", `${label} (${item.name})`);
    resolvedPrices.push({ list, unitPrice: supplied ?? list!, overridden });
  }
  if (input.orderDiscount && !authority.discount) refuseNotPermitted("discount", "The order");
  const priced = priceCart(
    input.lines.map((line, index) => ({
      quantity: line.quantity,
      unitPrice: resolvedPrices[index]!.unitPrice,
      discount: line.discount ?? null,
    })),
    input.orderDiscount ?? null,
    register.currencyDecimals,
  );
  const defaults = new Map(
    (
      await resolveDocumentLineDefaults(runner, orgId, {
        kind: "cash_sale",
        partyId: customerId,
        itemIds,
      })
    ).map((row) => [row.itemId, row]),
  );
  const documentLines: DocumentLineInput[] = input.lines.map((line, index) => {
    const item = items.get(line.itemId)!;
    const lineDefaults = defaults.get(item.id);
    if (!lineDefaults?.accountId) {
      throw posRefusal(
        `${item.name} has no usable income account.`,
        "register_misconfigured",
        422,
        "Set an active income account on the item in Items, then ring it up again.",
      );
    }
    const pricedLine = priced.lines[index]!;
    return {
      itemId: item.id,
      description: item.name,
      quantity: pricedLine.quantity,
      unitPrice: pricedLine.unitPrice,
      amount: fromUnits(pricedLine.netUnits),
      accountId: lineDefaults.accountId,
      taxCodeId: lineDefaults.taxCodeId,
      locationId: register.locationId,
      ...(STOCKED_KINDS.has(item.kind) && register.stockLocationId
        ? { stockLocationId: register.stockLocationId }
        : {}),
    };
  });
  const totals = await precomputeDocumentTotalsForCreate(orgId, "cash_sale", {
    lines: documentLines,
    currency: register.currency,
    documentDate: input.documentDate,
    partyId: customerId,
    subsidiaryId: register.subsidiaryId,
  });
  if (!totals) throw new Error("cart totals did not resolve");
  const quoteLines: PosQuoteLine[] = documentLines.map((line, index) => {
    const item = items.get(line.itemId!)!;
    const pricedLine = priced.lines[index]!;
    const taxed = totals.lines[index]!;
    return {
      itemId: item.id,
      code: item.code,
      name: item.name,
      quantity: pricedLine.quantity,
      listUnitPrice: resolvedPrices[index]!.list,
      unitPrice: pricedLine.unitPrice,
      priceOverridden: resolvedPrices[index]!.overridden,
      gross: fromUnits(pricedLine.grossUnits),
      lineDiscount: fromUnits(pricedLine.lineDiscountUnits),
      orderDiscount: fromUnits(pricedLine.orderDiscountUnits),
      net: taxed.amount,
      tax: taxed.taxAmount,
      total: fromUnits(toUnits(taxed.amount) + toUnits(taxed.taxAmount)),
    };
  });
  return {
    quote: {
      currency: register.currency,
      currencyDecimals: register.currencyDecimals,
      customerId,
      lines: quoteLines,
      gross: fromUnits(priced.grossUnits),
      discount: fromUnits(priced.lineDiscountUnits + priced.orderDiscountUnits),
      subtotal: totals.subtotal,
      tax: totals.taxTotal,
      total: totals.total,
    },
    documentLines,
    totalUnits: toUnits(totals.total),
    evidence: input.lines.map((line, index) => ({
      lineNumber: index + 1,
      listUnitPrice: resolvedPrices[index]!.list,
      priceOverridden: resolvedPrices[index]!.overridden,
      lineDiscount: fromUnits(priced.lines[index]!.lineDiscountUnits),
      orderDiscount: fromUnits(priced.lines[index]!.orderDiscountUnits),
      discount: line.discount ?? null,
    })),
  };
}

/** Price a cart for the register screen without writing anything. */
export async function quotePosCart(
  input: {
    orgId: string;
    registerId: string;
    customerId: string | null;
    lines: PosSaleLineInput[];
    orderDiscount?: PosDiscount | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
  authority: PosAuthority,
  pricing: PosPricingDeps,
): Promise<PosQuote> {
  return withOrgTransaction(input.orgId, async () => {
    await assertRegisterFeature(db, input.orgId);
    const register = await loadRegisterForUse(db, input.orgId, input.registerId, {
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    });
    const documentDate = await businessToday(input.orgId);
    return (
      await buildPosCart(db, input.orgId, register, { ...input, documentDate }, authority, pricing)
    ).quote;
  });
}

interface PlannedTenders {
  tenders: Array<Record<string, string | null>>;
  cashAppliedUnits: bigint;
  cashTenderedUnits: bigint;
  changeUnits: bigint;
}

async function resolveStoredValueAccount(
  runner: SqlExecutor,
  orgId: string,
  code: string | null | undefined,
  label: string,
): Promise<string> {
  const normalized = typeof code === "string" ? normalizeStoredValueCode(code) : "";
  if (!normalized) {
    throw posRefusal(
      `${label} needs the gift card or store credit code.`,
      "stored_value_unknown",
      422,
      "Scan or type the card code.",
    );
  }
  const row = (
    await runner.execute<{ id: string }>(
      sql`
    select id from stored_value_accounts where org_id = ${orgId} and code_hash = ${hashStoredValueCode(orgId, normalized)}`,
      "objects",
    )
  )[0];
  if (!row) {
    throw posRefusal(
      `${label} names a card code that does not exist.`,
      "stored_value_unknown",
      404,
      "Check the code and scan or type it again.",
    );
  }
  return row.id;
}

function cleanReference(value: string | null | undefined, max: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text.slice(0, max);
}

/**
 * Turn register payments into native tenders that settle the total exactly.
 * Non-cash tenders apply their stated amounts; cash covers the remainder,
 * and on a sale the cash handed over beyond it is change. Every tender kind
 * must be accepted by the register (its settlement account configured).
 * A total of exactly zero — a sale discounted or comped in full, or the
 * refund of one — settles with no tenders at all, and takes no payment.
 */
export async function planTenders(
  runner: SqlExecutor,
  orgId: string,
  register: PosRegister,
  payments: PosPaymentInput[],
  totalUnits: bigint,
  mode: "sale" | "refund",
): Promise<PlannedTenders> {
  const list = Array.isArray(payments) ? payments : [];
  if (totalUnits === 0n) {
    // A refund paid back through one tender names no amount: the whole
    // refund, which here is nothing, so that tender pays nothing out.
    const wholeRefundOfNothing =
      mode === "refund" &&
      list.length === 1 &&
      (list[0]!.amount === undefined || list[0]!.amount === null || list[0]!.amount === "");
    if (list.length > 0 && !wholeRefundOfNothing) {
      throw posRefusal(
        mode === "sale"
          ? "Nothing is due on this sale, so it takes no payment."
          : "Nothing is owed back on this refund, so it pays nothing out.",
        "tender_mismatch",
        422,
        mode === "sale"
          ? "Remove the payments and complete the sale at no charge."
          : "Remove the refund payment and complete the refund at no charge.",
      );
    }
    return { tenders: [], cashAppliedUnits: 0n, cashTenderedUnits: 0n, changeUnits: 0n };
  }
  if (list.length === 0) {
    throw posRefusal("Add a payment.", "tender_mismatch", 422, "Choose how the customer pays.");
  }
  if (payments.length > 10) {
    throw posRefusal(
      "A receipt takes at most ten payments.",
      "tender_mismatch",
      422,
      "Combine payments of the same kind.",
    );
  }
  const accepted = new Set(acceptedTenderKinds(register));
  const cashPayments = payments.filter((payment) => payment.kind === "cash");
  if (cashPayments.length > 1) {
    throw posRefusal(
      "Enter cash once.",
      "tender_mismatch",
      422,
      "Combine the cash into one payment.",
    );
  }
  const tenders: Array<Record<string, string | null>> = [];
  let nonCashUnits = 0n;
  for (const [index, payment] of payments.entries()) {
    const label = `Payment ${index + 1}`;
    if (!accepted.has(payment.kind)) {
      throw posRefusal(
        `This register does not accept ${payment.kind.replace("_", " ")} payments.`,
        "tender_not_accepted",
        422,
        "Choose another payment, or configure the tender's account on the register in Setup → Sales → Registers.",
      );
    }
    if (payment.kind === "cash") continue;
    // A refund paid back through one tender takes the whole refund: the
    // register cannot know the refund total before the writer prices it.
    const wholeRefund =
      mode === "refund" &&
      payments.length === 1 &&
      (payment.amount === undefined || payment.amount === null || payment.amount === "");
    const amountUnits = wholeRefund
      ? totalUnits
      : parsePosAmount(payment.amount ?? "", `${label} amount`, register.currencyDecimals);
    if (amountUnits <= 0n)
      throw posRefusal(
        `${label} amount must be greater than zero.`,
        "tender_mismatch",
        422,
        "Enter the amount paid with this tender, or remove it.",
      );
    nonCashUnits += amountUnits;
    if (payment.kind === "stored_value") {
      tenders.push({
        kind: "stored_value",
        methodLabel: cleanReference(payment.label, 60) ?? "Gift card",
        storedValueAccountId: await resolveStoredValueAccount(runner, orgId, payment.code, label),
        amount: fromUnits(amountUnits),
        reference: null,
      });
    } else {
      tenders.push({
        kind: payment.kind,
        methodLabel:
          cleanReference(payment.label, 60) ?? (payment.kind === "card" ? "Card" : "Other"),
        accountId: payment.kind === "card" ? register.cardAccountId : register.otherAccountId,
        amount: fromUnits(amountUnits),
        reference: cleanReference(payment.reference, 120),
      });
    }
  }
  if (nonCashUnits > totalUnits) {
    throw posRefusal(
      `The payments total ${fromUnits(nonCashUnits)}, more than the ${fromUnits(totalUnits)} due.`,
      "tender_mismatch",
      422,
      "Reduce a payment so the payments equal the total.",
    );
  }
  const cashAppliedUnits = totalUnits - nonCashUnits;
  let cashTenderedUnits = 0n;
  let changeUnits = 0n;
  if (cashAppliedUnits > 0n) {
    const cash = cashPayments[0];
    if (!cash) {
      throw posRefusal(
        `The payments total ${fromUnits(nonCashUnits)}, but ${fromUnits(totalUnits)} is due.`,
        "tender_mismatch",
        422,
        "Add a payment for the remaining balance.",
      );
    }
    if (mode === "sale") {
      cashTenderedUnits = parsePosAmount(
        cash.tendered ?? cash.amount ?? "",
        "Cash tendered",
        register.currencyDecimals,
      );
      if (cashTenderedUnits < cashAppliedUnits) {
        throw posRefusal(
          `Cash tendered ${fromUnits(cashTenderedUnits)} does not cover the ${fromUnits(cashAppliedUnits)} due in cash.`,
          "cash_insufficient",
          422,
          "Enter the cash handed over, or add another payment for the rest.",
        );
      }
      changeUnits = cashTenderedUnits - cashAppliedUnits;
    } else {
      const stated = cash.amount
        ? parsePosAmount(cash.amount, "Cash refunded", register.currencyDecimals)
        : cashAppliedUnits;
      if (stated !== cashAppliedUnits) {
        throw posRefusal(
          `Cash refunded ${fromUnits(stated)} does not match the ${fromUnits(cashAppliedUnits)} still owed to the customer.`,
          "tender_mismatch",
          422,
          "Refund the remaining balance in cash, or adjust the other refund payments.",
        );
      }
    }
    tenders.unshift({
      kind: "cash",
      methodLabel: "Cash",
      accountId: register.cashAccountId,
      amount: fromUnits(cashAppliedUnits),
      reference: null,
    });
  } else if (cashPayments.length > 0) {
    throw posRefusal(
      "The other payments already cover the total.",
      "tender_mismatch",
      422,
      "Remove the cash payment.",
    );
  }
  return { tenders, cashAppliedUnits, cashTenderedUnits, changeUnits };
}

/** Submit and post a register document inside the caller's transaction, exactly as the document actions do. */
async function submitAndPost(
  orgId: string,
  actorId: string,
  documentId: string,
  kindLabel: string,
): Promise<string> {
  const locked = (
    await db.execute<{ status: string; kind: string }>(
      sql`
    select status, kind from documents where org_id = ${orgId} and id = ${documentId} for update`,
      "objects",
    )
  )[0];
  if (!locked) throw new Error("register document disappeared before posting");
  if (locked.status === "posted") return "posted";
  if (locked.status !== "draft") {
    throw posRefusal(
      `The ${kindLabel} is ${locked.status}.`,
      "idempotency_conflict",
      409,
      "Open the receipt in Cash Sales to review it.",
    );
  }
  const submission = await submitAndReleaseIfUngated(locked.kind, documentId, actorId, {
    source: "ui",
  });
  if (submission.flowError || submission.gated) {
    throw posRefusal(
      `This ${kindLabel} needs approval under the organization's approval flow${submission.flowError ? `: ${submission.flowError}` : ""}.`,
      "approval_required",
      409,
      `Record the ${kindLabel} from Cash Sales in the back office, where it can be routed for approval.`,
    );
  }
  await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'documents', ${documentId}, 'submit', ${JSON.stringify({ from: "draft", to: "approved", auto_approved: true })}::jsonb, ${actorId}),
           (${orgId}, 'documents', ${documentId}, 'approve', ${JSON.stringify({ from: "draft", to: "approved", auto: true, reason: "released without approval: no approval flow configured" })}::jsonb, ${actorId})`);
  await postDocument(documentId, await controlDeps(orgId), {
    deferEffects: true,
    audit: { actorId, source: "pos" },
  });
  return "draft";
}

export interface PosSaleInput {
  orgId: string;
  actorId: string;
  sessionId: string;
  idempotencyKey: string;
  customerId: string | null;
  lines: PosSaleLineInput[];
  orderDiscount?: PosDiscount | null;
  payments: PosPaymentInput[];
  /** The total the cashier was shown; a different computed total is refused. */
  expectedTotal?: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

export interface PosCompletion {
  documentId: string;
  documentNumber: string;
  kind: "sale" | "refund";
  total: string;
  change: string;
  replayed: boolean;
  effectsPending: boolean;
}

async function existingTransaction(
  orgId: string,
  documentId: string,
): Promise<{
  kind: "sale" | "refund";
  totalMinor: string;
  changeMinor: string;
  documentNumber: string;
} | null> {
  const row = (
    await db.execute<{
      kind: "sale" | "refund";
      total_minor: string;
      change_minor: string;
      document_number: string;
    }>(
      sql`
    select t.kind, t.total_minor::text as total_minor, t.change_minor::text as change_minor, d.document_number
      from pos_transactions t
      join documents d on d.org_id = t.org_id and d.id = t.document_id
     where t.org_id = ${orgId} and t.document_id = ${documentId}`,
      "objects",
    )
  )[0];
  return row
    ? {
        kind: row.kind,
        totalMinor: row.total_minor,
        changeMinor: row.change_minor,
        documentNumber: row.document_number,
      }
    : null;
}

function replayOf(
  documentId: string,
  prior: NonNullable<Awaited<ReturnType<typeof existingTransaction>>>,
  expectKind: "sale" | "refund",
): PosCompletion {
  if (prior.kind !== expectKind) {
    throw posRefusal(
      "This request key was already used for a different register transaction.",
      "idempotency_conflict",
      409,
      "Start a new receipt.",
    );
  }
  return {
    documentId,
    documentNumber: prior.documentNumber,
    kind: prior.kind,
    total: fromUnits(BigInt(prior.totalMinor)),
    change: fromUnits(BigInt(prior.changeMinor)),
    replayed: true,
    effectsPending: false,
  };
}

async function finishEffects(documentId: string, previousStatus: string): Promise<boolean> {
  if (previousStatus === "posted") return false;
  try {
    await runPostDocumentEffects(documentId, previousStatus);
    return false;
  } catch (error) {
    // The sale is posted; its stock and automation effects stay queued in the
    // posting-effects outbox and are retried from the document's actions.
    console.error("register posting effects deferred", { documentId, error });
    return true;
  }
}

async function createRegisterDocument(input: {
  orgId: string;
  actorId: string;
  kind: "cash_sale" | "cash_refund";
  key: string;
  body: DocumentEditInput;
  subsidiaryId: string;
  requestBody: unknown;
}): Promise<{ status: "created" | "replayed"; id: string; documentNumber: string }> {
  try {
    const created = await createDocument({
      orgId: input.orgId,
      userId: input.actorId,
      kind: input.kind,
      key: input.key,
      body: input.body,
      subsidiaryId: input.subsidiaryId,
      requestBody: input.requestBody,
    });
    return { status: created.status, id: created.id, documentNumber: created.documentNumber };
  } catch (error) {
    if (error instanceof DocumentCreateConflict) {
      throw posRefusal(
        "This request key was already used for a different receipt.",
        "idempotency_conflict",
        409,
        "Start a new receipt; the earlier one is unchanged.",
      );
    }
    throw error;
  }
}

/** Ring up a sale: price, tender, create and post the native cash sale, and attribute it to the session. */
export async function completePosSale(
  input: PosSaleInput,
  authority: PosAuthority,
  pricing: PosPricingDeps,
): Promise<PosCompletion> {
  if (!isUuid(input.idempotencyKey)) {
    throw posRefusal(
      "The sale carries no valid request key.",
      "invalid_input",
      422,
      "Retry the sale from the register.",
    );
  }
  const outcome = await withOrgTransaction(input.orgId, async () => {
    await assertRegisterFeature(db, input.orgId);
    const session = await lockSession(
      db,
      input.orgId,
      input.sessionId,
      "share",
      input.allowedSubsidiaryIds,
    );
    const prior = await existingTransaction(input.orgId, input.idempotencyKey);
    if (prior)
      return {
        completion: replayOf(input.idempotencyKey, prior, "sale"),
        previousStatus: "posted",
      };
    assertSessionOpen(session);
    const register = await loadRegisterForUse(db, input.orgId, session.registerId, {
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    });
    const documentDate = await businessToday(input.orgId);
    const cart = await buildPosCart(
      db,
      input.orgId,
      register,
      {
        customerId: input.customerId,
        lines: input.lines,
        orderDiscount: input.orderDiscount,
        documentDate,
      },
      authority,
      pricing,
    );
    if (
      input.expectedTotal !== undefined &&
      input.expectedTotal !== null &&
      input.expectedTotal !== ""
    ) {
      let shown: bigint | null = null;
      try {
        shown = toUnits(input.expectedTotal);
      } catch {
        shown = null;
      }
      if (shown !== cart.totalUnits) {
        throw posRefusal(
          `The total is now ${cart.quote.total}, not ${input.expectedTotal}.`,
          "total_changed",
          409,
          "Review the updated total with the customer and take payment again.",
          { quote: cart.quote },
        );
      }
    }
    const planned = await planTenders(
      db,
      input.orgId,
      register,
      input.payments,
      cart.totalUnits,
      "sale",
    );
    const body: DocumentEditInput = {
      partyId: cart.quote.customerId,
      documentDate,
      currency: register.currency,
      subsidiaryId: register.subsidiaryId,
      locationId: register.locationId,
      memo: `Register ${register.code} · session ${session.sessionNumber}`,
      lines: cart.documentLines,
      custom: { tenders: planned.tenders },
    } as DocumentEditInput;
    const created = await createRegisterDocument({
      orgId: input.orgId,
      actorId: input.actorId,
      kind: "cash_sale",
      key: input.idempotencyKey,
      body,
      subsidiaryId: register.subsidiaryId,
      requestBody: {
        register: register.id,
        session: session.id,
        customerId: input.customerId,
        lines: input.lines,
        orderDiscount: input.orderDiscount ?? null,
        payments: input.payments,
      },
    });
    if (created.status === "replayed") {
      const raced = await existingTransaction(input.orgId, created.id);
      if (raced)
        return { completion: replayOf(created.id, raced, "sale"), previousStatus: "posted" };
    }
    const previousStatus = await submitAndPost(input.orgId, input.actorId, created.id, "sale");
    const inserted = await db.execute(
      sql`
      insert into pos_transactions
        (org_id, session_id, register_id, kind, document_id, total_minor, cash_applied_minor,
         cash_tendered_minor, change_minor, pricing, created_by)
      values (${input.orgId}, ${session.id}, ${register.id}, 'sale', ${created.id}, ${cart.totalUnits.toString()}::bigint,
        ${planned.cashAppliedUnits.toString()}::bigint, ${planned.cashTenderedUnits.toString()}::bigint,
        ${planned.changeUnits.toString()}::bigint,
        ${JSON.stringify({ lines: cart.evidence, orderDiscount: input.orderDiscount ?? null })}::jsonb, ${input.actorId})
      -- A same-key retry that raced this one already attributed the document; the existing row stands.
      on conflict (org_id, document_id) do nothing
      returning id`,
      "objects",
    );
    if (inserted.length !== 1) {
      const raced = await existingTransaction(input.orgId, created.id);
      if (!raced) throw new Error("register sale attribution was not recorded");
      return { completion: replayOf(created.id, raced, "sale"), previousStatus: "posted" };
    }
    return {
      completion: {
        documentId: created.id,
        documentNumber: created.documentNumber,
        kind: "sale" as const,
        total: cart.quote.total,
        change: fromUnits(planned.changeUnits),
        replayed: false,
        effectsPending: false,
      },
      previousStatus,
    };
  });
  const effectsPending = await finishEffects(outcome.completion.documentId, outcome.previousStatus);
  return { ...outcome.completion, effectsPending };
}

export interface PosRefundInput {
  orgId: string;
  actorId: string;
  sessionId: string;
  idempotencyKey: string;
  originalDocumentId: string;
  lines: Array<{ lineNumber: number; quantity: string }>;
  payments: PosPaymentInput[];
  reason: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

type OriginalLine = {
  id: string;
  line_number: number;
  item_id: string | null;
  stock_location_id: string | null;
  issue_movement_id: string | null;
  account_id: string;
  description: string | null;
  quantity: string | null;
  unit_price: string | null;
  amount: string;
  tax_amount: string;
  tax_overridden: boolean;
  tax_code_id: string | null;
  tax_group_id: string | null;
  location_id: string | null;
};

type RefundedLineTotals = { quantity: bigint; amount: bigint; taxAmount: bigint };

/** Posted refund quantity and values per original receipt line. */
async function refundedByLine(
  runner: SqlExecutor,
  orgId: string,
  originalDocumentId: string,
): Promise<Map<number, RefundedLineTotals>> {
  const rows = await runner.execute<{
    line_number: number;
    quantity: string;
    amount: string;
    tax_amount: string;
  }>(
    sql`
    select (entry.value->>'lineNumber')::int as line_number,
           sum((entry.value->>'quantity')::numeric)::text as quantity,
           sum(refund_line.amount)::text as amount,
           sum(refund_line.tax_amount)::text as tax_amount
      from pos_transactions t
      join documents d on d.org_id = t.org_id and d.id = t.document_id and d.status = 'posted' -- Live entries only: voided refunds no longer reduce the refundable balance
      cross join lateral jsonb_array_elements(coalesce(t.pricing->'refundLines', '[]'::jsonb)) with ordinality entry(value, refund_ordinality)
      join document_lines refund_line on refund_line.org_id = t.org_id and refund_line.document_id = t.document_id
                                    and refund_line.line_number = entry.refund_ordinality
     where t.org_id = ${orgId} and t.refund_of_document_id = ${originalDocumentId} and t.kind = 'refund'
     group by 1`,
    "objects",
  );
  return new Map(
    rows.map((row) => [
      Number(row.line_number),
      {
        quantity: toUnits(row.quantity),
        amount: toUnits(row.amount),
        taxAmount: toUnits(row.tax_amount),
      },
    ]),
  );
}

/**
 * Refund items from a prior receipt: a native cash refund at the original
 * prices and the original tax, linked to the sale it returns, attributed to
 * the session that pays it out. The original receipt is locked for the
 * transaction, so two refunds of the same receipt cannot both return the
 * same units.
 */
export async function completePosRefund(input: PosRefundInput): Promise<PosCompletion> {
  if (!isUuid(input.idempotencyKey)) {
    throw posRefusal(
      "The refund carries no valid request key.",
      "invalid_input",
      422,
      "Retry the refund from the register.",
    );
  }
  if (!isUuid(input.originalDocumentId)) {
    throw posRefusal(
      "Choose the receipt being refunded.",
      "refund_source_invalid",
      404,
      "Look the receipt up by its number.",
    );
  }
  const reason = input.reason?.trim() || null;
  if (reason && reason.length > 500) {
    throw posRefusal(
      "The refund reason is longer than 500 characters.",
      "invalid_input",
      422,
      "Shorten the reason to 500 characters.",
    );
  }
  const outcome = await withOrgTransaction(input.orgId, async () => {
    await assertRegisterFeature(db, input.orgId);
    const session = await lockSession(
      db,
      input.orgId,
      input.sessionId,
      "share",
      input.allowedSubsidiaryIds,
    );
    const prior = await existingTransaction(input.orgId, input.idempotencyKey);
    if (prior)
      return {
        completion: replayOf(input.idempotencyKey, prior, "refund"),
        previousStatus: "posted",
      };
    assertSessionOpen(session);
    const register = await loadRegisterForUse(db, input.orgId, session.registerId, {
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    });
    const original = (
      await db.execute<{
        id: string;
        kind: string;
        status: string;
        subsidiary_id: string | null;
        party_id: string | null;
        document_number: string;
        currency: string;
      }>(
        sql`
      select id, kind, status, subsidiary_id, party_id, document_number, currency from documents
       where org_id = ${input.orgId} and id = ${input.originalDocumentId}
       for update`,
        "objects",
      )
    )[0];
    if (
      !original ||
      original.kind !== "cash_sale" ||
      !subsidiaryScopeAllows(input.allowedSubsidiaryIds, original.subsidiary_id)
    ) {
      throw posRefusal(
        "That receipt is not a cash sale in this organization.",
        "refund_source_invalid",
        404,
        "Look the receipt up by its number.",
      );
    }
    if (original.status !== "posted") {
      throw posRefusal(
        `Receipt ${original.document_number} is ${original.status}; only a posted sale can be refunded.`,
        "refund_source_invalid",
        422,
        "Open the receipt in Cash Sales to review it.",
      );
    }
    if (original.subsidiary_id !== register.subsidiaryId) {
      throw posRefusal(
        `Receipt ${original.document_number} belongs to another legal entity than this register.`,
        "refund_source_invalid",
        422,
        "Refund it at a register of the legal entity that made the sale.",
      );
    }
    if (original.currency !== register.currency) {
      throw posRefusal(
        `Receipt ${original.document_number} is in ${original.currency}; this register takes ${register.currency}.`,
        "refund_source_invalid",
        422,
        "Refund it from Cash Sales in the back office.",
      );
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw posRefusal(
        "Choose at least one line to refund.",
        "invalid_input",
        422,
        "Pick the items the customer is returning.",
      );
    }
    // Each stocked line's own issue movement is the return source: the
    // refund restocks the units at the cost they left at, into the warehouse
    // they left from.
    const originalLines = new Map(
      (
        await db.execute<OriginalLine>(
          sql`
      select l.id, l.line_number, l.item_id, l.stock_location_id, l.account_id, l.description, l.quantity::text as quantity,
             l.unit_price::text as unit_price, l.amount::text as amount, l.tax_amount::text as tax_amount, l.tax_overridden,
             l.tax_code_id, l.tax_group_id, l.location_id,
             (select m.id from inventory_movements m
               where m.org_id = l.org_id and m.document_line_id = l.id and m.kind = 'issue' and m.status = 'posted'
                 and not exists (select 1 from inventory_movements r where r.org_id = m.org_id and r.reverses_movement_id = m.id)
               order by m.id limit 1) as issue_movement_id
        from document_lines l where l.org_id = ${input.orgId} and l.document_id = ${original.id}
       order by l.line_number`,
          "objects",
        )
      ).map((row) => [Number(row.line_number), row]),
    );
    const already = await refundedByLine(db, input.orgId, original.id);
    const seen = new Set<number>();
    const refundLines: Array<{ lineNumber: number; quantity: string }> = [];
    const documentLines: DocumentLineInput[] = input.lines.map((requested, index) => {
      const label = `Refund line ${index + 1}`;
      const source = originalLines.get(Number(requested.lineNumber));
      if (!source || seen.has(source.line_number)) {
        throw posRefusal(
          `${label} does not name a line of receipt ${original.document_number}.`,
          "refund_source_invalid",
          422,
          "Pick the returned items from the receipt.",
        );
      }
      seen.add(source.line_number);
      const quantity = parsePosQuantity(requested.quantity, label);
      const originalQuantity = source.quantity ?? "1";
      const previouslyRefunded = already.get(source.line_number) ?? {
        quantity: 0n,
        amount: 0n,
        taxAmount: 0n,
      };
      const remaining = toUnits(originalQuantity) - previouslyRefunded.quantity;
      if (toUnits(quantity) > remaining) {
        throw posRefusal(
          `${label} returns ${quantity} of ${source.description ?? "the item"}, but only ${fromUnits(remaining > 0n ? remaining : 0n)} remain unreturned.`,
          "refund_exceeds_sale",
          422,
          "Return at most the quantity still unreturned on the receipt.",
        );
      }
      const remainingQuantity = fromUnits(remaining);
      const amountUnits = proratedReturnUnits(
        toUnits(source.amount) - previouslyRefunded.amount,
        remainingQuantity,
        quantity,
        register.currencyDecimals,
      );
      const taxUnits = proratedReturnUnits(
        toUnits(source.tax_amount) - previouslyRefunded.taxAmount,
        remainingQuantity,
        quantity,
        register.currencyDecimals,
      );
      refundLines.push({ lineNumber: source.line_number, quantity });
      const taxed = Boolean(source.tax_code_id || source.tax_group_id);
      return {
        itemId: source.item_id,
        description: source.description,
        quantity,
        unitPrice: source.unit_price,
        amount: fromUnits(amountUnits),
        accountId: source.account_id,
        taxCodeId: source.tax_code_id,
        taxGroupId: source.tax_group_id,
        // The refund carries the sale's own tax, never a re-rating at today's rates.
        ...(taxed ? { taxOverridden: true, taxAmount: fromUnits(taxUnits) } : {}),
        locationId: source.location_id,
        ...(source.issue_movement_id && source.stock_location_id
          ? {
              stockLocationId: source.stock_location_id,
              inventoryReturnSource: { movementId: source.issue_movement_id },
            }
          : {}),
      };
    });
    const documentDate = await businessToday(input.orgId);
    const totals = await precomputeDocumentTotalsForCreate(input.orgId, "cash_refund", {
      lines: documentLines,
      currency: register.currency,
      documentDate,
      partyId: original.party_id,
      subsidiaryId: register.subsidiaryId,
    });
    if (!totals) throw new Error("refund totals did not resolve");
    const totalUnits = toUnits(totals.total);
    const planned = await planTenders(
      db,
      input.orgId,
      register,
      input.payments,
      totalUnits,
      "refund",
    );
    const body: DocumentEditInput = {
      partyId: original.party_id,
      documentDate,
      currency: register.currency,
      subsidiaryId: register.subsidiaryId,
      locationId: register.locationId,
      referenceNumber: original.document_number,
      memo: `Refund of ${original.document_number} at register ${register.code}${reason ? ` · ${reason}` : ""}`,
      lines: documentLines,
      custom: { tenders: planned.tenders },
    } as DocumentEditInput;
    const created = await createRegisterDocument({
      orgId: input.orgId,
      actorId: input.actorId,
      kind: "cash_refund",
      key: input.idempotencyKey,
      body,
      subsidiaryId: register.subsidiaryId,
      requestBody: {
        register: register.id,
        session: session.id,
        original: original.id,
        lines: input.lines,
        payments: input.payments,
        reason,
      },
    });
    if (created.status === "replayed") {
      const raced = await existingTransaction(input.orgId, created.id);
      if (raced)
        return { completion: replayOf(created.id, raced, "refund"), previousStatus: "posted" };
    }
    const previousStatus = await submitAndPost(input.orgId, input.actorId, created.id, "refund");
    await db.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
      values (${input.orgId}, ${original.id}, ${created.id}, 'created_from', ${input.actorId}, ${input.actorId})
      -- The refund is linked to its sale once; a replay observes the existing edge.
      on conflict (org_id, from_document_id, to_document_id, link_type) do nothing`);
    // The cash columns describe cash handed over at a sale and its change; a
    // refund records none (the storage rule holds them at zero), and the cash
    // it pays out is read from its own tender rows like every other tender.
    const inserted = await db.execute(
      sql`
      insert into pos_transactions
        (org_id, session_id, register_id, kind, document_id, refund_of_document_id, total_minor,
         pricing, created_by)
      values (${input.orgId}, ${session.id}, ${register.id}, 'refund', ${created.id}, ${original.id},
        ${totalUnits.toString()}::bigint,
        ${JSON.stringify({ refundLines, reason })}::jsonb, ${input.actorId})
      -- A same-key retry that raced this one already attributed the document; the existing row stands.
      on conflict (org_id, document_id) do nothing
      returning id`,
      "objects",
    );
    if (inserted.length !== 1) {
      const raced = await existingTransaction(input.orgId, created.id);
      if (!raced) throw new Error("register refund attribution was not recorded");
      return { completion: replayOf(created.id, raced, "refund"), previousStatus: "posted" };
    }
    return {
      completion: {
        documentId: created.id,
        documentNumber: created.documentNumber,
        kind: "refund" as const,
        total: totals.total,
        change: "0.0000",
        replayed: false,
        effectsPending: false,
      },
      previousStatus,
    };
  });
  const effectsPending = await finishEffects(outcome.completion.documentId, outcome.previousStatus);
  return { ...outcome.completion, effectsPending };
}

export interface PosReceipt {
  documentId: string;
  kind: string;
  documentNumber: string;
  status: string;
  documentDate: string;
  currency: string;
  customerName: string | null;
  subtotal: string;
  tax: string;
  total: string;
  register: {
    code: string;
    name: string;
    receiptHeader: string | null;
    receiptFooter: string | null;
  } | null;
  session: { id: string; sessionNumber: number } | null;
  cashierName: string | null;
  cashTendered: string;
  change: string;
  refundOf: { documentId: string; documentNumber: string } | null;
  lines: Array<{
    lineNumber: number;
    description: string | null;
    quantity: string | null;
    unitPrice: string | null;
    amount: string;
    tax: string;
    listUnitPrice: string | null;
    discount: string;
    refundedQuantity: string;
    refundableQuantity: string;
  }>;
  tenders: Array<{ kind: string; methodLabel: string; amount: string; reference: string | null }>;
}

/** A register receipt: the native document with its register attribution, for display, print and refunds. */
export async function readPosReceipt(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<PosReceipt> {
  const doc = isUuid(documentId)
    ? (
        await runner.execute<{
          id: string;
          kind: string;
          document_number: string;
          status: string;
          document_date: string;
          currency: string;
          subsidiary_id: string | null;
          customer_name: string | null;
          subtotal: string;
          tax_total: string;
          total: string;
        }>(
          sql`
        select d.id, d.kind, d.document_number, d.status, d.document_date::text as document_date, d.currency,
               d.subsidiary_id, p.display_name as customer_name, d.subtotal::text as subtotal,
               d.tax_total::text as tax_total, d.total::text as total
          from documents d
          left join parties p on p.org_id = d.org_id and p.id = d.party_id
         where d.org_id = ${orgId} and d.id = ${documentId} and d.kind in ('cash_sale', 'cash_refund')`,
          "objects",
        )
      )[0]
    : undefined;
  if (!doc || !subsidiaryScopeAllows(allowedSubsidiaryIds, doc.subsidiary_id)) {
    throw posRefusal(
      "That receipt does not exist.",
      "refund_source_invalid",
      404,
      "Look the receipt up by its number.",
    );
  }
  const attribution = (
    await runner.execute<{
      session_id: string;
      session_number: number;
      code: string;
      name: string;
      receipt_header: string | null;
      receipt_footer: string | null;
      cashier: string | null;
      cash_tendered_minor: string;
      change_minor: string;
      pricing: Record<string, unknown>;
      refund_of: string | null;
      refund_of_number: string | null;
    }>(
      sql`
    select t.session_id, s.session_number, r.code, r.name, r.receipt_header, r.receipt_footer, u.name as cashier,
           t.cash_tendered_minor::text as cash_tendered_minor, t.change_minor::text as change_minor, t.pricing,
           t.refund_of_document_id as refund_of, o.document_number as refund_of_number
      from pos_transactions t
      join pos_sessions s on s.org_id = t.org_id and s.id = t.session_id
      join pos_registers r on r.org_id = t.org_id and r.id = t.register_id
      left join users u on u.org_id = t.org_id and u.id = t.created_by
      left join documents o on o.org_id = t.org_id and o.id = t.refund_of_document_id
     where t.org_id = ${orgId} and t.document_id = ${doc.id}`,
      "objects",
    )
  )[0];
  const lines = await runner.execute<{
    line_number: number;
    description: string | null;
    quantity: string | null;
    unit_price: string | null;
    amount: string;
    tax_amount: string;
  }>(
    sql`
    select line_number, description, quantity::text as quantity, unit_price::text as unit_price,
           amount::text as amount, tax_amount::text as tax_amount
      from document_lines where org_id = ${orgId} and document_id = ${doc.id} order by line_number`,
    "objects",
  );
  const tenders = await runner.execute<{
    kind: string;
    method_label: string;
    amount_minor: string;
    reference: string | null;
  }>(
    sql`
    select kind, method_label, amount_minor::text as amount_minor, reference
      from document_tenders where org_id = ${orgId} and document_id = ${doc.id} order by position`,
    "objects",
  );
  const refunded =
    doc.kind === "cash_sale"
      ? await refundedByLine(runner, orgId, doc.id)
      : new Map<number, RefundedLineTotals>();
  const evidence = new Map<
    number,
    { listUnitPrice: string | null; lineDiscount: string; orderDiscount: string }
  >();
  const pricedLines =
    attribution?.pricing && Array.isArray((attribution.pricing as { lines?: unknown }).lines)
      ? (
          attribution.pricing as {
            lines: Array<{
              lineNumber: number;
              listUnitPrice: string | null;
              lineDiscount: string;
              orderDiscount: string;
            }>;
          }
        ).lines
      : [];
  for (const entry of pricedLines) evidence.set(Number(entry.lineNumber), entry);
  return {
    documentId: doc.id,
    kind: doc.kind,
    documentNumber: doc.document_number,
    status: doc.status,
    documentDate: doc.document_date,
    currency: doc.currency,
    customerName: doc.customer_name,
    subtotal: doc.subtotal,
    tax: doc.tax_total,
    total: doc.total,
    register: attribution
      ? {
          code: attribution.code,
          name: attribution.name,
          receiptHeader: attribution.receipt_header,
          receiptFooter: attribution.receipt_footer,
        }
      : null,
    session: attribution
      ? { id: attribution.session_id, sessionNumber: Number(attribution.session_number) }
      : null,
    cashierName: attribution?.cashier ?? null,
    cashTendered: fromUnits(BigInt(attribution?.cash_tendered_minor ?? "0")),
    change: fromUnits(BigInt(attribution?.change_minor ?? "0")),
    refundOf: attribution?.refund_of
      ? { documentId: attribution.refund_of, documentNumber: attribution.refund_of_number ?? "" }
      : null,
    lines: lines.map((line) => {
      const priced = evidence.get(Number(line.line_number));
      const refundedUnits = refunded.get(Number(line.line_number))?.quantity ?? 0n;
      const originalUnits = toUnits(line.quantity ?? "1");
      const discountUnits = priced
        ? toUnits(priced.lineDiscount) + toUnits(priced.orderDiscount)
        : 0n;
      return {
        lineNumber: Number(line.line_number),
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unit_price,
        amount: line.amount,
        tax: line.tax_amount,
        listUnitPrice: priced?.listUnitPrice ?? null,
        discount: fromUnits(discountUnits),
        refundedQuantity: fromUnits(refundedUnits),
        refundableQuantity: fromUnits(
          originalUnits - refundedUnits > 0n ? originalUnits - refundedUnits : 0n,
        ),
      };
    }),
    tenders: tenders.map((tender) => ({
      kind: tender.kind,
      methodLabel: tender.method_label,
      amount: fromUnits(BigInt(tender.amount_minor)),
      reference: tender.reference,
    })),
  };
}

/** Find a cash sale receipt by its document number, for the refund lookup. */
export async function findPosReceiptByNumber(
  runner: SqlExecutor,
  orgId: string,
  documentNumber: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<string | null> {
  const number = documentNumber.trim();
  if (!number || number.length > 80) return null;
  const rows = await runner.execute<{ id: string; subsidiary_id: string | null }>(
    sql`
    select id, subsidiary_id from documents
     where org_id = ${orgId} and kind = 'cash_sale' and document_number = ${number}
     order by created_at desc limit 5`,
    "objects",
  );
  return (
    rows.find((row) => subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id))?.id ?? null
  );
}

/** Recent receipts rung in a session, newest first. */
export async function listSessionReceipts(
  runner: SqlExecutor,
  orgId: string,
  session: Pick<PosSessionRow, "id">,
): Promise<
  Array<{
    documentId: string;
    documentNumber: string;
    kind: string;
    totalMinor: string;
    createdAt: string;
    customerName: string | null;
  }>
> {
  return await runner.execute<{
    documentId: string;
    documentNumber: string;
    kind: string;
    totalMinor: string;
    createdAt: string;
    customerName: string | null;
  }>(
    sql`
    select t.document_id as "documentId", d.document_number as "documentNumber", t.kind,
           t.total_minor::text as "totalMinor", t.created_at::text as "createdAt", p.display_name as "customerName"
      from pos_transactions t
      join documents d on d.org_id = t.org_id and d.id = t.document_id
      left join parties p on p.org_id = d.org_id and p.id = d.party_id
     where t.org_id = ${orgId} and t.session_id = ${session.id}
     order by t.created_at desc limit 100`,
    "objects",
  );
}
