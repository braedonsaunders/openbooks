import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  perms: string[];
}

const stateKey = Symbol.for("openbooks.hrm-me-work-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  calls: [],
  serviceThrow: null,
  perms: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-work-route-test')]
      export async function guardPermission(permission) {
        state.perms.push(permission)
        if (permission !== 'hrm.self.read' && permission !== 'hrm.self.request') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmMeWorkRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-work-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:my-work",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-work-route-test')]
      async function run(fn, args) {
        state.calls.push({ fn, args })
        if (state.serviceThrow) throw state.serviceThrow
        return { fn, ok: true, id: 'row-1', status: 'active' }
      }
      export async function getMyReviewWorkspace(args) { return run('reviews', args) }
      export async function submitMySelfAssessment(args) { return run('submit', args) }
      export async function acknowledgeMyReview(args) { return run('acknowledge', args) }
      export async function updateMyGoalProgress(args) { return run('progress', args) }
      export async function getMyBenefitsWorkspace(args) { return run('benefits', args) }
      export async function electMyBenefit(args) { return run('elect', args) }
      export async function changeMyBenefit(args) { return run('change', args) }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmMeWorkRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/self-service/my-work.ts", "mock:my-work"],
]);

let reviewsRoute: typeof import("./reviews/route.ts") | undefined;
let acknowledgeRoute: typeof import("./reviews/acknowledge/route.ts") | undefined;
let submitRoute: typeof import("./reviews/submit/route.ts") | undefined;
let progressRoute: typeof import("./goals/progress/route.ts") | undefined;
let benefitsRoute: typeof import("./benefits/route.ts") | undefined;
let electRoute: typeof import("./benefits/elect/route.ts") | undefined;
let changeRoute: typeof import("./benefits/change/route.ts") | undefined;

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
  const reviewsRouteUrl = "./reviews/route.ts?hrm-me-work-reviews";
  reviewsRoute = (await import(reviewsRouteUrl)) as typeof import("./reviews/route.ts");
  const acknowledgeRouteUrl = "./reviews/acknowledge/route.ts?hrm-me-work-ack";
  acknowledgeRoute = (await import(acknowledgeRouteUrl)) as typeof import("./reviews/acknowledge/route.ts");
  const submitRouteUrl = "./reviews/submit/route.ts?hrm-me-work-submit";
  submitRoute = (await import(submitRouteUrl)) as typeof import("./reviews/submit/route.ts");
  const progressRouteUrl = "./goals/progress/route.ts?hrm-me-work-progress";
  progressRoute = (await import(progressRouteUrl)) as typeof import("./goals/progress/route.ts");
  const benefitsRouteUrl = "./benefits/route.ts?hrm-me-work-benefits";
  benefitsRoute = (await import(benefitsRouteUrl)) as typeof import("./benefits/route.ts");
  const electRouteUrl = "./benefits/elect/route.ts?hrm-me-work-elect";
  electRoute = (await import(electRouteUrl)) as typeof import("./benefits/elect/route.ts");
  const changeRouteUrl = "./benefits/change/route.ts?hrm-me-work-change";
  changeRoute = (await import(changeRouteUrl)) as typeof import("./benefits/change/route.ts");
  hooks.deregister();
}

const REVIEW_ID = "00000000-0000-4000-8000-000000000031";
const GOAL_ID = "00000000-0000-4000-8000-000000000032";
const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000033";
const PLAN_ID = "00000000-0000-4000-8000-000000000034";
const WINDOW_ID = "00000000-0000-4000-8000-000000000035";
const ENROLLMENT_ID = "00000000-0000-4000-8000-000000000036";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.perms = [];
}

