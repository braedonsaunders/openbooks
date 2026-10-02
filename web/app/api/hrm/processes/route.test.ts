import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  /** Independent outcome for the hrm.self.read fallback on the step-complete route. */
  selfGate: { user: { id: string; orgId: string } } | { status: number } | null;
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-processes-route-test");

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  selfGate: null,
  featureOn: true,
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const processesRealUrl = new URL("../../../../../engine/src/hrm/processes.ts", import.meta.url).href;
const processesReadRealUrl = new URL("../../../../../engine/src/hrm/processes-read.ts", import.meta.url).href;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-processes-route-test')]
      export async function guardPermission(permission) {
        const NextResponse = globalThis.openbooksHrmProcessRouteNextResponse
        if (permission !== 'hrm.self.read' && !permission.startsWith('hrm.process.')) {
          throw new Error('unexpected permission ' + permission)
        }
        const gate = permission === 'hrm.self.read' ? state.selfGate : state.gate
        if (!gate) throw new Error('unexpected self.read gate call')
        return 'status' in gate ? NextResponse.json({ error: 'denied' }, { status: gate.status }) : gate
      }
      export async function getAuthz() { return state.gate && 'status' in state.gate && state.gate.status === 401 ? null : state.gate }
      export function guardRootSubsidiaryScope() { return null } export function guardUnrestrictedScope() { return null }
      export async function isFeatureEnabled(orgId, key) { if (key !== 'hrm') throw new Error('unexpected feature ' + key); return state.featureOn }
      export async function guardFeaturePermission(permission, feature) { const gate = await guardPermission(permission); if (gate instanceof globalThis.openbooksHrmProcessRouteNextResponse) return gate; return await isFeatureEnabled(gate.user.orgId, feature) ? gate : globalThis.openbooksHrmProcessRouteNextResponse.json({ error: 'not found' }, { status: 404 }) }
    `,
  ],

  [
    "mock:processes-service",
    `
            export * from '${processesRealUrl}'
      const state = globalThis[Symbol.for('openbooks.hrm-processes-route-test')]
      function record(fn, result) { return async args => { state.calls.push({fn,args}); if(state.serviceThrow) throw state.serviceThrow; return typeof result==='function' ? result(args) : result } }
      export const openProcess=record('open',{id:'process-1',status:'open'})
      export const completeProcessStep=record('completeStep')
      export const skipProcessStep=record('skipStep')
      export const completeProcess=record('completeProcess')
      export const cancelProcess=record('cancelProcess')
      const designerResult=args=>({id:args.templateId,revision:1})
      export const saveChecklistDraft=record('saveChecklistDraft',designerResult)
      export const publishChecklistDraft=record('publishChecklistDraft',designerResult)
      export const retireChecklistTemplate=record('retireChecklistTemplate',designerResult)
      export const getChecklistDesigner=record('getChecklistDesigner',designerResult)
      export const getChecklistVersion=record('getChecklistVersion',designerResult)
      export const previewChecklistCoverage=record('previewChecklistCoverage',designerResult)
      export const submitChecklistStepApproval=record('submitChecklistStepApproval',designerResult)
    `,
  ],
  [
    "mock:processes-read-service",
    `
      export * from '${processesReadRealUrl}'
      const state = globalThis[Symbol.for('openbooks.hrm-processes-route-test')]
      function record(fn, result) { return async args => { state.calls.push({fn,args}); if(state.serviceThrow) throw state.serviceThrow; return result } }
      export const listProcesses = record('list', [{id:'process-1',status:'open'}])
      export const getProcess = record('get', {id:'process-1',status:'open'})
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmProcessRouteNextResponse = NextResponse;

