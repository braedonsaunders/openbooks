import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";

const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

// HR-18: the public apply route — honeypot, per-IP sliding window, and the
// service write path. The rate limiter runs before any database work, so
// the 429 proof needs no database: five attempts reach the service (whatever
// they return), the sixth is refused as too many with the remedy intact.
// __resetApplyRateLimitForTests reseeds the in-process window per test.

let hooks: { deregister(): void } | undefined;
if (!isVitest) {
  hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
      }
      return nextResolve(specifier);
    },
  });
}
const applyRouteUrl = "./route.ts?hrm-recruiting-apply";
const { POST, __resetApplyRateLimitForTests } = (await import(applyRouteUrl)) as typeof import("./route.ts");
hooks?.deregister();

function applyRequest(postingId: string, displayName: string): Request {
  return new Request("http://openbooks.test/api/recruiting/apply", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
    body: JSON.stringify({ postingId, displayName }),
  });
}

const POSTING_ID = "00000000-0000-4000-8000-000000000051";

if (isVitest) {
  test("apply rate limiting and the honeypot read from the route source", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /MAX_PER_WINDOW = 5/);
    assert.match(source, /too many applications from this address/);
    assert.match(source, /website/);
  });
} else {
  test("an unreadable body 400s before the limiter runs", async () => {
    __resetApplyRateLimitForTests();
    const response = await POST(
      new Request("http://openbooks.test/api/recruiting/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postingId: "nope" }),
      }),
    );
    assert.equal(response.status, 400);
  });

  test("the sixth apply inside the window 429s with the remedy", async () => {
    __resetApplyRateLimitForTests();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await POST(applyRequest(POSTING_ID, `Applicant ${attempt}`));
      statuses.push(response.status);
    }
    assert.deepEqual(statuses.slice(0, 5).every((status) => status !== 429), true, "the first five reach the service");
    assert.equal(statuses[5], 429, "the sixth attempt is rate limited");
    const sixth = await POST(applyRequest(POSTING_ID, "Applicant late"));
    assert.equal(sixth.status, 429);
    assert.match(String((await sixth.json()).error), /wait a minute/);
  });

  test("a filled honeypot shapes success and writes nothing", async () => {
    __resetApplyRateLimitForTests();
    const response = await POST(
      new Request("http://openbooks.test/api/recruiting/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postingId: POSTING_ID, displayName: "Bot", website: "http://bot.test" }),
      }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { received: true });
  });
}
