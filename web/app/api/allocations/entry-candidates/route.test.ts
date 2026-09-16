import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

// Boundary contract for GET /api/allocations/entry-candidates (shard A9):
// feature + permission gates, query validation, subsidiary scope, and the
// candidate DTO shaped from A4's matcher. Real matching semantics live in
// engine/src/allocations/match.test.ts; here the engine module is a test
// double driven by markers on canned versions so this file pins only the
// route's own layer.

const stateKey = Symbol.for("openbooks.entry-candidates-route-test");

const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000a002";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000a003";
const SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000a004";
const OTHER_SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000a005";

interface CannedVersion {
  __match?: boolean;
  __specificity?: number;
  applyPolicy: string;
  documentKinds?: string[] | null;
}

interface CannedRule {
  key: string;
  name: string;
  sortOrder: number;
  version: CannedVersion & { id: string };
}

interface RouteState {
  features: Record<string, boolean>;
  allowedSubsidiaryIds: string[] | null;
  authed: boolean;
  rules: CannedRule[];
  selectCalls: { keys: string[]; line: Record<string, unknown> }[];
  matchCalls: number;
}

const state: RouteState = {
  features: {},
  allowedSubsidiaryIds: null,
  authed: true,
  rules: [],
  selectCalls: [],
  matchCalls: 0,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;
// Synthetic mock: URLs have no filesystem parent, so a mock cannot import
// next/server itself. The 401 shape is built here (real module graph) and
// the mock returns a clone.
const deniedKey = Symbol.for("openbooks.entry-candidates-route-denied");
(globalThis as typeof globalThis & Record<symbol, unknown>)[deniedKey] = () =>
  NextResponse.json({ error: "unauthorized" }, { status: 401 });

function cannedRule(
  key: string,
  overrides: Partial<CannedRule> & { policy?: string; match?: boolean; specificity?: number } = {},
): CannedRule {
  return {
    key,
    name: overrides.name ?? `Rule ${key}`,
    sortOrder: overrides.sortOrder ?? 100,
    version: {
      id: `00000000-0000-4000-8000-00000000b${key.slice(-3)}`,
      applyPolicy: overrides.policy ?? "manual",
      __match: overrides.match ?? true,
      __specificity: overrides.specificity ?? 0,
    },
  };
}

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `export async function guardPermission() {
       const state = globalThis[Symbol.for('openbooks.entry-candidates-route-test')]
       if (!state.authed) {
         return globalThis[Symbol.for('openbooks.entry-candidates-route-denied')]()
       }
       return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         allowedSubsidiaryIds: state.allowedSubsidiaryIds === null ? null : new Set(state.allowedSubsidiaryIds),
       }
     }`,
  ],
  [
    "mock:features",
    `export async function isFeatureEnabled(orgId, key) {
       const state = globalThis[Symbol.for('openbooks.entry-candidates-route-test')]
       if (orgId !== '${ORG_ID}') return false
       return state.features[key] === true
     }`,
  ],
  [
    "mock:match",
    `export async function listEntryRulesInEffect(request) {
       const state = globalThis[Symbol.for('openbooks.entry-candidates-route-test')]
       state.lastListRequest = { ...request }
       return state.rules.map((canned) => ({
         rule: {
           id: '00000000-0000-4000-8000-00000000c' + canned.key.slice(-3),
           orgId: '${ORG_ID}',
           key: canned.key,
           name: canned.name,
           mode: 'entry',
           sortOrder: canned.sortOrder,
           isActive: true,
           isSystem: false,
           currentVersionId: canned.version.id,
         },
         version: {
           id: canned.version.id,
           orgId: '${ORG_ID}',
           ruleId: 'rule-' + canned.key,
           versionNo: 1,
           status: 'published',
           effectiveFrom: '2025-01-01',
           effectiveTo: null,
           bookScope: 'primary',
           bookIds: [],
           documentKinds: null,
           accountScope: { kind: 'any' },
           dimensionFilters: {},
           applyPolicy: canned.version.applyPolicy,
           sourceMeasure: 'period_activity',
           basisKind: 'fixed_percent',
           driverId: null,
           driverAsOf: 'period',
           basisConfig: {},
           targetKind: 'explicit',
           dynamicTarget: {},
           impact: 'reclass',
           offsetAccountId: null,
           residualPolicy: 'largest_share',
           residualTargetId: null,
           solveMethod: 'sequential',
           runPolicy: 'manual',
           runOffsetDays: 0,
           approvalFlowId: null,
           memoTemplate: null,
           lineDescriptionTemplate: null,
           definitionHash: 'hash-' + canned.key,
           __match: canned.version.__match,
           __specificity: canned.version.__specificity,
         },
         targets: [],
       }))
     }
     export function matchLine(version, line) {
       const state = globalThis[Symbol.for('openbooks.entry-candidates-route-test')]
       state.matchCalls += 1
       state.lastLine = { ...line }
       return { matched: version.__match !== false, specificity: version.__specificity ?? 0 }
     }
     export function selectRule(candidates, line) {
       const state = globalThis[Symbol.for('openbooks.entry-candidates-route-test')]
       state.selectCalls.push({ keys: candidates.map((c) => c.rule.key), line: { ...line } })
       return candidates[0] ?? null
     }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/allocations/match.ts", "mock:match"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?entry-candidates-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.features = { allocations: true, allocationsAtEntry: true };
  state.allowedSubsidiaryIds = null;
  state.authed = true;
  state.rules = [];
  state.selectCalls = [];
  state.matchCalls = 0;
}

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/allocations/entry-candidates${query}`));
}

