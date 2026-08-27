import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";

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
