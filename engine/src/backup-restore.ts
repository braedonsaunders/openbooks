import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import pg from "pg";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_DATA_KEY_CHECK_PLAINTEXT,
  DURABLE_USER_AUTH_BACKUP_TABLES,
  ORGLESS_BACKUP_TABLES,
  ORG_SCOPED_BACKUP_EXCLUSIONS,
  backupSchemaFingerprint,
  type BackupHeaderV2,
  type BackupHeaderV3,
} from "./backup-format.ts";
import { unsealSecret } from "./secrets.ts";
import {
  unsealSecret as unsealEmailSecret,
  validateStoredEmailConfig,
  type RawEmailConfig,
} from "@openbooks/emails";

const TABLE_NAME_RE = /^[a-z0-9_]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ROW_LINE_RE = /^\{"t":"([a-z0-9_]+)","r":(.+)\}$/;

type LegacyHeader = {
  format: typeof BACKUP_FORMAT;
  version: 1;
  orgId: string;
  createdAt: string;
};

export interface BackupArchiveInspection {
  archivePath: string;
  sha256: string;
  header: BackupHeaderV3 | BackupHeaderV2 | LegacyHeader;
  tables: { name: string; rows: number }[];
  totalRows: number;
  spoolDir: string;
}

export interface RestoreReport {
  format: "openbooks-restore-report";
  version: 1;
  orgId: string;
  sourceSha256: string;
  sourceCreatedAt: string;
  sourceFormatVersion: number;
  schemaSha256: string | null;
  tablesRestored: number;
  rowsRestored: number;
  interruptedBackupRunsClosed: number;
  mfaFactorsReset: number;
  restoredAt: string;
  databaseUser: string;
  validation: {
    archiveCounts: "passed";
    targetEmpty: "passed" | "test-override";
    schemaFingerprint: "passed" | "legacy-override";
    databaseConstraints: "passed";
    tenantReferences: "passed";
    mfaCiphertexts: "passed" | "reset";
    mfaRecoveryHashes: "passed" | "reset";
    sessionSecretEmailConfig: "passed" | "not-present";
    postedLedgerBalance: "passed";
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function closeWriteStream(stream: ReturnType<typeof createWriteStream> | null): Promise<void> {
  if (!stream) return;
  stream.end();
  await once(stream, "close");
}

/**
 * Authenticate and fully validate an archive before opening a database
 * transaction. Row JSON is spooled verbatim by table so numeric precision is
 * never round-tripped through JavaScript and restore memory stays bounded.
 */
export async function inspectBackupArchive(args: {
  archivePath: string;
  expectedSha256: string;
  expectedOrgId: string;
  spoolDir: string;
  allowLegacyV1?: boolean;
  allowLegacyV2WithoutKeyCheck?: boolean;
}): Promise<BackupArchiveInspection> {
  if (!args.archivePath.startsWith("/")) throw new Error("backup archive path must be absolute");
  if (!SHA256_RE.test(args.expectedSha256)) throw new Error("expected SHA-256 must be 64 lowercase hexadecimal characters");
  if (!UUID_RE.test(args.expectedOrgId)) throw new Error("expected organization id is not a UUID");
  await mkdir(args.spoolDir, { recursive: true, mode: 0o700 });

  const actualSha256 = await sha256File(args.archivePath);
  if (actualSha256 !== args.expectedSha256) {
    throw new Error(`backup SHA-256 mismatch: expected ${args.expectedSha256}, received ${actualSha256}`);
  }

  const lines = createInterface({
    input: createReadStream(args.archivePath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let header: BackupHeaderV3 | BackupHeaderV2 | LegacyHeader | null = null;
  let footer: { tables: { name: string; rows: number }[]; totalRows: number } | null = null;
  let lineNumber = 0;
  let currentTable: string | null = null;
  let currentSink: ReturnType<typeof createWriteStream> | null = null;
  const completedTables = new Set<string>();
  const actualCounts = new Map<string, number>();
  let orgRows = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) throw new Error(`empty line at backup line ${lineNumber}`);
      if (!header) {
        const candidate: unknown = JSON.parse(line);
        if (!plainObject(candidate) || candidate.format !== BACKUP_FORMAT) {
          throw new Error("not an OpenBooks organization backup");
        }
        if (candidate.version !== 1 && candidate.version !== 2 && candidate.version !== BACKUP_FORMAT_VERSION) {
          throw new Error(`unsupported OpenBooks backup version ${String(candidate.version)}`);
        }
        if (candidate.version === 1 && !args.allowLegacyV1) {
          throw new Error("legacy format-v1 backup has no schema fingerprint; pass the explicit legacy override only after proving source/target schema parity");
        }
        if (candidate.version === 2 && !args.allowLegacyV2WithoutKeyCheck) {
          throw new Error(
            "legacy format-v2 backup has no data-key canary; pass --allow-legacy-v2-without-key-check only after independently proving the source OPENBOOKS_DATA_KEY",
          );
        }
        if (typeof candidate.orgId !== "string" || candidate.orgId !== args.expectedOrgId) {
          throw new Error("backup organization does not match --org");
        }
        if (typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt))) {
          throw new Error("backup header has an invalid createdAt timestamp");
        }
        if (
          (candidate.version === 2 || candidate.version === BACKUP_FORMAT_VERSION) &&
          (typeof candidate.schemaSha256 !== "string" || !SHA256_RE.test(candidate.schemaSha256))
        ) {
          throw new Error(`format-v${candidate.version} backup header has an invalid schema fingerprint`);
        }
        if (
          candidate.version === BACKUP_FORMAT_VERSION &&
          (typeof candidate.dataKeyCheck !== "string" || !candidate.dataKeyCheck.startsWith("enc:v1:"))
        ) {
          throw new Error("format-v3 backup header has no valid data-key verification canary");
        }
        header = candidate as unknown as BackupHeaderV3 | BackupHeaderV2 | LegacyHeader;
        continue;
      }
      if (footer) throw new Error(`data found after backup footer at line ${lineNumber}`);

      if (line.startsWith('{"meta":')) {
        await closeWriteStream(currentSink);
        currentSink = null;
        const parsed: unknown = JSON.parse(line);
        const meta = plainObject(parsed) && plainObject(parsed.meta) ? parsed.meta : null;
        if (!meta || !Array.isArray(meta.tables) || !Number.isSafeInteger(meta.totalRows) || Number(meta.totalRows) < 0) {
          throw new Error("backup footer is malformed");
        }
        const seen = new Set<string>();
        const tables = meta.tables.map((entry: unknown) => {
          if (!plainObject(entry) || typeof entry.name !== "string" || !TABLE_NAME_RE.test(entry.name)) {
            throw new Error("backup footer contains an invalid table name");
          }
          if (!Number.isSafeInteger(entry.rows) || Number(entry.rows) < 0) {
            throw new Error(`backup footer has an invalid row count for ${entry.name}`);
          }
          if (seen.has(entry.name)) throw new Error(`backup footer repeats table ${entry.name}`);
          seen.add(entry.name);
          return { name: entry.name, rows: Number(entry.rows) };
        });
        footer = { tables, totalRows: Number(meta.totalRows) };
        continue;
      }

      const match = ROW_LINE_RE.exec(line);
      if (!match) throw new Error(`malformed row envelope at backup line ${lineNumber}`);
      const [, tableName, rawRow] = match;
      if (tableName !== currentTable) {
        await closeWriteStream(currentSink);
        currentSink = null;
        if (completedTables.has(tableName)) {
          throw new Error(`backup table ${tableName} is split into multiple sections`);
        }
        if (currentTable) completedTables.add(currentTable);
        currentTable = tableName;
        currentSink = createWriteStream(join(args.spoolDir, `${tableName}.ndjson`), {
          flags: "wx",
          mode: 0o600,
        });
      }
      const row: unknown = JSON.parse(rawRow);
      if (!plainObject(row)) throw new Error(`backup row for ${tableName} is not an object`);
      if (tableName === "orgs") {
        if (row.id !== header.orgId) throw new Error("backup contains a different organization root row");
        orgRows += 1;
      } else if (Object.hasOwn(row, "org_id") && row.org_id !== header.orgId) {
        throw new Error(`backup row for ${tableName} crosses the organization boundary`);
      }
      if (!currentSink!.write(`${rawRow}\n`)) await once(currentSink!, "drain");
      actualCounts.set(tableName, (actualCounts.get(tableName) ?? 0) + 1);
    }
  } finally {
    await closeWriteStream(currentSink).catch(() => {});
  }

