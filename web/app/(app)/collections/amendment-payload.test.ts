import assert from "node:assert/strict";
import test from "node:test";
import { amendmentRequestPayload } from "./amendment-payload.ts";

test("blank amendment fields are omitted so the typed body schema never sees an empty uuid or date", () => {
  const payload = amendmentRequestPayload({
    subscriptionId: "00000000-0000-4000-8000-00000000c003",
    type: "change_component",
    effectiveOn: "2026-11-01",
    componentKey: "",
    name: "  ",
    termEndsOn: "",
    anchorSubscriptionId: "",
    planVersionId: "",
    reason: "Upgrade",
  });
  assert.deepEqual(payload, {
    subscriptionId: "00000000-0000-4000-8000-00000000c003",
    type: "change_component",
    effectiveOn: "2026-11-01",
    reason: "Upgrade",
  });
});

test("a filled plan-change version and its date reach the request unchanged", () => {
  assert.deepEqual(
    amendmentRequestPayload({
      type: "change_plan",
      planVersionId: "00000000-0000-4000-8000-00000000d001",
      effectiveOn: "2026-11-01",
    }),
    {
      type: "change_plan",
      planVersionId: "00000000-0000-4000-8000-00000000d001",
      effectiveOn: "2026-11-01",
    },
  );
});
