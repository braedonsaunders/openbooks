import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorScrollTop,
  countAssistantTurns,
  formatMessageTimestamp,
  isViewportAtBottom,
  MESSAGE_PAGE_SIZE,
  reconcileThreadAfterStop,
  withLastAssistantParts,
} from "./thread-state";

type Msg = { id: string; role: string; parts: unknown[] };

function user(id: string): Msg {
  return { id, role: "user", parts: [{ type: "text", text: "hi" }] };
}

function assistant(id: string, parts: unknown[] = [{ type: "text", text: "hello" }]): Msg {
  return { id, role: "assistant", parts };
}

test("streamed parts land on the last assistant message only", () => {
  const list = [user("u1"), assistant("a1"), user("u2"), assistant("a2", [])];
  const next = withLastAssistantParts(list, [{ type: "text", text: "new" }]);
  // The sent user message prints exactly once: untouched, still one row.
  assert.equal(next.filter((m) => m.role === "user").length, 2);
  assert.deepEqual(next[1]!.parts, [{ type: "text", text: "hello" }]);
  assert.deepEqual(next[3]!.parts, [{ type: "text", text: "new" }]);
  // No assistant message: the list is returned unchanged.
  assert.deepEqual(withLastAssistantParts([user("u1")], [{ type: "text", text: "x" }]), [
    user("u1"),
  ]);
});

test("a completed stream stays visible while persistence catches up", () => {
  // The panel showed two assistant turns; the server read only has one yet.
  const local = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];
  const lagging = [user("u1"), assistant("a1"), user("u2")];
  assert.deepEqual(reconcileThreadAfterStop(local, lagging, 2), local);
  // Once the host catches up it is authoritative again (ids, tool state).
  const caughtUp = [user("u1"), assistant("a1"), user("u2"), assistant("a2b")];
  assert.deepEqual(reconcileThreadAfterStop(local, caughtUp, 2), caughtUp);
});

test("countAssistantTurns counts assistant rows", () => {
  assert.equal(countAssistantTurns([]), 0);
  assert.equal(countAssistantTurns([user("u1"), assistant("a1"), assistant("a2")]), 2);
});

test("history pages match the server window and prepending holds position", () => {
  assert.equal(MESSAGE_PAGE_SIZE, 30);
  // 500px of new rows above a reader sitting at 1200px leaves them at 1700px.
  assert.equal(anchorScrollTop(1200, 4000, 4500), 1700);
  assert.equal(anchorScrollTop(0, 1000, 1000), 0);
});

test("stick-to-bottom holds only while the reader is at the bottom", () => {
  // Exactly at the bottom, and within the threshold above it: stuck.
  assert.equal(isViewportAtBottom(500, 500, 1000), true);
  assert.equal(isViewportAtBottom(460, 500, 1000), true);
  // Scrolled up past the threshold: detached.
  assert.equal(isViewportAtBottom(400, 500, 1000), false);
  assert.equal(isViewportAtBottom(0, 500, 1000), false);
  // Short content that fits without scrolling counts as at the bottom.
  assert.equal(isViewportAtBottom(0, 500, 300), true);
  assert.equal(isViewportAtBottom(0, 0, 0), true);
});

test("timestamps show time today, date + time otherwise", () => {
  const now = new Date("2026-09-16T12:00:00");
  const today = formatMessageTimestamp("2026-09-16T09:41:00Z", now, 'en-US', 'UTC');
  assert.ok(today);
  assert.ok(!today.compact.includes("Sep"));
  const older = formatMessageTimestamp("2026-08-02T09:41:00Z", now, 'en-US', 'UTC');
  assert.ok(older);
  assert.ok(older.compact.includes("Aug"));
  const lastYear = formatMessageTimestamp("2025-12-31T23:59:00Z", now, 'en-US', 'UTC');
  assert.ok(lastYear);
  assert.ok(lastYear.compact.includes("2025"));
  assert.ok(today.full.length > today.compact.length);
  assert.equal(formatMessageTimestamp("not-a-date", now, 'en-US', 'UTC'), null);
});

test('timestamps compare and format dates in the configured viewer time zone', () => {
  const now = new Date('2026-09-16T03:00:00Z')
  const priorUtcDay = formatMessageTimestamp('2026-09-16T02:30:00Z', now, 'fr', 'America/Toronto')
  assert.ok(priorUtcDay)
  assert.ok(!priorUtcDay.compact.includes('sept'))
  assert.match(priorUtcDay.full, /sept/i)
})