test("the server refuses when the entry gate is off, regardless of UI", async () => {
  reset();
  state.features = { allocations: true, allocationsAtEntry: false };
  state.rules = [cannedRule("overhead")];
  const res = await get(`?documentKind=bill&accountId=${ACCOUNT_ID}`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("the server refuses unauthenticated callers", async () => {
  reset();
  state.authed = false;
  const res = await get("?documentKind=bill");
  assert.equal(res.status, 401);
});

test("malformed query params fail closed with a named error", async () => {
  reset();
  const badDate = await get("?documentKind=bill&documentDate=next-friday");
  assert.equal(badDate.status, 400);
  assert.deepEqual(await badDate.json(), { error: "invalid_documentDate" });

  const badAccount = await get("?documentKind=bill&accountId=not-a-uuid");
  assert.equal(badAccount.status, 400);
  assert.deepEqual(await badAccount.json(), { error: "invalid_accountId" });

  const badPolicy = await get("?documentKind=bill&policy=always");
  assert.equal(badPolicy.status, 400);
  assert.deepEqual(await badPolicy.json(), { error: "invalid_policy" });
});

test("a subsidiary outside the caller's scope is unreachable, not empty", async () => {
  reset();
  state.allowedSubsidiaryIds = [SUBSIDIARY_ID];
  state.rules = [cannedRule("overhead")];
  const res = await get(`?documentKind=bill&subsidiaryId=${OTHER_SUBSIDIARY_ID}`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("line context returns matched candidates most-specific-first with a recommendation", async () => {
  reset();
  state.rules = [
    cannedRule("general", { policy: "manual", specificity: 0, sortOrder: 100 }),
    cannedRule("overhead", { policy: "suggest", specificity: 2, sortOrder: 200 }),
    cannedRule("skipped", { policy: "manual", match: false, specificity: 9 }),
  ];
  const res = await get(`?documentKind=bill&accountId=${ACCOUNT_ID}&documentDate=2026-09-01`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    rules: {
      ruleId: string
      ruleKey: string
      ruleName: string
      applyPolicy: string
      versionId: string
      recommended: boolean
    }[];
  };
  assert.deepEqual(
    body.rules.map((r) => r.ruleKey),
    ["overhead", "general"],
  );
  assert.equal(body.rules[0]!.applyPolicy, "suggest");
  assert.ok(body.rules[0]!.ruleId.length > 0);
  assert.equal(body.rules[0]!.recommended, true);
  assert.equal(body.rules[1]!.recommended, false);
  assert.ok(body.rules[0]!.versionId.length > 0);
  // The matcher saw the line coordinate the drawer described.
  const seen = (state as RouteState & { lastLine?: Record<string, unknown> }).lastLine;
  assert.equal(seen?.["accountId"], ACCOUNT_ID);
  assert.equal(seen?.["documentKind"], "bill");
});

test("the policy filter narrows a line context to automatic rules for apply-all", async () => {
  reset();
  state.rules = [
    cannedRule("auto-rule", { policy: "automatic", specificity: 1 }),
    cannedRule("manual-rule", { policy: "manual", specificity: 5 }),
  ];
  const res = await get(`?documentKind=bill&accountId=${ACCOUNT_ID}&policy=automatic`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rules: { ruleKey: string }[] };
  assert.deepEqual(
    body.rules.map((r) => r.ruleKey),
    ["auto-rule"],
  );
});

test("header context without a line returns every rule in effect", async () => {
  reset();
  state.rules = [cannedRule("auto-rule", { policy: "automatic" }), cannedRule("manual-rule", { policy: "manual" })];
  const res = await get("?documentKind=bill&documentDate=2026-09-01");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rules: { ruleKey: string }[] };
  assert.deepEqual(
    body.rules.map((r) => r.ruleKey),
    ["auto-rule", "manual-rule"],
  );
  assert.equal(state.matchCalls, 0);
});
