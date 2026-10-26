import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export interface StoredBackupArchiveRow {
  id: string;
  file_name: string | null;
  object_key: string | null;
  status: string;
  purged_at: string | null;
  sha256: string | null;
  byte_size: string | null;
}

export interface StoredBackupManifestRow {
  id: string;
  org_id: string;
  file_name: string | null;
  status: string;
  purged_at: string | null;
  sha256: string | null;
  byte_size: string | null;
  table_count: number | null;
  row_count: string | null;
  created_at: Date | string;
}

export interface StoredBackupPurgeRow {
  id: string;
  file_name: string | null;
  object_key: string | null;
  status: string;
  kind: string;
  byte_size: number | null;
  sha256: string | null;
  purged_at: string | null;
}

export async function findStoredBackupArchive(
  orgId: string,
  id: string,
): Promise<StoredBackupArchiveRow | null> {
  const rows = await db.execute<StoredBackupArchiveRow>(
    sql`
    select id, file_name, object_key, status, purged_at, sha256, byte_size::text as byte_size
      from backup_runs where id = ${id} and org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

export async function findStoredBackupManifest(
  orgId: string,
  id: string,
): Promise<StoredBackupManifestRow | null> {
  const rows = await db.execute<StoredBackupManifestRow>(
    sql`
    select id, org_id, file_name, status, purged_at, sha256,
           byte_size::text as byte_size, table_count, row_count::text as row_count,
           created_at
      from backup_runs
     where id = ${id} and org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

export async function findStoredBackupForPurge(
  orgId: string,
  id: string,
): Promise<StoredBackupPurgeRow | null> {
  const rows = await db.execute<StoredBackupPurgeRow>(
    sql`
    select id, file_name, object_key, status, kind, byte_size, sha256, purged_at
      from backup_runs where id = ${id} and org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}
