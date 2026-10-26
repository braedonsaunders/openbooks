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
    const rows = await db.execute<{
      id: string;
      name: string;
    }>(
      sql`select id, name from flows where org_id = ${orgId} and subject_kind = ${BENEFIT_AWARD_SUBJECT_KIND} and enabled order by name, id`,
      "objects",
    );
    return {
      configured: rows.length > 0,
      href: "/admin/flows",
      policies: rows.map((row) => ({
        id: row.id,
        name: row.name,
        href: `/admin/flows/${row.id}`,
      })),
    };
  });
}
