import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { seedApprovalFlow } from "@openbooks/engine/testing/fixtures";
import { installEngineSeams } from "@openbooks/engine/composition/install";
import { registerFlowApprovalReleaseHandlers } from "../lib/flow-approval-releases";
import { POST as decide } from "../app/api/flows/gates/decide/route";

/** Install the native application release boundary for integration fixtures. */
export async function installTimesheetFlowFixture() {
  installEngineSeams();
  await registerFlowApprovalReleaseHandlers();
}

/** Scenarios declare their actual tenant review policy before submitting hours. */
export async function configureTimesheetReviewFixture(
  orgId: string,
  reviewerId: string,
  preventSelfApproval = true,
) {
  await installTimesheetFlowFixture();
  await db.execute(
    sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"flows":true}'::jsonb) where id=${orgId}`,
  );
  return seedApprovalFlow(orgId, {
    subjectKind: "timesheet_week",
    assignees: [{ type: "user", userId: reviewerId }],
    mode: "all",
    preventSelfApproval,
  });
}

/** Exercise the real shared gate API against a submitted week's native gate. */
export async function decideTimesheetFixture(input: {
  orgId: string;
  employee: string;
  week: string;
  decision: "approved" | "rejected";
  reason?: string;
}): Promise<Response> {
  const gate = (
    await db.execute<{ id: string }>(
      sql`select g.id from timesheet_weeks w join flow_gates g
  on g.org_id=w.org_id and g.subject_id=w.id and g.subject_kind='timesheet_week'
  where w.org_id=${input.orgId} and w.employee_party_id=${input.employee} and w.week_start=${input.week}::date
  and g.status='pending' order by g.created_at,g.id limit 1`,
      "objects",
    )
  )[0];
  return decide(
    new Request("http://time.local/api/flows/gates/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gateId: gate?.id ?? randomUUID(),
        decision: input.decision,
        comment: input.reason,
      }),
    }),
  );
}
