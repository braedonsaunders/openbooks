/**
 * Private, one-time AdminApp2 equipment-rate migration.
 *
 * This is deliberately separate from the reusable NetSuite connector.  The
 * commercial day/week/month schedule lives in AdminApp2, while the matching
 * item master lives in NetSuite.  Rows are joined to already-imported items by
 * AdminApp2 equipmentrates.NetsuiteItemID -> items.custom.nsId.
 */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg, { type PoolClient } from "pg";
import { normalizeMoney } from "../money.ts";
import { deterministicUuid } from "./adminapp2-labor-rates.ts";

type SourceRow = Record<string, unknown>;

const RATE_BOOK_CODE = "EQUIPMENT";
const RATE_BOOK_NAME = "Equipment Standard";
const EFFECTIVE_FROM = "1900-01-01";

function present(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function nonNegativeMoney(value: unknown, field: string): string | null {
  if (!present(value)) return null;
  const normalized = normalizeMoney(String(value));
  if (Number(normalized) < 0) throw new Error(`${field} cannot be negative`);
  return normalized;
}

function sourceId(value: unknown): string | null {
  if (!present(value)) return null;
  const normalized = String(value).trim().replace(/\.0+$/, "");
  return /^\d+$/.test(normalized) ? normalized : null;
}

export interface EquipmentRateRecord {
  sourceRateId: string;
  netsuiteItemId: string;
  daily: string | null;
  weekly: string | null;
  monthly: string | null;
  appliesTo: string | null;
  category: string | null;
}

export function toEquipmentRateRecord(row: SourceRow): EquipmentRateRecord {
  const sourceRateId = sourceId(row.id);
  const netsuiteItemId = sourceId(row.NetsuiteItemID);
  if (!sourceRateId) throw new Error("Equipment-rate row has no valid id");
  if (!netsuiteItemId)
    throw new Error(`Equipment-rate ${sourceRateId} has no valid NetsuiteItemID`);
  const record = {
    sourceRateId,
    netsuiteItemId,
    daily: nonNegativeMoney(row.Daily, "Daily"),
    weekly: nonNegativeMoney(row.Weekly, "Weekly"),
    monthly: nonNegativeMoney(row.Monthly, "Monthly"),
    appliesTo: present(row.AppliesTo) ? String(row.AppliesTo).trim() : null,
    category: present(row.CategoryName) ? String(row.CategoryName).trim() : null,
  };
  if (record.daily === null && record.weekly === null && record.monthly === null)
    throw new Error(`Equipment-rate ${sourceRateId} has no prices`);
  return record;
}

interface TargetItem {
  id: string;
  name: string;
  netsuiteItemId: string;
  category: string | null;
}

type SourceConfig =
  | { kind: "postgres"; config: pg.PoolConfig }
  | {
      kind: "sqlserver";
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
    };

export interface EquipmentRateImportSummary {
  sourceRows: number;
  importedItems: number;
  importedLines: number;
  unmatched: Array<{ sourceRateId: string; netsuiteItemId: string }>;
  duplicateSourceItemIds: string[];
  targetItemsWithoutLegacyRate: Array<{ id: string; name: string; netsuiteItemId: string }>;
  dryRun: boolean;
}

async function findTargetItems(
  client: PoolClient,
  orgId: string,
): Promise<Map<string, TargetItem[]>> {
  const result = await client.query<TargetItem>(
    `select id::text, name, category, custom->>'nsId' as "netsuiteItemId"
       from items
      where org_id=$1 and custom->>'nsId' is not null`,
    [orgId],
  );
  const bySource = new Map<string, TargetItem[]>();
  for (const item of result.rows) {
    const key = sourceId(item.netsuiteItemId);
    if (!key) continue;
    const group = bySource.get(key) ?? [];
    group.push({ ...item, netsuiteItemId: key });
    bySource.set(key, group);
  }
  return bySource;
}

export function parseTsqlEquipmentRateRows(output: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const columns = rawLine.split("\t").map((value) => value.trim());
    if (columns.length !== 7 || !/^\d+$/.test(columns[0] ?? "")) continue;
    rows.push({
      id: columns[0],
      NetsuiteItemID: columns[1],
      Daily: columns[2],
      Weekly: columns[3],
      Monthly: columns[4],
      AppliesTo: columns[5],
      CategoryName: columns[6],
    });
  }
  return rows;
}

