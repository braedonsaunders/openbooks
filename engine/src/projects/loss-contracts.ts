import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { recordOwnerSubsidiary } from "../organization/record-owner.ts";
import { cmp, normalizeMoney } from "../money/money.ts";
import { projectCostEstimate } from "./revenue.ts";
import { recognitionAccounts } from "./recognition.ts";

/**
 * How the organization treats projects whose estimated total cost exceeds
 * their contract value. Off reports nothing; warn flags each such project
 * that has no loss assessment applied in the period; require makes that
 * finding block the close. The provision itself is always measured and
 * posted through the governed loss assessment.
 */
export type ProjectLossPolicyMode = "off" | "warn" | "require";

/** The policy in effect on a date; an organization with no policy is off. */
export async function projectLossPolicyMode(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  asOfDate: string,
): Promise<ProjectLossPolicyMode> {
  const row = (
    await runner.execute<{ mode: ProjectLossPolicyMode }>(
      sql`
    select mode from project_loss_policies
     where org_id = ${orgId} and effective_from <= ${asOfDate}::date
     order by effective_from desc
     limit 1`,
      "objects",
    )
  )[0];
  return row?.mode ?? "off";
}

export interface UnassessedLossContract {
  projectId: string;
  code: string;
  name: string;
  contractValue: string;
  estimatedTotalCost: string;
}

/**
 * Projects forecasting a loss — estimated total cost above a positive
 * contract value as of the period end — with no loss assessment applied
 * within the period for the same project, owning legal entity and book.
 * Cost is measured exactly as percent complete measures it, in the
 * project's owning entity and the given book.
 *
 * `subsidiaryIds` is the close's entity scope: empty means the close
 * covers every entity. A project with no subsidiary belongs to the
 * organization's unique root; one whose owner cannot be resolved has no
 * entity to measure or assess in, and revenue recognition already refuses
 * it by name.
 */
export async function unassessedLossContracts(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  input: {
    periodStartsOn: string;
    periodEndsOn: string;
    bookId: string;
    subsidiaryIds: readonly string[];
  },
): Promise<UnassessedLossContract[]> {
  if (!(await orgFeatureEnabled(orgId, "projects", runner as SqlExecutor))) return [];
  const progressOn = await orgFeatureEnabled(orgId, "projectProgress", runner as SqlExecutor);
  const scope =
    input.subsidiaryIds.length > 0
      ? sql`and owned.owner_id = any(${`{${input.subsidiaryIds.join(",")}}`}::uuid[])`
      : sql``;
  const projects = await runner.execute<{
    id: string;
    code: string;
    name: string;
    subsidiary_id: string;
    contract_value: string;
  }>(
    sql`
    select owned.id, owned.code, owned.name, owned.owner_id as subsidiary_id, owned.contract_value::text as contract_value
      from (
        select p.id, p.org_id, p.code, p.name, p.contract_value,
               ${recordOwnerSubsidiary(orgId, sql`p.subsidiary_id`)} as owner_id
          from projects p
         where p.org_id = ${orgId} and p.is_active and p.contract_value > 0
      ) owned
     where owned.owner_id is not null
       ${scope}
       and not exists (
         select 1 from financial_changes change
           join provision_obligations obligation
             on obligation.org_id = change.org_id and obligation.id = change.subject_id
          where change.org_id = owned.org_id and change.domain = 'provision' and change.status = 'applied'
            and obligation.project_id = owned.id
            and obligation.subsidiary_id = owned.owner_id
            and obligation.book_id = ${input.bookId}
            and change.effective_on between ${input.periodStartsOn}::date and ${input.periodEndsOn}::date)
     order by owned.code, owned.id`,
    "objects",
  );
  if (projects.length === 0) return [];
  const laborWip = (await recognitionAccounts(orgId, runner)).laborWip ?? null;
  const found: UnassessedLossContract[] = [];
  for (const project of projects) {
    const { estimatedTotal } = await projectCostEstimate(runner, orgId, {
      projectId: project.id,
      subsidiaryId: project.subsidiary_id,
      bookId: input.bookId,
      laborWipAccountId: laborWip,
      asOfDate: input.periodEndsOn,
      progressOn,
    });
    if (cmp(estimatedTotal, project.contract_value) > 0) {
      found.push({
        projectId: project.id,
        code: project.code,
        name: project.name,
        contractValue: normalizeMoney(project.contract_value),
        estimatedTotalCost: estimatedTotal,
      });
    }
  }
  return found;
}

/**
 * Contract projects with no resolvable owning entity: no subsidiary while the
 * organization has several root entities. Their cost cannot be measured or
 * assessed in any entity, so a loss policy cannot certify them; the remedy
 * is assigning the project's subsidiary.
 */
export async function unownedContractProjects(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
): Promise<{ projectId: string; code: string; name: string }[]> {
  if (!(await orgFeatureEnabled(orgId, "projects", runner as SqlExecutor))) return [];
  return await runner.execute<{ projectId: string; code: string; name: string }>(
    sql`
    select p.id as "projectId", p.code, p.name
      from projects p
     where p.org_id = ${orgId} and p.is_active and p.contract_value > 0
       and ${recordOwnerSubsidiary(orgId, sql`p.subsidiary_id`)} is null
     order by p.code, p.id`,
    "objects",
  );
}
