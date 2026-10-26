import assert from "node:assert/strict";
import test from "node:test";
import { employmentSpells } from "./employment-spells.ts";

const active = (effectiveFrom: string) => ({ status: "active", effectiveFrom });
const terminated = (effectiveFrom: string) => ({ status: "terminated", effectiveFrom });

test("a rehired worker has one spell per interruption, starting at the rehire", () => {
  assert.deepEqual(
    employmentSpells("2025-05-05", "2026-01-24", [
      active("2025-05-05"),
      active("2026-01-02"),
      terminated("2026-01-24"),
      active("2026-04-19"),
      terminated("2026-05-09"),
    ]),
    [
      { start: "2025-05-05", terminatedOn: "2026-01-24" },
      { start: "2026-04-19", terminatedOn: "2026-05-09" },
    ],
  );
});

test("a spell still running after a rehire stays open rather than borrowing the earlier termination", () => {
  assert.deepEqual(
    employmentSpells("2020-01-06", "2024-03-01", [
      active("2020-01-06"),
      terminated("2024-03-01"),
      active("2025-02-03"),
    ]),
    [
      { start: "2020-01-06", terminatedOn: "2024-03-01" },
      { start: "2025-02-03", terminatedOn: null },
    ],
  );
});

test("an employment whose history records no termination takes the role termination date", () => {
  assert.deepEqual(
    employmentSpells("2019-03-04", "2026-01-12", [active("2019-03-04"), active("2026-01-01")]),
    [{ start: "2019-03-04", terminatedOn: "2026-01-12" }],
  );
  assert.deepEqual(employmentSpells("2024-01-02", null, [active("2024-01-02")]), [
    { start: "2024-01-02", terminatedOn: null },
  ]);
});

test("a termination-only history is one spell from the service start", () => {
  assert.deepEqual(employmentSpells("2024-03-11", "2025-12-23", [terminated("2025-12-23")]), [
    { start: "2024-03-11", terminatedOn: "2025-12-23" },
  ]);
});