  if (!header) throw new Error("backup is empty");
  if (!footer) throw new Error("backup did not complete: footer is missing");
  if (orgRows !== 1) throw new Error(`backup must contain exactly one organization row; found ${orgRows}`);
  let declaredTotal = 0;
  for (const table of footer.tables) {
    declaredTotal += table.rows;
    const actual = actualCounts.get(table.name) ?? 0;
    if (actual !== table.rows) {
      throw new Error(`backup row count mismatch for ${table.name}: footer ${table.rows}, archive ${actual}`);
    }
    actualCounts.delete(table.name);
  }
  if (actualCounts.size > 0) {
    throw new Error(`backup footer omits table ${actualCounts.keys().next().value}`);
  }
  if (declaredTotal !== footer.totalRows) {
    throw new Error(`backup footer total ${footer.totalRows} does not equal table total ${declaredTotal}`);
  }
  return {
    archivePath: args.archivePath,
    sha256: actualSha256,
    header,
    tables: footer.tables,
    totalRows: footer.totalRows,
    spoolDir: args.spoolDir,
  };
}

async function targetBackupTables(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(`
    select distinct column_row.table_name
      from information_schema.columns column_row
      join information_schema.tables table_row
        on table_row.table_schema = column_row.table_schema
       and table_row.table_name = column_row.table_name
     where column_row.table_schema = 'public'
       and table_row.table_type = 'BASE TABLE'
       and column_row.column_name = 'org_id'
       and not (column_row.table_name = any($1::text[]))
    union select 'orgs'
    order by 1
  `, [[...ORG_SCOPED_BACKUP_EXCLUSIONS]]);
  const present = new Set(result.rows.map((row) => row.table_name));
  for (const child of ORGLESS_BACKUP_TABLES) {
    const exists = await client.query<{ present: boolean }>(
      `select to_regclass($1) is not null as present`,
      [`public.${child}`],
    );
    if (exists.rows[0]?.present) present.add(child);
  }
  return [...present].sort();
}

