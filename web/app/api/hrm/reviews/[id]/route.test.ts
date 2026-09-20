import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  authz: { user: { id: string; orgId: string } } | null;
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-review-item-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  authz: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  calls: [],
  serviceThrow: null,
  mapped: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-item-route-test')]
      export async function getAuthz() {
        return state.authz
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-item-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-item-route-test')]
      export async function submitReview(args) {
        state.calls.push({ fn: 'submit', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.reviewId, status: 'submitted' }
      }
      export async function calibrateReview(args) {
        state.calls.push({ fn: 'calibrate', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.reviewId, status: 'calibrated' }
      }
      export async function shareReview(args) {
        state.calls.push({ fn: 'share', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.reviewId, status: 'shared' }
      }
      export async function acknowledgeReview(args) {
        state.calls.push({ fn: 'acknowledge', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.reviewId, status: 'acknowledged' }
      }
      export async function reopenReview(args) {
        state.calls.push({ fn: 'reopen', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.reviewId, status: 'pending' }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-item-route-test')]
      export async function getReviewDetail(args) {
        state.calls.push({ fn: 'detail', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { review: { id: args.reviewId }, answers: [] }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-item-route-test')]
      const NextResponse = globalThis.openbooksHrmReviewItemRouteNextResponse
      export function performanceErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmReviewItemRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/performance/reviews.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/performance/performance-read.ts", "mock:read"],
  ["../../review-cycles/_lib", "mock:lib"],
]);

let itemRoute: typeof import("./route.ts") | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
      }
      const mocked = mockUrls.get(specifier);
      if (mocked) return { url: mocked, shortCircuit: true };
      return nextResolve(specifier);
    },
    load(url, _context, nextLoad) {
      const source = mockSources.get(url);
      if (source !== undefined) return { format: "module", source, shortCircuit: true };
      return nextLoad(url);
    },
  });
  const routeUrl = "./route.ts?hrm-review-item";
  itemRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const REVIEW_ID = "00000000-0000-4000-8000-000000000051";
const ANSWER_ID = "00000000-0000-4000-8000-000000000052";
const params = { params: Promise.resolve({ id: REVIEW_ID }) };

function reset(): void {
  routeState.authz = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function patchRequest(body: unknown): Request {
  return new Request(`http://openbooks.test/api/hrm/reviews/${REVIEW_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("review item route carries identity without a permission shortcut", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /getAuthz\(\)/);
    assert.doesNotMatch(source, /guardPermission/);
  });
} else {
  test("an unknown id never reaches the service", async () => {
    reset();
    const bad = { params: Promise.resolve({ id: "nope" }) };
    assert.equal((await itemRoute!.GET(new Request("http://openbooks.test/x"), bad)).status, 400);
    assert.equal((await itemRoute!.PATCH(patchRequest({ action: "share" }), bad)).status, 400);
    assert.deepEqual(routeState.calls, []);
  });

  test("detail resolves through the privacy scope", async () => {
    reset();
    const response = await itemRoute!.GET(new Request("http://openbooks.test/x"), params);
    assert.equal(response.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "detail", args: { orgId: "org-1", actorId: "user-1", reviewId: REVIEW_ID } },
    ]);
  });

  test("submit forwards answers and the overall rating", async () => {
    reset();
    const response = await itemRoute!.PATCH(
      patchRequest({ action: "submit", answers: [{ answerId: ANSWER_ID, rating: "4", text: "strong" }], overallRating: "4" }),
      params,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(routeState.calls, [
      {
        fn: "submit",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          reviewId: REVIEW_ID,
          answers: [{ answerId: ANSWER_ID, rating: "4", text: "strong" }],
          overallRating: "4",
        },
      },
    ]);
  });

  test("calibrate and reopen require their reason at the real boundary", async () => {
    reset();
    assert.equal(
      (await itemRoute!.PATCH(patchRequest({ action: "calibrate", calibratedRating: "4" }), params)).status,
      400,
    );
    assert.equal(
      (await itemRoute!.PATCH(patchRequest({ action: "calibrate", calibratedRating: "4", reason: "  " }), params)).status,
      400,
    );
    assert.equal(
      (await itemRoute!.PATCH(patchRequest({ action: "reopen" }), params)).status,
      400,
    );
    assert.equal((await itemRoute!.PATCH(patchRequest({ action: "share" }), params)).status, 200);
    assert.equal((await itemRoute!.PATCH(patchRequest({ action: "acknowledge" }), params)).status, 200);
    assert.deepEqual(routeState.calls.map((c) => c.fn), ["share", "acknowledge"]);
  });

  test("action routes refuse hostile payloads at the real boundary", async () => {
    reset();
    for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
      const refused = await itemRoute!.PATCH(
        new Request(`http://openbooks.test/api/hrm/reviews/${REVIEW_ID}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body,
        }),
        params,
      );
      assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
    }
    assert.deepEqual(routeState.calls, []);
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("outside the template scale 1 to 5");
    routeState.serviceThrow = refusal;
    const response = await itemRoute!.PATCH(
      patchRequest({ action: "submit", answers: [{ answerId: ANSWER_ID, rating: "9" }] }),
      params,
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
