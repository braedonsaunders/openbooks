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
  column?: { udtName: string; isNullable: boolean },
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

interface MaskingPolicyRow extends Record<string, unknown> {
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
  { tableName: "party_bank_accounts", columnName: "account_number_encrypted", transform: "reseal_secret" },
  { tableName: "party_bank_accounts", columnName: "account_last_four", transform: "null_out" },
  { tableName: "party_bank_accounts", columnName: "routing", transform: "null_out" },
  // D2b: corporate card labels read "Visa …4821 — K. Laroche": the holder
  // name rides in display text even though holder_party_id points at a
  // masked party. Fake the label, null the last four like every other one.
  // The network brand ("Visa") stays: it identifies nobody.
  { tableName: "payment_cards", columnName: "label", transform: "faker_name" },
  { tableName: "payment_cards", columnName: "last_four", transform: "null_out" },
  { tableName: "parties", columnName: "email", transform: "faker_email" },
  { tableName: "parties", columnName: "display_name", transform: "faker_name" },
  { tableName: "parties", columnName: "legal_name", transform: "faker_name" },
  { tableName: "parties", columnName: "phone", transform: "faker_phone" },
  { tableName: "parties", columnName: "tax_ids", transform: "null_out" },
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
  // HR-9 self-service (0198): the emergency contact is candidate PII —
  // nulled in sandboxes like tax_ids, never faked into a plausible lie.
  { tableName: "parties", columnName: "emergency_contact", transform: "null_out" },
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
  // HR-14 end
  { tableName: "hrm_review_answers", columnName: "text", transform: "redact" },
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
  // HR-17 end
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
      .onConflictDoNothing();
  }
}
