import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import {
  INTERCOMPANY_TRANSACTIONS_FEATURE,
  loadPartyRepresentation,
  loadSubsidiaryRepresentatives,
  rootSubsidiaryId,
} from "../organization/intercompany-accounts.ts";
import {
  auditIntercompany,
  IntercompanyError,
  INTERCOMPANY_TRANSACTIONS_DISABLED,
  requireOneRow,
  requireIntercompanyPermission,
} from "./errors.ts";
import {
  BUYER_KIND,
  comparePairedDocuments,
  pairSideOf,
  SELLER_KIND,
  type PairComparison,
  type PairedDocumentSummary,
  type PairKind,
} from "./pairing-compare.ts";

/**
 * Paired intercompany transactions.
 *
 * A sales order, invoice or credit memo in one entity whose customer
 * represents another entity is an intercompany sale; a purchase order, bill
 * or vendor credit whose vendor represents another entity is an
 * intercompany purchase. Pairing links the two sides explicitly — generated
 * from one another or linked by an operator — with an audited reason, and a
 * document belongs to at most one live pair. Unlinking keeps the history.
 * The workspace reads every intercompany document as unpaired, mismatched
 * (currency, amount, item quantities or a voided side) or paired.
 */

export interface IntercompanyDocument {
  documentId: string;
  documentNumber: string;
  kind: string;
  status: string;
  pairKind: PairKind;
  side: "seller" | "buyer";
  /** The document's own entity (the root for an unscoped document). */
  subsidiaryId: string;
  /** The entity its party represents. */
  counterpartySubsidiaryId: string;
  partyId: string;
  currency: string;
  total: string;
  documentDate: string;
}

export interface PairDetail {
  id: string;
  pairKind: PairKind;
  status: "linked" | "unlinked";
  origin: "generated" | "linked";
  sellerSubsidiaryId: string;
  buyerSubsidiaryId: string;
  seller: PairedDocumentSummary & { kind: string; documentDate: string };
  buyer: PairedDocumentSummary & { kind: string; documentDate: string };
  comparison: PairComparison;
  linkReason: string | null;
  linkedBy: string;
  linkedAt: string;
  unlinkReason: string | null;
  unlinkedAt: string | null;
}

function refuse(message: string, status: 404 | 409 | 422 = 422): never {
  throw new IntercompanyError(message, status);
}

function scopeAllows(allowed: ReadonlySet<string> | null, ids: readonly string[]): boolean {
  return allowed === null || ids.every((id) => allowed.has(id));
}

async function assertTransactionsEnabled(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, INTERCOMPANY_TRANSACTIONS_FEATURE)))
    refuse(INTERCOMPANY_TRANSACTIONS_DISABLED);
}

/** The intercompany reading of one document, or null when it is not intercompany. */
export async function intercompanyDocument(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  options: { lock?: boolean } = {},
): Promise<IntercompanyDocument | null> {
  if (!isUuid(documentId)) return null;
  const doc = (
    await runner.execute<{
      id: string;
      document_number: string;
      kind: string;
      status: string;
      subsidiary_id: string | null;
      party_id: string | null;
      currency: string;
      total: string;
      document_date: string;
    }>(
      sql`
    select id, document_number, kind, status, subsidiary_id, party_id, currency, total::text as total,
           document_date::text as document_date
      from documents
     where org_id = ${orgId} and id = ${documentId}
     ${options.lock ? sql`for share` : sql``}`,
      "objects",
    )
  )[0];
  if (!doc || !doc.party_id) return null;
  const side = pairSideOf(doc.kind);
  if (!side) return null;
  const representation = (
    await runner.execute<{ subsidiary_id: string }>(
      side.side === "seller"
        ? sql`select subsidiary_id from intercompany_representing_parties
             where org_id = ${orgId} and customer_party_id = ${doc.party_id} and is_active`
        : sql`select subsidiary_id from intercompany_representing_parties
             where org_id = ${orgId} and vendor_party_id = ${doc.party_id} and is_active`,
      "objects",
    )
  )[0];
  if (!representation) return null;
  const subsidiaryId = doc.subsidiary_id ?? (await rootSubsidiaryId(runner, orgId));
  return {
    documentId: doc.id,
    documentNumber: doc.document_number,
    kind: doc.kind,
    status: doc.status,
    pairKind: side.pairKind,
    side: side.side,
    subsidiaryId,
    counterpartySubsidiaryId: representation.subsidiary_id,
    partyId: doc.party_id,
    currency: doc.currency,
    total: fromUnits(toUnits(doc.total)),
    documentDate: doc.document_date,
  };
}