async function validateDurableAuthOwnership(
  client: pg.PoolClient,
  inspection: BackupArchiveInspection,
  orgId: string,
): Promise<void> {
  const archived = new Map(inspection.tables.map((table) => [table.name, table.rows]));
  for (const tableName of DURABLE_USER_AUTH_BACKUP_TABLES) {
    if ((archived.get(tableName) ?? 0) === 0) continue;
    const lines = createInterface({
      input: createReadStream(join(inspection.spoolDir, `${tableName}.ndjson`)),
      crlfDelay: Infinity,
    });
    let userIds = new Set<string>();
    const flush = async () => {
      if (userIds.size === 0) return;
      const ids = [...userIds];
      const owned = await client.query<{ id: string }>(
        "select id::text as id from users where id = any($1::uuid[]) and org_id = $2",
        [ids, orgId],
      );
      if (new Set(owned.rows.map((row) => row.id)).size !== ids.length) {
        throw new Error(`restore durable-auth validation failed: ${tableName} references a user outside the archived organization`);
      }
      userIds = new Set<string>();
    };
    for await (const line of lines) {
      const row: unknown = JSON.parse(line);
      if (!plainObject(row) || typeof row.user_id !== "string" || !UUID_RE.test(row.user_id)) {
        throw new Error(`restore durable-auth validation failed: ${tableName} has an invalid user_id`);
      }
      userIds.add(row.user_id);
      if (userIds.size >= 250) await flush();
    }
    await flush();
  }
}