async function querySqlServerEquipmentRates(
  config: Extract<SourceConfig, { kind: "sqlserver" }>,
): Promise<SourceRow[]> {
  const query = `set nocount on
select convert(varchar(30),er.id),
       convert(varchar(30),er.NetsuiteItemID),
       coalesce(convert(varchar(50),er.Daily),''),
       coalesce(convert(varchar(50),er.Weekly),''),
       coalesce(convert(varchar(50),er.Monthly),''),
       coalesce(replace(replace(replace(er.AppliesTo,char(9),' '),char(10),' '),char(13),' '),''),
       coalesce(replace(replace(replace(c.Name,char(9),' '),char(10),' '),char(13),' '),'')
  from equipmentrates er
  left join equipmentratecategories c on c.id=er.CategoryID
 order by er.id
go
exit
`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "tsql",
      [
        "-H",
        config.host,
        "-p",
        String(config.port),
        "-U",
        config.user,
        "-D",
        config.database,
        "-o",
        "fhq",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`AdminApp2 SQL Server query failed: ${stderr.trim()}`));
    });
    // Keeping the password on stdin avoids exposing it in the process list.
    child.stdin.end(`${config.password}\n${query}`);
  });
  const rows = parseTsqlEquipmentRateRows(output);
  if (rows.length === 0)
    throw new Error("AdminApp2 SQL Server returned no equipment-rate rows");
  return rows;
}

