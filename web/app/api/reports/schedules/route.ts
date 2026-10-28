import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { can } from "../../../../lib/authz";
import {
  canAccessReportArtifact,
  canAccessReportDefinition,
} from "../../../../lib/report-execution-context";
import { loadReportDefinition } from "../../../../lib/custom-reports";
import { createReportSchedule } from "../../../../lib/report-schedule-write";
import { reportScheduleRouteError } from "../../../../lib/report-schedule-route-error";
const POSTBodySchema1 = z.object({
  definitionId: uuidString(),
  cadence: z.enum(["daily", "weekly", "monthly"]),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minute: z.number().int().min(0).max(59).optional(),
  timezone: z.string().min(1),
  recipientEmails: z.array(z.string().email()),
  active: z.boolean().optional(),
  statementParams: z.record(z.string(), z.json()).optional(),
});

export const runtime = "nodejs";

/** List schedules for a definition (?definitionId=…). */
export const GET = defineRoute({
  permission: "reports.read",
  feature: {
    none: "This always-on route is governed by reports.read; the existing route has no separate feature gate.",
  },
  handler: async ({ request: req, authz: routeAuthz }) => {
    const gate = routeAuthz;
    const { user } = gate;
    const definitionId = new URL(req.url).searchParams.get("definitionId");
    const rows = await db.execute(
      sql`
        select id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
               timezone, recipient_emails, next_run_at, active, authorization_snapshot
          from report_schedules
         where org_id = ${user.orgId}
           ${definitionId ? sql`and definition_id = ${definitionId}` : sql``}
         order by next_run_at
      `,
      "objects",
    );
    const schedules = [];
    for (const row of rows) {
      const def = await loadReportDefinition(user.orgId, String(row.definition_id));
      if (
        def &&
        (await canAccessReportDefinition(gate, def)) &&
        (row.authorization_snapshot == null ||
          (await canAccessReportArtifact(gate, row.authorization_snapshot)))
      ) {
        const visible = { ...row };
        delete visible.authorization_snapshot;
        schedules.push(visible);
      }
    }
    return NextResponse.json({
      schedules,
      canSchedule: can(gate, "reports.schedule") || can(gate, "*"),
    });
  },
});

/**
 * Create a schedule for a definition. Cadence + recipients are validated by
 * the engine policy, and next_run_at is computed via computeNextRunAt so the
 * worker seam can pick due schedules up by a single index scan.
 */
export const POST = defineRoute({
  permission: "reports.schedule",
  feature: {
    none: "This always-on route is governed by reports.schedule; the existing route has no separate feature gate.",
  },
  body: POSTBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, body: routeBody }) => {
    const gate = routeAuthz;
    try {
      const schedule = await createReportSchedule(gate, routeBody, req.headers.get("X-Request-Id"));
      return NextResponse.json({ schedule }, { status: 201 });
    } catch (error) {
      return reportScheduleRouteError(error, req);
    }
  },
});
