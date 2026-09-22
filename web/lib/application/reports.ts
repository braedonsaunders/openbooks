import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrg } from "@openbooks/engine/src/platform/db.ts";
import { parseReportQuery } from "../report-filters";
import { resolvePeriod } from "../periods";
import { canAccessReportDefinition, withReportAuthz } from "../report-execution-context";
import { resolveDefinitionToExportData } from "../report-run";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";

export interface ApplicationReportDefinition {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  reportType: string;
  slug: string | null;
  entity: string | null;
}

interface ReportDefinitionRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  kind: string;
  report_type: "query" | "statement";
  slug: string | null;
  query: { entity?: string } | null;
  statement: { kind?: string; params?: Record<string, string> } | null;
}

function asAuthorizationDefinition(row: ReportDefinitionRow) {
  return {
    report_type: row.report_type,
    query: row.query,
    statement: row.statement,
    name: row.name,
    slug: row.slug ?? "",
    kind: row.kind,
  };
}

function present(row: ReportDefinitionRow): ApplicationReportDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    reportType: row.report_type,
    slug: row.slug,
    entity: row.query?.entity ?? row.statement?.kind ?? null,
  };
}

async function loadVisibleDefinitions(
  context: ApplicationContext,
): Promise<ReportDefinitionRow[]> {
  assertApplicationPermission(context, "reports.read");
  const rows = (await db.execute<ReportDefinitionRow>(sql`
    select id, name, description, kind,
           coalesce(report_type, 'query') as report_type,
           slug, query, statement
      from report_definitions
     where org_id = ${context.authz.user.orgId}
     order by updated_at desc, name
  `)).rows;
  const visible: ReportDefinitionRow[] = [];
  for (const row of rows) {
    if (await canAccessReportDefinition(context.authz, asAuthorizationDefinition(row))) {
      visible.push(row);
    }
  }
  return visible;
}

/** List report definitions this actor may run. Same catalog as the Reports hub. */
export async function listApplicationReports(
  context: ApplicationContext,
  input: { query?: string } = {},
): Promise<{ definitions: ApplicationReportDefinition[] }> {
  const visible = await loadVisibleDefinitions(context);
  const needle = input.query?.trim().toLowerCase();
  const definitions = visible
    .filter((row) => !needle || row.name.toLowerCase().includes(needle))
    .map(present);
  return { definitions };
}

/** One report definition after tenant and permission checks. */
export async function getApplicationReport(
  context: ApplicationContext,
  definitionId: string,
): Promise<ApplicationReportDefinition> {
  if (!isUuid(definitionId)) throw invalidInput("id must be a UUID");
  const visible = await loadVisibleDefinitions(context);
  const row = visible.find((candidate) => candidate.id === definitionId);
  if (!row) throw notFound("report");
  return present(row);
}

/**
 * Execute a saved report through the same resolver the Reports hub, export,
 * and scheduler use. Restricted subsidiary scopes are refused by name until
 * that resolver carries the allowlist end to end — silent widening is not
 * a fallback.
 */
export async function runApplicationReport(
  context: ApplicationContext,
  input: { definitionId: string; period?: string; fromDate?: string; toDate?: string },
): Promise<Record<string, unknown>> {
  assertApplicationPermission(context, "reports.read");
  if (context.authz.allowedSubsidiaryIds !== null) {
    throw forbidden("reports.unrestricted_scope");
  }
  if (!isUuid(input.definitionId)) throw invalidInput("definitionId must be a UUID");

  const orgId = context.authz.user.orgId;
  const params = new URLSearchParams();
  if (input.period && input.period !== "custom") {
    params.set("period", input.period);
  } else if (input.fromDate && input.toDate) {
    params.set("period", "custom");
    params.set("from", input.fromDate);
    params.set("to", input.toDate);
  }
  const query = parseReportQuery(params);
  const period = await resolvePeriod(query.period, {
    customFrom: input.fromDate,
    customTo: input.toDate,
    orgId,
  });

  try {
    const data = await withReportAuthz(context.authz, () =>
      withOrg(orgId, () =>
        resolveDefinitionToExportData(orgId, input.definitionId, params, {
          orgId,
          t: (key) => key,
          period,
          query,
        }),
      ),
    );
    return {
      title: data.title,
      dateRangeLabel: data.dateRangeLabel,
      summary: data.summary,
      groups: data.groups,
    };
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    const message = error instanceof Error ? error.message : "report refused";
    if (/not found/i.test(message)) throw notFound("report");
    if (/access denied|forbidden|disabled/i.test(message)) throw forbidden("reports.read");
    throw invalidInput(message);
  }
}
