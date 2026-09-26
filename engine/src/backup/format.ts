import { createHash } from "node:crypto";

/** Org-less child rows reached through an ordinary tenant-owned parent. */
export const ORGLESS_CHILD_BACKUP_TABLES = [
  "file_blobs",
  "file_versions",
  "tax_group_members",
] as const;

/**
 * Durable pre-tenant authentication state that follows the archived users.
 * Active sessions, login challenges, lockout state, and login-event evidence
 * are deliberately absent: an organization restore must never resurrect an
 * authentication credential or stale security decision.
 */
export const DURABLE_USER_AUTH_BACKUP_TABLES = [
  "auth_mfa_factors",
  "auth_oidc_identities",
] as const;

/** Every no-org_id table intentionally supported by a one-org archive. */
export const ORGLESS_BACKUP_TABLES = [
  ...ORGLESS_CHILD_BACKUP_TABLES,
  ...DURABLE_USER_AUTH_BACKUP_TABLES,
] as const;

/**
 * Cross-tenant access grants cannot be represented faithfully in a one-org
 * archive: member_user_id may belong to another organization's home identity.
 * They are intentionally omitted and must be reviewed/re-created after restore.
 */
/**
 * gl_month_activity and party_payment_stats are derived: their triggers
 * rebuild them row-by-row as a restore re-inserts the entries, lines and
 * settlements, so carrying them in the archive would double-count.
 */
export const ORG_SCOPED_BACKUP_EXCLUSIONS = ["user_org_access", "gl_month_activity", "party_payment_stats"] as const;

export const BACKUP_FORMAT = "openbooks-backup" as const;
export const BACKUP_FORMAT_VERSION = 3 as const;
export const BACKUP_DATA_KEY_CHECK_PLAINTEXT = "openbooks-backup-data-key-check:v1" as const;

/**
 * Encrypted backups wrap the gzip NDJSON stream in AES-256-GCM under a
 * random per-backup content key, itself sealed by OPENBOOKS_DATA_KEY. The
 * file is one plaintext JSON envelope line, the ciphertext, then the 16-byte
 * GCM tag as the trailer. The manifest/ledger SHA-256 continues to cover the
 * whole file. The key id is hard-coded until the key-rotation work adopts
 * real key ids.
 */
export const BACKUP_ENCRYPTION = "aes-256-gcm" as const;
export const BACKUP_KEY_ID = "v1" as const;
/** GCM authentication tag length in bytes. */
export const BACKUP_TAG_BYTES = 16 as const;

export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  encryption: typeof BACKUP_ENCRYPTION;
  keyId: string;
  /** Base64 12-byte GCM nonce for the per-backup content key. */
  nonce: string;
  /**
   * The content key sealed by OPENBOOKS_DATA_KEY. New archives carry the
   * v2 scope-bound seal; v1 (no scope binding) still decodes for the
   * rotation window, the same way the header canary accepts both.
   */
  wrappedKey: string;
}

export function encodeBackupEnvelope(envelope: BackupEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/**
 * Parse the first line of a backup file. Returns null for legacy plaintext
 * gzip archives (binary magic, never JSON). Throws a named refusal for a
 * line that claims to be an envelope but is malformed.
 */
export function decodeBackupEnvelopeLine(line: string): BackupEnvelope | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    return null;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (record.format !== BACKUP_FORMAT) return null;
  if (record.encryption === undefined) return null;
  if (
    record.version !== BACKUP_FORMAT_VERSION ||
    record.encryption !== BACKUP_ENCRYPTION ||
    typeof record.keyId !== "string" ||
    record.keyId.length === 0 ||
    typeof record.nonce !== "string" ||
    record.nonce.length === 0 ||
    typeof record.wrappedKey !== "string" ||
    (!record.wrappedKey.startsWith("enc:v1:") && !record.wrappedKey.startsWith("enc:v2:"))
  ) {
    throw new Error(
      "backup encryption envelope is malformed; the archive is neither a supported encrypted backup nor a legacy plaintext backup",
    );
  }
  return candidate as BackupEnvelope;
}

export interface BackupHeaderV2 {
  format: typeof BACKUP_FORMAT;
  version: 2;
  orgId: string;
  createdAt: string;
  schemaSha256: string;
}

export interface BackupHeaderV3 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_FORMAT_VERSION;
  orgId: string;
  createdAt: string;
  schemaSha256: string;
  /** AEAD canary proving restore has the source OPENBOOKS_DATA_KEY. */
  dataKeyCheck: string;
}

export interface BackupSchemaColumn {
  tableName: string;
  columnName: string;
  ordinalPosition: number;
  dataType: string;
  udtSchema: string;
  udtName: string;
  isNullable: string;
  columnDefault: string | null;
}

export interface BackupQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * A deterministic description of the columns, constraints, and tracked
 * migrations the tenant archive depends on.
 * A restore refuses a different fingerprint before its first database write;
 * upgrades therefore happen after restoring into the exact source schema.
 */
export async function backupSchemaFingerprint(
  client: BackupQueryable,
  tableNames: readonly string[],
): Promise<string> {
  const rows = await client.query<{
    table_name: string;
    column_name: string;
    ordinal_position: number;
    data_type: string;
    udt_schema: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select table_name, column_name, ordinal_position, data_type,
            udt_schema, udt_name, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [[...tableNames].sort()],
  );
  const normalized: BackupSchemaColumn[] = rows.rows.map((row) => ({
    tableName: row.table_name,
    columnName: row.column_name,
    ordinalPosition: row.ordinal_position,
    dataType: row.data_type,
    udtSchema: row.udt_schema,
    udtName: row.udt_name,
    isNullable: row.is_nullable,
    columnDefault: row.column_default,
  }));
  const constraints = await client.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: string;
    deferrable: boolean;
    initially_deferred: boolean;
    definition: string;
  }>(
    `select relation.relname as table_name,
            constraint_row.conname as constraint_name,
            constraint_row.contype::text as constraint_type,
            constraint_row.condeferrable as deferrable,
            constraint_row.condeferred as initially_deferred,
            pg_get_constraintdef(constraint_row.oid, true) as definition
       from pg_constraint constraint_row
       join pg_class relation on relation.oid = constraint_row.conrelid
       join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
      where namespace_row.nspname = 'public'
        and relation.relname = any($1::text[])
      order by relation.relname, constraint_row.conname`,
    [[...tableNames].sort()],
  );
  const migrations = await client.query<{ filename: string; sha256: string }>(
    `select filename, sha256 from public._applied_migrations order by filename`,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        columns: normalized,
        constraints: constraints.rows,
        migrations: migrations.rows,
      }),
    )
    .digest("hex");
}
