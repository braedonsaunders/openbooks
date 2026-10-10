import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dueBusinessDay, priorityForDueDate } from "./types.ts";

describe("inbox due dates are business days", () => {
  it("a date-only deadline is never overdue on or before its own day", () => {
    assert.equal(priorityForDueDate("2026-10-11", "2026-10-10", "America/Toronto"), "due_soon");
    assert.equal(priorityForDueDate("2026-10-11", "2026-10-11", "America/Toronto"), "due_soon");
    assert.equal(priorityForDueDate("2026-10-11", "2026-10-12", "America/Toronto"), "overdue");
    assert.equal(dueBusinessDay("2026-10-11", "Pacific/Kiritimati"), "2026-10-11", "a business day is not shifted by any zone");
  });

  it("a due instant is placed on the organization's business day, not the UTC day", () => {
    // 22:00 on 10 October in Toronto is already 11 October in UTC.
    const lateEvening = "2026-10-11T02:00:00.000Z";
    assert.equal(dueBusinessDay(lateEvening, "America/Toronto"), "2026-10-10");
    assert.equal(priorityForDueDate(lateEvening, "2026-10-10", "America/Toronto"), "due_soon");
    assert.equal(priorityForDueDate(lateEvening, "2026-10-11", "America/Toronto"), "overdue");
    assert.equal(dueBusinessDay(lateEvening), "2026-10-11", "without a zone the UTC day stands");
  });

  it("work due beyond three days reads as normal", () => {
    assert.equal(priorityForDueDate("2026-10-20", "2026-10-10"), "normal");
    assert.equal(priorityForDueDate(null, "2026-10-10"), "normal");
  });
});
