import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import {
  requireAggregateRecruitingRead,
  requireHrmRecruitingRead,
} from "../authorization.ts";
import { requireOrgId, requireActorId, requireId } from "./input.ts";
import { getRequisitionDetail, getCandidateDetail } from "./recruiting-read.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { RecruitingError } from "./errors.ts";

export type ApplicationWorklistRow = {
  id: string;
  candidate: string;
  candidateId: string;
  opening: string;
  requisitionId: string;
  stage: string;
  stageId: string;
  status: string;
  source: string | null;
  appliedOn: string;
  owner: string | null;
};
/** Cross-job queue: every row is scoped through its own requisition, never another application of the same candidate. */
export async function listApplicationWorklist(args: {
  orgId: string;
  actorId: string;
  status?: string;
  opening?: string;
  stage?: string;
}): Promise<ApplicationWorklistRow[]> {
  const orgId = requireOrgId(args.orgId),
    actorId = requireActorId(args.actorId);
  if (
    args.status &&
    !["active", "rejected", "withdrawn", "hired"].includes(args.status)
  )
    throw new RecruitingError(
      "INVALID_INPUT",
      "Choose an available application status.",
    );
  const opening = args.opening ? requireId(args.opening, "opening") : null,
    stage = args.stage ? requireId(args.stage, "stage") : null;
  return withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, "hrmRecruiting")))
      throw new RecruitingError(
        "REFUSED",
        "Enable Recruiting in Company Settings → Features.",
      );
    const allowed = await requireAggregateRecruitingRead(db, orgId, actorId);
    return (
      await db.execute<ApplicationWorklistRow>(sql`
      select a.id,c.display_name as candidate,c.id as "candidateId",r.title as opening,r.id as "requisitionId",
        s.name as stage,s.id as "stageId",a.status,c.source,a.applied_on::text as "appliedOn",p.display_name as owner
      from hrm_applications a join hrm_candidates c on c.org_id=a.org_id and c.id=a.candidate_id
      join hrm_requisitions r on r.org_id=a.org_id and r.id=a.requisition_id
      join hrm_pipeline_stages s on s.org_id=a.org_id and s.id=a.stage_id
      left join parties p on p.org_id=r.org_id and p.id=r.hiring_manager_party_id
      where a.org_id=${orgId} ${subsidiaryVisibleFilter(sql`r.employer_subsidiary_id`, allowed)}
        ${args.status ? sql`and a.status=${args.status}` : sql``}
        ${opening ? sql`and r.id=${opening}` : sql``}
        ${stage ? sql`and s.id=${stage}` : sql``}
      order by a.applied_on,a.id
    `)
    ).rows;
  });
}
export async function getApplicationWorkspace(args: {
  orgId: string;
  actorId: string;
  applicationId: string;
}) {
  const orgId = requireOrgId(args.orgId),
    actorId = requireActorId(args.actorId),
    id = requireId(args.applicationId, "applicationId");
  return withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, "hrmRecruiting")))
      throw new RecruitingError(
        "REFUSED",
        "Enable Recruiting in Company Settings → Features.",
      );
    const application = (
      await db.execute<{ requisitionId: string; candidateId: string }>(
        sql`select requisition_id as "requisitionId",candidate_id as "candidateId" from hrm_applications where org_id=${orgId} and id=${id}`,
      )
    ).rows[0];
    if (!application)
      throw new RecruitingError(
        "NOT_FOUND",
        "This application is not available. Return to the application list.",
      );
    await requireHrmRecruitingRead(
      db,
      orgId,
      actorId,
      application.requisitionId,
    );
    const requisition = await getRequisitionDetail({
      orgId,
      actorId,
      requisitionId: application.requisitionId,
    });
    const selected = requisition.applications.find((a) => a.id === id);
    if (!selected)
      throw new RecruitingError(
        "NOT_FOUND",
        "This application is not available. Return to the application list.",
      );
    const candidate = await getCandidateDetail({
      orgId,
      actorId,
      candidateId: application.candidateId,
    });
    const events = (
      await db.execute<{
        id: string;
        kind: string;
        reason: string | null;
        at: string;
        fromStage: string | null;
        toStage: string | null;
      }>(sql`
      select e.id,e.kind,e.reason,e.recorded_at::text as at,f.name as "fromStage",t.name as "toStage"
      from hrm_application_events e left join hrm_pipeline_stages f on f.org_id=e.org_id and f.id=e.from_stage_id
      left join hrm_pipeline_stages t on t.org_id=e.org_id and t.id=e.to_stage_id
      where e.org_id=${orgId} and e.application_id=${id} order by e.recorded_at desc,e.id desc
    `)
    ).rows;
    return {
      application: selected,
      candidate,
      requisition: {
        id: requisition.id,
        title: requisition.title,
        description: requisition.description,
        stages: requisition.stages,
      },
      events,
    };
  });
}

export type ApplicationWorkspace = Awaited<
  ReturnType<typeof getApplicationWorkspace>
>;