async function validateMfaMaterial(
  client: pg.PoolClient,
  orgId: string,
  validateCiphertext: boolean,
): Promise<void> {
  const factors = await client.query<{ secret_encrypted: string; recovery_code_hashes: unknown }>(
    `select factor.secret_encrypted, factor.recovery_code_hashes
       from auth_mfa_factors factor
       join users user_row on user_row.id = factor.user_id
      where user_row.org_id = $1`,
    [orgId],
  );
  for (const factor of factors.rows) {
    if (
      !Array.isArray(factor.recovery_code_hashes) ||
      factor.recovery_code_hashes.some(
        (hash) => typeof hash !== "string" || !/^s1:[0-9a-f]{32}:[0-9a-f]{64}$/i.test(hash),
      )
    ) {
      throw new Error("restored MFA factor contains an unsupported recovery-code hash format");
    }
    // Never return or log the plaintext. Successful authenticated decryption is
    // enough to prove the configured OPENBOOKS_DATA_KEY is the source key.
    if (validateCiphertext && unsealSecret(factor.secret_encrypted) === null) {
      throw new Error(
        "restored MFA ciphertext is corrupt despite a valid backup data-key canary",
      );
    }
  }
}

/**
 * Email-provider credentials predate OPENBOOKS_DATA_KEY and are AES-GCM sealed
 * with a key derived from SESSION_SECRET. Validate that separate recovery key
 * while the restore is still transactional; a wrong key must not leave a
 * seemingly successful organization whose outbound email is unusable.
 */
async function validateSessionSecretEmailConfig(
  client: pg.PoolClient,
  orgId: string,
): Promise<"passed" | "not-present"> {
  const result = await client.query<{ email: unknown }>(
    "select settings -> 'email' as email from orgs where id = $1",
    [orgId],
  );
  const email = result.rows[0]?.email;
  if (email === null || email === undefined) return "not-present";
  if (!plainObject(email)) {
    throw new Error("restored organization email configuration is malformed");
  }
  try {
    validateStoredEmailConfig(email as RawEmailConfig);
  } catch {
    throw new Error("restored organization email configuration is malformed");
  }
  const ciphertext = email.keyCiphertext;
  const nonce = email.keyNonce;
  const hasCiphertext = typeof ciphertext === "string" && ciphertext.trim().length > 0;
  const hasNonce = typeof nonce === "string" && nonce.trim().length > 0;
  if (!hasCiphertext && !hasNonce) return "not-present";
  if (
    !hasCiphertext ||
    !hasNonce ||
    unsealEmailSecret({ ciphertext: ciphertext as string, nonce: nonce as string }) === null
  ) {
    throw new Error(
      "restored email-provider credential cannot be decrypted; SESSION_SECRET must match the source deployment",
    );
  }
  return "passed";
}

async function insertionOrder(client: pg.PoolClient, tableNames: readonly string[]): Promise<string[]> {
  const names = new Set(tableNames);
  const edges = await client.query<{ child: string; parent: string }>(`
    select child.relname as child, parent.relname as parent
      from pg_constraint constraint_row
      join pg_class child on child.oid = constraint_row.conrelid
      join pg_class parent on parent.oid = constraint_row.confrelid
      join pg_namespace namespace_row on namespace_row.oid = child.relnamespace
     where constraint_row.contype = 'f'
       and not constraint_row.condeferrable
       and namespace_row.nspname = 'public'
  `);
  const children = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const name of names) {
    children.set(name, new Set());
    indegree.set(name, 0);
  }
  for (const { child, parent } of edges.rows) {
    if (!names.has(child) || !names.has(parent) || child === parent) continue;
    if (!children.get(parent)!.has(child)) {
      children.get(parent)!.add(child);
      indegree.set(child, (indegree.get(child) ?? 0) + 1);
    }
  }
  const queue = [...names].filter((name) => indegree.get(name) === 0).sort();
  const ordered: string[] = [];
  while (queue.length) {
    const parent = queue.shift()!;
    ordered.push(parent);
    for (const child of children.get(parent) ?? []) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
    queue.sort();
  }
  if (ordered.length !== names.size) {
    const cycle = [...names].filter((name) => !ordered.includes(name));
    throw new Error(`target schema has a non-deferrable foreign-key cycle: ${cycle.join(", ")}`);
  }
  // orgs has no hard parent and must precede tenant rows for clarity even when
  // their org_id foreign keys are deferrable.
  return ["orgs", ...ordered.filter((name) => name !== "orgs")];
}

