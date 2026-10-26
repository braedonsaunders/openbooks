import assert from "node:assert/strict";
import test from "node:test";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { PeriodClosedError } from "@openbooks/engine/periods/period-policy";
import { defineRoute } from "./route.ts";

// A domain refusal thrown from a handler must answer 4xx through the route
// factory itself — never escape as the 500 a bare boundary used to produce
// for status-less engine refusals. Token routes skip the session boundary,
// so these drive the real catch mapping with no stubs.
function throwingRoute(error: unknown) {
  return defineRoute({
    public: "token",
    handler: () => {
      throw error;
    },
  });
}

test("a status-less posting refusal answers 422 with its scope through defineRoute", async () => {
  const scope = {
    kind: "period-closed" as const,
    periodId: "period-1",
    bookId: "book-1",
    subsidiaryId: null,
    module: "gl" as const,
  };
  const response = await throwingRoute(
    new PostingError("journal entry JE-1: GL is closed for this period", { details: scope }),
  )();
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "journal entry JE-1: GL is closed for this period",
    code: "posting_refused",
    details: scope,
  });
});

test("a raw closed-period refusal answers 422 with its scope through defineRoute", async () => {
  const scope = {
    kind: "period-closed" as const,
    periodId: "period-1",
    bookId: "book-1",
    subsidiaryId: "sub-1",
    module: "gl" as const,
  };
  const response = await throwingRoute(
    new PeriodClosedError("GL is closed for this period", scope),
  )();
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "GL is closed for this period",
    code: "period-closed",
    details: scope,
  });
});

test("an unexpected failure still escapes defineRoute instead of forging a refusal", async (t) => {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  await assert.rejects(
    throwingRoute(new Error("private database relation missing"))(),
    /private database relation missing/,
  );
});
