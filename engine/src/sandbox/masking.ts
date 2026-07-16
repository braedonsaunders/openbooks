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

/** SQL expression that rewrites `col` under `transform`. `idExpr` is the row's
 * stable seed for deterministic output (usually the `id` column). */
export function maskExpr(col: string, transform: MaskTransform, idExpr = "id"): string {
  const q = `"${col}"`;
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
      return `null`;
    case "reseal_secret":
      // Can't re-encrypt in SQL; null = "unconfigured", the safe sandbox state.
      return `null`;
  }
}

export interface MaskingPolicy {
  tableName: string;
  columnName: string;
  transform: MaskTransform;
}

/** Load active masking policies for a production org as table → column → transform. */
export async function loadMaskingPolicies(
  prodOrgId: string,
): Promise<Map<string, Map<string, MaskTransform>>> {
  const res = (await db.execute(sql`
    select table_name, column_name, transform
      from masking_policies
     where org_id = ${prodOrgId} and is_active = true`)) as any;
  const map = new Map<string, Map<string, MaskTransform>>();
  for (const r of res.rows as any[]) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Map());
    map.get(r.table_name)!.set(r.column_name, r.transform as MaskTransform);
  }
  return map;
}

/** High-confidence default policies seeded for an org that has none. Columns
 * that don't exist in the schema are skipped by the clone generator, so a bad
 * guess is harmless. */
const DEFAULT_POLICIES: MaskingPolicy[] = [
  { tableName: "party_bank_accounts", columnName: "account_number_encrypted", transform: "reseal_secret" },
  { tableName: "parties", columnName: "email", transform: "faker_email" },
  { tableName: "parties", columnName: "display_name", transform: "faker_name" },
  { tableName: "parties", columnName: "legal_name", transform: "faker_name" },
  { tableName: "parties", columnName: "phone", transform: "faker_phone" },
  { tableName: "addresses", columnName: "line1", transform: "redact" },
  { tableName: "addresses", columnName: "line2", transform: "redact" },
];

export async function seedDefaultMaskingPolicies(prodOrgId: string): Promise<void> {
  const existing = (await db.execute(sql`
    select 1 from masking_policies where org_id = ${prodOrgId} limit 1`)) as any;
  if (existing.rows.length) return;
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
