import assert from "node:assert/strict";
import test from "node:test";
import { sodBlockedIds } from "./sod.ts";

test("separation of duties blocks both the submitter and the maker", () => {
  assert.deepEqual(
    sodBlockedIds({ submitterUserId: "submitter", makerUserId: "maker" }),
    new Set(["submitter", "maker"]),
  );
});