// Authorization and feature outcomes vary per test; JSON validation stays real.
stubModules({
  authz: mockSources.get('mock:authz')!, features: mockSources.get('mock:authz')!,
  extra: {
    '@openbooks/engine/src/hrm/processes.ts': mockSources.get('mock:processes-service')!,
    '@openbooks/engine/hrm/processes': mockSources.get('mock:processes-service')!,
    '@openbooks/engine/src/hrm/processes-read.ts': mockSources.get('mock:processes-read-service')!,
    '@/lib/feature-gates': mockSources.get('mock:authz')!,
  },
});
type RouteModule = Record<string, ((req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>) | undefined>;
const loadRoute = async (path: string): Promise<RouteModule> => import(path);

const collectionRoute = await loadRoute("./route.ts?hrm-processes-collection");
const recordRoute = await loadRoute("./[id]/route.ts?hrm-processes-record");
const completeRoute = await loadRoute("./[id]/complete/route.ts?hrm-processes-complete");
const cancelRoute = await loadRoute("./[id]/cancel/route.ts?hrm-processes-cancel");
const stepCompleteRoute = await loadRoute("./steps/[stepId]/complete/route.ts?hrm-processes-step-complete");
const stepSkipRoute = await loadRoute("./steps/[stepId]/skip/route.ts?hrm-processes-step-skip");

const designerRoute = await loadRoute("../process-templates/designer/route.ts?checklist-designer");
const submitRoute = await loadRoute("./steps/[stepId]/submit/route.ts?checklist-submit");

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";
const PROCESS_ID = "00000000-0000-4000-8000-000000000022";
const STEP_ID = "00000000-0000-4000-8000-000000000023";
const FILE_ID = "00000000-0000-4000-8000-000000000024";

const OPEN_BODY = { employmentId: EMPLOYMENT_ID, kind: 'onboarding', effectiveDate: '2026-09-01' };
const ORG_ACTOR = { orgId: 'org-1', actorId: 'user-1' };
function expectCall(fn: string, args: Record<string, unknown>) {
  assert.deepEqual(routeState.calls, [{ fn, args: { ...ORG_ACTOR, ...args } }]);
}

const routePaths = new Map<RouteModule, string>([
  [collectionRoute, '/api/hrm/processes'], [completeRoute, '/api/hrm/processes/'+PROCESS_ID+'/complete'],
  [cancelRoute, '/api/hrm/processes/'+PROCESS_ID+'/cancel'], [stepCompleteRoute, '/api/hrm/processes/steps/x/complete'],
  [stepSkipRoute, '/api/hrm/processes/steps/x/skip'], [designerRoute, '/api/hrm/process-templates/designer'],
  [submitRoute, '/api/hrm/processes/steps/x/submit'],
]);
function invokePost(route: RouteModule, body: unknown, params?: Record<string, string>) {
  const url=routePaths.get(route); assert.ok(url, 'Every POST fixture names its route');
  return route.POST!(jsonRequest('http://openbooks.test'+url, body), params ? ctx(params) : undefined);
}

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.selfGate = null;
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

test.beforeEach(reset);

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(params: Record<string, string>): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve(params) };
}

test("a missing feature flag 404s before any service runs", async () => {

    routeState.featureOn = false;
    const get = await collectionRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes"));
    assert.equal(get.status, 404);
    const post = await invokePost(collectionRoute, OPEN_BODY);
    assert.equal(post.status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("an unauthenticated caller never reaches the service", async () => {

    routeState.gate = { status: 401 };
    const response = await invokePost(collectionRoute, OPEN_BODY);
    assert.equal(response.status, 401);
    assert.deepEqual(routeState.calls, []);
  });

  test("open validates the body through the real parser before the service runs", async () => {

    for (const body of [
      { kind: "onboarding", effectiveDate: "2026-09-01" },
      { employmentId: EMPLOYMENT_ID, kind: "orientation", effectiveDate: "2026-09-01" },
      { employmentId: EMPLOYMENT_ID, kind: "onboarding", effectiveDate: "September" },
    ]) {
      assert.equal(
        (await invokePost(collectionRoute, body)).status,
        400,
        `boundary accepted an invalid open body: ${JSON.stringify(body)}`,
      );
    }
    assert.deepEqual(routeState.calls, []);
  });

  test("open forwards org, actor, employment, kind, and date, then 201s", async () => {

    const response = await invokePost(collectionRoute, OPEN_BODY);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { process: { id: "process-1", status: "open" } });
    expectCall("open", {employmentId: EMPLOYMENT_ID,
          kind: "onboarding",
          effectiveDate: "2026-09-01", });
  });

  test("list rejects unknown segments and filters nothing server-side", async () => {

    const bad = await collectionRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes?segment=someday"));
    assert.equal(bad.status, 400);
    assert.deepEqual(routeState.calls, []);
    const ok = await collectionRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes?segment=overdue"));
    assert.equal(ok.status, 200);
    expectCall("list", {segment: "overdue" });
  });

  test("record fetch validates the id before the service runs", async () => {

    const bad = await recordRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes/nope"), ctx({ id: "nope" }));
    assert.equal(bad.status, 400);
    assert.deepEqual(routeState.calls, []);
    const ok = await recordRoute!.GET!(
      new Request(`http://openbooks.test/api/hrm/processes/${PROCESS_ID}`),
      ctx({ id: PROCESS_ID }),
    );
    assert.equal(ok.status, 200);
    expectCall("get", {processId: PROCESS_ID });
  });

  test("step complete forwards an optional attachment; skip requires a reason", async () => {

    const done = await invokePost(stepCompleteRoute, { attachmentId: FILE_ID }, { stepId: STEP_ID });
    assert.equal(done.status, 200);
    expectCall("completeStep", {stepId: STEP_ID, attachmentId: FILE_ID });
    const blank = await invokePost(stepSkipRoute, { reason: "  " }, { stepId: STEP_ID });
    assert.equal(blank.status, 400);
    assert.equal(routeState.calls.length, 1);
    const skipped = await invokePost(stepSkipRoute, { reason: "desk ready" }, { stepId: STEP_ID });
    assert.equal(skipped.status, 200);
    assert.deepEqual(routeState.calls[1], {
      fn: "skipStep",
      args: { orgId: "org-1", actorId: "user-1", stepId: STEP_ID, reason: "desk ready" },
    });
  });

  test("step complete admits a self-service reader through the fallback gate", async () => {

    routeState.gate = { status: 403 };
    routeState.selfGate = { user: { id: "user-1", orgId: "org-1" } };
    const admitted = await invokePost(stepCompleteRoute, {}, { stepId: STEP_ID });
    assert.equal(admitted.status, 200);
    expectCall("completeStep", {stepId: STEP_ID });
    reset();
    routeState.gate = { status: 403 };
    routeState.selfGate = { status: 403 };
    const refused = await invokePost(stepCompleteRoute, {}, { stepId: STEP_ID });
    assert.equal(refused.status, 403);
    assert.deepEqual(routeState.calls, []);
  });

  test("complete refuses hostile payloads at the real boundary before the service runs", async () => {

    for (const body of ["{not json", "null"]) {
      const refused = await invokePost(completeRoute, body, { id: PROCESS_ID });
      assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
    }
    assert.deepEqual(routeState.calls, []);
    const done = await invokePost(completeRoute, {}, { id: PROCESS_ID });
    assert.equal(done.status, 200);
    expectCall("completeProcess", {processId: PROCESS_ID });
  });

  test("cancel reaches the service with the record id and reason", async () => {

    const cancelled = await invokePost(cancelRoute, { reason: "hire withdrawn" }, { id: PROCESS_ID });
    assert.equal(cancelled.status, 200);
    expectCall("cancelProcess", {processId: PROCESS_ID, reason: "hire withdrawn" });
  });

  test("a service refusal reaches the caller with its message intact", async () => {

    const { HrmProcessError } = await import("@openbooks/engine/src/hrm/processes.ts");
    routeState.serviceThrow = new HrmProcessError(
      "DUPLICATE_OPEN",
      "an open onboarding process already exists for this employment — complete or cancel it before opening another",
    );
    const response = await invokePost(collectionRoute, OPEN_BODY);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error:
        "an open onboarding process already exists for this employment — complete or cancel it before opening another",
    });
  });