async function insertSpoolTable(
  client: pg.PoolClient,
  inspection: BackupArchiveInspection,
  tableName: string,
  expectedRows: number,
): Promise<number> {
  if (expectedRows === 0) return 0;
  if (!TABLE_NAME_RE.test(tableName)) throw new Error(`unsafe backup table name ${tableName}`);
  const path = join(inspection.spoolDir, `${tableName}.ndjson`);
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let batch: string[] = [];
  let batchBytes = 0;
  let inserted = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await client.query(
      `insert into public."${tableName}"
       select * from jsonb_populate_recordset(null::public."${tableName}", $1::jsonb)`,
      [`[${batch.join(",")}]`],
    );
    inserted += result.rowCount ?? 0;
    batch = [];
    batchBytes = 0;
  };
  for await (const line of lines) {
    if (!line) throw new Error(`empty spooled row for ${tableName}`);
    const rowBytes = Buffer.byteLength(line);
    if (batch.length && batchBytes + rowBytes > 4 * 1024 * 1024) await flush();
    batch.push(line);
    batchBytes += rowBytes;
    if (batch.length >= 250 || batchBytes >= 4 * 1024 * 1024) await flush();
  }
  await flush();
  if (inserted !== expectedRows) {
    throw new Error(`restore inserted ${inserted} ${tableName} rows; expected ${expectedRows}`);
  }
  return inserted;
}

async function validateTenantReferences(client: pg.PoolClient, orgId: string): Promise<void> {
  const refs = await client.query<{
    source_table: string;
    source_column: string;
    target_table: string;
    target_column: string;
  }>(`
    select source.relname source_table, source_column.attname source_column,
           target.relname target_table, target_column.attname target_column
      from pg_constraint constraint_row
      join pg_class source on source.oid = constraint_row.conrelid
      join pg_class target on target.oid = constraint_row.confrelid
      join pg_namespace source_namespace on source_namespace.oid = source.relnamespace
      cross join lateral generate_subscripts(constraint_row.conkey, 1) position
      join pg_attribute source_column
        on source_column.attrelid = source.oid
       and source_column.attnum = constraint_row.conkey[position]
      join pg_attribute target_column
        on target_column.attrelid = target.oid
       and target_column.attnum = constraint_row.confkey[position]
     where constraint_row.contype = 'f'
       and source_namespace.nspname = 'public'
       and exists (select 1 from pg_attribute a where a.attrelid = source.oid and a.attname = 'org_id' and not a.attisdropped)
       and exists (select 1 from pg_attribute a where a.attrelid = target.oid and a.attname = 'org_id' and not a.attisdropped)
  `);
  for (const ref of refs.rows) {
    for (const value of Object.values(ref)) {
      if (!TABLE_NAME_RE.test(value)) throw new Error("unsafe catalog identifier during restore validation");
    }
    const mismatch = await client.query<{ count: string }>(
      `select count(*)::text as count
         from public."${ref.source_table}" source_row
         join public."${ref.target_table}" target_row
           on target_row."${ref.target_column}" = source_row."${ref.source_column}"
        where source_row.org_id = $1 and target_row.org_id <> $1`,
      [orgId],
    );
    if (mismatch.rows[0]?.count !== "0") {
      throw new Error(`restore tenant-reference validation failed at ${ref.source_table}.${ref.source_column}`);
    }
  }
}

