import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { validateReportLayout } from "@openbooks/reports";
import { isDocumentRevisionToken } from "./api/registry-data";
import { isUuid } from "./list-params";
import { can, type Authz } from "./authz";
import { validateOrgReportQuery } from "./custom-record-report-catalog";
import { canAccessReportDefinition } from "./report-execution-context";
import { guardReportEntity } from "./report-authz";
import { loadReportDefinition, slugifyReportName, uniqueReportSlug } from "./custom-reports";
import { claimIdempotentCreate, resolveIdempotentReplay } from "./api/idempotency";
import { auditSetupChange } from "./setup/audit";
import {
  ApplicationError,
  conflict,
  forbidden,
  invalidInput,
  notFound,
} from "./application/errors";

export type ReportDefinitionInput = {
  name: string;
  description?: string | null;
  query: unknown;
  layout?: unknown;
};

const REPORT_DEFINITION_REVISION = sql`to_char(
  updated_at at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
)`;

export async function loadReportDefinitionRevision(
  orgId: string,
  id: string,
): Promise<string | null> {
  const result = await db.execute<{ updated_at: string }>(
    sql`
    select ${REPORT_DEFINITION_REVISION} as updated_at
      from report_definitions
     where id = ${id} and org_id = ${orgId}
  `,
    "objects",
  );
  return result[0]?.updated_at ?? null;
}

/** Save a custom query definition through the same audited writer used by the Reports hub. */
export async function createReportDefinition(
  authz: Authz,
  input: ReportDefinitionInput,
  idempotencyId: string = randomUUID(),
): Promise<{ definition: Record<string, unknown>; replayed: boolean }> {
  if (!can(authz, "reports.create")) {
    throw forbidden("reports.create");
  }
  const name = input.name.trim();
  if (!name) throw invalidInput("A report name is required");
  let query: unknown;
  try {
    query = await validateOrgReportQuery(authz, input.query);
  } catch (error) {
    throw invalidInput(error instanceof Error ? error.message : "Invalid report query");
  }
  const denied = await guardReportEntity(authz, query);
  if (denied) {
    const body = (await denied.json().catch(() => ({}))) as Record<string, unknown>;
    const message = typeof body.error === "string" ? body.error : "Report data access denied";
    throw new ApplicationError(
      denied.status === 404 ? "not_found" : "forbidden",
      message,
      denied.status,
      body,
    );
  }
  const description = input.description?.trim() || null;
  let layout: Record<string, unknown> | null;
  try {
    layout = (validateReportLayout(input.layout) as Record<string, unknown> | null) ?? null;
  } catch (error) {
    throw invalidInput(error instanceof Error ? error.message : "Invalid report layout");
  }
  const orgId = authz.user.orgId;
  const userId = authz.user.id;
  const slug = await uniqueReportSlug(orgId, slugifyReportName(name));
  const snapshot = {
    id: idempotencyId,
    org_id: orgId,
    kind: "custom",
    report_type: "query",
    slug,
    name,
    description,
    query,
    layout,
    system: false,
    created_by: userId,
    updated_by: userId,
  };
  const match = { name, description, query, layout };
  const outcome = await db.transaction(async (tx) => {
    const claim = await claimIdempotentCreate(tx, {
      orgId,
      table: "report_definitions",
      key: idempotencyId,
    });
    if (claim === "exists") {
      return {
        kind: "replay" as const,
        result: await resolveIdempotentReplay(tx, {
          orgId,
          table: "report_definitions",
          key: idempotencyId,
          match,
        }),
      };
    }
    const inserted = await tx.execute<Record<string, unknown>>(
      sql`
        insert into report_definitions
          (id, org_id, kind, report_type, slug, name, description, query, layout,
           system, created_by, updated_by)
        values (${idempotencyId}, ${orgId}, 'custom', 'query', ${slug}, ${name}, ${description},
                ${JSON.stringify(query)}::jsonb, ${layout ? JSON.stringify(layout) : null}::jsonb,
                false, ${userId}, ${userId})
        -- The idempotency identity is resolved only after its payload is matched.
        on conflict (id) do nothing
        returning id, kind, slug, name, description, query, layout, updated_at
      `,
      "objects",
    );
    const row = inserted[0];
    if (!row) {
      return {
        kind: "replay" as const,
        result: await resolveIdempotentReplay(tx, {
          orgId,
          table: "report_definitions",
          key: idempotencyId,
          match,
        }),
      };
    }
    await auditSetupChange(
      {
        orgId,
        table: "report_definitions",
        rowId: idempotencyId,
        action: "insert",
        changes: { before: null, after: snapshot },
        actorId: userId,
        requestId: idempotencyId,
      },
      tx,
    );
    return { kind: "created" as const, definition: row };
  });
  if (outcome.kind === "replay") {
    if (outcome.result === "conflict")
      throw conflict("This idempotency key was already used with different report content.");
    const existing = (
      await db.execute<Record<string, unknown>>(
        sql`select id, kind, slug, name, description, query, layout, updated_at
              from report_definitions where id = ${idempotencyId} and org_id = ${orgId}`,
        "objects",
      )
    )[0];
    if (!existing) throw conflict("The saved report could not be resolved after a retry.");
    return { definition: existing, replayed: true };
  }
  return { definition: outcome.definition, replayed: false };
}

