import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { can } from "../authz";
import { listResources } from "../data-io/resources";
import type { AssistantToolDef, ToolResult } from "./types";
import { capList } from "./tools-shared";

/**
 * Operations read tools for the agentic assistant: the surfaces the
 * whole-app coverage matrix (coverage-matrix.test.ts) flagged as gaps —
 * data import/export, sync connectors, environments, PDF templates, report
 * deliveries. Each mirrors its screen/route's gate and query shape, is
 * org-scoped on every query, and returns compact rows with href deep links.
 */

const listDataResources: AssistantToolDef = {
  name: "list_data_resources",
  description:
    "Import/export resources: key, label, group, natural key, import support. Same registry and per-resource read-permission filter as the data pages. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["data.export"] },
  inputSchema: z.object({
    group: z.enum(["Setup", "Master data", "Property management", "Records", "Transactions"]).optional().describe("Only resources in this group"),
    supportsImport: z.boolean().optional().describe("Only resources that support import"),
    q: z.string().max(100).optional().describe("Filter by label or key text"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { group?: string; supportsImport?: boolean; q?: string };
    // Same two calls as GET /api/data/resources: list, then keep what the
    // caller may read. Descriptors carry no rows, so no subsidiary fence.
    const all = await listResources(authz.user.orgId);
    const q = a.q?.trim().toLowerCase();
    const items = all
      .filter((d) => can(authz, d.readPermission))
      .filter((d) => !a.group || d.group === a.group)
      .filter((d) => a.supportsImport === undefined || d.supportsImport === a.supportsImport)
      .filter((d) => !q || d.label.toLowerCase().includes(q) || d.key.toLowerCase().includes(q))
      .map((d) => ({
        key: d.key,
        label: d.label,
        group: d.group,
        supportsImport: d.supportsImport,
        naturalKey: d.naturalKey ?? null,
        canPost: d.canPost ?? false,
      }));
    const { items: capped, truncated } = capList(items);
    return {
      ok: true,
      data: { total: items.length, truncated, href: "/data/export", items: capped },
    };
  },
};

const importRunStatus = z.enum(["committed", "failed"]).optional().describe("Only runs in this status");

function firstErrorText(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0];
  const text =
    typeof first === "string"
      ? first
      : typeof first === "object" && first !== null && "message" in first
        ? String((first as { message: unknown }).message)
        : JSON.stringify(first);
  return text.length > 300 ? `${text.slice(0, 300)}…[truncated]` : text;
}

const listImportRuns: AssistantToolDef = {
  name: "list_import_runs",
  description:
    "Data import history: per-run resource, file, status, row counts, and actor, newest first. Same rows as the import history page. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["data.import"] },
  inputSchema: z.object({
    resourceKey: z.string().max(120).optional().describe("Only runs for this resource key"),
    status: importRunStatus,
    limit: z.number().int().min(1).max(100).optional().describe("Max runs, default 25"),
    offset: z.number().int().min(0).optional().describe("Rows to skip for paging (default 0)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { resourceKey?: string; status?: "committed" | "failed"; limit?: number; offset?: number };
    const limit = Math.min(a.limit ?? 25, 100);
    const offset = a.offset ?? 0;
    // Same shape as loadImportHistory in
    // web/app/(app)/data/import/history/view.ts, plus the requested filters.
    // History rows carry no subsidiary, exactly like the view: data.import.
    let where = sql`j.org_id = ${authz.user.orgId}`;
    if (a.resourceKey) where = sql`${where} and j.resource_key = ${a.resourceKey}`;
    if (a.status) where = sql`${where} and j.status = ${a.status}`;
    const [rows, count] = await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select j.id, j.resource_key, j.resource_label, j.format, j.file_name, j.status,
               j.total_rows, j.created_count, j.updated_count, j.failed_count, j.created_at,
               u.name as actor_name,
               case when jsonb_typeof(j.errors) = 'array' then jsonb_array_length(j.errors) else 0 end as error_count,
               case when jsonb_typeof(j.errors) = 'array' and jsonb_array_length(j.errors) > 0 then j.errors->0 else null end as first_error
          from import_jobs j
          left join users u on u.id = j.created_by
         where ${where}
         order by j.created_at desc
         limit ${limit} offset ${offset}
      `),
      db.execute<{ n: string }>(sql`select count(*) as n from import_jobs j where ${where}`),
    ]);
    const total = Number(count.rows[0]?.n ?? 0);
    const items = rows.rows.map((j) => ({
      id: j.id,
      resourceKey: j.resource_key,
      resourceLabel: (j.resource_label as string | null) ?? j.resource_key,
      fileName: j.file_name,
      format: j.format,
      status: j.status,
      totalRows: j.total_rows,
      created: j.created_count,
      updated: j.updated_count,
      failed: j.failed_count,
      errorCount: j.error_count,
      firstError: firstErrorText(j.first_error),
      actor: (j.actor_name as string | null) ?? null,
      createdAt: j.created_at,
    }));
    return {
      ok: true,
      data: {
        total,
        returned: items.length,
        offset,
        truncated: offset + items.length < total,
        href: "/data/import/history",
        runs: items,
      },
    };
  },
};

export const OPS_TOOLS: AssistantToolDef[] = [listDataResources, listImportRuns];
