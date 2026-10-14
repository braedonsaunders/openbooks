import { createHash } from 'node:crypto';
import { automationGraphSchema } from '@openbooks/forms-core';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../platform/db.ts';
import { canonicalJson } from '../../platform/canonical-json.ts';
import { BenefitsError } from './errors.ts';

export type BenefitSubmissionIdentity={orgId:string;actorId:string;subjectKind:string;subjectId:string;runId:string};
export type BenefitSubmissionRun={id:string;flowId:string;createdBy:string;status:string;error:string|null;context:Record<string,unknown>};
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

/** Only the same run's completed routing under the current graph can finish automatic submission. */
export function assertBenefitSubmissionRouting(identity:BenefitSubmissionIdentity,run:BenefitSubmissionRun,currentGraph:unknown):void {
  const parsed=automationGraphSchema.safeParse(currentGraph),proof=object(run.context.submissionRouting),policy=object(run.context.submissionPolicy);
  if(!parsed.success||run.id!==identity.runId||run.status!=='completed'||run.error!==null||!proof||!policy
    ||proof.version!==1||proof.runId!==run.id||proof.flowId!==run.flowId||proof.subjectKind!==identity.subjectKind
    ||proof.subjectId!==identity.subjectId||proof.actorId!==identity.actorId||proof.outcome!=='apply'||proof.gatesCreated!==0
    ||!Array.isArray(proof.failures)||proof.failures.length!==0||typeof run.context.event_source!=='string'||!run.context.event_source
    ||proof.eventSource!==run.context.event_source||policy.ungatedOutcome!=='apply'||policy.flowId!==run.flowId
    ||!object(policy.graph)||canonicalJson(policy.graph)!==canonicalJson(parsed.data)
    ||proof.graphDigest!==createHash('sha256').update(canonicalJson(parsed.data)).digest('hex'))
    throw new BenefitsError('REFUSED','Automatic benefit submission needs the exact completed routing proof under the current Flow policy — review and retry its existing run in Flows');
}

export async function requireAutomaticBenefitSubmission(exec:SqlExecutor,identity:BenefitSubmissionIdentity):Promise<BenefitSubmissionRun>{
  const runs=(await exec.execute<BenefitSubmissionRun>(sql`select id,flow_id as "flowId",created_by as "createdBy",status,error,context
    from flow_runs where org_id=${identity.orgId} and id=${identity.runId} and subject_kind=${identity.subjectKind}
      and subject_id=${identity.subjectId} and trigger='on_submit' for update`)).rows;
  if(runs.length!==1)throw new BenefitsError('REFUSED','This benefit has no matching original submission run — preserve its evidence and review its submission in Flows');
  const run=runs[0]!;
  const flows=(await exec.execute<{graph:unknown}>(sql`select graph from flows where org_id=${identity.orgId} and id=${run.flowId}
    and enabled and subject_kind=${identity.subjectKind} for share`)).rows;
  if(flows.length!==1)throw new BenefitsError('REFUSED','The original benefit submission Flow is unavailable or disabled — review its existing policy');
  assertBenefitSubmissionRouting(identity,run,flows[0]!.graph);
  const outstanding=(await exec.execute<{blocked:boolean}>(sql`select
    exists(select 1 from flow_runs where org_id=${identity.orgId} and subject_kind=${identity.subjectKind} and subject_id=${identity.subjectId}
      and id<>${run.id} and status in ('failed','running','waiting'))
    or exists(select 1 from flow_gates where org_id=${identity.orgId} and subject_kind=${identity.subjectKind} and subject_id=${identity.subjectId}) as blocked`)).rows;
  if(outstanding.length!==1||outstanding[0]!.blocked)throw new BenefitsError('REFUSED','Benefit workflow gates or failed submissions remain — resolve the existing workflow rather than recording automatic approval');
  return run;
}
