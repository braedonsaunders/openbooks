import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { automationGraphSchema } from '@openbooks/forms-core';
import { canonicalJson } from '../../platform/canonical-json.ts';
import { assertBenefitSubmissionRouting, type BenefitSubmissionRun } from './submission-routing.ts';

const identity={orgId:'org',actorId:'actor',subjectKind:'hrm_benefit_award',subjectId:'award',runId:'run'};
const graph=automationGraphSchema.parse({schemaVersion:1,ungatedOutcome:'apply',nodes:[{id:'submit',position:{x:0,y:0},data:{kind:'trigger',trigger:{trigger:'on_submit'}}}],edges:[]});
const proof={version:1,runId:'run',flowId:'flow',subjectKind:identity.subjectKind,subjectId:'award',eventSource:'script',outcome:'apply',gatesCreated:0,failures:[],graphDigest:createHash('sha256').update(canonicalJson(graph)).digest('hex'),actorId:'actor'};
function completed():BenefitSubmissionRun{return {id:'run',flowId:'flow',createdBy:'original-submitter',status:'completed',error:null,
  context:{event_source:'script',submissionRouting:{...proof},submissionPolicy:{ungatedOutcome:'apply',flowId:'flow',graph}}};}
test('automatic completion requires the completed same-run graph, actor and original source',()=>{
  const run=completed();assert.doesNotThrow(()=>assertBenefitSubmissionRouting(identity,run,graph));
  for(const status of ['running','waiting','failed'])assert.throws(()=>assertBenefitSubmissionRouting(identity,{...run,status},graph),/completed routing proof/);
  for(const patch of [{actorId:'different'},{subjectId:'different'},{runId:'different'},{flowId:'different'},{eventSource:'api'},
    {gatesCreated:1},{failures:['effect failed']},{graphDigest:'changed'},{version:2}])
    assert.throws(()=>assertBenefitSubmissionRouting(identity,{...run,context:{...run.context,submissionRouting:{...proof,...patch}}},graph),/completed routing proof/);
  assert.throws(()=>assertBenefitSubmissionRouting(identity,{...run,error:'retained failure'},graph),/completed routing proof/);
  assert.throws(()=>assertBenefitSubmissionRouting(identity,{...run,context:{...run.context,event_source:''}},graph),/completed routing proof/);
});
test('missing proof or changed current policy cannot imply automatic approval',()=>{
  const run=completed();
  for(const routing of [undefined,null,{},[],{...proof,failures:null}])
    assert.throws(()=>assertBenefitSubmissionRouting(identity,{...run,context:{...run.context,submissionRouting:routing}},graph),/completed routing proof/);
  assert.throws(()=>assertBenefitSubmissionRouting(identity,run,{...graph,ungatedOutcome:'require_approval'}),/completed routing proof/);
  assert.throws(()=>assertBenefitSubmissionRouting(identity,{...run,context:{...run.context,submissionPolicy:{ungatedOutcome:'apply',flowId:'flow'}}},graph),/completed routing proof/);
  assert.equal(run.context.event_source,'script','refusals never synthesize an api source');
});
