import { authorizeTimeWorkspace } from "@/lib/time-workspace";
import { defineRoute } from "@/lib/api/route";
import { reopenTimesheetBodySchema, handleReopenTimesheet } from "@/lib/timesheet-week-lifecycle";

export const runtime = "nodejs";

export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.reopen"),
  feature: {
    none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target.",
  },
  body: reopenTimesheetBodySchema,
  handler: handleReopenTimesheet,
});