test("designer validation refuses invalid revisions, missing reasons and impossible dates before writes",async()=>{
 reset();
 for(const body of [{action:'publish',templateId:PROCESS_ID,revision:-1,reason:'Review'}, {action:'retire',templateId:PROCESS_ID,revision:1,reason:' '}, {action:'preview',employmentId:EMPLOYMENT_ID,effectiveDate:'2026-02-30',document:{name:'Welcome',kind:'onboarding',appliesTo:{employerSubsidiaryId:null,departmentId:null},steps:[]}}]) {
  const response=await invokePost(designerRoute, body);assert.equal(response.status,400)
 }
 assert.deepEqual(routeState.calls,[])
})
test("designer and approval submission honor feature and permission refusals",async()=>{
 reset();routeState.featureOn=false
 const disabled=await invokePost(designerRoute, {action:'load',templateId:PROCESS_ID});assert.equal(disabled.status,404)
 reset();routeState.gate={status:403}
 const denied=await invokePost(designerRoute, {action:'load',templateId:PROCESS_ID});assert.equal(denied.status,403)
 routeState.selfGate={status:403}
 const submitted=await invokePost(submitRoute, {}, {stepId:STEP_ID});assert.equal(submitted.status,403);assert.deepEqual(routeState.calls,[])
})
test("designer publication carries the domain refusal and its actual remedy to the operator",async()=>{
 reset();const {HrmProcessError}=await import('@openbooks/engine/src/hrm/processes.ts');routeState.serviceThrow=new HrmProcessError('REFUSED','Another editor saved this draft — reload the latest revision before applying your changes. Your edits have not been overwritten.')
 const response=await invokePost(designerRoute, {action:'publish',templateId:PROCESS_ID,revision:1,reason:'Reviewed checklist'});assert.equal(response.status,422);assert.deepEqual(await response.json(),{error:(routeState.serviceThrow as Error).message})
})
test("approval submission forwards acknowledged form evidence through the self-service boundary",async()=>{
 reset();routeState.gate={status:403};routeState.selfGate={user:{id:'self-user',orgId:'org-1'}}
 const response=await invokePost(submitRoute, {acknowledged:true,response:{asset:'Laptop'}}, {stepId:STEP_ID});assert.equal(response.status,200);assert.deepEqual(routeState.calls,[{fn:'submitChecklistStepApproval',args:{orgId:'org-1',actorId:'self-user',stepId:STEP_ID,acknowledged:true,response:{asset:'Laptop'}}}])
})