function post(body: unknown): Request {
  return new Request("http://openbooks.test/api/hrm/me/work", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("me work routes gate on the hrm feature and the self permissions", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["./reviews/route.ts", "./benefits/route.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(source, /guardPermission\("hrm\.self\.read"\)/);
      assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrm"\)/);
    }
    for (const file of [
      "./reviews/acknowledge/route.ts",
      "./reviews/submit/route.ts",
      "./goals/progress/route.ts",
      "./benefits/elect/route.ts",
      "./benefits/change/route.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(source, /guardPermission\("hrm\.self\.request"\)/);
      assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrm"\)/);
    }
  });
} else {
  test("a missing feature flag 404s before any service runs", async () => {
    reset();
    routeState.featureOn = false;
    assert.equal((await reviewsRoute!.GET()).status, 404);
    assert.equal((await benefitsRoute!.GET()).status, 404);
    assert.equal((await acknowledgeRoute!.POST(post({ reviewId: REVIEW_ID }))).status, 404);
    assert.equal((await submitRoute!.POST(post({ reviewId: REVIEW_ID, answers: [] }))).status, 404);
    assert.equal((await progressRoute!.POST(post({ goalId: GOAL_ID, progressPercent: 10 }))).status, 404);
    assert.equal((await electRoute!.POST(post({ employmentId: EMPLOYMENT_ID, planId: PLAN_ID, effectiveFrom: "2026-03-01" }))).status, 404);
    assert.equal((await changeRoute!.POST(post({ enrollmentId: ENROLLMENT_ID, changeDate: "2026-04-01", reason: "x" }))).status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("an unauthenticated caller never reaches a service", async () => {
    reset();
    routeState.gate = { status: 401 };
    assert.equal((await reviewsRoute!.GET()).status, 401);
    assert.equal((await benefitsRoute!.GET()).status, 401);
    assert.equal((await acknowledgeRoute!.POST(post({ reviewId: REVIEW_ID }))).status, 401);
    assert.equal((await changeRoute!.POST(post({ enrollmentId: ENROLLMENT_ID, changeDate: "2026-04-01", reason: "x" }))).status, 401);
    assert.deepEqual(routeState.calls, []);
  });

  test("reads forward org and actor and return the service payload", async () => {
    reset();
    const reviews = await reviewsRoute!.GET();
    assert.equal(reviews.status, 200);
    assert.deepEqual((await reviews.json()).workspace, { fn: "reviews", ok: true, id: "row-1", status: "active" });
    const benefits = await benefitsRoute!.GET();
    assert.equal(benefits.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "reviews", args: { orgId: "org-1", actorId: "user-1" } },
      { fn: "benefits", args: { orgId: "org-1", actorId: "user-1" } },
    ]);
    assert.deepEqual(routeState.perms, ["hrm.self.read", "hrm.self.read"]);
  });

  test("writes validate the body before the service runs", async () => {
    reset();
    assert.equal((await acknowledgeRoute!.POST(post({}))).status, 400);
    assert.equal((await acknowledgeRoute!.POST(post({ reviewId: "nope" }))).status, 400);
    assert.equal((await submitRoute!.POST(post({ reviewId: REVIEW_ID, answers: [{ answerId: "nope" }] }))).status, 400);
    assert.equal((await progressRoute!.POST(post({ goalId: GOAL_ID }))).status, 400);
    assert.equal((await electRoute!.POST(post({ employmentId: EMPLOYMENT_ID, planId: PLAN_ID, effectiveFrom: "March" }))).status, 400);
    assert.equal((await changeRoute!.POST(post({ enrollmentId: ENROLLMENT_ID, changeDate: "2026-04-01", reason: "  " }))).status, 400);
    assert.deepEqual(routeState.calls, []);
    const good = await electRoute!.POST(
      post({ employmentId: EMPLOYMENT_ID, planId: PLAN_ID, windowId: WINDOW_ID, effectiveFrom: "2026-03-01" }),
    );
    assert.equal(good.status, 201);
    assert.deepEqual(routeState.calls, [
      {
        fn: "elect",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          employmentId: EMPLOYMENT_ID,
          planId: PLAN_ID,
          windowId: WINDOW_ID,
          coverageLevelKey: undefined,
          effectiveFrom: "2026-03-01",
          effectiveTo: undefined,
          lifeEventReason: undefined,
        },
      },
    ]);
    assert.ok(routeState.perms.length > 0 && routeState.perms.every((perm) => perm === "hrm.self.request"));
  });

  test("an unlinked login is refused as a 403 with the remedy intact", async () => {
    reset();
    const { SelfServiceError } = await import(
      "@openbooks/engine/src/hrm/self-service/actor.ts"
    );
    routeState.serviceThrow = new SelfServiceError(
      "NO_LINK",
      "no person is linked to this login — ask an administrator to link your person in Admin → Users → Link person before using self-service",
    );
    const reviews = await reviewsRoute!.GET();
    assert.equal(reviews.status, 403);
    assert.match((await reviews.json()).error as string, /Admin → Users → Link person/);
    const elect = await electRoute!.POST(post({ employmentId: EMPLOYMENT_ID, planId: PLAN_ID, effectiveFrom: "2026-03-01" }));
    assert.equal(elect.status, 403);
  });

  test("another person's review id is refused by identity, never acted on", async () => {
    reset();
    const { HrmPerformanceError } = await import(
      "@openbooks/engine/src/hrm/performance/errors.ts"
    );
    routeState.serviceThrow = new HrmPerformanceError(
      "FORBIDDEN",
      "review belongs to another reviewer — only its reviewer submits it",
    );
    const response = await submitRoute!.POST(post({ reviewId: REVIEW_ID, answers: [] }));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error as string, /only its reviewer submits it/);
    routeState.serviceThrow = new HrmPerformanceError("NOT_FOUND", "review is not visible in this organization");
    assert.equal((await acknowledgeRoute!.POST(post({ reviewId: REVIEW_ID }))).status, 404);
    routeState.serviceThrow = new HrmPerformanceError("BAD_STATE", "review is submitted — only a shared review acknowledges");
    assert.equal((await acknowledgeRoute!.POST(post({ reviewId: REVIEW_ID }))).status, 409);
  });

  test("a closed window refuses elect as a 400 with the remedy intact", async () => {
    reset();
    const { BenefitsError } = await import("@openbooks/engine/src/hrm/benefits/errors.ts");
    routeState.serviceThrow = new BenefitsError(
      "REFUSED",
      "enrollment window is closed — elect inside an open window, or record a life event with a reason",
    );
    const response = await electRoute!.POST(post({ employmentId: EMPLOYMENT_ID, planId: PLAN_ID, windowId: WINDOW_ID, effectiveFrom: "2026-03-01" }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error as string, /elect inside an open window/);
    routeState.serviceThrow = new BenefitsError("BAD_STATE", "enrolment is ended — only an active enrolment is changed");
    assert.equal((await changeRoute!.POST(post({ enrollmentId: ENROLLMENT_ID, changeDate: "2026-04-01", reason: "x" }))).status, 409);
  });

  test("another person's employment id is refused as a 403", async () => {
    reset();
    const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");
    routeState.serviceThrow = new HrmAuthorizationError(
      "Benefit elections from the Me workspace elect only against your own employment — ask a manager holding hrm.benefits.manage to act on your behalf.",
    );
    const response = await electRoute!.POST(post({ employmentId: EMPLOYMENT_ID, planId: PLAN_ID, effectiveFrom: "2026-03-01" }));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error as string, /only against your own employment/);
  });
}