async function querySourceEquipmentRates(source: SourceConfig): Promise<SourceRow[]> {
  if (source.kind === "sqlserver") return querySqlServerEquipmentRates(source);
  const pool = new pg.Pool(source.config);
  try {
    const result = await pool.query(
      `select er.id, er."NetsuiteItemID", er."Daily", er."Weekly",
              er."Monthly", er."AppliesTo", c."Name" as "CategoryName"
         from adminapp2.equipmentrates er
         left join adminapp2.equipmentratecategories c on c.id=er."CategoryID"
        order by er.id`,
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

async function ensureRateBook(
  client: PoolClient,
  orgId: string,
  currency: string,
): Promise<{ bookId: string; versionId: string }> {
  const bookId = deterministicUuid("adminapp2-equipment-rate-book", orgId);
  const versionId = deterministicUuid("adminapp2-equipment-rate-version", orgId);
  const assignmentId = deterministicUuid(
    "adminapp2-equipment-rate-assignment",
    orgId,
  );
  await client.query(
    `insert into item_rate_books (id,org_id,code,name,currency,is_default,is_active)
     values ($1,$2,$3,$4,$5,false,true)
     on conflict (org_id,code) do update set
       name=excluded.name,currency=excluded.currency,is_active=true,updated_at=now()`,
    [bookId, orgId, RATE_BOOK_CODE, RATE_BOOK_NAME, currency],
  );
  const actualBook = await client.query<{ id: string }>(
    `select id::text from item_rate_books where org_id=$1 and code=$2`,
    [orgId, RATE_BOOK_CODE],
  );
  const resolvedBookId = actualBook.rows[0]?.id;
  if (!resolvedBookId) throw new Error("Could not create equipment rate book");
  await client.query(
    `insert into item_rate_versions
       (id,org_id,rate_book_id,effective_from,effective_to,status,custom)
     values ($1,$2,$3,$4,null,'draft',$5::jsonb)
     on conflict (rate_book_id,effective_from) do update set
       effective_to=null,status='draft',
       custom=item_rate_versions.custom || excluded.custom,updated_at=now()`,
    [
      versionId,
      orgId,
      resolvedBookId,
      EFFECTIVE_FROM,
      JSON.stringify({ source: "adminapp2-equipment-rates" }),
    ],
  );
  const actualVersion = await client.query<{ id: string }>(
    `select id::text from item_rate_versions
      where rate_book_id=$1 and effective_from=$2`,
    [resolvedBookId, EFFECTIVE_FROM],
  );
  const resolvedVersionId = actualVersion.rows[0]?.id;
  if (!resolvedVersionId) throw new Error("Could not create equipment rate version");
  await client.query(
    `insert into item_rate_book_assignments
       (id,org_id,rate_book_id,rate_version_id,customer_id,project_id,
        effective_from,effective_to,date_basis,is_active)
     values ($1,$2,$3,null,null,null,null,null,'usage_date',true)
     on conflict (id) do update set
       rate_book_id=excluded.rate_book_id,is_active=true,updated_at=now()`,
    [assignmentId, orgId, resolvedBookId],
  );
  return { bookId: resolvedBookId, versionId: resolvedVersionId };
}

async function importRecord(
  client: PoolClient,
  orgId: string,
  versionId: string,
  item: TargetItem,
  record: EquipmentRateRecord,
): Promise<number> {
  await client.query(
    `insert into item_rate_profiles
       (org_id,item_id,base_unit,pricing_policy,invoice_presentation,is_active)
     values ($1,$2,'day','capped_ladder','rate_components',true)
     on conflict (org_id,item_id) do update set
       base_unit='day',pricing_policy='capped_ladder',
       invoice_presentation='rate_components',is_active=true,updated_at=now()`,
    [orgId, item.id],
  );
  await client.query(
    `update items set
       kind='equipment_charge',
       default_rate=coalesce($3::numeric,default_rate),
       description=coalesce($4,description),
       category=coalesce($5,category),
       custom=custom || $6::jsonb,
       updated_at=now()
     where id=$1 and org_id=$2`,
    [
      item.id,
      orgId,
      record.daily,
      record.appliesTo,
      record.category,
      JSON.stringify({
        adminapp2EquipmentRateId: record.sourceRateId,
        adminapp2EquipmentRateSource: true,
      }),
    ],
  );
  const tiers = [
    ["day", "Day", "1", record.daily, 0],
    ["week", "Week", "4", record.weekly, 1],
    ["month", "Month", "12", record.monthly, 2],
  ] as const;
  let count = 0;
  for (const [code, name, baseQuantity, billRate, sortOrder] of tiers) {
    if (billRate === null) continue;
    const lineId = deterministicUuid(
      "adminapp2-equipment-rate-line",
      `${orgId}:${item.id}:${code}`,
    );
    await client.query(
      `insert into item_rate_lines
         (id,org_id,version_id,item_id,unit_code,unit_name,base_quantity,
          cost_rate,bill_rate,time_type_bill_rates,sort_order)
       values ($1,$2,$3,$4,$5,$6,$7,0,$8,'{}'::jsonb,$9)
       on conflict (version_id,item_id,unit_code) do update set
         unit_name=excluded.unit_name,base_quantity=excluded.base_quantity,
         cost_rate=excluded.cost_rate,bill_rate=excluded.bill_rate,
         sort_order=excluded.sort_order,updated_at=now()`,
      [
        lineId,
        orgId,
        versionId,
        item.id,
        code,
        name,
        baseQuantity,
        billRate,
        sortOrder,
      ],
    );
    count++;
  }
  return count;
}

export async function importAdminApp2EquipmentRates(options: {
  source: SourceConfig;
  targetConnectionString: string;
  orgId: string;
  currency: string;
  dryRun?: boolean;
}): Promise<EquipmentRateImportSummary> {
  const target = new pg.Pool({ connectionString: options.targetConnectionString });
  const client = await target.connect();
  try {
    const records = (await querySourceEquipmentRates(options.source)).map(
      toEquipmentRateRecord,
    );
    const duplicateSourceItemIds = [
      ...records.reduce((counts, row) => {
        counts.set(row.netsuiteItemId, (counts.get(row.netsuiteItemId) ?? 0) + 1);
        return counts;
      }, new Map<string, number>()),
    ]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);
    if (duplicateSourceItemIds.length)
      throw new Error(
        `AdminApp2 has duplicate equipment rates for NetSuite item ids: ${duplicateSourceItemIds.join(", ")}`,
      );

    await client.query("begin");
    await client.query("set local app.bypass_rls='on'");
    const org = await client.query<{ base_currency: string }>(
      `select base_currency from orgs where id=$1`,
      [options.orgId],
    );
    if (!org.rowCount) throw new Error(`Organization ${options.orgId} not found`);
    const targetItems = await findTargetItems(client, options.orgId);
    const unmatched: EquipmentRateImportSummary["unmatched"] = [];
    const matchedSourceIds = new Set<string>();
    let importedItems = 0;
    let importedLines = 0;
    const { versionId } = await ensureRateBook(
      client,
      options.orgId,
      options.currency || org.rows[0]!.base_currency,
    );
    for (const record of records) {
      const matches = targetItems.get(record.netsuiteItemId) ?? [];
      if (matches.length === 0) {
        unmatched.push({
          sourceRateId: record.sourceRateId,
          netsuiteItemId: record.netsuiteItemId,
        });
        continue;
      }
      if (matches.length > 1)
        throw new Error(
          `NetSuite item ${record.netsuiteItemId} matches ${matches.length} target items`,
        );
      importedLines += await importRecord(
        client,
        options.orgId,
        versionId,
        matches[0]!,
        record,
      );
      matchedSourceIds.add(record.netsuiteItemId);
      importedItems++;
    }
    await client.query(
      `update item_rate_versions set status='active',updated_at=now()
        where id=$1 and org_id=$2`,
      [versionId, options.orgId],
    );
    const targetItemsWithoutLegacyRate = [...targetItems.values()]
      .flat()
      .filter(
        (item) =>
          !matchedSourceIds.has(item.netsuiteItemId) &&
          item.category?.toLowerCase() === "equipment",
      );
    if (options.dryRun) await client.query("rollback");
    else await client.query("commit");
    return {
      sourceRows: records.length,
      importedItems,
      importedLines,
      unmatched,
      duplicateSourceItemIds,
      targetItemsWithoutLegacyRate,
      dryRun: Boolean(options.dryRun),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await target.end();
  }
}

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return values;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const sourceEnv = arg("--source-env");
  const orgId = arg("--org-id");
  if (!sourceEnv || !orgId)
    throw new Error(
      "Usage: --source-env <path> --org-id <uuid> [--currency CAD] [--apply]",
    );
  const targetConnectionString = process.env.OPENBOOKS_DB_URL;
  if (!targetConnectionString) throw new Error("OPENBOOKS_DB_URL is required");
  const env = parseEnv(await readFile(sourceEnv, "utf8"));
  const source: SourceConfig = env.PGHOST
    ? {
        kind: "postgres",
        config: {
          host: env.PGHOST,
          port: Number(env.PGPORT || 5432),
          database: env.PGDATABASE,
          user: env.PGUSER,
          password: env.PGPASSWORD,
          ssl:
            env.PGSSLMODE === "require"
              ? { rejectUnauthorized: false }
              : undefined,
        },
      }
    : {
        kind: "sqlserver",
        host: env.DB_HOST,
        port: Number(env.DB_PORT || 1433),
        database: env.DB_DATABASE,
        user: env.DB_USERNAME,
        password: env.DB_PASSWORD,
      };
  if (
    (source.kind === "postgres" &&
      (!source.config.host || !source.config.database || !source.config.user)) ||
    (source.kind === "sqlserver" &&
      (!source.host || !source.database || !source.user || !source.password))
  )
    throw new Error(
      "Source env needs PGHOST/PGDATABASE/PGUSER/PGPASSWORD or DB_HOST/DB_DATABASE/DB_USERNAME/DB_PASSWORD",
    );
  const summary = await importAdminApp2EquipmentRates({
    source,
    targetConnectionString,
    orgId,
    currency: (arg("--currency") ?? "CAD").toUpperCase(),
    dryRun: !argv.includes("--apply"),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
