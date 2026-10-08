import { sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";

/**
 * Data masking — the transform layer applied inline during the clone SELECT so
 * a masked sandbox never contains production PII. Because it runs as part of the
 * copy it costs no extra pass. Transforms are deterministic off the row id so a value
 * masks the same way on every refresh (stable test data) while being
 * irreversible in the sandbox.
 */

export type MaskTransform =
  | "faker_name"
  | "faker_email"
  | "faker_phone"
  | "redact"
  | "hash"
  | "jitter_amount"
  | "null_out"
  | "reseal_secret";

/** The typed "no value" a NOT NULL column receives when its policy removes the
 * value: masking must never fail a clone on a NOT NULL constraint, and it must
 * never leave the production value behind. Supported deliberately narrowly —
 * an unsupported type is a policy error, not something to guess around. */
function emptyValueSql(col: string, column: { udtName: string }): string {
  switch (column.udtName) {
    case "jsonb":
    case "json":
      return `'{}'::${column.udtName}`;
    case "text":
    case "varchar":
    case "bpchar":
      return `''`;
    default:
      throw new Error(
        `masking policy for NOT NULL column "${col}" (${column.udtName}) cannot remove the value: unsupported type`,
      );
  }
}

/** SQL expression that rewrites `col` under `transform`. `idExpr` is the row's
 * stable seed for deterministic output (usually the `id` column). `column`
 * (type + nullability) lets value-removing transforms honour NOT NULL. */
export function maskExpr(
  col: string,
  transform: MaskTransform,
  idExpr = "id",
  column?: { udtName: string; isNullable: boolean; tableName?: string },
): string {
  const q = `"${col}"`;
  const removed = column && !column.isNullable ? emptyValueSql(col, column) : "null";
  switch (transform) {
    case "faker_name":
      return `('Contact ' || upper(substr(md5(${idExpr}::text), 1, 6)))`;
    case "faker_email":
      return `(substr(md5(${idExpr}::text), 1, 12) || '@sandbox.invalid')`;
    case "faker_phone":
      return `('+1555' || lpad(((abs(hashtext(${idExpr}::text)) % 9000000) + 1000000)::text, 7, '0'))`;
    case "redact":
      return `(case when ${q} is null then null else 'REDACTED' end)`;
    case "hash":
      return `(case when ${q} is null then null else md5(${q}::text) end)`;
    case "jitter_amount":
      // Deterministic ±50% jitter, preserves sign and numeric type.
      return `(case when ${q} is null then null else round(${q} * (0.5 + (abs(hashtext(${idExpr}::text)) % 1000) / 1000.0), 4) end)`;
    case "null_out":
      // An approved override must retain the presence of its reason alongside
      // its approver and timestamp. Remove the prose without fabricating a
      // missing approval or breaking the existing evidence constraint.
      if (column?.tableName === "hrm_benefit_enrollment_terms" && col === "override_reason") {
        return `(case when ${q} is null then null else 'REDACTED' end)`;
      }
      // Historical compensation cycles require a source key and an object
      // together. Remove the employee evidence while retaining its presence;
      // native cycles without source evidence must remain without it.
      if (column?.tableName === "hrm_comp_cycles" && col === "source_evidence" && column.udtName === "jsonb") {
        return `(case when ${q} is null then null else '{"redacted":true}'::jsonb end)`;
      }
      // information_return_filings_finalized requires payer_snapshot <> '{}'
      // on finalized/filed rows. Emptying the object would refuse the clone
      // INSERT and leave production tax ids in the sandbox if the operator
      // retried unmasked. A tombstone removes the identifiers and still
      // satisfies the check. A new named transform would also need the
      // masking_policies enum in schema/src/sandboxes.ts.
      if (col === "payer_snapshot" && (column?.udtName === "jsonb" || column?.udtName === "json")) {
        return `'{"redacted":true}'::${column.udtName}`;
      }
      return removed;
    case "reseal_secret":
      // Can't re-encrypt in SQL; null = "unconfigured", the safe sandbox state.
      return removed;
  }
}

export interface MaskingPolicy {
  tableName: string;
  columnName: string;
  transform: MaskTransform;
}

type MaskingPolicyRow = Record<string, unknown> & {
  table_name: string; column_name: string; transform: MaskTransform;
}

/** Load active masking policies for a production org as table → column → transform. */
export async function loadMaskingPolicies(
  prodOrgId: string,
): Promise<Map<string, Map<string, MaskTransform>>> {
  const res = await db.execute<MaskingPolicyRow>(sql`
    select table_name, column_name, transform
      from masking_policies
     where org_id = ${prodOrgId} and is_active = true`);
  const map = new Map<string, Map<string, MaskTransform>>();
  for (const r of res.rows) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Map());
    map.get(r.table_name)!.set(r.column_name, r.transform);
  }
  return map;
}

