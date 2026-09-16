import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { listConnections } from "@openbooks/engine/src/sync/connection.ts";
import { listSandboxes } from "@openbooks/engine/src/sandbox/index.ts";
import { PDF_RECORD_TYPE_BY_KEY } from "../pdf-templates/catalog";
import { getPdfTemplate, listPdfTemplates } from "../pdf-templates/store";
import { loadReportDefinition } from "../custom-reports";
import { canAccessReportArtifact, canAccessReportDefinition } from "../report-execution-context";
import { can } from "../authz";
import { listResources } from "../data-io/resources";
import type { AssistantToolDef, ToolResult } from "./types";
import { truncateText } from "./types";
import { capList, uuidInput } from "./tools-shared";

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
  return truncateText(text, 300);
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

type SyncRunEvidence = {
  status: string;
  kind: string;
  startedAt: unknown;
  finishedAt: unknown;
  syncedThrough: unknown;
  triggeredBy: unknown;
  error: string | null;
};

const listSyncConnections: AssistantToolDef = {
  name: "list_sync_connections",
  description:
    "Sync connectors: source, display name, status, mirror schedule, last run time and error, plus the latest run's evidence. Same list and last-run rows as the sync console. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["admin.setup.manage"] },
  inputSchema: z.object({
    source: z.string().max(40).optional().describe("Only connectors of this source"),
    status: z.string().max(30).optional().describe("Only connectors in this status"),
    limit: z.number().int().min(1).max(100).optional().describe("Max connectors, default 25"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { source?: string; status?: string; limit?: number };
    const limit = Math.min(a.limit ?? 25, 100);
    // Same reads as GET /api/platform/connections: the tenant's connections
    // plus the latest sync_runs rows as last-run evidence. The sealed
    // credential blob never leaves the server — only its presence bit.
    const [connections, runs] = await Promise.all([
      listConnections(authz.user.orgId),
      db.execute<Record<string, unknown>>(sql`
        select id, connection_id as "connectionId", source, kind, status,
               started_at as "startedAt", finished_at as "finishedAt",
               synced_through as "syncedThrough", error_message as "errorMessage", triggered_by as "triggeredBy"
          from sync_runs where org_id = ${authz.user.orgId} order by started_at desc limit 200`),
    ]);
    const latestByConnection = new Map<string, SyncRunEvidence>();
    for (const row of runs.rows) {
      const id = row.connectionId as string | null;
      if (!id || latestByConnection.has(id)) continue;
      latestByConnection.set(id, {
        status: String(row.status),
        kind: String(row.kind),
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        syncedThrough: row.syncedThrough,
        triggeredBy: row.triggeredBy,
        error: typeof row.errorMessage === "string" ? truncateText(row.errorMessage, 300) : null,
      });
    }
    const items = connections
      .filter((c) => !a.source || c.source === a.source)
      .filter((c) => !a.status || c.status === a.status)
      .slice(0, limit)
      .map((c) => ({
        id: c.id,
        source: c.source,
        displayName: c.displayName,
        authKind: c.authKind,
        status: c.status,
        mirrorEnabled: c.mirrorEnabled,
        mirrorSchedule: c.mirrorSchedule,
        postedChangePolicy: c.postedChangePolicy,
        cursor: c.cursor,
        lastRunAt: c.lastRunAt,
        lastError: c.lastError ? truncateText(c.lastError, 300) : null,
        hasSecrets: c.secrets !== null,
        lastRun: latestByConnection.get(c.id) ?? null,
      }));
    const { items: capped, truncated } = capList(items, limit);
    return {
      ok: true,
      data: { total: items.length, truncated, href: "/sync", items: capped },
    };
  },
};

const listEnvironments: AssistantToolDef = {
  name: "list_environments",
  description:
    "Sandbox environments: name, tier, status, last refresh time and error, refresh schedule. Same rows as the environments admin page. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["admin.sandboxes.manage"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    // Same read as loadSandboxes in web/app/(app)/admin/sandboxes/view.ts:
    // managed against the home production org. Sandbox rows are
    // production-scoped config, not subsidiary rows — no subsidiary fence,
    // exactly like the loader.
    const rows = await listSandboxes(authz.user.productionOrgId);
    const { items, truncated } = capList(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        tier: s.tier,
        masked: s.masked,
        status: s.status,
        lastError: s.lastError ? truncateText(s.lastError, 300) : null,
        lastRefreshAt: s.lastRefreshAt,
        refreshSchedule: s.refreshSchedule,
        storageRows: s.storageRows,
        createdAt: s.createdAt,
      })),
    );
    return {
      ok: true,
      data: {
        total: rows.length,
        truncated,
        insideSandbox: authz.user.envKind !== "production",
        href: "/admin/sandboxes",
        items,
      },
    };
  },
};

