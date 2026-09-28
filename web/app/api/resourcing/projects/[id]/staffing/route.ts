import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { projects } from "@openbooks/schema";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { addCalendarDays, businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { weekStartOf } from "@openbooks/engine/src/resourcing/weeks.ts";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { loadPlanVsActual } from "@/lib/resourcing/tie-out";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";

const Params = z.object({ id: z.string().uuid() }).strict();

/**
 * Project staffing tie-out for the project cockpit Staffing tab: plan vs
 * approved time per person-week over the last four weeks, with the same
 * evidence the resourcing cockpit shows. A project outside the caller's
 * subsidiary scope answers notFound, identical to absent.
 */
export const GET = defineRoute({
  permission: "resourcing.read",
  feature: "resourcing",
  params: Params,
  handler: async ({ authz, params }) => {
    const orgId = authz.user.orgId;
    const visible = await db.select({ id: projects.id })
      .from(projects)
      .where(sql`${and(eq(projects.orgId, orgId), eq(projects.id, params.id))}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, authz.allowedSubsidiaryIds)}`);
    if (visible.length === 0) return notFound("project");
    const lastSunday = weekStartOf(await businessToday(orgId));
    const firstSunday = addCalendarDays(lastSunday, -21);
    const rows = await loadPlanVsActual(orgId, authz.allowedSubsidiaryIds, {
      firstSunday,
      lastSunday,
      projectId: params.id,
    });
    return Response.json({ rows });
  },
});
