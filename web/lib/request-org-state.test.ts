import assert from "node:assert/strict";
import test from "node:test";
import { requestOrgByWorkStore } from "./request-org-state";

test("request org state survives duplicate module evaluation", async () => {
  const duplicate = await import(`./request-org-state.ts?duplicate=${Date.now()}`);
  assert.strictEqual(duplicate.requestOrgByWorkStore, requestOrgByWorkStore);

  const workStore = {};
  const scope = { orgId: "tenant-a", bypass: false };
  requestOrgByWorkStore.set(workStore, scope);
  assert.deepEqual(duplicate.requestOrgByWorkStore.get(workStore), scope);
});
