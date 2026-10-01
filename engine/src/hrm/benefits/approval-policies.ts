import { sql } from "drizzle-orm";
import { BENEFIT_AWARD_SUBJECT_KIND } from "@openbooks/schema/src/benefits-programs.ts";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { getBenefitProgram } from "./programs.ts";
import { requireActorId, requireId, requireOrgId } from "./shared.ts";

export interface BenefitApprovalPolicies {
  readonly configured: boolean;
  readonly href: string;
  readonly policies: readonly {
    id: string;
    name: string;
    ungatedOutcome: "apply" | "require_approval";
    href: string;
  }[];
}

/** Policy availability is descriptive; conditional eligibility is assessed on submission. */
export async function listBenefitApprovalPolicies(query: {
  orgId: string;
  actorId: string;
  programId: string;
}): Promise<BenefitApprovalPolicies> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const programId = requireId(query.programId, "programId");
  return withOrgTransaction(orgId, async () => {
    await getBenefitProgram(db, orgId, actorId, programId);
    const rows = (
      await db.execute<{
        id: string;
        name: string;
        ungated_outcome: string | null;
      }>(
        sql`select id, name, graph->>'ungatedOutcome' as ungated_outcome from flows where org_id = ${orgId} and subject_kind = ${BENEFIT_AWARD_SUBJECT_KIND} and enabled order by name, id`,
      )
    ).rows;
    return {
      configured: rows.length > 0,
      href: "/admin/flows",
      policies: rows.map((row) => ({
        id: row.id,
        name: row.name,
        ungatedOutcome:
          row.ungated_outcome === "apply" ? "apply" : "require_approval",
        href: `/admin/flows/${row.id}`,
      })),
    };
  });
}
