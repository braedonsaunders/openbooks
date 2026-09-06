import { sql } from "drizzle-orm";
import { db, schema } from "../db.ts";

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
 * ciphertext, last four, type) on vendor and information-return rows, and the
 * party / legal-entity tax registrations. The org row's own tax ids are not
 * cloned at all; createSandbox/refreshSandbox blank them for masked sandboxes.
 *
 * `users` rows are deliberately NOT masked: they are the sandbox's login
 * identities (the customization layer), not business PII payload, and a
 * sandbox that cannot be signed into is useless. */
const DEFAULT_POLICIES: MaskingPolicy[] = [
  { tableName: "party_bank_accounts", columnName: "account_number_encrypted", transform: "reseal_secret" },
  { tableName: "party_bank_accounts", columnName: "account_last_four", transform: "null_out" },
  { tableName: "party_bank_accounts", columnName: "routing", transform: "null_out" },
  { tableName: "parties", columnName: "email", transform: "faker_email" },
  { tableName: "parties", columnName: "display_name", transform: "faker_name" },
  { tableName: "parties", columnName: "legal_name", transform: "faker_name" },
  { tableName: "parties", columnName: "phone", transform: "faker_phone" },
  { tableName: "parties", columnName: "tax_ids", transform: "null_out" },
  { tableName: "vendor_roles", columnName: "tin_encrypted", transform: "reseal_secret" },
  { tableName: "vendor_roles", columnName: "tin_last4", transform: "null_out" },
  { tableName: "vendor_roles", columnName: "tin_type", transform: "null_out" },
  { tableName: "information_return_recipients", columnName: "tin_last4", transform: "null_out" },
  { tableName: "information_return_recipients", columnName: "tin_type", transform: "null_out" },
  { tableName: "subsidiaries", columnName: "tax_ids", transform: "null_out" },
  { tableName: "addresses", columnName: "line1", transform: "redact" },
  { tableName: "addresses", columnName: "line2", transform: "redact" },
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
