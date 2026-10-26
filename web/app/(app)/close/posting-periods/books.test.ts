import assert from "node:assert/strict";
import test from "node:test";
import { resolvePostingPeriodsBookId } from "./books";

const books = [
  { id: "secondary", name: "Secondary", is_primary: false },
  { id: "primary", name: "Primary", is_primary: true },
];

test("posting periods keep a valid book and otherwise default to the active primary book", () => {
  assert.equal(resolvePostingPeriodsBookId(books, "secondary"), "secondary");
  assert.equal(resolvePostingPeriodsBookId(books, "inactive-or-unknown"), "primary");
  assert.equal(resolvePostingPeriodsBookId([], undefined), "");
});