/** The live pair a document belongs to, or null. */
export async function livePairOf(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<{ id: string } | null> {
  const row = (
    await runner.execute<{ id: string }>(
      sql`
    select id from intercompany_transaction_pairs
     where org_id = ${orgId} and status = 'linked'
       and (seller_document_id = ${documentId} or buyer_document_id = ${documentId})`,
      "objects",
    )
  )[0];
  return row ?? null;
}

/**
 * Link a selling entity's document to the buying entity's mirror. Both must
 * be intercompany with each other's entity, of the same pair kind, unvoided,
 * visible to the caller and not already paired.
 */
export async function linkIntercompanyDocuments(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: {
    sellerDocumentId: string;
    buyerDocumentId: string;
    reason?: string | null;
    origin?: "generated" | "linked";
  },
): Promise<PairDetail> {
  const reason =
    typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
  if (reason && reason.length > 2000) refuse("the reason must be at most 2000 characters");
  const origin = input.origin ?? "linked";
  if (origin === "linked" && !reason) refuse("a reason is required to link two documents by hand");
  const pairId = await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.manage");
    await assertTransactionsEnabled(db, orgId);
    // Lock both documents in a stable order before reading either side.
    const ordered = [input.sellerDocumentId, input.buyerDocumentId].sort();
    const first = await intercompanyDocument(db, orgId, ordered[0]!, { lock: true });
    const second = await intercompanyDocument(db, orgId, ordered[1]!, { lock: true });
    const seller = first?.documentId === input.sellerDocumentId ? first : second;
    const buyer = first?.documentId === input.buyerDocumentId ? first : second;
    if (!seller || !buyer) {
      refuse(
        "both documents must be intercompany: the customer and the vendor must each represent the other entity — set them in Setup → Accounting → Intercompany representing parties",
      );
    }
    if (!scopeAllows(allowedSubsidiaryIds, [seller.subsidiaryId, buyer.subsidiaryId]))
      refuse("document not found", 404);
    if (seller.side !== "seller" || buyer.side !== "buyer") {
      refuse(
        "link a sales document of the selling entity to a purchase document of the buying entity",
      );
    }
    if (seller.pairKind !== buyer.pairKind) {
      refuse(
        `a ${SELLER_KIND[seller.pairKind].replace("_", " ")} pairs with a ${BUYER_KIND[seller.pairKind].replace("_", " ")}`,
      );
    }
    if (
      seller.counterpartySubsidiaryId !== buyer.subsidiaryId ||
      buyer.counterpartySubsidiaryId !== seller.subsidiaryId
    ) {
      refuse(
        `${seller.documentNumber} and ${buyer.documentNumber} are not between the same two entities`,
      );
    }
    if (seller.status === "voided" || buyer.status === "voided")
      refuse("a voided document cannot be paired");
    for (const doc of [seller, buyer]) {
      const existing = await livePairOf(db, orgId, doc.documentId);
      if (existing) refuse(`${doc.documentNumber} is already paired; unlink it first`, 409);
    }
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into intercompany_transaction_pairs
        (org_id, pair_kind, seller_subsidiary_id, buyer_subsidiary_id, seller_document_id, buyer_document_id,
         origin, link_reason, linked_by)
      values (${orgId}, ${seller.pairKind}, ${seller.subsidiaryId}, ${buyer.subsidiaryId}, ${seller.documentId},
              ${buyer.documentId}, ${origin}, ${reason}, ${actorId})
      returning id`,
      "objects",
    );
    requireOneRow(inserted, "the pair could not be recorded");
    const id = inserted[0]!.id;
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_transaction_pairs",
      rowId: id,
      action: "insert",
      actorId,
      changes: {
        mode: origin === "generated" ? "intercompany_pair_generated" : "intercompany_pair_linked",
        reason,
        after: {
          pairKind: seller.pairKind,
          sellerDocument: seller.documentNumber,
          buyerDocument: buyer.documentNumber,
          sellerSubsidiaryId: seller.subsidiaryId,
          buyerSubsidiaryId: buyer.subsidiaryId,
        },
      },
    });
    return id;
  });
  return loadIntercompanyPairDetail(orgId, pairId, allowedSubsidiaryIds);
}

/** End a live pair, keeping it as history with the reason. */
export async function unlinkIntercompanyPair(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  pairId: string,
  reasonInput: string,
): Promise<PairDetail> {
  const reason = typeof reasonInput === "string" ? reasonInput.trim() : "";
  if (!reason) refuse("a reason is required to unlink a pair");
  if (reason.length > 2000) refuse("the reason must be at most 2000 characters");
  if (!isUuid(pairId)) refuse("pair not found", 404);
  await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.manage");
    await assertTransactionsEnabled(db, orgId);
    const pair = (
      await db.execute<{
        status: string;
        seller_subsidiary_id: string;
        buyer_subsidiary_id: string;
      }>(
        sql`
      select status, seller_subsidiary_id, buyer_subsidiary_id from intercompany_transaction_pairs
       where org_id = ${orgId} and id = ${pairId}
       for update`,
        "objects",
      )
    )[0];
    if (
      !pair ||
      !scopeAllows(allowedSubsidiaryIds, [pair.seller_subsidiary_id, pair.buyer_subsidiary_id])
    )
      refuse("pair not found", 404);
    if (pair.status !== "linked") refuse("this pair is already unlinked", 409);
    const updated = await db.execute<{ id: string }>(
      sql`
      update intercompany_transaction_pairs
         set status = 'unlinked', unlinked_by = ${actorId}, unlinked_at = now(), unlink_reason = ${reason}, updated_at = now()
       where org_id = ${orgId} and id = ${pairId} and status = 'linked'
      returning id`,
      "objects",
    );
    requireOneRow(updated, "the pair changed while it was being unlinked");
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_transaction_pairs",
      rowId: pairId,
      action: "update",
      actorId,
      changes: {
        mode: "intercompany_pair_unlinked",
        reason,
        before: { status: "linked" },
        after: { status: "unlinked" },
      },
    });
  });
  return loadIntercompanyPairDetail(orgId, pairId, allowedSubsidiaryIds);
}

async function documentSummaries(
  runner: SqlExecutor,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, PairedDocumentSummary & { kind: string; documentDate: string }>> {
  if (ids.length === 0) return new Map();
  const docs = await runner.execute<{
    id: string;
    document_number: string;
    status: string;
    currency: string;
    total: string;
    kind: string;
    document_date: string;
  }>(
    sql`
    select id, document_number, status, currency, total::text as total, kind, document_date::text as document_date
      from documents where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])`,
    "objects",
  );
  const quantities = await runner.execute<{
    document_id: string;
    item_id: string;
    quantity: string;
  }>(
    sql`
    select document_id, item_id, sum(coalesce(quantity, 0))::text as quantity
      from document_lines
     where org_id = ${orgId} and document_id = any(${uuidArray(ids)}::uuid[]) and item_id is not null
     group by document_id, item_id`,
    "objects",
  );
  const out = new Map<string, PairedDocumentSummary & { kind: string; documentDate: string }>();
  for (const doc of docs) {
    out.set(doc.id, {
      documentId: doc.id,
      documentNumber: doc.document_number,
      status: doc.status,
      currency: doc.currency,
      total: fromUnits(toUnits(doc.total)),
      quantities: {},
      kind: doc.kind,
      documentDate: doc.document_date,
    });
  }
  for (const row of quantities) {
    const summary = out.get(row.document_id);
    if (summary) summary.quantities[row.item_id] = row.quantity;
  }
  return out;
}

type PairRow = {
  id: string;
  pair_kind: PairKind;
  status: "linked" | "unlinked";
  origin: "generated" | "linked";
  seller_subsidiary_id: string;
  buyer_subsidiary_id: string;
  seller_document_id: string;
  buyer_document_id: string;
  link_reason: string | null;
  linked_by: string;
  linked_at: string;
  unlink_reason: string | null;
  unlinked_at: string | null;
};

async function pairDetails(
  runner: SqlExecutor,
  orgId: string,
  rows: PairRow[],
): Promise<PairDetail[]> {
  const summaries = await documentSummaries(
    runner,
    orgId,
    rows.flatMap((row) => [row.seller_document_id, row.buyer_document_id]),
  );
  return rows.flatMap((row) => {
    const seller = summaries.get(row.seller_document_id);
    const buyer = summaries.get(row.buyer_document_id);
    if (!seller || !buyer) return [];
    return [
      {
        id: row.id,
        pairKind: row.pair_kind,
        status: row.status,
        origin: row.origin,
        sellerSubsidiaryId: row.seller_subsidiary_id,
        buyerSubsidiaryId: row.buyer_subsidiary_id,
        seller,
        buyer,
        comparison: comparePairedDocuments(seller, buyer),
        linkReason: row.link_reason,
        linkedBy: row.linked_by,
        linkedAt: row.linked_at,
        unlinkReason: row.unlink_reason,
        unlinkedAt: row.unlinked_at,
      },
    ];
  });
}

const PAIR_COLUMNS = sql`
  id, pair_kind, status, origin, seller_subsidiary_id, buyer_subsidiary_id, seller_document_id, buyer_document_id,
  link_reason, linked_by, linked_at::text as linked_at, unlink_reason, unlinked_at::text as unlinked_at`;

export async function loadIntercompanyPairDetail(
  orgId: string,
  pairId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  runner: SqlExecutor = db,
): Promise<PairDetail> {
  if (!isUuid(pairId)) refuse("pair not found", 404);
  const row = (
    await runner.execute<PairRow>(
      sql`
    select ${PAIR_COLUMNS} from intercompany_transaction_pairs where org_id = ${orgId} and id = ${pairId}`,
      "objects",
    )
  )[0];
  if (
    !row ||
    !scopeAllows(allowedSubsidiaryIds, [row.seller_subsidiary_id, row.buyer_subsidiary_id])
  )
    refuse("pair not found", 404);
  const [detail] = await pairDetails(runner, orgId, [row]);
  if (!detail) refuse("pair not found", 404);
  return detail;
}

export interface UnpairedDocument extends IntercompanyDocument {
  partyName: string;
  subsidiaryName: string;
  counterpartySubsidiaryName: string;
}

export interface IntercompanyWorkspace {
  unpaired: UnpairedDocument[];
  mismatched: PairDetail[];
  paired: PairDetail[];
  /** True when a view hit its row limit; narrow by entity to see the rest. */
  truncated: boolean;
}

const WORKSPACE_LIMIT = 500;

/**
 * The pairing workspace: every live intercompany document the caller can see
 * in both entities, split into unpaired, mismatched and paired. Optionally
 * narrowed to one entity.
 */
export async function intercompanyWorkspace(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  filter: { subsidiaryId?: string | null } = {},
): Promise<IntercompanyWorkspace> {
  const subsidiaryFilter =
    filter.subsidiaryId && isUuid(filter.subsidiaryId) ? filter.subsidiaryId : null;
  const allowed = allowedSubsidiaryIds === null ? null : [...allowedSubsidiaryIds];
  const root = await rootSubsidiaryId(db, orgId);
  const unpairedRows = await db.execute<{
    id: string;
    document_number: string;
    kind: string;
    status: string;
    subsidiary_id: string;
    counterparty_id: string;
    party_id: string;
    party_name: string;
    currency: string;
    total: string;
    document_date: string;
    subsidiary_name: string;
    counterparty_name: string;
  }>(
    sql`
    select d.id, d.document_number, d.kind, d.status, coalesce(d.subsidiary_id, ${root}::uuid) as subsidiary_id,
           r.subsidiary_id as counterparty_id, d.party_id, p.display_name as party_name, d.currency,
           d.total::text as total, d.document_date::text as document_date,
           s.name as subsidiary_name, c.name as counterparty_name
      from documents d
      join intercompany_representing_parties r
        on r.org_id = d.org_id and r.is_active
       and ((d.kind in ('sales_order', 'customer_invoice', 'customer_credit') and r.customer_party_id = d.party_id)
         or (d.kind in ('purchase_order', 'vendor_bill', 'vendor_credit') and r.vendor_party_id = d.party_id))
      join parties p on p.org_id = d.org_id and p.id = d.party_id
      join subsidiaries s on s.org_id = d.org_id and s.id = coalesce(d.subsidiary_id, ${root}::uuid)
      join subsidiaries c on c.org_id = d.org_id and c.id = r.subsidiary_id
     where d.org_id = ${orgId} and d.status <> 'voided'
       and not exists (
         select 1 from intercompany_transaction_pairs tp
          where tp.org_id = d.org_id and tp.status = 'linked'
            and (tp.seller_document_id = d.id or tp.buyer_document_id = d.id))
       and (${subsidiaryFilter}::uuid is null
            or coalesce(d.subsidiary_id, ${root}::uuid) = ${subsidiaryFilter}::uuid
            or r.subsidiary_id = ${subsidiaryFilter}::uuid)
       and (${allowed === null}::boolean
            or (coalesce(d.subsidiary_id, ${root}::uuid) = any(${uuidArray(allowed ?? [])}::uuid[])
                and r.subsidiary_id = any(${uuidArray(allowed ?? [])}::uuid[])))
     order by d.document_date desc, d.document_number desc
     limit ${WORKSPACE_LIMIT + 1}`,
    "objects",
  );
  const pairRows = await db.execute<PairRow>(
    sql`
    select ${PAIR_COLUMNS} from intercompany_transaction_pairs
     where org_id = ${orgId} and status = 'linked'
       and (${subsidiaryFilter}::uuid is null
            or seller_subsidiary_id = ${subsidiaryFilter}::uuid or buyer_subsidiary_id = ${subsidiaryFilter}::uuid)
       and (${allowed === null}::boolean
            or (seller_subsidiary_id = any(${uuidArray(allowed ?? [])}::uuid[])
                and buyer_subsidiary_id = any(${uuidArray(allowed ?? [])}::uuid[])))
     order by linked_at desc
     limit ${WORKSPACE_LIMIT + 1}`,
    "objects",
  );
  const details = await pairDetails(db, orgId, pairRows.slice(0, WORKSPACE_LIMIT));
  return {
    unpaired: unpairedRows.slice(0, WORKSPACE_LIMIT).map((row) => {
      const side = pairSideOf(row.kind)!;
      return {
        documentId: row.id,
        documentNumber: row.document_number,
        kind: row.kind,
        status: row.status,
        pairKind: side.pairKind,
        side: side.side,
        subsidiaryId: row.subsidiary_id,
        counterpartySubsidiaryId: row.counterparty_id,
        partyId: row.party_id,
        currency: row.currency,
        total: fromUnits(toUnits(row.total)),
        documentDate: row.document_date,
        partyName: row.party_name,
        subsidiaryName: row.subsidiary_name,
        counterpartySubsidiaryName: row.counterparty_name,
      };
    }),
    mismatched: details.filter((detail) => detail.comparison.state === "mismatched"),
    paired: details.filter((detail) => detail.comparison.state !== "mismatched"),
    truncated: unpairedRows.length > WORKSPACE_LIMIT || pairRows.length > WORKSPACE_LIMIT,
  };
}

export interface CounterpartLine {
  itemId: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string;
  /** The account the counterpart line posts to; null lets an order line take its item's account. */
  accountId: string | null;
}

export interface CounterpartPlan {
  source: IntercompanyDocument;
  pairKind: PairKind;
  targetKind: string;
  targetSide: "seller" | "buyer";
  targetSubsidiaryId: string;
  targetPartyId: string;
  currency: string;
  documentDate: string;
  memo: string;
  lines: CounterpartLine[];
}

/**
 * Plan the mirror document of an intercompany document: the buying entity's
 * purchase document to the seller's representing vendor (or the selling
 * entity's sales document to the buyer's representing customer), line for
 * line at the same prices and currency. The native order and document
 * writers create it; nothing is written here.
 */
export async function planIntercompanyCounterpart(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  documentId: string,
): Promise<CounterpartPlan> {
  return withOrgTransaction(orgId, async () => {
    await assertTransactionsEnabled(db, orgId);
    const source = await intercompanyDocument(db, orgId, documentId);
    if (!source) {
      refuse(
        "this document is not intercompany: its customer or vendor does not represent another subsidiary",
      );
    }
    if (!scopeAllows(allowedSubsidiaryIds, [source.subsidiaryId, source.counterpartySubsidiaryId]))
      refuse("document not found", 404);
    if (source.status === "voided") refuse("a voided document has no counterpart");
    const existing = await livePairOf(db, orgId, documentId);
    if (existing)
      refuse(`${source.documentNumber} is already paired; open the pair to review it`, 409);
    const targetSide = source.side === "seller" ? "buyer" : "seller";
    const targetKind =
      targetSide === "buyer" ? BUYER_KIND[source.pairKind] : SELLER_KIND[source.pairKind];
    const representatives = await loadSubsidiaryRepresentatives(db, orgId, source.subsidiaryId);
    const targetPartyId =
      targetSide === "buyer" ? representatives?.vendorPartyId : representatives?.customerPartyId;
    const names = await db.execute<{ id: string; name: string }>(
      sql`
      select id, name from subsidiaries where org_id = ${orgId} and id in (${source.subsidiaryId}, ${source.counterpartySubsidiaryId})`,
      "objects",
    );
    const nameOf = (id: string) => names.find((row) => row.id === id)?.name ?? id;
    if (!targetPartyId) {
      refuse(
        `${nameOf(source.subsidiaryId)} has no representing ${targetSide === "buyer" ? "vendor" : "customer"}; set one in Setup → Accounting → Intercompany representing parties`,
      );
    }
    const vendorDefault =
      targetSide === "buyer"
        ? ((
            await db.execute<{ account_id: string | null }>(
              sql`
          select default_expense_account_id as account_id from vendor_roles
           where org_id = ${orgId} and party_id = ${targetPartyId}`,
              "objects",
            )
          )[0]?.account_id ?? null)
        : null;
    const lines = await db.execute<{
      line_number: number;
      item_id: string | null;
      description: string | null;
      quantity: string | null;
      unit: string | null;
      unit_price: string | null;
      amount: string;
      income_account_id: string | null;
      expense_account_id: string | null;
    }>(
      sql`
      select l.line_number, l.item_id, l.description, l.quantity::text as quantity, l.unit,
             l.unit_price::text as unit_price, l.amount::text as amount,
             i.income_account_id, i.expense_account_id
        from document_lines l
        left join items i on i.org_id = l.org_id and i.id = l.item_id
       where l.org_id = ${orgId} and l.document_id = ${documentId}
       order by l.line_number`,
      "objects",
    );
    if (lines.length === 0) refuse(`${source.documentNumber} has no lines to mirror`);
    const isOrder = source.pairKind === "order";
    const planned: CounterpartLine[] = lines.map((line) => {
      let accountId: string | null;
      if (targetSide === "buyer") {
        accountId = line.item_id
          ? isOrder
            ? null
            : (line.expense_account_id ?? vendorDefault)
          : vendorDefault;
        if (!accountId && !(isOrder && line.item_id)) {
          refuse(
            `line ${line.line_number} needs an expense account in ${nameOf(source.counterpartySubsidiaryId)}; set the representing vendor's default expense account or the item's expense account`,
          );
        }
      } else {
        accountId = line.item_id ? (isOrder ? null : line.income_account_id) : null;
        if (!accountId && !(isOrder && line.item_id)) {
          refuse(
            `line ${line.line_number} has no item with an income account to sell; add the line to the generated document by hand or give the item an income account`,
          );
        }
      }
      return {
        itemId: line.item_id,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unit_price,
        amount: fromUnits(toUnits(line.amount)),
        accountId,
      };
    });
    return {
      source,
      pairKind: source.pairKind,
      targetKind,
      targetSide,
      targetSubsidiaryId: source.counterpartySubsidiaryId,
      targetPartyId,
      currency: source.currency,
      documentDate: source.documentDate,
      memo: `Intercompany ${targetSide === "buyer" ? "purchase from" : "sale to"} ${nameOf(source.subsidiaryId)} — ${source.documentNumber}`,
      lines: planned,
    };
  });
}

/** The subsidiaries a party represents, by role (for the party record). */
export async function intercompanyRepresentationsOfParty(
  orgId: string,
  partyId: string,
): Promise<{ role: "customer" | "vendor"; subsidiaryId: string; subsidiaryName: string }[]> {
  if (!isUuid(partyId)) return [];
  const out: { role: "customer" | "vendor"; subsidiaryId: string; subsidiaryName: string }[] = [];
  for (const role of ["customer", "vendor"] as const) {
    const representation = await loadPartyRepresentation(db, orgId, partyId, role);
    if (representation)
      out.push({
        role,
        subsidiaryId: representation.subsidiaryId,
        subsidiaryName: representation.subsidiaryName,
      });
  }
  return out;
}
