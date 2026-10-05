import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  ConversionError,
  CONVERSION_TARGETS,
  convertOrder,
  createOrderDraft,
  draftDocumentId,
  OrderDraftConflictError,
  OrderDraftError,
  type OrderKind,
} from "../order-cycle";
import { isFeatureEnabled } from "../features";
import { isUuid } from "../list-params";
import { isDocumentRevisionToken } from "@openbooks/engine/src/records/revision.ts";
import { add, compareDecimal, mulPercent, neg } from "@openbooks/engine/money";
import {
  issueSalesOrder,
  SalesOrderIssueError,
} from "@openbooks/engine/sales/orders";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";
import {
  applyOrderEdit,
  OrderEditError,
  type OrderPatchBody,
} from "../order-draft-edit";
import { orderEditServices } from "../../app/api/_order/handlers";
import {
  exactOrderQuantity,
  exactOrderUnitPrice,
  type OrderLineInput,
} from "../../app/api/_order/line-selection";
import { decimalNullRefusal } from "../payroll-decimal-refusal";
import {
  findDocumentByExternalRef,
  resolveExternalRefPair,
} from "../external-ref";
import {
  upsertApplicationCustomer,
  type CustomerUpsertInput,
} from "./customer-upsert";

export const ORDER_TYPE_KIND = {
  quotes: "quote",
  "sales-orders": "sales_order",
  "purchase-orders": "purchase_order",
} as const;

export type OrderTypeKey = keyof typeof ORDER_TYPE_KIND;

function orderWritePermission(kind: OrderKind): string {
  return kind === "purchase_order" ? "ap.create" : "ar.create";
}

