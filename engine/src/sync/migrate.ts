import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import type { MigrationSource, SourceEntity } from "./source.ts";

/**
 * Master-data loader for full migrations. Drives the canonical entity streams
 * an adapter exposes (`source.entities()`) into openbooks, source-driven and
 * idempotent — the generalized successor to the one-shot seed-netsuite.ts,
 * which read the same shapes from local JSON dumps.
 *
 * Every landed row records its source id under `custom[refKey]`; re-running a
 * migration upserts by that key (never duplicates), and the GL sync reads the
 * same key to map accounts/departments/parties.
 */

export interface ResourceLoadStats {
  created: number;
  updated: number;
  skipped: number;
}
export type EntityLoadStats = Record<string, ResourceLoadStats>;

/** Resources this loader knows how to land. Order = dependency order. */
const KNOWN = new Set(["accounts", "departments", "projects", "parties", "items"]);

export async function loadEntities(
  source: MigrationSource,
  orgId: string,
): Promise<EntityLoadStats> {
  if (!source.entities) return {};
  const refKey = source.refKey;
  const streams = await source.entities();
  const stats: EntityLoadStats = {};

  for (const stream of streams) {
    if (!KNOWN.has(stream.resource)) {
      stats[stream.resource] = { created: 0, updated: 0, skipped: stream.records.length };
      continue;
    }
    const s: ResourceLoadStats = { created: 0, updated: 0, skipped: 0 };
    // sourceRef → landed uuid, for the hierarchical second pass.
    const idByRef = new Map<string, string>();

    for (const rec of stream.records) {
      try {
        const id = await upsert(stream.resource, orgId, refKey, rec, s);
        if (id) idByRef.set(rec.sourceRef, id);
      } catch (e) {
        s.skipped++;
        void e;
      }
    }

    // Second pass: link hierarchy (accounts, dimensions) now that every row exists.
    if (stream.resource === "accounts") {
      for (const rec of stream.records) {
        if (!rec.parentRef) continue;
        const child = idByRef.get(rec.sourceRef);
        const parent = idByRef.get(rec.parentRef);
        if (child && parent) {
          await db.execute(sql`update accounts set parent_id = ${parent} where id = ${child}`);
        }
      }
    }
    stats[stream.resource] = s;
  }
  return stats;
}

/**
 * Insert or update one canonical entity by its source ref. Returns the row id
 * (or null if the row couldn't be landed). Identifiers are from the trusted
 * KNOWN set; all values are bound parameters.
 */
async function upsert(
  resource: string,
  orgId: string,
  refKey: string,
  rec: SourceEntity,
  s: ResourceLoadStats,
): Promise<string | null> {
  const f = rec.fields;
  const existing = (await db.execute(sql`
    select id, custom from ${sql.raw(resource === "parties" ? "parties" : resource)}
     where org_id = ${orgId} and custom->>${refKey} = ${rec.sourceRef} limit 1`)) as {
    rows: { id: string; custom: Record<string, unknown> }[];
  };
  const found = existing.rows[0];

  if (resource === "accounts") {
    const type = String(f.type ?? "");
    if (!type) { s.skipped++; return null; }
    const vals = {
      number: (f.number as string) ?? null,
      name: String(f.name ?? `Account ${rec.sourceRef}`),
      type,
      isSummary: !!f.isSummary,
      isActive: f.isActive !== false,
      eliminate: !!f.eliminate,
      reconcilable: !!f.reconcilable,
    };
    if (found) {
      await db.execute(sql`
        update accounts set name = ${vals.name}, type = ${vals.type}::text,
          is_summary = ${vals.isSummary}, is_active = ${vals.isActive},
          eliminate = ${vals.eliminate}, reconcilable = ${vals.reconcilable}
         where id = ${found.id}`);
      s.updated++;
      return found.id;
    }
    const ins = (await db.execute(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, custom)
      values (${orgId}, ${vals.number}, ${vals.name}, ${vals.type}::text,
              ${vals.isSummary}, ${vals.isActive}, ${vals.eliminate}, ${vals.reconcilable},
              ${JSON.stringify({ [refKey]: rec.sourceRef })}::jsonb)
      returning id`)) as { rows: { id: string }[] };
    s.created++;
    return ins.rows[0]?.id ?? null;
  }

  if (resource === "departments" || resource === "projects") {
    const table = resource; // trusted: from KNOWN
    const name = String(f.name ?? `${resource} ${rec.sourceRef}`);
    if (found) {
      await db.execute(sql`update ${sql.raw(table)} set name = ${name} where id = ${found.id}`);
      s.updated++;
      return found.id;
    }
    const ins = (await db.execute(sql`
      insert into ${sql.raw(table)} (org_id, name, custom)
      values (${orgId}, ${name}, ${JSON.stringify({ [refKey]: rec.sourceRef })}::jsonb)
      returning id`)) as { rows: { id: string }[] };
    s.created++;
    return ins.rows[0]?.id ?? null;
  }

  if (resource === "items") {
    const name = String(f.name ?? `Item ${rec.sourceRef}`);
    const code = (f.code as string) ?? null;
    const itemKind = String(f.kind ?? "service");
    const isActive = f.isActive !== false;
    if (found) {
      await db.execute(sql`
        update items set name = ${name}, kind = ${itemKind}::text, is_active = ${isActive}
         where id = ${found.id}`);
      s.updated++;
      return found.id;
    }
    const ins = (await db.execute(sql`
      insert into items (org_id, kind, code, name, is_active, custom)
      values (${orgId}, ${itemKind}::text, ${code}, ${name}, ${isActive},
              ${JSON.stringify({ [refKey]: rec.sourceRef })}::jsonb)
      returning id`)) as { rows: { id: string }[] };
    s.created++;
    return ins.rows[0]?.id ?? null;
  }

  // parties
  const displayName = String(f.displayName ?? `Party ${rec.sourceRef}`);
  const kind = f.kind === "person" ? "person" : "company";
  const isActive = f.isActive !== false;
  if (found) {
    await db.execute(sql`
      update parties set display_name = ${displayName}, kind = ${kind}::text, is_active = ${isActive}
       where id = ${found.id}`);
    s.updated++;
    return found.id;
  }
  const ins = (await db.execute(sql`
    insert into parties (org_id, kind, display_name, is_active, custom)
    values (${orgId}, ${kind}::text, ${displayName}, ${isActive},
            ${JSON.stringify({ [refKey]: rec.sourceRef })}::jsonb)
    returning id`)) as { rows: { id: string }[] };
  s.created++;
  return ins.rows[0]?.id ?? null;
}
