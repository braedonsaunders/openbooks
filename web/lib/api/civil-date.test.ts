import assert from "node:assert/strict";
import test from "node:test";
import { civilDateInput } from "./civil-date";

test("API civil-date schema accepts leap days and refuses impossible calendar days", () => {
  const schema = civilDateInput();
  assert.equal(schema.safeParse("2024-02-29").success, true);
  const invalid = schema.safeParse("2025-02-29");
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.match(invalid.error.issues[0]?.message ?? "", /real.*calendar date/);
});
