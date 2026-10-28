import { authorizeTimeWorkspace } from "@/lib/time-workspace";
import { defineRoute } from "@/lib/api/route";
import { submitTimesheetBodySchema, handleSubmitTimesheet } from "@/lib/timesheet-week-lifecycle";

export const runtime = "nodejs";

export const POST = defineRoute({
  authorize: authorizeTimeWorkspace("time.manage"),
  feature: {
    none: "The explicit workspace pins Time Tracking or Manufacturing; native commands fence every actual target.",
  },
  body: submitTimesheetBodySchema,
  handler: handleSubmitTimesheet,
});
