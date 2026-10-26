import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { claimIdempotentCreate, resolveIdempotentReplay } from "@/lib/api/idempotency";
import { cmp, sum } from "@openbooks/engine/money/money";
import { allocateDocumentNumber } from "@openbooks/engine/records/numbering";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { PaymentError } from "@openbooks/engine/payments-core/payment-errors";
import { PAYMENT_KIND_SIDE, type PaymentKind } from "@openbooks/engine/payments/payment-contracts";
import {
  validateAllocationInputs,
  validateSettlementEvidence,
  type AllocationInput,
} from "@openbooks/engine/payments/settlement-policy";
import { loadPaymentDocument, openItemsForParty } from "@openbooks/engine/payments/payment-queries";
import { can, getAuthz, guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { exactMoney, isoDate, nullableUuidId, uuidId } from "@/lib/api/json";
import {
  updateDraftPayment,
  resolvePaymentCurrencyBasis,
} from "@openbooks/engine/payments/payment-documents";
import { isIso4217CurrencyCode } from "@openbooks/engine/fx/currencies";
import {
  assertAllocationTargetsInScope,
  isPaymentKind,
  paymentErrorResponse,
  paymentPermission,
} from "./lib";

export const runtime = "nodejs";

const NUMBER_PREFIX: Record<PaymentKind, string> = {
  vendor_payment: "PAY-",
  customer_payment: "RCPT-",
};

function bad(error: string, field?: string, status = 422) {
  return NextResponse.json({ error, ...(field ? { field } : {}) }, { status });
}

/** One open-item application — the same shape PATCH accepts, so the create
 *  path and the edit path validate identical allocations. */
const allocationInput = z.object({
  openLineId: z.string().min(1),
  sourceTransactionAmount: exactMoney(),
  targetTransactionAmount: exactMoney(),
  targetBaseAmount: exactMoney().optional(),
  settlementRate: z.string().min(1),
  settlementRateSource: z.enum(["same_currency", "provider", "manual", "contractual", "imported"]),
  settlementRateReference: z.string(),
  settlementFxRateId: nullableUuidId.optional(),
});

const paymentCreateBody = z.object({
  kind: z.enum(["vendor_payment", "customer_payment"], {
    error: "kind must be vendor_payment or customer_payment",
  }),
  partyId: nullableUuidId.optional(),
  bankAccountId: nullableUuidId.optional(),
  subsidiaryId: nullableUuidId.optional(),
  currency: z.string().refine(isIso4217CurrencyCode, "must be an ISO currency").optional(),
  documentDate: isoDate().optional(),
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  withholdingAuthorisation: z.string().trim().max(100).nullable().optional(),
  withholdingAuthorisedAmount: exactMoney().nullable().optional(),
  // Explicit settlement rate into the owning entity's functional currency.
  // The insert below records no evidence; the locked draft save in the same
  // transaction records it with its before/after audit.
  explicitFx: z
    .object({
      rate: z.string(),
      source: z.string(),
      reason: z.string(),
      fromCurrency: z.string(),
      toCurrency: z.string(),
      rateDate: isoDate(),
    })
    .strict()
    .nullable()
    .optional(),
  allocations: z.array(allocationInput).optional(),
  // Cash received beyond the applications (customer receipts only): it stays
  // on the receipt as an on-account credit rather than being dropped.
  onAccountAmount: exactMoney().optional(),
  // Stored-value tenders (customer receipts only): fresh gift-card codes or
  // already-resolved echoes. Resolved and re-verified after insert (never
  // persisted raw); part of the replay match as caller-controlled input.
  storedValueTenders: z
    .array(
      z.union([
        z.object({ code: z.string().min(1).max(64), amount: exactMoney() }),
        z.object({ accountId: uuidId, amount: exactMoney() }),
      ]),
    )
    .optional(),
});

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/**
 * Create one draft vendor payment or customer receipt with its open-item
 * applications. The kind is fixed by the entry surface (the payments list
 * creates vendor payments, the receipts list creates customer receipts) and
 * each kind gates on its own permission (ap.pay / ar.pay).
 *
 * The caller supplies a UUID idempotency key, which becomes the document ID.
 * The first write allocates the PAY-/RCPT- number inside the locked save
 * transaction and inserts exactly one document, its bank line, and one audit
 * row carrying the key as its request correlation. Retrying the exact
 * request replays the same payment (200); reusing the key for a changed
 * payload, or for a key minted in another org, is a 409 — never the older
 * payment returned as though it matched.
 *
 * This is the only first-party write path for new payments: the lists open
 * an unsaved drawer (zero writes) and this endpoint persists it exactly
 * once. The legacy draft factory stays for backward-compatible
 * integrations only.
 */
async function createPayment(
  request: Request,
  session: Authz,
  body: z.infer<typeof paymentCreateBody>,
) {
  if (!isPaymentKind(body.kind))
    return bad("kind must be vendor_payment or customer_payment", "kind");
  const kind: PaymentKind = body.kind;

  const gate = session;
  const user = gate.user;

  const requestId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!isUuid(requestId)) return bad("invalid_idempotency_key", undefined, 400);

  const side = PAYMENT_KIND_SIDE[kind];
  const allocations: AllocationInput[] = body.allocations ?? [];
  const partyId = body.partyId ?? null;
  const bankAccountId = body.bankAccountId ?? null;

  // -- party: must be an active counterparty of the right kind ----------------
  let partySubsidiaryId: string | null = null;
  if (partyId) {
    const party = (
      await db.execute<{ id: string; subsidiaryId: string | null }>(
        sql`
      select id, subsidiary_id as "subsidiaryId" from parties
       where id = ${partyId} and org_id = ${user.orgId} and is_active`,
        "objects",
      )
    )[0];
    if (!party)
      return NextResponse.json({ error: "party not found in this organization" }, { status: 404 });
    const roleTable = side === "ap" ? "vendor_roles" : "customer_roles";
    const role = await db.execute<{ id: string }>(
      sql`
      select party_id as id from ${sql.raw(roleTable)}
       where party_id = ${partyId} and org_id = ${user.orgId} and is_active`,
      "objects",
    );
    if (!role[0]) {
      return bad(
        side === "ap"
          ? "payment party must be an active vendor"
          : "receipt party must be an active customer",
        "partyId",
      );
    }
    partySubsidiaryId = party.subsidiaryId;
  }
  if (allocations.length > 0 && !partyId) {
    return bad("select a party before applying open items", "partyId");
  }

  if (
    bankAccountId &&
    !(
      await db.execute(
        sql`select id from accounts
    where org_id = ${user.orgId} and id = ${bankAccountId} and is_active and not is_summary`,
        "objects",
      )
    )[0]
  ) {
    return NextResponse.json(
      { error: "payment funding account not found in this organization" },
      { status: 404 },
    );
  }

  // -- legal entity + currency --------------------------------------------------
  // The payment inherits the party's subsidiary, else the org root — the
  // same derivation the legacy draft factory used, minus the write. A
  // restricted caller outside that entity sees the tenant-opaque 404.
  let subsidiaryId: string | null = body.subsidiaryId ?? partySubsidiaryId;
  if (!subsidiaryId) {
    const root = await db.execute<{ id: string }>(
      sql`
      select id from subsidiaries where org_id = ${user.orgId} and parent_id is null`,
      "objects",
    );
    subsidiaryId = root[0]?.id ?? null;
    if (!subsidiaryId) return bad("org has no root subsidiary", undefined, 500);
  }
  const denied = guardSubsidiaryScope(gate, subsidiaryId);
  if (denied) return denied;
  const entity = (
    await db.execute<{ id: string }>(
      sql`
    select id from subsidiaries where org_id = ${user.orgId} and id = ${subsidiaryId}
      and is_active and not is_elimination`,
      "objects",
    )
  )[0];
  if (!entity) return NextResponse.json({ error: "record not found" }, { status: 404 });
  const org = (
    await db.execute<{ baseCurrency: string }>(
      sql`
    select base_currency as "baseCurrency" from orgs where id = ${user.orgId}`,
      "objects",
    )
  )[0];
  if (!org) return bad("org not found", undefined, 500);
  const currency = body.currency ?? org.baseCurrency;

  // -- allocations: real open items of this party, within open balance --------
  try {
    validateAllocationInputs(allocations);
  } catch (e) {
    return paymentErrorResponse(e);
  }
  const allocationTargetsDenied = await assertAllocationTargetsInScope(
    gate,
    allocations.map((a) => a.openLineId),
  );
  if (allocationTargetsDenied) return allocationTargetsDenied;
  if (allocations.length > 0) {
    const openItems = await openItemsForParty(
      partyId!,
      side,
      user.orgId,
      new Set(subsidiaryId ? [subsidiaryId] : []),
    );
    const byLine = new Map(openItems.map((i) => [i.lineId, i]));
    for (const a of allocations) {
      const item = byLine.get(a.openLineId);
      if (!item) return bad("an allocated item is not an open item for this party", "allocations");
      try {
        validateSettlementEvidence(a, currency, item.currency);
      } catch (e) {
        return paymentErrorResponse(e);
      }
      if (cmp(a.targetTransactionAmount, item.transactionOpen) > 0) {
        return bad(
          `applying ${a.targetTransactionAmount} ${item.currency} exceeds the open transaction balance ${item.transactionOpen} on ${item.documentNumber ?? item.entryNumber}`,
          "allocations",
        );
      }
    }
  }

  const documentDate = body.documentDate ?? (await businessToday(user.orgId));
  const referenceNumber = trimOrNull(body.referenceNumber);
  const memo = trimOrNull(body.memo);
  // documents.total on a payment is the CASH frame by contract: the bank
  // line carries this total (same derivation as the draft edit path).
  const total = sum(allocations.map((a) => a.sourceTransactionAmount));
  const custom = { bankAccountId, allocations };
  // The replay match is the canonical request-controlled subset: the kind
  // and the caller's fields exactly as supplied. Server-derived values —
  // the defaulted date, the resolved subsidiary and currency, the derived
  // total, the allocated number — are EXCLUDED: they depend on live
  // clock/config/sequence state, so comparing them would turn a genuine
  // retry into a conflict. They still persist in the full snapshot below.
  // A null date here means "the caller omitted it", which is itself part of
  // the request identity.
  const match = {
    kind,
    partyId,
    bankAccountId,
    ...(body.subsidiaryId !== undefined ? { subsidiaryId: body.subsidiaryId } : {}),
    ...(body.currency !== undefined ? { currency: body.currency } : {}),
    documentDate: body.documentDate ?? null,
    referenceNumber: body.referenceNumber ?? null,
    memo: body.memo ?? null,
    ...(body.withholdingAuthorisation !== undefined
      ? { withholdingAuthorisation: body.withholdingAuthorisation }
      : {}),
    ...(body.withholdingAuthorisedAmount !== undefined
      ? { withholdingAuthorisedAmount: body.withholdingAuthorisedAmount }
      : {}),
    ...(body.explicitFx !== undefined ? { explicitFx: body.explicitFx } : {}),
    allocations: body.allocations ?? [],
    ...(body.onAccountAmount !== undefined ? { onAccountAmount: body.onAccountAmount } : {}),
    storedValueTenders: body.storedValueTenders ?? [],
  };
  // The persisted image is the full immutable create snapshot (derived
  // values included) plus the request match above, so audit evidence stays
  // complete while replay compares only what the caller controlled.
  const snapshot = {
    request: match,
    id: requestId,
    org_id: user.orgId,
    kind,
    subsidiary_id: subsidiaryId,
    document_date: documentDate,
    currency,
    party_id: partyId,
    reference_number: referenceNumber,
    memo,
    subtotal: total,
    total,
    custom,
  };

  let created = false;
  try {
    created = await withOrgTransaction(user.orgId, async () => {
      const tx = db;
      // Serialize every request carrying this key: without the lock, two
      // concurrent identical Saves could both read no row, both allocate a
      // number, and the loser would 409 on the insert conflict instead of
      // replaying 200. The lock is keyed only — it carries no tenant read.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      // Same-org claim only — never a bare by-id read: a key minted in
      // another org must not be observable here. A foreign/global UUID
      // collision surfaces below at the insert conflict, without reading it.
      const claim = await claimIdempotentCreate(tx, {
        orgId: user.orgId,
        table: "documents",
        key: requestId,
      });
      // Replay compares the immutable request image in the insert audit
      // event — not today's row, and not the derived values — so an
      // unchanged retry still succeeds after the clock/config moved under a
      // defaulted field.
      const replayMatch = { request: match };
      if (claim === "exists") {
        const replay = await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: "documents",
          key: requestId,
          match: replayMatch,
        });
        if (replay !== "replay") throw new Error("idempotency_key_conflict");
        return false;
      }
      // A supplied explicit rate replaces the ordinary organization
      // exchange-rate lookup: resolving it here would fail a foreign
      // payment that carries a valid manual election and no global rate
      // row. The locked draft save below records the election instead.
      const currencyBasis =
        body.currency !== undefined && body.explicitFx === undefined
          ? await resolvePaymentCurrencyBasis(user.orgId, subsidiaryId, currency, documentDate)
          : null;
      const fxRate = currencyBasis?.fxRate ?? "1";
      const fundedCustom = {
        ...custom,
        ...(currencyBasis ? { paymentCurrencyEvidence: currencyBasis.evidence } : {}),
      };
      // First write for this key: the number is allocated here, inside the
      // locked save transaction — opening the drawer never consumed one.
      const documentNumber = await allocateDocumentNumber(
        tx,
        user.orgId,
        kind,
        NUMBER_PREFIX[kind],
      );
      const inserted = await tx.execute<{ id: string }>(
        sql`
        insert into documents
          (id, org_id, kind, status, subsidiary_id, document_number, document_date,
           currency, fx_rate, party_id, reference_number, memo, custom,
           subtotal, tax_total, total, created_by, updated_by)
        values
          (${requestId}, ${user.orgId}, ${kind}, 'draft', ${subsidiaryId}, ${documentNumber},
           ${documentDate}, ${currency}, ${fxRate}, ${partyId}, ${referenceNumber}, ${memo},
           ${JSON.stringify(fundedCustom)}::jsonb, ${total}, '0', ${total}, ${user.id}, ${user.id})
        -- A retry is accepted only after the existing audited create payload is verified below.
        on conflict (id) do nothing
        returning id`,
        "objects",
      );
      if (!inserted[0]) {
        // Lost insert race or foreign/global UUID collision: the re-read
        // decides — a genuine retry replays, anything else conflicts, all
        // without reading another org's row.
        const replay = await resolveIdempotentReplay(tx, {
          orgId: user.orgId,
          table: "documents",
          key: requestId,
          match: replayMatch,
        });
        if (replay !== "replay") throw new Error("idempotency_key_conflict");
        return false;
      }
      if (bankAccountId && cmp(total, "0") !== 0) {
        await tx.execute(sql`
          insert into document_lines (org_id, document_id, line_number, account_id,
                                      quantity, unit_price, amount, tax_amount)
          values (${user.orgId}, ${requestId}, 1, ${bankAccountId}, '1', ${total}, ${total}, '0')`);
      }
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${user.orgId}, 'documents', ${requestId}, 'insert',
                ${JSON.stringify({ before: null, after: { ...snapshot, fx_rate: fxRate, custom: fundedCustom } })}::jsonb,
                ${user.id}, ${requestId})`);
      await updateDraftPayment(
        requestId,
        {
          allocations,
          explicitFx: body.explicitFx,
          onAccountAmount: body.onAccountAmount,
          withholdingAuthorisation: body.withholdingAuthorisation,
          withholdingAuthorisedAmount: body.withholdingAuthorisedAmount,
          storedValueTenders: body.storedValueTenders,
        },
        user.id,
        user.orgId,
        { allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
      );
      return true;
    });
  } catch (error) {
    if (error instanceof PaymentError) return paymentErrorResponse(error);
    const message =
      error instanceof Error
        ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`
        : String(error);
    if (message.includes("idempotency_key_conflict"))
      return bad("invalid_idempotency_key", undefined, 409);
    throw error;
  }

  const payment = await loadPaymentDocument(requestId, kind, user.orgId, gate.allowedSubsidiaryIds);
  if (!payment) return bad("save_failed", undefined, 500);
  return NextResponse.json(payment, { status: created ? 201 : 200 });
}

export const POST = defineRoute({
  authorize: async ({ request }) => {
    const session = await getAuthz();
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    let kind: unknown;
    try {
      kind = ((await request.clone().json()) as { kind?: unknown }).kind;
    } catch {
      /* the real schema returns the malformed-body refusal */
    }
    if (kind === "vendor_payment" || kind === "customer_payment") {
      const permission = paymentPermission(kind);
      if (!can(session, permission)) {
        return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
      }
    }
    return session;
  },
  feature: { none: "Payment creation checks ap.pay or ar.pay from the validated payment kind." },
  body: paymentCreateBody,
  invalidBodyStatus: 422,
  handler: async ({ request, authz, body }) => createPayment(request, authz, body),
});
