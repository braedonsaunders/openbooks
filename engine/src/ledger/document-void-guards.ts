import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import {
  DocumentVoidError,
  PAYMENT_KINDS,
  carriedCreditAllocations,
  isLockNotAvailable,
} from "./document-void-shared.ts";

/** The transaction a void completes in. */
export type VoidTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The locked document row a completing void reads. */
export type VoidDocumentRow = Record<string, unknown>;

/**
 * Discover the source entry and all currently live application endpoints
 * before taking locks, then acquire the shared document → entry → line
 * protocol used by application writers and lock the document row in scope.
 * The locks hold through every later refusal check and the reversal.
 */
export async function lockVoidApplicationEvidence(
  tx: VoidTransaction,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<{
  doc: VoidDocumentRow;
  discoveredEntryId: string | null;
  lockedEvidence: Awaited<ReturnType<typeof lockApplicationEvidence>>;
}> {
  const discovered = (
    await tx.execute<{ posted_entry_id: string | null; kind: string; custom: unknown }>(
      sql`
        select posted_entry_id, kind, custom
          from documents
         where id = ${documentId} and org_id = ${orgId}
      `,
      "objects",
    )
  )[0];
  const discoveredEntryId = discovered?.posted_entry_id ?? null;
  // A payment's carried credit allocations are released with it below, so
  // their credit and target lines join the same evidence lock.
  const carriedCreditEndpoints =
    discovered && PAYMENT_KINDS.has(discovered.kind)
      ? carriedCreditAllocations(discovered.custom).flatMap((allocation) => [
          allocation.fromLineId,
          allocation.toLineId,
        ])
      : [];
  const endpointIds = discoveredEntryId
    ? (
        await tx.execute<{ id: string }>(
          sql`
            with source_lines as (
              select id from journal_lines
               where org_id = ${orgId} and entry_id = ${discoveredEntryId}
            ), related_lines as (
              select a.from_line_id as id
                from applications a
               where a.org_id = ${orgId} and a.unapplied_at is null
                 and a.to_line_id in (select id from source_lines)
              union
              select a.to_line_id as id
                from applications a
               where a.org_id = ${orgId} and a.unapplied_at is null
                 and a.from_line_id in (select id from source_lines)
            )
            select id from source_lines
            union
            select id from related_lines
          `,
          "objects",
        )
      )
        .map((row) => row.id)
        .concat(carriedCreditEndpoints)
    : [];
  let lockedEvidence: Awaited<ReturnType<typeof lockApplicationEvidence>>;
  try {
    lockedEvidence = await lockApplicationEvidence(
      tx,
      orgId,
      endpointIds,
      [documentId],
      discoveredEntryId ? [discoveredEntryId] : [],
      { nowait: true },
    );
  } catch (error) {
    if (isLockNotAvailable(error)) {
      throw new DocumentVoidError(
        "another application or posting is in flight — retry the void once it completes",
        409,
      );
    }
    throw error;
  }
  const locked = await tx.execute<Record<string, unknown>>(
    sql`
        select *
          from documents
         where id = ${documentId} and org_id = ${orgId}
         for update
      `,
    "objects",
  );
  const doc = locked[0];
  if (!doc) throw new DocumentVoidError("document not found");
  if (
    allowedSubsidiaryIds !== undefined &&
    !subsidiaryScopeAllows(allowedSubsidiaryIds, doc.subsidiary_id as string | null)
  ) {
    throw new ScopeNotFoundError();
  }
  return { doc, discoveredEntryId, lockedEvidence };
}

/** The posting and its live applications are exactly what was locked; otherwise the void retries. */
export async function refuseChangedVoidEvidence(
  tx: VoidTransaction,
  orgId: string,
  doc: VoidDocumentRow,
  discoveredEntryId: string | null,
  lockedEvidence: Awaited<ReturnType<typeof lockApplicationEvidence>>,
): Promise<void> {
  const currentEntryId = doc.posted_entry_id ? String(doc.posted_entry_id) : null;
  if (currentEntryId !== discoveredEntryId) {
    throw new DocumentVoidError(
      "the document posting changed while its void was being completed — retry",
      409,
    );
  }
  if (currentEntryId) {
    const liveEndpoints = (
      await tx.execute<{ id: string }>(
        sql`
          with source_lines as (
            select id from journal_lines
             where org_id = ${orgId} and entry_id = ${currentEntryId}
          ), related_lines as (
            select a.from_line_id as id
              from applications a
             where a.org_id = ${orgId} and a.unapplied_at is null
               and a.to_line_id in (select id from source_lines)
            union
            select a.to_line_id as id
              from applications a
             where a.org_id = ${orgId} and a.unapplied_at is null
               and a.from_line_id in (select id from source_lines)
          )
          select id from source_lines
          union
          select id from related_lines
        `,
        "objects",
      )
    ).map((row) => row.id);
    const lockedLineIds = new Set(lockedEvidence.lineIds);
    if (liveEndpoints.some((id) => !lockedLineIds.has(id))) {
      throw new DocumentVoidError(
        "an application was created while the void was being prepared — retry after it completes",
        409,
      );
    }
  }
}

// Downstream fence for every kind, posting or not (quotes, orders,
// shipments and receipts carry no entry): a document that feeds a live
// downstream document cannot be voided out from under it.
export async function refuseLiveDownstreamVoid(
  tx: VoidTransaction,
  orgId: string,
  documentId: string,
): Promise<void> {
  const downstream = await tx.execute<{ document_number: string }>(
    sql`
        select d2.document_number
          from document_links dl
          join documents d2 on d2.id = dl.to_document_id and d2.org_id = dl.org_id
         where dl.from_document_id = ${documentId} and dl.org_id = ${orgId}
           and d2.status in ('approved', 'posted')
           and dl.link_type <> 'pays'
         limit 1
      `,
    "objects",
  );
  if (downstream[0]) {
    throw new DocumentVoidError(
      `this transaction feeds ${downstream[0].document_number} — reverse the downstream transaction first`,
    );
  }
}

/** A retainer invoice with posted drawdowns keeps its recognition history. */
export async function refuseRetainerWithPostedDrawdowns(
  tx: VoidTransaction,
  orgId: string,
  documentId: string,
): Promise<void> {
  const linkedRetainer = (
    await tx.execute<{ id: string }>(
      sql`
          select id from res_retainers
           where org_id = ${orgId} and invoice_document_id = ${documentId}
           for update
        `,
      "objects",
    )
  )[0];
  if (linkedRetainer) {
    const postedDrawdown = (
      await tx.execute<{ id: string }>(
        sql`
            select id from res_retainer_drawdowns
             where org_id = ${orgId} and retainer_id = ${linkedRetainer.id} and state = 'posted'
             limit 1
          `,
        "objects",
      )
    )[0];
    if (postedDrawdown) {
      throw new DocumentVoidError(
        "this retainer invoice has posted drawdowns and cannot be voided without orphaning their recognition history — keep the invoice posted and correct the issue with an adjusting journal entry",
        409,
        "retainer-drawdowns-posted",
      );
    }
  }
}

/**
 * A bank-reconciled entry, or one with live payments or credits applied to it,
 * cannot be voided. The evidence locks already held keep any new application
 * from settling the entry while the void completes.
 */
export async function refuseSettledEntryVoid(
  tx: VoidTransaction,
  orgId: string,
  entryId: string,
): Promise<void> {
  const reconciled = await tx.execute(
    sql`
          select 1
            from reconciliation_matches rm
           where rm.org_id = ${orgId}
             and rm.journal_line_id in (
             select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
           )
           limit 1
        `,
    "objects",
  );
  if (reconciled.length > 0) {
    throw new DocumentVoidError(
      "this transaction is bank-reconciled — remove the reconciliation match before voiding",
    );
  }
  const incoming = await tx.execute(
    sql`
          select 1
            from applications a
           where a.org_id = ${orgId} and a.unapplied_at is null
             and a.to_line_id in (
               select id from journal_lines where entry_id = ${entryId} and org_id = ${orgId}
             )
           limit 1
        `,
    "objects",
  );
  if (incoming.length > 0) {
    throw new DocumentVoidError(
      "this transaction has live payments or credits applied to it — unapply them before voiding",
    );
  }
}

/** Live inventory or revenue-recognition subledger activity refuses with the remedy for what is present. */
export async function refuseDependentSubledgerVoid(
  tx: VoidTransaction,
  orgId: string,
  documentId: string,
  doc: VoidDocumentRow,
): Promise<void> {
  // A voided bill unwinds its own receipt movements above, so the
  // gate below must not trip on the unwound originals: movement rows
  // survive a kernel reversal, and only the reversal row proves the
  // stock went back. Other documents keep the existence rule.
  const billUnwindsInventory = String(doc.kind) === "vendor_bill";
  const dependentSubledger = await tx.execute<{ inventory: boolean; revenue: boolean }>(
    sql`
          select
            exists (
              select 1
                from inventory_movements movement
               where movement.org_id = ${orgId}
                 and movement.document_line_id in (
                 select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
               )
                 and (${billUnwindsInventory}::boolean = false or not exists (
                   select 1 from inventory_movements reversal
                    where reversal.org_id = movement.org_id
                      and reversal.reverses_movement_id = movement.id
                 ))
            ) as inventory,
            exists (
              select 1
                from performance_obligations obligation
               where obligation.org_id = ${orgId}
                 and obligation.document_line_id in (
                 select id from document_lines where document_id = ${documentId} and org_id = ${orgId}
               )
                 and obligation.status <> 'cancelled'
            ) as revenue
        `,
    "objects",
  );
  const hasInventoryActivity = dependentSubledger[0]?.inventory ?? false;
  const hasRevenueActivity = dependentSubledger[0]?.revenue ?? false;
  if (hasInventoryActivity || hasRevenueActivity) {
    // The queries above are existence-based: movement and obligation
    // rows survive a kernel reversal, so reversing the stock does not
    // unblock the void — the document stays posted. The refusal names
    // the remedy for the subledger actually present; revenue
    // cancellation cannot relieve stock.
    const revenueRemedy =
      "revenue contracts cancel from Revenue → contract → Cancel recognition (POST /api/revenue/cancel-recognition)";
    if (!hasInventoryActivity) {
      throw new DocumentVoidError(
        `this transaction has inventory or revenue-recognition subledger activity — use the dedicated return/cancellation workflow: ${revenueRemedy}`,
      );
    }
    const revenueClause = hasRevenueActivity
      ? ` Cancel open revenue recognition from Revenue → contract → Cancel recognition (POST /api/revenue/cancel-recognition).`
      : "";
    if (String(doc.kind) === "vendor_bill") {
      // Only actions that exist today are named, and the financial
      // and stock legs are kept distinct: an account-only vendor
      // credit (no stock lines) posts without inventory evidence and,
      // where cash is still due, applies toward the bill through a
      // vendor payment; Inventory Adjust removes the units at carried
      // cost. Both legs use the item's own inventory adjustment
      // account, so any difference between the credit and the carried
      // cost remains there as the residual. No receipt-selection
      // workflow and no reverse action are claimed.
      throw new DocumentVoidError(
        `this transaction has posted inventory receipt movements — the bill remains posted and cannot be voided. Correct the finances separately from the stock: post an account-only vendor credit (no stock lines) to the item's inventory adjustment account, and where cash is still due apply the credit toward the bill through a vendor payment; correct the stock separately with Inventory Adjust, which removes the units at carried cost against the same adjustment account. Any difference between the credit and the carried cost remains there as the residual.${revenueClause}`,
      );
    }
    throw new DocumentVoidError(
      `this transaction has posted inventory movements — it remains posted even after its stock movements are reversed; voiding cannot unwind the stock ledger.${revenueClause}`,
    );
  }
}

// Capitalized cost depends on this posting: an accepted asset proposal
// or a construction-in-progress link must be reversed first. Pending
// proposals need nothing here; the reversal voids them.
export async function refuseCapitalizedEntryVoid(
  tx: VoidTransaction,
  orgId: string,
  entryId: string,
): Promise<void> {
  const capitalized = (
    await tx.execute<{ accepted: boolean; linked: boolean }>(
      sql`
          select exists (select 1 from asset_proposals p
                          where p.org_id = ${orgId} and p.source_entry_id = ${entryId} and p.status = 'accepted') as accepted,
                 exists (select 1 from asset_cip_costs c
                          where c.org_id = ${orgId} and c.source_entry_id = ${entryId} and c.status = 'linked') as linked
        `,
      "objects",
    )
  )[0];
  if (capitalized?.accepted) {
    throw new DocumentVoidError(
      "this transaction was capitalized through an accepted fixed-asset proposal — reverse the acceptance from Fixed Assets → Proposals (Reverse acceptance), then void the transaction",
    );
  }
  if (capitalized?.linked) {
    throw new DocumentVoidError(
      "this transaction carries a cost linked to construction in progress — unlink the cost from Fixed Assets → Construction in progress, then void the transaction",
    );
  }
}