const listPdfTemplatesTool: AssistantToolDef = {
  name: "list_pdf_templates",
  description:
    "PDF templates per record type: name, paper size, orientation, margins, default and active flags. Same rows as the template admin list, without the HTML bodies. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["admin.customization.manage"] },
  inputSchema: z.object({
    recordType: z.string().max(60).optional().describe("Only templates for this record type, e.g. customer_invoice"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { recordType?: string };
    // Same reads as GET /api/pdf-templates: unknown record types are refused,
    // and the list payload omits the (potentially large) HTML bodies.
    if (a.recordType && !PDF_RECORD_TYPE_BY_KEY[a.recordType]) {
      return { ok: false, error: "unknown_record_type" };
    }
    const rows = await listPdfTemplates(authz.user.orgId, a.recordType);
    const { items, truncated } = capList(
      rows.map((row) => ({
        id: row.id,
        recordType: row.recordType,
        name: row.name,
        description: row.description,
        paperSize: row.paperSize,
        orientation: row.orientation,
        marginMm: row.marginMm,
        isDefault: row.isDefault,
        isActive: row.isActive,
        updatedAt: row.updatedAt,
      })),
    );
    return {
      ok: true,
      data: { total: rows.length, truncated, href: "/admin/pdf-templates", items },
    };
  },
};

const getPdfTemplateTool: AssistantToolDef = {
  name: "get_pdf_template",
  description:
    "One PDF template's render configuration and design source: record type, paper, orientation, margins, default/active flags, and the source HTML truncated to fit. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.customization.manage"] },
  inputSchema: z.object({ id: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { id: string };
    const row = await getPdfTemplate(authz.user.orgId, a.id);
    if (!row) return { ok: false, error: "template_not_found" };
    return {
      ok: true,
      data: {
        id: row.id,
        recordType: row.recordType,
        name: row.name,
        description: row.description,
        paperSize: row.paperSize,
        orientation: row.orientation,
        marginMm: row.marginMm,
        isDefault: row.isDefault,
        isActive: row.isActive,
        updatedAt: row.updatedAt,
        href: `/admin/pdf-templates/${row.id}`,
        sourceHtmlChars: row.sourceHtml.length,
        headerHtmlChars: row.headerHtml?.length ?? 0,
        footerHtmlChars: row.footerHtml?.length ?? 0,
        sourceHtml: truncateText(row.sourceHtml, 6000),
        sourceTruncated: row.sourceHtml.length > 6000,
      },
    };
  },
};

type ReportRunRow = {
  id: string;
  definition_id: string;
  trigger: string;
  status: string;
  error: string | null;
  row_count: number | null;
  started_at: string | null;
  finished_at: string | null;
  scheduled_for: string | null;
  recipient_emails: unknown;
  authorization_snapshot: unknown;
};

async function visibleReportLabel(
  authz: Parameters<typeof canAccessReportDefinition>[0],
  orgId: string,
  definitionId: string,
  snapshot: unknown,
): Promise<string | null> {
  // Same visibility rule as GET /api/reports/schedules: the definition must
  // be loadable and runnable by this caller, and a stamped run must still
  // grant artifact access. Snapshots stay server-side either way.
  const def = await loadReportDefinition(orgId, definitionId);
  if (!def) return null;
  if (!(await canAccessReportDefinition(authz, def))) return null;
  if (snapshot != null && !(await canAccessReportArtifact(authz, snapshot))) return null;
  return def.name;
}

const listReportRuns: AssistantToolDef = {
  name: "list_report_runs",
  description:
    "Scheduled and manual report runs: definition, trigger, status, row counts, timing, and error, newest first. Same visibility rule as the schedules screen. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({
    definitionId: uuidInput.optional().describe("Only runs of this report definition"),
    status: z.string().max(30).optional().describe("Only runs in this status, e.g. succeeded, failed"),
    limit: z.number().int().min(1).max(100).optional().describe("Max runs, default 25"),
    offset: z.number().int().min(0).optional().describe("Rows to skip for paging (default 0)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { definitionId?: string; status?: string; limit?: number; offset?: number };
    const limit = Math.min(a.limit ?? 25, 100);
    const offset = a.offset ?? 0;
    let where = sql`r.org_id = ${authz.user.orgId}`;
    if (a.definitionId) where = sql`${where} and r.definition_id = ${a.definitionId}`;
    if (a.status) where = sql`${where} and r.status = ${a.status}`;
    const rows = (await db.execute<ReportRunRow>(sql`
      select r.id, r.definition_id, r.trigger, r.status, r.error, r.row_count,
             r.started_at, r.finished_at, r.scheduled_for, r.recipient_emails, r.authorization_snapshot
        from report_runs r
       where ${where}
       order by r.started_at desc nulls last, r.created_at desc
       limit ${limit} offset ${offset}
    `));
    const items: Record<string, unknown>[] = [];
    for (const row of rows.rows) {
      const label = await visibleReportLabel(authz, authz.user.orgId, row.definition_id, row.authorization_snapshot);
      if (!label) continue;
      items.push({
        id: row.id,
        definitionId: row.definition_id,
        definitionName: label,
        trigger: row.trigger,
        status: row.status,
        rowCount: row.row_count,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        scheduledFor: row.scheduled_for,
        recipientCount: Array.isArray(row.recipient_emails) ? row.recipient_emails.length : 0,
        error: typeof row.error === "string" ? truncateText(row.error, 300) : null,
      });
    }
    return {
      ok: true,
      data: { returned: items.length, offset, href: "/reports", runs: items },
    };
  },
};

const listEmailDeliveries: AssistantToolDef = {
  name: "list_email_deliveries",
  description:
    "Report email deliveries: recipient, status, attempts, timing, and error, newest first. Same visibility rule as the schedules screen. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({
    status: z.string().max(30).optional().describe("Only deliveries in this status, e.g. sent, failed, pending"),
    recipient: z.string().max(200).optional().describe("Filter by recipient address text"),
    limit: z.number().int().min(1).max(100).optional().describe("Max deliveries, default 25"),
    offset: z.number().int().min(0).optional().describe("Rows to skip for paging (default 0)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { recipient?: string; status?: string; limit?: number; offset?: number };
    const limit = Math.min(a.limit ?? 25, 100);
    const offset = a.offset ?? 0;
    let where = sql`d.org_id = ${authz.user.orgId}`;
    if (a.status) where = sql`${where} and d.status = ${a.status}`;
    if (a.recipient) where = sql`${where} and d.recipient ilike ${"%" + a.recipient + "%"}`;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select d.id, d.run_id as "runId", d.recipient, d.status, d.attempt_count as "attemptCount",
             d.last_attempt_at as "lastAttemptAt", d.sent_at as "sentAt", d.error, d.created_at as "createdAt",
             r.definition_id as "definitionId", r.authorization_snapshot as "snapshot"
        from report_delivery_outbox d
        join report_runs r on r.id = d.run_id and r.org_id = d.org_id
       where ${where}
       order by d.created_at desc
       limit ${limit} offset ${offset}
    `));
    const items: Record<string, unknown>[] = [];
    for (const row of rows.rows) {
      const label = await visibleReportLabel(authz, authz.user.orgId, String(row.definitionId), row.snapshot);
      if (!label) continue;
      items.push({
        id: row.id,
        runId: row.runId,
        definitionName: label,
        recipient: row.recipient,
        status: row.status,
        attemptCount: row.attemptCount,
        lastAttemptAt: row.lastAttemptAt,
        sentAt: row.sentAt,
        createdAt: row.createdAt,
        error: typeof row.error === "string" ? truncateText(row.error, 300) : null,
      });
    }
    return {
      ok: true,
      data: { returned: items.length, offset, href: "/reports", deliveries: items },
    };
  },
};

export const OPS_TOOLS: AssistantToolDef[] = [
  listDataResources,
  listImportRuns,
  listSyncConnections,
  listEnvironments,
  listPdfTemplatesTool,
  getPdfTemplateTool,
  listReportRuns,
  listEmailDeliveries,
];