/** Restore one authenticated organization archive in one all-or-nothing transaction. */
export async function restoreOrgBackup(args: {
  archivePath: string;
  expectedSha256: string;
  expectedOrgId: string;
  connectionString: string;
  expectedRowCount?: number;
  expectedTableCount?: number;
  allowLegacyV1?: boolean;
  allowLegacyV2WithoutKeyCheck?: boolean;
  /** Explicit factor revocation; this never bypasses source-key verification. */
  resetMfaFactors?: boolean;
  /** Integration-drill escape hatch. Never exposed by the operator CLI. */
  testOnlyAllowNonemptyTarget?: boolean;
}): Promise<RestoreReport> {
  const spoolDir = await mkdtemp(join(tmpdir(), "openbooks-restore-"));
  let inspection: BackupArchiveInspection | null = null;
  const pool = new pg.Pool({ connectionString: args.connectionString, max: 1, connectionTimeoutMillis: 30_000 });
  try {
    inspection = await inspectBackupArchive({
      archivePath: args.archivePath,
      expectedSha256: args.expectedSha256,
      expectedOrgId: args.expectedOrgId,
      spoolDir,
      allowLegacyV1: args.allowLegacyV1,
      allowLegacyV2WithoutKeyCheck: args.allowLegacyV2WithoutKeyCheck,
    });
    if (args.expectedRowCount !== undefined && args.expectedRowCount !== inspection.totalRows) {
      throw new Error(`manifest row count ${args.expectedRowCount} does not match archive ${inspection.totalRows}`);
    }
    if (args.expectedTableCount !== undefined && args.expectedTableCount !== inspection.tables.length) {
      throw new Error(`manifest table count ${args.expectedTableCount} does not match archive ${inspection.tables.length}`);
    }
    if (
      inspection.header.version === BACKUP_FORMAT_VERSION &&
      unsealSecret(inspection.header.dataKeyCheck) !== BACKUP_DATA_KEY_CHECK_PLAINTEXT
    ) {
      throw new Error(
        "backup data-key verification failed; OPENBOOKS_DATA_KEY is missing, wrong, or the archive canary was tampered",
      );
    }
    const client = await pool.connect();
    let deploymentLock = false;
    try {
      // Freeze migrations before reading the target catalog/fingerprint. The
      // bootstrap uses the exclusive counterpart of this session lock.
      await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
        "openbooks:deployment-bootstrap",
      ]);
      deploymentLock = true;
      const sourceTables = inspection.tables.map((table) => table.name).sort();
      const posture = await client.query<{ current_user: string; rolsuper: boolean; unowned: string }>(`
        select current_user, role_row.rolsuper,
               (select count(*)::text
                  from pg_class relation
                  join pg_namespace namespace_row on namespace_row.oid = relation.relnamespace
                 where namespace_row.nspname = 'public'
                   and relation.relname = any($1::text[])
                   and pg_get_userbyid(relation.relowner) <> current_user) as unowned
          from pg_roles role_row where role_row.rolname = current_user
      `, [sourceTables]);
      const role = posture.rows[0];
      if (!role || (!role.rolsuper && role.unowned !== "0")) {
        throw new Error("restore connection must be the schema owner (or an explicitly controlled PostgreSQL superuser)");
      }

      const targetTables = await targetBackupTables(client);
      if (JSON.stringify(sourceTables) !== JSON.stringify(targetTables)) {
        const missing = targetTables.filter((table) => !sourceTables.includes(table));
        const unknown = sourceTables.filter((table) => !targetTables.includes(table));
        throw new Error(`backup table catalog differs from target schema (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`);
      }
      const targetSchemaSha256 = await backupSchemaFingerprint(client, targetTables);
      if (inspection.header.version !== 1 && inspection.header.schemaSha256 !== targetSchemaSha256) {
        throw new Error(`backup schema fingerprint ${inspection.header.schemaSha256} does not match target ${targetSchemaSha256}; restore the source version first, then upgrade`);
      }
      const order = await insertionOrder(client, targetTables);
      const rowCounts = new Map(inspection.tables.map((table) => [table.name, table.rows]));
      let interruptedBackupRunsClosed = 0;
      let mfaFactorsReset = 0;
      let sessionSecretEmailConfig: "passed" | "not-present" = "not-present";

      await client.query("begin");
      try {
        await client.query("set local statement_timeout = 0");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", ["openbooks:organization-restore"]);
        await client.query("select set_config('app.current_org', '', true), set_config('app.bypass_rls', 'on', true)");
        await client.query("select set_config('openbooks.migration', 'on', true), set_config('openbooks.amend', 'on', true)");
        await client.query("set constraints all deferred");
        const existing = await client.query<{ count: string }>("select count(*)::text as count from orgs");
        if (existing.rows[0]?.count !== "0" && !args.testOnlyAllowNonemptyTarget) {
          throw new Error("restore target is not empty: organization restore requires a schema-only database with zero org rows");
        }

        // Historical rows cannot be replayed through state-transition triggers:
        // a correction link created while a replacement was draft may now point
        // to a posted document, for example. Disable USER triggers transactionally;
        // FK constraints remain active and are forced immediate before commit.
        for (const tableName of [...targetTables].sort()) {
          if (!TABLE_NAME_RE.test(tableName)) throw new Error(`unsafe target table ${tableName}`);
          await client.query(`alter table public."${tableName}" disable trigger user`);
        }
        let rowsRestored = 0;
        for (const tableName of order) {
          rowsRestored += await insertSpoolTable(client, inspection, tableName, rowCounts.get(tableName) ?? 0);
        }
        if (rowsRestored !== inspection.totalRows) {
          throw new Error(`restore row total ${rowsRestored} does not match archive ${inspection.totalRows}`);
        }
        // Drain deferred FK/constraint events before ALTER TABLE re-enables
        // user triggers; PostgreSQL refuses trigger DDL while a relation has
        // pending trigger events.
        await client.query("set constraints all immediate");
        for (const tableName of [...targetTables].sort()) {
          await client.query(`alter table public."${tableName}" enable trigger user`);
        }
        // The row triggers that maintain gl_month_activity and
        // party_payment_stats were intentionally disabled during the bulk copy,
        // and those derived tables are deliberately excluded from archives in
        // expectation of a rebuild. Rebuild both aggregates explicitly for the
        // restored organization so reporting is not permanently empty.
        await client.query("select openbooks_gl_activity_rebuild($1)", [args.expectedOrgId]);
        await client.query("select openbooks_party_payment_stats_rebuild($1)", [args.expectedOrgId]);
        // Redis queue state is intentionally not replayed by an organization
        // archive. A stored backup also snapshots its own backup_runs row while
        // that row is still "running". Close every in-flight backup ledger row
        // so the restored tenant is not permanently blocked by phantom work.
        const interrupted = await client.query(
          `update backup_runs
              set status = 'failed', completed_at = now(), updated_at = now(),
                  error = 'interrupted source backup run closed during restore'
            where org_id = $1 and status in ('queued', 'running')`,
          [args.expectedOrgId],
        );
        interruptedBackupRunsClosed = interrupted.rowCount ?? 0;
        await validateTenantReferences(client, args.expectedOrgId);
        await validateDurableAuthOwnership(client, inspection, args.expectedOrgId);
        sessionSecretEmailConfig = await validateSessionSecretEmailConfig(client, args.expectedOrgId);
        if (sourceTables.includes("auth_mfa_factors")) {
          await validateMfaMaterial(client, args.expectedOrgId, !args.resetMfaFactors);
          if (args.resetMfaFactors) {
            const reset = await client.query(
              `delete from auth_mfa_factors factor
                using users user_row
                where factor.user_id = user_row.id and user_row.org_id = $1`,
              [args.expectedOrgId],
            );
            mfaFactorsReset = reset.rowCount ?? 0;
          }
        }
        const invalidLedger = await client.query<{ count: string }>(`
          with invalid_entry as (
            select entry.id
              from journal_entries entry
              left join lateral (
                select count(*)::int line_count, coalesce(sum(amount), 0) balance
                  from journal_lines line where line.entry_id = entry.id
              ) totals on true
             where entry.org_id = $1 and entry.status in ('posted', 'reversed')
               and (totals.line_count < 2 or totals.balance <> 0)
          ), invalid_subsidiary as (
            select line.entry_id, line.subsidiary_id
              from journal_lines line
              join journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
             where entry.org_id = $1 and entry.status in ('posted', 'reversed')
             group by line.entry_id, line.subsidiary_id
            having sum(line.amount) <> 0
          )
          select (
            (select count(*) from invalid_entry) +
            (select count(*) from invalid_subsidiary)
          )::text as count
        `, [args.expectedOrgId]);
        if (invalidLedger.rows[0]?.count !== "0") {
          throw new Error(`restore contains ${invalidLedger.rows[0]?.count ?? "unknown"} invalid posted journal entries`);
        }
        const root = await client.query<{ count: string }>("select count(*)::text as count from orgs where id = $1", [args.expectedOrgId]);
        if (root.rows[0]?.count !== "1") throw new Error("restored organization root validation failed");
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }

      return {
        format: "openbooks-restore-report",
        version: 1,
        orgId: args.expectedOrgId,
        sourceSha256: inspection.sha256,
        sourceCreatedAt: inspection.header.createdAt,
        sourceFormatVersion: inspection.header.version,
        schemaSha256: inspection.header.version === 1 ? null : inspection.header.schemaSha256,
        tablesRestored: inspection.tables.length,
        rowsRestored: inspection.totalRows,
        interruptedBackupRunsClosed,
        mfaFactorsReset,
        restoredAt: new Date().toISOString(),
        databaseUser: role.current_user,
        validation: {
          archiveCounts: "passed",
          targetEmpty: args.testOnlyAllowNonemptyTarget ? "test-override" : "passed",
          schemaFingerprint: inspection.header.version === 1 ? "legacy-override" : "passed",
          databaseConstraints: "passed",
          tenantReferences: "passed",
          mfaCiphertexts: args.resetMfaFactors ? "reset" : "passed",
          mfaRecoveryHashes: args.resetMfaFactors ? "reset" : "passed",
          sessionSecretEmailConfig,
          postedLedgerBalance: "passed",
        },
      };
    } finally {
      if (deploymentLock) {
        await client
          .query("select pg_advisory_unlock(hashtextextended($1, 0))", [
            "openbooks:deployment-bootstrap",
          ])
          .catch(() => {});
      }
      client.release();
    }
  } finally {
    await pool.end().catch(() => {});
    await rm(spoolDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface LocalBackupManifest {
  format: "openbooks-local-backup-manifest";
  version: 1;
  orgId: string;
  sha256: string;
  rowCount?: number;
  tableCount?: number;
}

export async function readLocalBackupManifest(path: string): Promise<LocalBackupManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !plainObject(parsed) ||
    parsed.format !== "openbooks-local-backup-manifest" ||
    parsed.version !== 1 ||
    typeof parsed.orgId !== "string" ||
    !UUID_RE.test(parsed.orgId) ||
    typeof parsed.sha256 !== "string" ||
    !SHA256_RE.test(parsed.sha256) ||
    (parsed.rowCount !== undefined &&
      (!Number.isSafeInteger(parsed.rowCount) || Number(parsed.rowCount) < 0)) ||
    (parsed.tableCount !== undefined &&
      (!Number.isSafeInteger(parsed.tableCount) || Number(parsed.tableCount) < 0))
  ) {
    throw new Error("invalid OpenBooks local-backup manifest");
  }
  return parsed as unknown as LocalBackupManifest;
}
