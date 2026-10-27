import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

// Preparing a sample company takes minutes, so POST /api/data/sample-companies
// only starts it in the background worker and answers at once; GET with
// `?industry=` reports its progress, a ready company, or the recorded staged
// failure. Known refusals are answered before anything is queued.

const stateKey = Symbol.for("openbooks.sample-companies-route-test");
const READY_ORG = "8266d59c-2c23-4e6d-834e-54f463319196";
const routeState = {
  started: [] as unknown[],
  readyOrgId: null as string | null,
  denyAccess: false,
  workerOnline: true,
  queueDown: false,
  job: null as unknown,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const failuresUrl = new URL(
  "../../../../../engine/src/sample-companies/provisioning-failures.ts",
  import.meta.url,
).href;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function getAuthz() {
        return { user: { homeUserId: 'user-1', orgId: 'org-1', name: 'Sara Lindqvist' } }
      }
      export async function guardPermission() { return await getAuthz() }
      export function guardRootSubsidiaryScope() { return null }
      export function guardUnrestrictedScope() { return null }
      export function can() {
        return true
      }
    `,
  ],
  [
    "mock:industries",
    `
      export const INDUSTRY_BY_KEY = new Map([['manufacturing', { features: {} }]])
    `,
  ],
  [
    "@openbooks/engine/sample-companies",
    `
      export { SampleCompanyError } from '${failuresUrl}'
      import { SampleCompanyError } from '${failuresUrl}'
      const state = globalThis[Symbol.for('openbooks.sample-companies-route-test')]
      export async function assertSampleRequestAccess() {
        if (state.denyAccess) {
          throw new SampleCompanyError('requesting member does not have access to the source organization')
        }
      }
      export async function readySampleCompany() {
        return state.readyOrgId ? { id: state.readyOrgId, name: 'SIM Atlas' } : null
      }
      export async function sampleCompanyStatuses() {
        return [{ industryKey: 'manufacturing', profileId: 'sim-atlas', companyName: 'SIM Atlas',
          focus: [], templateReady: true, existingOrgId: state.readyOrgId }]
      }
    `,
  ],
  [
    "@openbooks/jobs",
    `
      const state = globalThis[Symbol.for('openbooks.sample-companies-route-test')]
      export async function getWorkerHeartbeat() {
        if (state.queueDown) throw new Error('connect ECONNREFUSED 127.0.0.1:6379')
        return state.workerOnline ? new Date().toISOString() : null
      }
      export async function readSampleCompanyJob() {
        if (state.queueDown) throw new Error('connect ECONNREFUSED 127.0.0.1:6379')
        return state.job
      }
      export async function startSampleCompanyJob(data) {
        state.started.push(data)
        state.job = state.job && (state.job.state === 'queued' || state.job.state === 'running')
          ? state.job
          : { state: 'queued', stage: null }
        return state.job
      }
    `,
  ],
]);

// '@/lib/api/json' is deliberately NOT mocked: a parseJsonBody stub taking only
// (request) and returning { ok: true } unconditionally would hollow every
// malformed-body case behind it, and the real boundary loads cleanly.
const mockUrls = new Map<string, string>([
  ["@openbooks/engine/sample-companies", "@openbooks/engine/sample-companies"],
  ["@openbooks/jobs", "@openbooks/jobs"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    if (specifier.endsWith("lib/authz")) return { url: "mock:authz", shortCircuit: true };
    if (specifier.endsWith("lib/industries")) return { url: "mock:industries", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?sample-companies-background-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
after(() => hooks.deregister());

function reset(): void {
  routeState.started = [];
  routeState.readyOrgId = null;
  routeState.denyAccess = false;
  routeState.workerOnline = true;
  routeState.queueDown = false;
  routeState.job = null;
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/data/sample-companies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function status(industry: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/data/sample-companies?industry=${industry}`));
}

test("a start answers at once with the queued run and queues exactly one run", async () => {
  reset();
  const response = await post({ industry: "manufacturing" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    provisioning: { state: "queued", stage: null },
  });
  assert.deepEqual(routeState.started, [
    {
      industryKey: "manufacturing",
      memberUserId: "user-1",
      sourceOrgId: "org-1",
      memberName: "Sara Lindqvist",
    },
  ]);

  routeState.job = { state: "running", stage: "clone" };
  const progress = await status("manufacturing");
  assert.equal(progress.status, 200);
  assert.deepEqual(await progress.json(), {
    industryKey: "manufacturing",
    existingOrgId: null,
    provisioning: { state: "running", stage: "clone" },
  });

  // A repeated start reports the run in progress instead of queueing another.
  const repeated = await post({ industry: "manufacturing" });
  assert.equal(repeated.status, 202);
  assert.deepEqual((await repeated.json()).provisioning, { state: "running", stage: "clone" });

  routeState.job = { state: "completed", orgId: READY_ORG };
  routeState.readyOrgId = READY_ORG;
  const ready = await status("manufacturing");
  assert.deepEqual(await ready.json(), {
    industryKey: "manufacturing",
    existingOrgId: READY_ORG,
    provisioning: null,
  });
});

test("a failed run reports its recorded staged refusal through the status read", async () => {
  reset();
  const failure = {
    error: "sample-company-clone-failed",
    stage: "clone",
    message:
      "Sample company preparation stopped: copying the template's posted history failed. Company readiness is unconfirmed.",
    requestId: "9cfa2170-6d06-4a49-8d8e-d73c33a4a9a9",
  };
  routeState.job = { state: "failed", failure };
  const response = await status("manufacturing");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).provisioning, { state: "failed", failure });

  const list = await GET(new Request("http://openbooks.test/api/data/sample-companies"));
  const profiles = (await list.json()).profiles as Array<Record<string, unknown>>;
  assert.deepEqual(profiles[0]!.provisioning, { state: "failed", failure });
});

test("a ready company is returned without queueing another run", async () => {
  reset();
  routeState.readyOrgId = READY_ORG;
  const response = await post({ industry: "manufacturing" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, orgId: READY_ORG, created: false });
  assert.equal(routeState.started.length, 0);
});

test("refusals are answered before anything is queued", async () => {
  reset();
  routeState.denyAccess = true;
  const denied = await post({ industry: "manufacturing" });
  assert.equal(denied.status, 409);
  assert.match((await denied.json()).error, /does not have access/);

  reset();
  routeState.workerOnline = false;
  const offline = await post({ industry: "manufacturing" });
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).error, "sample-company-worker-unavailable");

  reset();
  routeState.queueDown = true;
  const queueDown = await post({ industry: "manufacturing" });
  assert.equal(queueDown.status, 503);
  const body = await queueDown.json();
  assert.equal(body.error, "sample-company-queue-unavailable");
  assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|6379/);

  assert.equal(routeState.started.length, 0);
});

test("an unreadable queue leaves the company facts readable with an unknown run", async () => {
  reset();
  routeState.queueDown = true;
  const response = await status("manufacturing");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    industryKey: "manufacturing",
    existingOrgId: null,
    provisioning: null,
  });
});

test("an unknown industry stays a 422 refusal", async () => {
  reset();
  const response = await post({ industry: "no_such_industry" });
  assert.equal(response.status, 422);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, "unknown-industry");
  assert.equal((await status("no_such_industry")).status, 422);
});
