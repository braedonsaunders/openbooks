"use client";

/** Register API client: typed shapes and a fetch helper that checks status before reading a refusal body. */

export type PosDiscount = { kind: "percent" | "amount"; value: string };

export type PosCartLine = {
  key: string;
  itemId: string;
  name: string;
  code: string | null;
  quantity: string;
  unitPrice: string | null;
  discount: PosDiscount | null;
};

export type PosQuoteLine = {
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
};

export type PosQuote = {
  currency: string;
  currencyDecimals: number;
  customerId: string | null;
  lines: PosQuoteLine[];
  gross: string;
  discount: string;
  subtotal: string;
  tax: string;
  total: string;
};

export type PosSession = {
  id: string;
  registerId: string;
  sessionNumber: number;
  status: "open" | "closed";
  businessDate: string;
  currency: string;
  openingFloatMinor: string;
  openedAt: string;
  closedAt: string | null;
  expectedCashMinor: string | null;
  countedCashMinor: string | null;
  overShortMinor: string | null;
};

export type PosRegisterContext = {
  register: {
    id: string;
    code: string;
    name: string;
    currency: string;
    currencyDecimals: number;
    denominations: string[];
    receiptHeader: string | null;
    receiptFooter: string | null;
    defaultCustomerId: string | null;
  };
  acceptedTenders: Array<"cash" | "card" | "stored_value" | "other">;
  session: PosSession | null;
  quickKeys: Array<{ itemId: string; label: string; code: string | null }>;
  cashReasons: Array<{ id: string; name: string; direction: "pay_in" | "pay_out" }>;
  defaultCustomerName: string | null;
};

export type PosPayment = {
  kind: "cash" | "card" | "stored_value" | "other";
  amount?: string | null;
  tendered?: string | null;
  reference?: string | null;
  code?: string | null;
  label?: string | null;
};

export type PosCompletion = {
  documentId: string;
  documentNumber: string;
  kind: "sale" | "refund";
  total: string;
  change: string;
  replayed: boolean;
  effectsPending: boolean;
};

export type PosReceipt = {
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
};

export type PosSessionSummary = {
  session: PosSession & { closeNote: string | null; overShortEntryId: string | null };
  register: { id: string; code: string; name: string };
  saleCount: number;
  refundCount: number;
  noChargeSaleCount: number;
  noChargeRefundCount: number;
  salesTotalMinor: string;
  refundsTotalMinor: string;
  tenders: Array<{ kind: string; methodLabel: string; saleMinor: string; refundMinor: string }>;
  payInMinor: string;
  payOutMinor: string;
  saleCashMinor: string;
  refundCashMinor: string;
  expectedCashMinor: string;
  movements: Array<{
    id: string;
    kind: string;
    reason: string;
    amountMinor: string;
    note: string | null;
    createdAt: string;
    journalEntryId: string;
  }>;
};

/** A register refusal as the API reports it: message, operator remedy and stable code. */
export class PosRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly remedy: string | null,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "PosRequestError";
  }

  /** A transport failure or server fault: the same request may be retried with the same key. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export async function posRequest<T>(
  url: string,
  init: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string } = {},
  fallbackMessage: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new PosRequestError(fallbackMessage, 0, null, null, null);
  }
  if (!response.ok) {
    let body: { error?: unknown; code?: unknown; remedy?: unknown; details?: unknown } = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    throw new PosRequestError(
      typeof body.error === "string" && body.error.trim() !== "" ? body.error : fallbackMessage,
      response.status,
      typeof body.code === "string" ? body.code : null,
      typeof body.remedy === "string" ? body.remedy : null,
      body.details && typeof body.details === "object" && !Array.isArray(body.details)
        ? (body.details as Record<string, unknown>)
        : null,
    );
  }
  return (await response.json()) as T;
}

export function newRequestKey(): string {
  return crypto.randomUUID();
}
