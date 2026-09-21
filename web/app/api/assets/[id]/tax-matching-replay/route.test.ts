import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const assetId = "00000000-0000-4000-8000-000000000001";
const changeId = "00000000-0000-4000-8000-000000000002";
const periodId = "00000000-0000-4000-8000-000000000003";
const otherId = "00000000-0000-4000-8000-000000000004";
const state = {
  allowed: true, assetId, refusal: "", calls: [] as unknown[][],
  citations: [periodId],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("tax-matching-replay-route")] = state;
// These two are synthetic module identities, not files on disk: the load hook
// below returns their source inline, so nothing ever reads them from the
// filesystem.
const authUrl = new URL("./replay-auth.fixture.mjs", import.meta.url).href; // source-path: synthetic
const commandUrl = new URL("./replay-command.fixture.mjs", import.meta.url).href; // source-path: synthetic
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates") return { shortCircuit: true, url: authUrl };
    if (specifier === "@openbooks/engine/src/tax-returns/consolidated-matching-replay.ts")
      return { shortCircuit: true, url: commandUrl };
    if (specifier === "@/lib/api/json")
      return next(new URL("../../../../../lib/api/json.ts", import.meta.url).href, context);
    if (specifier === "@/lib/list-params")
      return next(new URL("../../../../../lib/list-params.ts", import.meta.url).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === authUrl) return {
      shortCircuit: true, format: "module",
      source: `import {NextResponse} from 'next/server';
      export async function guardFeaturePermission(...args){
        const s=globalThis[Symbol.for('tax-matching-replay-route')];s.calls.push(['gate',...args]);
        return s.allowed?{user:{id:'actor',orgId:'org'}}:NextResponse.json({error:'missing permission'},{status:403});
      }`,
    };
    if (url === commandUrl) return {
      shortCircuit: true, format: "module",
      source: `export class TaxMatchingReplayError extends Error { name='TaxMatchingReplayError' }
      export async function previewTaxMatchingReplay(...args){
        const s=globalThis[Symbol.for('tax-matching-replay-route')];s.calls.push(['preview',...args]);
        if(s.refusal)throw new TaxMatchingReplayError(s.refusal);
        return {assetId:s.assetId,replacementWorkpaperChangeId:args[2],citedHistoricalPeriodIds:s.citations,
          replacementOpening:'50.0001',historical:[]};
      }
      export async function proposeTaxMatchingReplay(...args){
        const s=globalThis[Symbol.for('tax-matching-replay-route')];s.calls.push(['propose',...args]);
        if(s.refusal)throw new TaxMatchingReplayError(s.refusal);return 'replay-change';
      }`,
    };
    return next(url, context);
  },
});
const route = await import("./route.ts");
hooks.deregister();
const context = { params: Promise.resolve({ id: assetId }) };
const get = (query = `replacementWorkpaperChangeId=${changeId}`) => new Request(`http://openbooks.test/api/assets/${assetId}/tax-matching-replay?${query}`);
const post = (body: unknown) => new Request(`http://openbooks.test/api/assets/${assetId}/tax-matching-replay`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const valid = { replacementWorkpaperChangeId: changeId, citedHistoricalPeriodIds: [periodId],
  reason: "Correct the approved intercompany gain", idempotencyKey: "replay-request" };
beforeEach(() => {
  state.allowed = true; state.assetId = assetId; state.refusal = ""; state.calls = []; state.citations = [periodId];
});

test("preview stamps period identities using authenticated access and the actual asset subject", async () => {
  const response = await route.GET(get(), context);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(value.citedHistoricalPeriodIds, [periodId]);
  assert.equal(value.replacementOpening, "50.0001");
  assert.deepEqual(state.calls, [["gate", "assets.manage", "fixedAssets"], ["preview", "org", "actor", changeId]]);
});

test("proposal forwards the submitted citations unchanged so the domain can reject a stale set", async () => {
  state.citations = [otherId];
  const response = await route.POST(post(valid), context);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { changeId: "replay-change" });
  assert.deepEqual(state.calls.at(-1), ["propose", "org", "actor", valid],
    "the boundary must not silently substitute the current preview for the citations the operator reviewed");
});

test("another asset's replacement cannot be viewed or proposed through this URL", async () => {
  state.assetId = otherId;
  assert.equal((await route.GET(get(), context)).status, 404);
  assert.equal((await route.POST(post(valid), context)).status, 404);
  assert.ok(state.calls.every(([command]) => command !== "propose"));
});

test("strict request validation rejects financial overrides, empty or duplicate citations and invalid reasons", async () => {
  for (const [label, body] of Object.entries({
    money: { ...valid, replacementOpening: "0.00" },
    period: { ...valid, citedHistoricalPeriodIds: ["typed-period"] },
    empty: { ...valid, citedHistoricalPeriodIds: [] },
    duplicate: { ...valid, citedHistoricalPeriodIds: [periodId, periodId] },
    shortReason: { ...valid, reason: "short" },
    longReason: { ...valid, reason: "x".repeat(1001) },
    emptyKey: { ...valid, idempotencyKey: " " },
  })) {
    state.calls = [];
    assert.equal((await route.POST(post(body), context)).status, 422, label);
    assert.deepEqual(state.calls, [["gate", "assets.manage", "fixedAssets"]], label);
  }
});

test("a missing, duplicated or operator-extended preview query never reaches the tax service", async () => {
  for (const query of ["", "replacementWorkpaperChangeId=bad",
    `replacementWorkpaperChangeId=${changeId}&replacementWorkpaperChangeId=${otherId}`,
    `replacementWorkpaperChangeId=${changeId}&citedHistoricalPeriodIds=${periodId}`]) {
    state.calls = [];
    assert.equal((await route.GET(get(query), context)).status, 422, query);
    assert.deepEqual(state.calls, [["gate", "assets.manage", "fixedAssets"]], query);
  }
});

test("empty-history remedy survives as 422 and permission denial calls no tax service", async () => {
  state.refusal = "no earlier matching year requires replay; re-run the latest computed year from Fixed Assets tax pools";
  const response = await route.GET(get(), context);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, state.refusal);
  const proposalResponse = await route.POST(post(valid), context);
  assert.equal(proposalResponse.status, 422);
  assert.equal((await proposalResponse.json()).error, state.refusal);
  state.allowed = false; state.calls = [];
  assert.equal((await route.GET(get(), context)).status, 403);
  assert.equal((await route.POST(post(valid), context)).status, 403);
  assert.ok(state.calls.every(([command]) => command === "gate"));
});
