import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { mutateInsight } from "@/lib/insight-mutations";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";
import {
  layoutCardsVisible,
  loadDashboard,
  normalizeAllowedRoles,
  normalizeLayout,
  strOrNull,
} from "../../_lib";
import { notFound } from "@/lib/api/responses";

export { runtime } from "@/lib/api/route";

// cardId stays a plain string here on purpose: a malformed reference must
// reach the domain check below (normalizeLayout) so the caller gets the
// usable 422 board refusal. Rejecting it in the schema would answer 400 and
// erase that domain refusal.
const layoutBody = z.array(z.strictObject({
  cardId: z.string(),
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(999),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(24),
})).max(1000, "layout cannot contain more than 1000 cards");
const revisionBody = z.string({ error: "expectedUpdatedAt is required; reload and review the latest revision" }).regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
  "expectedUpdatedAt must be the exact dashboard revision",
);

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

/**
 * PostgreSQL keeps six fractional digits on timestamptz values while the
 * node-postgres Date mapping does not. Dashboards use this exact wire token as
 * their optimistic-concurrency revision, so callers can safely echo it back
 * without losing precision between a read and a save.
 */
function dashboardRevisionSql(column: SQL): SQL<string> {
  return sql<string>`to_char(
    ${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`;
}

const DASHBOARD_REVISION_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DASHBOARD_REVISION_REQUIRED =
  "the dashboard revision is required; reload and review the latest revision";
const DASHBOARD_REVISION_CONFLICT =
  "this dashboard changed after you opened it; reload and review the latest revision";

class DashboardRevisionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DashboardRevisionError";
  }
}

function requireDashboardRevision(value: unknown): string {
  if (typeof value !== "string" || !DASHBOARD_REVISION_PATTERN.test(value)) {
    throw new DashboardRevisionError(409, DASHBOARD_REVISION_REQUIRED);
  }
  return value;
}

function assertDashboardRevision(expected: string, actual: unknown): void {
  if (typeof actual !== "string" || expected !== actual) {
    throw new DashboardRevisionError(409, DASHBOARD_REVISION_CONFLICT);
  }
}

export const GET = defineRoute({
  permission: "insights.read",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");
    const dashboard = await loadDashboard(id, gate.user.orgId);
    if (!dashboard)
      return notFound("record");
    return NextResponse.json(dashboard);
  },
});

interface PatchBody {
  /** Exact `updated_at` token returned by GET; required for every autosave. */
  expectedUpdatedAt?: unknown;
  name?: string;
  description?: string | null;
  layout?: unknown;
  allowedRoles?: unknown;
}

export const PATCH = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: z
    .strictObject({
      expectedUpdatedAt: revisionBody,
      name: z.string().trim().min(1, "name cannot be empty").max(200).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      layout: layoutBody.optional(),
      allowedRoles: z.array(z.string().trim().min(1, "allowedRoles cannot contain blank role keys")).nullable().optional(),
    })
    .refine((body) => Object.keys(body).some((key) => key !== "expectedUpdatedAt"), "provide at least one dashboard field to update"),
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const user = gate.user;
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    const existing = await loadDashboard(id, user.orgId);
    if (!existing)
      return notFound("record");

    const body = routeBody as PatchBody;

    let expectedRevision: string;
    try {
      expectedRevision = requireDashboardRevision(body.expectedUpdatedAt);
    } catch (e) {
      if (e instanceof DashboardRevisionError) {
        return apiErrorResponse(e);
      }
      throw e;
    }

    const name = body.name !== undefined ? body.name.trim() : undefined;
    if (name !== undefined && name === "")
      return bad("Dashboard name cannot be empty");

    let layout: ReturnType<typeof normalizeLayout> | undefined = undefined;
    if (body.layout !== undefined) {
      try {
        layout = normalizeLayout(body.layout);
      } catch (e) {
        return bad(e instanceof Error ? e.message : "invalid layout");
      }
    }

    let allowedRoles: string[] | null | undefined = undefined;
    if (body.allowedRoles !== undefined) {
      try {
        allowedRoles = normalizeAllowedRoles(body.allowedRoles);
      } catch (e) {
        return bad(e instanceof Error ? e.message : "invalid roles");
      }
    }

    try {
      const outcome = await mutateInsight(
        gate,
        "insight_dashboards",
        id,
        "update",
        async (tx) => {
          // Lock and compare in the same transaction as the replacement. A slow
          // request can therefore never commit over a newer save that advanced
          // the exact revision while this request was in flight.
          const locked = (
            await tx.execute<{ updatedAt: string }>(sql`
        select ${dashboardRevisionSql(sql.raw("updated_at"))} as "updatedAt"
          from insight_dashboards
         where id = ${id} and org_id = ${user.orgId}
         for update
      `)
          ).rows[0];
          if (!locked) throw new DashboardRevisionError(404, "not found");
          assertDashboardRevision(expectedRevision, locked.updatedAt);

          if (
            layout !== undefined &&
            !(await layoutCardsVisible(tx, gate, layout))
          ) {
            return bad("Layout references an unavailable card");
          }

          const updated = await tx.execute(sql`
        update insight_dashboards set
          name = ${name !== undefined ? name : sql`name`},
          description = ${body.description !== undefined ? strOrNull(body.description) : sql`description`},
          layout = ${layout !== undefined ? sql`${JSON.stringify(layout)}::jsonb` : sql`layout`},
          allowed_roles = ${allowedRoles !== undefined ? sql`${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb` : sql`allowed_roles`},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
          updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
        returning *, ${dashboardRevisionSql(sql.raw("updated_at"))} as updated_at
      `);
          return NextResponse.json(updated.rows[0]);
        },
      );
      return outcome;
    } catch (e) {
      if (e instanceof DashboardRevisionError) {
        return apiErrorResponse(e);
      }
      throw e;
    }
  },
});

export const DELETE = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const user = gate.user;
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    if (!(await loadDashboard(id, user.orgId)))
      return notFound("record");

    return mutateInsight(
      gate,
      "insight_dashboards",
      id,
      "delete",
      async (tx) => {
        await tx.execute(
          sql`delete from insight_dashboard_pins where dashboard_id = ${id} and org_id = ${user.orgId}`,
        );
        await tx.execute(
          sql`delete from insight_dashboards where id = ${id} and org_id = ${user.orgId}`,
        );
        return NextResponse.json({ ok: true });
      },
    );
  },
});
