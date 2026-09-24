import assert from "node:assert/strict";
import test from "node:test";
import { requireExplicitOrgId, selectOnlyOrg } from "./org-selection.ts";

test("an explicit org id resolves, anything else refuses with the orgs listed", () => {
  const orgs = [
    { id: "11111111-1111-1111-1111-111111111111", name: "Older" },
    { id: "22222222-2222-2222-2222-222222222222", name: "Newer" },
  ];
  assert.equal(
    requireExplicitOrgId("22222222-2222-2222-2222-222222222222", orgs, "seed-eft-settings.ts"),
    "22222222-2222-2222-2222-222222222222",
  );
  for (const bad of [undefined, "", "not-a-uuid", "22222222-2222-2222-2222-22222222222x"]) {
    assert.throws(
      () => requireExplicitOrgId(bad, orgs, "seed-eft-settings.ts"),
      (error: unknown) =>
        error instanceof Error &&
        /pass the org id \(uuid\) as the first argument/.test(error.message) &&
        error.message.includes("Older (11111111-1111-1111-1111-111111111111)") &&
        error.message.includes("Newer (22222222-2222-2222-2222-222222222222)"),
    );
  }
  assert.throws(
    () => requireExplicitOrgId(undefined, [], "seed-eft-settings.ts"),
    /no orgs exist yet/,
  );
});

test("single-org scripts select the only org and refuse any other population", () => {
  const only = [{ id: "11111111-1111-1111-1111-111111111111", name: "Only" }];
  assert.deepEqual(selectOnlyOrg(only, "demo-e2e.ts"), only[0]);
  assert.throws(() => selectOnlyOrg([], "demo-e2e.ts"), /seed an org first/);
  assert.throws(
    () =>
      selectOnlyOrg(
        [...only, { id: "22222222-2222-2222-2222-222222222222", name: "Second" }],
        "demo-e2e.ts",
      ),
    (error: unknown) =>
      error instanceof Error &&
      /runs against exactly one org but found 2/.test(error.message) &&
      error.message.includes("Second (22222222-2222-2222-2222-222222222222)"),
  );
});
