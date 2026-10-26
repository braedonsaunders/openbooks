import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { allocateDocumentNumber } from "@openbooks/engine/records/numbering";
import { claimIdempotentCreate, resolveIdempotentReplay } from "./api/idempotency";
import { type OrderKind } from "./order-kinds";
import { isFeatureEnabled } from "./features";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { isUuid } from "./list-params";

const NUMBER_PREFIX: Record<OrderKind, { kind: OrderKind; prefix: string }> = {
  quote: { kind: "quote", prefix: "EST-" },
  sales_order: { kind: "sales_order", prefix: "SO-" },
  purchase_order: { kind: "purchase_order", prefix: "PO-" },
};

/**
 * Create an empty draft order document and return its id + number — the one
 * draft factory every instant-create surface uses (the three legacy draft
 * routes and the v1 order create).
 *
 * Idempotent under the canonical order-create contract
 * (web/app/api/_order/create.ts): the caller's `Idempotency-Key` header is a
 * required UUID that becomes the document id, so a lost-response retry
 * replays the same order instead of minting a second one and burning a
 * second number. A reused key with different request-controlled details, or
 * a key minted for another org's row, is a 409, never the older order
 * returned as though it matched.
 */
export async function createOrderDraft(
  orgId: string,
  userId: string,
  kind: OrderKind,
  idempotencyKey: string,
  /**
   * REQUIRED, no default: every draft lands in an explicitly named
   * subsidiary, resolved from the actor's scope BEFORE numbering or insert by
   * the caller (draft routes) or the v1 application layer — never an implicit
   * null for a restricted actor.
   */
  subsidiaryId: string | null,
): Promise<{ id: string; document_number: string; replayed: boolean }> {
  // One system for every caller: the document id derives deterministically
  // from the org and key (verbatim for UUID keys, namespaced hash for
  // opaque v1 keys), so claim, replay, insert, and audit all join on the
  // same id.
  const draftId = draftDocumentId(orgId, idempotencyKey);
  if (!(await isFeatureEnabled(orgId, "orders"))) throw new Error("Orders feature is disabled");
  const cfg = NUMBER_PREFIX[kind];
  const org = await db.execute<{ base_currency: string | null }>(
    sql`select base_currency from orgs where id = ${orgId}`,
    "objects",
  );
  // The order currency is the org's base currency — never invented. A
  // missing org row (or an unconfigured base currency) refuses by name
  // instead of silently booking foreign-currency intent as CAD, the same
  // rule the canonical order create enforces.
  const baseCurrency = org[0]?.base_currency;
  if (!baseCurrency) {
    throw new OrderDraftError(
      "this organization has no base currency configured — set one before creating orders",
    );
  }
  const today = await businessToday(orgId);
  // The request-controlled image a retry must equal: the kind plus the
  // subsidiary this call drafts under. Derived values (number, date,
  // currency, totals) are excluded so an identical retry still replays
  // after midnight or a configuration change.
  const match = { kind, subsidiary_id: subsidiaryId };

  let replayed = false;
  const outcome = await db.transaction(async (tx) => {
    // Same-key fence first: two concurrent first-clicks with one key
    // serialize so the loser replays instead of racing past the prior-row
    // check and dying on the insert conflict.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${draftId}, 0))`);
    // The lookup never reads another org's row: a key minted elsewhere
    // misses here, hits the insert conflict below, and refuses as 409.
    if (
      (await claimIdempotentCreate(tx, { orgId, table: "documents", key: draftId })) === "exists"
    ) {
      const verdict = await resolveIdempotentReplay(tx, {
        orgId,
        table: "documents",
        key: draftId,
        match,
      });
      if (verdict !== "replay") throw new OrderDraftConflictError();
      return { replayed: true };
    }
    // The number allocates HERE, inside the successful draft transaction:
    // a retried click never reaches this statement, so it burns neither
    // a row nor a sequence value.
    const documentNumber = await allocateDocumentNumber(tx, orgId, cfg.kind, cfg.prefix);
    const inserted = await tx.execute<{ id: string }>(
      sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, subtotal, tax_total, total, created_by)
      values (${draftId}, ${orgId}, ${kind}, ${documentNumber}, ${today},
              ${baseCurrency}, ${subsidiaryId}, '0', '0', '0', ${userId})
      -- A concurrent draft-ID collision raises the explicit draft conflict below.
      on conflict (id) do nothing
      returning id
    `,
      "objects",
    );
    if (!inserted[0]) throw new OrderDraftConflictError();
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'documents', ${draftId}, 'insert',
              ${JSON.stringify({ before: null, after: { ...match, status: "draft" } })}::jsonb,
              ${userId}, ${draftId})
    `);
    return { replayed: false };
  });
  replayed = outcome.replayed;

  const doc = await db.execute<{ id: string; document_number: string }>(
    sql`
    select id, document_number from documents
     where id = ${draftId} and org_id = ${orgId} and kind = ${kind}
  `,
    "objects",
  );
  // A write that matches zero rows is a failure, not a success: the replay
  // above verified this org's row, so a missing row here is never a
  // legitimate empty — refuse instead of returning an unobservable draft.
  if (!doc[0]) throw new OrderDraftError("Draft order not found", 404);
  return { ...doc[0], replayed };
}

/**
 * Refusal from the instant-into-draft factory: the draft cannot be minted
 * (missing base currency, disabled feature). Draft routes map this to the
 * 422 the operator acts on; it must never surface as a storage failure.
 */
export class OrderDraftError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "OrderDraftError";
  }
}

/**
 * Refusal when a draft idempotency key cannot mint or replay: a changed
 * payload, a key colliding with another org's row, or a key this factory
 * did not create. Surfaces as 409 through the same mapper as every other
 * draft refusal — fail closed, never the older order as though it matched.
 */
export class OrderDraftConflictError extends OrderDraftError {
  constructor() {
    super("invalid_idempotency_key", 409);
    this.name = "OrderDraftConflictError";
  }
}

/**
 * Namespace the draft factory hashes opaque idempotency keys under (RFC 4122
 * name-based UUIDs). Fixed for the life of the product: the same org and key
 * must always resolve to the same document id, or a retry would mint a
 * second draft instead of replaying.
 */
const DRAFT_ID_NAMESPACE = "8f2c3a90-5b1e-4d6f-a7c8-e9f0a1b2c3d4";

/**
 * The document id for an idempotency key within an org. UUID keys are used
 * verbatim (the UI contract requires them); any other non-empty key — the
 * v1 API accepts opaque keys — hashes to a stable UUID over the org id and
 * the key, so every caller shares the one claim/replay/insert system, a
 * retry still replays, and two orgs sending the same opaque key (say
 * 'order-1') never collide into a false 409. Empty keys refuse: they cannot
 * name a document.
 */
export function draftDocumentId(orgId: string, idempotencyKey: string): string {
  if (!idempotencyKey.trim()) throw new OrderDraftError("invalid_idempotency_key", 400);
  if (isUuid(idempotencyKey)) return idempotencyKey;
  const namespace = Buffer.from(DRAFT_ID_NAMESPACE.replaceAll("-", ""), "hex");
  const digest = createHash("sha1")
    .update(namespace)
    .update(orgId, "utf8")
    .update(idempotencyKey, "utf8")
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
