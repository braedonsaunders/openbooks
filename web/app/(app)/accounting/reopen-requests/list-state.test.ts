import assert from "node:assert/strict";
import test from "node:test";
import { parseReopenRequestListState } from "./list-state";

test("reopen request status changes keep server pagination within the selected filter", () => {
  assert.deepEqual(parseReopenRequestListState({ status: "approved", page: "3", perPage: "50" }), {
    status: "approved",
    page: 3,
    perPage: 50,
    offset: 100,
  });
  assert.deepEqual(parseReopenRequestListState({ status: "invalid", page: "0" }), {
    status: undefined,
    page: 1,
    perPage: 25,
    offset: 0,
  });
  assert.equal(parseReopenRequestListState({ perPage: "1000" }).perPage, 100);
});
