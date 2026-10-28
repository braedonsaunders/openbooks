import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { updateReportSchedule, deleteReportSchedule } from "@/lib/report-schedule-write";
import { reportScheduleRouteError } from "@/lib/report-schedule-route-error";

const params = z.object({ id: z.string() });
const updateBody = z
  .object({
    cadence: z.enum(["daily", "weekly", "monthly"]).optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    timezone: z.string().min(1).optional(),
    recipientEmails: z.array(z.string().email()).optional(),
    active: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });
const deleteBody = z
  .union([z.object({ reason: z.string().optional() }), z.undefined()])
  .refine((body) => body === undefined || Object.keys(body).length > 0, {
    message: "A delete reason is required when a request body is provided.",
  });

export const runtime = "nodejs";

export const PATCH = defineRoute({
  permission: "reports.schedule",
  feature: {
    none: "This always-on route is governed by reports.schedule; the existing route has no separate feature gate.",
  },
  params,
  body: updateBody,
  handler: async ({ request, authz, params: routeParams, body }) => {
    try {
      const schedule = await updateReportSchedule(
        authz,
        routeParams.id,
        body,
        request.headers.get("X-Request-Id"),
      );
      return Response.json({ schedule });
    } catch (error) {
      return reportScheduleRouteError(error, request, true);
    }
  },
});

export const DELETE = defineRoute({
  permission: "reports.schedule",
  feature: {
    none: "This always-on route is governed by reports.schedule; the existing route has no separate feature gate.",
  },
  params,
  body: deleteBody,
  handler: async ({ request, authz, params: routeParams, body }) => {
    try {
      await deleteReportSchedule(
        authz,
        routeParams.id,
        body?.reason,
        request.headers.get("X-Request-Id"),
      );
      return Response.json({ ok: true });
    } catch (error) {
      return reportScheduleRouteError(error, request, true);
    }
  },
});
