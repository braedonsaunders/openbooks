import assert from "node:assert/strict";
import test from "node:test";
import {
  allocationRunOccurrenceKey,
  parseRunAllocationConfig,
  previewInputFor,
} from "./scheduling.ts";

test("allocation run occurrences key on rule, period, and book", () => {
  assert.equal(
    allocationRunOccurrenceKey("rule-1", "period-1", "book-1"),
    "alloc:rule-1:period-1:book-1",
  );
});

test("run_allocation config fails closed on shape", () => {
  assert.deepEqual(parseRunAllocationConfig({ ruleIds: "all", post: true }), {
    ruleIds: "all",
    post: true,
  });
  const one = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(parseRunAllocationConfig({ ruleIds: [one], post: false }), {
    ruleIds: [one],
    post: false,
  });
  // post defaults to preview-only when absent.
  assert.deepEqual(parseRunAllocationConfig({ ruleIds: "all" }), {
    ruleIds: "all",
    post: false,
  });
  for (const bad of [
    null,
    undefined,
    "all",
    [],
    {},
    { ruleIds: [] },
    { ruleIds: ["not-a-uuid"], post: false },
    { ruleIds: "all", post: "yes" },
    { ruleIds: 42, post: false },
  ]) {
    assert.throws(() => parseRunAllocationConfig(bad), Error, JSON.stringify(bad));
  }
});

test("unattended preview input runs as the version publisher", () => {
  const input = previewInputFor({
    orgId: "org-1",
    ruleId: "rule-1",
    periodId: "period-1",
    bookId: "book-1",
    triggerKind: "scheduled",
    publishedBy: "publisher-1",
  });
  assert.equal(input.actorId, "publisher-1");
  assert.equal(input.trigger, "scheduled");
  assert.throws(
    () => previewInputFor({
      orgId: "org-1",
      ruleId: "rule-1",
      periodId: "period-1",
      bookId: "book-1",
      triggerKind: "close_automation",
      publishedBy: "  ",
    }),
    /no publisher/,
  );
});

/* Outbox enqueue/process wiring is proven through the real functions in
 * scheduling.integration.test.ts ("enqueue is idempotent …", "processing
 * previews and posts through the real engine"), and the production sweep
 * dispatch in scheduling/outbox.integration.test.ts ("the scheduler sweep
 * routes allocation_run rows to the allocation processor"). Close-automation
 * routing is proven in
 * close/automations-recovery.integration.test.ts ("a run_allocation rule
 * routes into the allocation scheduler …"). */