function conversionFailure(error: unknown): never {
  if (error instanceof ConversionError) {
    const code = error.status === 404
      ? "not_found"
      : error.status === 409
        ? "conflict"
        : error.status === 403
          ? "forbidden"
          : "invalid_input";
    throw new ApplicationError(code, error.message, error.status, {
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
  }
  throw error;
}

/** Empty commercial-order draft — same writer as the New Order drawer. */
export async function createApplicationOrder(
  context: ApplicationContext,
  input: { kind: OrderKind; idempotencyKey: string; subsidiaryId?: string | null },
): Promise<{ replayed: boolean; result: { id: string; documentNumber: string } }> {
  assertApplicationPermission(context, orderWritePermission(input.kind));
  if (!(await isFeatureEnabled(context.authz.user.orgId, "orders"))) throw notFound("order");
  // The draft must carry a subsidiary the caller can read back: a NULL
  // subsidiary is invisible to a restricted key's GET/list, so the 201 would
  // name a document no read can observe. An explicit subsidiary is asserted;
  // an omitted one is derived when the key sees exactly one subsidiary and
  // otherwise refused closed, the same rule record creates enforce.
  const requested = input.subsidiaryId ?? null;
  if (requested !== null && !isUuid(requested)) {
    throw invalidInput("subsidiaryId must be a UUID");
  }
  let subsidiaryId = requested;
  if (subsidiaryId === null) {
    const allowed = context.authz.allowedSubsidiaryIds;
    if (allowed !== null && allowed.size === 1) {
      subsidiaryId = [...allowed][0]!;
    }
  }
  assertSubsidiaryAccess(context, subsidiaryId);
  const outcome = await executeIdempotent({
    context,
    operation: "order.create",
    idempotencyKey: input.idempotencyKey,
    request: { kind: input.kind, subsidiaryId },
    execute: async () => {
      try {
        const draft = await createOrderDraft(context.authz.user.orgId, context.authz.user.id, input.kind, input.idempotencyKey, subsidiaryId);
        return { id: draft.id, documentNumber: draft.document_number };
      } catch (error) {
        if (error instanceof OrderDraftConflictError) {
          throw conflict(error.message);
        }
        if (error instanceof OrderDraftError) {
          throw invalidInput(error.message);
        }
        if (error instanceof Error && error.message === "Orders feature is disabled") {
          throw notFound("order");
        }
        throw error;
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

/** Convert an issued order — same writer as the order-cycle convert action. */
export async function convertApplicationOrder(
  context: ApplicationContext,
  input: {
    documentId: string;
    targetKind: string;
    expectedUpdatedAt?: string;
    creditOverrideReason?: string;
    idempotencyKey: string;
    /** The route's own order kind: the source must be this kind, never a
     * sibling kind reached by id. */
    expectedKind?: OrderKind;
  },
): Promise<{ replayed: boolean; result: { id: string; documentNumber: string; kind: string } }> {
  const source = await sourceOrder(context.authz.user.orgId, input.documentId);
  // The route converts one order kind: a quote id on the purchase-orders
  // route (or any sibling-kind id) is not this route's order — refuse it as
  // not found rather than converting across kinds.
  if (input.expectedKind !== undefined && source.kind !== input.expectedKind) {
    throw notFound("order");
  }
  assertSubsidiaryAccess(context, source.subsidiaryId);
  const sourceKind = source.kind;
  assertApplicationPermission(context, orderWritePermission(sourceKind));
  if (!(await isFeatureEnabled(context.authz.user.orgId, "orders"))) throw notFound("order");
  const allowed = CONVERSION_TARGETS[sourceKind] ?? [];
  if (!allowed.some((target) => target.kind === input.targetKind)) {
    throw invalidInput(`Cannot convert a ${sourceKind} into ${input.targetKind}`);
  }
  // The revision fence is required, not optional: converting from a stale
  // view must never create the downstream document. The UI route already
  // refuses a missing token with the same 409; v1 answers invalid_input
  // here before any idempotency claim or write.
  if (!isDocumentRevisionToken(input.expectedUpdatedAt)) {
    throw invalidInput("expectedUpdatedAt must be the document revision token from GET");
  }
  const outcome = await executeIdempotent({
    context,
    operation: "order.convert",
    idempotencyKey: input.idempotencyKey,
    request: {
      documentId: input.documentId,
      targetKind: input.targetKind,
      expectedUpdatedAt: input.expectedUpdatedAt,
      creditOverrideReason: input.creditOverrideReason ?? null,
    },
    execute: async () => {
      try {
        return await convertOrder(
          context.authz.user.orgId,
          context.authz.user.id,
          input.documentId,
          input.targetKind,
          {
            creditOverrideReason: input.creditOverrideReason,
            expectedUpdatedAt: input.expectedUpdatedAt,
          },
        );
      } catch (error) {
        conversionFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

async function sourceOrder(orgId: string, documentId: string): Promise<{ kind: OrderKind; subsidiaryId: string | null }> {
  const row = (await db.execute<{ kind: string; subsidiary_id: string | null }>(sql`
    select kind, subsidiary_id from documents
     where id = ${documentId} and org_id = ${orgId}
       and kind in ('quote', 'sales_order', 'purchase_order')
  `)).rows[0];
  if (!row) throw notFound("order");
  return { kind: row.kind as OrderKind, subsidiaryId: row.subsidiary_id };
}

/** The drawer config for the v1 sales-order surface: same writer, same rules. */
const SALES_ORDER_CFG = { kind: "sales_order", readPerm: "ar.read", createPerm: "ar.create" } as const;

function orderEditFailure(error: unknown): never {
  if (error instanceof OrderEditError) {
    const body = (error.body ?? {}) as { error?: unknown; existingId?: unknown };
    const message = typeof body.error === "string" ? body.error : error.message;
    const details =
      typeof body.existingId === "string" ? { existingId: body.existingId } : undefined;
    if (error.status === 404) throw notFound("order");
    if (error.status === 409) throw conflict(message, details);
    throw invalidInput(message, details);
  }
  throw error;
}

async function applyOrderEditAsV1(
  context: ApplicationContext,
  documentId: string,
  patch: OrderPatchBody,
): Promise<{ doc: Record<string, unknown>; lines: unknown[] }> {
  let response: Response;
  try {
    response = await applyOrderEdit(
      {
        orgId: context.authz.user.orgId,
        userId: context.authz.user.id,
        user: context.authz.user,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        permissions: context.authz.permissions,
        services: orderEditServices,
      },
      SALES_ORDER_CFG,
      documentId,
      patch,
    );
  } catch (error) {
    orderEditFailure(error);
  }
  if (response.status === 404) throw notFound("order");
  if (response.status !== 200) {
    throw new ApplicationError("internal_error", "the order update did not complete", 500);
  }
  const payload = (await response.json()) as { doc: Record<string, unknown>; lines: unknown[] };
  if (!payload.doc || !isDocumentRevisionToken(payload.doc.updated_at)) {
    throw new ApplicationError("internal_error", "the order update did not return a revision", 500);
  }
  return payload;
}

export interface V1OrderLineInput {
  itemId?: string;
  itemCode?: string;
  accountId?: string;
  description?: string;
  quantity?: unknown;
  unit?: string;
  unitPrice?: unknown;
  discountPercent?: unknown;
  discountAmount?: unknown;
  taxCodeId?: string;
  taxGroupId?: string;
  stockLocationId?: string;
  departmentId?: string;
  projectId?: string;
}

export interface V1ShippingLineInput {
  accountId: string;
  description?: string;
  amount: unknown;
  taxCodeId?: string;
  taxGroupId?: string;
}

export interface FullOrderCustomerInput {
  id?: string;
  externalRef?: string;
  externalSource?: string;
  email?: string;
  name?: string;
  kind?: string;
  phone?: string | null;
  address?: CustomerUpsertInput["address"];
}

export interface FullOrderInput {
  kind: OrderKind;
  idempotencyKey: string;
  subsidiaryId?: string | null;
  customer: FullOrderCustomerInput;
  documentDate?: string;
  dueDate?: string | null;
  currency?: string;
  memo?: string | null;
  lines?: V1OrderLineInput[];
  shippingLines?: V1ShippingLineInput[];
  externalRef?: string | null;
  externalSource?: string | null;
}

/** Refuse an external pair already claimed by another document, naming the winner. */
async function assertNoExternalDuplicate(
  orgId: string,
  externalRef: unknown,
  externalSource: unknown,
  excludeId?: string,
): Promise<void> {
  const pair = resolveExternalRefPair({ externalRef, externalSource });
  if (pair.action === "refuse") throw invalidInput(pair.message);
  if (pair.action !== "set") return;
  const winner = await findDocumentByExternalRef(db, orgId, pair.ref, pair.source, excludeId);
  if (winner) {
    throw conflict(
      `externalRef "${pair.ref}" from "${pair.source}" already exists on document ${winner.documentNumber} — send a new reference or update the existing document`,
      { existingId: winner.id },
    );
  }
}

async function resolveLineItem(
  orgId: string,
  lineNumber: number,
  itemId: unknown,
  itemCode: unknown,
): Promise<string | null> {
  if (itemId !== undefined && itemCode !== undefined) {
    throw invalidInput(`Order line ${lineNumber}: send either itemId or itemCode, not both`);
  }
  if (itemId !== undefined) {
    if (typeof itemId !== "string" || !isUuid(itemId)) {
      throw invalidInput(`Order line ${lineNumber}: itemId must be a UUID`);
    }
    const row = (await db.execute<{ id: string }>(sql`
      select id from items where id = ${itemId} and org_id = ${orgId}`)).rows[0];
    if (!row) {
      throw invalidInput(
        `Order line ${lineNumber}: item "${itemId}" not found in this organization — check the id or create the item first`,
      );
    }
    return row.id;
  }
  if (itemCode !== undefined) {
    if (typeof itemCode !== "string" || itemCode.trim() === "") {
      throw invalidInput(`Order line ${lineNumber}: itemCode must not be blank`);
    }
    const row = (await db.execute<{ id: string }>(sql`
      select id from items where code = ${itemCode.trim()} and org_id = ${orgId}`)).rows[0];
    if (!row) {
      throw invalidInput(
        `Order line ${lineNumber}: item code "${itemCode.trim()}" not found in this organization — check the code or create the item first`,
      );
    }
    return row.id;
  }
  return null;
}

/**
 * Map one v1 line onto the drawer's line shape. Quantities and prices ride
 * as validated decimal strings; a discount is applied to the unit price up
 * front, so the writer below totals exactly what the drawer would total for
 * the same net price — no second pricing path.
 */
async function mapV1OrderLine(
  orgId: string,
  lineNumber: number,
  line: V1OrderLineInput,
): Promise<OrderLineInput> {
  const quantity = exactOrderQuantity(line.quantity ?? "1");
  if (quantity === "invalid") {
    throw invalidInput(
      decimalNullRefusal(`lines[${lineNumber - 1}].quantity`, "a quantity", line.quantity ?? "1", 8),
    );
  }
  const unitPrice = exactOrderUnitPrice(line.unitPrice ?? "0");
  if (unitPrice === "invalid") {
    throw invalidInput(
      decimalNullRefusal(`lines[${lineNumber - 1}].unitPrice`, "an amount", line.unitPrice ?? "0", 8),
    );
  }
  let net = unitPrice;
  if (line.discountPercent !== undefined && line.discountAmount !== undefined) {
    throw invalidInput(
      `Order line ${lineNumber}: send either discountPercent or discountAmount, not both`,
    );
  }
  if (line.discountPercent !== undefined) {
    const percent = line.discountPercent;
    if (
      typeof percent !== "string" ||
      !/^([+-]?)(\d+(\.\d*)?|\.\d+)$/.test(percent.trim()) ||
      compareDecimal(percent.trim(), "0") < 0 ||
      compareDecimal(percent.trim(), "100") > 0
    ) {
      throw invalidInput(
        decimalNullRefusal(`lines[${lineNumber - 1}].discountPercent`, "a percent from 0 to 100", percent, 18),
      );
    }
    // Discounts are money: the ledger keeps four decimals, and the order
    // writer below totals in the same domain. A price finer than that has
    // no exact discount here, so refuse naming the bound instead of rounding
    // silently or dying on the writer's arithmetic.
    try {
      net = add(net, neg(mulPercent(net, percent.trim(), 4)));
    } catch {
      throw invalidInput(
        `Order line ${lineNumber}: discounts apply at ledger precision (four decimals) — round the unit price to four decimals or send the net unit price instead`,
      );
    }
  }
  if (line.discountAmount !== undefined) {
    const discount = exactOrderUnitPrice(line.discountAmount);
    if (discount === "invalid") {
      throw invalidInput(
        decimalNullRefusal(`lines[${lineNumber - 1}].discountAmount`, "an amount", line.discountAmount, 8),
      );
    }
    try {
      net = add(net, neg(discount));
    } catch {
      throw invalidInput(
        `Order line ${lineNumber}: discounts apply at ledger precision (four decimals) — round the unit price to four decimals or send the net unit price instead`,
      );
    }
  }
  // Scale-safe: the net can carry the line's full eight decimals, past the
  // ledger helpers' four-decimal domain.
  if (compareDecimal(net, "0") < 0) {
    throw invalidInput(
      `Order line ${lineNumber}: the discount exceeds the unit price — reduce the discount or correct the price`,
    );
  }
  return {
    itemId: await resolveLineItem(orgId, lineNumber, line.itemId, line.itemCode),
    accountId: line.accountId ?? null,
    description: line.description ?? null,
    quantity,
    unit: line.unit ?? null,
    unitPrice: net,
    taxCodeId: line.taxCodeId ?? null,
    taxGroupId: line.taxGroupId ?? null,
    departmentId: line.departmentId ?? null,
    projectId: line.projectId ?? null,
    stockLocationId: line.stockLocationId ?? null,
  };
}

async function mapV1OrderLines(
  orgId: string,
  lines: V1OrderLineInput[] | undefined,
  shippingLines: V1ShippingLineInput[] | undefined,
): Promise<OrderLineInput[]> {
  if (lines !== undefined && !Array.isArray(lines)) {
    throw invalidInput("lines must be an array");
  }
  if (shippingLines !== undefined && !Array.isArray(shippingLines)) {
    throw invalidInput("shippingLines must be an array");
  }
  const mapped: OrderLineInput[] = [];
  for (let index = 0; index < (lines ?? []).length; index++) {
    const line = lines![index]!;
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw invalidInput(`Order line ${index + 1} is invalid`);
    }
    mapped.push(await mapV1OrderLine(orgId, index + 1, line));
  }
  for (let index = 0; index < (shippingLines ?? []).length; index++) {
    const shipping = shippingLines![index]!;
    if (!shipping || typeof shipping !== "object" || Array.isArray(shipping)) {
      throw invalidInput(`shippingLines[${index}] is invalid`);
    }
    const amount = exactOrderUnitPrice(shipping.amount);
    if (amount === "invalid") {
      throw invalidInput(
        decimalNullRefusal(`shippingLines[${index}].amount`, "an amount", shipping.amount, 8),
      );
    }
    mapped.push({
      itemId: null,
      accountId: shipping.accountId ?? null,
      description: shipping.description ?? null,
      quantity: "1",
      unit: null,
      unitPrice: amount,
      taxCodeId: shipping.taxCodeId ?? null,
      taxGroupId: shipping.taxGroupId ?? null,
    });
  }
  return mapped;
}

async function resolveFullOrderCustomer(
  context: ApplicationContext,
  customer: FullOrderCustomerInput,
): Promise<string> {
  const orgId = context.authz.user.orgId;
  if (!customer || typeof customer !== "object") {
    throw invalidInput("customer is required — send customer.id or match fields");
  }
  if (customer.id !== undefined) {
    const rest = ["externalRef", "externalSource", "email", "name", "kind", "phone", "address"] as const;
    if (rest.some((key) => customer[key] !== undefined)) {
      throw invalidInput("send either customer.id or customer match fields, not both");
    }
    if (!isUuid(customer.id)) throw invalidInput("customer.id must be a UUID");
    const row = (await db.execute<{ id: string }>(sql`
      select id from parties where id = ${customer.id} and org_id = ${orgId}`)).rows[0];
    // A write that matches zero rows is a failure, not a success: the save
    // below would otherwise bind a stranger's id or fail on the FK as a 500.
    if (!row) throw invalidInput(`customer "${customer.id}" not found in this organization`);
    return row.id;
  }
  // Match-or-create: establishing the customer role can mint a party, so it
  // needs the manage grant; pointing at a known id above needs none.
  const { id } = await upsertApplicationCustomer(context, {
    externalRef: customer.externalRef,
    externalSource: customer.externalSource,
    email: customer.email,
    name: customer.name,
    kind: customer.kind,
    phone: customer.phone,
    address: customer.address,
  });
  return id;
}

/**
 * Full sales-order create: header, customer, lines, shipping and the external
 * reference land through the drawer's writer (applyOrderEdit) after an empty
 * draft is minted by the drawer's factory — the same two calls the UI makes,
 * never a second writer.
 */
export async function createFullApplicationOrder(
  context: ApplicationContext,
  input: FullOrderInput,
): Promise<{
  replayed: boolean;
  result: {
    id: string;
    documentNumber: string;
    expectedUpdatedAt: string;
    status: string;
    currency: string;
    subtotal: string;
    taxTotal: string;
    total: string;
    lines: unknown[];
  };
}> {
  if (input.kind !== "sales_order") throw invalidInput("a full order body is only accepted for sales orders");
  if (!input.idempotencyKey || !input.idempotencyKey.trim()) {
    throw invalidInput("Idempotency-Key header is required");
  }
  assertApplicationPermission(context, "ar.create");
  const orgId = context.authz.user.orgId;
  if (!(await isFeatureEnabled(orgId, "orders"))) throw notFound("order");
  // A replay carries the same external pair the first attempt stamped: the
  // draft this key mints is its own conflict exclusion, derived the same way
  // the factory derives it, so a retry replays instead of 409ing on itself.
  await assertNoExternalDuplicate(
    orgId,
    input.externalRef,
    input.externalSource,
    draftDocumentId(orgId, input.idempotencyKey),
  );
  if (input.currency !== undefined) {
    const base = (await db.execute<{ base_currency: string | null }>(sql`
      select base_currency from orgs where id = ${orgId}`)).rows[0]?.base_currency;
    if (!base || String(input.currency).trim().toUpperCase() !== base.toUpperCase()) {
      throw invalidInput(
        base
          ? `currency must be ${base}, this organization's booking currency — convert the amounts before sending`
          : "this organization has no base currency configured — set one before creating orders",
      );
    }
  }
  const partyId = await resolveFullOrderCustomer(context, input.customer);
  const mapped = await mapV1OrderLines(orgId, input.lines, input.shippingLines);
  const draft = await createApplicationOrder(context, {
    kind: "sales_order",
    idempotencyKey: input.idempotencyKey,
    subsidiaryId: input.subsidiaryId ?? null,
  });
  // The drawer's first save fences on the fresh draft's own token: read it
  // back rather than inventing one, exactly as the drawer reloads before saving.
  const fresh = (await db.execute<{ token: string }>(sql`
    select revision_seq::text as token from documents
     where id = ${draft.result.id} and org_id = ${orgId}`)).rows[0];
  if (!fresh) throw notFound("order");
  const patch: OrderPatchBody = {
    expectedUpdatedAt: fresh.token,
    partyId,
    documentDate: input.documentDate,
    dueDate: input.dueDate,
    memo: input.memo,
    lines: mapped,
  };
  if (input.externalRef !== undefined || input.externalSource !== undefined) {
    patch.externalRef = input.externalRef;
    patch.externalSource = input.externalSource;
  }
  // applyOrderEditAsV1 raises every refusal mapped; nothing to catch here.
  const payload = await applyOrderEditAsV1(context, draft.result.id, patch);
  const doc = payload.doc;
  return {
    replayed: draft.replayed,
    result: {
      id: draft.result.id,
      documentNumber: draft.result.documentNumber,
      expectedUpdatedAt: String(doc.updated_at),
      status: String(doc.status ?? "draft"),
      currency: String(doc.currency ?? ""),
      subtotal: String(doc.subtotal ?? "0"),
      taxTotal: String(doc.tax_total ?? "0"),
      total: String(doc.total ?? "0"),
      lines: payload.lines,
    },
  };
}

/** Replace every line on a draft order — the drawer's line-replacement write. */
export async function replaceApplicationOrderLines(
  context: ApplicationContext,
  input: {
    documentId: string;
    expectedUpdatedAt: string;
    lines?: V1OrderLineInput[];
    shippingLines?: V1ShippingLineInput[];
  },
): Promise<{
  result: {
    id: string;
    documentNumber: string;
    expectedUpdatedAt: string;
    status: string;
    subtotal: string;
    taxTotal: string;
    total: string;
    lines: unknown[];
  };
}> {
  assertApplicationPermission(context, "ar.create");
  const orgId = context.authz.user.orgId;
  if (!(await isFeatureEnabled(orgId, "orders"))) throw notFound("order");
  if (!isDocumentRevisionToken(input.expectedUpdatedAt)) {
    throw invalidInput(
      "expectedUpdatedAt is required — pass the revision token returned by the order create or the last lines response",
    );
  }
  const mapped = await mapV1OrderLines(orgId, input.lines, input.shippingLines);
  const payload = await applyOrderEditAsV1(context, input.documentId, {
    expectedUpdatedAt: input.expectedUpdatedAt,
    lines: mapped,
  });
  const doc = payload.doc;
  return {
    result: {
      id: String(doc.id ?? input.documentId),
      documentNumber: String(doc.document_number ?? ""),
      expectedUpdatedAt: String(doc.updated_at),
      status: String(doc.status ?? "draft"),
      subtotal: String(doc.subtotal ?? "0"),
      taxTotal: String(doc.tax_total ?? "0"),
      total: String(doc.total ?? "0"),
      lines: payload.lines,
    },
  };
}

/** Issue a draft sales order — the same engine call as the drawer's Issue action. */
export async function issueApplicationOrder(
  context: ApplicationContext,
  input: { documentId: string; expectedUpdatedAt: string; creditOverrideReason?: string },
): Promise<{
  status: number;
  result: {
    id: string;
    documentNumber: string;
    expectedUpdatedAt: string;
    status: string;
    approvalPending?: boolean;
    requestId?: string;
    credit?: unknown;
  };
}> {
  assertApplicationPermission(context, "ar.create");
  const orgId = context.authz.user.orgId;
  if (!(await isFeatureEnabled(orgId, "orders"))) throw notFound("order");
  if (!isDocumentRevisionToken(input.expectedUpdatedAt)) {
    throw invalidInput(
      "expectedUpdatedAt is required — pass the revision token returned by the order create or the last lines response",
    );
  }
  const source = (await db.execute<{ subsidiary_id: string | null; document_number: string }>(sql`
    select subsidiary_id, document_number from documents
     where id = ${input.documentId} and org_id = ${orgId} and kind = 'sales_order'
  `)).rows[0];
  // The route issues one order kind: any other id is not this route's order.
  if (!source) throw notFound("order");
  assertSubsidiaryAccess(context, source.subsidiary_id);
  try {
    const issued = await issueSalesOrder({
      orgId,
      salesOrderId: input.documentId,
      actorId: context.authz.user.id,
      expectedUpdatedAt: input.expectedUpdatedAt,
      creditOverrideReason: input.creditOverrideReason,
    });
    // Every mutation moves the revision: hand back the fresh token so the
    // caller can convert or void without another read.
    const token = (await db.execute<{ token: string }>(sql`
      select revision_seq::text as token from documents
       where id = ${input.documentId} and org_id = ${orgId}`)).rows[0];
    if (!token) throw notFound("order");
    if (issued.submission.gated) {
      return {
        status: 202,
        result: {
          id: input.documentId,
          documentNumber: source.document_number,
          expectedUpdatedAt: token.token,
          status: "pending_approval",
          approvalPending: true,
          requestId: issued.submission.runId ?? undefined,
        },
      };
    }
    return {
      status: 200,
      result: {
        id: input.documentId,
        documentNumber: source.document_number,
        expectedUpdatedAt: token.token,
        status: "approved",
        credit: issued.credit,
      },
    };
  } catch (error) {
    if (error instanceof SalesOrderIssueError) {
      const details = { code: error.code };
      if (error.status === 404) throw notFound("order");
      if (error.status === 409) throw conflict(error.message, details);
      throw invalidInput(error.message, details);
    }
    throw error;
  }
}
