import assert from "node:assert/strict";
import test from "node:test";
import { DocumentDefaultsError, dueDateFromNetDays } from "./document-defaults.ts";

test("net days count calendar days from the document date across month and year ends", () => {
  assert.equal(dueDateFromNetDays("2026-07-20", 0), "2026-07-20");
  assert.equal(dueDateFromNetDays("2026-07-20", 15), "2026-08-04");
  assert.equal(dueDateFromNetDays("2026-12-20", 30), "2027-01-19");
  assert.equal(dueDateFromNetDays("2028-02-15", 15), "2028-03-01");
});

test("terms with negative or fractional net days refuse with the setup remedy", () => {
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.throws(() => dueDateFromNetDays("2026-07-20", bad), (error: unknown) =>
      error instanceof DocumentDefaultsError && /Payment terms/.test(error.message));
  }
  assert.throws(() => dueDateFromNetDays("2026-02-30", 15), DocumentDefaultsError);
});
