import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * The ONE document-number allocator.
 *
 * Every generator — UI bills, scripts, imports, recurring, AP capture,
 * inventory, construction, subcontracts, subscriptions, payments, payroll,
 * CRM — must allocate through here, because `documents` enforces
 * UNIQUE (org_id, kind, document_number) WITHOUT any subsidiary column. A
 * document number is an organization-wide identity, so the sequence
 * configuration must guarantee organization-wide disjoint output: exactly one
 * `number_sequences` row per (org_id, document_kind), always the org-wide row
 * (`subsidiary_id IS NULL`, storage-enforced by
 * `number_sequences_org_wide_sequence` and the unique constraint). Independent
 * per-subsidiary rows would each hand out the same number and the second
 * document would die on the documents unique index mid-close.
 *
 * The single upsert is also the concurrency boundary: ON CONFLICT DO UPDATE
 * takes the row lock, so concurrent writers — any subsidiary, any entry point
 * — serialize on one counter and receive distinct, strictly increasing
 * numbers. `allocated_through` (maintained by the storage watermark trigger)
 * records the highest number ever issued so no edit can reset the counter
 * backward into reproducing an existing document number.
 */
/**
 * Canonical live prefixes per document kind — the exact prefixes the live
 * allocators hand the canonical allocator (sources: web/lib/document-kinds.ts
 * DOC_KINDS for the shared AP/AR/bank kinds; web/app/api/estimates,
 * sales-orders and purchase-orders routes for EST-/SO-/PO-;
 * web/app/api/expenses/draft/route.ts for EXP-;
 * engine/src/payables/ap-capture-service.ts for VCRED-;
 * engine/src/payments/payment-documents.ts for PAY-/RCPT-;
 * engine/src/ledger/journal-writes.ts for JE-).
 *
 * Needed only to tell a sample-issued number from a foreign one: the sample
 * generator writes vendor bills as BILL-*, invoices as INV-* and expense
 * reports as EXP-*, which ARE the live prefixes, while its one-off kinds
 * (FP-*, TM-*, CP-*, WOFF-*, ADV-VOID-*) never collide with any live output
 * and must not steer a sequence. Kinds absent here keep whatever row (and
 * prefix) the live allocator already created for them; kinds with no row and
 * no canonical-prefixed documents are left for the allocator's lazy insert.
 */
const CANONICAL_PREFIXES: Record<string, string> = {
  customer_invoice: "INV-",
  vendor_bill: "BILL-",
  vendor_credit: "VCRED-",
  customer_credit: "CM-",
  expense_report: "EXP-",
  journal: "JE-",
  vendor_payment: "PAY-",
  customer_payment: "RCPT-",
  quote: "EST-",
  sales_order: "SO-",
  purchase_order: "PO-",
};

export interface ReconciledSequence {
  documentKind: string;
  prefix: string;
  nextNumber: number;
}

/**
 * Sample-to-live sequence handoff.
 *
 * The sample generator numbers its documents from private in-memory counters
 * and never touches `number_sequences`, so a sample company whose invoices
 * reach INV-000157 would hand a live operator INV-00001 next. Call this once
 * when sample generation completes (and again after the template is cloned):
 * for every document kind, the org-wide counter is floored at the highest
 * number already issued under its prefix, so the next live allocation
 * continues the run instead of restarting it.
 *
 * Forward-only and history-preserving: existing rows move up or stay put
 * (the monotonic guard + watermark trigger enforce that in storage), row
 * prefixes are never changed, no document is renumbered, and one-off sample
 * prefixes (FP-, TM-, WOFF-, …) cannot steer a canonical sequence because
 * only the canonical prefix counts toward a kind's floor.
 */
export async function reconcileDocumentSequences(
  exec: SqlExecutor,
  orgId: string,
): Promise<ReconciledSequence[]> {
  const kinds = (await exec.execute<{ document_kind: string }>(sql`
    select distinct document_kind from (
      select document_kind from number_sequences where org_id = ${orgId}
      union
      select kind as document_kind from documents where org_id = ${orgId}
    ) kinds`)).rows.map((r) => r.document_kind);

  const reconciled: ReconciledSequence[] = [];
  for (const kind of kinds) {
    const existing = (await exec.execute<{ prefix: string; next_number: number }>(sql`
      select prefix, next_number from number_sequences
       where org_id = ${orgId} and document_kind = ${kind}`)).rows[0];
    const prefix = existing?.prefix ?? CANONICAL_PREFIXES[kind];
    if (!prefix) continue;
    const issued = (await exec.execute<{ mx: number }>(sql`
      select coalesce(max(substring(document_number from length(${prefix}) + 1)::bigint), 0) as mx
        from documents
       where org_id = ${orgId}
         and kind = ${kind}
         and starts_with(document_number, ${prefix})
         and substring(document_number from length(${prefix}) + 1) ~ '^[0-9]+$'`));
    const floor = Number(issued.rows[0]?.mx ?? 0);
    if (existing) {
      if (floor > existing.next_number) {
        await exec.execute(sql`
          update number_sequences set next_number = ${floor}
           where org_id = ${orgId} and document_kind = ${kind}`);
      }
      reconciled.push({ documentKind: kind, prefix, nextNumber: Math.max(existing.next_number, floor) });
    } else if (floor > 0) {
      await exec.execute(sql`
        insert into number_sequences (org_id, document_kind, prefix, next_number, allocated_through)
        values (${orgId}, ${kind}, ${prefix}, ${floor}, ${floor})`);
      reconciled.push({ documentKind: kind, prefix, nextNumber: floor });
    }
  }
  return reconciled;
}

export async function allocateDocumentNumber(
  exec: SqlExecutor,
  orgId: string,
  documentKind: string,
  prefix: string,
): Promise<string> {
  const seq = await exec.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, prefix)
    values (${orgId}, ${documentKind}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    where number_sequences.org_id = ${orgId}
    returning prefix, next_number, padding
  `);
  const s = seq.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}
