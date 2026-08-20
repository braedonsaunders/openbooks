import { sql } from "drizzle-orm";
import { db } from "./db.ts";

type Runner = Pick<typeof db, "execute">;

/**
 * Point-in-time evidence for one business transaction. The document and its
 * lines are the editable business record; glImpact is the currently
 * materialized accounting projection. Keeping both sides lets the audit log
 * show the same old/new GL impact that operators expect from a mutable-open-
 * period accounting system.
 */
export interface TransactionAuditSnapshot {
  document: Record<string, unknown>;
  lines: Record<string, unknown>[];
  taxComponents: Record<string, unknown>[];
  applications: Record<string, unknown>[];
  glImpact: {
    entry: Record<string, unknown>;
    lines: Record<string, unknown>[];
    reversals: Array<{
      entry: Record<string, unknown>;
      lines: Record<string, unknown>[];
    }>;
  } | null;
}

export interface TransactionAuditChanges {
  mode: "record_update" | "record_post" | "transaction_void" | "transaction_delete";
  source: string;
  reason?: string;
  before: TransactionAuditSnapshot;
  after: TransactionAuditSnapshot | null;
}

/** Capture the document, lines, and complete current GL impact in one query. */
export async function captureTransactionAuditSnapshot(
  runner: Runner,
  documentId: string,
): Promise<TransactionAuditSnapshot | null> {
  const result = (await runner.execute<{ snapshot: TransactionAuditSnapshot }>(sql`
    select jsonb_build_object(
      'document', to_jsonb(d),
      'lines', coalesce((
        select jsonb_agg(to_jsonb(dl) order by dl.line_number, dl.id)
          from document_lines dl
         where dl.document_id = d.id
      ), '[]'::jsonb),
      'taxComponents', coalesce((
        select jsonb_agg(to_jsonb(tc) order by dl.line_number, tc.sequence, tc.id)
          from document_lines dl
          join document_line_tax_components tc on tc.document_line_id = dl.id
         where dl.document_id = d.id
      ), '[]'::jsonb),
      'applications', coalesce((
        select jsonb_agg(to_jsonb(a) order by a.applied_on, a.id)
          from applications a
         where e.id is not null and (
           a.from_line_id in (
             select jl.id from journal_lines jl where jl.entry_id = e.id
           )
           or a.to_line_id in (
             select jl.id from journal_lines jl where jl.entry_id = e.id
           )
         )
      ), '[]'::jsonb),
      'glImpact', case when e.id is null then null else jsonb_build_object(
        'entry', to_jsonb(e),
        'lines', coalesce((
          select jsonb_agg(to_jsonb(jl) order by jl.line_number, jl.id)
            from journal_lines jl
           where jl.entry_id = e.id
        ), '[]'::jsonb),
        'reversals', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'entry', to_jsonb(reversal),
              'lines', coalesce((
                select jsonb_agg(to_jsonb(reversal_line) order by reversal_line.line_number, reversal_line.id)
                  from journal_lines reversal_line
                 where reversal_line.entry_id = reversal.id
              ), '[]'::jsonb)
            )
            order by reversal.posting_date, reversal.id
          )
            from journal_entries reversal
           where reversal.reverses_entry_id = e.id
        ), '[]'::jsonb)
      ) end
    ) as snapshot
      from documents d
     left join journal_entries e on e.id = d.posted_entry_id
     where d.id = ${documentId}
     limit 1
     for update of d
  `));
  return result.rows[0]?.snapshot ?? null;
}

export function buildTransactionAuditChanges(input: {
  mode: TransactionAuditChanges["mode"];
  source: string;
  reason?: string;
  before: TransactionAuditSnapshot;
  after: TransactionAuditSnapshot | null;
}): TransactionAuditChanges {
  return {
    mode: input.mode,
    source: input.source,
    ...(input.reason ? { reason: input.reason } : {}),
    before: input.before,
    after: input.after,
  };
}

/**
 * Persist immutable transaction evidence inside the caller's transaction.
 * actorId is null for source-mirror/system changes; the source remains explicit
 * in the evidence envelope.
 */
export async function recordTransactionAudit(
  runner: Runner,
  input: {
    orgId: string;
    documentId: string;
    action: "update" | "delete" | "post" | "void";
    actorId?: string | null;
    source: string;
    reason?: string;
    before: TransactionAuditSnapshot;
    after: TransactionAuditSnapshot | null;
  },
): Promise<void> {
  const changes = buildTransactionAuditChanges({
    mode: input.action === "delete"
      ? "transaction_delete"
      : input.action === "void"
        ? "transaction_void"
      : input.action === "post"
        ? "record_post"
        : "record_update",
    source: input.source,
    reason: input.reason,
    before: input.before,
    after: input.after,
  });
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${input.orgId}, 'documents', ${input.documentId}, ${input.action},
            ${JSON.stringify(changes)}::jsonb, ${input.actorId ?? null}, ${input.source})
  `);
}
