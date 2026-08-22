import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  FEATURES,
  featureEnabled,
  resolvedFeatureState,
  type FeatureState,
} from "../features";
import {
  SETUP_ENTITIES,
  SETUP_ENTITY_BY_KEY,
  setupEntityForFeatureState,
  toSnake,
  type SetupEntity,
} from "../setup/registry";
import type { AssistantToolDef, ToolResult } from "./types";
import { capList } from "./tools-shared";

/**
 * Read tools for the Setup registry (/admin/setup) and the Features
 * switchboard. Record listing mirrors the registry-driven select the setup
 * list page runs (app/(app)/admin/setup/[entity]/page.tsx): table and column
 * identifiers come ONLY from the registry (trusted constants, interpolated
 * with sql.raw exactly like the page and the CRUD API); every value stays a
 * bound parameter.
 */

/** Same rule as `setupEntityEnabled` in web/app/api/admin/setup/[entity]/route.ts:
 *  an entity without a featureKey is always on; otherwise it follows the org's
 *  resolved feature state. Callers resolve the state once and pass it in. */
function setupEntityEnabled(entity: SetupEntity, features: FeatureState): boolean {
  if (!entity.featureKey) return true;
  return featureEnabled(features, entity.featureKey);
}

const listSetupEntitiesTool: AssistantToolDef = {
  name: "list_setup_entities",
  description:
    "Enumerate every configuration entity in the Setup registry: key, setup-rail group, backing table, whether it is nested under or re-homed onto another surface, its optional-feature gate, and whether it is currently enabled for this org. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.setup.manage"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const features = await resolvedFeatureState(authz.user.orgId);
    const { items, truncated } = capList(
      SETUP_ENTITIES.map((e) => ({
        key: e.key,
        groupKey: e.groupKey,
        table: e.table,
        rehomed: e.rehomed ?? false,
        nestedUnder: e.nestedUnder ?? null,
        featureKey: e.featureKey ?? null,
        enabled: setupEntityEnabled(e, features),
        hasActive: e.hasActive,
      })),
    );
    return {
      ok: true,
      data: { total: SETUP_ENTITIES.length, truncated, href: "/admin/setup", items },
    };
  },
};

const listSetupRecordsTool: AssistantToolDef = {
  name: "list_setup_records",
  description:
    "List the configuration records of one Setup entity (by its key from list_setup_entities), optionally filtered by a text search across its list columns. Returns each row's id plus the entity's declared list columns; archived rows are excluded when the entity supports archiving. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["admin.setup.manage"] },
  inputSchema: z.object({
    entityKey: z.string().max(80),
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { entityKey: string; query?: string; limit?: number };
    const { orgId } = authz.user;
    const base = SETUP_ENTITY_BY_KEY.get(a.entityKey);
    if (!base) return { ok: false, error: "setup_entity_not_found" };
    const features = await resolvedFeatureState(orgId);
    if (!setupEntityEnabled(base, features)) return { ok: false, error: "feature_disabled" };
    // Same feature-derived descriptor the list page renders (drops subsidiary
    // columns when multi-subsidiary is off).
    const entity = setupEntityForFeatureState(base, {
      multiSubsidiary: featureEnabled(features, "multiSubsidiary"),
      equipment: featureEnabled(features, "equipment"),
    });
    const limit = Math.min(a.limit ?? 50, 200);
    const idColumn = entity.idColumn ?? "id";
    const columnKeys = entity.columns.map((c) => toSnake(c.key));
    // TRUSTED identifiers from the registry, never from the request — the same
    // sql.raw interpolation the setup list page and CRUD API use.
    const selectCols = [...new Set([idColumn, ...columnKeys])];
    const searchColumns = entity.columns.map(
      (c) => sql`cast(${sql.raw(toSnake(c.key))} as text) ilike ${`%${a.query ?? ""}%`}`,
    );
    const rowFilter = sql`where 1 = 1
      ${entity.orgScoped ? sql`and org_id = ${orgId}` : sql``}
      ${entity.hasActive ? sql`and is_active` : sql``}
      ${a.query && searchColumns.length ? sql`and (${sql.join(searchColumns, sql` or `)})` : sql``}`;
    const orderBy = entity.orderBy ?? (entity.naturalKey ? toSnake(entity.naturalKey) : idColumn);
    const [rowsRes, countRes] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select ${sql.raw(selectCols.join(", "))} from ${sql.raw(entity.table)} ${rowFilter}
         order by ${sql.raw(orderBy)}
         limit ${limit}`),
      db.execute<{ n: number }>(sql`
        select count(*)::int as n from ${sql.raw(entity.table)} ${rowFilter}`),
    ]);
    const total = Number(countRes.rows[0]?.n ?? 0);
    return {
      ok: true,
      data: {
        entityKey: entity.key,
        total,
        returned: rowsRes.rows.length,
        truncated: total > rowsRes.rows.length,
        href: `/admin/setup/${entity.key}`,
        items: rowsRes.rows.map((row) => ({
          id: row[idColumn],
          ...Object.fromEntries(entity.columns.map((c) => [c.key, row[toSnake(c.key)]])),
        })),
      },
    };
  },
};

const listFeaturesTool: AssistantToolDef = {
  name: "list_features",
  description:
    "The Features switchboard: every optional feature's key, category, default, parent/required features, the nav modules it gates, and whether it is currently enabled for this org (resolved state, including data-dependent defaults). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.setup.manage"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const features = await resolvedFeatureState(authz.user.orgId);
    const { items, truncated } = capList(
      FEATURES.map((f) => ({
        key: f.key,
        category: f.category,
        defaultEnabled: f.defaultEnabled,
        parentKey: f.parentKey ?? null,
        requiresAll: f.requiresAll ?? [],
        navModules: f.navModules ?? [],
        enabled: featureEnabled(features, f.key),
      })),
    );
    return {
      ok: true,
      data: { total: FEATURES.length, truncated, href: "/admin/setup/features", items },
    };
  },
};

export const SETUP_TOOLS: AssistantToolDef[] = [
  listSetupEntitiesTool,
  listSetupRecordsTool,
  listFeaturesTool,
];
