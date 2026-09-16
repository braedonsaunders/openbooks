import assert from "node:assert/strict";
import test from "node:test";
import { buildLineageQuery, shortId } from "./lineage-helpers.ts";

test("lineage query needs exactly one anchor", () => {
  assert.equal(buildLineageQuery({ runId: "r-1" }), "/api/allocations/lineage?runId=r-1");
  assert.equal(
    buildLineageQuery({ journalEntryId: "a/b?c" }),
    "/api/allocations/lineage?journalEntryId=a%2Fb%3Fc",
  );
  assert.throws(() => buildLineageQuery({}), /exactly one/);
  assert.throws(() => buildLineageQuery({ runId: "a", documentId: "b" }), /exactly one/);
  assert.throws(() => buildLineageQuery({ runId: "" }), /exactly one/);
});

test("shortId compacts uuids and tolerates empties", () => {
  assert.equal(shortId("11111111-2222-3333-4444-555555555555"), "11111111");
  assert.equal(shortId("abc"), "abc");
  assert.equal(shortId(null), "");
  assert.equal(shortId(undefined), "");
});
