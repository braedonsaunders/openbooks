import { authorizeTimeWorkspace } from "@/lib/time-workspace";
import { defineRoute } from "@/lib/api/route";
import { billableBodySchema, handleTimesheetBillable } from "@/lib/time-entry-billable";

export const runtime = "nodejs";

export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.approve"),
  feature: {
    none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target.",
  },
  body: billableBodySchema,
  handler: handleTimesheetBillable,
});