/** High-confidence default policies every org receives. Columns that don't
 * exist in the schema are skipped by the clone generator, so a bad guess is
 * harmless. Beyond contact PII this covers the identifiers a masked sandbox
 * must never carry: bank routing + last-four, taxpayer identification (TIN
 * ciphertext, last four, type) on vendor and information-return rows, employee
 * SIN ciphertext and last-three, the frozen information-return recipient
 * snapshot (name/TIN/address at compute time), the frozen payer snapshot
 * (org/subsidiary tax registrations at finalize time), and the party /
 * legal-entity tax registrations. The org row's own tax ids are not cloned
 * at all; createSandbox/refreshSandbox blank them for masked sandboxes.
 *
 * User rows remain present so the production login can act as its deterministic
 * sandbox counterpart, but their contact identity and password credential are
 * masked just like business PII. Sandbox access is established by the home
 * session, so an empty password hash does not make the environment unusable.
 *
 * Exported for the PII inventory test (pii-inventory.integration.test.ts),
 * which derives every text/bytea/jsonb column of every cloned table and
 * fails unless each is masked here or explicitly allow-listed as
 * non-personal. Add a policy there before allow-listing anyone's identity. */
export const DEFAULT_POLICIES: MaskingPolicy[] = [
  { tableName: "schedule_source_records", columnName: "source_system", transform: "hash" },
  { tableName: "schedule_source_records", columnName: "source_dataset", transform: "hash" },
  { tableName: "schedule_source_records", columnName: "source_key", transform: "hash" },
  { tableName: "schedule_source_records", columnName: "source_payload", transform: "null_out" },
  { tableName: "schedule_source_records", columnName: "label", transform: "redact" },
  { tableName: "schedule_source_records", columnName: "source_result", transform: "redact" },
  { tableName: "schedule_source_records", columnName: "source_notes", transform: "redact" },
  { tableName: "schedule_source_records", columnName: "reason", transform: "redact" },
  { tableName: "hrm_comp_cycles", columnName: "source_key", transform: "hash" },
  { tableName: "hrm_comp_cycles", columnName: "source_evidence", transform: "null_out" },
  // Checklist responses are employee-authored evidence; publication reasons may name people.
  { tableName: "hrm_process_steps", columnName: "response", transform: "null_out" },
  { tableName: "hrm_process_template_versions", columnName: "reason", transform: "redact" },
  // Sales target names, reasons and authored coverage can contain personal
  // details. Published definitions are removed from masked sandboxes so
  // routing cannot act on a partially anonymized definition.
  { tableName: "crm_sales_quotas", columnName: "name", transform: "redact" },
  { tableName: "crm_sales_quotas", columnName: "reason", transform: "redact" },
  { tableName: "crm_sales_evidence", columnName: "source_number", transform: "hash" },
  { tableName: "crm_sales_territories", columnName: "geography", transform: "null_out" },
  { tableName: "addresses", columnName: "longitude", transform: "null_out" },
  { tableName: "addresses", columnName: "latitude", transform: "null_out" },
  { tableName: "addresses", columnName: "location_verified_at", transform: "null_out" },
  { tableName: "addresses", columnName: "location_verified_by", transform: "null_out" },
  { tableName: "rma_documents", columnName: "rejection_reason", transform: "redact" },
  { tableName: "party_bank_accounts", columnName: "account_number_encrypted", transform: "reseal_secret" },
  { tableName: "party_bank_accounts", columnName: "account_last_four", transform: "null_out" },
  { tableName: "party_bank_accounts", columnName: "routing", transform: "null_out" },
  // D2b: corporate card labels read "Visa …4821 — K. Laroche": the holder
  // name rides in display text even though holder_party_id points at a
  // masked party. Fake the label, null the last four like every other one.
  // The network brand ("Visa") stays: it identifies nobody.
  { tableName: "payment_cards", columnName: "label", transform: "faker_name" },
  { tableName: "payment_cards", columnName: "last_four", transform: "null_out" },
  // Stored autopay methods carry the same card tail as corporate cards: null
  // it like every other last four. The brand ("Visa") stays allow-listed —
  // it identifies nobody — as do the opaque provider customer/method ids.
  { tableName: "customer_payment_methods", columnName: "last4", transform: "null_out" },
  { tableName: "parties", columnName: "email", transform: "faker_email" },
  { tableName: "parties", columnName: "display_name", transform: "faker_name" },
  { tableName: "parties", columnName: "legal_name", transform: "faker_name" },
  { tableName: "parties", columnName: "phone", transform: "faker_phone" },
  { tableName: "parties", columnName: "tax_ids", transform: "null_out" },
  { tableName: "usage_records", columnName: "distinct_key", transform: "hash" },
  { tableName: "usage_records", columnName: "reversal_reason", transform: "redact" },
  // SaaS normalization operator prose and evidence may name people and carry
  // request detail: redact the text, empty the JSONB. Currency, source,
  // status, hash and version columns stay: enumerations and digests that
  // identify nobody.
  { tableName: "saas_metrics_normalization_requests", columnName: "reason", transform: "redact" },
  { tableName: "saas_metrics_normalization_requests", columnName: "failure", transform: "redact" },
  { tableName: "saas_metrics_normalization_requests", columnName: "remedy", transform: "redact" },
  { tableName: "saas_metrics_normalization_requests", columnName: "progress", transform: "null_out" },
  { tableName: "saas_metrics_normalization_requests", columnName: "result", transform: "null_out" },
  { tableName: "saas_metrics_fx_evidence", columnName: "evidence", transform: "null_out" },
  { tableName: "saas_metrics_monthly", columnName: "normalization_evidence", transform: "null_out" },
  { tableName: "saas_metrics_facts_monthly", columnName: "normalization_evidence", transform: "null_out" },
  { tableName: "saas_metrics_cohort_monthly", columnName: "normalization_evidence", transform: "null_out" },
  // 0195: candidate PII masks exactly like parties (a prospect's contact
  // identity is as sensitive as a worker's). Columns absent from the schema
  // are skipped by the clone generator, so ordering with the migration is
  // safe either way.
  { tableName: "hrm_candidates", columnName: "display_name", transform: "faker_name" },
  { tableName: "hrm_candidates", columnName: "email", transform: "faker_email" },
  { tableName: "hrm_candidates", columnName: "phone", transform: "faker_phone" },
  // D2b: interviewer notes assess a named person in free text — redact the
  // prose like review answers, not just the identity columns above.
  { tableName: "hrm_candidates", columnName: "notes", transform: "redact" },
  // D2b: goal-update notes are person-tied prose; the progress percent (a
  // number, out of the text inventory) stays testable.
  { tableName: "hrm_goal_updates", columnName: "note", transform: "redact" },
  // D2b: feedback context is schemaless JSON that can carry anything the
  // requester attached — empty it (NOT NULL jsonb nulls to '{}').
  { tableName: "hrm_feedback", columnName: "context", transform: "null_out" },
  // HR-8: covered-dependent names are PII like party display names.
  { tableName: "hrm_benefit_dependents", columnName: "display_name", transform: "faker_name" },
  // Award proof and free text can identify employees or external recipients.
  { tableName: "hrm_benefit_awards", columnName: "evidence", transform: "null_out" },
  { tableName: "hrm_benefit_awards", columnName: "program_snapshot", transform: "null_out" },
  { tableName: "hrm_benefit_awards", columnName: "source_snapshot", transform: "null_out" },
  // Election evidence may contain employee source records and personal explanations.
  { tableName: "hrm_benefit_enrollment_terms", columnName: "provenance", transform: "null_out" },
  { tableName: "hrm_benefit_enrollment_terms", columnName: "source_decimal", transform: "null_out" },
  { tableName: "hrm_benefit_enrollment_terms", columnName: "override_reason", transform: "null_out" },
  { tableName: "hrm_benefit_contribution_rules", columnName: "provenance", transform: "null_out" },
  { tableName: "hrm_benefit_contribution_rules", columnName: "source_decimal", transform: "null_out" },
  { tableName: "hrm_benefit_enrollments", columnName: "submission_snapshot", transform: "null_out" },
  { tableName: "hrm_benefit_enrollments", columnName: "decision_snapshot", transform: "null_out" },
  { tableName: "pay_run_benefit_allocations", columnName: "source_snapshot", transform: "null_out" },
  { tableName: "pay_runs", columnName: "benefit_source_snapshot", transform: "null_out" },
  { tableName: "payroll_service_credits", columnName: "source_snapshot", transform: "null_out" },
  { tableName: "payroll_vacation_terms", columnName: "source_snapshot", transform: "null_out" },
  { tableName: "payroll_service_credits", columnName: "reason", transform: "redact" },
  { tableName: "payroll_vacation_terms", columnName: "reason", transform: "redact" },
  { tableName: "hrm_benefit_awards", columnName: "decision_snapshot", transform: "null_out" },
  { tableName: "hrm_benefit_awards", columnName: "external_ref", transform: "hash" },
  { tableName: "hrm_benefit_awards", columnName: "source_key", transform: "hash" },
  { tableName: "hrm_benefit_awards", columnName: "void_reason", transform: "redact" },
  { tableName: "hrm_benefit_award_events", columnName: "reason", transform: "redact" },
  { tableName: "hrm_benefit_program_members", columnName: "role", transform: "redact" },
  // Policy labels and reasons can contain employee names; keys are masked
  // consistently across recipient positions and their dated assignments.
  { tableName: "hrm_benefit_transaction_positions", columnName: "name", transform: "faker_name" },
  { tableName: "hrm_benefit_transaction_positions", columnName: "position_key", transform: "hash" },
  { tableName: "hrm_benefit_transaction_responsibilities", columnName: "position_key", transform: "hash" },
  { tableName: "hrm_benefit_transaction_policies", columnName: "reason", transform: "redact" },
  { tableName: "hrm_benefit_transaction_items", columnName: "reason", transform: "redact" },
  { tableName: "hrm_benefit_transaction_positions", columnName: "reason", transform: "redact" },
  { tableName: "hrm_benefit_transaction_responsibilities", columnName: "reason", transform: "redact" },
  { tableName: "hrm_benefit_transaction_limits", columnName: "reason", transform: "redact" },
  { tableName: "hrm_benefit_programs", columnName: "name", transform: "faker_name" },
  { tableName: "hrm_benefit_programs", columnName: "description", transform: "redact" },
  // Operational reasons and obligation titles may name people. Goods-tax
  // evidence includes registration details, so retain no authored snapshot.
  { tableName: "assembly_disassemblies", columnName: "reason", transform: "redact" },
  { tableName: "provision_obligations", columnName: "name", transform: "redact" },
  { tableName: "document_goods_tax_snapshots", columnName: "snapshot", transform: "null_out" },
  // Validated tax IDs and authority responses may name a sole trader —
  // nulled in sandboxes like tax_ids, never faked into a plausible lie.
  { tableName: "party_tax_ids", columnName: "value", transform: "null_out" },
  { tableName: "party_tax_ids", columnName: "response_excerpt", transform: "null_out" },
  // HR-9 self-service (0198): the emergency contact is candidate PII —
  // nulled in sandboxes like tax_ids, never faked into a plausible lie.
  { tableName: "parties", columnName: "emergency_contact", transform: "null_out" },
  { tableName: "gifts", columnName: "tribute_name", transform: "faker_name" },
  // HR-20 begin: raw clock coordinates are worker location — nulled in
  // sandboxes like tax_ids, never faked into a plausible lie. The
  // geo_check flag stays so approval behavior remains testable.
  { tableName: "time_clock_events", columnName: "geo", transform: "null_out" },
  // HR-20 end
  { tableName: "vendor_roles", columnName: "tin_encrypted", transform: "reseal_secret" },
  { tableName: "vendor_roles", columnName: "tin_last4", transform: "null_out" },
  { tableName: "vendor_roles", columnName: "tin_type", transform: "null_out" },
  { tableName: "employee_payroll_profiles", columnName: "sin_encrypted", transform: "reseal_secret" },
  { tableName: "employee_payroll_profiles", columnName: "sin_last3", transform: "null_out" },
  { tableName: "information_return_recipients", columnName: "tin_last4", transform: "null_out" },
  { tableName: "information_return_recipients", columnName: "tin_type", transform: "null_out" },
  { tableName: "information_return_recipients", columnName: "recipient_snapshot", transform: "null_out" },
  { tableName: "information_return_filings", columnName: "payer_snapshot", transform: "null_out" },
  { tableName: "subsidiaries", columnName: "tax_ids", transform: "null_out" },
  { tableName: "addresses", columnName: "line1", transform: "redact" },
  { tableName: "addresses", columnName: "line2", transform: "redact" },
  // D2b: a street without a city and postal code still locates the person —
  // redact the locality with the street lines. Region/country stay: they are
  // coarse jurisdiction the sandbox's tax behavior needs, not identity.
  { tableName: "addresses", columnName: "city", transform: "redact" },
  { tableName: "addresses", columnName: "postal_code", transform: "redact" },
  // A warehouse address can be a person's premises in a small business, so
  // its street and locality are redacted like any other address.
  { tableName: "warehouses", columnName: "address_line1", transform: "redact" },
  { tableName: "warehouses", columnName: "address_line2", transform: "redact" },
  { tableName: "warehouses", columnName: "city", transform: "redact" },
  { tableName: "warehouses", columnName: "postal_code", transform: "redact" },
  // A shipment's ship-to snapshot is the customer's delivery address, and a
  // parcel tracking number locates a person's delivery: both are removed.
  { tableName: "fulfillment_documents", columnName: "ship_to_address", transform: "null_out" },
  { tableName: "drop_ship_orders", columnName: "ship_to_address", transform: "null_out" },
  { tableName: "fulfillment_documents", columnName: "tracking_number", transform: "redact" },
  // A carrier label's tracking number locates a person's delivery, its signed
  // label URL grants downloads to whoever holds it, and provider tracking
  // events may quote address fragments: all three are removed from masked
  // sandboxes.
  { tableName: "shipment_labels", columnName: "tracking_number", transform: "redact" },
  { tableName: "shipment_labels", columnName: "label_url", transform: "redact" },
  { tableName: "shipment_labels", columnName: "events", transform: "null_out" },
  // D2b: contacts are people at a customer/vendor company, faked exactly
  // like party and user identity. Title/role stay: a job function ("Billing")
  // paired with a faked name identifies nobody.
  { tableName: "contacts", columnName: "first_name", transform: "faker_name" },
  { tableName: "contacts", columnName: "last_name", transform: "faker_name" },
  { tableName: "contacts", columnName: "name", transform: "faker_name" },
  { tableName: "contacts", columnName: "email", transform: "faker_email" },
  { tableName: "contacts", columnName: "phone", transform: "faker_phone" },
  { tableName: "contacts", columnName: "mobile_phone", transform: "faker_phone" },
  { tableName: "contacts", columnName: "fax", transform: "faker_phone" },
  // Quote-to-cash signature requests name a customer-side signer: fake the
  // name and email like any other contact, and drop the network evidence
  // (IP, user agent) a sandbox must never resolve delivery to.
  { tableName: "signature_requests", columnName: "signer_name", transform: "faker_name" },
  { tableName: "signature_requests", columnName: "signer_email", transform: "faker_email" },
  { tableName: "signature_requests", columnName: "signer_ip", transform: "null_out" },
  { tableName: "signature_requests", columnName: "signer_user_agent", transform: "null_out" },
  { tableName: "signature_requests", columnName: "signature_svg", transform: "null_out" },
  // A customer accepting a pre-billing package names who accepted it.
  { tableName: "prebills", columnName: "customer_signer_name", transform: "faker_name" },
  // D2b: every other column that carries a real person's address. Faked
  // where the sandbox needs a plausible address (participant and
  // notification emails), emptied where delivery must simply not resolve.
  { tableName: "crm_activity_participants", columnName: "email", transform: "faker_email" },
  { tableName: "dunning_log", columnName: "to_email", transform: "faker_email" },
  { tableName: "vendor_roles", columnName: "eft_notification_email", transform: "faker_email" },
  { tableName: "report_runs", columnName: "recipient_emails", transform: "null_out" },
  { tableName: "report_schedules", columnName: "recipient_emails", transform: "null_out" },
  { tableName: "close_reporting_packages", columnName: "recipients", transform: "null_out" },
  { tableName: "payment_remittances", columnName: "recipients", transform: "null_out" },
  // D2b: NOT NULL text with length CHECKs — redact keeps a passing value
  // where null_out's '' would refuse the clone INSERT.
  { tableName: "report_delivery_outbox", columnName: "recipient", transform: "redact" },
  { tableName: "field_ticket_signature_requests", columnName: "recipient", transform: "redact" },
  // D2b: a pay-link bearer token must never survive the clone, even though
  // bootstrap nulls the live column — null_out is a no-op on the rows that
  // are already clean and closes the rows that are not.
  { tableName: "payment_links", columnName: "token", transform: "null_out" },
  // D2b: talent-pool notes assess named succession candidates in free text.
  { tableName: "hrm_talent_pool_members", columnName: "note", transform: "redact" },
  { tableName: "users", columnName: "email", transform: "faker_email" },
  { tableName: "users", columnName: "name", transform: "faker_name" },
  { tableName: "users", columnName: "password_hash", transform: "reseal_secret" },
  // 0196: review answers and exit records assess named people in free
  // text, so a masked sandbox redacts the prose (ratings, scales and
  // status codes carry no PII and copy verbatim on purpose).
  // HR-14 begin: license/credential numbers are candidate PII — nulled
  // in sandboxes like tax_ids, never faked into a plausible lie.
  { tableName: "hrm_worker_qualifications", columnName: "identifier", transform: "null_out" },
  // Participant observations and feedback can contain personal or medical information.
  { tableName: "hrm_training_participants", columnName: "notes", transform: "redact" },
  { tableName: "payroll_compensation_packages", columnName: "name", transform: "redact" },
  { tableName: 'payroll_period_openings', columnName: 'source_reference', transform: 'redact' },
  { tableName: 'payroll_period_openings', columnName: 'reason', transform: 'redact' },
  { tableName: 'payroll_employee_employer_assignments', columnName: 'source_reference', transform: 'redact' },
  { tableName: 'payroll_employee_employer_assignments', columnName: 'reason', transform: 'redact' },
  { tableName: "payroll_compensation_packages", columnName: "description", transform: "redact" },
  { tableName: "payroll_compensation_packages", columnName: "reason", transform: "redact" },
  { tableName: "payroll_compensation_versions", columnName: "definition", transform: "null_out" },
  { tableName: "payroll_compensation_versions", columnName: "authorship", transform: "null_out" },
  { tableName: "payroll_compensation_versions", columnName: "reason", transform: "redact" },
  { tableName: "payroll_compensation_assignments", columnName: "inputs", transform: "null_out" },
  { tableName: "payroll_compensation_assignments", columnName: "authorship", transform: "null_out" },
  { tableName: "payroll_compensation_assignments", columnName: "reason", transform: "redact" },
  { tableName: "payroll_compensation_calculations", columnName: "source_snapshot", transform: "null_out" },
  { tableName: "payroll_compensation_calculations", columnName: "result_snapshot", transform: "null_out" },
  { tableName: "hrm_training_courses", columnName: "name", transform: "redact" },
  { tableName: "hrm_training_courses", columnName: "description", transform: "redact" },
  { tableName: "hrm_training_courses", columnName: "reason", transform: "redact" },
  { tableName: "hrm_training_sessions", columnName: "name", transform: "redact" },
  { tableName: "hrm_training_sessions", columnName: "location", transform: "redact" },
  { tableName: "hrm_training_sessions", columnName: "reason", transform: "redact" },
  { tableName: "hrm_training_participants", columnName: "reason", transform: "redact" },
  { tableName: "hrm_training_feedback", columnName: "comments", transform: "redact" },
  { tableName: "hrm_training_feedback", columnName: "reason", transform: "redact" },
  // HR-14 end
  { tableName: "hrm_review_answers", columnName: "text", transform: "redact" },
  // Reviewer assignments map employments to reviewer parties: linkable
  // identity, so masked sandboxes start with no overrides (NOT NULL jsonb
  // nulls to '{}'). Scale and template snapshots stay: frozen configuration.
  { tableName: "hrm_review_cycles", columnName: "reviewer_assignments", transform: "null_out" },
  { tableName: "hrm_exit_records", columnName: "destination", transform: "redact" },
  { tableName: "hrm_exit_records", columnName: "notes", transform: "redact" },
  // Correction evidence (0281) mirrors the exit row it corrects, so its
  // images and reason carry the same notes/destination the parent masks.
  { tableName: "hrm_exit_record_events", columnName: "reason", transform: "redact" },
  { tableName: "hrm_exit_record_events", columnName: "before_snapshot", transform: "null_out" },
  { tableName: "hrm_exit_record_events", columnName: "after_snapshot", transform: "null_out" },
  // 0291: a scheduled SFTP import binds to the bank account number its
  // statements carry — a real account identifier, never copied verbatim.
  { tableName: "sftp_import_schedules", columnName: "expected_external_account_id", transform: "redact" },
  // 0292: the executed lien waiver's frozen print image carries every
  // name, figure and signature line exactly as signed.
  { tableName: "lien_waivers", columnName: "executed_snapshot", transform: "null_out" },
  // HR-17 begin: 1:1 agenda prose, feedback bodies, calibration
  // justifications and talent notes assess named people in free text —
  // same redact as review answers above.
  { tableName: "hrm_one_on_one_items", columnName: "body", transform: "redact" },
  { tableName: "hrm_feedback", columnName: "body", transform: "redact" },
  // D2b: assistant chat history is interactive user input, not a business
  // record — operators paste arbitrary data into it. Redact the text and
  // empty the structured payload (NOT NULL metadata nulls to '{}').
  { tableName: "ai_messages", columnName: "content", transform: "redact" },
  { tableName: "ai_messages", columnName: "data", transform: "null_out" },
  { tableName: "ai_conversations", columnName: "title", transform: "redact" },
  { tableName: "ai_conversations", columnName: "metadata", transform: "null_out" },
  // D2b: reviewer comments and notes on agent findings are human-authored
  // assessments that name people — redact like review answers. The finding
  // type, severity, status and fingerprint stay: triage shape, not prose.
  { tableName: "ai_work_item_feedback", columnName: "comment", transform: "redact" },
  { tableName: "ai_work_item_notes", columnName: "body", transform: "redact" },
  { tableName: "hrm_calibration_entries", columnName: "justification", transform: "redact" },
  { tableName: "hrm_talent_reviews", columnName: "notes", transform: "redact" },
  { tableName: "hrm_succession_candidates", columnName: "notes", transform: "redact" },
  { tableName: "hrm_succession_plans", columnName: "notes", transform: "redact" },
  // HR-17 end
  // Raw inbound webhook bodies may hold customer contact data. The inbox is
  // excluded from clones, so this policy documents the classification rather
  // than rewriting rows; a clone path that ever copies the table must empty it.
  { tableName: "integration_inbound_events", columnName: "raw_body", transform: "null_out" },
  // A channel order carries the buyer's contact snapshot for matching and
  // the exception queue: the name is faked, the email is faked, and the
  // address snapshot is removed like every other ship-to snapshot.
  { tableName: "channel_orders", columnName: "customer_name", transform: "faker_name" },
  { tableName: "channel_orders", columnName: "customer_email", transform: "faker_email" },
  { tableName: "channel_orders", columnName: "customer_address", transform: "null_out" },
  // A portal magic link is keyed to the customer contact email it was sent
  // to; the event detail can hold customer-written notes, so it is removed
  // while the coded reason stays queryable.
  { tableName: "customer_portal_links", columnName: "contact_email", transform: "faker_email" },
  { tableName: "customer_portal_events", columnName: "detail", transform: "null_out" },
];

/** Make sure every default policy exists for the org. Idempotent: a policy the
 * org already holds (active or deliberately deactivated) is left untouched,
 * so a newly added default reaches existing tenants without overriding their
 * configuration. */
export async function seedDefaultMaskingPolicies(prodOrgId: string): Promise<void> {
  for (const p of DEFAULT_POLICIES) {
    await db
      .insert(schema.maskingPolicies)
      .values({
        orgId: prodOrgId,
        tableName: p.tableName,
        columnName: p.columnName,
        transform: p.transform,
      })
      // Default provisioning preserves an existing masking transform for this column.
      .onConflictDoNothing();
  }
}
