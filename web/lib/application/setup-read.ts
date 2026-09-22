import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  FEATURES,
  featureEnabled,
  resolvedFeatureState,
  type FeatureState,
} from "../features";
import { loadExtensionSettingRows } from "../setup/extension-settings";
import {
  SETUP_ENTITIES,
  SETUP_ENTITY_BY_KEY,
  setupEntityForFeatureState,
  toSnake,
  type SetupEntity,
} from "../setup/registry";
import { clamp } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError } from "./errors";

function setupEntityEnabled(entity: SetupEntity, features: FeatureState): boolean {
  if (!entity.featureKey) return true;
  return featureEnabled(features, entity.featureKey);
}

function resolveEntity(base: SetupEntity, features: FeatureState): SetupEntity {
  return setupEntityForFeatureState(base, {
    multiSubsidiary: featureEnabled(features, "multiSubsidiary"),
    equipment: featureEnabled(features, "equipment"),
    fieldTickets: featureEnabled(features, "fieldTickets"),
  });
}

/** Setup-registry catalog, with this org's feature gates applied. */
export async function listSetupEntities(context: ApplicationContext) {
  const features = await resolvedFeatureState(context.authz.user.orgId);
  return {
    entities: SETUP_ENTITIES.map((entity) => ({
      key: entity.key,
      groupKey: entity.groupKey,
      table: entity.table,
      rehomed: entity.rehomed ?? false,
      nestedUnder: entity.nestedUnder ?? null,
      featureKey: entity.featureKey ?? null,
      enabled: setupEntityEnabled(entity, features),
      hasActive: entity.hasActive,
    })),
  };
}

function setupEntityMissing(): ApplicationError {
  return new ApplicationError(
    "not_found",
    "setup entity not found; list enabled entities from GET /api/v1/setup",
    404,
  );
}

function setupRecordMissing(entityKey: string): ApplicationError {
  return new ApplicationError(
    "not_found",
    `setup record not found; list ids from GET /api/v1/setup/${entityKey}`,
    404,
  );
}

async function requireSetupEntity(context: ApplicationContext, entityKey: string): Promise<SetupEntity> {
  assertApplicationPermission(context, "admin.setup.manage");
  const base = SETUP_ENTITY_BY_KEY.get(entityKey);
  if (!base) throw setupEntityMissing();
  const features = await resolvedFeatureState(context.authz.user.orgId);
  if (!setupEntityEnabled(base, features)) throw setupEntityMissing();
  return resolveEntity(base, features);
}

function mapSetupRecord(entity: SetupEntity, row: Record<string, unknown>): Record<string, unknown> {
  const idColumn = entity.idColumn ?? "id";
  return {
    id: row[idColumn],
    ...Object.fromEntries(entity.columns.map((column) => [column.key, row[toSnake(column.key)]])),
  };
}

/** Records of one Setup entity — same registry-driven select as /admin/setup. */
export async function listSetupRecords(
  context: ApplicationContext,
  input: { entityKey: string; query?: string; limit?: number },
) {
  const entity = await requireSetupEntity(context, input.entityKey);
  const limit = clamp(input.limit ?? 50, 1, 200);
  if (entity.dataSource === "extension-settings") {
    const needle = input.query?.trim().toLowerCase();
    const rows = (await loadExtensionSettingRows(context.authz.user.orgId)).filter((row) =>
      !needle || Object.values(row).some((value) => String(value).toLowerCase().includes(needle)),
    );
    return {
      entityKey: entity.key,
      total: rows.length,
      records: rows.slice(0, limit),
    };
  }
  const orgId = context.authz.user.orgId;
  const idColumn = entity.idColumn ?? "id";
  const columnKeys = entity.columns.map((column) => toSnake(column.key));
  const selectCols = [...new Set([idColumn, ...columnKeys])];
  const searchColumns = entity.columns.map(
    (column) => sql`cast(${sql.raw(toSnake(column.key))} as text) ilike ${`%${input.query ?? ""}%`}`,
  );
  const rowFilter = sql`where 1 = 1
    ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
    ${entity.hasActive ? sql`and is_active` : sql``}
    ${input.query && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`;
  const orderBy = entity.orderBy ?? (entity.naturalKey ? toSnake(entity.naturalKey) : idColumn);
  const [rows, count] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select ${sql.raw(selectCols.join(", "))} from ${sql.raw(entity.table)} ${rowFilter}
       order by ${sql.raw(orderBy)}
       limit ${limit}`),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`),
  ]);
  return {
    entityKey: entity.key,
    total: Number(count.rows[0]?.n ?? 0),
    records: rows.rows.map((row) => mapSetupRecord(entity, row)),
  };
}

/** One Setup record by its primary key — never a paged list scan. */
export async function getSetupRecord(
  context: ApplicationContext,
  input: { entityKey: string; id: string },
) {
  const entity = await requireSetupEntity(context, input.entityKey);
  if (entity.dataSource === "extension-settings") {
    // The adapter returns the full active catalog, not a page; find by id
    // here is a key lookup over that complete set.
    const record = (await loadExtensionSettingRows(context.authz.user.orgId))
      .find((row) => String(row.id) === input.id);
    if (!record) throw setupRecordMissing(entity.key);
    return record;
  }
  const orgId = context.authz.user.orgId;
  const idColumn = entity.idColumn ?? "id";
  const columnKeys = entity.columns.map((column) => toSnake(column.key));
  const selectCols = [...new Set([idColumn, ...columnKeys])];
  const rows = await db.execute<Record<string, unknown>>(sql`
    select ${sql.raw(selectCols.join(", "))} from ${sql.raw(entity.table)}
     where ${sql.raw(idColumn)} = ${input.id}
     ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}`);
  if (rows.rows.length === 0) throw setupRecordMissing(entity.key);
  if (rows.rows.length !== 1) {
    throw new ApplicationError(
      "internal_error",
      `setup record id matched ${rows.rows.length} rows; refuse rather than guess`,
      500,
    );
  }
  return mapSetupRecord(entity, rows.rows[0]!);
}

/** Features switchboard as the Company Settings page shows it. */
export async function listApplicationFeatures(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.setup.manage");
  const features = await resolvedFeatureState(context.authz.user.orgId);
  return {
    features: FEATURES.map((feature) => ({
      key: feature.key,
      category: feature.category,
      defaultEnabled: feature.defaultEnabled,
      parentKey: feature.parentKey ?? null,
      requiresAll: feature.requiresAll ?? [],
      navModules: feature.navModules ?? [],
      enabled: featureEnabled(features, feature.key),
    })),
  };
}
