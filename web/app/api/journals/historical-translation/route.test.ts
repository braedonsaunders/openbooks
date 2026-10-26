import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";
import { FinancialChangeConflictError } from "@openbooks/engine/platform/financial-changes";

const state = {
  NextResponse,
  user: { id: randomUUID(), orgId: randomUUID() },
  calls: [] as Array<{ command: string; input: Record<string, unknown> }>,
  deniedStatus: null as number | null,
  refusal: null as Error | null,
  changeId: randomUUID(),
  basisId: randomUUID(),
};
(
  globalThis as typeof globalThis & { historicalTranslationRouteTest?: typeof state }
).historicalTranslationRouteTest = state;

const mocks: Record<string, string> = {
  "@/lib/feature-gates": `
    export async function guardFeaturePermission(permission,feature) {
      const state=globalThis.historicalTranslationRouteTest;
      if(permission!=='close.run'||feature!=='multiCurrency') throw new Error('unexpected gate');
      if(state.deniedStatus) return state.NextResponse.json({error:'denied'},{status:state.deniedStatus});
      return {user:state.user,allowedSubsidiaryIds:null};
    }`,
  "@/lib/analytics/preview-invalidation": `export async function invalidateAnalyticsPreviews(){}`,
  "@openbooks/engine/journal/historical-translation-evidence": `
    async function command(name,input){const state=globalThis.historicalTranslationRouteTest;
      state.calls.push({command:name,input});if(state.refusal)throw state.refusal;
      if(name==='read')return {source:{lineId:input.sourceLineId},currencies:['CAD','USD'],certificates:[],proposals:[],originalLayers:[]};
      return name==='propose'?{changeId:state.changeId}:{basisId:state.basisId};}
    export async function readHistoricalTranslationAuthoringContext(input){return command('read',input)}
    export async function proposeHistoricalTranslationContribution(input){return command('propose',input)}
    export async function applyHistoricalTranslationContribution(input){return command('apply',input)}
  `,
};
registerHooks({
  resolve(specifier, context, next) {
    if (mocks[specifier]) return { shortCircuit: true, url: `historical-route-mock:${specifier}` };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("historical-route-mock:"))
      return {
        shortCircuit: true,
        format: "module",
        source: mocks[url.slice("historical-route-mock:".length)]!,
      };
    return next(url, context);
  },
});
const routePath: string = "./route.ts?historical-route-test";
const applyPath: string = "./[changeId]/apply/route.ts?historical-route-test";
const { GET, POST } = (await import(routePath)) as typeof import("./route.ts");
const { POST: APPLY } = (await import(applyPath)) as typeof import("./[changeId]/apply/route.ts");

function proposal() {
  return {
    instruction: {
      sourceLineId: randomUUID(),
      measurementCurrency: "USD",
      presentationCurrency: "CAD",
      kind: "contribution",
      layers: [
        {
          amount: "-100.0000",
          rate: "1.125",
          historicalDate: "2024-02-29",
          provenance: "Original equity contribution statement",
          source: { fileId: randomUUID(), versionId: randomUUID(), contentHash: "a".repeat(64) },
          originalLayerId: null,
        },
      ],
    },
    reason: "Document original historical contribution",
    idempotencyKey: randomUUID(),
  };
}
const postRequest = (body: unknown) =>
  new Request("http://openbooks.test/api/journals/historical-translation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("historical authoring routes enforce native permission and feature before reading source evidence", async () => {
  for (const deniedStatus of [403, 404]) {
    state.calls = [];
    state.deniedStatus = deniedStatus;
    const response = await GET(
      new Request(
        `http://openbooks.test/api/journals/historical-translation?sourceLineId=${randomUUID()}`,
      ),
    );
    assert.equal(response.status, deniedStatus);
    assert.deepEqual(state.calls, []);
  }
  state.deniedStatus = null;
});

test("historical source read refuses display line numbers and supplies signed-in native authority", async () => {
  state.calls = [];
  assert.equal(
    (
      await GET(
        new Request("http://openbooks.test/api/journals/historical-translation?sourceLineId=1"),
      )
    ).status,
    404,
  );
  assert.deepEqual(state.calls, []);
  const sourceLineId = randomUUID();
  const response = await GET(
    new Request(
      `http://openbooks.test/api/journals/historical-translation?sourceLineId=${sourceLineId}`,
    ),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls, [
    { command: "read", input: { orgId: state.user.orgId, actorId: state.user.id, sourceLineId } },
  ]);
});

test("historical proposal records the exact instruction without approving or applying it", async () => {
  state.calls = [];
  const body = proposal();
  const response = await POST(postRequest(body));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { changeId: state.changeId });
  assert.deepEqual(state.calls, [
    { command: "propose", input: { orgId: state.user.orgId, actorId: state.user.id, ...body } },
  ]);
  state.calls = [];
  assert.equal((await POST(postRequest({ ...body, actorId: randomUUID() }))).status, 422);
  assert.deepEqual(state.calls, []);
});

test("explicit historical apply preserves a native lifecycle refusal and later resolves its retained basis", async () => {
  state.calls = [];
  // The engine's own lifecycle refusal: the boundary maps typed refusals only,
  // so a plain Error dressed with a status would rightly surface as a 500.
  state.refusal = new FinancialChangeConflictError(
    "Obtain the Accounting event decision before applying.",
  );
  const context = { params: Promise.resolve({ changeId: state.changeId }) };
  const response = await APPLY(
    new Request("http://openbooks.test/apply", { method: "POST" }),
    context,
  );
  assert.equal(response.status, 409);
  assert.match(JSON.stringify(await response.json()), /Obtain the Accounting event decision/);
  state.refusal = null;
  const applied = await APPLY(
    new Request("http://openbooks.test/apply", { method: "POST" }),
    context,
  );
  assert.equal(applied.status, 200);
  assert.deepEqual(await applied.json(), { basisId: state.basisId });
  assert.equal(state.calls.length, 2);
  assert.ok(
    state.calls.every(
      (call) =>
        call.command === "apply" &&
        call.input.changeId === state.changeId &&
        call.input.actorId === state.user.id,
    ),
  );
});
