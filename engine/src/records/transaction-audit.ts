import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

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
  orgId: string,
): Promise<TransactionAuditSnapshot | null> {
  const result = (await runner.execute<{ snapshot: TransactionAuditSnapshot }>(sql`
    select jsonb_build_object(
      'document', to_jsonb(d),
      'lines', coalesce((
        select jsonb_agg(to_jsonb(dl) order by dl.line_number, dl.id)
          from document_lines dl
         where dl.document_id = d.id and dl.org_id = d.org_id
      ), '[]'::jsonb),
      'taxComponents', coalesce((
        select jsonb_agg(to_jsonb(tc) order by dl.line_number, tc.sequence, tc.id)
          from document_lines dl
          join document_line_tax_components tc on tc.document_line_id = dl.id and tc.org_id = dl.org_id
         where dl.document_id = d.id and dl.org_id = d.org_id
      ), '[]'::jsonb),
      'applications', coalesce((
        select jsonb_agg(to_jsonb(a) order by a.applied_on, a.id)
          from applications a
         where a.org_id = d.org_id and e.id is not null and (
           a.from_line_id in (
             select jl.id from journal_lines jl where jl.entry_id = e.id and jl.org_id = e.org_id
           )
           or a.to_line_id in (
             select jl.id from journal_lines jl where jl.entry_id = e.id and jl.org_id = e.org_id
           )
         )
      ), '[]'::jsonb),
      'glImpact', case when e.id is null then null else jsonb_build_object(
        'entry', to_jsonb(e),
        'lines', coalesce((
          select jsonb_agg(to_jsonb(jl) order by jl.line_number, jl.id)
            from journal_lines jl
           where jl.entry_id = e.id and jl.org_id = e.org_id
        ), '[]'::jsonb),
        'reversals', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'entry', to_jsonb(reversal),
              'lines', coalesce((
                select jsonb_agg(to_jsonb(reversal_line) order by reversal_line.line_number, reversal_line.id)
                  from journal_lines reversal_line
                 where reversal_line.entry_id = reversal.id and reversal_line.org_id = reversal.org_id
              ), '[]'::jsonb)
            )
            order by reversal.posting_date, reversal.id
          )
            from journal_entries reversal
           where reversal.reverses_entry_id = e.id and reversal.org_id = e.org_id
        ), '[]'::jsonb)
      ) end
    ) as snapshot
      from documents d
     left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
     where d.id = ${documentId} and d.org_id = ${orgId}
     limit 1
     for update of d
  `));
  return result.rows[0]?.snapshot ?? null;
}

/**
 * Write stamps every document UPDATE bumps, even when the save changes
 * nothing material: the display timestamp, the actor, and the optimistic-
 * concurrency counter. They are evidence of a write, not of a change, so
 * the no-change comparison ignores them.
 */
const VOLATILE_SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
  "updated_at",
  "updated_by",
  "revision_seq",
]);

/**
 * Surrogate identity the line writer re-mints on every wholesale line
 * replace: a save that rewrites identical lines carries new row ids but no
 * new content. Line content (line number and every content column) fully
 * describes the material state, so the comparison ignores the minted ids
 * and the component linkage that follows them.
 */
const LINE_IDENTITY_KEYS: ReadonlySet<string> = new Set(["id", "document_line_id"]);

function comparableSnapshotRow(
  row: Record<string, unknown>,
  stripped: ReadonlySet<string> = VOLATILE_SNAPSHOT_KEYS,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (stripped.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function comparableSnapshot(snapshot: TransactionAuditSnapshot): unknown {
  const lineStripped = new Set([...VOLATILE_SNAPSHOT_KEYS, ...LINE_IDENTITY_KEYS]);
  return {
    document: comparableSnapshotRow(snapshot.document),
    lines: snapshot.lines.map((line) => comparableSnapshotRow(line, lineStripped)),
    taxComponents: snapshot.taxComponents.map((component) => comparableSnapshotRow(component, lineStripped)),
    applications: snapshot.applications,
    glImpact: snapshot.glImpact,
  };
}

/**
 * Whether a save changed anything the audit trail evidences. Snapshots come
 * from the same transaction, so any remaining difference is this save's own
 * write — a rewrite of identical lines still counts as no change. Callers
 * skip the audit insert on true, so a no-op save leaves no 'Updated' row.
 */
export function transactionSnapshotsMatch(
  before: TransactionAuditSnapshot,
  after: TransactionAuditSnapshot,
): boolean {
  return JSON.stringify(comparableSnapshot(before)) === JSON.stringify(comparableSnapshot(after));
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
