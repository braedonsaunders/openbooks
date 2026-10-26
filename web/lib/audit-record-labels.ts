import "server-only";

import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/database";

/** How an audited record reads in the log: its identifying text and, where a date identifies it, that civil date. */
export interface AuditRecordLabel {
  label: string | null;
  on: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The display label of each audited record family, read from the record
 * itself within the organization: a security by its number, a class or plan
 * by its code and name, a run by its legal entity and through date, a job
 * by its number. Each source selects `id`, `label` and `on` for the ids
 * given; a family with no source keeps the shortened row id.
 */
const SOURCES: Record<string, (orgId: string, ids: SQL) => SQL> = {
  documents: (orgId, ids) =>
    sql`select r.id::text as id, r.document_number as label, null::text as on_date from documents r where r.org_id = ${orgId} and r.id in (${ids})`,
  parties: (orgId, ids) =>
    sql`select r.id::text as id, r.display_name as label, null::text as on_date from parties r where r.org_id = ${orgId} and r.id in (${ids})`,
  users: (orgId, ids) =>
    sql`select r.id::text as id, coalesce(r.name, r.email) as label, null::text as on_date from users r where r.org_id = ${orgId} and r.id in (${ids})`,
  accounts: (orgId, ids) =>
    sql`select r.id::text as id, concat_ws(' · ', r.number, r.name) as label, null::text as on_date from accounts r where r.org_id = ${orgId} and r.id in (${ids})`,
  items: (orgId, ids) =>
    sql`select r.id::text as id, concat_ws(' · ', r.code, r.name) as label, null::text as on_date from items r where r.org_id = ${orgId} and r.id in (${ids})`,
  subsidiaries: (orgId, ids) =>
    sql`select r.id::text as id, r.name as label, null::text as on_date from subsidiaries r where r.org_id = ${orgId} and r.id in (${ids})`,

  equity_securities: (orgId, ids) =>
    sql`select r.id::text as id, r.security_number as label, null::text as on_date from equity_securities r where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_share_classes: (orgId, ids) =>
    sql`select r.id::text as id, concat_ws(' · ', r.code, r.name) as label, null::text as on_date from equity_share_classes r where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_plans: (orgId, ids) =>
    sql`select r.id::text as id, concat_ws(' · ', r.code, r.name) as label, null::text as on_date from equity_plans r where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_financing_rounds: (orgId, ids) =>
    sql`select r.id::text as id, r.name as label, null::text as on_date from equity_financing_rounds r where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_splits: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, c.code as label, r.effective_on::text as on_date from equity_splits r
    left join equity_share_classes c on c.org_id = r.org_id and c.id = r.share_class_id where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_account_policies: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, s.name as label, r.effective_from::text as on_date from equity_account_policies r
    left join subsidiaries s on s.org_id = r.org_id and s.id = r.subsidiary_id where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_compensation_runs: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, s.name as label, r.through_date::text as on_date from equity_compensation_runs r
    left join subsidiaries s on s.org_id = r.org_id and s.id = r.subsidiary_id where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_interest_runs: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, s.name as label, r.through_date::text as on_date from equity_interest_runs r
    left join subsidiaries s on s.org_id = r.org_id and s.id = r.subsidiary_id where r.org_id = ${orgId} and r.id in (${ids})`,
  equity_action_requests: (orgId, ids) =>
    sql`select r.id::text as id, r.subject_label as label, r.effective_on::text as on_date from equity_action_requests r where r.org_id = ${orgId} and r.id in (${ids})`,

  pos_registers: (orgId, ids) =>
    sql`select r.id::text as id, concat_ws(' · ', r.code, r.name) as label, null::text as on_date from pos_registers r where r.org_id = ${orgId} and r.id in (${ids})`,
  pos_sessions: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', g.code, r.session_number::text) as label, r.business_date::text as on_date from pos_sessions r
    left join pos_registers g on g.org_id = r.org_id and g.id = r.register_id where r.org_id = ${orgId} and r.id in (${ids})`,

  service_requests: (orgId, ids) =>
    sql`select r.id::text as id, r.request_number as label, null::text as on_date from service_requests r where r.org_id = ${orgId} and r.id in (${ids})`,
  service_jobs: (orgId, ids) =>
    sql`select r.id::text as id, r.job_number as label, null::text as on_date from service_jobs r where r.org_id = ${orgId} and r.id in (${ids})`,
  service_agreements: (orgId, ids) =>
    sql`select r.id::text as id, r.agreement_number as label, null::text as on_date from service_agreements r where r.org_id = ${orgId} and r.id in (${ids})`,
  service_agreement_versions: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, a.agreement_number as label, r.effective_from::text as on_date from service_agreement_versions r
    left join service_agreements a on a.org_id = r.org_id and a.id = r.agreement_id where r.org_id = ${orgId} and r.id in (${ids})`,
  service_visits: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, coalesce(j.job_number, q.request_number, a.agreement_number) as label, r.occurs_on::text as on_date from service_visits r
    left join service_jobs j on j.org_id = r.org_id and j.id = r.job_id
    left join service_requests q on q.org_id = r.org_id and q.id = r.request_id
    left join service_agreements a on a.org_id = r.org_id and a.id = r.agreement_id
    where r.org_id = ${orgId} and r.id in (${ids})`,
  service_quotes: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, d.document_number as label, null::text as on_date from service_quotes r
    left join documents d on d.org_id = r.org_id and d.id = r.quote_document_id where r.org_id = ${orgId} and r.id in (${ids})`,
  service_job_lines: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', j.job_number, r.description) as label, null::text as on_date from service_job_lines r
    left join service_jobs j on j.org_id = r.org_id and j.id = r.job_id where r.org_id = ${orgId} and r.id in (${ids})`,
  service_job_deposits: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, coalesce(d.document_number, j.job_number) as label, null::text as on_date from service_job_deposits r
    left join documents d on d.org_id = r.org_id and d.id = r.payment_document_id
    left join service_jobs j on j.org_id = r.org_id and j.id = r.job_id where r.org_id = ${orgId} and r.id in (${ids})`,
  service_billings: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, coalesce(d.document_number, j.job_number) as label, null::text as on_date from service_billings r
    left join documents d on d.org_id = r.org_id and d.id = r.invoice_document_id
    left join service_jobs j on j.org_id = r.org_id and j.id = r.job_id where r.org_id = ${orgId} and r.id in (${ids})`,
  service_visit_parts: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', coalesce(j.job_number, q.request_number), i.code) as label, v.occurs_on::text as on_date from service_visit_parts r
    left join service_visits v on v.org_id = r.org_id and v.id = r.visit_id
    left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
    left join service_requests q on q.org_id = v.org_id and q.id = v.request_id
    left join items i on i.org_id = r.org_id and i.id = r.item_id where r.org_id = ${orgId} and r.id in (${ids})`,
  service_visit_signatures: (orgId, ids) =>
    sql`select r.id::text as id, r.signer_name as label, null::text as on_date from service_visit_signatures r where r.org_id = ${orgId} and r.id in (${ids})`,
  service_visit_signature_requests: (orgId, ids) =>
    sql`select r.id::text as id, r.recipient as label, null::text as on_date from service_visit_signature_requests r where r.org_id = ${orgId} and r.id in (${ids})`,
  service_dispatch_policies: (orgId, ids) =>
    sql`select r.id::text as id, null::text as label, r.effective_from::text as on_date from service_dispatch_policies r where r.org_id = ${orgId} and r.id in (${ids})`,
  signature_requests: (orgId, ids) =>
    sql`select r.id::text as id, coalesce(r.signer_name, r.signer_email) as label, null::text as on_date from signature_requests r where r.org_id = ${orgId} and r.id in (${ids})`,

  schedule_boards: (orgId, ids) =>
    sql`select r.id::text as id, concat_ws(' · ', r.code, r.name) as label, null::text as on_date from schedule_boards r where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_patterns: (orgId, ids) =>
    sql`select r.id::text as id, concat_ws(' · ', r.code, r.name) as label, null::text as on_date from schedule_patterns r where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_calendars: (orgId, ids) =>
    sql`select r.id::text as id, r.name as label, null::text as on_date from schedule_calendars r where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_entries: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', b.code, p.display_name) as label, r.starts_on::text as on_date from schedule_entries r
    left join schedule_boards b on b.org_id = r.org_id and b.id = r.board_id
    left join parties p on p.org_id = r.org_id and p.id = r.worker_party_id where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_entry_requests: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', b.code, p.display_name) as label, null::text as on_date from schedule_entry_requests r
    left join schedule_boards b on b.org_id = r.org_id and b.id = r.board_id
    left join parties p on p.org_id = r.org_id and p.id = r.worker_party_id where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_pattern_assignments: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', t.code, p.display_name) as label, r.effective_from::text as on_date from schedule_pattern_assignments r
    left join schedule_patterns t on t.org_id = r.org_id and t.id = r.pattern_id
    left join parties p on p.org_id = r.org_id and p.id = r.worker_party_id where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_pattern_exceptions: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', t.code, p.display_name) as label, r.occurs_on::text as on_date from schedule_pattern_exceptions r
    left join schedule_pattern_assignments s on s.org_id = r.org_id and s.id = r.assignment_id
    left join schedule_patterns t on t.org_id = s.org_id and t.id = s.pattern_id
    left join parties p on p.org_id = s.org_id and p.id = s.worker_party_id where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_distributions: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, b.code as label, r.from_date::text as on_date from schedule_distributions r
    left join schedule_boards b on b.org_id = r.org_id and b.id = r.board_id where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_resource_recipients: (
    orgId,
    ids,
  ) => sql`select r.id::text as id, concat_ws(' · ', b.code, p.display_name) as label, null::text as on_date from schedule_resource_recipients r
    left join schedule_boards b on b.org_id = r.org_id and b.id = r.board_id
    left join parties p on p.org_id = r.org_id and p.id = r.party_id where r.org_id = ${orgId} and r.id in (${ids})`,
  schedule_source_records: (orgId, ids) =>
    sql`select r.id::text as id, r.label as label, r.on_date::text as on_date from schedule_source_records r where r.org_id = ${orgId} and r.id in (${ids})`,
};

/** The record families whose audit rows read by their display label. */
export const LABELLED_AUDIT_TABLES: readonly string[] = Object.keys(SOURCES);

/** The label source of one family, for the schema conformance test. */
export function auditRecordLabelSource(
  table: string,
  orgId: string,
  ids: readonly string[],
): SQL | null {
  const source = SOURCES[table];
  const valid = ids.filter((id) => UUID.test(id));
  if (!source || valid.length === 0) return null;
  return source(
    orgId,
    sql.join(
      valid.map((id) => sql`${id}::uuid`),
      sql`, `,
    ),
  );
}

/**
 * The display label of each audited record on a page, keyed `table:rowId`.
 * Records of a family with no source, or no longer present, are absent: the
 * log then shows their shortened row id.
 */
export async function auditRecordLabels(
  orgId: string,
  refs: readonly { table: string; rowId: string }[],
): Promise<Map<string, AuditRecordLabel>> {
  const byTable = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!SOURCES[ref.table]) continue;
    const ids = byTable.get(ref.table) ?? new Set<string>();
    ids.add(ref.rowId);
    byTable.set(ref.table, ids);
  }
  const labels = new Map<string, AuditRecordLabel>();
  await Promise.all(
    [...byTable].map(async ([table, ids]) => {
      const query = auditRecordLabelSource(table, orgId, [...ids]);
      if (!query) return;
      const rows = await db.execute<{ id: string; label: string | null; on_date: string | null }>(
        query,
        "objects",
      );
      for (const row of rows) {
        const label = row.label?.trim() ? row.label.trim() : null;
        if (label !== null || row.on_date !== null)
          labels.set(`${table}:${row.id}`, { label, on: row.on_date });
      }
    }),
  );
  return labels;
}
