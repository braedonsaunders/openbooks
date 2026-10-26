import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { listFlowSubjectProfiles } from "@openbooks/engine/flows/module";
import { isFlowSubjectAvailable } from "@/lib/flows/subject-availability";
import { flowSubjectLabelKey } from "@/lib/flows/subject-labels";
import { flowSubjectGroup } from "./groups.ts";

export const runtime = "nodejs";

/**
 * Flow subject profiles — the builder vocabulary (triggers, actions,
 * statuses, fields, roles) per subject kind. Drives the New flow and New
 * approval record-type pickers, so it offers only the kinds whose owning
 * features are enabled for the organization; creating a flow rechecks the
 * same rule. The picker groups record types by product area (`group`, see
 * ./groups.ts), so same-named kinds from different families stay
 * distinguishable, and names each kind through its catalog `labelKey`.
 */
export const GET = defineRoute({
  permission: "flows.manage",
  feature: "flows",
  handler: async ({ authz }) => {
    const available = await isFlowSubjectAvailable(authz.user.orgId);
    return NextResponse.json({
      profiles: listFlowSubjectProfiles()
        .filter((profile) => available(profile.subjectKind))
        .map(({ label: _label, ...profile }) => ({
          ...profile,
          labelKey: flowSubjectLabelKey(profile),
          group: flowSubjectGroup(profile.subjectKind),
        })),
    });
  },
});