/** Clone a visible source report by saving its query as a new audited definition. */
export async function cloneReportDefinition(
  authz: Authz,
  id: string,
  name: string,
): Promise<{ definition: Record<string, unknown>; replayed: boolean }> {
  const source = await loadReportDefinition(authz.user.orgId, id);
  if (!source) throw notFound("report");
  if (!(await canAccessReportDefinition(authz, source))) throw notFound("report");
  if (!source.query) throw invalidInput("Only query reports can be cloned.");
  return createReportDefinition(authz, {
    name,
    description: source.description,
    query: source.query,
    layout: source.layout,
  });
}

/** Update one visible definition under its exact revision token and audit the before/after state. */
export async function updateReportDefinition(
  authz: Authz,
  id: string,
  input: {
    name?: string;
    description?: string | null;
    query?: unknown;
    layout?: unknown;
    expectedUpdatedAt?: unknown;
  },
): Promise<Record<string, unknown>> {
  if (!can(authz, "reports.create")) throw forbidden("reports.create");
  if (!isUuid(id)) throw notFound("report");
  const orgId = authz.user.orgId;
  const existing = await loadReportDefinition(orgId, id);
  if (!existing) throw notFound("report");
  if (!(await canAccessReportDefinition(authz, existing))) throw forbidden("reports.read");
  const expectedUpdatedAt = input.expectedUpdatedAt;
  if (!isDocumentRevisionToken(expectedUpdatedAt)) {
    throw conflict(
      "The report definition revision is required; reload and review the latest revision.",
    );
  }
  let name = existing.name;
  let slug = existing.slug;
  if (input.name !== undefined) {
    name = input.name.trim();
    if (!name) throw invalidInput("A report name is required");
    if (name !== existing.name) slug = await uniqueReportSlug(orgId, slugifyReportName(name), id);
  }
  let query = existing.query;
  if (input.query !== undefined) {
    try {
      query = await validateOrgReportQuery(authz, input.query);
    } catch (error) {
      throw invalidInput(error instanceof Error ? error.message : "Invalid report query");
    }
    const denied = await guardReportEntity(authz, query);
    if (denied) {
      const body = (await denied.json().catch(() => ({}))) as Record<string, unknown>;
      const message = typeof body.error === "string" ? body.error : "Report data access denied";
      throw new ApplicationError(
        denied.status === 404 ? "not_found" : "forbidden",
        message,
        denied.status,
        body,
      );
    }
  }
  let layout = existing.layout;
  if (input.layout !== undefined) {
    try {
      layout = validateReportLayout(input.layout);
    } catch (error) {
      throw invalidInput(error instanceof Error ? error.message : "Invalid report layout");
    }
  }
  const description =
    input.description !== undefined ? input.description?.trim() || null : existing.description;
  const updated = await db.transaction(async (tx) => {
    const result = await tx.execute<Record<string, unknown>>(
      sql`
      update report_definitions set
        name = ${name}, slug = ${slug}, description = ${description},
        query = ${JSON.stringify(query)}::jsonb,
        layout = ${layout ? JSON.stringify(layout) : null}::jsonb,
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
        updated_by = ${authz.user.id}
      where id = ${id} and org_id = ${orgId}
        and ${REPORT_DEFINITION_REVISION} = ${expectedUpdatedAt}
      returning id, kind, report_type, slug, name, description, query, statement,
                system, layout, created_at, updated_at, created_by, updated_by
    `,
      "objects",
    );
    const after = result[0];
    if (!after) return null;
    await auditSetupChange(
      {
        orgId,
        table: "report_definitions",
        rowId: id,
        action: "update",
        changes: { before: existing, after },
        actorId: authz.user.id,
      },
      tx,
    );
    return after;
  });
  if (!updated) {
    throw conflict(
      "This report definition changed after you opened it; reload and review the latest revision.",
    );
  }
  const definition = await loadReportDefinition(orgId, id);
  const updatedAt = await loadReportDefinitionRevision(orgId, id);
  if (!definition) throw notFound("report");
  return { ...definition, updated_at: updatedAt ?? definition.updated_at };
}

/** Archive a custom report and disable its active deliveries in one audit transaction. */
export async function archiveReportDefinition(authz: Authz, id: string): Promise<void> {
  if (!can(authz, "reports.create")) throw forbidden("reports.create");
  if (!isUuid(id)) throw notFound("report");
  const orgId = authz.user.orgId;
  const existing = await loadReportDefinition(orgId, id);
  if (!existing) throw notFound("report");
  if (!(await canAccessReportDefinition(authz, existing))) throw forbidden("reports.read");
  if (existing.kind === "built_in") {
    throw invalidInput("Built-in reports cannot be deleted; clone the report first.");
  }
  await db.transaction(async (tx) => {
    const archived = await tx.execute<Record<string, unknown>>(
      sql`
      update report_definitions
         set archived_at = clock_timestamp(), archived_by = ${authz.user.id},
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${authz.user.id}
       where id = ${id} and org_id = ${orgId} and kind = 'custom' and archived_at is null
      returning id, kind, report_type, slug, name, description, query, statement,
                system, layout, created_at, updated_at, created_by, updated_by,
                archived_at, archived_by
    `,
      "objects",
    );
    const after = archived[0];
    if (!after) throw notFound("report");
    await tx.execute(sql`
      update report_schedules set active = false, updated_at = now()
       where org_id = ${orgId} and definition_id = ${id} and active
    `);
    await auditSetupChange(
      {
        orgId,
        table: "report_definitions",
        rowId: id,
        action: "delete",
        changes: { before: existing, after },
        actorId: authz.user.id,
      },
      tx,
    );
  });
}
